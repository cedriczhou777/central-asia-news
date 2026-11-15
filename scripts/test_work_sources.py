import gzip,hashlib,json,subprocess,sys,tempfile,unittest,zlib
from pathlib import Path
from datetime import datetime,timedelta,timezone
from unittest.mock import patch
from urllib.error import HTTPError
import fetch_work_sources as f

PAGE=('<!doctype html><html><head><meta property="og:title" content="Actual title"><meta property="og:type" content="article"></head><body><svg><h1>Wrong SVG title</h1></svg><article><h1>Actual title</h1><p>'+('Synthetic fixture content, not news. '*12)+'</p></article></body></html>').encode()
class Response:
    status=200;url='https://example.com/story';headers={}
    def __enter__(self):return self
    def __exit__(self,*a):pass
    def read(self,*a):return PAGE
class ListingResponse(Response):url='https://example.com/'
class CutoffClock(datetime):
    @classmethod
    def now(cls,tz=None):return datetime.fromisoformat('2026-11-16T06:10:00+08:00').astimezone(tz or timezone.utc)

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
    def cached(self,url,kind,age=3600,status=200,fetched_at=None):
        key=hashlib.sha256(url.encode()).hexdigest()[:18]
        d={'url':url,'status':status,'key':key,'parser_version':f.PARSER_VERSION,'source_kind':kind,'contentValidated':status==200,'fetchedAt':fetched_at or (datetime.now(timezone.utc)-timedelta(seconds=age)).isoformat(),'title':'cached'}
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
    def test_cutoff_listing_bypasses_still_young_pre_cutoff_cache(self):
        url='https://example.com/';self.cached(url,'listing',fetched_at='2026-11-16T05:59:00+08:00')
        with patch.object(f,'datetime',CutoffClock),patch.object(f.urllib.request,'urlopen',return_value=ListingResponse()) as request:
            r=f.fetch(url,'2026-11-16T06:00:00+08:00')
        self.assertEqual(request.call_count,1)
        self.assertEqual(r['fetchedAt'],'2026-11-15T22:10:00+00:00','record actual request time, not the requested cutoff')
        self.assertEqual(r['source_kind'],'listing');self.assertTrue(r['contentValidated'])
    def test_cutoff_listing_reuses_real_post_cutoff_cache(self):
        url='https://example.com/';old=self.cached(url,'listing',fetched_at='2026-11-16T06:04:00+08:00')
        with patch.object(f,'datetime',CutoffClock),patch.object(f.urllib.request,'urlopen') as request:r=f.fetch(url,'2026-11-16T06:00:00+08:00')
        self.assertEqual(request.call_count,0);self.assertEqual(r['fetchedAt'],old['fetchedAt'])
    def test_listing_minimum_does_not_refetch_frozen_article(self):
        url='https://example.com/story';old=self.cached(url,'article',fetched_at='2026-11-16T05:00:00+08:00')
        with patch.object(f,'datetime',CutoffClock),patch.object(f.urllib.request,'urlopen') as request:r=f.fetch(url,'2026-11-16T06:00:00+08:00')
        self.assertEqual(request.call_count,0);self.assertEqual(r['fetchedAt'],old['fetchedAt'])
    def test_failed_cutoff_refresh_never_returns_old_success(self):
        url='https://example.com/';self.cached(url,'listing',fetched_at='2026-11-16T05:59:00+08:00')
        with patch.object(f,'datetime',CutoffClock),patch.object(f.urllib.request,'urlopen',side_effect=HTTPError(url,503,'unavailable',{},None)) as request,patch.object(f.time,'sleep'):
            r=f.fetch(url,'2026-11-16T06:00:00+08:00')
        self.assertEqual(request.call_count,3);self.assertEqual(r['status'],503);self.assertFalse(r['contentValidated']);self.assertNotIn('source_kind',r)
    def test_invalid_listing_minimum_is_rejected_before_fetch(self):
        for minimum in ('2026-11-16T06:00:00','2026-11-16T06:10:01+08:00','not-a-date','',42):
            with self.subTest(minimum=minimum),patch.object(f,'datetime',CutoffClock),patch.object(f.urllib.request,'urlopen') as request:
                with self.assertRaises(ValueError):f.fetch('https://example.com/',minimum)
                self.assertEqual(request.call_count,0)
    def test_listing_minimum_does_not_retry_cached_denial(self):
        url='https://example.com/';old=self.cached(url,'listing',status=403,fetched_at='2026-11-16T05:59:00+08:00')
        with patch.object(f,'datetime',CutoffClock),patch.object(f.urllib.request,'urlopen') as request:r=f.fetch(url,'2026-11-16T06:00:00+08:00')
        self.assertEqual(request.call_count,0);self.assertEqual(r['status'],403);self.assertEqual(r['fetchedAt'],old['fetchedAt'])
    def test_cli_rejects_naive_cutoff_before_reading_input(self):
        r=subprocess.run([sys.executable,str(Path(f.__file__)),'--listing-not-before','2026-11-16T06:00:00'],input='not-json',text=True,capture_output=True,timeout=5)
        self.assertEqual(r.returncode,2);self.assertIn('listing-not-before requires a timezone-aware ISO timestamp',r.stderr)

