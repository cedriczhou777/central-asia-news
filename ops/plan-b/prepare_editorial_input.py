#!/usr/bin/env python3
"""Index local evidence for the author and retrieve exact inputs for independent review."""

import argparse
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import tempfile

from source_attribution import publisher_name
from editorial_policy import EFFECTIVE_ISSUE
from source_evidence import evidence_packet
from work_quantity_policy import _listing_attempt


VERSION = 'editorial-input-v1'
COUNTRIES = ('kz', 'uz', 'kg', 'tj', 'az')
BEIJING = timezone(timedelta(hours=8))


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def digest(value):
    return hashlib.sha256(encode(value)).hexdigest()


def load(path):
    raw = path.read_bytes()
    document = json.loads(raw)
    if not isinstance(document, dict):
        raise ValueError('expected a JSON object')
    return document, len(raw)


def rows(document, key):
    value = document.get(key)
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise ValueError(f'{key} must be an array of objects')
    return value


def indexed(entries):
    keyed = {}
    for row in entries:
        key = row.get('id')
        if not isinstance(key, str) or not key.strip() or key in keyed:
            raise ValueError('missing or duplicate item ID')
        keyed[key] = row
    return keyed


def issue_end(issue):
    if date.fromisoformat(issue).isoformat() != issue:
        raise ValueError('issue date must use YYYY-MM-DD')
    return datetime.fromisoformat(issue + 'T06:00:00+08:00')


def identity(document, issue, country):
    end = issue_end(issue)
    if document.get('issueDate') != issue or document.get('country') != country:
        raise ValueError('input does not match the requested issue and country')
    for key, expected in (('windowStart', end - timedelta(days=1)), ('windowEnd', end)):
        if datetime.fromisoformat(document.get(key) or '') != expected:
            raise ValueError('input does not match the requested 24-hour window')


def pick(row, names):
    return {key: row[key] for key in names if row.get(key) is not None}


def count_by_source(entries):
    return Counter(row['sourceId'] for row in entries if row.get('sourceId'))


def source_progress(scan, cutoff):
    listings = defaultdict(list)
    for row in rows(scan, 'sourceScanAudit'):
        source = row.get('sourceId')
        if not isinstance(source, str) or not source:
            raise ValueError('source scan row is missing sourceId')
        group = listings[source]
        if _listing_attempt(row) and row.get('fetchedAt') and not row.get('fetchRetryable'):
            stamp = datetime.fromisoformat(row['fetchedAt'])
            if stamp.tzinfo is None:
                raise ValueError('source fetch timestamp needs a timezone')
            group.append((stamp, row))

    listing_jobs = count_by_source(rows(scan, 'listingQueue'))
    article_jobs = count_by_source(rows(scan, 'articleQueue'))
    budget_events = count_by_source(rows(scan, 'budgetEvents'))
    raw_leads = scan.get('rawLeadQueueBySource') or {}
    if not isinstance(raw_leads, dict):
        raise ValueError('invalid raw lead queue summary')
    unavailable = set(scan.get('unavailableSourceIds') or [])
    result = []
    for source in sorted(set(listings) | set(listing_jobs) | set(article_jobs) | set(raw_leads) | set(budget_events)):
        observed = sorted(listings[source], key=lambda item: item[0])
        last = observed[-1] if observed else None
        readable = [stamp for stamp, row in observed if row.get('status') == 200 and row.get('contentValidated') is True]
        result.append({'sourceId': source, 'queuedListings': listing_jobs[source],
                       'queuedArticles': article_jobs[source], 'queuedRawLeads': raw_leads.get(source, 0),
                       'budgetEvents': budget_events[source], 'listedUnavailable': source in unavailable,
                       'lastListingAt': last[0].astimezone(BEIJING).isoformat() if last else None,
                       'lastListingStatus': last[1].get('status') if last else None,
                       'lastReadableListingAt': readable[-1].astimezone(BEIJING).isoformat() if readable else None,
                       'hasListingObservationAfterCutoff': bool(last and last[0] >= cutoff),
                       'hasReadableListingAfterCutoff': bool(readable and readable[-1] >= cutoff)})
    return result


