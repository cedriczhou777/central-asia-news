import copy,unittest
from datetime import datetime
from finalize_writer_handoff import finalize,digest
from test_work_quantity import fixture

class HandoffIdentity(unittest.TestCase):
    def setUp(self):
        self.now=datetime.fromisoformat('2026-11-15T10:00:00+08:00')
        self.article={'id':'fixture01','title':'Synthetic fixture','body':'Synthetic fixture, not news.','category':'fixture','source':'fixture','source_url':'https://example.com/fixture','original_full_text':'Synthetic fixture, not news.','timeEvidence':'fixture only','firstPublicationCheck':'fixture only','published_at':'2026-11-14T12:00:00+08:00','imageUnavailableReason':'fixture has no image'}
        self.draft={'issueDate':'2026-11-15','country':'KG','writerRun':'fixture-author','windowStart':'2026-11-14T06:00:00+08:00','windowEnd':'2026-11-15T06:00:00+08:00','coverageShortfallExplanation':'fixture only','articles':[self.article]}
        self.audit=[{'url':'https://example.com/','kind':'listing','status':200,'contentValidated':True,'fetchedAt':'2026-11-15T06:01:00+08:00'}]
    def test_cross_stage_country_identity_and_article_hash(self):
        original=digest(self.draft['articles'])
        d=finalize(self.draft,self.audit,self.now)
        self.assertEqual((d['country'],d['stage'],d['bodyHash']),('kg','drafted',original))
        self.assertFalse(d['review']['independentReviewCompleted'])
    def test_missing_author_cannot_reach_independent_handoff(self):
        self.draft.pop('writerRun')
        with self.assertRaises(AssertionError):finalize(self.draft,self.audit,self.now)
    def test_missing_category_cannot_reach_builder_then_fail_gate(self):
        self.article.pop('category')
        with self.assertRaises(AssertionError):finalize(self.draft,self.audit,self.now)
    def test_unknown_country_rejected(self):
        self.draft['country']='tm'
        with self.assertRaises(AssertionError):finalize(self.draft,self.audit,self.now)
    def test_early_scheduler_cannot_claim_future_cutoff(self):
        now=datetime.fromisoformat('2026-11-15T05:55:00+08:00')
        self.audit[0]['fetchedAt']='2026-11-15T05:54:00+08:00'
        d=finalize(self.draft,self.audit,now)
        self.assertEqual(d['stage'],'precollected')
        self.assertEqual(d['coverageEnd'],'2026-11-15T05:54:00+08:00')
    def test_after_cutoff_requires_real_new_scan(self):
        self.audit[0]['fetchedAt']='2026-11-15T05:59:00+08:00'
        with self.assertRaises(AssertionError):finalize(self.draft,self.audit,self.now)
    def test_arbitrary_shortfall_is_pre_review_only(self):
        self.draft['coverageShortfallExplanation']='No more news, everything checked'
        d=finalize(self.draft,self.audit,self.now)
        self.assertTrue(d['manuscriptReady'])
        self.assertTrue(d['writerHandoffComplete'])
        self.assertFalse(d['quantityReady'])
        self.assertFalse(d['qualityDeliveryComplete'])
        self.assertTrue(d['shortfallOpen'])
        self.assertFalse(d['sourceCoverage']['complete'])
        self.assertFalse(d['candidateLedgerValidation']['complete'])
    def test_short_draft_without_explanation_can_still_get_useful_pre_review(self):
        self.draft.pop('coverageShortfallExplanation')
        d=finalize(self.draft,self.audit,self.now)
        self.assertTrue(d['manuscriptReady'])
        self.assertEqual(d['quantityStatus'],'needs_expansion')
    def test_quantity_and_other_review_issues_do_not_disappear(self):
        issues=[{'status':'open','issue':'Original six-article shortfall requires continued expansion'},
                {'status':'open','issue':'Original unresolved factual question'}]
        review_issues=[{'status':'open','issue':'Independent reviewer original wording'}]
        self.draft['issues']=copy.deepcopy(issues)
        self.draft['review']={'independentReviewCompleted':True,'reviewer':'old-reviewer','issues':copy.deepcopy(review_issues)}
        d=finalize(self.draft,self.audit,self.now)
        self.assertEqual(d['issues'],issues)
        self.assertEqual(d['review']['issues'],review_issues)
        self.assertFalse(d['review']['independentReviewCompleted'])
    def test_full_target_can_pass_quantity_without_claiming_independent_review(self):
        sample,audit,now=fixture()
        for article in sample['articles']:
            article.update({k:v for k,v in self.article.items() if k not in ('id','source_url')})
        sample.update(windowStart=self.draft['windowStart'],windowEnd=self.draft['windowEnd'])
        d=finalize(sample,audit,now)
        self.assertTrue(d['quantityReady'])
        self.assertFalse(d['qualityDeliveryComplete'])
        self.assertFalse(d['shortfallOpen'])

if __name__=='__main__':unittest.main()
