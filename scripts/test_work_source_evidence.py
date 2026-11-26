import json
import unittest

from discovery_feed import parse_feed
from source_evidence import fact_locations, local_timestamp, source_time
from news_funnel import event_pairs, scan_funnel
from db_handoff import sql


class SourceEvidencePolicy(unittest.TestCase):
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
        with self.assertRaises(ValueError):
            sql('evidence','2026-11-26','az',ids=['id'])
