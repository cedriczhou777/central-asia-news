import copy
import json
import unittest
from datetime import datetime

from work_quantity_policy import evaluate_quantity


def fixture(count=15):
    """Synthetic source observations only; no network or actual news."""
    now = datetime.fromisoformat('2026-11-15T08:00:00+08:00')
    stamp = '2026-11-15T06:01:00+08:00'
    sources, audit, articles, ledger = [], [], [], []
    for n in range(11):
        host = f'source{n}.example'
        source = {'id': f'source{n}', 'country': 'kg', 'family': f'family{n}',
                  'kind': 'media' if n < 8 else 'institution',
                  'entrypoints': [{'url': f'https://{host}/', 'role': 'home', 'language': 'ru'}],
                  'allowedHosts': [host]}
        if n >= 8:
            source['institutionType'] = ['tax', 'energy', 'transport'][n - 8]
        sources.append(source)
        audit.append({'sourceId': source['id'], 'family': source['family'], 'sourceType': source['kind'],
                      'institutionType': source.get('institutionType'), 'role': 'home', 'kind': 'listing',
                      'url': f'https://{host}/', 'final_url': f'https://{host}/', 'fetchedAt': stamp,
                      'status': 200 if n < 3 else 403, 'contentValidated': n < 3, 'language': 'ru', 'linksFound': 6})
    for n in range(count):
        source = sources[n % 3]
        url = f'https://{source["allowedHosts"][0]}/article-{n}'
        observation = {'sourceId': source['id'], 'family': source['family'], 'sourceType': 'media',
                       'role': 'article', 'kind': 'article', 'url': url, 'final_url': url,
                       'fetchedAt': stamp, 'status': 200, 'contentValidated': True, 'language': 'ru', 'sourceHash': f'{n:064x}'}
        audit.append(observation)
        evidence = [{'url': url, 'observedAt': stamp, 'description': 'Synthetic article observation for this test only'}]
        articles.append({'id': f'article{n}', 'source_url': url})
        ledger.append({'id': f'article{n}', 'source_url': url, 'family': source['family'], 'sourceId': source['id'],
                       'discoveredAt': stamp, 'fullTextFetchedAt': stamp, 'publicationEvidence': copy.deepcopy(evidence),
                       'decision': 'selected', 'reason': 'Synthetic current article passes test selection criteria',
                       'evidence': evidence})
    draft = {'issueDate': '2026-11-15', 'country': 'kg', 'writerRun': 'fixture-writer', 'articles': articles,
             'sourceRegistry': {'sources': sources}, 'candidateLedger': ledger,
             'discoveryState': {'country': 'kg', 'issueDate': '2026-11-15', 'observedAt': stamp,
                                'budgetEvents': [], 'listingQueueRemaining': 0, 'articleQueueRemaining': 0,
                                'complete': True, 'needs_expansion': False},
             'review': {'independentReviewCompleted': False, 'reviewer': None}}
    return draft, audit, now


