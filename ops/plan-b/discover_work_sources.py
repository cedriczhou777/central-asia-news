"""Discover dated news candidates from a verified source registry; never write news.

Only URLs present in real fetched DOM/registry entrypoints are followed.  A
successful crawl is evidence collection, not an editorial quantity certificate.
"""
import argparse
import concurrent.futures
import copy
import gzip
import hashlib
import importlib.util
import inspect
import json
import math
import re
import threading
import time
from collections import Counter, defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urldefrag, urljoin, urlparse
from news_queue_policy import VERSION as QUEUE_POLICY_VERSION, MAX_ACTIVE_ARTICLES, importance, bounded_review_reason

VERSION = 'work-discovery-v6'
OFFSETS = {'kz': 5, 'uz': 5, 'kg': 6, 'tj': 5, 'az': 4}
LISTING_ROLES = {'home', 'section', 'archive', 'date_archive', 'pagination', 'language'}
TERMINAL = {'selected', 'rejected'}
ARTICLE_PATTERNS = {
    'kz-inbusiness-kz': r'^/(?:ru|kz)/(?:news|last)/[^/]+',
    'kz-kazakhstan-stock-exchange': r'^/(?:ru|en|kz)/(?:information/)?news/(?:show/)?\d+',
    'kz-finprom': r'^/(?:ru|en|kk)/article/[^/]+',
    'az-apa': r'^/[^/]+/[^/]+-\d{6,9}/?$',
    'az-report-az': r'^/(?:ru|az|en)/[^/]+/[^/]+-[^/]+/?$',
    'az-caliber-az': r'^/(?:en/)?post/[^/]+',
    'az-central-bank-azerbaijan': r'^/(?:[a-z]{2}/)?press-release-\d+',
    'az-state-customs-committee-azerbaijan': r'^/az/faydali/xeberler/\d+',
}


class _FetchFlights:
    """Share one actual fetch per request key within a single discovery run.

    Source aliases may observe the same response, but must not concurrently
    truncate its URL-addressed cache or mutate another consumer's evidence.
    """
    def __init__(self):
        self.lock = threading.Lock()
        self.results = {}

    def get(self, key, fetch):
        with self.lock:
            owner = key not in self.results
            if owner:
                self.results[key] = concurrent.futures.Future()
            future = self.results[key]
        if owner:
            try:
                future.set_result(copy.deepcopy(fetch()))
            except BaseException as error:
                future.set_exception(error)
        return copy.deepcopy(future.result()), owner


def lead_route(url, source, known_listings=()):
    """Route explicit collections/static pages; never filter by news topic."""
    path = urlparse(url).path.lower()
    parts = [part for part in path.split('/') if part]
    if normal_url(url) in known_listings:
        return 'listing', 'registered_or_observed_listing'
    if any(part in ('search', 'author', 'authors', 'tag', 'tags', 'tagmix') for part in parts):
        return 'listing', 'explicit_search_author_or_tag_collection'
    for marker in ('category', 'categories', 'type', 'types'):
        if marker in parts and len(parts) - parts.index(marker) - 1 <= 1:
            return 'listing', 'explicit_collection_not_article'
    static = {'privacy', 'privacy-policy', 'privacy_policy', 'terms', 'terms-of-use',
              'about', 'about-us', 'about_us', 'contacts', 'contact', 'cookies', 'disclaimer',
              'redakcionnaia-politika', 'redaktsionnaya-politika', 'editorial-policy', 'reklama-na-saite'}
    if any(part in static for part in parts):
        return 'static_page', 'explicit_permanent_information_page'
    if parts and parts[-1] in ('advertising', 'advertise'):
        return 'static_page', 'publisher_advertising_contact_index'
    if parts and parts[-1] == 'guide':
        return 'listing', 'guide_index_not_specific_article'
    sid = source['id']
    if sid == 'kg-24-kg' and re.fullmatch(r'/(?:[a-z]{2}/)?plot(?:/\d+)?/?', path):
        return 'listing', 'publisher_plot_topic_collection_not_article'
    if sid == 'kz-tengrinews' and path.rstrip('/') in ('/tengri-education', '/tengritravel'):
        return 'listing', 'publisher_verified_section_landing'
    if sid == 'kz-kazakhstan-stock-exchange' and any(p in ('issuers', 'instruments', 'members') for p in parts):
        return 'listing', 'exchange_entity_directory_not_news'
    if sid == 'az-central-bank-azerbaijan' and any(re.fullmatch(r'page-\d+', p) for p in parts):
        return 'listing', 'central_bank_permanent_page_not_press_release'
    if sid == 'az-apa' and len(parts) <= 2 and parts and parts[0] == 'news':
        return 'listing', 'publisher_news_section_not_specific_article'
    for marker in ('specprojects', 'tv_programs', 'lp'):
        if marker in parts:
            if len(parts) - parts.index(marker) - 1 == 0:
                return 'listing', 'special_project_or_program_index'
            return 'article_deferred', 'specific_special_project_after_current_news'
    return 'article_candidate', 'requires_actual_full_text_and_editorial_review'


def article_priority(lead, source):
    """Positive DOM/date/verified URL-shape ranking; no SME/topic blacklist."""
    route, reason = lead_route(lead['source_url'], source, {e['url'] for e in source_entries(source)})
    if route in ('listing', 'static_page'):
        return -1000, route, reason
    score = -40 if route == 'article_deferred' else 0
    path = urlparse(lead['source_url']).path
    if re.search(ARTICLE_PATTERNS.get(source['id'], r'(?!)'), path):
        score += 90
    # Registry examples must be explicitly confirmed full articles; access samples
    # alone (which include directories and privacy pages) are never training data.
    for example in source.get('articleExamples', []):
        if not isinstance(example, dict) or example.get('articleIdentityVerified') is not True:
            continue
        sample = urlparse(example.get('url', '')).path.split('/')
        current = path.split('/')
        prefix = []
        for part in sample[1:]:
            if re.search(r'\d|(?:[^/]+-){2}', part) or len(part) > 35:
                break
            prefix.append(part)
        if prefix and current[1:1 + len(prefix)] == prefix and len(current) == len(sample):
            score += 35
            break
    if re.search(r'/\d{4}/\d{1,2}/\d{1,2}/|(?:-|/)\d{5,}/?$|/[^/]*-[^/]*-[^/]+/?$', path):
        score += 15
    anchors = lead.get('anchorEvidence', [])
    best = None
    for anchor in anchors:
        points = 80 * bool(anchor.get('inHeading')) + 65 * bool(anchor.get('articleCard'))
        points += 45 * bool(anchor.get('nearbyTimes'))
        points -= 100 * bool(anchor.get('inNavigation'))
        best = points if best is None else max(best, points)
    return score + (best or 0), route, reason


def rank_leads(leads, source, window=None):
    for lead in leads:
        score, route, reason = article_priority(lead, source)
        if window and route in ('article_candidate', 'article_deferred'):
            # Promote strongly dated cards, without treating listing timestamps
            # as publication proof or rejecting undated leads.
            stamps = set()
            for anchor in lead.get('anchorEvidence', []):
                if not (anchor.get('inHeading') or anchor.get('articleCard')) or anchor.get('inNavigation'):
                    continue
                for time_tag in anchor.get('nearbyTimes') or []:
                    try:
                        stamp = datetime.fromisoformat((time_tag.get('datetime') or '').replace('Z', '+00:00'))
                    except (ValueError, TypeError):
                        continue
                    if stamp.tzinfo is not None:
                        stamps.add(stamp)
            if len(stamps) == 1:
                stamp = next(iter(stamps))
                score += 120 if window[0] <= stamp < window[1] else -80
        lead.update(articlePriority=score, leadType=route, routeReason=reason)
        if lead.get('status') in ('queued', 'routed_listing', 'non_news'):
            lead['status'] = 'routed_listing' if route == 'listing' else 'non_news' if route == 'static_page' else 'queued'
    return sorted(leads, key=lambda lead: (-lead['articlePriority'], lead.get('discoveredAt', ''), lead['source_url']))


