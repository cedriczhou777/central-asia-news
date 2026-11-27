"""Offline regression over the saved incident; never open a source or service."""
import copy
from contextlib import redirect_stdout
import gzip
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops' / 'plan-b'))
from discover_work_sources import discover, pagination_links
from news_queue_policy import (VERSION, MAX_ACTIVE_ARTICLES, digest, importance,
                               archived_publication_is_old, bounded_review_reason, partition_coverage,
                               publisher_reference_directory, validate_queue_accounting)
from source_coverage import COVERAGE_VERSION, assess_coverage
import work_client
from test_work_discovery import source, page
from datetime import datetime

FIXTURE=Path(os.environ.get('PLAN_B_INCIDENT_FIXTURE',
    str(Path(__file__).with_name('fixtures')/'plan-b-20261122-real-queues.json.gz')))


class BoundedQueuePolicy(unittest.TestCase):
    def test_work_client_blocked_reads_and_checkpoint_base_are_explicit(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(work_client,'protected_connection',return_value=('https://unit.test','fixture-key')), \
                patch.object(work_client,'handshake',return_value={'ok':True}) as request, redirect_stdout(io.StringIO()):
            def run(args):
                with patch.object(sys,'argv',['work_client.py',*args]),self.assertRaises(SystemExit) as stopped:
                    work_client.main()
                return stopped.exception.code
            self.assertEqual(run(['manifest','--phase','final','--allow-blocked']),0)
            self.assertEqual(request.call_args.args[2]['allowBlocked'],'1')
            request.reset_mock()
            self.assertEqual(run(['submit','--phase','final','--allow-blocked']),1)
            request.assert_not_called()
            document=Path(directory)/'checkpoint.json';document.write_text('{"writer":{"articles":[]},"review":{"completedIds":[]}}')
            self.assertEqual(run(['checkpoint','--document',str(document),'--hash','f'*64,'--base-checkpoint-hash','b'*64]),0)
            self.assertEqual(request.call_args.args[3]['baseCheckpointHash'],'b'*64)

    def test_budget_reserves_bodies_and_preserves_unfetched_work(self):
        calls=[]
        sources=[source(str(i),str(i),f'{i}.news.test') for i in range(12)]
        def fetcher(url, minimum, source_role='auto'):
            calls.append((url,source_role))
            if source_role=='listing':
                links=[(url+f'news/ordinary-{i}-event', f'Local SME event {i}', '') for i in range(15)]
                # Deliberately last in the DOM: positive priority must survive sorting.
                links.append((url+'news/energy-investment-policy', 'Major energy investment policy', ''))
                links.extend([(url+'privacy','Publisher privacy policy',''),
                              (url+'?page=1942','Ancient archive','next'),
                              (url+'?page=2','Older','next')])
                return page(url,links)
            record=page(url,kind='article',published='2026-11-14T12:00:00+08:00')
            record.update(fullTextValidated=True,title='Fixed local business news')
            return record
        with tempfile.TemporaryDirectory() as directory, patch('socket.create_connection',side_effect=AssertionError('network forbidden')):
            result=discover({'sources':sources},'kz','2026-11-15',Path(directory),
                fetcher=fetcher,news_budget=True,max_pages_per_source=2,max_articles_per_source=12,max_seconds=60)
            articles=[url for url,role in calls if role=='article']
            self.assertLessEqual(len(articles),MAX_ACTIVE_ARTICLES)
            self.assertEqual(len(articles),MAX_ACTIVE_ARTICLES)
            self.assertTrue(all('energy-investment-policy' in url for url in articles[:12]))
            self.assertTrue(any('ordinary' in url for url in articles),'SME news is not blacklisted')
            self.assertFalse(any('1942' in url or 'privacy' in url for url,_ in calls))
            self.assertTrue(all(n<=2 for n in result['pageFetchCounts'].values()))
            self.assertEqual(result['newsBudget']['listingFraction'],.25)
            self.assertGreater(result['rawLeadsQueued'],0,'unfetched work stays in the cache')

    def test_one_observed_adjacent_page_only(self):
        self.assertEqual(pagination_links({'url':'https://news.test/',
            'nextLinks':['https://news.test/?page=1942','https://news.test/?page=2']},True),
            ['https://news.test/?page=2'])

    def test_unknown_or_important_body_never_becomes_coverage_success(self):
        stamp='2026-11-22T06:02:00+08:00'; cutoff=datetime.fromisoformat('2026-11-22T06:00:00+08:00')
        registry={'sources':[source()]}; registry['sources'][0]['country']='kz'
        audit={'sourceId':'one','url':'https://news.test/','role':'home','kind':'listing',
               'status':200,'contentValidated':True,'fetchedAt':stamp}
        urls=['https://news.test/news/ordinary-event','https://news.test/news/energy-policy']
        inventory={'sourceScanAudit':[audit],'observedAt':stamp,'maxSeconds':60,
                   'articleQueue':[{'sourceId':'one','url':url} for url in urls]}
        leads=[{'sourceId':'one','source_url':url,'status':'queued',
                'queueAssessment':{'version':VERSION,**importance({'url':url})}} for url in urls]
        proof=assess_coverage(registry,'kz',inventory,cutoff,leads=leads,observed_at=stamp)
        self.assertEqual(proof['state'],'blocked')
        self.assertTrue(any(w.get('url')==urls[1] for w in proof['pendingWork']))
        self.assertFalse(any(w.get('url')==urls[0] for w in proof['pendingWork']))
        self.assertEqual(proof['queueAccounting']['article'],dict(total=2,pending=1,review=1,closed=0,
            identityHash=proof['queueAccounting']['article']['identityHash']))
        for lead in leads:lead.pop('queueAssessment')
        unknown=assess_coverage(registry,'kz',inventory,cutoff,leads=leads,observed_at=stamp)
        self.assertTrue(any(w.get('url')==urls[0] and w['kind']=='article' for w in unknown['pendingWork']))

    def test_archive_url_is_only_a_priority_hint(self):
        old={'url':'https://news.test/2020/01/01/energy-policy/'}
        self.assertFalse(importance(old,'2026-11-22T06:00:00+08:00')['important'])
        self.assertTrue(importance({**old,'mustProcess':True},'2026-11-22T06:00:00+08:00')['important'])
        self.assertTrue(importance({**old,'title':'Major energy announcement'},'2026-11-22T06:00:00+08:00')['important'])

    def test_verified_directory_and_exact_old_local_time_keep_new_articles_pending(self):
        reference = 'https://economy.gov.az/en/page/beynelxalq-elaqeler/maliyye-institutlari-ile-emekdasliq'
        self.assertTrue(publisher_reference_directory(reference))
        self.assertFalse(publisher_reference_directory(reference + '/new-project'))
        self.assertFalse(publisher_reference_directory('https://cbu.uz/ru/statistics/credit/5040955/'))
        archived = 'https://www.vb.kg/doc/463410_v_kyrgyzstane_gotoviat_edinyy_zakon_ili_migracionnyy_kodeks_k_2027_gody.html'
        cutoff = '2026-11-27T06:00:00+08:00'
        old = {'anchorEvidence': [{'nearbyTimes': [{'text': '2026-11-25'}]}]}
        recent = {'anchorEvidence': [{'nearbyTimes': [{'text': '2026-11-26T10:00:00+06:00'}]}]}
        self.assertTrue(archived_publication_is_old(archived, old, cutoff))
        self.assertFalse(archived_publication_is_old(archived, recent, cutoff))
        self.assertFalse(archived_publication_is_old(archived, {'rawPublicationEvidence': [{'kind': 'published'}]}, cutoff))

    def test_verified_navigation_keeps_current_news_obligations(self):
        for url in ('https://www.ozodi.org/z/538', 'https://www.ozodi.org/z/3537',
                    'https://kz.kursiv.media/en/category/economics/banks-finance/',
                    'https://president.uz/ru/site/document/2?menu_id=144',
                    'https://transport.ec.europa.eu/news-events/news_nl',
                    'https://transport.ec.europa.eu/select-language?destination=/node/2',
                    'https://www.spot.uz/ru/legislation/'):
            with self.subTest(url=url):
                self.assertTrue(publisher_reference_directory(url))
        for url in ('https://www.ozodi.org/a/news-today/33906329.html',
                    'https://transport.ec.europa.eu/news-events/news/current-transport-dialogue_en',
                    'https://president.uz/ru/lists/view/9899'):
            with self.subTest(url=url):
                self.assertFalse(publisher_reference_directory(url))

    def test_verified_prior_disclosure_does_not_override_current_evidence(self):
        work = {'url': 'https://www.super.kg/article/show/63454', 'kind': 'article'}
        cutoff = '2026-11-27T06:00:00+08:00'
        self.assertEqual(bounded_review_reason(work, {}, cutoff),
                         'prior_first_disclosure_requires_coverage_review')
        self.assertIsNone(bounded_review_reason(work, {'candidate': {'publicationWindowAssessment': 'in_window'}}, cutoff))
        self.assertIsNone(bounded_review_reason(work, {'lead': {'anchorEvidence': [
            {'nearbyTimes': [{'text': '2026-11-26T12:00:00+06:00'}]}]}}, cutoff))


@unittest.skipUnless(FIXTURE.exists(),'provide private PLAN_B_INCIDENT_FIXTURE for real incident regression')
class RealNovember22Queues(unittest.TestCase):
    def test_all_real_queue_records_are_accounted_without_faking_freeze(self):
        fixture=json.loads(gzip.decompress(FIXTURE.read_bytes()))
        registry=json.loads((Path(__file__).resolve().parents[1]/'ops/plan-b/source_registry.json').read_text())
        sources={s['id']:s for s in registry['sources']}
        expected={'kz':2212,'uz':1530,'kg':1699,'tj':862,'az':120}
        totals=0; summary=[]
        with patch('socket.create_connection',side_effect=AssertionError('network forbidden')):
            for country in fixture['countries']:
                before=copy.deepcopy(country['coverage']); original_hash=digest(country)
                self.assertEqual(len(before['pendingWork']),expected[country['country']])
                proof=partition_coverage(copy.deepcopy(before),sources)
                totals+=len(before['pendingWork'])
                self.assertEqual(proof['queues'],before['queues'],'never zero queue counters')
                self.assertEqual(proof['discoveryEnd']['originalPendingCount'],len(before['pendingWork']))
                self.assertFalse(proof['discoveryEnd']['unfinishedWorkCompleted'])
                self.assertEqual(proof['discoveryEnd']['originalWorkHash'],digest(
                    before['pendingWork']+before.get('reviewWork',[])+before.get('closedQueueWork',[])))
                self.assertEqual(digest(country),original_hash,'saved candidate and body hashes untouched')
                # Saved descriptors lack the new collector's body assessment:
                # unknown article bodies must remain blocked, not relabelled green.
                self.assertEqual(proof['state'],'blocked')
                self.assertTrue(any(w['kind']=='article' for w in proof['pendingWork']))
                for work in proof['reviewWork']:
                    self.assertGreater(work['count'],0); self.assertEqual(len(work['queueHash']),64)
                for kind,counts in proof['queueAccounting'].items():
                    self.assertLessEqual(sum(counts[k] for k in ('pending','review','closed')),counts['total'])
                if country['country']=='tj':
                    self.assertTrue(any(w['reason']=='unaccounted_queue_identity' for w in proof['pendingWork']),
                                    'five missing/insecure listing identities cannot be invented')
                summary.append({'country':country['country'],'oldBlocking':len(before['pendingWork']),
                    'strictRemaining':len(proof['pendingWork']),'coverageReviewGroups':len(proof['reviewWork']),
                    'frozenReady':False})
                # Queue counts cannot be erased to forge a coverage proof.
                tampered=copy.deepcopy(proof);tampered['queueAccounting']['listing']['total']+=1
                with self.assertRaisesRegex(ValueError,'coverage_evidence_invalid'):validate_queue_accounting(tampered)
        self.assertEqual(totals,6423)
        print('REAL_NOV22_QUEUE_REGRESSION '+json.dumps({'sourceSha256':fixture['sourceSha256'],
            'originalBlockingItems':totals,'countries':summary},sort_keys=True))


if __name__=='__main__':unittest.main()
