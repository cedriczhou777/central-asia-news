import importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('stage_images',Path(__file__).with_name('stage-reviewed-images.py'))
stage=importlib.util.module_from_spec(spec);spec.loader.exec_module(stage)
class Clock:
    value=0
    def now(self):return self.value
    def pause(self,seconds):self.value+=seconds
class Readiness(unittest.TestCase):
    def setUp(self):self.clock=Clock();self.calls=[]
    def check(self,api,seconds=180):return stage.wait_for_private_service(api,seconds,self.clock.now,self.clock.pause)
    def test_cold_service_recovers_before_any_upload(self):
        def api(method,path,**kwargs):
            self.calls.append((method,path));self.assertEqual(method,'GET');self.assertEqual(kwargs['attempts'],1)
            if len(self.calls)<3:raise stage.ImageServiceError(503)
            return {'ok':True,'images':{'ready':True,'private':True}}
        r=self.check(api);self.assertEqual(r['attempts'],3);self.assertEqual(self.clock.value,10)
    def test_auth_denial_is_never_retried(self):
        def api(*args,**kwargs):self.calls.append(args);raise stage.ImageServiceError(403)
        with self.assertRaises(stage.ImageServiceError):self.check(api)
        self.assertEqual(len(self.calls),1);self.assertEqual(self.clock.value,0)
    def test_readiness_wait_has_a_real_deadline(self):
        def api(*args,**kwargs):self.calls.append(args);raise stage.ImageServiceError(503)
        with self.assertRaisesRegex(ValueError,'timed out'):self.check(api,12)
        self.assertEqual(self.clock.value,12);self.assertEqual(len(self.calls),3)
    def test_nonprivate_storage_is_rejected_before_upload(self):
        def api(*args,**kwargs):self.calls.append(args);return {'ok':True,'images':{'ready':True,'private':False}}
        with self.assertRaisesRegex(ValueError,'not private'):self.check(api)
        self.assertEqual(len(self.calls),1);self.assertEqual(self.clock.value,0)
    def test_http_200_transient_health_recovers_before_upload(self):
        for kind in ('network','timeout','service_unavailable'):
            with self.subTest(kind=kind):
                self.calls=[];self.clock=Clock()
                def api(method,path,**kwargs):
                    self.calls.append((method,path));self.assertEqual(method,'GET')
                    if len(self.calls)==1:return {'ok':True,'images':{'ready':False,'private':False,'retryable':True,'failureKind':kind}}
                    return {'ok':True,'images':{'ready':True,'private':True}}
                result=self.check(api);self.assertEqual(result['attempts'],2);self.assertEqual(self.clock.value,5)
    def test_http_200_hard_failures_are_not_retried(self):
        for kind in ('authorization','configuration','public_bucket','not_found','rate_limited','unavailable'):
            with self.subTest(kind=kind):
                self.calls=[];self.clock=Clock()
                def api(*args,**kwargs):
                    self.calls.append(args)
                    return {'ok':True,'images':{'ready':False,'private':False,'retryable':False,'failureKind':kind}}
                with self.assertRaisesRegex(ValueError,'not private'):self.check(api)
                self.assertEqual(len(self.calls),1);self.assertEqual(self.clock.value,0)
    def test_transient_health_requires_an_explicit_allowed_reason(self):
        for images in ({'ready':False,'private':False},
                       {'ready':False,'private':False,'retryable':True,'failureKind':'public_bucket'},
                       {'ready':True,'private':False,'retryable':True,'failureKind':'network'}):
            with self.subTest(images=images):
                self.calls=[];self.clock=Clock()
                def api(*args,**kwargs):self.calls.append(args);return {'ok':True,'images':images}
                with self.assertRaises(ValueError):self.check(api)
                self.assertEqual(len(self.calls),1);self.assertEqual(self.clock.value,0)
    def test_http_200_transient_wait_uses_the_total_deadline(self):
        def api(*args,**kwargs):
            self.calls.append(args)
            return {'ok':True,'images':{'ready':False,'private':False,'retryable':True,'failureKind':'service_unavailable'}}
        with self.assertRaisesRegex(ValueError,'timed out'):self.check(api,12)
        self.assertEqual(self.clock.value,12);self.assertEqual(len(self.calls),3)
if __name__=='__main__':unittest.main()