class PublicationEvidenceRegressions(unittest.TestCase):
    def page(self,ld=None,head='',body='',lang='ru'):
        script='<script type="application/ld+json">'+json.dumps(ld,ensure_ascii=False)+'</script>' if ld is not None else ''
        return ('<!doctype html><html lang="'+lang+'"><head>'+head+script+'</head><body><article><h1>Current story</h1><p>'+('Fixture content, not news. '*12)+'</p>'+body+'</article></body></html>').encode()
    def parse(self,page,url='https://example.com/story',final=None):return f.parse_response(url,final or url,page,{})
    def test_graph_prioritizes_bound_article_and_excludes_recommendations(self):
        current={'@type':['Thing','NewsArticle'],'mainEntityOfPage':{'@id':'https://example.com/story/'},'datePublished':'2026-11-14T11:00:00+05:00','dateModified':'2026-11-15T08:00:00+05:00'}
        other={'@type':'NewsArticle','url':'https://example.com/other','datePublished':'2026-11-15T09:00:00+05:00'}
        r=self.parse(self.page({'@graph':[other,current]},'<meta property="article:published_time" content="2026-11-14T11:01:00+05:00">'))
        self.assertEqual(r['publicationEvidence'][0]['raw'],current['datePublished'])
        self.assertEqual(r['publicationEvidence'][0]['articleUrl'],'https://example.com/story')
        self.assertEqual(r['publicationEvidence'][0]['precision'],'seconds')
        self.assertEqual(r['publicationEvidence'][0]['timezoneEvidence'],'explicit')
        self.assertNotIn(other['datePublished'],[x['raw'] for x in r['publicationEvidence']])
        self.assertEqual(r['excludedPublicationEvidence'][0]['raw'],other['datePublished'])
        self.assertIn(other['datePublished'],r['linked_data'][0],'original JSON-LD is retained')
        self.assertTrue(any(x['kind']=='modified' for x in r['publicationEvidence']))
        self.assertNotIn('firstPublication',r)
    def test_mismatched_and_unidentified_articles_do_not_supply_current_time(self):
        nodes=[{'@type':'Article','mainEntityOfPage':'https://example.com/recommended','datePublished':'2026-11-15T09:00:00+05:00'},{'@type':'Article','datePublished':'2026-11-15T10:00:00+05:00'}]
        r=self.parse(self.page(nodes))
        self.assertEqual(r['publicationEvidence'],[])
        self.assertEqual(len(r['excludedPublicationEvidence']),2)
    def test_url_arrays_and_canonical_identity_bind_redirected_article(self):
        ld={'@type':'Article','url':['https://example.com/other','https://example.com/canonical#article'],'datePublished':'2026-11-14T11:00:00+05:00'}
        r=self.parse(self.page(ld,'<link rel="canonical" href="/canonical"><link rel="next" href="?page=2">'),final='https://example.com/redirected')
        self.assertEqual(r['final_url'],'https://example.com/redirected')
        self.assertEqual(r['canonical_url'],'https://example.com/canonical')
        self.assertEqual(r['html_lang'],'ru')
        self.assertEqual(r['page_links'][1]['url'],'https://example.com/redirected?page=2')
        self.assertEqual(r['publicationEvidence'][0]['articleUrl'],'https://example.com/canonical')
    def test_date_only_and_naive_time_never_gain_timezone_or_precision(self):
        for raw,precision in [('2026-11-14','date'),('2026-11-14T11:00','minutes'),('2026-11-14T11:00:00','seconds')]:
            with self.subTest(raw=raw):
                r=self.parse(self.page({'@type':'NewsArticle','url':'https://example.com/story','datePublished':raw}))
                e=r['publicationEvidence'][0]
                self.assertEqual((e['raw'],e['precision'],e['timezoneEvidence']),(raw,precision,'not_provided'))
    def test_modified_only_never_becomes_published(self):
        r=self.parse(self.page({'@type':'NewsArticle','url':'https://example.com/story','dateModified':'2026-11-14T11:00:00+05:00'},'<meta property="article:modified_time" content="2026-11-14T11:01:00+05:00">'))
        self.assertEqual(len(r['publicationEvidence']),2)
        self.assertTrue(all(x['kind']=='modified' for x in r['publicationEvidence']))
    def test_conflicting_current_article_evidence_is_preserved_without_selection(self):
        nodes=[{'@type':'NewsArticle','url':'https://example.com/story','datePublished':'2026-11-14T11:00:00+05:00'},{'@type':'Article','mainEntityOfPage':'https://example.com/story','datePublished':'2026-11-13T12:00:00+05:00'}]
        r=self.parse(self.page(nodes))
        self.assertEqual(len(r['publicationEvidence']),2)
        self.assertEqual([x['raw'] for x in r['publicationEvidence']],[x['datePublished'] for x in nodes])
    def test_listing_link_retains_its_card_time_not_other_card_time(self):
        page=('<!doctype html><html lang="tg"><body><main><p>'+('Listing fixture. '*12)+'</p><ul><li><a href="/one" rel="next">One</a><time datetime="2026-11-14T11:00:00+05:00">11:00</time></li><li><a href="/two">Two</a><time datetime="2026-11-13T09:00:00+05:00">Yesterday</time></li></ul></main></body></html>').encode()
        r=self.parse(page,url='https://example.com/')
        self.assertEqual(r['publicationEvidence'],[])
        self.assertEqual(r['links'][0]['nearbyTimes'],[{'text':'11:00','datetime':'2026-11-14T11:00:00+05:00'}])
        self.assertEqual(r['links'][1]['nearbyTimes'][0]['text'],'Yesterday')
        self.assertEqual(r['links'][0]['rel'],'next')
    def test_article_time_is_bound_but_nested_recommendation_time_is_not(self):
        body='<header><time itemprop="datePublished" datetime="2026-11-14T11:00:00+05:00">11:00</time></header><aside><article><a href="/other">Other</a><time datetime="2026-11-15T09:00:00+05:00">Other time</time></article></aside>'
        r=self.parse(self.page(head='<meta property="og:type" content="article">',body=body))
        self.assertEqual(len(r['time_tags']),2)
        self.assertEqual([x['raw'] for x in r['publicationEvidence']],['2026-11-14T11:00:00+05:00'])
    def test_listing_article_cards_do_not_supply_the_listing_publication_time(self):
        body='<time itemprop="datePublished" datetime="2026-11-14T11:00:00+05:00">11:00</time>'
        r=self.parse(self.page(body=body),url='https://example.com/')
        self.assertEqual(r['publicationEvidence'],[])
        self.assertEqual(r['time_tags'][0]['datetime'],'2026-11-14T11:00:00+05:00')
    def test_sibur_frozen_article_metadata_keeps_precise_publication_time(self):
        # Actual fields frozen in the 2026-11-15 source archive. Visible date-only
        # text must not clear the more precise, article-bound JSON-LD evidence.
        url='https://lsm.kz/sibur-pod-sanktsiiami-chto-eto-znachit-dlia-kazakhstana'
        ld=[{'@type':'WebSite','url':'https://lsm.kz'},{'@type':'NewsArticle','headline':'СИБУР под санкциями: что это значит для Казахстана','datePublished':'2026-11-14T11:00:00+05:00','dateModified':'2026-11-14T11:11:40+05:00','mainEntityOfPage':{'@type':'WebPage','@id':url}}]
        r=self.parse(self.page(ld,body='<p>14.11.2026</p>'),url=url)
        e=r['publicationEvidence'][0]
        self.assertEqual((e['raw'],e['precision'],e['timezoneEvidence']),('2026-11-14T11:00:00+05:00','seconds','explicit'))
    def test_reparse_v13_archive_preserves_fetch_time_and_adds_publication_evidence(self):
        url='https://example.com/story';key=hashlib.sha256(url.encode()).hexdigest()[:18]
        raw=self.page({'@type':'NewsArticle','url':url,'datePublished':'2026-11-14T11:00:00+05:00'})
        with tempfile.TemporaryDirectory() as tmp,patch.object(f,'S',Path(tmp)),patch.object(f.urllib.request,'urlopen') as request:
            old={'url':url,'final_url':url,'status':200,'parser_version':'source-html-v13','source_kind':'article','contentValidated':True,'fetchedAt':'2026-11-15T03:00:00+00:00'}
            (f.S/(key+'.json')).write_text(json.dumps(old));(f.S/(key+'.html.gz')).write_bytes(gzip.compress(raw))
            r=f.fetch(url)
        self.assertEqual(request.call_count,0)
        self.assertEqual(r['fetchedAt'],old['fetchedAt'])
        self.assertEqual(r['publicationEvidence'][0]['raw'],'2026-11-14T11:00:00+05:00')
        self.assertEqual(r['parser_version'],'source-html-v16')

