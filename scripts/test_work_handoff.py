import copy,hashlib,io,json,tempfile,unittest
from datetime import datetime
from pathlib import Path
from PIL import Image
from finalize_writer_handoff import finalize,digest,restore_image_paths
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

class RestoredImageHandoff(unittest.TestCase):
    def setUp(self):
        fixture=HandoffIdentity();fixture.setUp()
        self.draft,self.audit,self.now=fixture.draft,fixture.audit,fixture.now
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)/'restored'
        (self.root/'images').mkdir(parents=True)
        buffer=io.BytesIO();Image.new('RGB',(2,2),(30,80,120)).save(buffer,format='PNG')
        self.data=buffer.getvalue();self.sha=hashlib.sha256(self.data).hexdigest()
        self.path=self.root/'images'/self.sha;self.path.write_bytes(self.data)
        self.entry=self.draft['articles'][0]
        self.entry.update(image_url='https://example.com/photo.png',image_sha256=self.sha,image_bytes=len(self.data),
                          image_local_path='/expired/producer/images/'+self.sha,imageReviewCompleted=True,
                          image_caption='Synthetic original image fixture, not news')
        self.manifest={'images':[{'url':self.entry['image_url'],'sha256':self.sha,'bytes':len(self.data),
                                  'path':'images/'+self.sha}]}
        self.save_manifest()

    def tearDown(self):self.temp.cleanup()
    def save_manifest(self):(self.root/'manifest.json').write_text(json.dumps(self.manifest))

    def test_restored_paths_rebind_with_explicit_hash_change_and_no_editorial_change(self):
        original=copy.deepcopy(self.entry);before=digest(self.draft['articles'])
        self.draft['review']={'independentReviewCompleted':True,'reviewer':'previous-independent','originalHash':before,'issues':[]}
        result=finalize(self.draft,self.audit,self.now,image_root=self.root)
        receipt=result['imagePathRestore']
        self.assertEqual(self.entry['image_local_path'],str(self.path.resolve()))
        self.assertEqual({k:v for k,v in self.entry.items() if k!='image_local_path'},
                         {k:v for k,v in original.items() if k!='image_local_path'})
        self.assertEqual(receipt['previousHandoffHash'],before)
        self.assertEqual(receipt['restoredHandoffHash'],result['bodyHash'])
        self.assertNotEqual(result['bodyHash'],before)
        self.assertTrue(receipt['reviewRebindingRequired'])
        self.assertFalse(receipt['editorialContentChanged'])
        self.assertFalse(result['review']['independentReviewCompleted'])
        self.assertIsNone(result['review']['reviewer'])
        self.assertEqual(result['review']['originalHash'],before,'never silently rewrite an old independent review hash')

    def test_old_manifest_absolute_images_path_is_rebased_only_inside_extracted_root(self):
        self.manifest['images'][0]['path']='/old/author/session/images/'+self.sha;self.save_manifest()
        receipt=restore_image_paths(self.draft,self.root,self.now)
        self.assertEqual(self.entry['image_local_path'],str(self.path.resolve()))
        self.assertTrue(receipt['reviewRebindingRequired'])
        second=restore_image_paths(self.draft,self.root,self.now)
        self.assertEqual(second['reboundImages'],0)
        self.assertFalse(second['reviewRebindingRequired'])

    def test_byte_or_manifest_mismatch_rejected_before_any_path_is_rebound(self):
        original=self.entry['image_local_path']
        self.path.write_bytes(self.data+b'corrupt')
        with self.assertRaisesRegex(ValueError,'byte identity mismatch'):restore_image_paths(self.draft,self.root,self.now)
        self.assertEqual(self.entry['image_local_path'],original)
        self.path.write_bytes(self.data)
        for field,value in [('url','https://example.com/another-photo.png'),('sha256','0'*64),('bytes',len(self.data)+1)]:
            with self.subTest(field=field):
                item=self.manifest['images'][0];prior=item[field];item[field]=value;self.save_manifest()
                with self.assertRaisesRegex(ValueError,'does not match'):restore_image_paths(self.draft,self.root,self.now)
                self.assertEqual(self.entry['image_local_path'],original)
                item[field]=prior

    def test_traversal_external_absolute_and_symlink_are_rejected(self):
        for value in ('../outside.png','images/../photo.png','/etc/passwd','images\\photo.png'):
            with self.subTest(path=value):
                self.manifest['images'][0]['path']=value;self.save_manifest()
                with self.assertRaises(ValueError):restore_image_paths(self.draft,self.root,self.now)
        self.manifest['images'][0]['path']='images/'+self.sha;self.save_manifest()
        outside=Path(self.temp.name)/'outside.png';outside.write_bytes(self.data)
        self.path.unlink();self.path.symlink_to(outside)
        with self.assertRaisesRegex(ValueError,'symlink'):restore_image_paths(self.draft,self.root,self.now)

    def test_restore_never_invents_existing_byte_proofs_or_visual_review(self):
        self.entry.pop('image_sha256')
        with self.assertRaisesRegex(ValueError,'existing adopted image hash/length'):restore_image_paths(self.draft,self.root,self.now)
        self.entry['image_sha256']=self.sha;self.entry.pop('imageReviewCompleted')
        with self.assertRaisesRegex(AssertionError,'actual author visual review'):finalize(self.draft,self.audit,self.now,image_root=self.root)
        self.assertNotIn('imageReviewCompleted',self.entry)

if __name__=='__main__':unittest.main()
