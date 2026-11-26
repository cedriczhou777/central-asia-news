"""Offline contracts for candidate discovery; no source or draft mutations."""
import gzip
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

# The hosted Plan B collector is shipped from ops/plan-b.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops' / 'plan-b'))
from discover_work_sources import discover, load_fetcher, migrate_discovery_leads, rebase_discovery_paths, lead_route, rank_leads, active_scan_events, rerank_cached_leads, _FetchFlights


STAMP = '2026-11-15T00:01:00+00:00'


def source(identifier='one', family='one', host='news.test'):
    return {'id': identifier, 'country': 'kz', 'family': family, 'kind': 'media',
            'allowedHosts': [host], 'available': True,
            'entrypoints': [{'url': 'https://' + host + '/', 'role': 'home', 'language': 'ru'}]}


def page(url, links=(), language='ru', kind='listing', published=None, status=200, text='news text'):
    record = {'url': url, 'final_url': url, 'fetchedAt': STAMP, 'status': status,
              'contentValidated': status == 200, 'html_lang': language, 'source_kind': kind,
              'links': [{'url': u, 'text': title, 'rel': rel} for u, title, rel in links],
              'source_sha256': hashlib.sha256(text.encode()).hexdigest(), 'text': text,
              'publicationEvidence': []}
    if published:
        record['publicationEvidence'] = [{'field': 'meta.article:published_time', 'raw': published,
                                          'kind': 'published', 'timezoneEvidence': 'explicit'}]
    return record


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output = Path(self.temp.name)
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    def run_scan(self, records, sources=None, **options):
        def fake_fetch(url, minimum, source_role='auto'):
            self.calls.append((url, minimum))
            result = dict(records[url])
            key = hashlib.sha256(url.encode()).hexdigest()[:18]
            result['key'] = key
            target = self.output / 'sources' / (key + '.html.gz')
            with gzip.GzipFile(filename=str(target), mode='wb', mtime=0) as handle:
                handle.write(b'<html><body>source evidence</body></html>')
            return result
        result = discover({'sources': sources or [source()]}, 'kz', '2026-11-15',
                          self.output, fetcher=fake_fetch, **options)
        ledger = json.loads((self.output / 'candidate_ledger.json').read_text())['candidateLedger']
        self.leads = json.loads((self.output / 'lead_queue.json').read_text())['leadLedger']
        return result, {r['source_url']: r for r in ledger}

    def test_real_dom_pagination_recovers_prior_evening(self):
        home, older = 'https://news.test/', 'https://news.test/?page=2'
        morning, evening = 'https://news.test/news/morning', 'https://news.test/news/evening'
        records = {
            home: page(home, [(morning, 'Fresh morning business event', ''), (older, 'Older', 'next')]),
            older: page(older, [(evening, 'Previous evening business event', '')]),
            morning: page(morning, kind='article', published='2026-11-15T08:00:00+05:00'),
            evening: page(evening, kind='article', published='2026-11-14T20:00:00+05:00'),
        }
        result, ledger = self.run_scan(records, listing_not_before='2026-11-14T22:00:00Z')
        self.assertEqual(ledger[evening]['publicationWindowAssessment'], 'in_window')
        self.assertEqual(ledger[evening]['decision'], 'pending')
        self.assertFalse(ledger[evening]['firstDisclosureVerified'])
        self.assertEqual(ledger[morning]['reason'], 'explicit_publication_outside_window')
        self.assertIn((older, '2026-11-14T22:00:00Z'), self.calls)
        self.assertIn((evening, None), self.calls)
        self.assertTrue(Path(ledger[evening]['sourceJSON']).is_file())
        self.assertTrue(Path(ledger[evening]['sourceHTML']).is_file())
        self.assertEqual(result['funnel']['explicitlyInWindowCandidates'], 1)
        self.assertFalse(result['editorialComplete'])

    def test_failures_wrong_language_and_redirect_do_not_count_as_coverage(self):
        sources = [source('failed', 'failed', 'bad.test'), source('wrong', 'wrong', 'wrong.test'),
                   source('redirect', 'redirect', 'redirect.test')]
        bad = page('https://bad.test/', status=403)
        wrong = page('https://wrong.test/', language='en')
        redirect = page('https://redirect.test/')
        redirect['final_url'] = 'https://unregistered.test/'
        result, ledger = self.run_scan({'https://bad.test/': bad, 'https://wrong.test/': wrong,
                                       'https://redirect.test/': redirect}, sources)
        self.assertEqual(result['funnel']['readableListingSources'], 0)
        self.assertEqual(result['funnel']['readableMediaFamilies'], 0)
        self.assertEqual(ledger, {})
        self.assertTrue(result['needs_expansion'])
        self.assertIn('unexpected_page_language', [r['error'] for r in result['sourceScanAudit']])
        self.assertIn('unexpected_final_host', [r['error'] for r in result['sourceScanAudit']])

    def test_candidate_failures_and_budget_omissions_all_have_dispositions(self):
        home = 'https://news.test/'
        bad, queued = 'https://news.test/news/failure', 'https://news.test/news/not-yet'
        records = {home: page(home, [(bad, 'An article with a broken full text', ''),
                                     (queued, 'Another operational business article', '')]),
                   bad: page(bad, status=403)}
        result, ledger = self.run_scan(records, max_articles_per_source=1)
        self.assertEqual(len(ledger), 1)
        self.assertEqual(ledger[bad]['decision'], 'rejected')
        self.assertIsNone(ledger[bad]['fullTextFetchedAt'])
        self.assertNotIn(queued, ledger)
        self.assertEqual(next(l for l in self.leads if l['source_url'] == queued)['status'], 'queued')
        self.assertEqual(result['rawLeadsQueued'], 1)
        self.assertEqual(result['queuedLeadSourceIds'], ['one'])
        self.assertFalse(result['complete'])
        self.assertTrue(result['needs_expansion'])
        self.assertEqual(result['funnel']['fullTextReadableCandidates'], 0)

    def test_human_decision_preserved_same_hash_and_reopened_after_change(self):
        home, article = 'https://news.test/', 'https://news.test/news/article'
        records = {home: page(home, [(article, 'A small local enterprise opens a shop', '')]),
                   article: page(article, kind='article', published='2026-11-14T20:00:00+05:00')}
        _, ledger = self.run_scan(records)
        path = self.output / 'candidate_ledger.json'
        document = json.loads(path.read_text())
        document['candidateLedger'][0].update(decision='selected', reason='reviewer checked original',
                                              decisionOrigin='human', reviewedBy='independent-editor',
                                              firstDisclosureVerified=True)
        path.write_text(json.dumps(document))
        _, ledger = self.run_scan(records)
        self.assertEqual(ledger[article]['decision'], 'selected')
        self.assertTrue(ledger[article]['manualDecisionPreserved'])
        records[article] = page(article, kind='article', published='2026-11-14T20:00:00+05:00', text='changed story')
        _, ledger = self.run_scan(records)
        self.assertEqual(ledger[article]['decision'], 'pending')
        self.assertTrue(ledger[article]['reopenedAfterSourceChange'])
        self.assertEqual(ledger[article]['previousDecisions'][-1]['decision'], 'selected')
        self.assertFalse(ledger[article]['firstDisclosureVerified'])

    def test_events_append_deduplicate_without_overwriting(self):
        home, article = 'https://news.test/', 'https://news.test/news/article'
        records = {home: page(home, [(article, 'Business source publication headline', '')]),
                   article: page(article, kind='article', published='2026-11-14T20:00:00+05:00')}
        self.run_scan(records)
        path = self.output / 'source_scan_events.jsonl'
        original = path.read_bytes()
        self.run_scan(records)
        self.assertEqual(path.read_bytes(), original)
        records[article]['fetchedAt'] = '2026-11-15T00:02:00+00:00'
        self.run_scan(records)
        self.assertTrue(path.read_bytes().startswith(original))
        self.assertEqual(len(path.read_text().splitlines()), 3)

    def test_modified_unclassified_and_timezone_unknown_do_not_prove_window(self):
        home, article = 'https://news.test/', 'https://news.test/news/article'
        record = page(article, kind='article')
        record['publicationEvidence'] = [
            {'field': 'dateModified', 'raw': '2020-01-01T10:00:00Z', 'kind': 'modified', 'timezoneEvidence': 'explicit'},
            {'field': 'time[0]', 'raw': '2020-01-01T10:00:00Z', 'kind': 'unclassified', 'timezoneEvidence': 'explicit'},
            {'field': 'datePublished', 'raw': '2020-01-01T10:00:00', 'kind': 'published', 'timezoneEvidence': 'not_provided'},
        ]
        _, ledger = self.run_scan({home: page(home, [(article, 'A labour rule affecting small enterprises', '')]), article: record})
        self.assertEqual(ledger[article]['publicationWindowAssessment'], 'uncertain')
        self.assertEqual(ledger[article]['decision'], 'pending')

    def test_budget_samples_different_families_and_never_claims_complete(self):
        sources = [source('a1', 'A', 'a1.test'), source('a2', 'A', 'a2.test'), source('b1', 'B', 'b1.test')]
        records = {'https://' + host + '/': page('https://' + host + '/') for host in ('a1.test', 'a2.test', 'b1.test')}
        result, _ = self.run_scan(records, sources, workers=2, max_seconds=3, clock=lambda: len(self.calls))
        sampled = {r['family'] for r in result['sourceScanAudit'] if r['fetchedAt']}
        self.assertEqual(sampled, {'A', 'B'})
        self.assertFalse(result['complete'])
        self.assertTrue(result['needs_expansion'])
        self.assertEqual(result['listingQueueRemaining'], 1)

    def test_output_cannot_mix_dates(self):
        self.run_scan({'https://news.test/': page('https://news.test/')})
        with self.assertRaisesRegex(ValueError, 'another issue'):
            discover({'sources': [source()]}, 'kz', '2026-11-16', self.output, fetcher=lambda *a: {})

    def test_registry_supplemental_sections_and_denied_source_are_retained(self):
        first = source()
        first['sections'] = [{'url': 'https://news.test/real-section', 'discoveredFrom': 'https://news.test/'}]
        first['paginationObserved'] = [{'url': 'https://news.test/real-section?page=2'}]
        second = source('denied', 'Official tax office', 'tax.test')
        second['kind'] = 'institution'
        second['institutionType'] = 'tax'
        records = {u: page(u) for u in ('https://news.test/', 'https://news.test/real-section', 'https://news.test/real-section?page=2')}
        records['https://tax.test/'] = page('https://tax.test/', status=403)
        result, _ = self.run_scan(records, [first, second])
        self.assertIn(('https://news.test/real-section', None), self.calls)
        self.assertIn(('https://news.test/real-section?page=2', None), self.calls)
        self.assertEqual(result['unavailableSourceIds'], ['denied'])
        denied = next(r for r in result['sourceScanAudit'] if r['sourceId'] == 'denied')
        self.assertEqual(denied['sourceType'], 'institution')
        self.assertEqual(denied['institutionType'], 'tax')

    def test_second_small_run_resumes_budget_candidate_after_homepage_disappearance(self):
        home = 'https://news.test/'
        first, second = 'https://news.test/news/first', 'https://news.test/news/second'
        records = {home: page(home, [(first, 'First article full headline', ''), (second, 'Second article full headline', '')]),
                   first: page(first, kind='article', published='2026-11-14T20:00:00+05:00'),
                   second: page(second, kind='article', published='2026-11-14T21:00:00+05:00')}
        self.run_scan(records, max_articles_per_source=1)
        records[home] = page(home, [(first, 'First article full headline', '')])
        before = len(self.calls)
        result, ledger = self.run_scan(records, max_articles_per_source=1)
        self.assertIn((second, None), self.calls[before:])
        self.assertIsNotNone(ledger[second]['fullTextFetchedAt'])
        self.assertTrue(any(r['url'] == first and r['role'] == 'article' for r in result['sourceScanAudit']))
        self.assertEqual(result['funnel']['fullTextReadableCandidates'], 2)

    def test_manual_time_and_disclosure_evidence_survives_same_hash_recheck(self):
        home, article = 'https://news.test/', 'https://news.test/news/article'
        records = {home: page(home, [(article, 'An independently checked enterprise story', '')]),
                   article: page(article, kind='article', published='2026-11-14T20:00:00+05:00')}
        _, ledger = self.run_scan(records)
        normalized = ledger[article]['publicationEvidence'][0]
        self.assertTrue(all(normalized.get(k) for k in ('url', 'observedAt', 'description', 'quote', 'sha256')))
        path = self.output / 'candidate_ledger.json'
        doc = json.loads(path.read_text())
        item = doc['candidateLedger'][0]
        human = {'url': article, 'observedAt': STAMP, 'description': 'Editor verified primary disclosure', 'quote': 'actual primary evidence'}
        item.update(decision='selected', decisionOrigin='human', firstDisclosureVerified=True, firstDisclosureEvidence=[human])
        item['evidence'].append(human)
        item['publicationEvidence'].append(human)
        binding = item['sourceJSON']
        path.write_text(json.dumps(doc))
        records[article]['fetchedAt'] = '2026-11-15T00:05:00Z'
        _, ledger = self.run_scan(records)
        self.assertIn(human, ledger[article]['evidence'])
        self.assertIn(human, ledger[article]['publicationEvidence'])
        self.assertEqual(ledger[article]['firstDisclosureEvidence'], [human])
        self.assertEqual(ledger[article]['sourceJSON'], binding)
        self.assertTrue(ledger[article]['fetchEvidence'])

    def test_unknown_article_structure_remains_for_human_review(self):
        home, article = 'https://news.test/', 'https://news.test/article'
        records = {home: page(home, [(article, 'A ministry publishes operational requirements', '')]),
                   article: page(article, kind='unknown')}
        _, ledger = self.run_scan(records)
        self.assertEqual(ledger[article]['decision'], 'pending')
        self.assertEqual(ledger[article]['reason'], 'needs_article_identity_review')

    def test_missing_standard_article_metadata_retains_institution_and_sme_text(self):
        home, article = 'https://news.test/', 'https://news.test/enterprise-registration-requirements'
        record = page(article, kind='listing', language=None, text='Official local business procedure ' * 50)
        records = {home: page(home, [(article, 'Small enterprise registration procedure', '')]), article: record}
        result, ledger = self.run_scan(records)
        self.assertEqual(ledger[article]['decision'], 'pending')
        self.assertEqual(ledger[article]['reason'], 'needs_article_identity_review')
        self.assertFalse(ledger[article]['articleIdentityVerified'])
        self.assertFalse(ledger[article]['languageVerified'])
        self.assertIsNotNone(ledger[article]['fullTextFetchedAt'])
        self.assertTrue(Path(ledger[article]['sourceHTML']).exists())

    def test_same_article_observed_by_two_sources_has_stable_primary_and_origins(self):
        home, article = 'https://news.test/', 'https://news.test/news/shared'
        sources = [source('one', 'A'), source('two', 'B')]
        records = {home: page(home, [(article, 'The same primary company disclosure', '')]),
                   article: page(article, kind='article', published='2026-11-14T20:00:00+05:00')}
        _, ledger = self.run_scan(records, sources)
        self.assertEqual(len(ledger), 1)
        primary = ledger[article]['id']
        self.assertEqual({o['sourceId'] for o in ledger[article]['discoveryOrigins']}, {'one', 'two'})
        _, second = self.run_scan(records, list(reversed(sources)))
        self.assertEqual(second[article]['id'], primary)
        records[article]['canonical_url'] = home
        another = 'https://news.test/news/another'
        records[home] = page(home, [(article, 'The same primary company disclosure', ''),
                                    (another, 'A separate company disclosure headline', '')])
        records[another] = dict(page(another, kind='article'), canonical_url=home)
        _, third = self.run_scan(records, sources)
        self.assertEqual(len(third), 2)

    def test_concurrent_aliases_fetch_once_and_keep_nonempty_archive_across_runs(self):
        home, article = 'https://news.test/', 'https://news.test/news/shared'
        sources = [source('one', 'A'), source('two', 'B')]
        records = {home: page(home, [(article, 'The same primary company disclosure', '')]),
                   article: page(article, kind='article', published='2026-11-14T20:00:00+05:00')}
        lock = threading.Lock()
        calls = []

        def actual_fetch(url, minimum, source_role='auto'):
            with lock:
                calls.append((url, minimum, source_role))
            result = dict(records[url])
            key = hashlib.sha256(url.encode()).hexdigest()[:18]
            result['key'] = key
            target = self.output / 'sources' / (key + '.html.gz')
            # Expose the original truncate/snapshot race deterministically if
            # two source aliases are allowed to fetch the same URL together.
            with gzip.GzipFile(filename=str(target), mode='wb', mtime=0) as handle:
                time.sleep(.005)
                handle.write(b'<html><body>shared original source evidence</body></html>')
            return result

        registry = {'sources': sources}
        for run in range(3):
            before = len(calls)
            result = discover(registry, 'kz', '2026-11-15', self.output,
                              fetcher=actual_fetch, workers=4)
            actual_calls = calls[before:]
            self.assertEqual(sum(u == home for u, _, _ in actual_calls), 1)
            self.assertEqual(sum(u == article for u, _, _ in actual_calls), 1)
            rows = [r for r in result['sourceScanAudit'] if r.get('url') == article]
            self.assertEqual({r['fetchedAt'] for r in rows}, {STAMP})
            ledger = json.loads((self.output / 'candidate_ledger.json').read_text())['candidateLedger']
            self.assertEqual(len(ledger), 1)
            candidate = ledger[0]
            self.assertEqual({o['sourceId'] for o in candidate['discoveryOrigins']}, {'one', 'two'})
            archived = Path(candidate['sourceHTML'])
            self.assertGreater(archived.stat().st_size, 0)
            self.assertEqual(hashlib.sha256(archived.read_bytes()).hexdigest(), candidate['sourceHTMLSha256'])
            self.assertIn(b'shared original source evidence', gzip.open(archived, 'rb').read())
            self.assertEqual(rebase_discovery_paths(self.output)['rebasedPaths'], 0)

    def test_shared_fetch_results_are_isolated_and_request_key_retains_role_and_cutoff(self):
        flights = _FetchFlights()
        calls = []
        record = {'fetchedAt': STAMP, 'meta': {'title': 'Original observed title'},
                  'publicationEvidence': [{'raw': '2026-11-14T20:00:00+05:00'}]}

        def actual_fetch():
            calls.append(True)
            time.sleep(.005)
            return record

        key = ('https://news.test/shared', None, 'article')
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            responses = list(pool.map(lambda _: flights.get(key, actual_fetch), range(6)))
        self.assertEqual(sum(owner for _, owner in responses), 1)
        results = [result for result, _ in responses]
        self.assertEqual(len(calls), 1)
        results[0]['meta']['title'] = 'Changed by only one consumer'
        results[0]['publicationEvidence'][0]['raw'] = 'changed'
        self.assertEqual(results[1], record)
        self.assertEqual(flights.get(key, actual_fetch), (record, False))
        self.assertEqual(len(calls), 1)
        flights.get((key[0], None, 'listing'), actual_fetch)
        flights.get((key[0], STAMP, 'listing'), actual_fetch)
        self.assertEqual(len(calls), 3)

    def test_bad_shared_nonroot_canonical_does_not_merge_different_text(self):
        home = 'https://news.test/'
        first, second = 'https://news.test/news/first', 'https://news.test/news/second'
        records = {home: page(home, [(first, 'First company original disclosure', ''), (second, 'Second company original disclosure', '')]),
                   first: dict(page(first, kind='article', text='one business'), canonical_url='https://news.test/news/broken-default'),
                   second: dict(page(second, kind='article', text='another business'), canonical_url='https://news.test/news/broken-default')}
        _, ledger = self.run_scan(records)
        self.assertEqual(len(ledger), 2)

    def test_legacy_decisions_are_migrated_even_when_candidate_is_not_refetched(self):
        home, article = 'https://news.test/', 'https://news.test/news/article'
        records = {home: page(home, [(article, 'A legacy independently reviewed story', '')]), article: page(article, kind='article')}
        self.run_scan(records)
        path = self.output / 'candidate_ledger.json'
        doc = json.loads(path.read_text())
        doc['candidateLedger'][0].update(decision='accepted', decisionOrigin='human')
        path.write_text(json.dumps(doc))
        records[home] = page(home)
        _, ledger = self.run_scan(records)
        self.assertEqual(ledger[article]['decision'], 'selected')
        self.assertEqual(ledger[article]['previousDecision'], 'accepted')
        self.assertEqual(ledger[article]['previousDecisions'][-1]['decision'], 'accepted')

    def test_listing_budget_resume_advances_past_first_seeds_and_retains_real_queue(self):
        s = source()
        s['sections'] = [{'url': 'https://news.test/section/' + str(n)} for n in range(1, 6)]
        records = {e['url']: page(e['url']) for e in s['entrypoints'] + s['sections']}
        first, _ = self.run_scan(records, [s], max_pages_per_source=3)
        self.assertEqual(first['listingQueueRemaining'], 3)
        self.assertTrue(first['listingQueue'])
        before = len(self.calls)
        second, _ = self.run_scan(records, [s], max_pages_per_source=3)
        newly_called = {u for u, _ in self.calls[before:]}
        self.assertIn('https://news.test/section/3', newly_called)
        self.assertIn('https://news.test/section/4', newly_called)
        self.assertIn('https://news.test/', newly_called)
        self.assertTrue(any(j['url'] == 'https://news.test/section/5' for j in second['listingQueue']))
        self.assertFalse(second['complete'])

    def test_structural_navigation_is_skipped_without_topic_filters(self):
        home, small = 'https://news.test/', 'https://news.test/small-shop-labour-procedure'
        menu = 'https://news.test/advertising'
        listing = page(home, [(menu, 'Advertising and commercial contact', ''),
                               (small, 'Small shops comply with new local labour procedure', '')])
        listing['links'][0]['inNavigation'] = True
        listing['links'][1]['inNavigation'] = False
        _, ledger = self.run_scan({home: listing, small: page(small, kind='unknown')})
        self.assertNotIn(menu, ledger)
        self.assertIn(small, ledger)

    def test_social_profile_metadata_does_not_count_as_original_post_fulltext(self):
        s = source('telegram', 'Social Publisher', 't.me')
        s.update(kind='social')
        s['entrypoints'] = [{'url': 'https://t.me/channel', 'role': 'home', 'language': 'ru'}]
        profile = 'https://t.me/anotherchannel'
        home = page('https://t.me/channel', [(profile, 'Official publisher channel description', '')])
        result, ledger = self.run_scan({'https://t.me/channel': home, profile: page(profile, kind='article')}, [s])
        self.assertEqual(ledger[profile]['reason'], 'social_profile_not_original_post')
        self.assertIsNone(ledger[profile]['fullTextFetchedAt'])
        self.assertEqual(result['funnel']['fullTextReadableCandidates'], 0)
        self.assertTrue(all(r['kind'] == 'social_profile' for r in result['sourceScanAudit']))

    def test_short_resume_prioritizes_families_not_yet_sampled(self):
        sources = [source('a', 'A', 'a.test'), source('b', 'B', 'b.test'), source('c', 'C', 'c.test')]
        records = {'https://' + host + '/': page('https://' + host + '/') for host in ('a.test', 'b.test', 'c.test')}
        self.run_scan(records, sources, workers=1, max_seconds=1.5, clock=lambda: len(self.calls))
        self.assertEqual([url for url, _ in self.calls], ['https://a.test/'])
        before = len(self.calls)
        self.run_scan(records, sources, workers=1, max_seconds=1.5, clock=lambda: len(self.calls) - before)
        self.assertEqual([url for url, _ in self.calls[before:]], ['https://b.test/'])

    def test_preferred_publisher_gets_a_listing_slot_under_short_news_budget(self):
        ordinary = source('original', 'A', 'early.test')
        primary = source('institution', 'Z', 'primary.test')
        primary['preferredInBoundedScan'] = True
        records = {url: page(url) for url in ['https://early.test/', 'https://primary.test/']}
        result, _ = self.run_scan(records, [ordinary, primary], news_budget=True,
                                  workers=1, max_seconds=3, clock=lambda: len(self.calls))
        self.assertEqual([url for url, _ in self.calls], ['https://primary.test/'])
        self.assertEqual([job['url'] for job in result['listingQueue']], ['https://early.test/'])
        self.assertFalse(result['complete'])

        before = len(self.calls)
        self.run_scan(records, [ordinary, primary], news_budget=True,
                      workers=1, max_seconds=3, clock=lambda: len(self.calls) - before)
        self.assertEqual([url for url, _ in self.calls[before:]], ['https://early.test/'])

    def test_old_permanent_refusal_does_not_hide_latest_transient_failure(self):
        home = 'https://news.test/'
        first, _ = self.run_scan({home: page(home, status=403)})
        self.assertEqual(first['unavailableSourceIds'], ['one'])
        later = page(home, status=503)
        later['fetchedAt'] = '2026-11-15T00:03:00Z'
        second, _ = self.run_scan({home: later})
        self.assertEqual(second['unavailableSourceIds'], [])

    def test_listing_role_hint_and_cutoff_are_not_applied_to_article_jobs(self):
        home, article = 'https://news.test/', 'https://news.test/news/article'
        records = {home: page(home, [(article, 'A new business declaration headline', '')]), article: page(article, kind='article')}
        calls = []
        def fetch(url, minimum, source_role='auto'):
            calls.append((url, minimum, source_role))
            return records[url]
        discover({'sources': [source()]}, 'kz', '2026-11-15', self.output,
                 listing_not_before='2026-11-14T22:00:00Z', fetcher=fetch)
        self.assertEqual(calls, [(home, '2026-11-14T22:00:00Z', 'listing'), (article, None, 'article')])

    def test_offline_legacy_lead_migration_keeps_actual_and_selected_candidates(self):
        home, first, queued = 'https://news.test/', 'https://news.test/news/first', 'https://news.test/news/later'
        records = {home: page(home, [(first, 'A selected original company story', ''), (queued, 'A raw link awaiting text retrieval', '')]),
                   first: page(first, kind='article')}
        self.run_scan(records, max_articles_per_source=1)
        path = self.output / 'candidate_ledger.json'
        document = json.loads(path.read_text())
        document['candidateLedger'][0].update(decision='selected', decisionOrigin='human')
        legacy = dict(next(l for l in self.leads if l['source_url'] == queued))
        legacy.update(decision='pending', reason='full_text_not_fetched_budget', fullTextFetchedAt=None, publicationEvidence=[])
        document['candidateLedger'].append(legacy)
        path.write_text(json.dumps(document))
        calls = len(self.calls)
        receipt = migrate_discovery_leads(self.output)
        after = json.loads(path.read_text())['candidateLedger']
        leads = json.loads((self.output / 'lead_queue.json').read_text())['leadLedger']
        self.assertEqual(receipt['movedToLeadQueue'], 1)
        self.assertEqual(len(after), 1)
        self.assertEqual(after[0]['decision'], 'selected')
        lead = next(l for l in leads if l['source_url'] == queued)
        self.assertEqual(lead['status'], 'queued')
        self.assertEqual(lead['evidence'][0]['url'], home)
        self.assertTrue(lead['listingEvidenceResolved'])
        self.assertEqual(len(self.calls), calls)
        self.assertEqual(migrate_discovery_leads(self.output)['movedToLeadQueue'], 0)

    def fixture_for_rebase(self):
        home, article = 'https://news.test/', 'https://news.test/news/article'
        self.run_scan({home: page(home, [(article, 'A genuine business source for portable evidence', '')]),
                       article: page(article, kind='article', published='2026-11-14T20:00:00+05:00')})

    def test_rebase_extracted_evidence_checks_hash_and_preserves_source_facts(self):
        self.fixture_for_rebase()
        before = json.loads((self.output / 'candidate_ledger.json').read_text())['candidateLedger'][0]
        with tempfile.TemporaryDirectory() as folder:
            restored = Path(folder) / 'restored'
            shutil.copytree(self.output, restored)
            receipt = rebase_discovery_paths(restored)
            after = json.loads((restored / 'candidate_ledger.json').read_text())['candidateLedger'][0]
            self.assertGreater(receipt['rebasedPaths'], 0)
            self.assertTrue(Path(after['sourceJSON']).is_relative_to(restored))
            self.assertTrue(Path(after['sourceHTML']).is_relative_to(restored))
            for field in ('source_url', 'sourceHash', 'fullTextFetchedAt', 'discoveredAt', 'publicationEvidence'):
                self.assertEqual(after[field], before[field])
            self.assertEqual(rebase_discovery_paths(restored)['rebasedPaths'], 0)

    def test_rebase_rejects_corrupt_file_before_metadata_is_changed(self):
        self.fixture_for_rebase()
        with tempfile.TemporaryDirectory() as folder:
            restored = Path(folder) / 'restored'
            shutil.copytree(self.output, restored)
            metadata = restored / 'candidate_ledger.json'
            before = metadata.read_bytes()
            item = json.loads(before)['candidateLedger'][0]
            target = restored / 'evidence' / Path(item['sourceJSON']).name
            target.write_bytes(target.read_bytes() + b' ')
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                rebase_discovery_paths(restored)
            self.assertEqual(metadata.read_bytes(), before)

    def test_rebase_rejects_traversal_and_symlink_escape(self):
        self.fixture_for_rebase()
        metadata = self.output / 'candidate_ledger.json'
        document = json.loads(metadata.read_text())
        document['candidateLedger'][0]['evidence'][0]['localPath'] = str(self.output / 'evidence' / '..' / 'outside.json')
        metadata.write_text(json.dumps(document))
        with self.assertRaisesRegex(ValueError, 'unsafe'):
            rebase_discovery_paths(self.output)
        self.temp.cleanup()
        self.temp = tempfile.TemporaryDirectory()
        self.output = Path(self.temp.name)
        self.fixture_for_rebase()
        with tempfile.TemporaryDirectory() as folder:
            source = json.loads((self.output / 'candidate_ledger.json').read_text())['candidateLedger'][0]['sourceJSON']
            target = Path(source)
            external = Path(folder) / 'external.json'
            external.write_bytes(target.read_bytes())
            target.unlink()
            target.symlink_to(external)
            with self.assertRaisesRegex(ValueError, 'outside'):
                rebase_discovery_paths(self.output)

    def test_explicit_search_privacy_and_tag_routes_never_take_article_budget(self):
        home = 'https://news.test/'
        urls = ['https://news.test/search/current-economy', 'https://news.test/privacy',
                'https://news.test/tagmix/business', 'https://news.test/author/editor']
        good = 'https://news.test/category/business/small-shop-registration-12345'
        listing = page(home, [(u, 'A misleading collection or permanent page headline', '') for u in urls] +
                             [(good, 'A small shop registration and labour procedure', '')])
        listing['links'][-1].update(inHeading=True, articleCard=True, nearbyTimes=[{'datetime': '2026-11-14T20:00:00+05:00'}])
        records = {home: listing, good: page(good, kind='article')}
        result, ledger = self.run_scan(records, max_articles_per_source=1)
        self.assertEqual(set(ledger), {good})
        for url in urls:
            self.assertNotIn((url, None), self.calls)
            lead = next(l for l in self.leads if l['source_url'] == url)
            self.assertIn(lead['status'], ('routed_listing', 'non_news'))
            self.assertTrue(lead['routeReason'])
        self.assertTrue(any(j['url'] == urls[0] for j in result['listingQueue']))

    def test_verified_article_shape_prioritizes_exchange_news_over_issuer_directory(self):
        s = source('kz-kazakhstan-stock-exchange', 'KASE')
        home, directory = 'https://news.test/', 'https://news.test/en/issuers/company-123456'
        article = 'https://news.test/en/information/news/show/1580352'
        records = {home: page(home, [(directory, 'Issuer information and trading directory', ''),
                                     (article, 'A bond issue opening for a small company', '')]),
                   article: page(article, kind='article')}
        _, ledger = self.run_scan(records, [s], max_articles_per_source=1)
        self.assertEqual(set(ledger), {article})
        self.assertEqual(next(l for l in self.leads if l['source_url'] == directory)['leadType'], 'listing')

    def test_specific_guides_category_articles_and_sme_are_not_topic_excluded(self):
        s = source()
        urls = ['https://news.test/category/economy/microbusiness-tax-123456',
                'https://news.test/guide/small-shop-payroll-and-tax',
                'https://news.test/advertising/local-enterprise-invests-123456']
        for url in urls:
            self.assertEqual(lead_route(url, s)[0], 'article_candidate')
        leads = [{'source_url': url, 'status': 'queued', 'anchorEvidence': [{'inHeading': True, 'articleCard': True}]} for url in urls]
        ranked = rank_leads(leads, s)
        self.assertTrue(all(l['articlePriority'] >= 145 for l in ranked))

    def test_observed_24kg_plot_and_tengri_sections_route_without_hiding_child_stories(self):
        kg = source('kg-24-kg', '24.kg', '24.kg')
        tengri = source('kz-tengrinews', 'Tengrinews', 'tengrinews.kz')
        self.assertEqual(lead_route('https://24.kg/plot/114', kg)[0], 'listing')
        self.assertEqual(lead_route('https://24.kg/article/small-construction-franchise', kg)[0], 'article_candidate')
        self.assertEqual(lead_route('https://24.kg/plot/114/article/small-construction-franchise', kg)[0], 'article_candidate')
        self.assertEqual(lead_route('https://tengrinews.kz/tengri-education/', tengri)[0], 'listing')
        self.assertEqual(lead_route('https://tengrinews.kz/tengritravel/', tengri)[0], 'listing')
        self.assertEqual(lead_route('https://tengrinews.kz/tengri-education/small-business-staff-training-123456/', tengri)[0], 'article_candidate')

    def test_body_identity_failure_remains_pending_with_actual_attempt_evidence(self):
        home, article = 'https://news.test/', 'https://news.test/news/body-identity-problem'
        record = page(article, kind='article')
        record.update(contentValidated=False, fullTextValidated=False, error='article_body_identity_unresolved')
        _, ledger = self.run_scan({home: page(home, [(article, 'A body that needs the actual primary article verified', '')]), article: record})
        self.assertEqual(ledger[article]['decision'], 'pending')
        self.assertEqual(ledger[article]['reason'], 'pending_body_identity_verification')
        self.assertIsNone(ledger[article]['fullTextFetchedAt'])
        self.assertTrue(ledger[article]['sourceJSON'])

    def test_focused_final_uses_pending_article_after_it_leaves_the_list(self):
        home = 'https://news.test/'
        article = home + 'news/energy-investment'
        incomplete = page(article, kind='article', published='2026-11-14T20:00:00+05:00')
        incomplete.update(contentValidated=False, fullTextValidated=False,
                          error='current_article_body_unverified_article_body_not_identified')
        opts = {'news_budget': True, 'listing_not_before': '2026-11-14T22:00:00Z'}
        _, first = self.run_scan({home: page(home, [(article, 'New energy investment', '')]), article: incomplete}, **opts)
        self.assertEqual(first[article]['reason'], 'pending_body_identity_verification')
        self.calls.clear()
        recovered = page(article, kind='article', published='2026-11-14T20:00:00+05:00',
                         text='This is the recovered body of the original story.')
        recovered['fullTextValidated'] = True
        _, ledger = self.run_scan({home: page(home), article: recovered}, only_source_ids=['one'], **opts)
        self.assertEqual(self.calls, [(article, None)], 'fresh list is sufficient; retry the exact unfinished original')
        self.assertTrue(ledger[article]['fullTextValidated'])
        self.assertEqual(ledger[article]['publicationWindowAssessment'], 'in_window')
        self.assertEqual(ledger[article]['decision'], 'pending', 'recovered text still needs editorial review')

    def test_focused_body_fetch_is_bounded_and_keeps_refusal(self):
        fetch = load_fetcher(self.output)
        url = 'https://news.test/news/energy-investment'
        key = hashlib.sha256(url.encode()).hexdigest()[:18]
        record = page(url, kind='article')
        record.update(parser_version=fetch.__globals__['PARSER_VERSION'], contentValidated=False, fullTextValidated=False,
                      error='current_article_body_unverified_article_body_not_identified')
        cache = self.output / 'sources' / (key + '.json')
        cache.write_text(json.dumps(record))
        refusal = {'status': 403, 'error': 'HTTP 403', 'fetchRetryable': False}
        with patch.dict(fetch.__globals__, {'bounded_response': lambda *args: (refusal, b'')}):
            metrics = {}
            self.assertEqual(fetch(url, source_role='article', fetch_metrics=metrics)['status'], 200)
            self.assertEqual(metrics['transportAttempts'], 0)
            self.assertEqual(fetch(url, source_role='article', fetch_metrics=metrics, recheck_article_body=True)['status'], 403)
            self.assertEqual(metrics['transportAttempts'], 1)
            self.assertEqual(fetch(url, source_role='article', fetch_metrics=metrics, recheck_article_body=True)['status'], 403)
            self.assertEqual(metrics['transportAttempts'], 0)

    def test_same_body_corrected_publication_or_parser_reopens_old_manual_rejection(self):
        home, article = 'https://news.test/', 'https://news.test/news/article'
        records = {home: page(home, [(article, 'A main article whose publication evidence is corrected', '')]),
                   article: page(article, kind='article', published='2026-11-14T20:00:00+05:00')}
        records[article]['parser_version'] = 'test-v1'
        _, ledger = self.run_scan(records)
        initial_hash = ledger[article]['sourceHash']
        path = self.output / 'candidate_ledger.json'
        def reject():
            document = json.loads(path.read_text())
            document['candidateLedger'][0].update(decision='rejected', decisionOrigin='human', reason='publication date insufficient')
            path.write_text(json.dumps(document))
        reject()
        records[article]['publicationEvidence'][0]['raw'] = '2026-11-14T21:00:00+05:00'
        _, ledger = self.run_scan(records)
        self.assertEqual(ledger[article]['sourceHash'], initial_hash)
        self.assertEqual(ledger[article]['decision'], 'pending')
        self.assertEqual(ledger[article]['previousDecision'], 'rejected')
        self.assertTrue(ledger[article]['reopenedAfterRevisionChange'])
        reject()
        records[article]['parser_version'] = 'test-v2'
        _, ledger = self.run_scan(records)
        self.assertEqual(ledger[article]['decision'], 'pending')
        self.assertEqual(ledger[article]['sourceHash'], initial_hash)
        self.assertTrue(ledger[article]['reopenedAfterRevisionChange'])

    def test_new_observation_time_alone_preserves_manual_decision_revision(self):
        home, article = 'https://news.test/', 'https://news.test/news/article'
        records = {home: page(home, [(article, 'A main article reviewed without further material changes', '')]),
                   article: page(article, kind='article', published='2026-11-14T20:00:00+05:00')}
        _, ledger = self.run_scan(records)
        revision = ledger[article]['sourceRevisionHash']
        path = self.output / 'candidate_ledger.json'
        document = json.loads(path.read_text())
        document['candidateLedger'][0].update(decision='selected', decisionOrigin='human', reason='source verified')
        path.write_text(json.dumps(document))
        records[article]['fetchedAt'] = '2026-11-15T00:08:00+00:00'
        records[article]['observedAt'] = '2026-11-15T00:08:00+00:00'
        _, ledger = self.run_scan(records)
        self.assertEqual(ledger[article]['sourceRevisionHash'], revision)
        self.assertEqual(ledger[article]['decision'], 'selected')
        self.assertTrue(ledger[article]['manualDecisionPreserved'])

    def test_latest_reparse_supersedes_old_metadata_without_losing_real_fetch_history(self):
        first = {'sourceId': 'one', 'url': 'https://news.test/article', 'role': 'article', 'fetchedAt': STAMP,
                 'observedAt': STAMP, 'kind': 'article', 'eventId': 'first'}
        revised = dict(first, eventId='revised', kind='listing', reparsedAt='2026-11-15T01:00:00Z')
        later = dict(first, eventId='later', fetchedAt='2026-11-15T02:00:00Z', observedAt='2026-11-15T02:00:00Z')
        events = [first, revised, later]
        active = active_scan_events(events)
        self.assertEqual({r['eventId'] for r in active}, {'revised', 'later'})
        self.assertEqual(len(events), 3)
        self.assertEqual(first['kind'], 'article')

    def test_bounded_supplement_only_fetches_selected_sources_and_keeps_registry_totals(self):
        sources = [source('one', 'A', 'one.test'), source('two', 'B', 'two.test')]
        result, _ = self.run_scan({'https://one.test/': page('https://one.test/')}, sources, only_source_ids=['one'])
        self.assertEqual([c[0] for c in self.calls], ['https://one.test/'])
        self.assertEqual(result['funnel']['registeredSources'], 2)
        self.assertEqual(result['runSourceIds'], ['one'])

    def test_offline_reparse_closes_search_seo_false_positive_and_preserves_selected_conflict(self):
        url = 'https://news.test/search/business'
        content = ('Actual listing prose about multiple business stories. ' * 12)
        raw = ('<html lang="ru"><head><meta property="og:type" content="article"><meta property="og:title" content="Business search">'
               '<meta property="article:published_time" content="2026-11-14T20:00:00+05:00"></head>'
               '<body><article><h1>Business search</h1><p>' + content + '</p></article></body></html>').encode()
        record = page(url, kind='article', published='2026-11-14T20:00:00+05:00')
        record.update(title='Business search', parser_version='source-html-v14', key=hashlib.sha256(url.encode()).hexdigest()[:18])
        (self.output / 'sources').mkdir()
        (self.output / 'evidence').mkdir()
        cache = self.output / 'sources' / (record['key'] + '.json')
        cache.write_text(json.dumps(record))
        with gzip.open(cache.with_suffix('.html.gz'), 'wb') as handle:
            handle.write(raw)
        snapshot = self.output / 'evidence' / 'old.json'
        snapshot.write_text(json.dumps(record))
        sha = hashlib.sha256(snapshot.read_bytes()).hexdigest()
        candidate = {'id': 'candidate-one', 'sourceId': 'one', 'family': 'one', 'country': 'kz', 'source_url': url,
                     'sourceHash': record['source_sha256'], 'sourceJSON': str(snapshot), 'sourceJSONSha256': sha,
                     'discoveredAt': STAMP, 'fullTextFetchedAt': STAMP, 'decision': 'pending', 'reason': 'needs review',
                     'evidence': [{'url': url, 'observedAt': STAMP, 'description': 'Original source', 'sha256': sha, 'localPath': str(snapshot)}]}
        ledger = {'country': 'kz', 'issueDate': '2026-11-15', 'windowStart': '2026-11-14T06:00:00+08:00',
                  'windowEnd': '2026-11-15T06:00:00+08:00', 'candidateLedger': [candidate]}
        (self.output / 'candidate_ledger.json').write_text(json.dumps(ledger))
        (self.output / 'lead_queue.json').write_text(json.dumps({k: v for k, v in ledger.items() if k != 'candidateLedger'} | {'leadLedger': [dict(candidate, status='attempted')]}))
        event = {'eventId': 'original', 'sourceId': 'one', 'family': 'one', 'sourceType': 'media', 'role': 'article',
                 'url': url, 'final_url': url, 'fetchedAt': STAMP, 'kind': 'article', 'status': 200, 'contentValidated': True}
        (self.output / 'source_scan_events.jsonl').write_text(json.dumps(event) + '\n')
        (self.output / 'source_scan_audit.json').write_text(json.dumps({'sourceScanAudit': [event], 'listingQueue': [], 'funnel': {}}))
        report = rerank_cached_leads({'sources': [source()]}, 'kz', self.output)
        updated = json.loads((self.output / 'candidate_ledger.json').read_text())['candidateLedger'][0]
        self.assertEqual(updated['decision'], 'rejected')
        self.assertEqual(report['machineArticleCandidatesWithReadableFullText'], 0)
        self.assertEqual(report['explicitlyInWindowCandidates'], 0)
        self.assertEqual(updated['fullTextFetchedAt'], STAMP)
        self.assertTrue(snapshot.exists())
        self.assertTrue(updated['sourceHistory'])
        resumed = discover({'sources': [source()]}, 'kz', '2026-11-15', self.output,
                            fetcher=lambda target, minimum, source_role='auto': page(target))
        self.assertEqual(resumed['funnel']['explicitlyInWindowCandidates'], 0)
        updated['decision'] = 'selected'
        ledger['candidateLedger'] = [updated]
        (self.output / 'candidate_ledger.json').write_text(json.dumps(ledger))
        rerank_cached_leads({'sources': [source()]}, 'kz', self.output)
        selected = json.loads((self.output / 'candidate_ledger.json').read_text())['candidateLedger'][0]
        self.assertEqual(selected['decision'], 'pending')
        self.assertEqual(selected['reason'], 'selected_route_conflict_needs_review')


if __name__ == '__main__':
    unittest.main()