def utcnow():
    return datetime.now(timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def source_revision_hash(record, source_hash=None, language_context=None):
    """Pin editorially relevant evidence, excluding transport observation time."""
    def stable(value):
        if isinstance(value, dict):
            return {key: stable(child) for key, child in value.items()
                    if key not in ('fetchedAt', 'observedAt', 'checkedAt', 'reparsedAt',
                                   'attemptedAt', 'transportAttemptsTotal', 'retryBudgetExhausted')}
        if isinstance(value, list):
            return [stable(child) for child in value]
        return value
    body_hash = source_hash or record.get('source_sha256') or record.get('transport_sha256')
    if not body_hash:
        body_hash = digest(json.dumps(record, ensure_ascii=False, sort_keys=True).encode())
    revision = {'sourceHash': body_hash, 'title': record.get('title') or record.get('meta', {}).get('og:title'),
                'canonicalURL': record.get('canonicalURL', record.get('canonical_url')),
                'publicationEvidence': record.get('publicationEvidence', record.get('publication_evidence', [])),
                'fullTextValidated': record.get('fullTextValidated'), 'articleBodyEvidence': record.get('articleBodyEvidence'),
                'sourceKind': record.get('source_kind'), 'sourceKindEvidence': record.get('sourceKindEvidence'),
                'parserVersion': record.get('parser_version', record.get('parserVersion'))}
    if language_context is not None:
        revision['registeredLanguagePolicy'] = language_context
        revision['htmlLanguage'] = record.get('html_lang', record.get('htmlLanguage', record.get('language')))
    return digest(json.dumps(stable(revision), ensure_ascii=False, sort_keys=True).encode())


def active_scan_events(events):
    """Newest parse of each actual response; every distinct fetch is retained."""
    latest = {}
    for row in events:
        key = (row.get('sourceId'), row.get('url'), row.get('role'), row.get('fetchedAt'))
        rank = (bool(row.get('reparsedAt')), row.get('reparsedAt') or '', row.get('observedAt') or '')
        previous = latest.get(key)
        if previous is None or rank >= previous[0]:
            latest[key] = (rank, row)
    return [value[1] for value in latest.values()]


def write_json(path, value):
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    temp.replace(path)


def rebase_discovery_paths(output):
    """Relocate only hash-proven evidence/sources files after archive extraction.

    All paths are validated before any metadata is written. URLs, hashes and
    fetch/publication timestamps are never rewritten. Symlinks escaping output,
    traversal components and unproven files are rejected.
    """
    root = Path(output).resolve()
    paths = [root / n for n in ('candidate_ledger.json', 'lead_queue.json', 'source_scan_audit.json')]
    documents = {p: json.loads(p.read_text()) for p in paths if p.exists()}
    proofs = defaultdict(set)

    def collect(value):
        if isinstance(value, dict):
            if value.get('localPath') and re.fullmatch(r'[0-9a-f]{64}', str(value.get('sha256', ''))):
                proofs[value['localPath']].add(value['sha256'])
            for child in value.values():
                collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)

    for document in documents.values():
        collect(document)

    verified_hashes = {}
    reused_hashes = 0

    def relocated(value, owner, key):
        nonlocal reused_hashes
        path = Path(value)
        if '..' in path.parts or '\\' in value or '\x00' in value:
            raise ValueError('unsafe discovery evidence path')
        markers = [i for i, part in enumerate(path.parts) if part in ('evidence', 'sources')]
        if not markers:
            raise ValueError('discovery path is outside evidence/sources')
        relative = Path(*path.parts[markers[-1]:])
        target = (root / relative).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            raise ValueError('missing or outside discovery evidence file: ' + str(relative))
        expected = set(proofs.get(value, set()))
        bound_hash = owner.get(key + 'Sha256')
        if re.fullmatch(r'[0-9a-f]{64}', str(bound_hash or '')):
            expected.add(bound_hash)
        if target in verified_hashes:
            actual = verified_hashes[target]
            reused_hashes += 1
        else:
            actual = digest(target.read_bytes())
            verified_hashes[target] = actual
        if not expected and key == 'sourceJSON':
            # Legacy merged origins omitted the full file proof. Their immutable
            # filename hash plus the independently pinned, verified text hash
            # permit a one-time upgrade to a full file hash.
            data = json.loads(target.read_text())
            source_hash = owner.get('sourceHash')
            text = data.get('text')
            name_proves = bool(re.search(r'-' + actual[:16] + r'\.json$', target.name))
            text_proves = isinstance(text, str) and digest(text.encode()) == source_hash == data.get('source_sha256')
            if name_proves and (text_proves or actual == source_hash):
                expected.add(actual)
                owner[key + 'Sha256'] = actual
        if not expected or actual not in expected or len(expected) != 1:
            raise ValueError('discovery evidence hash mismatch or missing proof: ' + str(relative))
        return str(target)

    changes = 0

    def walk(value):
        nonlocal changes
        if isinstance(value, dict):
            for key, child in list(value.items()):
                if key in ('sourceJSON', 'sourceHTML', 'localPath') and child:
                    before_hash = value.get(key + 'Sha256')
                    replacement = relocated(child, value, key)
                    if value.get(key + 'Sha256') != before_hash:
                        changes += 1
                    if replacement != child:
                        value[key] = replacement
                        changes += 1
                else:
                    walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    for document in documents.values():
        walk(document)
    if changes:
        for path, document in documents.items():
            write_json(path, document)
    return {'rebasedPaths': changes, 'verifiedMetadataFiles': len(documents),
            'evidenceFilesHashed': len(verified_hashes), 'evidenceHashReuses': reused_hashes}


def lead_state(leads):
    queued = [lead for lead in leads if lead.get('status') == 'queued']
    counts = defaultdict(int)
    for lead in queued:
        counts[lead['sourceId']] += 1
    return {'rawLeadsTotal': len(leads), 'rawLeadsQueued': len(queued),
            'rawLeadQueueRemaining': len(queued), 'queuedLeadSourceIds': sorted(counts),
            'rawLeadQueueBySource': dict(sorted(counts.items())), 'leadQueueFile': 'lead_queue.json'}


def listing_lead_evidence(output, events):
    """Recover genuine listing provenance for the one-time legacy migration."""
    result = {}
    for row in events:
        if row.get('role') == 'article' or not row.get('contentValidated') or not row.get('url'):
            continue
        cache = output / 'sources' / (digest(row['url'].encode())[:18] + '.json')
        if not cache.exists():
            continue
        record = json.loads(cache.read_text())
        if record.get('source_sha256') != row.get('sourceHash') or record.get('fetchedAt') != row.get('fetchedAt'):
            continue
        raw = json.dumps(record, sort_keys=True, ensure_ascii=False).encode()
        archive = output / 'evidence' / ('listing-' + digest(raw)[:24] + '.json')
        if not archive.exists():
            archive.write_bytes(raw)
        for link in record.get('links', []):
            if not isinstance(link, dict) or not public_url(link.get('url')):
                continue
            url = normal_url(link['url'])
            result.setdefault((row['sourceId'], url), {
                'url': row.get('final_url') or row['url'], 'observedAt': row['fetchedAt'],
                'description': 'Target link observed in fetched listing DOM', 'linkURL': url,
                'sha256': digest(raw), 'localPath': str(archive.resolve())})
    return result


def migrate_discovery_leads(output):
    """Offline migration: unattempted DOM URLs are leads, not editorial work."""
    output = Path(output)
    ledger_path, lead_path = output / 'candidate_ledger.json', output / 'lead_queue.json'
    if not ledger_path.exists():
        return {'movedToLeadQueue': 0, 'candidateCount': 0, 'rawLeadsQueued': 0}
    document = json.loads(ledger_path.read_text())
    lead_doc = json.loads(lead_path.read_text()) if lead_path.exists() else {}
    leads = {lead['id']: lead for lead in lead_doc.get('leadLedger', [])}
    event_path = output / 'source_scan_events.jsonl'
    events = [json.loads(line) for line in event_path.read_text().splitlines()] if event_path.exists() else []
    attempted = {(e['sourceId'], normal_url(e.get('url', ''))) for e in events if e.get('role') == 'article'}
    latest_fetch = {(e['sourceId'], e.get('url')): e.get('fetchedAt') for e in events if e.get('role') == 'article'}
    candidates, moved = [], 0
    need_migration = any(c.get('reason') == 'full_text_not_fetched_budget' and c.get('decision') == 'pending'
                         and not c.get('sourceJSON') and not c.get('fullTextFetchedAt')
                         and (c['sourceId'], c['source_url']) not in attempted
                         for c in document.get('candidateLedger', []))
    provenance = listing_lead_evidence(output, events) if need_migration else {}
    for candidate in document.get('candidateLedger', []):
        unattempted = (candidate.get('reason') == 'full_text_not_fetched_budget'
                       and candidate.get('decision') == 'pending' and not candidate.get('sourceJSON')
                       and not candidate.get('fullTextFetchedAt')
                       and (candidate['sourceId'], candidate['source_url']) not in attempted)
        has_attempt = bool(candidate.get('sourceJSON') or (candidate['sourceId'], candidate['source_url']) in attempted)
        status = 'queued' if unattempted else 'attempted' if has_attempt else 'retained_editorial_decision'
        old = leads.get(candidate['id'], {})
        lead = {k: candidate.get(k) for k in ('id', 'source_url', 'family', 'sourceId', 'sourceType', 'country', 'discoveredAt')}
        lead.update(old)
        lead['status'] = status
        if unattempted:
            lead['reason'] = 'full_text_not_fetched_budget'
            recovered = provenance.get((candidate['sourceId'], candidate['source_url']))
            if recovered:
                lead['evidence'], lead['listingEvidenceResolved'] = [recovered], True
            elif not old.get('listingEvidenceResolved'):
                lead['evidence'], lead['listingEvidenceResolved'] = candidate.get('evidence', []), False
            moved += 1
        else:
            lead['candidateId'] = candidate['id']
            lead['attemptedAt'] = (candidate.get('fullTextFetchedAt') or candidate.get('readableTextFetchedAt')
                                   or latest_fetch.get((candidate['sourceId'], candidate['source_url'])))
            lead.setdefault('evidence', candidate.get('evidence', []))
            candidates.append(candidate)
        leads[lead['id']] = lead
    state = lead_state(list(leads.values()))
    document.update(version=VERSION, candidateLedger=candidates)
    if moved:
        document['leadMigration'] = {'version': VERSION, 'movedToLeadQueue': moved,
                                     'remainingCandidates': len(candidates), 'observedAt': utcnow()}
    write_json(ledger_path, document)
    write_json(lead_path, {k: document[k] for k in ('version', 'country', 'issueDate', 'windowStart', 'windowEnd') if k in document} | {'leadLedger': list(leads.values())})
    for name in ('source_scan_audit.json', 'precollection_summary.json'):
        path = output / name
        if not path.exists():
            continue
        summary = json.loads(path.read_text())
        summary.update(state)
        funnel = summary.get('funnel', {})
        funnel.update(discoveredCandidates=len(candidates), pendingEditorialCandidates=sum(c.get('decision') == 'pending' for c in candidates),
                      rawLeadsTotal=state['rawLeadsTotal'], rawLeadsQueued=state['rawLeadsQueued'])
        summary['funnel'] = funnel
        if moved:
            summary['leadMigration'] = document['leadMigration']
        write_json(path, summary)
    return {'movedToLeadQueue': moved, 'candidateCount': len(candidates), **state}