def candidate_row(row):
    result = pick(row, ('id', 'sourceId', 'family', 'source_url', 'canonicalURL', 'decision', 'reason',
                        'decisionOrigin', 'publicationWindowAssessment', 'fullTextFetchedAt',
                        'fullTextValidated', 'languageReviewRequired', 'sourceHash', 'sourceJSON', 'sourceJSONSha256',
                        'sourceHTML', 'sourceHTMLSha256'))
    revision = pick(row, ('id', 'sourceId', 'source_url', 'canonicalURL', 'sourceHash', 'sourceRevisionHash',
                          'decision', 'reason', 'decisionOrigin', 'publicationWindowAssessment',
                          'firstDisclosureVerified', 'articleIdentityVerified', 'languageVerified',
                          'languageReviewRequired', 'articleIdentityReview', 'languageReview',
                          'firstDisclosureEvidence', 'fullTextValidated'))
    revision['hasFullTextObservation'] = bool(row.get('fullTextFetchedAt'))
    revision['origins'] = [pick(origin, ('sourceId', 'source_url', 'sourceHash', 'sourceRevisionHash',
                                         'articleIdentityReview', 'languageReview'))
                           for origin in row.get('discoveryOrigins', [])]
    if not row.get('sourceRevisionHash'):
        # Old records without the scanner's editorial revision hash cannot
        # distinguish a substantive update from a transport-only refresh.
        revision = row
    result['editorialFingerprint'] = digest(revision)
    return result


def discovery_index(directory, issue, country, previous=None):
    directory = directory.resolve()
    ledger_path = directory / 'candidate_ledger.json'
    scan_path = directory / 'source_scan_audit.json'
    ledger, ledger_bytes = load(ledger_path)
    scan, scan_bytes = load(scan_path)
    for document in (ledger, scan):
        identity(document, issue, country)
    candidates = [candidate_row(row) for row in indexed(rows(ledger, 'candidateLedger')).values()]
    prior = {}
    if previous is not None:
        previous, _ = load(previous)
        require_index(previous, 'discovery')
        identity(previous, issue, country)
        prior = indexed(rows(previous, 'candidates'))
    for row in candidates:
        before = prior.get(row['id'])
        row['change'] = ('new' if before is None else 'changed'
                         if row['editorialFingerprint'] != before.get('editorialFingerprint') else 'unchanged')
    counts = Counter(row.get('decision', 'unknown') for row in candidates)
    changes = Counter(row['change'] for row in candidates)
    end = issue_end(issue)
    return {'version': VERSION, 'kind': 'discovery', 'issueDate': issue, 'country': country,
            'windowStart': (end - timedelta(days=1)).isoformat(), 'windowEnd': end.isoformat(),
            'candidateLedger': str(ledger_path), 'sourceScanAudit': str(scan_path),
            'inputBytes': ledger_bytes + scan_bytes, 'candidateCounts': dict(counts), 'changes': dict(changes),
            'removedIds': sorted(prior.keys() - {row['id'] for row in candidates}),
            'sourceProgress': source_progress(scan, end), 'candidates': candidates,
            'scanFunnel': scan.get('funnel'),
            'queues': pick(scan, ('listingQueueRemaining', 'articleQueueRemaining', 'rawLeadsQueued',
                                  'retryableFetchesThisRun', 'elapsedSeconds', 'complete'))}


def read_handoff(draft_path, issue, country):
    draft, size = load(draft_path)
    identity(draft, issue, country)
    writer = draft.get('writerRun')
    if (draft.get('manuscriptReady') is not True or draft.get('writerHandoffComplete') is not True
            or not isinstance(writer, str) or not writer.strip()):
        raise ValueError('finalized writer handoff required')
    articles = rows(draft, 'articles')
    indexed(articles)
    if not 0 < len(articles) <= 20 or draft.get('bodyHash') != digest(articles):
        raise ValueError('article count or writer hash does not match final handoff')
    return draft, size


def file_stamp(path):
    stat = path.stat()
    return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]


REVIEW_BINDING = ('issueDate', 'country', 'windowStart', 'windowEnd', 'writerRun', 'writerBodyHash')


