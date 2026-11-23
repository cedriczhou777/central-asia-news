"""Bounded regression over retained Nov22 samples and all 269 Nov23 pending URLs."""
import json,sys,unittest,os
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'ops/plan-b'))
from news_queue_policy import bounded_review_reason
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

    def test_real_directory_is_review_not_completion(self):
        work={'sourceId':'uz-central-bank-uzbekistan','kind':'article','url':'https://cbu.uz/ru/credit-organizations/banks/','reason':'discovered_article_needs_body_or_review'}
        self.assertEqual(bounded_review_reason(work,{},'2026-11-23T06:00:00+08:00'),'publisher_directory_requires_coverage_review')
        self.assertIsNone(bounded_review_reason({**work,'important':True},{},'2026-11-23T06:00:00+08:00'))
        specific={**work,'url':'https://economy.gov.az/az/page/elanlar/new-investment-contract'}
        self.assertIsNone(bounded_review_reason(specific,{'candidate':{'title':'New investment contract'}},'2026-11-23T06:00:00+08:00'))

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