def rerank_cached_leads(registry, country, output):
    """Offline replay of real archived DOM; preserve original fetch evidence."""
    output = Path(output)
    lead_path = output / 'lead_queue.json'
    document = json.loads(lead_path.read_text())
    leads = document.get('leadLedger', [])
    by_key = {(lead['sourceId'], lead['source_url']): lead for lead in leads}
    sources = {s['id']: s for s in registry['sources'] if s['country'].lower() == country}
    events = [json.loads(line) for line in (output / 'source_scan_events.jsonl').read_text().splitlines()]
    spec = importlib.util.spec_from_file_location('work_discovery_replay', Path(__file__).with_name('fetch_work_sources.py'))
    parser = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(parser)
    replayed, failures = set(), []
    for row in events:
        if row.get('role') == 'article' or not row.get('url') or row['sourceId'] not in sources:
            continue
        key = digest(row['url'].encode())[:18]
        cache, archive = output / 'sources' / (key + '.json'), output / 'sources' / (key + '.html.gz')
        if not cache.exists() or not archive.exists() or (row['sourceId'], key) in replayed:
            continue
        cached = json.loads(cache.read_text())
        if cached.get('fetchedAt') != row.get('fetchedAt'):
            continue
        try:
            raw = gzip.open(archive, 'rb').read()
            parsed = parser.parse_response(row['url'], cached.get('final_url', row['url']), raw, cached.get('response_headers', {}))
        except Exception as error:
            failures.append({'sourceId': row['sourceId'], 'url': row['url'], 'error': str(error)[:200]})
            continue
        replayed.add((row['sourceId'], key))
        for anchor in links_from(parsed):
            lead = by_key.get((row['sourceId'], normal_url(anchor['url'])))
            if lead is None:
                continue
            item = {k: anchor.get(k) for k in ('text', 'inHeading', 'articleCard', 'nearbyTimes', 'inNavigation')}
            item.update(listingURL=cached.get('final_url', row['url']), fetchedAt=row['fetchedAt'], parserVersion=parser.PARSER_VERSION)
            anchors = lead.setdefault('anchorEvidence', [])
            if item not in anchors:
                anchors.append(item)
    scan_path = output / 'source_scan_audit.json'
    scan = json.loads(scan_path.read_text())
    ledger_path = output / 'candidate_ledger.json'
    ledger_doc = json.loads(ledger_path.read_text())
    revised, closed_non_news = 0, 0
    event_ids = {row['eventId'] for row in events}
    for candidate in ledger_doc.get('candidateLedger', []):
        source = sources.get(candidate['sourceId'])
        if source is None:
            continue
        url = candidate['source_url']
        key = digest(url.encode())[:18]
        cache, archive = output / 'sources' / (key + '.json'), output / 'sources' / (key + '.html.gz')
        if not cache.exists() or not archive.exists():
            continue
        cached = json.loads(cache.read_text())
        if cached.get('status') != 200:
            continue
        record = dict(cached)
        try:
            record.update(parser.parse_response(url, cached.get('final_url', url), gzip.open(archive, 'rb').read(), cached.get('response_headers', {})))
        except Exception as error:
            record.update(contentValidated=False, fullTextValidated=False, parser_version=parser.PARSER_VERSION,
                          error='offline_body_reparse_' + str(error)[:160])
        stamp = cached.get('reparsedAt') if cached.get('parser_version') == parser.PARSER_VERSION else None
        record['reparsedAt'] = stamp or utcnow()
        record['fetchedAt'] = cached['fetchedAt']
        write_json(cache, record)
        source_hash = record.get('source_sha256') or candidate.get('sourceHash')
        route, route_reason = lead_route(url, source, {e['url'] for e in source_entries(source)})
        actual_language = record.get('html_lang')
        expected = [e.get('language') for e in source_entries(source) if e.get('language')]
        language = language_observation(source, expected, actual_language, record.get('final_url', url))
        revision = source_revision_hash(record, source_hash, source.get('knownMislabeledHtmlLanguages') or None)
        valid = bool(record.get('contentValidated') and allowed_url(record.get('final_url', url), source)
                     and (language['languageMatch'] is not False or language['knownLanguageMismatch']))
        old_decision = candidate.get('decision')
        if candidate.get('sourceRevisionHash') != revision:
            history = {k: candidate.get(k) for k in ('sourceJSON', 'sourceHTML', 'sourceJSONSha256', 'sourceHTMLSha256',
                        'sourceHash', 'sourceRevisionHash', 'evidence', 'publicationEvidence', 'fullTextFetchedAt', 'decision', 'reason')}
            candidate.setdefault('sourceHistory', []).append(history)
            candidate['previousDecision'] = old_decision
            raw_json = json.dumps(record, ensure_ascii=False, sort_keys=True).encode()
            snapshot = output / 'evidence' / (candidate['id'] + '-' + digest(raw_json)[:16] + '.json')
            if not snapshot.exists():
                snapshot.write_bytes(raw_json)
            evidence = [{'url': url, 'observedAt': cached['fetchedAt'], 'description': 'Original response reinterpreted offline; no new fetch',
                         'sha256': digest(raw_json), 'localPath': str(snapshot.resolve())}]
            if candidate.get('sourceHTML'):
                evidence.extend(e for e in candidate.get('evidence', []) if e.get('localPath') == candidate['sourceHTML'])
            raw_publication = record.get('publicationEvidence', [])
            candidate.update(sourceHash=source_hash, sourceRevisionHash=revision, sourceJSON=str(snapshot.resolve()),
                             sourceJSONSha256=digest(raw_json), evidence=evidence, reparsedAt=record['reparsedAt'],
                             fullTextFetchedAt=cached['fetchedAt'] if valid else None,
                             readableTextFetchedAt=cached['fetchedAt'] if valid else None,
                             machineArticleKind=record.get('source_kind'), fullTextValidated=record.get('fullTextValidated'),
                             **language,
                             articleBodyEvidence=record.get('articleBodyEvidence'), sourceKindEvidence=record.get('sourceKindEvidence'),
                             rawPublicationEvidence=raw_publication, firstDisclosureVerified=False, articleIdentityVerified=False)
            candidate['publicationEvidence'] = [{'url': e.get('articleUrl') or record.get('final_url', url), 'observedAt': cached['fetchedAt'],
                'description': 'Source publication evidence reinterpreted offline; first disclosure requires review',
                'quote': str(e.get('raw', '')), 'sha256': digest(raw_json), 'kind': e.get('kind'), 'timezoneEvidence': e.get('timezoneEvidence')}
                for e in raw_publication if isinstance(e, dict)]
            candidate['publicationWindowAssessment'] = assess_window(record, country, datetime.fromisoformat(document['windowStart']), datetime.fromisoformat(document['windowEnd']))
            candidate.update(decision='pending', reason='requires_semantic_and_first_disclosure_review', decisionOrigin=None)
            for review in ('articleIdentityReview', 'languageReview', 'firstDisclosureEvidence'):
                candidate.pop(review, None)
            revised += 1
        if route in ('listing', 'static_page'):
            candidate.update(decision='pending' if old_decision == 'selected' else 'rejected',
                             reason='selected_route_conflict_needs_review' if old_decision == 'selected' else 'explicit_non_news_route:' + route_reason,
                             decisionOrigin=None if old_decision == 'selected' else 'mechanical')
            closed_non_news += old_decision != 'selected'
        elif not valid:
            candidate.update(decision='pending', reason='pending_body_identity_verification', decisionOrigin=None, fullTextFetchedAt=None)
        elif language['languageReviewRequired'] and not current_language_review(candidate, source_hash, revision, language['knownLanguageMismatch']):
            candidate.update(decision='pending', reason='needs_language_review', decisionOrigin=None)
        elif candidate.get('publicationWindowAssessment') == 'outside_window':
            candidate.update(decision='rejected', reason='explicit_publication_outside_window', decisionOrigin='mechanical')
        kind = 'listing' if route == 'listing' else 'static_page' if route == 'static_page' else record.get('source_kind', 'unknown')
        row = {'sourceId': source['id'], 'family': source['family'], 'sourceType': source.get('kind', 'media'),
               'institutionType': source.get('institutionType'), 'role': 'article', 'url': url,
               'observedAt': record['reparsedAt'], 'reparsedAt': record['reparsedAt'], 'fetchedAt': cached['fetchedAt'],
               'kind': kind, 'status': 200, 'contentValidated': valid, 'fullTextValidated': record.get('fullTextValidated'),
               'articleBodyEvidence': record.get('articleBodyEvidence'), 'final_url': record.get('final_url', url),
               **language, 'expectedLanguage': expected,
               'linksFound': len(links_from(record)), 'sourceHash': source_hash,
               'sourceRevisionHash': revision, 'canonicalURL': record.get('canonical_url'), 'parserVersion': parser.PARSER_VERSION,
               'error': record.get('error'), 'routeReason': route_reason}
        row['eventId'] = digest(json.dumps({k: v for k, v in row.items() if k not in ('observedAt', 'reparsedAt')}, sort_keys=True).encode())
        if row['eventId'] not in event_ids:
            with (output / 'source_scan_events.jsonl').open('a') as handle:
                handle.write(json.dumps(row, ensure_ascii=False) + '\n')
            event_ids.add(row['eventId'])
            events.append(row)
    write_json(ledger_path, ledger_doc)
    scan.update(sourceScanAudit=active_scan_events(events), sourceScanAuditHistory=events)
    queue = {(j['sourceId'], j['url']): j for j in scan.get('listingQueue', [])}
    reports = []
    for sid, source in sources.items():
        ranked = rank_leads([lead for lead in leads if lead['sourceId'] == sid], source)
        eligible = [lead for lead in ranked if lead['leadType'] in ('article_candidate', 'article_deferred')]
        old_urls = list(dict.fromkeys(row['url'] for row in events if row.get('sourceId') == sid and row.get('role') == 'article'))[:12]
        old_non_news = [url for url in old_urls if lead_route(url, source, {e['url'] for e in source_entries(source)})[0] in ('listing', 'static_page')]
        def row(lead):
            return {k: lead.get(k) for k in ('source_url', 'articlePriority', 'leadType', 'routeReason', 'status', 'anchorEvidence')}
        reports.append({'sourceId': sid, 'family': source['family'],
                        'priorActualArticleAttempts': old_urls, 'priorNonNewsArticleAttempts': old_non_news,
                        'nextQueuedTop12': [row(lead) for lead in eligible if lead['status'] == 'queued'][:12],
                        'allEligibleTop12': [row(lead) for lead in eligible[:12]]})
        expected = next((e.get('language') for e in source_entries(source) if e.get('language')), None)
        for lead in ranked:
            if lead['leadType'] in ('listing', 'static_page'):
                queue.setdefault((sid, lead['source_url']), {'sourceId': sid, 'url': lead['source_url'], 'role': 'section', 'language': expected})
    state = lead_state(leads)
    state.update(routedListingLeads=sum(lead.get('leadType') == 'listing' for lead in leads),
                 permanentPageLeads=sum(lead.get('leadType') == 'static_page' for lead in leads))
    candidates = ledger_doc.get('candidateLedger', [])
    active_articles = [row for row in scan['sourceScanAudit'] if row.get('role') == 'article' and row.get('kind') == 'article' and row.get('contentValidated') and row.get('fullTextValidated') is True]
    current_counts = {'discoveredCandidates': len(candidates),
                      'fullTextReadableCandidates': sum(bool(c.get('fullTextFetchedAt')) for c in candidates),
                      'pendingEditorialCandidates': sum(c.get('decision') == 'pending' for c in candidates),
                      'rejectedCandidates': sum(c.get('decision') == 'rejected' for c in candidates),
                      'machineArticleCandidatesWithReadableFullText': len({row['url'] for row in active_articles}),
                      'explicitlyInWindowCandidates': sum(c.get('decision') != 'rejected' and bool(c.get('fullTextFetchedAt')) and c.get('publicationWindowAssessment') == 'in_window' and lead_route(c['source_url'], sources[c['sourceId']])[0] in ('article_candidate', 'article_deferred') for c in candidates)}
    document.update(version=VERSION, leadLedger=leads)
    write_json(lead_path, document)
    scan.update(state, listingQueue=list(queue.values()), listingQueueRemaining=len(queue))
    scan.setdefault('funnel', {}).update(current_counts, rawLeadsQueued=state['rawLeadsQueued'])
    write_json(scan_path, scan)
    summary_path = output / 'precollection_summary.json'
    if summary_path.exists():
        summary = json.loads(summary_path.read_text())
        summary.update(state, listingQueueRemaining=len(queue))
        summary.setdefault('funnel', {}).update(current_counts, rawLeadsQueued=state['rawLeadsQueued'])
        summary.update(historicalV14Counts={k: summary.get(k) for k in ('machineArticleCandidatesWithReadableFullText',)},
                       machineArticleCandidatesWithReadableFullText=current_counts['machineArticleCandidatesWithReadableFullText'])
        write_json(summary_path, summary)
    result = {'version': VERSION, 'parserVersion': parser.PARSER_VERSION, 'networkRequests': 0,
              'country': country, 'replayedListingPages': len(replayed), 'replayFailures': failures,
              **state, **current_counts, 'revisedCandidateEvidence': revised, 'closedExplicitNonNewsCandidates': closed_non_news,
              'sources': reports,
              'limitation': 'DOM/URL priority only; neither article identity, date window nor first disclosure is editorially approved.'}
    write_json(output / 'offline_rerank_report.json', result)
    return result