class QuantityEvidence(unittest.TestCase):
    def test_fifteen_target_needs_real_coverage_and_closed_ledger(self):
        d, audit, now = fixture()
        result = evaluate_quantity(d, audit, now)
        self.assertEqual(result['quantityStatus'], 'target_met')
        self.assertTrue(result['quantityReady'])
        self.assertFalse(result['qualityDeliveryComplete'])
        self.assertFalse(result['shortfallOpen'])
        self.assertTrue(result['sourceCoverage']['complete'])
        self.assertTrue(result['candidateLedgerValidation']['complete'])

    def test_six_articles_never_complete_with_arbitrary_shortfall(self):
        d, audit, now = fixture(6)
        d['coverageShortfallExplanation'] = 'All sources checked, no more news today'
        d['quantityExceptionReview'] = self.exception(d, audit)
        d['review'] = {'independentReviewCompleted': True, 'reviewer': 'independent'}
        result = evaluate_quantity(d, audit, now)
        self.assertEqual(result['quantityStatus'], 'needs_expansion')
        self.assertFalse(result['quantityReady'])
        self.assertFalse(result['qualityDeliveryComplete'])
        self.assertTrue(result['shortfallOpen'])

    def test_plan_b_short_edition_requires_bound_source_and_independent_review(self):
        d, audit, _ = fixture(1)
        d = json.loads(json.dumps(d).replace('2026-11-15', '2026-11-26'))
        audit = json.loads(json.dumps([r for r in audit if r['sourceId'] == 'source0']).replace('2026-11-15', '2026-11-26'))
        d['sourceRegistry']['sources'] = d['sourceRegistry']['sources'][:1]
        d['planBFinalHash'] = 'b'*64
        d['planBCoverage'] = {'version':'plan-b-coverage-2', 'country':'kg', 'windowEnd':'2026-11-26T06:00:00+08:00',
                              'observedAt':'2026-11-26T06:03:00+08:00', 'state':'observed',
                              'queues':dict.fromkeys(('listing','article','lead'),0), 'gaps':[],
                              'pendingWork':[], 'reviewWork':[], 'closedQueueWork':[],
                              'queueAccounting':{kind:dict(total=0,pending=0,review=0,closed=0,identityHash='c'*64)
                                                 for kind in ('listing','article','lead')}}
        now = datetime.fromisoformat('2026-11-26T08:00:00+08:00')
        self.assertFalse(evaluate_quantity(d, audit, now)['quantityReady'])
        d['quantityExceptionReview'] = {**self.exception(d, audit), 'reviewedAt':'2026-11-26T07:00:00+08:00'}
        result = evaluate_quantity(d, audit, now)
        self.assertTrue(result['quantityReady'], result)
        self.assertEqual(result['quantitySummary']['exceptionMin'], 1)
        d['planBCoverage']['pendingWork'] = [{'sourceId':'source0','kind':'article'}]
        self.assertFalse(evaluate_quantity(d, audit, now)['quantityReady'])

    @staticmethod
    def exception(d, audit):
        r = audit[0]
        return {'status': 'approved', 'reviewer': 'fixture-independent', 'reviewedAt': '2026-11-15T07:00:00+08:00',
                'reason': 'Independently checked the complete source coverage and every candidate decision',
                'evidence': [{'url': r['url'], 'observedAt': r['fetchedAt'],
                              'description': 'Actual final-window source scan reviewed with full candidate ledger'}]}

    def test_daily_target_matches_the_editorial_gate(self):
        for count, approved, ready in [(5,True,False),(6,False,False),(6,True,True),(7,False,True)]:
            with self.subTest(count=count, approved=approved):
                draft, audit, _ = fixture(count)
                draft = json.loads(json.dumps(draft).replace('2026-11-15','2026-11-27'))
                draft['sourceRegistry']['sources'] = draft['sourceRegistry']['sources'][:3]
                audit = json.loads(json.dumps([row for row in audit if row['status']==200]).replace('2026-11-15','2026-11-27'))
                from source_coverage import assess_coverage
                stamp = '2026-11-27T06:03:00+08:00'
                draft['planBCoverage'] = assess_coverage(draft['sourceRegistry'],'kg',{'sourceScanAudit':audit},
                    datetime.fromisoformat('2026-11-27T06:00:00+08:00'),observed_at=stamp)
                draft['planBFinalHash'] = 'b'*64
                if approved:
                    draft['quantityExceptionReview']={**self.exception(draft,audit),'reviewedAt':'2026-11-27T07:00:00+08:00'}
                result=evaluate_quantity(draft,audit,datetime.fromisoformat('2026-11-27T08:00:00+08:00'))
                self.assertEqual(result['quantitySummary']['exceptionMin'], 6, result)
                self.assertEqual(result['quantityReady'],ready,result)

    def test_ten_requires_independent_evidenced_exception(self):
        d, audit, now = fixture(10)
        self.assertFalse(evaluate_quantity(d, audit, now)['quantityReady'])
        d['quantityExceptionReview'] = self.exception(d, audit)
        result = evaluate_quantity(d, audit, now)
        self.assertTrue(result['quantityReady'])
        self.assertEqual(result['quantityStatus'], 'exception_approved')
        d['quantityExceptionReview']['reviewer'] = d['writerRun']
        self.assertFalse(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_exception_without_actual_source_evidence_fails(self):
        d, audit, now = fixture(14)
        d['quantityExceptionReview'] = self.exception(d, audit)
        d['quantityExceptionReview']['evidence'][0]['url'] = 'https://never-fetched.example/'
        self.assertFalse(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_pending_candidate_blocks_even_fifteen(self):
        d, audit, now = fixture()
        row = copy.deepcopy(d['candidateLedger'][0])
        row.update(id='pending', source_url='https://source0.example/next', decision='pending', fullTextFetchedAt=None)
        d['candidateLedger'].append(row)
        result = evaluate_quantity(d, audit, now)
        self.assertEqual(result['candidateLedgerValidation']['pending'], 1)
        self.assertFalse(result['quantityReady'])

    def test_successful_full_text_cannot_disappear_from_ledger(self):
        d, audit, now = fixture()
        row = dict(audit[-1], url='https://source0.example/unresolved', final_url='https://source0.example/unresolved')
        row.update(sourceId='source0', family='family0')
        audit.append(row)
        result = evaluate_quantity(d, audit, now)
        self.assertFalse(result['candidateLedgerValidation']['complete'])
        self.assertIn('missing from candidate ledger', ' '.join(result['candidateLedgerValidation']['errors']))

    def test_failure_or_listing_evidence_can_close_unfetched_rejection(self):
        d, audit, now = fixture()
        r = audit[4]
        d['candidateLedger'].append({'id': 'rejected', 'sourceId': r['sourceId'], 'family': r['family'],
                                    'source_url': 'https://source4.example/blocked-article', 'discoveredAt': r['fetchedAt'],
                                    'decision': 'rejected', 'reason': 'Source section returned HTTP 403; full text was unavailable',
                                    'evidence': [{'url': r['url'], 'observedAt': r['fetchedAt'], 'description': 'Actual source listing returned HTTP 403'}]})
        result = evaluate_quantity(d, audit, now)
        self.assertTrue(result['candidateLedgerValidation']['complete'])
        self.assertTrue(result['quantityReady'])
        self.assertEqual(result['candidateLedgerValidation']['fullTextFetched'], 15)

    def test_generic_reason_or_empty_evidence_does_not_close_candidate(self):
        d, audit, now = fixture()
        d['candidateLedger'][0].update(reason='not relevant', evidence=[])
        self.assertFalse(evaluate_quantity(d, audit, now)['candidateLedgerValidation']['complete'])

    def test_repeated_domains_or_registry_entries_do_not_inflate_media_families(self):
        d, audit, now = fixture()
        for source in d['sourceRegistry']['sources'][:8]:
            source['family'] = 'one-media-family'
        for row in audit:
            if row['sourceType'] == 'media': row['family'] = 'one-media-family'
        for row in d['candidateLedger']: row['family'] = 'one-media-family'
        result = evaluate_quantity(d, audit, now)
        self.assertEqual(result['sourceCoverage']['mediaFamiliesAttempted'], ['one-media-family'])
        self.assertFalse(result['quantityReady'])

    def test_every_declared_available_source_needs_after_cutoff_attempt(self):
        d, audit, now = fixture()
        audit[7]['status'] = 503
        audit[7]['fetchedAt'] = '2026-11-15T05:59:00+08:00'
        result = evaluate_quantity(d, audit, now)
        self.assertEqual(result['sourceCoverage']['missingAfterCutoffSourceIds'], ['source7'])
        self.assertFalse(result['quantityReady'])

    def test_all_entrypoints_proven_terminally_unavailable_need_no_fake_cutoff_retry(self):
        d, audit, now = fixture()
        audit[7]['fetchedAt'] = '2026-11-15T05:59:00+08:00'
        result = evaluate_quantity(d, audit, now)
        coverage = result['sourceCoverage']
        self.assertTrue(result['quantityReady'])
        self.assertTrue(coverage['afterCutoffScanned'])
        self.assertFalse(coverage['actualAfterCutoffScanned'])
        self.assertIn('source7', coverage['unavailableSourceIds'])
        self.assertEqual(coverage['unavailableExcluded'], ['source7'])
        self.assertEqual(coverage['unavailableEvidence']['source7'][0]['status'], 403)
        self.assertEqual(coverage['unavailableEvidence']['source7'][0]['fetchedAt'], '2026-11-15T05:59:00+08:00')
        self.assertNotIn('family7', coverage['fullTextFamiliesSuccessful'])

    def test_refused_home_does_not_exempt_unattempted_section(self):
        d, audit, now = fixture()
        source = d['sourceRegistry']['sources'][7]
        source['entrypoints'].append({'url': 'https://source7.example/business/', 'role': 'section', 'language': 'ru'})
        audit[7]['fetchedAt'] = '2026-11-15T05:59:00+08:00'
        result = evaluate_quantity(d, audit, now)
        self.assertFalse(result['quantityReady'])
        self.assertNotIn('source7', result['sourceCoverage']['unavailableSourceIds'])
        self.assertIn('source7', result['sourceCoverage']['missingAfterCutoffSourceIds'])

    def test_every_declared_entrypoint_needs_own_real_terminal_failure(self):
        d, audit, now = fixture()
        source = d['sourceRegistry']['sources'][7]
        url = 'https://source7.example/business/'
        source['entrypoints'].append({'url': url, 'role': 'section', 'language': 'ru'})
        audit[7]['fetchedAt'] = '2026-11-15T05:59:00+08:00'
        audit.append(dict(audit[7], url=url, final_url=url, role='section', status=410))
        coverage = evaluate_quantity(d, audit, now)['sourceCoverage']
        self.assertTrue(coverage['complete'])
        self.assertEqual(len(coverage['unavailableEvidence']['source7']), 2)

    def test_readable_alternative_section_prevents_terminal_home_exemption(self):
        d, audit, now = fixture()
        audit[7]['fetchedAt'] = '2026-11-15T05:59:00+08:00'
        section = dict(audit[7], url='https://source7.example/business/', final_url='https://source7.example/business/',
                       role='section', status=200, contentValidated=True)
        audit.append(section)
        result = evaluate_quantity(d, audit, now)
        self.assertNotIn('source7', result['sourceCoverage']['unavailableSourceIds'])
        self.assertFalse(result['quantityReady'])
        section['fetchedAt'] = '2026-11-15T06:02:00+08:00'
        self.assertTrue(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_transient_failure_requires_actual_final_window_retry(self):
        for status, error in [(503, 'source_http_503'), (None, 'TimeoutError')]:
            with self.subTest(status=status):
                d, audit, now = fixture()
                audit[7].update(status=status, error=error, fetchedAt='2026-11-15T05:59:00+08:00')
                result = evaluate_quantity(d, audit, now)
                self.assertFalse(result['quantityReady'])
                self.assertNotIn('source7', result['sourceCoverage']['unavailableSourceIds'])
                audit.append(dict(audit[7], fetchedAt='2026-11-15T06:02:00+08:00'))
                self.assertTrue(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_cached_refusal_retains_original_timestamp_in_evidence(self):
        d, audit, now = fixture()
        audit[7]['fetchedAt'] = '2026-11-15T05:59:00+08:00'
        audit.append(copy.deepcopy(audit[7]))
        coverage = evaluate_quantity(d, audit, now)['sourceCoverage']
        self.assertNotIn('source7', coverage['afterCutoffSourceIds'])
        self.assertIn('source7', coverage['unavailableExcluded'])

    def test_only_current_issue_refusal_can_support_exemption(self):
        d, audit, now = fixture()
        audit[7]['fetchedAt'] = '2026-11-13T05:59:00+08:00'
        self.assertNotIn('source7', evaluate_quantity(d, audit, now)['sourceCoverage']['unavailableSourceIds'])

    def test_terminal_decisions_use_selected_rejected_pending_contract(self):
        for decision in ['accepted', 'excluded']:
            with self.subTest(decision=decision):
                d, audit, now = fixture()
                d['candidateLedger'][0]['decision'] = decision
                result = evaluate_quantity(d, audit, now)
                self.assertFalse(result['candidateLedgerValidation']['complete'])
                self.assertIn('selected/rejected/pending', ' '.join(result['candidateLedgerValidation']['errors']))

    def test_wrong_language_redirect_is_not_successful_source_coverage(self):
        d, audit, now = fixture()
        for row in audit:
            if row['sourceId'] == 'source2': row['language'] = 'az'
        result = evaluate_quantity(d, audit, now)
        self.assertEqual(len(result['sourceCoverage']['fullTextFamiliesSuccessful']), 2)
        self.assertFalse(result['quantityReady'])

    def test_html_language_region_and_separator_normalize_to_base(self):
        for language in ['ru-RU', 'RU_ru', 'ru']:
            with self.subTest(language=language):
                d, audit, now = fixture()
                for row in audit:
                    if row['status'] == 200: row['language'] = language
                self.assertTrue(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_und_registry_has_no_fixed_language_but_real_html_language_can_verify(self):
        d, audit, now = fixture()
        d['sourceRegistry']['sources'][2]['entrypoints'][0]['language'] = 'und'
        for row in audit:
            if row['sourceId'] == 'source2': row.update(language='ru-RU', rawLanguage='ru-RU', expectedLanguage='und')
        self.assertTrue(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_missing_actual_language_does_not_turn_expected_into_observation(self):
        d, audit, now = fixture()
        for row in audit:
            if row['sourceId'] == 'source2': row.update(language=None, expectedLanguage='ru')
        result = evaluate_quantity(d, audit, now)
        self.assertFalse(result['quantityReady'])
        self.assertEqual(len(result['sourceCoverage']['fullTextFamiliesSuccessful']), 2)
        self.assertTrue(result['sourceCoverage']['languagePending'])
        self.assertFalse(any('language' in e for e in result['sourceCoverage']['errors']))

    @staticmethod
    def manual_review(row, language=None):
        review = {'status': 'verified', 'reviewer': 'actual-human-reviewer', 'reviewedAt': '2026-11-15T06:30:00+08:00',
                  'sourceHash': row['sourceHash'],
                  'evidence': [{'url': row['url'], 'observedAt': row['fetchedAt'],
                                'description': 'Actual full text visually read and independently identified for this test'}]}
        if language: review['language'] = language
        return review

    def test_missing_html_language_can_be_confirmed_by_bound_full_text_review(self):
        d, audit, now = fixture()
        for row in audit:
            if row['sourceId'] == 'source2':
                row['language'] = None
                if row['kind'] == 'article': row['languageReview'] = self.manual_review(row, 'ru-RU')
        result = evaluate_quantity(d, audit, now)
        self.assertTrue(result['quantityReady'])
        # Missing language on an otherwise readable listing remains transparent,
        # without invalidating the article texts a human actually reviewed.
        self.assertTrue(result['sourceCoverage']['languagePending'])

    def test_language_review_missing_hash_or_mismatched_url_cannot_verify(self):
        for change in ['no_hash', 'wrong_url', 'future_review']:
            with self.subTest(change=change):
                d, audit, now = fixture()
                for row in audit:
                    if row['sourceId'] == 'source2':
                        row['language'] = None
                        if row['kind'] == 'article':
                            review = self.manual_review(row, 'ru')
                            if change == 'no_hash': review.pop('sourceHash')
                            elif change == 'wrong_url': review['evidence'][0]['url'] = 'https://source2.example/not-fetched'
                            else: review['reviewedAt'] = '2026-11-16T06:30:00+08:00'
                            row['languageReview'] = review
                self.assertFalse(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_parser_listing_article_needs_bound_identity_review_without_rewriting_kind(self):
        d, audit, now = fixture()
        for row in audit:
            if row['role'] == 'article': row['kind'] = 'listing'
        original_audit = copy.deepcopy(audit)
        self.assertFalse(evaluate_quantity(d, audit, now)['quantityReady'])
        for candidate in d['candidateLedger']:
            row = next(r for r in audit if r['url'] == candidate['source_url'])
            candidate['articleIdentityReview'] = self.manual_review(row)
            candidate['readableTextFetchedAt'] = candidate.pop('fullTextFetchedAt')
        result = evaluate_quantity(d, audit, now)
        self.assertTrue(result['quantityReady'])
        self.assertEqual(result['candidateLedgerValidation']['fullTextFetched'], 15)
        self.assertEqual(audit, original_audit)

    def test_weak_article_kind_does_not_impersonate_final_listing_refresh(self):
        d, audit, now = fixture()
        audit[0]['fetchedAt'] = '2026-11-15T05:59:00+08:00'
        for candidate in d['candidateLedger']:
            if candidate['sourceId'] != 'source0': continue
            row = next(r for r in audit if r['url'] == candidate['source_url'])
            row['kind'] = 'listing'
            candidate['articleIdentityReview'] = self.manual_review(row)
        result = evaluate_quantity(d, audit, now)
        self.assertIn('source0', result['sourceCoverage']['missingAfterCutoffSourceIds'])
        self.assertFalse(result['quantityReady'])

    def test_identity_flag_alone_or_wrong_hash_does_not_upgrade_parser_listing(self):
        for change in ['flag', 'wrong_hash', 'old_review', 'wrong_evidence_url']:
            with self.subTest(change=change):
                d, audit, now = fixture()
                row = audit[-1]
                row['kind'] = 'listing'
                candidate = d['candidateLedger'][-1]
                review = self.manual_review(row)
                if change == 'flag': review = {'status': 'verified'}
                elif change == 'wrong_hash': review['sourceHash'] = 'f' * 64
                elif change == 'old_review': review['reviewedAt'] = '2026-11-15T05:30:00+08:00'
                else: review['evidence'][0]['url'] = 'https://source0.example/another'
                candidate['articleIdentityReview'] = review
                self.assertFalse(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_same_hash_refetch_preserves_real_prior_language_and_identity_review(self):
        d, audit, now = fixture()
        row = audit[-1]
        row.update(kind='listing', language=None)
        candidate = d['candidateLedger'][-1]
        candidate['articleIdentityReview'] = self.manual_review(row)
        candidate['languageReview'] = self.manual_review(row, 'ru')
        audit.append(dict(row, fetchedAt='2026-11-15T07:15:00+08:00'))
        self.assertTrue(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_scarcity_exception_cannot_hide_finite_crawl_budget(self):
        d, audit, now = fixture(10)
        d['quantityExceptionReview'] = self.exception(d, audit)
        d['discoveryState'].update(budgetEvents=[{'sourceId': 'source0', 'url': audit[0]['url'], 'reason': 'listing_page_budget'}],
                                   listingQueueRemaining=2, complete=False, needs_expansion=True)
        result = evaluate_quantity(d, audit, now)
        self.assertFalse(result['quantityReady'])
        self.assertIn('discoveryReview', ' '.join(result['quantityExceptionValidation']['errors']))

    def test_scarcity_review_must_resolve_budget_with_actual_window_evidence(self):
        d, audit, now = fixture(10)
        exception = self.exception(d, audit)
        d['quantityExceptionReview'] = exception
        d['discoveryState'].update(budgetEvents=[{'sourceId': 'source0', 'reason': 'listing_page_budget'}],
                                   complete=False, needs_expansion=True)
        review = {'reviewedBy': exception['reviewer'], 'reviewedAt': exception['reviewedAt'],
                  'sourceIdsReviewed': ['source0', 'source1', 'source2'], 'incompleteSourceIds': [],
                  'resolvedBudgetEvidence': []}
        exception['discoveryReview'] = review
        self.assertFalse(evaluate_quantity(d, audit, now)['quantityReady'])
        observation = audit[0]
        review['resolvedBudgetEvidence'] = [{'sourceId': 'source0', 'url': observation['url'], 'observedAt': observation['fetchedAt'],
            'description': 'Actual source archive reviewed through issue start; remaining linked pages predate the issue window',
            'evidence': [{'url': observation['url'], 'observedAt': observation['fetchedAt'],
                          'description': 'Actual archive entries older than the issue start independently read'}]}]
        self.assertTrue(evaluate_quantity(d, audit, now)['quantityReady'])
        review['incompleteSourceIds'] = ['source0']
        self.assertFalse(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_attributed_queue_needs_only_affected_sources_resolved(self):
        d, audit, now = fixture(10)
        exception = self.exception(d, audit)
        d['quantityExceptionReview'] = exception
        d['discoveryState'].update(listingQueueRemaining=1, listingQueue=[{'sourceId': 'source0', 'url': audit[0]['url']}],
                                   complete=False, needs_expansion=True)
        row = audit[0]
        exception['discoveryReview'] = {'reviewedBy': exception['reviewer'], 'reviewedAt': exception['reviewedAt'],
            'sourceIdsReviewed': ['source0', 'source1', 'source2'], 'incompleteSourceIds': [],
            'resolvedBudgetEvidence': [{'sourceId': 'source0', 'url': row['url'], 'observedAt': row['fetchedAt'],
                'description': 'Actual queued archive page reviewed; remaining entries are before the current issue start',
                'evidence': [{'url': row['url'], 'observedAt': row['fetchedAt'],
                              'description': 'Real issue boundary and listed older article dates independently read'}]}]}
        self.assertTrue(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_candidate_full_text_time_must_be_an_actual_matching_observation(self):
        d, audit, now = fixture()
        d['candidateLedger'][0]['fullTextFetchedAt'] = '2026-11-15T06:05:00+08:00'
        self.assertFalse(evaluate_quantity(d, audit, now)['quantityReady'])

    @classmethod
    def discovery_exception(cls, d, audit, resolved_ids=()):
        exception = cls.exception(d, audit)
        resolutions = []
        for sid in resolved_ids:
            row = next(r for r in audit if r['sourceId'] == sid)
            resolutions.append({'sourceId': sid, 'url': row['url'], 'observedAt': row['fetchedAt'],
                'description': 'Actual remaining source archive reviewed through issue start; queued older or unrelated DOM links add no current issue news',
                'evidence': [{'url': row['url'], 'observedAt': row['fetchedAt'],
                              'description': 'Actual archive boundary dates and unrelated queued page subjects independently examined'}]})
        exception['discoveryReview'] = {'reviewedBy': exception['reviewer'], 'reviewedAt': exception['reviewedAt'],
            'sourceIdsReviewed': ['source0', 'source1', 'source2'], 'incompleteSourceIds': [],
            'resolvedBudgetEvidence': resolutions}
        return exception

    def test_normal_fifteen_does_not_need_thousands_of_raw_leads_terminated(self):
        d, audit, now = fixture()
        d['discoveryState'].update(rawLeadsQueued=4155, queuedLeadSourceIds=['source0'], complete=False, needs_expansion=True)
        self.assertTrue(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_ten_cannot_approve_raw_lead_queue_with_empty_resolution_evidence(self):
        d, audit, now = fixture(10)
        d['discoveryState'].update(rawLeadsQueued=4155, queuedLeadSourceIds=['source0'])
        d['quantityExceptionReview'] = self.discovery_exception(d, audit)
        result = evaluate_quantity(d, audit, now)
        self.assertFalse(result['quantityReady'])
        self.assertIn('source0', ' '.join(result['quantityExceptionValidation']['errors']))

    def test_named_raw_lead_sources_need_source_level_evidence_only(self):
        d, audit, now = fixture(10)
        d['discoveryState'].update(rawLeadsQueued=4155, queuedLeadSourceIds=['source0'])
        d['quantityExceptionReview'] = self.discovery_exception(d, audit, ['source0'])
        self.assertTrue(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_anonymous_raw_lead_count_requires_all_readable_sources_accounted(self):
        d, audit, now = fixture(10)
        d['discoveryState']['rawLeadsQueued'] = 4155
        d['quantityExceptionReview'] = self.discovery_exception(d, audit, ['source0'])
        self.assertFalse(evaluate_quantity(d, audit, now)['quantityReady'])
        d['quantityExceptionReview'] = self.discovery_exception(d, audit, ['source0', 'source1', 'source2'])
        self.assertTrue(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_actual_lead_queue_can_supply_missing_source_id_summary(self):
        d, audit, now = fixture(10)
        d['discoveryState'].update(rawLeadsQueued=1, leadQueue=[{'sourceId': 'source2', 'source_url': 'https://source2.example/queued'}])
        d['quantityExceptionReview'] = self.discovery_exception(d, audit, ['source2'])
        self.assertTrue(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_refused_raw_lead_sources_do_not_require_infinite_fetches(self):
        d, audit, now = fixture(10)
        d['discoveryState'].update(rawLeadsQueued=100, queuedLeadSourceIds=['source7'])
        d['quantityExceptionReview'] = self.discovery_exception(d, audit)
        self.assertTrue(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_raw_lead_queue_alias_and_count_validation(self):
        d, audit, now = fixture(10)
        d['discoveryState'].update(rawLeadQueueRemaining=2, queuedLeadSourceIds=['source0'])
        d['quantityExceptionReview'] = self.discovery_exception(d, audit)
        self.assertFalse(evaluate_quantity(d, audit, now)['quantityReady'])
        d['quantityExceptionReview'] = self.discovery_exception(d, audit, ['source0'])
        self.assertTrue(evaluate_quantity(d, audit, now)['quantityReady'])
        d['discoveryState']['rawLeadsQueued'] = -1
        self.assertFalse(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_same_url_same_hash_multiple_source_origins_need_no_duplicate_candidate(self):
        d, audit, now = fixture()
        candidate = d['candidateLedger'][0]
        primary = next(r for r in audit if r['url'] == candidate['source_url'])
        candidate['sourceHash'] = primary['sourceHash']
        d['sourceRegistry']['sources'][3]['allowedHosts'].append('source0.example')
        origin = dict(primary, sourceId='source3', family='family3')
        audit.append(origin)
        candidate['discoveryOrigins'] = [{'sourceId': 'source3', 'family': 'family3',
            'source_url': candidate['source_url'], 'sourceHash': primary['sourceHash']}]
        result = evaluate_quantity(d, audit, now)
        self.assertTrue(result['quantityReady'])
        self.assertEqual(result['candidateLedgerValidation']['selected'], 15)

    def test_canonical_alias_needs_actual_same_hash_and_non_listing_canonical(self):
        for change in ['valid', 'wrong_hash', 'home_canonical', 'missing_canonical']:
            with self.subTest(change=change):
                d, audit, now = fixture()
                candidate = d['candidateLedger'][0]
                primary = next(r for r in audit if r['url'] == candidate['source_url'])
                canonical = candidate['source_url'] if change != 'home_canonical' else 'https://source0.example/'
                alias = candidate['source_url'] + '?tracking=alias'
                primary['canonicalURL'] = canonical
                candidate.update(sourceHash=primary['sourceHash'], canonicalURL=canonical)
                origin = dict(primary, url=alias, final_url=alias)
                if change == 'wrong_hash': origin['sourceHash'] = 'f' * 64
                if change == 'missing_canonical': origin.pop('canonicalURL')
                audit.append(origin)
                candidate['discoveryOrigins'] = [{'sourceId': 'source0', 'family': 'family0',
                    'source_url': alias, 'sourceHash': primary['sourceHash'], 'canonicalURL': canonical}]
                self.assertEqual(evaluate_quantity(d, audit, now)['quantityReady'], change == 'valid')

    def test_weak_alias_keeps_its_own_bound_identity_review(self):
        d, audit, now = fixture()
        candidate = d['candidateLedger'][0]
        primary = next(r for r in audit if r['url'] == candidate['source_url'])
        canonical = primary['canonicalURL'] = candidate['source_url']
        candidate.update(sourceHash=primary['sourceHash'], canonicalURL=canonical)
        alias = candidate['source_url'] + '?tracking=weak-alias'
        origin_record = dict(primary, url=alias, final_url=alias, kind='listing')
        audit.append(origin_record)
        origin = {'sourceId': 'source0', 'family': 'family0', 'source_url': alias,
                  'sourceHash': primary['sourceHash'], 'canonicalURL': canonical}
        candidate['discoveryOrigins'] = [origin]
        self.assertFalse(evaluate_quantity(d, audit, now)['quantityReady'])
        origin['articleIdentityReview'] = self.manual_review(origin_record)
        self.assertTrue(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_all_refused_sources_do_not_need_infinite_history_for_scarcity_exception(self):
        d, audit, now = fixture(10)
        exception = self.exception(d, audit)
        d['quantityExceptionReview'] = exception
        d['discoveryState'].update(budgetEvents=[{'sourceId': 'source7', 'reason': 'listing_page_budget'}],
                                   complete=False, needs_expansion=True)
        exception['discoveryReview'] = {'reviewedBy': exception['reviewer'], 'reviewedAt': exception['reviewedAt'],
            'sourceIdsReviewed': ['source0', 'source1', 'source2'], 'incompleteSourceIds': [], 'resolvedBudgetEvidence': []}
        self.assertTrue(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_scarcity_exception_requires_current_discovery_summary(self):
        d, audit, now = fixture(10)
        d['quantityExceptionReview'] = self.exception(d, audit)
        d.pop('discoveryState')
        self.assertFalse(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_future_or_invented_audit_does_not_count_as_attempt(self):
        d, audit, now = fixture()
        audit[7]['fetchedAt'] = '2026-11-16T06:01:00+08:00'
        result = evaluate_quantity(d, audit, now)
        self.assertEqual(len(result['sourceCoverage']['mediaFamiliesAttempted']), 7)
        self.assertFalse(result['quantityReady'])

    def test_fifteen_without_registry_does_not_certify_coverage(self):
        d, audit, now = fixture()
        d.pop('sourceRegistry')
        self.assertFalse(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_adopted_article_must_have_selected_ledger_row(self):
        d, audit, now = fixture()
        d['candidateLedger'][0]['decision'] = 'rejected'
        self.assertFalse(evaluate_quantity(d, audit, now)['candidateLedgerValidation']['complete'])

    def test_selected_evidence_cannot_cite_another_article_from_same_source(self):
        d, audit, now = fixture()
        d['candidateLedger'][0]['evidence'] = copy.deepcopy(d['candidateLedger'][3]['evidence'])
        self.assertFalse(evaluate_quantity(d, audit, now)['candidateLedgerValidation']['complete'])

    def test_independent_approval_cannot_predate_current_source_observations(self):
        d, audit, now = fixture(10)
        d['quantityExceptionReview'] = self.exception(d, audit)
        d['quantityExceptionReview']['reviewedAt'] = '2026-11-15T05:59:00+08:00'
        self.assertFalse(evaluate_quantity(d, audit, now)['quantityReady'])

    def test_open_issue_prevents_quality_complete_and_is_preserved(self):
        d, audit, now = fixture()
        d['review'] = {'independentReviewCompleted': True, 'reviewer': 'independent',
                      'issues': [{'status': 'open', 'issue': 'Original review issue wording'}]}
        original = copy.deepcopy(d)
        result = evaluate_quantity(d, audit, now)
        self.assertTrue(result['quantityReady'])
        self.assertFalse(result['qualityDeliveryComplete'])
        self.assertEqual(d, original)

    def test_legacy_text_issue_also_remains_unresolved(self):
        d, audit, now = fixture()
        d['review'] = {'independentReviewCompleted': True, 'reviewer': 'independent'}
        d['issues'] = ['Original unresolved issue without a status field']
        self.assertFalse(evaluate_quantity(d, audit, now)['qualityDeliveryComplete'])


if __name__ == '__main__': unittest.main()
