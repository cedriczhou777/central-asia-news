"""Close bounded source attempts without hiding unfinished discovery or articles."""

from datetime import datetime, timedelta, timezone
import math
import hashlib
from pathlib import Path
from urllib.parse import urlsplit

from editorial_policy import EFFECTIVE_ISSUE, MIN_ARTICLES, TARGET_ARTICLES
from work_quantity_policy import _dt, _listing_attempt, _url, terminal_source_failure
from news_queue_policy import partition_coverage, validate_queue_accounting


COVERAGE_VERSION = 'plan-b-coverage-2'
CRITICAL_TOPICS = {'policy', 'energy', 'investment', 'business'}


def assess_coverage(registry, country, inventory, cutoff, ledger=(), leads=(), observed_at=None):
    observed = _dt(observed_at) if observed_at else datetime.now(timezone.utc)
    sources = {s['id']: s for s in registry['sources']
               if s['country'].lower() == country and s.get('available') is not False}
    latest = {}
    for row in inventory.get('sourceScanAuditHistory', []) + inventory.get('sourceScanAudit', []):
        sid, url = row.get('sourceId'), _url(row.get('url'))
        if sid not in sources or not url or not _listing_attempt(row):
            continue
        if sources[sid].get('allowedHosts') and urlsplit(url).hostname not in sources[sid]['allowedHosts']:
            continue
        try:
            stamp = _dt(row.get('fetchedAt') or row.get('attemptedAt'))
            if not cutoff - timedelta(days=1) <= stamp <= observed:
                continue
        except (ValueError, TypeError):
            continue
        key = sid, url
        if key not in latest or stamp >= latest[key][0]:
            latest[key] = stamp, row

    readable, gaps, pending, review_work = [], [], [], []
    max_seconds = inventory.get('maxSeconds')
    # An integral scan budget has the same JSON representation before and after
    # Node transports the frozen proof back to Python for release verification.
    if type(max_seconds) is float and max_seconds.is_integer():
        max_seconds = int(max_seconds)
    try:
        bounded_scan = (type(max_seconds) in (int, float)
                        and math.isfinite(max_seconds) and 0 < max_seconds <= 480
                        and cutoff <= _dt(inventory.get('observedAt')) <= observed)
    except (ValueError, TypeError):
        bounded_scan = False

    def gap(sid, reason, evidence=()):
        prior = next((item for item in gaps if item['sourceId'] == sid), None)
        if prior:
            prior.setdefault('reasons', [prior['reason']])
            if reason not in prior['reasons']:
                prior['reasons'].append(reason)
            prior['evidence'].extend(item for item in evidence if item not in prior['evidence'])
        else:
            gaps.append({'sourceId': sid, 'reason': reason, 'evidence': list(evidence)})

    def block(sid, kind, url, reason):
        item = {'sourceId': sid, 'kind': kind, 'url': url, 'reason': reason}
        if item not in pending:
            pending.append(item)

    for sid, source in sorted(sources.items()):
        records = [(stamp, row) for (owner, _), (stamp, row) in latest.items() if owner == sid]
        fresh = [row for stamp, row in records if stamp >= cutoff and row.get('status') == 200
                 and row.get('contentValidated') is True and not row.get('fetchRetryable')]
        entries = {_url(e.get('url')) for e in source.get('entrypoints', [])}
        failures = [row for _, row in records if terminal_source_failure(row)]
        denied = {_url(row.get('url')) for row in failures}
        # A single failed alias never declares all of that publisher unavailable.
        terminal = bool(entries and None not in entries and entries <= denied)
        if fresh:
            readable.append(sid)
        elif not terminal:
            if not records and entries and None not in entries and bounded_scan and sid in inventory.get('runSourceIds', []):
                # A bounded run may not reach every registration. This is an
                # explicit unobserved gap, never an assertion of unavailability.
                gap(sid, 'not_observed_within_scan_budget')
            elif failures and bounded_scan and all(terminal_source_failure(row) for _, row in records):
                # The attempted aliases are exhausted; untried alternatives stay
                # explicit review work, not a claim that every alias failed.
                gap(sid, 'entrypoint_unavailable_with_unobserved_alternatives')
            elif bounded_scan:
                # Exhausted listing observation is a coverage-review gap, not
                # proof of a missing important article. Concrete queued bodies
                # and increments are assessed separately below and stay open.
                gap(sid, 'final_source_observation_budget_ended',
                    [{'url':row['url'],'status':row.get('status'),
                      'observedAt':row.get('fetchedAt') or row.get('attemptedAt'),
                      'contentValidated':row.get('contentValidated',False)} for _,row in records])
            else:
                block(sid, 'increment' if any(row.get('contentValidated') for _, row in records) else 'source',
                      None, 'final_window_observation_required')
        if failures:
            gap(sid, 'source_unavailable' if terminal and not fresh else 'entrypoint_unavailable',
                [{'url': row['url'], 'status': row.get('status'), 'error': row.get('error'),
                                       'failureType': 'http_refusal' if row.get('status') in (401, 403, 404, 410)
                                           else 'unusable_response' if row.get('status') == 200
                                           else 'security_rejection' if row.get('error') == 'source_public_https_only'
                                           else 'retry_exhausted',
                                       'contentValidated': row.get('contentValidated', False),
                                       'observedAt': row.get('fetchedAt') or row.get('attemptedAt'),
                                       'retryBudgetExhausted': row.get('retryBudgetExhausted', False),
                                       'transportAttemptsTotal': row.get('transportAttemptsTotal')}
                 for row in sorted(failures, key=lambda r: r['url'])])

    queues = {}
    closed = []
    for key, kind in (('listingQueue', 'listing'), ('articleQueue', 'article')):
        jobs = inventory.get(key, [])
        count = inventory.get(key + 'Remaining', len(jobs))
        queues[kind] = count
        if type(count) is not int or count < 0 or count != len(jobs):
            block('discovery', kind, None, 'unaccounted_queue_count')
        for job in jobs:
            sid, url = job.get('sourceId', 'discovery'), _url(job.get('url'))
            actual = latest.get((sid, url))
            # Only an actual terminal request closes its exact listing job.
            # A discovered article remains work even if its publisher is denied.
            if kind == 'listing' and actual and terminal_source_failure(actual[1]):
                closed.append({'sourceId': sid, 'kind': kind, 'url': url, 'reason': 'terminal_request'})
            elif (kind == 'listing' and bounded_scan and url and
                  (any(g['sourceId'] == sid and g['reason'] in (
                       'not_observed_within_scan_budget', 'entrypoint_unavailable_with_unobserved_alternatives') for g in gaps)
                   or sid in readable and type(inventory.get('maxPagesPerSource')) is int
                   and inventory['maxPagesPerSource'] > 0
                   and inventory.get('pageFetchCounts', {}).get(sid, 0) >= inventory['maxPagesPerSource'])):
                review_work.append({'sourceId': sid, 'kind': kind, 'url': url, 'reason': 'discovery_budget_requires_review'})
                gap(sid, 'unfinished_discovery_requires_review')
            else:
                block(sid, kind, url, 'unfinished_discovery' if kind == 'listing' else 'article_body_pending')

    for row in ledger:
        if row.get('decision') != 'rejected' and not (row.get('fullTextValidated') is True and row.get('fullTextFetchedAt')):
            block(row.get('sourceId', 'discovery'), 'article', row.get('source_url'), 'discovered_article_needs_body_or_review')
    queued_leads = [row for row in leads if row.get('status') == 'queued']
    lead_count = inventory.get('rawLeadsQueued', inventory.get('rawLeadQueueRemaining', len(queued_leads)))
    queues['lead'] = lead_count
    if type(lead_count) is not int or lead_count < 0 or lead_count != len(queued_leads):
        block('discovery', 'lead', None, 'unaccounted_lead_queue')
    for row in queued_leads:
        block(row.get('sourceId', 'discovery'), 'lead', row.get('source_url'), 'unprocessed_original_lead')
    # A scan budget cannot silently disappear merely because no job was saved.
    for item in inventory.get('budgetEvents', []):
        sid = item.get('sourceId', 'discovery')
        if item.get('reason') == 'listing_page_budget':
            url = _url(item.get('url'))
            if not any(row['sourceId'] == sid and row.get('url') == url for row in pending + review_work + closed):
                block(sid, 'listing', url, 'unaccounted_pagination_budget')
        elif item.get('remaining', 0):
            block(sid, 'article' if item.get('reason') == 'article_budget' else 'discovery',
                  None, 'unresolved_discovery_budget')

    pending.sort(key=lambda r: (r['sourceId'], r['kind'], r['url'] or '', r['reason']))
    daily_policy = cutoff.date().isoformat() >= EFFECTIVE_ISSUE
    proof = {'version': COVERAGE_VERSION, 'country': country, 'windowEnd': cutoff.isoformat(),
            'observedAt': observed.isoformat(),
            'state': 'blocked' if pending else 'review_required' if gaps else 'observed',
            'readableSources': sorted(readable), 'gaps': gaps, 'pendingWork': pending,
            'queues': queues, 'closedQueueWork': closed, 'reviewWork': review_work,
            'scanBudget': {'bounded': bounded_scan, 'maxSeconds': max_seconds,
                           'observedAt': inventory.get('observedAt')},
            'coverageChecked': False, 'normalTarget': [TARGET_ARTICLES, 8] if daily_policy else [15, 20],
            'scarcityRange': [MIN_ARTICLES, TARGET_ARTICLES - 1] if daily_policy else [10, 14]}
    metadata = {}
    for row in leads:
        metadata.setdefault((row.get('sourceId'), _url(row.get('source_url'))), {})['lead'] = row
    for row in ledger:
        metadata.setdefault((row.get('sourceId'), _url(row.get('source_url'))), {})['candidate'] = row
    for row in inventory.get('budgetEvents', []):
        if row.get('reason') == 'article_budget':
            metadata.setdefault((row.get('sourceId'), None), {})['budget'] = row
    return partition_coverage(proof, sources, metadata)