def review_packet_path(index_path, binding):
    body_hash = binding.get('writerBodyHash')
    if not isinstance(body_hash, str) or not re.fullmatch('[0-9a-f]{64}', body_hash):
        raise ValueError('invalid writer body hash')
    return index_path.with_name(f'.review-articles-{digest(binding)}.json')


def reusable_review_index(index_path, draft_path, issue, country, stamp):
    if index_path == draft_path or index_path.is_symlink():
        return None
    try:
        existing, _ = load(index_path)
        require_index(existing, 'review')
        identity(existing, issue, country)
        if existing.get('draftFile') != str(draft_path):
            return None
        metadata = existing['reviewPacket']
        if metadata.get('sourceStamp') != stamp:
            return None
        packet = review_packet_path(index_path, pick(existing, REVIEW_BINDING))
        if packet.is_symlink() or packet.stat().st_size != metadata.get('bytes'):
            return None
        # Reuse only the index. review-articles still validates the complete
        # body hash against the current handoff before extracting articles.
        return existing if file_stamp(draft_path) == stamp else None
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


def review_index(draft_path, issue, country, index_path=None):
    draft_path = draft_path.resolve()
    stamp = file_stamp(draft_path) if index_path else None
    if index_path is not None:
        existing = reusable_review_index(index_path, draft_path, issue, country, stamp)
        if existing is not None:
            return {**existing, 'indexReused': True}
    draft, draft_bytes = read_handoff(draft_path, issue, country)
    entries = []
    for article in draft['articles']:
        exact = pick(article, ('id', 'title', 'source_url', 'published_at', 'image_url', 'image_sha256'))
        body = encode(article)
        entries.append({**exact, 'articleHash': hashlib.sha256(body).hexdigest(), 'articleBytes': len(body)})
    result = {'version': VERSION, 'kind': 'review', 'issueDate': issue, 'country': country, 'writerRun': draft['writerRun'],
            'windowStart': draft['windowStart'], 'windowEnd': draft['windowEnd'], 'draftFile': str(draft_path),
            'draftBytes': draft_bytes, 'writerBodyHash': draft['bodyHash'], 'articles': entries,
            'handoffState': pick(draft, ('stage', 'coverageEnd', 'quantityStatus', 'quantityReady', 'shortfallOpen'))}
    if index_path is not None:
        binding = pick(result, REVIEW_BINDING)
        target = review_packet_path(index_path, binding)
        if draft_path in (target.resolve(), index_path.resolve()) or target.resolve() == index_path.resolve():
            raise ValueError('review index or packet would overwrite source evidence')
        if stamp != file_stamp(draft_path):
            raise ValueError('writer handoff changed while creating the review index')
        packet_size = write_index(target, {**binding, 'articles': draft['articles']})
        result['reviewPacket'] = {'sourceStamp': stamp, 'bytes': packet_size}
    return result


def require_index(index, kind):
    if index.get('version') != VERSION or index.get('kind') != kind:
        raise ValueError(f'an {kind} index from {VERSION} is required')


def require_article_ids(article_ids):
    if not 1 <= len(article_ids) <= 5 or len(set(article_ids)) != len(article_ids):
        raise ValueError('request one to five different article IDs')