class CharacterEncodingRegressions(unittest.TestCase):
    title='Суғд: иқтисод ва соҳибкорӣ'
    body='Хабарҳои Тоҷикистон барои соҳибкорон. '
    def page(self,charset='',encoding='utf-8'):
        # Legacy pages can encode unsupported Tajik letters as HTML entities.
        return ('<!doctype html><html lang="tg"><head>'+charset+'<title>'+self.title+'</title></head><body><article><h1>'+self.title+'</h1><p>'+self.body*12+'</p></article></body></html>').encode(encoding,errors='xmlcharrefreplace')
    def parse(self,raw,headers=None):return f.parse_response('https://example.com/story','https://example.com/story',raw,headers or {})
    def test_undeclared_unicode_utf8_never_becomes_latin1(self):
        r=self.parse(self.page())
        self.assertEqual(r['title'],self.title);self.assertIn(self.body,r['text'])
        self.assertEqual(r['decodedEncoding'],'utf-8')
        self.assertEqual(r['encodingEvidence']['selectedBy'],'valid_utf8_without_charset')
    def test_http_charset_decodes_real_windows1251(self):
        r=self.parse(self.page(encoding='windows-1251'),{'content-type':'text/html; charset="windows-1251"'})
        self.assertEqual(r['title'],self.title);self.assertEqual(r['decodedEncoding'],'cp1251')
    def test_meta_charset_and_legacy_http_equiv_are_respected(self):
        for meta in ['<meta charset="windows-1251">','<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">']:
            with self.subTest(meta=meta):
                r=self.parse(self.page(meta,encoding='windows-1251'))
                self.assertEqual(r['title'],self.title);self.assertEqual(r['encodingEvidence']['selectedBy'],'meta')
    def test_bom_precedes_wrong_declared_charset_and_preserves_conflict(self):
        r=self.parse(b'\xef\xbb\xbf'+self.page('<meta charset="utf-8">'),{'content-type':'text/html; charset=windows-1251'})
        self.assertEqual(r['title'],self.title);self.assertEqual(r['decodedEncoding'],'utf-8-sig')
        self.assertTrue(r['encodingEvidence']['declarationConflict'])
    def test_http_precedes_conflicting_meta_and_preserves_declarations(self):
        r=self.parse(self.page('<meta charset="utf-8">',encoding='windows-1251'),{'content-type':'text/html; charset=windows-1251'})
        self.assertEqual(r['title'],self.title);self.assertEqual(r['encodingEvidence']['selectedBy'],'http')
        self.assertTrue(r['encodingEvidence']['declarationConflict'])
    def test_wrong_declared_single_byte_charset_is_rejected_as_mojibake(self):
        with self.assertRaisesRegex(ValueError,'HTML_mojibake_detected_encoding_iso8859-1'):
            self.parse(self.page('<meta charset="utf-8">'),{'content-type':'text/html; charset=iso-8859-1'})
    def test_wrong_cyrillic_charset_is_not_silently_validated(self):
        # Russian UTF-8 decoded as CP1251 produces the equally broken Р/С form.
        with self.assertRaisesRegex(ValueError,'HTML_mojibake_detected_encoding_cp1251'):
            self.parse(self.page('<meta charset="utf-8">'),{'content-type':'text/html; charset=windows-1251'})
    def test_already_mojibake_utf8_is_not_validated(self):
        broken=self.page().decode('latin1').encode('utf-8')
        with self.assertRaisesRegex(ValueError,'HTML_mojibake_detected'):self.parse(broken)
    def test_compressed_undeclared_unicode_is_decoded(self):
        for encoding,raw in [('gzip',gzip.compress(self.page())),('deflate',zlib.compress(self.page()))]:
            with self.subTest(encoding=encoding):self.assertEqual(self.parse(raw,{'content-encoding':encoding})['title'],self.title)
    def test_mojibake_fetch_fails_validation_without_retry_or_silent_success(self):
        raw=self.page().decode('latin1').encode('utf-8')
        class BrokenResponse(Response):
            def read(self,*a):return raw
        with tempfile.TemporaryDirectory() as tmp,patch.object(f,'S',Path(tmp)),patch.object(f.urllib.request,'urlopen',return_value=BrokenResponse()) as request:
            r=f.fetch('https://example.com/story')
        self.assertEqual(request.call_count,1);self.assertFalse(r['contentValidated'])
        self.assertIn('HTML_mojibake_detected',r['error'])
        self.assertEqual(r['decodedEncoding'],'utf-8')
        self.assertEqual(r['encodingEvidence']['selectedBy'],'valid_utf8_without_charset')

