import gzip,hashlib,json,tempfile,unittest,zlib
from pathlib import Path
from datetime import datetime,timedelta,timezone
from unittest.mock import patch
from urllib.error import HTTPError
import fetch_work_sources as f

PAGE=('<!doctype html><html><head><meta property="og:title" content="Actual title"><meta property="og:type" content="article"></head><body><svg><h1>Wrong SVG title</h1></svg><article><h1>Article heading</h1><p>'+('Synthetic fixture content, not news. '*12)+'</p></article></body></html>').encode()
class Response:
    status=200;url='https://example.com/story';headers={}
    def __enter__(self):return self
    def __exit__(self,*a):pass
    def read(self,*a):return PAGE

class SourceRegressions(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.p=patch.object(f,'S',Path(self.tmp.name));self.p.start()
    def tearDown(self):self.p.stop();self.tmp.cleanup()
    def parse(self,b,h=None):return f.parse_response('https://example.com/story','https://example.com/story',b,h or {})
    def test_gzip_transport_is_decoded(self):self.assertTrue(self.parse(gzip.compress(PAGE),{'content-encoding':'gzip'})['contentValidated'])
    def test_deflate_transport_is_decoded(self):self.assertIn('Synthetic fixture',self.parse(zlib.compress(PAGE),{'content-encoding':'deflate'})['text'])
    def test_identity_transport_is_readable(self):self.assertEqual(self.parse(PAGE)['source_kind'],'article')
    def test_binary_200_is_not_valid_article(self):
        with self.assertRaises(ValueError):self.parse(b'\x00\xffrandom binary')
    def test_metadata_title_wins_over_svg_heading(self):self.assertEqual(self.parse(PAGE)['title'],'Actual title')
    def cached(self,url,kind,age=3600,status=200):
        key=hashlib.sha256(url.encode()).hexdigest()[:18]
        d={'url':url,'status':status,'key':key,'parser_version':f.PARSER_VERSION,'source_kind':kind,'contentValidated':status==200,'fetchedAt':(datetime.now(timezone.utc)-timedelta(seconds=age)).isoformat(),'title':'cached'}
        (f.S/(key+'.json')).write_text(json.dumps(d));return d
    def test_stale_listing_is_really_refetched(self):
        url='https://example.com/';self.cached(url,'listing',age=901)
        with patch.object(f.urllib.request,'urlopen',return_value=Response()) as request:r=f.fetch(url)
        self.assertEqual(request.call_count,1);self.assertEqual(r['title'],'Actual title')
    def test_article_evidence_is_reused(self):
        url='https://example.com/story';self.cached(url,'article')
        with patch.object(f.urllib.request,'urlopen',side_effect=AssertionError('must not refetch unchanged article')):self.assertEqual(f.fetch(url)['title'],'cached')
    def test_transient_503_gets_bounded_retry(self):
        url='https://example.com/story';error=lambda:HTTPError(url,503,'unavailable',{},None)
        with patch.object(f.urllib.request,'urlopen',side_effect=[error(),error(),Response()]) as request,patch.object(f.time,'sleep'):
            r=f.fetch(url)
        self.assertEqual((r['status'],r['attempts'],request.call_count),(200,3,3));self.assertNotIn('error',r)
    def test_403_is_recorded_and_never_retried(self):
        url='https://example.com/forbidden'
        with patch.object(f.urllib.request,'urlopen',side_effect=HTTPError(url,403,'denied',{},None)) as request,patch.object(f.time,'sleep'):
            a=f.fetch(url);b=f.fetch(url)
        self.assertEqual((a['status'],b['status'],request.call_count),(403,403,1))

if __name__=='__main__':unittest.main()