def public_url(value):
    try:
        p = urlparse(value)
        return p.scheme in ('http', 'https') and bool(p.hostname) and not p.username and not p.password
    except (TypeError, ValueError):
        return False


def normal_url(value):
    return urldefrag(value)[0]


def original_social_url(value):
    parsed = urlparse(value)
    host = (parsed.hostname or '').lower()
    if host in ('t.me', 'telegram.me', 'www.t.me'):
        return bool(re.fullmatch(r'/(?:s/)?[^/]+/\d+/?', parsed.path))
    if host in ('instagram.com', 'www.instagram.com'):
        return bool(re.match(r'^/(?:p|reel|tv)/[^/]+/?$', parsed.path))
    return False


def allowed_url(value, source):
    if not public_url(value):
        return False
    host = urlparse(value).hostname.lower()
    allowed = source.get('allowedHosts') or [urlparse(e['url']).hostname for e in source.get('entrypoints', [])]
    return host in {str(h).lower() for h in allowed if h}


def language_matches(expected, actual):
    # Missing declaration is recorded as unknown, never as a language match.
    if not actual:
        return None
    expected = expected if isinstance(expected, list) else [expected]
    wanted = {str(v).lower().replace('_', '-').split('-')[0] for v in expected if v and str(v).lower() != 'und'}
    return not wanted or str(actual).lower().replace('_', '-').split('-')[0] in wanted


def language_observation(source, expected, actual, final_url):
    """Keep declared HTML metadata separate from manually identified language.

    A verified, URL-scoped registry observation can explain one exact bad HTML
    tag. It permits DOM collection, never verifies a newly fetched article's
    content language. Unknown exceptions retain the ordinary strict check.
    """
    raw_tag = str(actual).strip().lower().replace('_', '-') if actual else None
    base = raw_tag.split('-')[0] if raw_tag else None
    match = language_matches(expected, actual)
    expected_values = expected if isinstance(expected, list) else [expected]
    wanted = {str(v).lower().replace('_', '-').split('-')[0] for v in expected_values if v}
    parsed = urlparse(final_url)
    exception = None
    rules = source.get('knownMislabeledHtmlLanguages', [])
    for rule in rules if isinstance(rules, list) else []:
        if not isinstance(rule, dict) or rule.get('status') != 'verified':
            continue
        declared = str(rule.get('declaredLanguage', '')).strip().lower().replace('_', '-')
        content = str(rule.get('contentLanguage', '')).strip().lower()
        host = str(rule.get('host', '')).strip().lower()
        prefixes = rule.get('pathPrefixes', [])
        excluded = rule.get('excludedPathPrefixes', [])
        if (declared != raw_tag or not re.fullmatch(r'[a-z]{2,3}', content) or content not in wanted or content == base
                or not allowed_url(final_url, source) or parsed.hostname != host
                or not isinstance(prefixes, list) or not prefixes or not isinstance(excluded, list)
                or any(not isinstance(p, str) or not p.startswith('/') or not p.endswith('/')
                       or '..' in p.split('/') for p in prefixes + excluded)
                or not any(parsed.path.startswith(p) for p in prefixes)
                or any(parsed.path.startswith(p) for p in excluded)):
            continue
        evidence = rule.get('evidence')
        try:
            reviewed = datetime.fromisoformat(rule['reviewedAt'].replace('Z', '+00:00'))
            if (not isinstance(rule.get('reviewer'), str) or not rule['reviewer'].strip()
                    or reviewed.tzinfo is None or reviewed > datetime.now(timezone.utc)
                    or not isinstance(evidence, list) or not evidence):
                continue
            for item in evidence:
                observed = datetime.fromisoformat(item['observedAt'].replace('Z', '+00:00'))
                if (not public_url(item.get('url')) or urlparse(item['url']).hostname != host
                        or observed.tzinfo is None or observed > reviewed
                        or not re.fullmatch(r'[0-9a-fA-F]{64}', str(item.get('sha256', '')))
                        or len(str(item.get('description', item.get('quote', ''))).strip()) < 8):
                    raise ValueError('unbound registry language evidence')
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
        exception = {k: copy.deepcopy(rule[k]) for k in ('declaredLanguage', 'contentLanguage', 'host',
                     'pathPrefixes', 'excludedPathPrefixes', 'reviewer', 'reviewedAt', 'evidence') if k in rule}
        break
    return {'language': None if exception else base, 'rawLanguage': actual,
            'languageVerified': bool(actual and match is True and not exception),
            'languageMatch': False if exception else match,
            'knownLanguageMismatch': exception,
            'languageReviewRequired': bool(exception)}


def current_language_review(candidate, source_hash, revision, mismatch):
    """Only retain a manual decision tied to this exact registered mismatch.

    Full evidence/time/reviewer validation remains the quantity gate's job.
    """
    if not mismatch:
        return True
    review = candidate.get('languageReview')
    return (isinstance(review, dict) and review.get('status') == 'verified'
            and review.get('sourceHash') == source_hash and review.get('sourceRevisionHash') == revision
            and language_matches(mismatch.get('contentLanguage'), review.get('language')) is True)


def round_robin(groups):
    queues = [deque(g) for g in groups if g]
    result = []
    while queues:
        remaining = []
        for queue in queues:
            result.append(queue.popleft())
            if queue:
                remaining.append(queue)
        queues = remaining
    return result


def fair_sources(sources):
    families = defaultdict(list)
    for source in sources:
        families[source['family']].append(source)
    return round_robin([families[k] for k in sorted(families)])


def source_entries(source):
    entries = list(source.get('entrypoints', []))
    default_language = next((e.get('language') for e in entries if e.get('language')), None)
    for field, role in (('sections', 'section'), ('archiveForms', 'archive'), ('paginationObserved', 'pagination')):
        values = source.get(field, [])
        if not isinstance(values, list):
            continue
        for value in values:
            if isinstance(value, str):
                value = {'url': value}
            if isinstance(value, dict) and public_url(value.get('url')):
                # Registry supplements contain actual observed URLs, never URL templates.
                entries.append(dict(value, role=value.get('role', role), language=value.get('language', default_language)))
    unique = {}
    for entry in entries:
        if entry.get('role') in LISTING_ROLES and public_url(entry.get('url')):
            unique.setdefault(normal_url(entry['url']), entry)
    return list(unique.values())


def links_from(record):
    links = []
    for entry in record.get('links', []):
        if isinstance(entry, dict) and public_url(entry.get('url')):
            links.append(entry)
    return links


def pagination_links(record, next_only=False):
    found = []
    for entry in record.get('nextLinks', record.get('next_links', [])):
        value = entry.get('url') if isinstance(entry, dict) else entry
        if public_url(value):
            found.append(value)
    for entry in record.get('page_links', []):
        if isinstance(entry, dict) and 'next' in str(entry.get('rel', '')).lower().split() and public_url(entry.get('url')):
            found.append(entry['url'])
    for entry in links_from(record):
        label = entry.get('text', '').strip().lower()
        rel = str(entry.get('rel', '')).lower()
        # The URL itself must have appeared in DOM; no guessed page URL/template.
        if ('next' in rel or re.fullmatch(r'\d{1,4}|[›»→]+', label)
                or re.search(r'^(next|older|далее|следующ|предыдущ|архив|archive)', label)):
            found.append(entry['url'])
    found=list(dict.fromkeys(normal_url(u) for u in found))
    if not next_only:return found
    # Follow one observed adjacent/next link, never all archive page numbers.
    current=record.get('final_url') or record.get('url') or ''
    at=re.search(r'(?:[?&]page=|/page/)(\d+)',current)
    current_page=int(at[1]) if at else 1
    safe=[]
    for url in found:
        page=re.search(r'(?:[?&]page=|/page/)(\d+)',url)
        if page and int(page[1])!=current_page+1:continue
        safe.append(url)
    return safe[:1]


def article_links(record, source, known_listings, structural_filter=False):
    pages = set(pagination_links(record)) | known_listings
    result = []
    for entry in links_from(record):
        url = normal_url(entry['url'])
        path = urlparse(url).path
        label = entry.get('text', '').strip()
        if not allowed_url(url, source) or url in pages:
            continue
        if structural_filter and (urlparse(url).scheme != 'https'
                or lead_route(url,source,known_listings)[0] in ('listing','static_page')):
            continue
        pattern = source.get('confirmedArticlePathPattern')
        if pattern and not re.fullmatch(pattern, path):
            continue
        if re.search(r'\.(?:pdf|jpe?g|png|gif|svg|zip|mp4|xml|json|css|js)$', path, re.I):
            continue
        # Structural navigation filtering only; no business/topic keyword filter.
        if len(label) < 12 or re.fullmatch(r'(?:https?://)?[^\s]+\.[a-z]{2,5}/?', label, re.I):
            continue
        if path.rstrip('/') in ('', '/ru', '/en', '/uz', '/kg', '/az'):
            continue
        result.append(url)
    return list(dict.fromkeys(result))


