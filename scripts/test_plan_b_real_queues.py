"""Bounded regression over retained Nov22 samples and all 269 Nov23 pending URLs."""
import json,sys,unittest,os
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'ops/plan-b'))
from news_queue_policy import bounded_review_reason
from source_coverage import assess_coverage
from datetime import datetime
from db_handoff import sql,verify_original,digest
from work_client import protected_connection
from unittest.mock import patch

class RealQueueRegression(unittest.TestCase):
    def test_all_real_pending_identities_are_retained(self):
        path=os.environ.get('PLAN_B_REAL_QUEUE_FIXTURE')
        if not path:self.skipTest('Production fixture is private; set PLAN_B_REAL_QUEUE_FIXTURE for authorized regression')
        saved=json.loads(Path(path).read_text())
        count=0;report=[]
        for row in saved['rows']:
            coverage=row['coverage'];pending=coverage['pendingWork'];before=json.dumps(pending,sort_keys=True)
            reasons=[bounded_review_reason(work,{},coverage['windowEnd'])for work in pending]
            self.assertEqual(before,json.dumps(pending,sort_keys=True))
            if row['issue_date']=='2026-11-23':count+=len(pending);self.assertEqual(len(pending),row['originalPendingCount'])
            report.append({'issue':row['issue_date'],'country':row['country'],'sampled':row['sampled'],
                'originalPending':row['originalPendingCount'],'reviewTriage':sum(r is not None for r in reasons),
                'stillRequiresEvidence':sum(r is None for r in reasons),'closed':0})
        self.assertEqual(count,sum(r['originalPendingCount']for r in saved['rows']if r['issue_date']=='2026-11-23'))
        print(json.dumps({'realQueueRegression':report,'nov23AllPendingChecked':count,'productionFreezeDeclared':False}))

    def test_directory_cannot_fake_signed_coverage_or_real_news(self):
        source_id='az-ministry-economy-azerbaijan'
        listing='https://economy.gov.az/az/'
        directory='https://economy.gov.az/az/page/iqtisadiyyat/investisiya'
        stamp='2026-11-24T06:02:00+08:00'
        source={'id':source_id,'country':'az','allowedHosts':['economy.gov.az'],
                'entrypoints':[{'url':listing,'role':'home'}],'available':True}
        registry={'sources':[source]}
        audit={'sourceId':source_id,'url':listing,'status':200,
               'contentValidated':True,'fetchedAt':stamp,'role':'home'}
        inventory={'sourceScanAudit':[audit],'observedAt':stamp,'maxSeconds':120}
        ledger=[{'id':'fixture', 'sourceId':source_id,'source_url':directory,
                 'decision':'pending','fullTextValidated':False}]
        cutoff=datetime.fromisoformat('2026-11-24T06:00:00+08:00')
        proof=assess_coverage(registry,'az',inventory,cutoff,ledger=ledger,observed_at=stamp)
        self.assertEqual(proof['pendingWork'],[])
        self.assertEqual(proof['state'],'review_required')
        self.assertEqual(len(proof['reviewWork']),1)
        self.assertEqual(proof['reviewWork'][0]['kind'],'candidate')
        self.assertEqual(proof['reviewWork'][0]['count'],1)
        self.assertEqual(proof['queueAccounting']['article']['total'],0)
        self.assertEqual(proof['discoveryEnd']['unfinishedWorkCompleted'],False)
        self.assertEqual(len(proof['deferredCandidates']),1)
        # The same URL with documented must-process evidence stays blocking.
        ledger[0]['mustProcess']=True
        guarded=assess_coverage(registry,'az',inventory,cutoff,ledger=ledger,observed_at=stamp)
        self.assertEqual(guarded['state'],'blocked')
        self.assertEqual(len(guarded['pendingWork']),1)
        self.assertEqual(guarded['pendingWork'][0]['url'],directory)

    def test_real_directory_is_review_not_completion(self):
        work={'sourceId':'uz-central-bank-uzbekistan','kind':'article','url':'https://cbu.uz/ru/credit-organizations/banks/','reason':'discovered_article_needs_body_or_review'}
        self.assertEqual(bounded_review_reason(work,{},'2026-11-23T06:00:00+08:00'),'publisher_directory_requires_coverage_review')
        self.assertIsNone(bounded_review_reason({**work,'important':True},{},'2026-11-23T06:00:00+08:00'))
        specific={**work,'url':'https://economy.gov.az/az/page/elanlar/new-investment-contract'}
        self.assertIsNone(bounded_review_reason(specific,{'candidate':{'title':'New investment contract'}},'2026-11-23T06:00:00+08:00'))

    def test_nov24_static_reference_routes_are_review_not_block(self):
        # Actual public publisher URL shapes from the Nov 24 frozen queue.
        # These cases exercise the production bounded_review_reason directly;
        # they must remain pending independent coverage review, not closed.
        directories = [
            ('uz-central-bank-uzbekistan','https://cbu.uz/ru/credit-organizations/banks/branches/'),
            ('uz-central-bank-uzbekistan','https://cbu.uz/ru/credit-organizations/banks/exchange-offices/'),
            ('uz-central-bank-uzbekistan','https://cbu.uz/ru/financial-stability/macroprudential-policy-tools/buffer-for-systemically-important-banks/'),
            ('uz-central-bank-uzbekistan','https://cbu.uz/ru/monetary-policy/refinancing-rate/'),
            ('uz-central-bank-uzbekistan','https://cbu.uz/ru/services/regulations/'),
            ('uz-central-bank-uzbekistan','https://cbu.uz/ru/statistics/credit/'),
            ('az-ministry-economy-azerbaijan','https://economy.gov.az/az/page/iqtisadiyyat/investisiya'),
            ('az-ministry-economy-azerbaijan','https://economy.gov.az/az/page/itm'),
            ('az-state-customs-committee-azerbaijan','https://customs.gov.az/az/faydali/Sat%C4%B1nalmalar/tender'),
            ('uz-tax-committee-uzbekistan','https://gov.uz/ru/soliq/pages/soliq-qo-mitasi-faoliyat-sohasi'),
            ('uz-uzdaily','https://www.uzdaily.uz/ru/special-projects/islamic-finance-2026/'),
            ('tj-sputnik-tajikistan','https://sputnik.tj/telegram_export/'),
        ]
        for source_id,url in directories:
            work={'sourceId':source_id,'kind':'article','url':url,'reason':'discovered_article_needs_body_or_review'}
            with self.subTest(url=url):
                self.assertEqual(bounded_review_reason(work,{},'2026-11-24T06:00:00+08:00'),
                                 'publisher_directory_requires_coverage_review')
                # Explicitly identified important live work cannot be downgraded.
                self.assertIsNone(bounded_review_reason({**work,'mustProcess':True},{},
                                  '2026-11-24T06:00:00+08:00'))

    def test_nov24_actual_news_stays_blocking(self):
        important_stories=[
            'https://economy.gov.az/az/post/3726/cinde-transxezer-beynelxalq-neqliyyat-dehlizi-uzre-senaye-ve-investisiya-emekdasligi-imkanlari-muzakire-edilib',
            'https://khovar.tj/rus/2026/11/iz-za-prostoya-predpriyatiya-hishti-tadzhikabad-zhiteli-zavozyat-stroitelnye-materialy-iz-dushanbe-i-rajona-vahdat-po-vysokoj-tsene/',
            'https://cbu.uz/ru/financial-stability/report/new-energy-policy-announcement/',
        ]
        for url in important_stories:
            work={'sourceId':'observed','kind':'article','url':url,
                  'reason':'discovered_article_needs_body_or_review','important':True}
            with self.subTest(url=url):
                self.assertIsNone(bounded_review_reason(work,{},'2026-11-24T06:00:00+08:00'))

    def test_nov24_dashed_date_archive_hint_never_overrules_important_headline(self):
        old='https://kz.kursiv.media/2026-05-19/mlmr-samyj-zhivopisnyj-obshhestvennyj-transport-kazahstana-pervye-kadry-rabotayushhego-lrt/'
        lead={'sourceId':'kz-kursiv-kazakhstan','kind':'lead','url':old,
              'reason':'unprocessed_original_lead'}
        self.assertEqual(bounded_review_reason(lead,{},'2026-11-24T06:00:00+08:00'),
                         'archive_url_discovery_requires_coverage_review')
        self.assertIsNone(bounded_review_reason(lead,{'lead':{'title':'Major energy investment agreement'}},
                                              '2026-11-24T06:00:00+08:00'))
        self.assertIsNone(bounded_review_reason({**lead,'important':True},{},'2026-11-24T06:00:00+08:00'))
        current='https://kz.kursiv.media/2026-11-23/new-investment-agreement/'
        self.assertIsNone(bounded_review_reason({**lead,'url':current},{},'2026-11-24T06:00:00+08:00'))

    def test_important_current_lead_not_cleared(self):
        work={'sourceId':'tj-khovar','kind':'lead','url':'https://khovar.tj/rus/2026/11/iz-za-prostoya-predpriyatiya-hishti-tadzhikabad-zhiteli-zavozyat-stroitelnye-materialy-iz-dushanbe-i-rajona-vahdat-po-vysokoj-tsene/','reason':'unprocessed_original_lead'}
        self.assertIsNone(bounded_review_reason(work,{},'2026-11-23T06:00:00+08:00'))
        self.assertIsNone(bounded_review_reason(work,{'lead':{'mustProcess':True}},'2026-11-23T06:00:00+08:00'))

    def test_no_legacy_credential_fallback(self):
        with patch.dict('os.environ',{'INGEST_SECRET':'unit-only','CENTRAL_ASIA_PLAN_B_URL':'https://unit.example'},clear=True):
            with self.assertRaisesRegex(ValueError,'protected_ingest_secret_missing'):protected_connection()
            with self.assertRaisesRegex(ValueError,'private_credential_contract_disabled'):protected_connection(Path('unused'))

    def test_connector_queries_are_scoped_and_bounded(self):
        key='sample/'+'a'*64+'/'+'b'*64
        self.assertIn("country='kz'",sql('originals','2026-11-24','kz',ids=[key]))
        with self.assertRaises(ValueError):sql('originals','2026-11-24','kz',ids=[key]*6)
        self.assertNotIn('INGEST_SECRET',sql('health','2026-11-24'))
        doc={'document':{'authorDraft':[{'id':'a'}],'reviewed':[{'id':'b'}]},'stage':'review','snapshotHash':'c'*64}
        doc['checkpointHash']=digest(doc['document'])
        query=sql('checkpoint','2026-11-24','kz',document=doc)
        self.assertIn('on conflict do nothing',query);self.assertIn('authorDraft',query);self.assertIn('reviewed',query)

if __name__=='__main__':unittest.main()
