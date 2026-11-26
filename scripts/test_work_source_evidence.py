import hashlib
import json
import unittest

from discovery_feed import parse_feed
from source_evidence import (fact_locations, khovar_archive_dateline, khovar_archive_publication_footer,
                             local_timestamp, publication_options, source_time)
from news_funnel import event_pairs, scan_funnel
from db_handoff import sql, verify_original
from datetime import datetime
from discover_work_sources import article_links, assess_window, published_intervals
from fetch_work_sources import parse_response


class SourceEvidencePolicy(unittest.TestCase):
    def test_khovar_archive_footer_requires_current_prose_dateline(self):
        url='https://khovar.tj/rus/2026/11/article/'
        prose='ДУШАНБЕ, 25.11.2026 /НИАТ «Ховар»/.\nТекст статьи.'
        footer='\n\ue716\nПечать страницы\n✉\nОтправить\nНоябрь 25, 2026 15:27'
        item=khovar_archive_publication_footer(url,prose+footer)
        self.assertEqual(item['localWallTime'],'2026-11-25T15:27')
        self.assertIsNone(khovar_archive_publication_footer(url,prose+footer.replace('25,','24,')))
        self.assertIsNone(khovar_archive_publication_footer(url,prose+footer+'\nДругая статья'))
        self.assertIsNone(khovar_archive_publication_footer(url.replace('11/','10/'),prose+footer))
        self.assertIsNone(khovar_archive_publication_footer(url,footer))

    def test_rss_atom_and_news_sitemap_are_leads_only(self):
        base='https://press.example/news'
        for raw in (
            b'<rss><channel><language>ru</language><item><title>Short</title><link>/story</link>'
            b'<pubDate>Wed, 25 Nov 2026 21:00:00 +0400</pubDate></item></channel></rss>',
            b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Short</title>'
            b'<link rel="alternate" href="/story"/><published>2026-11-25T21:00:00+04:00</published></entry></feed>',
            b'<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"><url><loc>/story</loc>'
            b'<lastmod>2020-01-01</lastmod><news:news><news:title>Short</news:title>'
            b'<news:publication_date>2026-11-25T21:00:00+04:00</news:publication_date></news:news></url></urlset>',
            json.dumps({'version':'https://jsonfeed.org/version/1.1','items':[{'url':'/story','title':'Short',
                        'date_published':'2026-11-25T21:00:00+04:00'}]}).encode(),
        ):
            with self.subTest(raw=raw):
                item=parse_feed(raw,base)
                self.assertNotIn('text',item)
                self.assertEqual(item['links'][0]['url'],'https://press.example/story')
                self.assertEqual(item['links'][0]['nearbyTimes'][0]['datetime'],'2026-11-25T21:00:00+04:00')
        self.assertIsNone(parse_feed(b'<!DOCTYPE rss SYSTEM "https://outside.example/news"><rss/>',base))
        self.assertIsNone(parse_feed(b'{"news":[]}',base))

    def test_unambiguous_source_wall_time_and_originals(self):
        self.assertEqual(local_timestamp('25.11.2026 17.00','Asia/Dushanbe'),'2026-11-25T17:00:00+05:00')
        self.assertIsNone(local_timestamp('2026-10-25T02:30','Europe/Berlin'))
        self.assertIsNone(local_timestamp('2026-03-29T02:30','Europe/Berlin'))
        self.assertIsNone(local_timestamp('2026-11-25','Asia/Dushanbe'))
        sentence='Отчёт за 2026 год указывает 22 млн тенге. Второй абзац не подтверждён.'
        extracted=fact_locations(sentence)
        self.assertEqual(extracted['verification'],'machine_locations_only')
        self.assertEqual(extracted['numbersAndPeriods'][0]['numbers'],['22 млн тенге'])
        record={'source_kind':'article','fullTextValidated':True,'final_url':'https://press.example/x',
                'publicationEvidence':[{'kind':'published','field':'meta.article:published_time','raw':'2026-11-25T17:00:00',
                                        'timezoneEvidence':'not_provided','articleUrl':'https://press.example/related'}]}
        self.assertNotIn('normalizedAt',source_time(record,'Asia/Dushanbe')['publicationEvidence'][0])

    def test_source_header_clocks_do_not_turn_creation_or_relative_time_into_publication(self):
        def parse(url, badge, zone):
            prose=('The current government report describes a separate local project and the accompanying '
                   'budget and work plan. The data refers to the same project and named agency. ')*3
            raw=(f'<!doctype html><html><head><meta property="og:type" content="article">'
                 f'<link rel="canonical" href="{url}"></head><body><article><h1>Verified current report</h1>{badge}'
                 f'<div itemprop="articleBody"><p>{prose}</p></div></article></body></html>').encode()
            return source_time({'url':url, **parse_response(url,url,raw,{})},zone)

        su='https://www.sugd.tj/ru/novosty/novosti-dnya/5048-agriculture'
        result=parse(su,'<div>Создано: <time datetime="2025-05-06 07:19:17">06.05.2025 12:19</time> Просмотров: 24</div>',
                     'Asia/Dushanbe')
        self.assertTrue(result['fullTextValidated'])
        created=next(row for row in result['publicationEvidence'] if row['kind']=='created')
        self.assertEqual(created['normalizedAt'],'2025-05-06T12:19:00+05:00')
        self.assertEqual(published_intervals(result,'tj'),[])
        self.assertTrue(any(row['raw']=='2025-05-06 07:19:17' and row['kind']=='unclassified'
                            for row in result['publicationEvidence']))

        result=parse('https://alau.kz/current-report/','<div><a href="/author/a">Автор</a> — Сегодня, 14:59</div>','Asia/Almaty')
        self.assertEqual(result['publicationEvidence'][0]['timezoneEvidence'],'reference_day_missing')
        self.assertEqual(published_intervals(result,'kz'),[])
        result=parse('https://review.uz/post/current-report',
                     '<div class="related-news"><span>25.11.2026 в 10:37</span></div>','Asia/Tashkent')
        self.assertEqual(published_intervals(result,'uz'),[])
        for url,badge,zone,country,wanted in (
                ('https://podrobno.uz/cat/economic/current-report/','25 ноября 2026, 20:54','Asia/Tashkent','uz','2026-11-25T20:54:00+05:00'),
                ('https://review.uz/post/current-report','25.11.2026 в 10:37','Asia/Tashkent','uz','2026-11-25T10:37:00+05:00'),
                ('https://www.taxes.gov.az/az/post/5167','26 noyabr 2026, 11:52','Asia/Baku','az','2026-11-26T11:52:00+04:00')):
            with self.subTest(url=url):
                self.assertEqual(published_intervals(parse(url,f'<div>{badge}</div>',zone),country)[0][0].isoformat(),wanted)

    def test_agency_dateline_stays_distinct_from_publication(self):
        url='https://khovar.tj/rus/2026/11/current-report/'
        prose='ДУШАНБЕ, 22.11.2026 /НИАТ «Ховар»/. The agency reported the local authorities’ decision.'
        item=khovar_archive_dateline(url,prose)
        self.assertEqual((item['kind'],item['calendarDay']),('dateline','2026-11-22'))
        self.assertEqual(khovar_archive_dateline(url,prose.replace('/НИАТ','\n/\nНИА\nТ'))['calendarDay'],'2026-11-22')
        self.assertIsNone(khovar_archive_dateline(url.replace('/11/','/10/'),prose))
        record=source_time({'url':url,'source_kind':'article','fullTextValidated':True,'publicationEvidence':[item]},
                           'Asia/Dushanbe')
        self.assertEqual(published_intervals(record,'tj'),[])
        self.assertEqual(assess_window(record,'tj',datetime.fromisoformat('2026-11-25T06:00:00+08:00'),
                                       datetime.fromisoformat('2026-11-26T06:00:00+08:00')),'uncertain')

    def test_toptj_utc_metadata_is_bound_to_same_article_alias_only(self):
        url='https://toptj.com/news/2026/11/25/this-report'
        original_id='http://www.toptj.com/news/2026/11/25/this-report'
        records=[{'@type':'NewsArticle','url':original_id,'datePublished':'2026-11-25T16:00:53Z'},
                 {'@type':'NewsArticle','url':original_id.replace('this-report','next-report'),
                  'datePublished':'2026-11-25T11:00:00Z'}]
        prose=('The current publisher reported a change in tax policy with sufficient detail for a '
               'bound body and scope. The policy is related to the current article heading. ')*3
        raw=(f'<html><head><script type="application/ld+json">{json.dumps(records)}</script></head>'
             f'<body><article><h1>Current report</h1><div>25 ноября 2026, 16:00</div>'
             f'<div itemprop="articleBody"><p>{prose}</p></div></article></body></html>').encode()
        record=parse_response(url,url,raw,{})
        self.assertTrue(record['fullTextValidated'])
        self.assertEqual(len(record['publicationEvidence']),1)
        self.assertEqual(record['publicationEvidence'][0]['observedArticleIdentity'],original_id)
        self.assertEqual(record['publicationEvidence'][0]['articleUrl'],url)
        self.assertEqual(record['excludedPublicationEvidence'][0]['raw'],'2026-11-25T11:00:00Z')
        intervals=published_intervals(record,'tj')
        self.assertEqual(intervals[0][0].isoformat(),'2026-11-25T16:00:53+00:00')

    def test_short_title_on_confirmed_article_route_still_fetches_body(self):
        url='https://press.example/story/47'
        source={'id':'example','allowedHosts':['press.example'],'confirmedArticlePathPattern':r'/story/\d+'}
        record={'links':[{'url':url,'text':'税','inHeading':False,'articleCard':False}]}
        self.assertEqual(article_links(record,source,set(),structural_filter=True,adaptive=True),[url])

    def test_funnel_keeps_http_parse_and_time_distinct_and_event_hints_keep_both(self):
        stamp='2026-11-26T06:01:00+08:00'
        root='https://press.example/'
        base={'sourceId':'source','fetchedAt':stamp,'status':200}
        audit=[{**base,'url':root,'role':'section','kind':'listing','contentValidated':True,'newsLinksFound':7},
               {**base,'url':root+'a','role':'article','kind':'article','fullTextValidated':False},
               {**base,'url':root+'b','role':'article','kind':'listing','fullTextValidated':False},
               {**base,'url':root+'c','role':'article','kind':'unknown','status':403}]
        ledger=[{'sourceId':'source','source_url':root+'d','fullTextValidated':True,'fullTextFetchedAt':stamp,
                 'publicationWindowAssessment':'in_window'}]
        row=scan_funnel([{'id':'source','family':'Publisher'}],audit,[],ledger)[0]
        self.assertEqual((row['articleParseFailures'],row['nonArticleResponses'],row['articleHttpFailures']),(1,1,1))
        self.assertEqual((row['readablePages'],row['pages'][0]['newsLinks'],row['inWindow']),(1,7,1))
        rows=[{'id':'a','title':'New export regulations entered into force','sourceHash':'x'},
              {'id':'b','title':'New export regulations entered into force','sourceHash':'y'}]
        self.assertEqual(event_pairs(rows)['a'][0]['candidateId'],'b')
        self.assertEqual(len(rows),2)

    def test_exchange_diagnostics_are_read_only_and_original_keys_stay_bounded(self):
        self.assertIn('sourceFunnel',sql('funnel','2026-11-26','az'))
        self.assertIn("'2026-11-20' and '2026-11-26'",sql('weekly-funnel','2026-11-26'))
        self.assertIn("payload #> '{original,evidencePacket}'",sql('evidence','2026-11-26','az',ids=['id/'+'a'*64+'/'+'b'*64]))
        key='id/'+'a'*64+'/'+'b'*64
        self.assertIn("'"+key+"'",sql('originals','2026-11-26','az',ids=[key]))
        self.assertIn("'source-evidence-2/"+key+"'",sql('originals','2026-11-27','az',ids=[key]))
        with self.assertRaises(ValueError):
            sql('evidence','2026-11-26','az',ids=['id'])

    def test_exchange_original_checks_revision_and_source_with_legacy_compatibility(self):
        source_url='https://press.example/post/1'
        text='Same archived original.'
        body_hash=hashlib.sha256(text.encode()).hexdigest()
        candidate={'id':'id','sourceHash':body_hash,'sourceUrl':source_url,'revision':'b'*64}
        legacy={'id':'id','sourceHash':body_hash,'text':text}
        self.assertTrue(verify_original({'candidate':candidate,'original':legacy}))
        self.assertTrue(verify_original({'candidate':candidate,'original':legacy},'2026-11-26'))
        with self.assertRaisesRegex(ValueError,'original_revision_or_source_mismatch'):
            verify_original({'candidate':candidate,'original':legacy},'2026-11-27')
        original={**legacy,'revision':candidate['revision'],'source_url':source_url,
                  'evidencePacket':{'version':'source-evidence-2'}}
        self.assertTrue(verify_original({'candidate':candidate,'original':original},'2026-11-27'))
        for patch in ({'revision':None},{'revision':'a'*64},{'source_url':source_url+'0'}):
            with self.assertRaisesRegex(ValueError,'original_revision_or_source_mismatch'):
                verify_original({'candidate':candidate,'original':{**original,**patch}})

    def test_publication_options_hold_conflicting_article_clocks(self):
        url='https://press.example/post/1'
        start=datetime.fromisoformat('2026-11-26T06:00:00+08:00')
        end=datetime.fromisoformat('2026-11-27T06:00:00+08:00')
        observed=datetime.fromisoformat('2026-11-27T06:05:00+08:00')
        first={'articleUrl':url,'kind':'published','precision':'seconds','raw':'2026-11-26T11:00:00Z'}
        same={**first,'raw':'2026-11-26T16:00:00+05:00'}
        def options(*entries, **flags):
            return publication_options({'url':url,'publicationEvidence':entries,**flags},observed,start,end)
        self.assertEqual(len(options(first,same)),2)
        for conflict in ('2026-11-26T11:01:00Z','2026-11-25T21:00:00Z','2026-11-27T11:00:00Z'):
            self.assertEqual(options(first,{**first,'raw':conflict}),[])
        self.assertEqual(options(first,publicationReviewRequired=True),[])
        self.assertEqual(len(options(first,{**first,'kind':'modified','raw':'2026-11-26T12:00:00Z'})),1)
