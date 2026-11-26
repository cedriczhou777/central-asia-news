"""Deterministic coverage closure fixtures. No news, AI, database or WeChat calls."""

import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops' / 'plan-b'))
import fetch_work_sources
from discover_work_sources import discover
from source_coverage import assess_coverage, require_coverage_review, coverage_self_test
import test_work_quantity
from work_quantity_policy import evaluate_quantity


def sample(count=15):
    draft, audit, now = test_work_quantity.fixture(count)
    for entry in draft['candidateLedger']:
        entry['fullTextValidated'] = True
    inventory = {'sourceScanAudit': audit, 'listingQueue': [], 'articleQueue': [], 'budgetEvents': []}
    cutoff = datetime.fromisoformat(draft['issueDate'] + 'T06:00:00+08:00')
    return draft, audit, inventory, cutoff, now


class CoverageClosure(unittest.TestCase):
    def assess(self, values, leads=()):
        draft, _, inventory, cutoff, now = values
        return assess_coverage(draft['sourceRegistry'], 'kg', inventory, cutoff,
                               draft['candidateLedger'], leads, now.isoformat())

    def test_403_is_gap_with_other_real_coverage_not_a_success(self):
        values = sample()
        proof = self.assess(values)
        self.assertEqual(proof['state'], 'review_required')
        self.assertEqual(proof['pendingWork'], [])
        self.assertNotIn('source3', proof['readableSources'])
        self.assertIn('source3', [g['sourceId'] for g in proof['gaps']])
        self.assertTrue(evaluate_quantity(values[0], values[1], values[4])['quantityReady'])

    def test_integral_scan_budget_has_stable_json_across_exchange(self):
        values = sample()
        values[2].update(maxSeconds=480.0, observedAt=values[4].isoformat())
        from_archive = self.assess(values)
        values[2]['maxSeconds'] = 480
        from_exchange = self.assess(values)
        self.assertTrue(from_archive['scanBudget']['bounded'])
        self.assertEqual(json.dumps(from_archive, sort_keys=True), json.dumps(from_exchange, sort_keys=True))

    def test_exhausted_timeout_uses_actual_attempt_and_is_not_full_text(self):
        values = sample()
        row = values[1][3]
        row.update(status=None, fetchedAt=None, attemptedAt='2026-11-15T06:01:00+08:00',
                   error='source_network_deadline_exceeded', retryBudgetExhausted=True, transportAttemptsTotal=3)
        self.assertEqual(self.assess(values)['pendingWork'], [])
        self.assertTrue(evaluate_quantity(values[0], values[1], values[4])['quantityReady'])
        row['transportAttemptsTotal'] = 2
        row['fetchRetryable'] = True
        self.assertIn('source3', [w['sourceId'] for w in self.assess(values)['pendingWork']])

    def test_http_200_with_failed_parsing_is_an_unusable_gap_not_a_readable_source(self):
        values = sample()
        values[1][3].update(status=200, contentValidated=False, parserVersion='fixture-parser', error='HTML_parse_failed')
        proof = self.assess(values)
        self.assertNotIn('source3', proof['readableSources'])
        self.assertEqual(next(g for g in proof['gaps'] if g['sourceId'] == 'source3')['evidence'][0]['failureType'], 'unusable_response')

    def test_major_discovered_article_blocks_even_when_source_is_terminal(self):
        values = sample()
        values[2]['articleQueue'] = [{'sourceId': 'source3', 'url': 'https://source3.example/major-energy-policy'}]
        proof = self.assess(values)
        self.assertEqual(proof['state'], 'blocked')
        self.assertTrue(any(w['kind'] == 'article' for w in proof['pendingWork']))

    def test_unfetched_ledger_article_cannot_vanish_when_queue_is_empty(self):
        values = sample()
        values[0]['candidateLedger'].append({'id': 'major', 'sourceId': 'source3', 'decision': 'pending',
                                             'source_url': 'https://source3.example/major-investment'})
        self.assertTrue(any(w['kind'] == 'article' for w in self.assess(values)['pendingWork']))

    def test_pagination_and_raw_leads_remain_unfinished(self):
        values = sample()
        values[2]['listingQueue'] = [{'sourceId': 'source0', 'url': 'https://source0.example/page2'}]
        self.assertTrue(any(w['kind'] == 'listing' for w in self.assess(values)['pendingWork']))
        values[2]['listingQueue'] = []
        values[2]['rawLeadsQueued'] = 1
        lead = {'sourceId': 'source0', 'source_url': 'https://source0.example/current-policy', 'status': 'queued'}
        self.assertTrue(any(w['kind'] == 'lead' for w in self.assess(values, [lead])['pendingWork']))

    def test_final_increment_requires_actual_after_cutoff_observation(self):
        values = sample()
        values[1][0]['fetchedAt'] = '2026-11-15T05:59:59+08:00'
        self.assertTrue(any(w['sourceId'] == 'source0' and w['kind'] == 'increment'
                            for w in self.assess(values)['pendingWork']))
        values[1][0]['fetchedAt'] = '2026-11-15T06:00:01+08:00'
        self.assertEqual(self.assess(values)['pendingWork'], [])

    def test_fifteen_is_not_automatic_coverage_approval(self):
        values = sample()
        draft, _, _, _, now = values
        proof = self.assess(values)
        with self.assertRaisesRegex(ValueError, 'coverage_review'):
            require_coverage_review(proof, draft, {'reviewer': 'independent'}, 'f' * 64, draft['candidateLedger'])
        # Three real full-text families and institution/media attempts stay mandatory.
        stripped = [row for row in values[1] if row['sourceId'] not in ('source1', 'source2')]
        self.assertFalse(evaluate_quantity(draft, stripped, now)['quantityReady'])

    def test_unobserved_registration_requires_independent_bounded_coverage_not_all_sources(self):
        values = sample()
        draft, audit, inventory, _, now = values
        draft['sourceRegistry']['sources'].append({'id': 'unobserved', 'country': 'kg', 'family': 'unobserved-family',
            'kind': 'media', 'entrypoints': [{'url': 'https://unobserved.example/'}], 'allowedHosts': ['unobserved.example']})
        inventory.update(observedAt=now.isoformat(), maxSeconds=60,
                         runSourceIds=[s['id'] for s in draft['sourceRegistry']['sources']],
                         listingQueue=[{'sourceId': 'unobserved', 'url': 'https://unobserved.example/'}])
        proof = self.assess(values)
        self.assertEqual(proof['pendingWork'], [])
        self.assertEqual(proof['state'], 'review_required')
        self.assertEqual(proof['queues']['listing'], 1, 'unfinished work is still reported')
        self.assertEqual(len(proof['reviewWork']), 1)
        self.assertFalse(evaluate_quantity(draft, audit, now)['quantityReady'])
        draft.update(planBCoverage=proof, planBFinalHash='f' * 64, planBReviewerRun='independent')
        draft['planBCoverageReview'] = {'status': 'verified', 'reviewer': 'independent', 'finalHash': 'f' * 64,
            'reviewedAt': now.isoformat(), 'criticalTopicsReviewed': ['policy', 'energy', 'investment', 'business'],
            'sourceIdsReviewed': proof['readableSources'] + [g['sourceId'] for g in proof['gaps']],
            'gapResolutions': [{'sourceId': g['sourceId'], 'reason': 'Synthetic independent review of actual alternative news and critical topics',
                'alternativeCandidateIds': ['article0', 'article1', 'article2'],
                'deferredUrlsReviewed': ['https://unobserved.example/'] if g['sourceId'] == 'unobserved' else [],
                'deferredWorkHashesReviewed': [w['queueHash'] for w in proof['reviewWork'] if w['sourceId']==g['sourceId']]}
                for g in proof['gaps']]}
        self.assertTrue(evaluate_quantity(draft, audit, now)['quantityReady'])
        draft['planBCoverageReview']['gapResolutions'][-1]['deferredUrlsReviewed'] = []
        self.assertFalse(evaluate_quantity(draft, audit, now)['quantityReady'])

    def test_article_budget_is_not_closed_by_reviewing_listing_budget(self):
        values = sample()
        values[2]['budgetEvents'] = [{'sourceId': 'source0', 'reason': 'article_budget', 'remaining': 2}]
        self.assertTrue(any(w['kind'] == 'article' for w in self.assess(values)['pendingWork']))

    def test_thirteen_requires_real_independent_scarcity_review(self):
        draft, audit, _, _, now = sample(13)
        self.assertFalse(evaluate_quantity(draft, audit, now)['quantityReady'])
        draft['quantityExceptionReview'] = test_work_quantity.QuantityEvidence.exception(draft, audit)
        self.assertTrue(evaluate_quantity(draft, audit, now)['quantityExceptionValidation']['approved'])
        draft['quantityExceptionReview']['reviewer'] = draft['writerRun']
        self.assertFalse(evaluate_quantity(draft, audit, now)['quantityReady'])

    def test_failed_alias_does_not_close_untried_publisher_alternative(self):
        values = sample()
        values[0]['sourceRegistry']['sources'][3]['entrypoints'].append({'url': 'https://source3.example/other'})
        self.assertIn('source3', [w['sourceId'] for w in self.assess(values)['pendingWork']])

    def test_readable_alternative_is_not_publisher_unavailable(self):
        values = sample()
        alternate = dict(values[1][3], url='https://source3.example/legal-rss', status=200,
                         contentValidated=True, fetchRetryable=False, error=None)
        values[1].append(alternate)
        proof = self.assess(values)
        self.assertIn('source3', proof['readableSources'])
        self.assertEqual(next(g for g in proof['gaps'] if g['sourceId'] == 'source3')['reason'],
                         'entrypoint_unavailable')
        self.assertEqual(proof['pendingWork'], [])

    def test_newer_transient_failure_is_not_hidden_by_old_403(self):
        values = sample()
        row = copy.deepcopy(values[1][3])
        values[2]['sourceScanAuditHistory'] = [row]
        values[1][3].update(status=503, fetchedAt='2026-11-15T06:02:00+08:00', fetchRetryable=True)
        self.assertIn('source3', [w['sourceId'] for w in self.assess(values)['pendingWork']])

    def test_transport_checkpoint_retries_are_cumulative_and_cached(self):
        with tempfile.TemporaryDirectory() as td, patch.object(fetch_work_sources, 'S', Path(td)), \
                patch.object(fetch_work_sources, 'bounded_response', side_effect=TimeoutError) as network:
            url = 'https://retry-fixture.example/'
            retry_path = Path(td) / (hashlib.sha256(url.encode()).hexdigest()[:18] + '.retry.json')
            for attempt in range(3):
                if retry_path.exists():
                    checkpoint = json.loads(retry_path.read_text())
                    checkpoint['resumeAt'] = '2020-01-01T00:00:00+00:00'
                    retry_path.write_text(json.dumps(checkpoint))
                result = fetch_work_sources.fetch(url, source_role='listing')
                self.assertEqual(result['transportAttemptsTotal'], attempt + 1)
            self.assertTrue(result['retryBudgetExhausted'])
            self.assertIsNone(result['fetchedAt'])
            actual_attempt = result['attemptedAt']
            reused = fetch_work_sources.fetch(url, source_role='listing')
            self.assertEqual(reused['attemptedAt'], actual_attempt)
            self.assertEqual(network.call_count, 3)

    def test_discovery_preserves_actual_exhaustion_evidence(self):
        source = {'id': 'fixture', 'country': 'kg', 'family': 'Fixture', 'kind': 'media',
                  'entrypoints': [{'url': 'https://fixture.example/', 'role': 'home'}], 'allowedHosts': ['fixture.example']}
        def fetcher(url, *_args, **_kwargs):
            return {'url': url, 'fetchedAt': None, 'attemptedAt': '2026-11-15T06:01:00+08:00',
                    'status': None, 'contentValidated': False, 'error': 'source_network_deadline_exceeded',
                    'transportAttemptsTotal': 3, 'retryBudgetExhausted': True, 'fetchRetryable': False}
        with tempfile.TemporaryDirectory() as td:
            result = discover({'sources': [source]}, 'kg', '2026-11-15', Path(td), fetcher=fetcher, max_seconds=1)
            row = next(r for r in result['sourceScanAudit'] if r.get('url'))
            self.assertTrue(row['retryBudgetExhausted'])
            self.assertEqual(row['transportAttemptsTotal'], 3)
            self.assertEqual(row['attemptedAt'], '2026-11-15T06:01:00+08:00')

    def test_runtime_self_check_has_no_network(self):
        with patch('socket.create_connection', side_effect=AssertionError('network forbidden')):
            self.assertTrue(coverage_self_test()['passed'])


if __name__ == '__main__':
    unittest.main()