def published_intervals(record, country):
    """Use explicit publication evidence only; modification time is not publication."""
    evidence = record.get('publicationEvidence', record.get('publication_evidence', []))
    if isinstance(evidence, dict):
        evidence = evidence.get('items', [evidence])
    explicit = []
    for item in evidence or []:
        if not isinstance(item, dict):
            continue
        label = ' '.join(str(item.get(k, '')) for k in ('kind', 'field', 'property', 'type', 'label', 'attribute'))
        if re.search(r'modif|updat|edited|обнов|измен', label, re.I):
            continue
        if item.get('kind') != 'published' or item.get('timezoneEvidence') != 'explicit':
            continue
        value = next((item[k] for k in ('value', 'datetime', 'raw', 'iso', 'timestamp') if item.get(k)), None)
        if value:
            explicit.append(str(value))
    # v13 compatibility: explicit page publication metadata with a timezone.
    # When v14 provides evidence, never bypass its identity/classification checks.
    if not evidence:
        meta = record.get('meta') or {}
        for key in ('article:published_time', 'datePublished', 'pubdate', 'publish-date', 'publication_date'):
            if meta.get(key):
                explicit.append(str(meta[key]))
    intervals = []
    for raw in dict.fromkeys(explicit):
        try:
            stamp = datetime.fromisoformat(raw.replace('Z', '+00:00'))
            if stamp.tzinfo is not None:
                intervals.append((stamp, stamp, raw, 'timestamp'))
        except ValueError:
            continue
    return intervals


def assess_window(record, country, start, end):
    votes = set()
    for lo, hi, _, precision in published_intervals(record, country):
        if precision == 'timestamp':
            votes.add('in_window' if start <= lo < end else 'outside_window')
        elif hi <= start or lo >= end:
            votes.add('outside_window')
        elif start <= lo and hi <= end:
            votes.add('in_window')
        else:
            votes.add('uncertain')
    if len(votes) == 1:
        return next(iter(votes))
    if not votes and date_only_outside_window(record, start, end):
        return 'outside_window'
    return 'uncertain'


def date_only_outside_window(record, start, end):
    """Use article-bound calendar dates only to rule out an impossible window."""
    if record.get('source_kind') != 'article' or record.get('publicationReviewRequired'):
        return False
    urls = {normal_url(value).rstrip('/') for value in
            (record.get('final_url'), record.get('canonical_url'), record.get('url')) if isinstance(value, str) and value}
    evidence = record.get('publicationEvidence') or []
    if not isinstance(evidence, list):
        return False
    published = [item for item in evidence if isinstance(item, dict) and item.get('kind') == 'published']
    dates = set()
    for item in published:
        raw, url = item.get('raw'), item.get('articleUrl')
        if (item.get('precision') != 'date' or not isinstance(raw, str) or not re.fullmatch(r'\d{4}-\d\d-\d\d', raw)
                or not isinstance(url, str) or normal_url(url).rstrip('/') not in urls):
            return False
        try:
            dates.add(datetime.fromisoformat(raw).replace(tzinfo=timezone.utc))
        except ValueError:
            return False
    if len(dates) != 1:
        return False
    day = dates.pop()
    # Cover all possible local timezones. A plausible boundary date stays uncertain.
    return day + timedelta(hours=36) <= start or day - timedelta(hours=14) >= end