class InstitutionArticleIdentityRegressions(unittest.TestCase):
    prose=('Synthetic institution fixture: businesses can read this complete explanatory notice, with its stated scope and implementation details. '*4)
    def article(self,body=None,date='<time itemprop="datePublished" datetime="2026-11-14T11:00:00+05:00">14.11.2026</time>'):
        return '<article><h1>Institution business notice</h1>'+date+'<p>'+(self.prose if body is None else body)+'</p></article>'
    def parse(self,body,path='/institution/notice-123'):
        raw=('<!doctype html><html lang="ru"><body>'+body+'</body></html>').encode()
        url='https://example.com'+path
        return f.parse_response(url,url,raw,{})
    def test_complete_single_institution_article_without_metadata_is_retained(self):
        r=self.parse(self.article())
        self.assertEqual(r['source_kind'],'article');self.assertTrue(r['contentValidated'])
        self.assertEqual(r['sourceKindEvidence'][0]['basis'],'single_article_heading_prose_and_date')
        self.assertEqual(r['publicationEvidence'][0]['raw'],'2026-11-14T11:00:00+05:00')
        self.assertNotIn('articleIdentityReviewCompleted',r,'structural evidence is not a manual review verdict')
    def test_explicit_title_publication_badge_without_time_element_is_evidence(self):
        r=self.parse(self.article(date='<span class="publication-date">2026-11-14T11:00:00+05:00</span>'))
        self.assertEqual(r['source_kind'],'article')
        self.assertEqual(r['publicationEvidence'][0]['kind'],'published')
        self.assertEqual(r['publicationEvidence'][0]['timezoneEvidence'],'explicit')
    def test_multiple_linked_cards_never_become_one_article(self):
        cards=''.join('<article><h1><a href="/news/'+str(i)+'">Card '+str(i)+'</a></h1><time datetime="2026-11-14T11:00:00+05:00">11:00</time><p>'+('Card summary. '*8)+'</p></article>' for i in range(3))
        r=self.parse(cards,path='/institution/latest-notices')
        self.assertEqual(r['source_kind'],'listing');self.assertEqual(r['publicationEvidence'],[])
    def test_category_segment_in_real_article_path_does_not_force_listing(self):
        r=self.parse(self.article(),path='/category/tax/business-notice-123')
        self.assertEqual(r['source_kind'],'article')
    def test_home_and_section_feature_cards_stay_listings(self):
        for path in ['/','/ru','/category/tax','/category/tax/page/2','/institution/news']:
            with self.subTest(path=path):
                r=self.parse(self.article(),path=path)
                self.assertEqual(r['source_kind'],'listing');self.assertEqual(r['publicationEvidence'],[])
    def test_main_with_heading_and_time_alone_stays_unknown_for_review(self):
        r=self.parse('<main><h1>Business notice</h1><time datetime="2026-11-14T11:00:00+05:00">11:00</time><p>'+self.prose+'</p></main>')
        self.assertEqual(r['source_kind'],'unknown');self.assertTrue(r['contentValidated'])
    def test_undated_or_short_single_article_is_pending_identity_not_false_listing(self):
        for article in [self.article(date=''),self.article(body='Short but readable institution notice with enough words to preserve as original body evidence for manual verification.')]:
            with self.subTest(article=article[:100]):
                r=self.parse(article)
                self.assertEqual(r['source_kind'],'unknown');self.assertTrue(r['contentValidated'])
    def test_recommended_article_jsonld_never_classifies_unidentified_body_as_article(self):
        ld=json.dumps({'@type':'NewsArticle','url':'https://example.com/other','datePublished':'2026-11-14T11:00:00+05:00'})
        r=self.parse('<script type="application/ld+json">'+ld+'</script><main><h1>Unknown page</h1><p>'+self.prose+'</p></main>')
        self.assertEqual(r['source_kind'],'unknown');self.assertEqual(r['publicationEvidence'],[])
    def test_unknown_frozen_body_does_not_follow_listing_refresh_policy(self):
        url='https://example.com/institution/notice-123';key=hashlib.sha256(url.encode()).hexdigest()[:18]
        old={'url':url,'status':200,'key':key,'source_kind':'unknown','parser_version':f.PARSER_VERSION,'contentValidated':True,'fetchedAt':'2026-11-15T20:00:00+00:00','title':'Unresolved institution body'}
        with tempfile.TemporaryDirectory() as tmp,patch.object(f,'S',Path(tmp)),patch.object(f,'datetime',CutoffClock),patch.object(f.urllib.request,'urlopen') as request:
            (f.S/(key+'.json')).write_text(json.dumps(old))
            r=f.fetch(url,'2026-11-16T06:00:00+08:00')
        self.assertEqual(request.call_count,0);self.assertEqual(r['fetchedAt'],old['fetchedAt'])
        self.assertEqual(r['source_kind'],'unknown')

