import copy,unittest
from datetime import datetime
from finalize_writer_handoff import finalize,digest

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

if __name__=='__main__':unittest.main()
