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
from work_quantity_policy import _listing_attempt


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


def coverage(registry, country, inventory, cutoff):
    expected = {source['id'] for source in registry['sources']
                if source['country'].lower() == country and source.get('available') is not False}
    observed, readable, unavailable = set(), set(), set()
    for row in inventory.get('sourceScanAuditHistory', []) + inventory.get('sourceScanAudit', []):
        if not _listing_attempt(row):
            continue
        identifier = row.get('sourceId')
        stamp = row.get('fetchedAt')
        if row.get('status') in (401, 403, 404, 410):
            unavailable.add(identifier)
        if stamp and datetime.fromisoformat(stamp) >= cutoff:
            if not row.get('fetchRetryable'):
                observed.add(identifier)
            if row.get('status') == 200 and row.get('contentValidated') is True:
                readable.add(identifier)
    terminal = (unavailable | observed) - readable
    return sorted(expected - observed - unavailable), {
        'registeredSources': len(expected), 'freshReadableSources': sorted(expected & readable),
        'unavailableSources': sorted(expected & terminal),
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
    pending, metrics = coverage(registry, country, audit, cutoff)
    # Deferred pagination is retained as evidence. An outstanding article job
    # discovered by this scan prevents silently closing the increment.
    if phase == 'final':
        pending = sorted(set(pending) | {row['sourceId'] for row in audit.get('articleQueue', [])})
    write(directory / 'snapshot.json', {
        'issue': issue, 'country': country, 'phase': phase, 'observedAt': datetime.now(timezone.utc).isoformat(),
        'candidates': inventory_entries(root, issue, country),
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['scan', 'extract-originals', 'originals'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('issue')
    parser.add_argument('country', choices=['kz', 'uz', 'kg', 'tj', 'az'])
    parser.add_argument('args', nargs='*')
    args = parser.parse_args()
    root = args.directory / 'source'
    if args.command == 'scan':
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