class ExplicitSourceRoleRegressions(unittest.TestCase):
    # Reuse the real temporary cache setup rather than mocking cache decisions.
    setUp=SourceRegressions.setUp
    tearDown=SourceRegressions.tearDown
    cached=SourceRegressions.cached
    parse=SourceRegressions.parse
    def unknown_response(self,url):
        class UnknownResponse(Response):
            def read(self,*a):return ('<!doctype html><html><body><main><h1>Unclassified notices</h1><p>'+('Readable institution content. '*12)+'</p></main></body></html>').encode()
        response=UnknownResponse();response.url=url;return response
    def test_declared_unknown_listing_refreshes_after_cutoff_without_changing_identity(self):
        url='https://example.com/department/notices-feed'
        self.cached(url,'unknown',fetched_at='2026-11-16T05:59:00+08:00')
        with patch.object(f,'datetime',CutoffClock),patch.object(f.urllib.request,'urlopen',return_value=self.unknown_response(url)) as request:
            r=f.fetch(url,'2026-11-16T06:00:00+08:00',source_role='listing')
        self.assertEqual(request.call_count,1);self.assertEqual(r['source_kind'],'unknown')
        self.assertEqual(r['fetchedAt'],'2026-11-15T22:10:00+00:00')
    def test_declared_unknown_listing_reuses_actual_post_cutoff_cache(self):
        url='https://example.com/department/notices-feed'
        old=self.cached(url,'unknown',fetched_at='2026-11-16T06:04:00+08:00')
        with patch.object(f,'datetime',CutoffClock),patch.object(f.urllib.request,'urlopen') as request:
            r=f.fetch(url,'2026-11-16T06:00:00+08:00',source_role='listing')
        self.assertEqual(request.call_count,0);self.assertEqual(r['fetchedAt'],old['fetchedAt'])
    def test_declared_unknown_listing_uses_existing_fifteen_minute_freshness(self):
        url='https://example.com/department/notices-feed'
        self.cached(url,'unknown',age=901)
        with patch.object(f.urllib.request,'urlopen',return_value=self.unknown_response(url)) as request:
            self.assertEqual(f.fetch(url,source_role='listing')['source_kind'],'unknown')
        self.assertEqual(request.call_count,1)
    def test_unknown_article_and_auto_roles_keep_original_body_evidence(self):
        url='https://example.com/department/notice-123'
        old=self.cached(url,'unknown',fetched_at='2026-11-16T05:00:00+08:00')
        for role in ('article','auto',None):
            with self.subTest(role=role),patch.object(f,'datetime',CutoffClock),patch.object(f.urllib.request,'urlopen') as request:
                r=f.fetch(url,'2026-11-16T06:00:00+08:00',source_role=role)
                self.assertEqual(request.call_count,0);self.assertEqual(r['fetchedAt'],old['fetchedAt'])
    def test_listing_hint_cannot_refetch_confirmed_article(self):
        url='https://example.com/department/notice-123'
        old=self.cached(url,'article',fetched_at='2026-11-16T05:00:00+08:00')
        with patch.object(f,'datetime',CutoffClock),patch.object(f.urllib.request,'urlopen') as request:
            r=f.fetch(url,'2026-11-16T06:00:00+08:00',source_role='listing')
        self.assertEqual(request.call_count,0);self.assertEqual(r['fetchedAt'],old['fetchedAt'])
    def test_future_minimum_is_rejected_for_all_source_roles_before_cache(self):
        url='https://example.com/department/notices-feed';self.cached(url,'unknown')
        for role in ('auto','article','listing'):
            with self.subTest(role=role),patch.object(f,'datetime',CutoffClock),patch.object(f.urllib.request,'urlopen') as request:
                with self.assertRaisesRegex(ValueError,'cannot be in the future'):f.fetch(url,'2026-11-16T06:10:01+08:00',source_role=role)
                self.assertEqual(request.call_count,0)
    def test_invalid_source_role_is_not_silently_ignored(self):
        with patch.object(f.urllib.request,'urlopen') as request:
            with self.assertRaisesRegex(ValueError,'source-role must be'):f.fetch('https://example.com/story',source_role='force')
        self.assertEqual(request.call_count,0)
    def test_navigation_ancestry_is_preserved_without_hiding_article_body_links(self):
        raw=('<!doctype html><html><body><header><a href="/header">Header</a></header><nav><a href="/nav">Menu</a></nav><div role="navigation"><a href="/role">Role menu</a></div><main><article><h1>Story</h1><p>'+('Readable body content. '*12)+'<a href="/body">Body source</a></p></article></main><footer><a href="/footer">Footer</a></footer></body></html>').encode()
        r=self.parse(raw);links={x['url'].rsplit('/',1)[-1]:x for x in r['links']}
        for key in ('header','nav','role','footer'):self.assertTrue(links[key]['inNavigation'])
        self.assertFalse(links['body']['inNavigation'])

