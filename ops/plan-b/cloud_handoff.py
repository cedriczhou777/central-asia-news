"""Run the existing source and verification code against an isolated country cache."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import tarfile

from discover_work_sources import discover, published_intervals, rebase_discovery_paths
from prepare_editorial_input import candidate_originals, discovery_index, indexed
from source_coverage import assess_coverage, coverage_self_test


REGISTRY = Path(__file__).with_name('source_registry.json')
ROOT_FILES = {'candidate_ledger.json', 'lead_queue.json', 'source_scan_audit.json', 'source_scan_events.jsonl'}
ARCHIVE_FILE = re.compile(r'(?:sources|evidence)/[a-zA-Z0-9_-]+\.(?:retry\.json|json|html\.gz)\Z')
LIMIT = 150 * 1024 * 1024


def read(path):
    return json.loads(path.read_bytes())


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')


def archive_name(value):
    return value in ROOT_FILES or bool(ARCHIVE_FILE.fullmatch(value))


def backup(root, destination):
    files = [root / name for name in ROOT_FILES]
    files += [entry for key in ('sources', 'evidence') for entry in (root / key).glob('*')]
    total = 0
    with tarfile.open(destination, 'w:gz', compresslevel=2) as tar:
        for file in sorted(files):
            name = file.relative_to(root).as_posix()
            if not archive_name(name) or not file.is_file() or file.is_symlink():
                continue
            size = file.stat().st_size
            total += size
            if total > LIMIT:
                raise ValueError('archive_size_limit')
            info = tarfile.TarInfo(name)
            info.size = size
            with file.open('rb') as source:
                tar.addfile(info, source)


def restore(root, source, editorial_only=False):
    root.mkdir(mode=0o700, exist_ok=True)
    total = 0
    with tarfile.open(source, 'r|gz') as tar:
        for entry in tar:
            total += entry.size
            if not archive_name(entry.name) or not entry.isfile() or total > LIMIT:
                raise ValueError('invalid_archive_member')
            if editorial_only and entry.name not in {'candidate_ledger.json', 'source_scan_audit.json'} and (
                    not entry.name.startswith('evidence/') or not entry.name.endswith('.json')):
                continue
            file = root / entry.name
            file.parent.mkdir(exist_ok=True)
            with file.open('xb') as out, tar.extractfile(entry) as data:
                shutil.copyfileobj(data, out)


def coverage(registry, country, inventory, cutoff, ledger=(), leads=(), observed_at=None):
    assessment = assess_coverage(registry, country, inventory, cutoff, ledger, leads, observed_at)
    return sorted({row['sourceId'] for row in assessment['pendingWork']}), {
        'coverage': assessment,
        'registeredSources': sum(s['country'].lower() == country and s.get('available') is not False
                                 for s in registry['sources']),
        'freshReadableSources': assessment['readableSources'],
        'unavailableSources': [g['sourceId'] for g in assessment['gaps'] if g['reason'] == 'source_unavailable'],
        'listingQueueRemaining': inventory.get('listingQueueRemaining', 0),
        'articleQueueRemaining': inventory.get('articleQueueRemaining', 0),
        'rawLeadsQueued': inventory.get('rawLeadsQueued', 0),
        'requestMetrics': inventory.get('fetchMetrics', {}),
        'elapsedSeconds': inventory.get('elapsedSeconds'),
    }


def inventory_entries(root, issue, country):
    index = discovery_index(root, issue, country)
    ledger = indexed(read(root / 'candidate_ledger.json')['candidateLedger'])
    result = []
    for entry in index['candidates']:
        if (entry.get('decision') == 'rejected' or entry.get('fullTextValidated') is not True
                or not entry.get('fullTextFetchedAt')):
            continue
        actual = ledger[entry['id']]
        path = root / 'evidence' / Path(actual['sourceJSON']).name
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != actual.get('sourceJSONSha256'):
            raise ValueError('source_archive_hash_mismatch')
        source = json.loads(raw)
        title = source.get('title') or (source.get('meta') or {}).get('og:title')
        if not isinstance(title, str) or not title.strip():
            continue
        times = published_intervals(source, country)
        valid = (actual.get('publicationWindowAssessment') == 'in_window' and len({v[0] for v in times}) == 1)
        result.append({'id': entry['id'], 'revision': entry['editorialFingerprint'], 'title': title.strip(),
                       'sourceId': actual['sourceId'], 'family': actual['family'],
                       'sourceUrl': entry['source_url'], 'sourceHash': entry['sourceHash'],
                       'publishedAt': times[0][0].isoformat() if valid else None, 'needsTimeReview': not valid})
    return result


def scan(root, directory, issue, country, phase, seconds):
    registry = read(REGISTRY)
    cutoff = datetime.fromisoformat(issue + 'T06:00:00+08:00')
    known = directory / 'input.gz'
    if known.is_file():
        restore(root, known)
    audit = discover(registry, country, issue, root, cutoff.isoformat() if phase == 'final' else None,
                     workers=2, max_seconds=seconds)
    observed = datetime.now(timezone.utc).isoformat()
    ledger = read(root / 'candidate_ledger.json')['candidateLedger']
    leads = read(root / 'lead_queue.json').get('leadLedger', []) if (root / 'lead_queue.json').exists() else []
    pending, metrics = coverage(registry, country, audit, cutoff, ledger, leads, observed)
    write(directory / 'snapshot.json', {
        'issue': issue, 'country': country, 'phase': phase, 'observedAt': observed,
        'candidates': inventory_entries(root, issue, country),
        'coverage': metrics['coverage'],
        'pendingSources': pending if phase == 'final' else [], 'metrics': metrics,
    })
    backup(root, directory / 'output.gz')


def originals(root, issue, country, ids):
    result = candidate_originals(discovery_index(root, issue, country), ids)
    for row in result['articles']:
        row.pop('sourceJSON', None)
        # Offload image downloads to the cloud. This evidence is only the
        # publisher's original-page image candidates.
    return result


# Fixed representative set only: this does not scan, cache, write state or call AI.
PROBE_SOURCES = {
    'kz': ('kz-tengrinews', 'kz-kazinform'),
    'uz': ('uz-gazeta-uz', 'uz-spot-uz'),
    'kg': ('kg-kabar', 'kg-kaktus-media'),
    'tj': ('tj-khovar', 'tj-asia-plus'),
    'az': ('az-report-az', 'az-apa'),
}


def probe_sources(directory, country):
    import io
    import ssl
    import time
    from urllib.parse import urlsplit
    from PIL import Image
    from fetch_work_sources import bounded_response, parse_response

    started = time.monotonic()
    deadline = started + 65
    rows = []
    pages = []

    def request(url, kind, source_id):
        begin = time.monotonic()
        row = {'kind': kind, 'sourceId': source_id, 'url': url, 'status': None, 'ok': False}
        parsed = None
        try:
            metadata, raw = bounded_response(url, min(deadline, begin + 10))
            row.update(status=metadata.get('status'), bytes=len(raw),
                       finalUrl=metadata.get('final_url', url))
            if metadata.get('error'):
                row['error'] = metadata['error'][:160]
            elif len(raw) > 10_000_000:
                row['error'] = 'response_too_large'
            elif kind == 'image':
                with Image.open(io.BytesIO(raw)) as image:
                    row.update(format=image.format, width=image.width, height=image.height)
                    if image.width * image.height > 40_000_000:
                        raise ValueError('image_dimensions_limit')
                    image.verify()
                row['ok'] = metadata.get('status') == 200
            else:
                parsed = parse_response(url, metadata.get('final_url', url), raw,
                                        metadata.get('response_headers', {}))
                row.update(title=parsed.get('title', '')[:180],
                           textChars=len(parsed.get('text', '')),
                           linkCount=len(parsed.get('links', [])),
                           contentValidated=parsed.get('contentValidated', False),
                           fullTextValidated=parsed.get('fullTextValidated', False))
                row['ok'] = metadata.get('status') == 200 and bool(parsed.get('contentValidated'))
                if parsed.get('error'):
                    row['error'] = parsed['error'][:160]
        except Exception as error:
            row['error'] = (type(error).__name__ + ': ' + str(error))[:160]
        row['elapsedMs'] = round((time.monotonic() - begin) * 1000)
        rows.append(row)
        return parsed if row['ok'] else None

    registry = {source['id']: source for source in read(REGISTRY)['sources']}
    for source_id in PROBE_SOURCES[country]:
        source = registry[source_id]
        entries = source['entrypoints']
        entry = next((item for item in entries if item.get('role') == 'home'
                      and item.get('language') == 'ru'), entries[0])
        parsed = request(entry['url'], 'website', source_id)
        if parsed:
            pages.append((source_id, parsed))

    # One headline and its own displayed original image, never a full issue.
    for source_id, page in pages:
        host = urlsplit(page['final_url']).hostname
        lead = next((link for link in page.get('links', [])
                     if (link.get('inHeading') or link.get('articleCard'))
                     and not link.get('inNavigation')
                     and len(link.get('text', '')) >= 20
                     and urlsplit(link['url']).scheme == 'https'
                     and urlsplit(link['url']).hostname == host
                     and link['url'] != page['final_url']), None)
        if not lead:
            continue
        article = request(lead['url'], 'article', source_id)
        if article and article.get('fullTextValidated'):
            candidates = (article.get('articleImages') or {}).get('candidates', [])
            if candidates:
                request(candidates[0]['url'], 'image', source_id)
        break

    if country == 'kz':
        # Social egress is supplementary and is reported separately.
        request('https://t.me/s/tengrinews', 'telegram', 'kz-social-telegram-2')
        request('https://www.instagram.com/tengrinewskz/', 'instagram', 'kz-social-instagram-1')

    write(directory / 'probe.json', {
        'country': country, 'checkedAt': datetime.now(timezone.utc).isoformat(),
        'runtime': 'plan-b-source-probe-1', 'readOnly': True, 'aiApiUsed': False,
        'certificateStore': ssl.create_default_context().cert_store_stats(),
        'maxRequests': 6 if country == 'kz' else 4,
        'elapsedMs': round((time.monotonic() - started) * 1000), 'results': rows,
    })


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['scan', 'extract-originals', 'originals', 'probe', 'coverage-self-test'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('issue')
    parser.add_argument('country', choices=['kz', 'uz', 'kg', 'tj', 'az'])
    parser.add_argument('args', nargs='*')
    args = parser.parse_args()
    root = args.directory / 'source'
    if args.command == 'coverage-self-test':
        proof = coverage_self_test()
        proof['releaseImplementationSha256'] = hashlib.sha256(Path(__file__).with_name('cloud_release.py').read_bytes()).hexdigest()
        write(args.directory / 'coverage-check.json', proof)
    elif args.command == 'probe':
        probe_sources(args.directory, args.country)
    elif args.command == 'scan':
        phase, seconds = args.args
        scan(root, args.directory, args.issue, args.country, phase, float(seconds))
    elif args.command == 'extract-originals':
        restore(root, args.directory / 'input.gz', editorial_only=True)
    else:
        cache, *ids = args.args
        write(args.directory / 'originals.json',
              originals(Path(cache) / 'source', args.issue, args.country, ids))


if __name__ == '__main__':
    main()