def require_coverage_review(coverage, draft, review, final_hash, candidates):
    """Gaps need the same independent reviewer, actual alternatives, and topic checks."""
    if coverage.get('version') != COVERAGE_VERSION or coverage.get('pendingWork') or coverage.get('state') == 'blocked':
        raise ValueError('freeze_incomplete')
    validate_queue_accounting(coverage)
    if not coverage.get('gaps'):
        return
    check = review.get('coverageReview') or {}
    try:
        stamp = _dt(check.get('reviewedAt'))
        if not _dt(coverage['observedAt']) <= stamp <= datetime.now(timezone.utc):
            raise ValueError('invalid review time')
    except (ValueError, TypeError):
        raise ValueError('coverage_review_time_invalid') from None
    if (check.get('status') != 'verified' or check.get('reviewer') != review.get('reviewer')
            or check.get('reviewer') == draft.get('writerRun') or check.get('finalHash') != final_hash
            or set(check.get('criticalTopicsReviewed', [])) != CRITICAL_TOPICS):
        raise ValueError('independent_coverage_review_required')
    gaps = {row['sourceId'] for row in coverage['gaps']}
    if not (gaps | set(coverage['readableSources'])).issubset(set(check.get('sourceIdsReviewed', []))):
        raise ValueError('coverage_source_review_incomplete')
    resolutions = check.get('gapResolutions', [])
    if len(resolutions) != len(gaps) or {row.get('sourceId') for row in resolutions} != gaps:
        raise ValueError('coverage_gap_resolution_incomplete')
    by_id = {row['id']: row for row in candidates}
    for row in resolutions:
        alternatives = row.get('alternativeCandidateIds', [])
        deferred_urls = {w['url'] for w in coverage.get('reviewWork', [])
                         if w['sourceId'] == row.get('sourceId') and w.get('url')}
        deferred_urls.update(url for work in coverage.get('reviewWork', [])
                             if work['sourceId'] == row.get('sourceId') for url in work.get('examples', []))
        if not deferred_urls.issubset(set(row.get('deferredUrlsReviewed', []))):
            raise ValueError('coverage_deferred_discovery_review_incomplete')
        hashes = {w['queueHash'] for w in coverage.get('reviewWork', [])
                  if w['sourceId'] == row.get('sourceId') and w.get('queueHash')}
        if not hashes.issubset(set(row.get('deferredWorkHashesReviewed', []))):
            raise ValueError('coverage_deferred_work_hash_review_incomplete')
        if (not isinstance(row.get('reason'), str) or len(row['reason'].strip()) < 16 or not alternatives
                or any(cid not in by_id or not by_id[cid].get('sourceId')
                       or by_id[cid]['sourceId'] == row['sourceId'] for cid in alternatives)):
            raise ValueError('coverage_gap_alternative_evidence_required')