class CurrentArticleBodyRegressions(unittest.TestCase):
    title='Synthetic business tax notice for 2027'
    def alau_structure(self):
        # Reproduces the frozen Alau DOM arrangement, with invented fixture text:
        # the current headline is outside main; <article> tags are related cards.
        return ('<!doctype html><html lang="ru"><head><meta property="og:type" content="article"><meta property="og:title" content="'+self.title+'"></head><body><div class="container"><header><h1 class="post-title">'+self.title+'</h1></header><main class="content mda-8 single"><div class="content-inner"><p>'+('Synthetic tax explanation for businesses, not a real news report. '*5)+'</p><ul><li>300 fixture businesses</li></ul><table><tr><th>Year</th><td>2027</td></tr><tr><th>Rate</th><td>16.0%</td></tr></table><footer><p>Footnote: a proposal, not an effective rule.</p></footer></div></main><section><article class="jeg-pl-sm"><h2><a href="/unrelated">Unrelated property recommendation</a></h2><p>'+('Unrelated recommendation text. '*40)+'</p></article></section></div></body></html>').encode()
    def parse(self,raw):return f.parse_response('https://example.com/tax-story','https://example.com/tax-story',raw,{})
    def test_alau_main_body_wins_over_longer_recommendation_article(self):
        r=self.parse(self.alau_structure())
        self.assertTrue(r['contentValidated']);self.assertTrue(r['fullTextValidated'])
        self.assertEqual(r['articleBodyEvidence']['basis'],'explicit_article_body')
        self.assertIn('300 fixture businesses',r['text']);self.assertIn('2027',r['text']);self.assertIn('16.0%',r['text'])
        self.assertIn('Footnote: a proposal, not an effective rule.',r['text'])
        self.assertNotIn('Unrelated property recommendation',r['text'])
    def test_main_heading_body_wins_when_cards_follow_without_body_class(self):
        raw=('<!doctype html><html><head><meta property="og:type" content="article"><meta property="og:title" content="Current notice"></head><body><main><h1>Current notice</h1><p>'+('Current notice substantive prose. '*8)+'</p></main><article><h2><a href="/other">Other headline</a></h2><p>'+('Longer unrelated recommendation. '*30)+'</p></article></body></html>').encode()
        r=self.parse(raw)
        self.assertTrue(r['fullTextValidated']);self.assertIn('Current notice substantive prose',r['text']);self.assertNotIn('Longer unrelated',r['text'])
    def test_recommendation_only_page_never_validates_current_article_body(self):
        raw=('<!doctype html><html><head><meta property="og:type" content="article"><meta property="og:title" content="Current notice"></head><body><header><h1>Current notice</h1></header><article class="jeg-pl-sm"><h2><a href="/other">Other headline</a></h2><p>'+('Other article summary. '*30)+'</p></article></body></html>').encode()
        r=self.parse(raw)
        self.assertFalse(r['contentValidated']);self.assertFalse(r['fullTextValidated']);self.assertIn('article_body_not_identified',r['error'])
        self.assertNotIn('Other article summary',r['text'])
    def test_conflicting_og_and_current_heading_requires_manual_verification(self):
        raw=self.alau_structure().replace(('<h1 class="post-title">'+self.title+'</h1>').encode(),b'<h1 class="post-title">Different current headline</h1>')
        r=self.parse(raw)
        self.assertFalse(r['contentValidated']);self.assertFalse(r['fullTextValidated']);self.assertIn('heading_title_conflict',r['error'])
    def test_seo_title_may_differ_when_url_bound_jsonld_confirms_current_headline(self):
        ld=json.dumps({'@type':'NewsArticle','mainEntityOfPage':{'@id':'https://example.com/tax-story'},'headline':'Current detailed tax notice'})
        raw=('<!doctype html><html><head><meta property="og:type" content="article"><meta property="og:title" content="How do the tax rules work?"><script type="application/ld+json">'+ld+'</script></head><body><main><h1>Current detailed tax notice</h1><p>'+('Current article explanation. '*12)+'</p></main></body></html>').encode()
        r=self.parse(raw)
        self.assertTrue(r['fullTextValidated']);self.assertEqual(r['articleBodyEvidence']['headingIdentityBasis'],'current_article_jsonld_headline')
    def test_related_explicit_body_cannot_inherit_current_page_heading(self):
        raw=('<!doctype html><html><head><meta property="og:type" content="article"><meta property="og:title" content="Current notice"></head><body><h1>Current notice</h1><aside><article><h2><a href="/other">Other headline</a></h2><div class="entry-content">'+('Other article prose. '*30)+'</div></article></aside></body></html>').encode()
        r=self.parse(raw)
        self.assertFalse(r['contentValidated']);self.assertFalse(r['fullTextValidated'])
    def test_v15_wrong_body_cache_is_reparsed_without_refetch_or_new_fetch_time(self):
        url='https://example.com/tax-story';key=hashlib.sha256(url.encode()).hexdigest()[:18]
        old={'url':url,'status':200,'final_url':url,'parser_version':'source-html-v15','source_kind':'article','contentValidated':True,'text':'Wrong unrelated recommendation','fetchedAt':'2026-11-15T13:22:37+00:00'}
        with tempfile.TemporaryDirectory() as tmp,patch.object(f,'S',Path(tmp)),patch.object(f.urllib.request,'urlopen') as request:
            (f.S/(key+'.json')).write_text(json.dumps(old));(f.S/(key+'.html.gz')).write_bytes(gzip.compress(self.alau_structure()))
            r=f.fetch(url)
        self.assertEqual(request.call_count,0);self.assertEqual(r['fetchedAt'],old['fetchedAt']);self.assertEqual(r['parser_version'],'source-html-v16')
        self.assertTrue(r['fullTextValidated']);self.assertIn('300 fixture businesses',r['text']);self.assertNotEqual(r['text'],old['text'])
    def test_semantic_body_failure_survives_cache_reparse_without_network_retry(self):
        url='https://example.com/tax-story';key=hashlib.sha256(url.encode()).hexdigest()[:18]
        old={'url':url,'status':200,'final_url':url,'parser_version':'source-html-v15','source_kind':'article','contentValidated':True,'text':'Wrong cached body','fetchedAt':'2026-11-15T13:22:37+00:00'}
        raw=self.alau_structure().replace(('<h1 class="post-title">'+self.title+'</h1>').encode(),b'<h1 class="post-title">Conflicting current headline</h1>')
        with tempfile.TemporaryDirectory() as tmp,patch.object(f,'S',Path(tmp)),patch.object(f.urllib.request,'urlopen') as request:
            (f.S/(key+'.json')).write_text(json.dumps(old));(f.S/(key+'.html.gz')).write_bytes(gzip.compress(raw))
            first=f.fetch(url);second=f.fetch(url)
        self.assertEqual(request.call_count,0)
        self.assertFalse(first['contentValidated']);self.assertFalse(second['contentValidated'])
        self.assertIn('heading_title_conflict',first['error']);self.assertEqual(second['error'],first['error'])
        self.assertEqual(second['fetchedAt'],old['fetchedAt'])
    def test_sputnik_basic_iso_keeps_actual_precision_and_explicit_offset(self):
        from datetime import datetime
        for raw in ['20261115T1222+0500','20261115T1745+0500','20261115T1522+0500']:
            with self.subTest(raw=raw):
                self.assertEqual(f.timestamp_precision(raw),('minutes','explicit'))
                self.assertEqual(datetime.fromisoformat(raw).utcoffset(),timedelta(hours=5))
        self.assertEqual(f.timestamp_precision('20261115T1222'),('minutes','not_provided'))
        self.assertEqual(f.timestamp_precision('20261315T1222+0500'),('unparsed','not_provided'))
    def test_article_header_headline_is_not_site_navigation(self):
        raw=('<!doctype html><html><body><header><a href="/menu">Site menu</a></header><main><article><header><h2><a href="/story">Valid card headline</a></h2></header><p>'+('Readable fixture body. '*10)+'</p><footer><a href="/citation">Article footnote</a></footer></article></main></body></html>').encode()
        r=self.parse(raw);links={x['url'].rsplit('/',1)[-1]:x for x in r['links']}
        self.assertTrue(links['menu']['inNavigation'])
        self.assertFalse(links['story']['inNavigation']);self.assertTrue(links['story']['inHeading']);self.assertTrue(links['story']['articleCard'])
        self.assertFalse(links['citation']['inNavigation'])