def candidate_originals(index, article_ids):
    require_index(index, 'discovery')
    require_article_ids(article_ids)
    ledger_path = Path(index['candidateLedger'])
    ledger, _ = load(ledger_path)
    identity(ledger, index['issueDate'], index['country'])
    current = indexed(rows(ledger, 'candidateLedger'))
    saved = indexed(rows(index, 'candidates'))
    evidence_dir = ledger_path.parent / 'evidence'
    if evidence_dir.is_symlink():
        raise ValueError('unsafe evidence directory')
    originals = []
    for article_id in article_ids:
        entry = current.get(article_id)
        if entry is None or entry.get('fullTextValidated') is not True or not entry.get('fullTextFetchedAt'):
            raise ValueError(f'{article_id}: validated full source text has not been archived')
        fingerprint = saved.get(article_id, {}).get('editorialFingerprint')
        if candidate_row(entry)['editorialFingerprint'] != fingerprint:
            raise ValueError(f'{article_id}: source evidence changed; regenerate discovery index')
        # Restored files may have an old absolute prefix. Resolve just the
        # matched immutable filename inside this scan's actual archive.
        path = evidence_dir / Path(entry['sourceJSON']).name
        if path.is_symlink() or path.suffix != '.json' or not path.is_file():
            raise ValueError(f'{article_id}: original source archive missing')
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != entry.get('sourceJSONSha256'):
            raise ValueError(f'{article_id}: original source archive hash mismatch')
        record = json.loads(raw)
        body = record.get('text')
        if not isinstance(body, str) or not body.strip() or hashlib.sha256(body.encode()).hexdigest() != entry.get('sourceHash'):
            raise ValueError(f'{article_id}: full source text hash mismatch')
        source_url = entry['source_url']
        source_name = publisher_name(source_url)
        if not source_name:
            # Source pages outside the registry require a verified name from
            # the actual original. A listing's family is not proof when it
            # merely links to a different publisher.
            site_name = (record.get('meta') or {}).get('og:site_name')
            publisher_hint = site_name if isinstance(site_name, str) else None
        else:
            publisher_hint = None
        original = {'id': article_id, 'sourceJSON': str(path), 'sourceHash': entry['sourceHash'],
                          'sourceId': entry.get('sourceId'), 'source_url': source_url,
                          'source': source_name, 'publisherHint': publisher_hint,
                          'archiveBytes': len(raw), **pick(record, ('title', 'url', 'final_url', 'canonical_url', 'text',
                                                                   'fetchedAt', 'publicationEvidence', 'html_lang',
                                                                   'publicationEvidenceIssues', 'articleBodyEvidence',
                                                                   'articleImages'))}
        if index['issueDate'] >= EFFECTIVE_ISSUE:
            original['revision'] = fingerprint
            original['evidencePacket'] = evidence_packet(record, entry, original)
        originals.append(original)
    return {'issueDate': index['issueDate'], 'country': index['country'], 'articles': originals}


def load_review_packet(index, index_path):
    metadata = index.get('reviewPacket')
    if index_path is None or not isinstance(metadata, dict):
        return None
    draft_path = Path(index['draftFile'])
    binding = pick(index, REVIEW_BINDING)
    try:
        packet_path = review_packet_path(index_path, binding)
        # The sidecar is a cache, never a replacement for the live handoff.
        # Rename, in-place edit or restored copy invalidates this shortcut.
        stamp = metadata.get('sourceStamp')
        if file_stamp(draft_path) != stamp or packet_path.is_symlink():
            return None
        if packet_path.stat().st_size != metadata.get('bytes'):
            return None
        packet, _ = load(packet_path)
        articles = rows(packet, 'articles')
        if pick(packet, REVIEW_BINDING) != binding or digest(articles) != index['writerBodyHash']:
            return None
        if file_stamp(draft_path) != stamp:
            return None
        return articles
    except (OSError, ValueError, TypeError):
        return None


def review_articles(index, article_ids, index_path=None):
    require_index(index, 'review')
    require_article_ids(article_ids)
    articles = load_review_packet(index, index_path)
    if articles is None:
        draft, _ = read_handoff(Path(index['draftFile']), index['issueDate'], index['country'])
        if draft['bodyHash'] != index.get('writerBodyHash') or draft['writerRun'] != index.get('writerRun'):
            raise ValueError('writer handoff changed; regenerate the review index')
        articles = draft['articles']
    entries = indexed(articles)
    if any(article_id not in entries for article_id in article_ids):
        raise ValueError('unknown adopted article ID')
    return {**pick(index, ('issueDate', 'country', 'writerRun', 'writerBodyHash')),
            'articles': [entries[key] for key in article_ids]}