def coverage_self_test():
    cutoff = _dt('2026-11-21T06:00:00+08:00')
    stamp = '2026-11-21T06:01:00+08:00'
    source = {'id': 'fixture', 'country': 'kg', 'entrypoints': [{'url': 'https://fixture.example/'}]}
    registry = {'sources': [source]}
    denied = {'sourceId': 'fixture', 'url': 'https://fixture.example/', 'role': 'home', 'kind': 'unknown',
              'status': 403, 'fetchedAt': stamp}
    first = assess_coverage(registry, 'kg', {'sourceScanAudit': [denied]}, cutoff, observed_at=stamp)
    second = assess_coverage(registry, 'kg', {'sourceScanAudit': [denied], 'articleQueue': [
        {'sourceId': 'fixture', 'url': 'https://fixture.example/important-energy-policy'}]}, cutoff, observed_at=stamp)
    exhausted = dict(denied, status=None, fetchedAt=None, attemptedAt=stamp, error='source_network_deadline_exceeded',
                     retryBudgetExhausted=True, transportAttemptsTotal=3)
    third = assess_coverage(registry, 'kg', {'sourceScanAudit': [exhausted]}, cutoff, observed_at=stamp)
    alternative = {'id': 'unobserved', 'country': 'kg', 'entrypoints': [{'url': 'https://alternative.example/'}]}
    fourth = assess_coverage({'sources': [source, alternative]}, 'kg', {
        'sourceScanAudit': [denied], 'observedAt': stamp, 'maxSeconds': 60,
        'runSourceIds': ['fixture', 'unobserved'], 'listingQueue': [
            {'sourceId': 'unobserved', 'url': 'https://alternative.example/'}]}, cutoff, observed_at=stamp)
    cases = {'refusal_recorded_as_gap': first['state'] == 'review_required',
             'important_article_still_blocks': second['state'] == 'blocked',
             'actual_retry_exhaustion_closes_source': third['state'] == 'review_required',
             'bounded_unobserved_is_review_gap_not_completion': fourth['state'] == 'review_required'
                and fourth['queues']['listing'] == 1 and len(fourth['reviewWork']) == 1}
    if not all(cases.values()):
        raise ValueError('coverage_self_test_failed')
    return {'version': COVERAGE_VERSION, 'passed': True, 'cases': cases, 'readOnly': True, 'aiApiUsed': False,
            'implementationSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