class PublisherTemplateRegressions(unittest.TestCase):
    prose='Synthetic publisher prose for a reproducible DOM fixture; this is not a real news report. '*5
    def parse(self,url,body,title='Current business notice',head=''):
        raw=('<!doctype html><html><head><meta property="og:type" content="article"><meta property="og:title" content="'+title+'">'+head+'</head><body>'+body+'</body></html>').encode()
        return f.parse_response(url,url,raw,{})
    def test_apa_category_h1_does_not_replace_actual_article_h2(self):
        body='<h1>Amerika</h1><div class="content_main"><h2 class="title_news mb-site">Current business notice</h2><div class="news_content"><div class="texts mb-site" itemprop="articleBody"><p>'+self.prose+'</p><ul><li>Fixture item 528</li></ul></div></div></div>'
        r=self.parse('https://apa.az/amerika/current-business-notice-1013949',body)
        self.assertTrue(r['fullTextValidated']);self.assertIn('apa_content_main',r['articleBodyEvidence']['basis'])
        self.assertEqual(r['articleBodyEvidence']['headingTexts'],['Current business notice']);self.assertIn('Fixture item 528',r['text'])
    def test_apa_selector_requires_publisher_host_and_matching_news_title(self):
        body='<h1>Amerika</h1><div class="content_main"><h2 class="title_news">Current business notice</h2><div itemprop="articleBody"><p>'+self.prose+'</p></div></div>'
        r=self.parse('https://unrecognized.example/amerika/story-1013949',body)
        self.assertFalse(r['fullTextValidated'])
        r=self.parse('https://apa.az/amerika/story-1013949',body.replace('Current business notice','Different article headline'))
        self.assertFalse(r['fullTextValidated'])
    def report_item(self,url,title,prose):
        return '<div class="news-detail__item post-detail-area" data-url="'+url+'" data-title="'+title+'"><h1 class="section-title">'+title+'</h1><div class="news-detail__desc"><p>'+prose+'</p><table><tr><th>Fixture</th><td>2026</td></tr></table><footer>Article footnote retained.</footer></div></div>'
    def test_report_selects_current_data_url_and_preserves_table_and_footnote(self):
        url='https://report.az/ru/economy/current-notice'
        current=self.report_item(url,'Current business notice',self.prose)
        other=self.report_item('https://report.az/ru/economy/other-notice','Other business notice','Unrelated article prose. '*50)
        r=self.parse(url,current+other)
        self.assertTrue(r['fullTextValidated']);self.assertIn('data_url',r['articleBodyEvidence']['basis'])
        self.assertIn('2026',r['text']);self.assertIn('Article footnote retained.',r['text']);self.assertNotIn('Unrelated article prose',r['text'])
    def test_report_data_url_mismatch_cannot_bind_another_article(self):
        r=self.parse('https://report.az/ru/economy/current-notice',self.report_item('https://report.az/ru/economy/other-notice','Current business notice',self.prose))
        self.assertFalse(r['fullTextValidated'])
    def test_inbusiness_text_template_requires_unique_body_and_article_route(self):
        body='<h1>Current business notice</h1><div class="text"><p>'+self.prose+'</p></div>'
        r=self.parse('https://inbusiness.kz/ru/last/current-notice',body)
        self.assertTrue(r['fullTextValidated']);self.assertIn('inbusiness_current_news_text',r['articleBodyEvidence']['basis'])
        r=self.parse('https://inbusiness.kz/ru/last/current-notice',body+'<div class="text"><p>'+self.prose+'</p></div>')
        self.assertFalse(r['fullTextValidated'],'ambiguous publisher bodies require manual verification')
    def test_24kg_viewer_retains_complete_address_lists_and_table(self):
        body='<h1>Current business notice</h1><div id="article-content" class="article-viewer-content cont"><p>'+self.prose+'</p><ul><li>District A, 9:00-17:00</li><li>District B, 10:00-16:00</li></ul><table><tr><td>Site 35</td></tr></table></div>'
        r=self.parse('https://24.kg/article/current-notice',body)
        self.assertTrue(r['fullTextValidated']);self.assertIn('24kg_current',r['articleBodyEvidence']['basis'])
        self.assertIn('District B, 10:00-16:00',r['text']);self.assertIn('Site 35',r['text'])
        r=self.parse('https://24.kg/plot/10',body)
        self.assertFalse(r['fullTextValidated'],'a plot collection is not upgraded using an article selector')
    def khovar_body(self,prose):
        return '<h1>Current business notice</h1><div class="block-content post-422940 post type-post status-publish"><div class="shortcode-content"><p>'+prose+'</p></div></div><div class="entry-content">Unrelated social footer. '+self.prose*3+'</div>'
    def test_khovar_published_post_body_precedes_unrelated_entry_content(self):
        # The observed site declares a publisher string rather than og:type=article.
        raw=('<!doctype html><html><head><meta property="og:type" content="Publisher"><meta property="og:title" content="Current business notice"></head><body>'+self.khovar_body(self.prose)+'</body></html>').encode()
        url='https://khovar.tj/rus/2026/11/current-business-notice/'
        r=f.parse_response(url,url,raw,{})
        self.assertEqual(r['source_kind'],'article');self.assertTrue(r['fullTextValidated']);self.assertIn('khovar_published_post',r['articleBodyEvidence']['basis'])
        self.assertNotIn('Unrelated social footer',r['text'])
    def test_khovar_image_only_body_does_not_fall_back_to_unrelated_footer(self):
        r=self.parse('https://khovar.tj/rus/2024/04/image-quote/',self.khovar_body('Print page. Send. 20 April 2024.'))
        self.assertFalse(r['fullTextValidated']);self.assertEqual(r['articleBodyEvidence']['status'],'publisher_body_has_no_substantive_text')
    def tilda_body(self):
        return '<div id="allrecords" class="t-records" data-tilda-page-id="345011103" data-tilda-project-id="11749581"><div class="t-rec"><h1 class="tn-atom">An editorial cover headline for this same longread</h1><p>'+self.prose+'</p><ol><li>Manufacturing step 1</li><li>Manufacturing step 2</li></ol></div></div>'
    def test_tengri_tilda_editorial_cover_is_bound_to_exact_current_article_url(self):
        url='https://tengrinews.kz/article/current-manufacturing-notice-4711/'
        r=self.parse(url,self.tilda_body(),head='<meta property="og:url" content="'+url+'">')
        self.assertTrue(r['fullTextValidated']);self.assertEqual(r['articleBodyEvidence']['headingIdentityBasis'],'publisher_url_bound_editorial_cover')
        self.assertIn('Manufacturing step 2',r['text'])
    def test_tengri_tilda_does_not_override_headline_conflict_without_url_identity(self):
        url='https://tengrinews.kz/article/current-manufacturing-notice-4711/'
        r=self.parse(url,self.tilda_body(),head='<meta property="og:url" content="https://tengrinews.kz/article/other-story-999/">')
        self.assertFalse(r['fullTextValidated'])

if __name__=='__main__':unittest.main()