def load_fetcher(output):
    spec = importlib.util.spec_from_file_location('work_discovery_fetch', Path(__file__).with_name('fetch_work_sources.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.S = output / 'sources'
    module.S.mkdir(parents=True, exist_ok=True)
    return module.fetch


def discover(registry, country, issue_date, output, listing_not_before=None,
             max_pages_per_source=4, max_articles_per_source=30, workers=6,
             max_seconds=600, fetcher=None, clock=time.monotonic, only_source_ids=None, news_budget=False):
    if not math.isfinite(max_seconds) or max_seconds <= 0:
        raise ValueError('max-seconds must be finite and positive')
    output = Path(output)
    if only_source_ids is not None:
        for name in ('candidate_ledger.json', 'lead_queue.json', 'source_scan_audit.json'):
            path = output / name
            if path.exists():
                checkpoint = json.loads(path.read_text())
                if checkpoint.get('issueDate') != issue_date or checkpoint.get('country') != country:
                    raise ValueError('output belongs to another issue/country; use an isolated output directory')
    if listing_not_before:
        minimum = datetime.fromisoformat(listing_not_before.replace('Z', '+00:00'))
        if minimum.tzinfo is None or minimum > datetime.now(timezone.utc):
            raise ValueError('listing-not-before must be a past timezone-aware ISO timestamp')
    output.mkdir(parents=True, exist_ok=True)
    (output / 'sources').mkdir(exist_ok=True)
    (output / 'evidence').mkdir(exist_ok=True)
    evidence_metrics = rebase_discovery_paths(output)
    migrate_discovery_leads(output)
    fetcher = fetcher or load_fetcher(output)
    fetcher_parameters = inspect.signature(fetcher).parameters
    start_clock = clock()
    deadline = start_clock + max_seconds
    listing_deadline = start_clock + max_seconds * (.25 if news_budget else .55)
    bjt = timezone(timedelta(hours=8))
    end = datetime.fromisoformat(issue_date).replace(hour=6, tzinfo=bjt)
    start = end - timedelta(days=1)
    sources = [dict(s, family=s.get('family', s.get('publisherFamily', s['id'])))
               for s in registry['sources'] if s['country'].lower() == country]
    sources = fair_sources(sources)
    by_id = {s['id']: s for s in sources}
    all_sources = sources
    if only_source_ids is not None:
        sources = [s for s in sources if s['id'] in set(only_source_ids)]
        if {s['id'] for s in sources} != set(only_source_ids):
            raise ValueError('unknown bounded-supplement source ID')
    audit, events, budgets = [], [], []
    event_path = output / 'source_scan_events.jsonl'
    existing_events = set()
    historical_events = []
    if event_path.exists():
        for line in event_path.read_text().splitlines():
            try:
                event = json.loads(line)
                existing_events.add(event['eventId'])
                historical_events.append(event)
            except (ValueError, KeyError):
                raise ValueError('invalid existing append-only source event log') from None
    ledger_path = output / 'candidate_ledger.json'
    old_doc = json.loads(ledger_path.read_text()) if ledger_path.exists() else {}
    if old_doc and (old_doc.get('issueDate') != issue_date or old_doc.get('country') != country):
        raise ValueError('output belongs to another issue/country; use an isolated output directory')
    for candidate in old_doc.get('candidateLedger', []):
        legacy = candidate.get('decision')
        if legacy in ('accepted', 'excluded'):
            candidate['previousDecision'] = legacy
            candidate['previousDecisions'] = candidate.get('previousDecisions', []) + [
                {k: candidate.get(k) for k in ('sourceHash', 'decision', 'reason', 'reviewedAt', 'reviewedBy')}]
            candidate['decision'] = {'accepted': 'selected', 'excluded': 'rejected'}[legacy]
    ledger = {c['id']: c for c in old_doc.get('candidateLedger', [])}
    lead_path = output / 'lead_queue.json'
    lead_doc = json.loads(lead_path.read_text()) if lead_path.exists() else {}
    leads = {lead['id']: lead for lead in lead_doc.get('leadLedger', [])}
    scan_path = output / 'source_scan_audit.json'
    previous_scan = json.loads(scan_path.read_text()) if scan_path.exists() else {}
    prior_jobs = previous_scan.get('listingQueue', [])
    visited_listing = {(e['sourceId'], e.get('url')) for e in historical_events
                       if e.get('role') != 'article' and e.get('contentValidated')}
    minimum = datetime.fromisoformat(listing_not_before.replace('Z', '+00:00')) if listing_not_before else None
    already_sampled = set()
    fresh_listings = set()
    for event in historical_events:
        if event.get('role') == 'article' or not event.get('fetchedAt') or event.get('fetchRetryable'):
            continue
        try:
            stamp = datetime.fromisoformat(event['fetchedAt'].replace('Z', '+00:00'))
            if minimum is None or stamp >= minimum:
                already_sampled.add(event['sourceId'])
            if minimum is not None and stamp >= minimum and event.get('status') == 200 and event.get('contentValidated'):
                fresh_listings.add(event['sourceId'])
        except (ValueError, TypeError):
            pass
    # A short run must not always spend its time on the same alphabetically
    # first families. At cutoff, only real after-minimum fetches clear this tier.
    unobserved = fair_sources([s for s in sources if s['id'] not in already_sampled])
    observed = fair_sources([s for s in sources if s['id'] in already_sampled])
    if news_budget:
        # Keep a short budget from ending before verified primary news feeds are reached.
        # Unobserved sources still precede revisits to already sampled publishers.
        for group in (unobserved, observed):
            group.sort(key=lambda source: source.get('preferredInBoundedScan') is not True)
    sources = unobserved + observed
    seen_listing, page_counts = set(), defaultdict(int)
    deferred_listing = []
    page_candidates = defaultdict(list)
    discovered = {}
    seed_groups = []
    focused_recovery = news_budget and only_source_ids is not None and minimum is not None
    body_rechecks = set()
    for source in sources:
        entries = source_entries(source)
        entries.sort(key=lambda e: (e.get('accessStatus') != 'public_html_readable_listing', e.get('role') != 'home'))
        jobs = [(source['id'], normal_url(e['url']), e.get('role', 'home'), e.get('language')) for e in entries]
        pending = [(j['sourceId'], j['url'], j['role'], j.get('language')) for j in prior_jobs
                   if j.get('sourceId') == source['id'] and allowed_url(j.get('url'), source)]
        if focused_recovery and source['id'] in fresh_listings:
            deferred_listing.extend(pending)
            continue
        all_jobs = list({(j[0], j[1]): j for j in pending + jobs}.values())
        home = next((j for j in jobs if j[2] == 'home'), jobs[0] if jobs else None)
        unvisited = [j for j in all_jobs if j != home and (j[0], j[1]) not in visited_listing]
        revisits = [j for j in all_jobs if j != home and (j[0], j[1]) in visited_listing]
        seed_groups.append(([home] if home else []) + unvisited + revisits)
    listing_queue = deque(round_robin(seed_groups))
    known_listings = {e['url'] for source in all_sources for e in source_entries(source)} | {job[1] for group in seed_groups for job in group}
    if only_source_ids is not None:
        known_listings.update(j['url'] for j in prior_jobs
                              if j.get('sourceId') in by_id and allowed_url(j.get('url'), by_id[j['sourceId']]))

    flights = _FetchFlights()
    fetch_metrics = {role: Counter(observations=0, fetchOperations=0, unmeasuredOperations=0,
                                   transportAttempts=0, transportRetries=0, cacheHits=0,
                                   archiveReparses=0, inRunReuses=0)
                     for role in ('listing', 'article')}

    def fetch_job(job, phase_deadline):
        minimum = listing_not_before if job[2] != 'article' else None
        source_role = 'article' if job[2] == 'article' else 'listing'
        operation_metrics = {}

        def actual_fetch():
            try:
                remaining = phase_deadline - clock()
                if remaining <= 0:
                    return {'url': job[1], 'contentValidated': False, 'fetchRetryable': True,
                            'error': 'source_scan_phase_deadline_exceeded'}
                hints = {}
                if 'source_role' in fetcher_parameters:
                    hints['source_role'] = source_role
                if 'network_timeout' in fetcher_parameters:
                    hints['network_timeout'] = remaining
                if 'fetch_metrics' in fetcher_parameters:
                    hints['fetch_metrics'] = operation_metrics
                if 'recheck_article_body' in fetcher_parameters:
                    hints['recheck_article_body'] = (job[0], job[1]) in body_rechecks and source_role == 'article'
                return fetcher(job[1], minimum, **hints)
            except TimeoutError:
                return {'url': job[1], 'contentValidated': False, 'fetchRetryable': True,
                        'error': 'source_network_deadline_exceeded'}
            except Exception as error:
                return {'url': job[1], 'fetchedAt': utcnow(), 'contentValidated': False,
                        'error': type(error).__name__ + ': ' + str(error)[:200]}

        record, owner = flights.get((job[1], minimum, source_role), actual_fetch)
        return record, owner, operation_metrics

    def observe(job, record, owner, operation):
        source_id, url, role, expected_language = job
        metrics = fetch_metrics['article' if role == 'article' else 'listing']
        metrics['observations'] += 1
        if owner:
            metrics['fetchOperations'] += 1
            if 'transportAttempts' in operation:
                metrics.update(operation)
                metrics['transportRetries'] += max(0, operation['transportAttempts'] - 1)
            else:
                metrics['unmeasuredOperations'] += 1
        else:
            metrics['inRunReuses'] += 1
        source = by_id[source_id]
        final_url = record.get('final_url', record.get('finalURL', url))
        actual_language = record.get('html_lang', record.get('htmlLanguage', record.get('language')))
        language = language_observation(source, expected_language, actual_language, final_url)
        valid = bool(not record.get('fetchRetryable') and record.get('status') == 200 and record.get('contentValidated') and allowed_url(final_url, source)
                     and (language['languageMatch'] is not False or language['knownLanguageMismatch']))
        error = record.get('error')
        if not allowed_url(final_url, source):
            error = 'unexpected_final_host'
        elif language['languageMatch'] is False and not language['knownLanguageMismatch']:
            error = 'unexpected_page_language'
        row = {'sourceId': source_id, 'family': source['family'], 'sourceType': source.get('kind', 'media'),
               'institutionType': source.get('institutionType'), 'role': role, 'url': url,
               'observedAt': utcnow(), 'fetchedAt': record.get('fetchedAt'),
               'kind': ('social_profile' if source.get('kind') == 'social' and not original_social_url(final_url)
                        else record.get('source_kind', 'unknown')), 'status': record.get('status'),
               'contentValidated': valid, 'final_url': final_url, **language,
               'expectedLanguage': expected_language,
               'linksFound': len(links_from(record)), 'error': error,
               'sourceHash': record.get('source_sha256'), 'sourceKindEvidence': record.get('sourceKindEvidence'),
               'canonicalURL': record.get('canonicalURL', record.get('canonical_url')),
               'sourceRevisionHash': source_revision_hash(record, language_context=source.get('knownMislabeledHtmlLanguages') or None),
               'fullTextValidated': record.get('fullTextValidated'), 'articleBodyEvidence': record.get('articleBodyEvidence'),
               'parserVersion': record.get('parser_version'), 'reparsedAt': record.get('reparsedAt')}
        for key in ('attemptedAt', 'transportAttemptsTotal', 'retryBudgetExhausted'):
            if key in record:
                row[key] = record[key]
        if record.get('fetchRetryable'):
            row['fetchRetryable'] = True
        identity = {k: v for k, v in row.items() if k != 'observedAt'}
        row['eventId'] = digest(json.dumps(identity, sort_keys=True).encode())
        audit.append(row)
        if row['eventId'] not in existing_events:
            with event_path.open('a') as handle:
                handle.write(json.dumps(row, ensure_ascii=False) + '\n')
            existing_events.add(row['eventId'])
            events.append(row)
        return valid, error, row

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        while listing_queue and clock() < listing_deadline:
            batch = []
            while listing_queue and len(batch) < workers:
                job = listing_queue.popleft()
                if (job[0], job[1]) in seen_listing:
                    continue
                if page_counts[job[0]] >= max_pages_per_source:
                    budgets.append({'sourceId': job[0], 'reason': 'listing_page_budget', 'url': job[1]})
                    deferred_listing.append(job)
                    continue
                seen_listing.add((job[0], job[1]))
                page_counts[job[0]] += 1
                batch.append(job)
            for job, fetched in zip(batch, pool.map(lambda job: fetch_job(job, listing_deadline), batch)):
                record, owner, operation = fetched
                valid, _, row = observe(job, record, owner, operation)
                if record.get('fetchRetryable'):
                    deferred_listing.append(job)
                if not valid:
                    continue
                source = by_id[job[0]]
                links = article_links(record, source, known_listings, structural_filter=news_budget)
                page_candidates[job[0]].append(links)
                anchors_by_url = defaultdict(list)
                for anchor in links_from(record):
                    anchors_by_url[normal_url(anchor['url'])].append(anchor)
                listing_raw = json.dumps(record, sort_keys=True, ensure_ascii=False).encode()
                listing_snapshot = output / 'evidence' / ('listing-' + digest(listing_raw)[:24] + '.json')
                if not listing_snapshot.exists():
                    listing_snapshot.write_bytes(listing_raw)
                for link in links:
                    discovered.setdefault((job[0], link), row['observedAt'])
                    key = digest((country + '\n' + job[0] + '\n' + link).encode())[:24]
                    if key not in leads:
                        leads[key] = {'id': key, 'source_url': link, 'sourceId': job[0], 'family': source['family'],
                                      'country': country, 'sourceType': source.get('kind', 'media'),
                                      'discoveredAt': row['observedAt'], 'status': 'queued',
                                      'reason': 'full_text_not_fetched_budget', 'listingEvidenceResolved': True,
                                      'evidence': [{'url': row['final_url'], 'observedAt': row.get('fetchedAt') or row['observedAt'],
                                                    'description': 'Target link observed in fetched listing DOM', 'linkURL': link,
                                                    'sha256': digest(listing_raw), 'localPath': str(listing_snapshot.resolve())}]}
                    anchors = leads[key].setdefault('anchorEvidence', [])
                    for anchor in anchors_by_url[link]:
                        item = {k: anchor.get(k) for k in ('text', 'inHeading', 'articleCard', 'nearbyTimes', 'inNavigation')}
                        item.update(listingURL=row['final_url'], fetchedAt=row.get('fetchedAt'))
                        if item not in anchors:
                            anchors.append(item)
                for url in pagination_links(record, next_only=news_budget):
                    if allowed_url(url, source) and (not news_budget or urlparse(url).scheme=='https') and (job[0], url) not in seen_listing:
                        known_listings.add(url)
                        listing_queue.append((job[0], url, 'pagination', job[3]))
        # Full-text evidence retains its own time budget even if a listing stalls.
        prior_article_jobs = defaultdict(list)
        for job in previous_scan.get('articleQueue', []):
            prior_article_jobs[job['sourceId']].append(job['url'])
        article_groups = []
        for source in sources:
            source_leads = [lead for lead in leads.values() if lead['sourceId'] == source['id']]
            ranked = rank_leads(source_leads, source, (start, end))
            if news_budget:
                for lead in ranked:
                    lead['queueAssessment']={'version':QUEUE_POLICY_VERSION,**importance(lead,end.isoformat())}
                ranked.sort(key=lambda lead:-(lead['articlePriority']+70*lead['queueAssessment']['important']))
            for lead in ranked:
                if lead['leadType']=='listing' or not news_budget and lead['leadType']=='static_page':
                    if (source['id'], lead['source_url']) not in seen_listing:
                        deferred_listing.append((source['id'], lead['source_url'], 'section', next((e.get('language') for e in source_entries(source) if e.get('language')), None)))
            urls = list(dict.fromkeys(round_robin(page_candidates[source['id']])))
            # A candidate need not remain on a changing homepage to be resumed.
            old_by_url = {c['source_url']: c for c in ledger.values() if c['sourceId'] == source['id']}
            queued_leads = {lead['source_url']: lead for lead in ranked if lead.get('status') == 'queued' and lead['leadType'] in ('article_candidate', 'article_deferred') and allowed_url(lead['source_url'], source)}
            old_pending = list(queued_leads)
            eligible = {lead['source_url'] for lead in ranked if lead['leadType'] in ('article_candidate', 'article_deferred')}
            resume = [u for u in prior_article_jobs[source['id']] if u in eligible and allowed_url(u, source)]
            unresolved = [u for u, candidate in old_by_url.items()
                          if focused_recovery and u in eligible and allowed_url(u, source)
                          and candidate.get('decision') == 'pending'
                          and not (candidate.get('fullTextFetchedAt') and candidate.get('fullTextValidated') is True)]
            body_rechecks.update((source['id'], url) for url in unresolved)
            needs_body = set(unresolved)
            resumable = set(resume) | queued_leads.keys() | needs_body
            urls = list(dict.fromkeys(old_pending + resume + unresolved + urls))
            urls = [u for u in urls if u in eligible]
            if news_budget:
                by_url={lead['source_url']:lead for lead in ranked}
                kept=[]
                for url in urls:
                    reason=bounded_review_reason({'kind':'article','url':url},
                        {'lead':by_url.get(url,{}),'candidate':old_by_url.get(url,{})},end.isoformat())
                    if reason in ('publisher_directory_requires_coverage_review','archive_url_discovery_requires_coverage_review',
                                  'listing_card_old_date_requires_coverage_review','archived_publication_requires_coverage_review'):
                        by_url[url]['discoveryDeferral']={'reason':reason,'completed':False}
                    else:kept.append(url)
                urls=kept
            # Spend the next batch on previously omitted/new evidence before reusing
            # already fetched pages. Repeated small runs must make forward progress.
            priority_by_url = {lead['source_url']: lead['articlePriority'] + (70 * lead.get('queueAssessment',{}).get('important',False) if news_budget else 0) for lead in ranked}
            urls.sort(key=lambda u: (u not in needs_body and (bool(old_by_url.get(u, {}).get('sourceJSON')) or old_by_url.get(u, {}).get('decision') in TERMINAL),
                                     -priority_by_url.get(u, 0)))
            for lead in ranked:
                if lead['source_url'] in resumable:
                    discovered.setdefault((source['id'], lead['source_url']), lead['discoveredAt'])
            needs_fetch = [u for u in urls if u in needs_body or u not in old_by_url or
                           (old_by_url[u].get('decision') == 'pending' and not old_by_url[u].get('sourceJSON'))]
            fetch_set = set(needs_fetch)
            rechecks = [u for u in urls if u not in fetch_set]
            if len(needs_fetch) > max_articles_per_source:
                budgets.append({'sourceId': source['id'], 'reason': 'article_budget', 'remaining': len(needs_fetch) - max_articles_per_source})
            selected_urls = needs_fetch[:max_articles_per_source]
            selected_urls += rechecks[:max_articles_per_source - len(selected_urls)]
            expected = [e.get('language') for e in source_entries(source) if e.get('language')]
            article_groups.append([(source['id'], u, 'article', expected) for u in selected_urls])
        article_queue = deque(round_robin(article_groups))
        deferred_article = []
        if news_budget and len(article_queue)>MAX_ACTIVE_ARTICLES:
            all_jobs=list(article_queue)
            article_queue=deque(all_jobs[:MAX_ACTIVE_ARTICLES])
            deferred_article.extend(all_jobs[MAX_ACTIVE_ARTICLES:])
        processed = set()
        while article_queue and clock() < deadline:
            batch = [article_queue.popleft() for _ in range(min(workers, len(article_queue)))]
            for job, fetched in zip(batch, pool.map(lambda job: fetch_job(job, deadline), batch)):
                record, owner, operation = fetched
                valid, error, row = observe(job, record, owner, operation)
                if record.get('fetchRetryable'):
                    deferred_article.append(job)
                    continue
                source = by_id[job[0]]
                url = job[1]
                key = digest((country + '\n' + job[0] + '\n' + url).encode())[:24]
                raw_json = json.dumps(record, ensure_ascii=False, sort_keys=True).encode()
                json_sha = digest(raw_json)
                source_hash = record.get('source_sha256') or record.get('transport_sha256') or json_sha
                revision_hash = source_revision_hash(record, source_hash, source.get('knownMislabeledHtmlLanguages') or None)
                json_path = output / 'evidence' / (key + '-' + json_sha[:16] + '.json')
                if not json_path.exists():
                    json_path.write_bytes(raw_json)
                evidence = [{'url': url, 'observedAt': row['observedAt'],
                             'description': 'Fetched source JSON; publication and first disclosure require editorial review',
                             'sha256': json_sha, 'localPath': str(json_path.resolve())}]
                cache_key = record.get('key') or digest(url.encode())[:18]
                archive = output / 'sources' / (cache_key + '.html.gz')
                html_path = None
                html_sha = None
                archive_bytes = archive.read_bytes() if archive.exists() else None
                raw_archive_matches = bool(archive_bytes is not None and record.get('transport_sha256') and
                                           digest(gzip.decompress(archive_bytes)) == record['transport_sha256'])
                if archive_bytes is not None and (valid or raw_archive_matches):
                    sha = digest(archive_bytes)
                    html_path = output / 'evidence' / (key + '-' + sha[:16] + '.html.gz')
                    if html_path.exists():
                        html_sha = digest(html_path.read_bytes())
                    else:
                        html_path.write_bytes(archive_bytes)
                        html_sha = sha
                    evidence.append({'url': row['final_url'], 'observedAt': row['observedAt'],
                                     'description': 'Original fetched HTML archive (gzip); hash covers archived bytes',
                                     'sha256': sha, 'localPath': str(html_path.resolve())})
                assessment = assess_window(record, country, start, end)
                decision, reason = 'pending', 'requires_semantic_and_first_disclosure_review'
                if not valid and record.get('status') == 200 and record.get('fullTextValidated') is False and error not in ('unexpected_page_language', 'unexpected_final_host'):
                    reason = 'pending_body_identity_verification'
                elif not valid:
                    decision, reason = 'rejected', error or 'unreadable_source'
                elif source.get('kind') == 'social' and not original_social_url(row['final_url']):
                    reason = 'social_profile_not_original_post'
                elif row['languageReviewRequired']:
                    reason = 'needs_language_review'
                elif assessment == 'outside_window':
                    decision, reason = 'rejected', 'explicit_publication_outside_window'
                elif record.get('source_kind') != 'article':
                    # Weak/missing OG/JSON-LD is not proof of a navigation page.
                    # Institution and local SME pages often omit these tags.
                    reason = 'needs_article_identity_review'
                elif not row['languageVerified']:
                    reason = 'needs_language_review'
                prior = ledger.get(key)
                if ((job[0], url) in body_rechecks and prior and not valid and record.get('status') != 200):
                    # A failed recovery request cannot resolve an unfinished
                    # story. Preserve the earlier evidence and the new audit.
                    prior['fetchEvidence'] = evidence
                    continue
                raw_publication = record.get('publicationEvidence', record.get('publication_evidence', []))
                if isinstance(raw_publication, dict):
                    raw_publication = raw_publication.get('items', [raw_publication])
                normalized_publication = [
                    {'url': e.get('articleUrl') or row['final_url'], 'observedAt': record.get('fetchedAt') or row['observedAt'],
                     'description': 'Source publication evidence: ' + str(e.get('field', e.get('kind', 'unclassified'))) + '; first disclosure is not established',
                     'quote': str(e.get('raw', e.get('value', e.get('datetime', '')))), 'sha256': json_sha,
                     'kind': e.get('kind'), 'timezoneEvidence': e.get('timezoneEvidence')}
                    for e in raw_publication if isinstance(e, dict)]
                item = {'id': key, 'source_url': url, 'final_url': row['final_url'],
                        'canonicalURL': record.get('canonicalURL', record.get('canonical_url')),
                        'country': country, 'family': source['family'], 'sourceId': job[0],
                        'sourceType': source.get('kind', 'media'), 'institutionType': source.get('institutionType'),
                        'discoveredAt': discovered[(job[0], url)],
                        'fullTextFetchedAt': record.get('fetchedAt') if valid and row['kind'] != 'social_profile' else None,
                        'readableTextFetchedAt': record.get('fetchedAt') if valid else None,
                        'language': row['language'], 'rawLanguage': row['rawLanguage'], 'languageVerified': row['languageVerified'],
                        'knownLanguageMismatch': row['knownLanguageMismatch'], 'languageReviewRequired': row['languageReviewRequired'],
                        'articleIdentityVerified': False,
                        'machineArticleKind': record.get('source_kind'), 'sourceKindEvidence': record.get('sourceKindEvidence'),
                        'fullTextValidated': record.get('fullTextValidated'), 'articleBodyEvidence': record.get('articleBodyEvidence'),
                        'publicationEvidence': normalized_publication, 'rawPublicationEvidence': raw_publication,
                        'publicationWindowAssessment': assessment,
                        'decision': decision, 'reason': reason, 'decisionOrigin': 'mechanical' if decision == 'rejected' else None,
                        'sourceHash': source_hash, 'sourceRevisionHash': revision_hash,
                        'sourceJSON': str(json_path.resolve()), 'sourceJSONSha256': json_sha,
                        'sourceHTML': str(html_path.resolve()) if html_path else None,
                        'sourceHTMLSha256': html_sha,
                        'evidence': evidence, 'firstDisclosureVerified': False}
                if news_budget:
                    lead=leads.get(key,{})
                    item['title']=record.get('title')
                    item['queueAssessment']={'version':QUEUE_POLICY_VERSION,
                        **importance({**lead,'title':record.get('title'),'source_url':url},end.isoformat())}
                if prior:
                    item['discoveredAt'] = prior.get('discoveredAt', item['discoveredAt'])
                    item['previousDecisions'] = prior.get('previousDecisions', [])
                    if (prior.get('sourceHash') == source_hash and prior.get('sourceRevisionHash') == revision_hash
                            and prior.get('decision') in TERMINAL and prior.get('decisionOrigin') != 'mechanical'
                            and current_language_review(prior, source_hash, revision_hash, row['knownLanguageMismatch'])):
                        for field in ('decision', 'reason', 'decisionOrigin', 'reviewedBy', 'reviewedAt', 'reviewEvidence', 'firstDisclosureVerified'):
                            if field in prior:
                                item[field] = prior[field]
                        item['manualDecisionPreserved'] = True
                        if prior.get('previousDecision'):
                            item['previousDecision'] = prior['previousDecision']
                        # Preserve the exact manually reviewed evidence and source
                        # snapshot binding; today's recheck is a separate record.
                        item['fetchEvidence'] = evidence
                        for field in ('evidence', 'publicationEvidence', 'rawPublicationEvidence', 'firstDisclosureEvidence',
                                      'sourceJSON', 'sourceHTML', 'publicationWindowAssessment', 'fullTextFetchedAt',
                                      'sourceJSONSha256', 'sourceHTMLSha256',
                                      'articleIdentityReview', 'articleIdentityVerified', 'languageReview',
                                      'languageEvidence', 'languageVerified'):
                            if field in prior:
                                item[field] = prior[field]
                    elif prior.get('sourceHash') != source_hash or prior.get('sourceRevisionHash') != revision_hash:
                        item['previousDecisions'] = item['previousDecisions'] + [{k: prior.get(k) for k in ('sourceHash', 'sourceRevisionHash', 'decision', 'reason', 'reviewedAt', 'reviewedBy')}]
                        item['previousDecision'] = prior.get('decision')
                        item['reopenedAfterSourceChange'] = prior.get('sourceHash') != source_hash
                        item['reopenedAfterRevisionChange'] = prior.get('sourceRevisionHash') != revision_hash
                ledger[key] = item
                lead = leads.get(key, {'id': key, 'source_url': url, 'sourceId': job[0], 'family': source['family'],
                                       'country': country, 'discoveredAt': discovered[(job[0], url)], 'evidence': []})
                lead.update(status='attempted', candidateId=key, attemptedAt=record.get('fetchedAt') or row['observedAt'])
                leads[key] = lead
                processed.add((job[0], url))

    # Unfetched URLs remain resumable leads; they are not editorial candidates.
    for (source_id, url), discovered_at in discovered.items():
        if (source_id, url) in processed:
            continue
        source = by_id[source_id]
        key = digest((country + '\n' + source_id + '\n' + url).encode())[:24]
        if key not in leads:
            leads[key] = {'id': key, 'source_url': url, 'family': source['family'], 'sourceId': source_id,
                          'sourceType': source.get('kind', 'media'), 'country': country,
                          'discoveredAt': discovered_at, 'status': 'queued', 'reason': 'full_text_not_fetched_budget',
                          'evidence': [{'url': url, 'observedAt': discovered_at, 'description': 'Previously observed DOM link; listing provenance requires verification'}]}
    for source in all_sources:
        if not any(r['sourceId'] == source['id'] for r in audit + historical_events):
            audit.append({'sourceId': source['id'], 'family': source['family'], 'sourceType': source.get('kind', 'media'),
                          'institutionType': source.get('institutionType'), 'role': None, 'fetchedAt': None,
                          'kind': 'not_scanned', 'status': None, 'contentValidated': False, 'final_url': None,
                          'language': None, 'linksFound': 0, 'error': 'no_listing_entrypoint_or_run_budget'})
    retryable_fetches = sum(bool(row.get('fetchRetryable')) for row in audit)
    current_placeholders = [r for r in audit if not r.get('eventId')]
    all_events = {e['eventId']: e for e in historical_events + events}
    audit_history = list(all_events.values())
    audit = active_scan_events(audit_history) + current_placeholders
    # One real article remains one candidate across repeated registry sources or
    # tracking aliases. Never trust a canonical pointing to a known homepage.
    prior_ids = {c['id'] for c in old_doc.get('candidateLedger', [])}
    groups = defaultdict(list)
    for item in ledger.values():
        canonical = item.get('canonicalURL')
        source = by_id.get(item['sourceId'])
        canonical_bound = bool(source and canonical and item.get('sourceHash') and item.get('fullTextFetchedAt')
                               and (item.get('machineArticleKind') == 'article' or item.get('articleIdentityReview', {}).get('status') == 'verified')
                               and allowed_url(canonical, source)
                               and canonical not in known_listings
                               and urlparse(canonical).path.rstrip('/') not in ('', '/ru', '/en', '/uz', '/kg', '/az'))
        # Equal text hashes prevent a broken non-root canonical from collapsing
        # unrelated articles. Exact requested URLs are unified in a second pass.
        identity = (normal_url(canonical), item['sourceHash']) if canonical_bound else (item['source_url'], None)
        groups[identity].append(item)
    exact_urls = {}
    for identity in list(groups):
        for item in list(groups[identity]):
            url = item['source_url']
            if url in exact_urls and exact_urls[url] != identity:
                destination = exact_urls[url]
                groups[destination].extend(groups.pop(identity))
                for moved in groups[destination]:
                    exact_urls[moved['source_url']] = destination
                break
            exact_urls[url] = identity
    candidates = []
    for group in groups.values():
        group.sort(key=lambda c: (c['id'] not in prior_ids, c.get('decision') != 'selected',
                                  not bool(c.get('fullTextFetchedAt')), c['sourceId'], c['source_url']))
        primary = group[0]
        origins = {}
        for item in group:
            entries = item.get('discoveryOrigins', []) + [
                {k: item.get(k) for k in ('id', 'sourceId', 'family', 'source_url', 'discoveredAt', 'sourceHash',
                                         'sourceJSON', 'canonicalURL', 'fullTextFetchedAt', 'articleIdentityReview',
                                         'languageReview', 'evidence', 'sourceJSONSha256', 'sourceRevisionHash')}]
            for entry in entries:
                origins[(entry.get('sourceId'), entry.get('source_url'))] = entry
        primary['discoveryOrigins'] = list(origins.values())
        for origin in origins.values():
            lead = leads.get(origin.get('id'))
            if lead and lead.get('status') == 'attempted':
                lead['candidateId'] = primary['id']
        candidates.append(primary)
    candidates.sort(key=lambda c: (c['sourceId'], c['source_url']))
    successful = {r['sourceId'] for r in audit if r['contentValidated'] and r['role'] != 'article'}
    language_verified = {r['sourceId'] for r in audit if r['contentValidated'] and r.get('languageMatch') is True and r['role'] != 'article'}
    unavailable = []
    for source in all_sources:
        declared = {normal_url(e['url']) for e in source_entries(source)}
        latest = {}
        for row in audit:
            if row['sourceId'] != source['id'] or not row.get('url') or not row.get('fetchedAt'):
                continue
            prior = latest.get(row['url'])
            if prior is None or datetime.fromisoformat(row['fetchedAt'].replace('Z', '+00:00')) >= datetime.fromisoformat(prior['fetchedAt'].replace('Z', '+00:00')):
                latest[row['url']] = row
        denied = {url for url, row in latest.items() if row.get('status') in (401, 403, 404, 410)}
        if declared and declared <= denied and source['id'] not in successful:
            unavailable.append(source['id'])
    candidate_funnel = {'discoveredCandidates': len(candidates),
                        'fullTextReadableCandidates': sum(bool(c.get('fullTextFetchedAt')) for c in candidates),
                        'explicitlyInWindowCandidates': sum(bool(c.get('fullTextFetchedAt')) and c.get('decision') != 'rejected'
                            and c.get('publicationWindowAssessment') == 'in_window'
                            and lead_route(c['source_url'], by_id.get(c['sourceId'], {'id': c['sourceId']}))[0] in ('article_candidate', 'article_deferred')
                            for c in candidates),
                        'pendingEditorialCandidates': sum(c.get('decision') == 'pending' for c in candidates),
                        'selectedByHuman': sum(c.get('decision') == 'selected' and c.get('decisionOrigin') != 'mechanical' for c in candidates),
                        'rejectedCandidates': sum(c.get('decision') == 'rejected' for c in candidates)}
    raw_state = lead_state(list(leads.values()))
    candidate_funnel.update(rawLeadsTotal=raw_state['rawLeadsTotal'], rawLeadsQueued=raw_state['rawLeadsQueued'])
    funnel = {'registeredSources': len(all_sources), 'sampledSources': len({r['sourceId'] for r in audit if r['fetchedAt'] and not r.get('fetchRetryable')}),
              'readableListingSources': len(successful),
              'languageVerifiedListingSources': len(language_verified),
              'readableMediaFamilies': len({s['family'] for s in all_sources if s['id'] in successful and s.get('kind', 'media') == 'media'}),
              'readableInstitutionSources': sum(s['id'] in successful and s.get('kind') == 'institution' for s in all_sources),
              **candidate_funnel}
    remaining_listing = list({(j[0], j[1]): j for j in list(listing_queue) + deferred_listing}.values())
    listing_jobs = [{'sourceId': j[0], 'url': j[1], 'role': j[2], 'language': j[3]} for j in remaining_listing]
    article_jobs = [{'sourceId': j[0], 'url': j[1], 'role': j[2], 'language': j[3]} for j in list(article_queue) + deferred_article]
    run_source_ids = [s['id'] for s in sources]
    if only_source_ids is not None:
        # A focused pass must not discard work queued for other sources.
        skipped_source_ids = by_id.keys() - set(run_source_ids)
        listing_jobs.extend(j for j in prior_jobs if j.get('sourceId') in skipped_source_ids)
        article_jobs.extend(j for j in previous_scan.get('articleQueue', [])
                            if j.get('sourceId') in skipped_source_ids)
    incomplete = bool(listing_jobs or article_jobs or budgets or raw_state['rawLeadsQueued'] or len(successful) < len(all_sources))
    result = {'version': VERSION, 'issueDate': issue_date, 'country': country, 'observedAt': utcnow(),
              'windowStart': start.isoformat(), 'windowEnd': end.isoformat(),
              'sourceScanAudit': audit, 'sourceScanAuditHistory': audit_history,
              'funnel': funnel, 'budgetEvents': budgets, 'runSourceIds': run_source_ids,
              'unavailableSourceIds': unavailable,
              'listingQueueRemaining': len(listing_jobs), 'articleQueueRemaining': len(article_jobs),
              'listingQueue': listing_jobs, 'articleQueue': article_jobs,
              'maxPagesPerSource': max_pages_per_source, 'maxArticlesPerSource': max_articles_per_source,
              'maxSeconds': max_seconds, 'pageFetchCounts': dict(page_counts),
              'newsBudget': {'version':QUEUE_POLICY_VERSION,'maxActiveArticles':MAX_ACTIVE_ARTICLES,
                             'listingFraction':.25} if news_budget else None,
              'retryableFetchesThisRun': retryable_fetches,
              'fetchMetrics': fetch_metrics, 'evidenceReadMetrics': evidence_metrics,
              'elapsedSeconds': round(clock() - start_clock, 3), 'complete': not incomplete,
              'needs_expansion': incomplete,
              **raw_state,
              'editorialComplete': False, 'limitation': 'Finite DOM crawl only; counts are candidates, not publishable news. Unknown dates/languages and first disclosure need review.'}
    write_json(ledger_path, {'version': VERSION, 'country': country, 'issueDate': issue_date,
                             'windowStart': start.isoformat(), 'windowEnd': end.isoformat(), 'candidateLedger': candidates})
    write_json(lead_path, {'version': VERSION, 'country': country, 'issueDate': issue_date,
                           'windowStart': start.isoformat(), 'windowEnd': end.isoformat(), 'leadLedger': list(leads.values())})
    write_json(scan_path, result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--registry', type=Path)
    parser.add_argument('--country', choices=sorted(OFFSETS))
    parser.add_argument('--issue-date')
    parser.add_argument('--output', type=Path, required=True)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--rebase-only', action='store_true', help='Offline: verify and relocate extracted evidence paths only')
    modes.add_argument('--migrate-leads-only', action='store_true', help='Offline: separate unattempted legacy DOM leads from actual candidates')
    parser.add_argument('--listing-not-before')
    parser.add_argument('--only-source-id', action='append',
                        help='Focus a follow-up pass on this registered country source; repeat for other gaps')
    parser.add_argument('--max-pages-per-source', type=int, default=4)
    parser.add_argument('--max-articles-per-source', type=int, default=30)
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--max-seconds', type=float, default=600,
                        help='Network collection budget including retries; local evidence processing and writes may add time')
    args = parser.parse_args()
    if args.rebase_only or args.migrate_leads_only:
        if args.only_source_id:
            parser.error('--only-source-id applies to a discovery pass, not offline maintenance')
        result = rebase_discovery_paths(args.output)
        if args.migrate_leads_only:
            result.update(migrate_discovery_leads(args.output))
        print(json.dumps(result, ensure_ascii=False))
        return
    if not args.registry or not args.country or not args.issue_date:
        parser.error('--registry, --country and --issue-date are required for network discovery')
    if (min(args.max_pages_per_source, args.max_articles_per_source, args.workers, args.max_seconds) <= 0
            or not math.isfinite(args.max_seconds)):
        parser.error('all budgets and workers must be positive')
    result = discover(json.loads(args.registry.read_text()), args.country, args.issue_date, args.output,
                      args.listing_not_before, args.max_pages_per_source,
                      args.max_articles_per_source, args.workers, args.max_seconds,
                      only_source_ids=args.only_source_id)
    print(json.dumps({k: result[k] for k in ('version', 'funnel', 'complete', 'editorialComplete',
                                             'listingQueueRemaining', 'articleQueueRemaining',
                                             'elapsedSeconds', 'runSourceIds', 'retryableFetchesThisRun',
                                             'fetchMetrics', 'evidenceReadMetrics')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