def show(index, view, cursor, limit, changes_only):
    if view == 'sources':
        require_index(index, 'discovery')
        entries = rows(index, 'sourceProgress')
    elif view in ('pending', 'candidates'):
        require_index(index, 'discovery')
        entries = rows(index, 'candidates')
        if view == 'pending':
            entries = [row for row in entries if row.get('decision') not in ('selected', 'rejected')]
        if changes_only:
            entries = [row for row in entries if row['change'] != 'unchanged']
    else:
        require_index(index, 'review')
        entries = rows(index, 'articles')
    if cursor > len(entries):
        raise ValueError('cursor is outside this index view')
    stop = min(cursor + limit, len(entries))
    return {'issueDate': index['issueDate'], 'country': index['country'], 'view': view, 'total': len(entries),
            'nextCursor': stop if stop < len(entries) else None, 'items': entries[cursor:stop]}


def write_index(path, index):
    # The input path can also be the last index used for --previous. Replace it
    # atomically after all evidence was read, leaving a prior index on error.
    data = encode(index)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        try:
            handle.write(data)
            handle.close()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    return len(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(required=True, dest='command')
    discovery = sub.add_parser('discovery', help='index current candidates, source observations, and scope differences')
    discovery.add_argument('--input-dir', type=Path, required=True)
    discovery.add_argument('--previous', type=Path)
    review = sub.add_parser('review', help='index a finalized country handoff without printing the articles')
    review.add_argument('--draft', type=Path, required=True)
    for command in (discovery, review):
        command.add_argument('--issue-date', required=True)
        command.add_argument('--country', choices=COUNTRIES, required=True)
        command.add_argument('--output', type=Path, required=True)
    page = sub.add_parser('show', help='read a bounded page from an index')
    page.add_argument('--index', type=Path, required=True)
    page.add_argument('--view', choices=('sources', 'pending', 'candidates', 'adopted'), required=True)
    page.add_argument('--cursor', type=int, default=0)
    page.add_argument('--limit', type=int, default=12)
    page.add_argument('--changed-only', action='store_true')
    articles = sub.add_parser('review-articles', help='read exact full adopted articles and their evidence')
    originals = sub.add_parser('candidate-originals', help='read unabridged archived source text with verified hashes')
    for command in (articles, originals):
        command.add_argument('--index', type=Path, required=True)
        command.add_argument('article_ids', nargs='+')
    args = parser.parse_args()
    try:
        if args.command in ('discovery', 'review'):
            if args.command == 'discovery':
                index = discovery_index(args.input_dir, args.issue_date, args.country, args.previous)
                source_paths = (index['candidateLedger'], index['sourceScanAudit'], args.input_dir / 'lead_queue.json')
                summary = pick(index, ('inputBytes', 'candidateCounts', 'changes', 'queues'))
            else:
                index = review_index(args.draft, args.issue_date, args.country, args.output)
                source_paths = (index['draftFile'],)
                summary = {'draftBytes': index['draftBytes'], 'articleCount': len(index['articles']),
                           'articleBytes': sum(row['articleBytes'] for row in index['articles']),
                           'writerBodyHash': index['writerBodyHash'], 'handoffState': index['handoffState']}
            if any(Path(source).resolve() == args.output.resolve() for source in source_paths):
                raise ValueError('index output must not overwrite source evidence')
            reused = index.get('indexReused') is True
            if reused:
                summary.update(indexReused=True, sourceBytesRead=0)
            summary.update(issueDate=index['issueDate'], country=index['country'], index=str(args.output),
                           indexBytes=args.output.stat().st_size if reused else write_index(args.output, index))
        else:
            index, _ = load(args.index)
            if args.command == 'review-articles':
                summary = review_articles(index, args.article_ids, args.index)
            elif args.command == 'candidate-originals':
                summary = candidate_originals(index, args.article_ids)
            else:
                if args.cursor < 0 or not 1 <= args.limit <= 25:
                    raise ValueError('cursor must be nonnegative and page limit must be 1–25')
                if args.changed_only and args.view not in ('pending', 'candidates'):
                    raise ValueError('changed-only applies to candidate views')
                summary = show(index, args.view, args.cursor, args.limit, args.changed_only)
    except (OSError, KeyError, ValueError, TypeError) as exc:
        parser.exit(1, f'editorial input failed: {exc}\n')
    print(encode(summary).decode())


if __name__ == '__main__':
    main()
