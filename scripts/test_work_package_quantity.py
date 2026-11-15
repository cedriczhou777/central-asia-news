"""Exercise the quantity gate and deadline fallback together, without requests."""
import copy
import json
import unittest
import subprocess
import sys
import tempfile
from pathlib import Path
from datetime import datetime, timedelta
import validate_work_package as gate
from test_work_quantity import fixture as supply_fixture


def shift_day(value):
    if isinstance(value, dict):return {k:shift_day(v) for k,v in value.items()}
    if isinstance(value, list):return [shift_day(v) for v in value]
    if isinstance(value, str) and value.startswith('2026-11-'):
        try:return (datetime.fromisoformat(value)+timedelta(days=1)).isoformat() if 'T' in value else (datetime.fromisoformat(value)+timedelta(days=1)).date().isoformat()
        except ValueError:pass
    return value


def full_fixture(count=15):
    data={'issueDate':'2026-11-16','drafts':{},'reviews':{},'package':{'version':'2026-11-16','countries':{}}}
    template=gate.fixture()['drafts']['kg']['articles'][0]
    for code in gate.COUNTRIES:
        draft,audit,_=supply_fixture(count)
        draft=shift_day(draft);audit=shift_day(audit);draft['country']=code
        for source in draft['sourceRegistry']['sources']:source['country']=code
        draft.update(windowStart='2026-11-15T06:00:00+08:00',windowEnd='2026-11-16T06:00:00+08:00',coverageEnd='2026-11-16T06:00:00+08:00',sourceScanAudit=audit)
        draft['articles']=[dict(copy.deepcopy(template),id=a['id'],source_url=a['source_url'],title=f'测试标题{i}') for i,a in enumerate(draft['articles'])]
        entries=copy.deepcopy(draft['articles'])
        review={'issueDate':data['issueDate'],'country':code,'reviewer':'fixture-independent','stage':'verified','originalHash':gate.digest(draft['articles']),'articles':entries,'finalBodyHash':gate.digest(entries),'issues':[],'fullSourceReviewCompleted':True,'revisedFullTextRechecked':True,'titleFactReviewCompleted':True,'bodyFactReviewCompleted':True}
        body='<section style="padding:0 10px 20px"><section style="padding:20px 12px"><p>2026年11月16日</p>'
        body+=''.join(f'<p>{a["title"]}</p><p style="font-size:16px;text-align:justify;text-align-last:left">{a["body"]}</p>' for a in entries)+'</section></section>'
        data['drafts'][code]=draft;data['reviews'][code]=review
        data['package']['countries'][code]={'title':'测试日报','summary':'测试摘要','sourceUrl':'','coverUrl':'','bodyHtml':body}
    return data


class PackageQuantity(unittest.TestCase):
    now=datetime.fromisoformat('2026-11-16T08:00:00+08:00')
    def test_fifteen_real_coverage_passes_normal_gate(self):
        data=full_fixture();self.assertFalse(gate.validate(data,now=self.now))
        self.assertTrue(all(r['quantityReady'] for r in gate.quantity_report(data,self.now).values()))
    def test_full_five_country_hundred_story_package_is_not_truncated(self):
        data=full_fixture(20);self.assertFalse(gate.validate(data,now=self.now))
        self.assertEqual(sum(len(r['articles']) for r in data['reviews'].values()),100)
        self.assertTrue(all(r['quantityReady'] for r in gate.quantity_report(data,self.now).values()))
    def test_six_with_arbitrary_explanation_cannot_complete(self):
        data=full_fixture(6)
        for review in data['reviews'].values():review['coverageShortfallExplanation']='All checked, no news today'
        errors=gate.validate(data,now=self.now)
        self.assertEqual(sum('quantity/coverage/selection incomplete' in e for e in errors),5)
    def test_deadline_fallback_keeps_quantity_failure_and_open_issue(self):
        data=full_fixture(10);issue={'kind':'quantity_shortfall','closed':False,'detail':'Ten real articles; coverage and expansion remain open'}
        data['reviews']['kg']['issues']=[issue]
        original=copy.deepcopy(data)
        self.assertFalse(gate.validate(data,now=self.now,delivery_mode='deadline_under_delivery'))
        self.assertTrue(all(not r['quantityReady'] and r['shortfallOpen'] for r in gate.quantity_report(data,self.now).values()))
        self.assertEqual(data,original)
    def test_fallback_is_not_available_before_0730(self):
        errors=gate.validate(full_fixture(6),now=datetime.fromisoformat('2026-11-16T07:29:59+08:00'),delivery_mode='deadline_under_delivery')
        self.assertTrue(any('07:30' in e for e in errors))
    def test_null_or_malformed_scarcity_review_returns_errors_not_crash(self):
        for value in (None, 'approved', [], 1):
            with self.subTest(value=value):
                data=full_fixture(10)
                for review in data['reviews'].values():review['quantityExceptionReview']=value
                self.assertTrue(gate.validate(data,now=self.now))
                self.assertFalse(gate.validate(data,now=self.now,delivery_mode='deadline_under_delivery'))
                self.assertTrue(all(not q['quantityReady'] for q in gate.quantity_report(data,self.now).values()))
    def test_fallback_never_bypasses_fact_issue_or_independent_author(self):
        data=full_fixture(6);data['reviews']['kg']['issues']=[{'kind':'fact','closed':False}]
        data['reviews']['uz']['reviewer']='fixture-writer'
        errors=gate.validate(data,now=self.now,delivery_mode='deadline_under_delivery')
        self.assertTrue(any('unclosed' in e for e in errors));self.assertTrue(any('independent reviewer' in e for e in errors))
    def test_fallback_never_bypasses_image_verification(self):
        data=full_fixture(6);entry=data['reviews']['kg']['articles'][0]
        entry.update(image_url='https://source0.example/photo.jpg',image_caption='Synthetic fixture',cloudImageProbe={'accessible':False})
        data['reviews']['kg']['finalBodyHash']=gate.digest(data['reviews']['kg']['articles'])
        self.assertTrue(any('cloud image' in e for e in gate.validate(data,now=self.now,delivery_mode='deadline_under_delivery')))

class CountryTransport(unittest.TestCase):
    now=datetime.fromisoformat('2026-11-16T08:00:00+08:00')
    @staticmethod
    def scoped(data,countries=('kz',)):
        data=copy.deepcopy(data)
        for key in ('drafts','reviews'):data[key]={c:data[key][c] for c in countries}
        data['package']['countries']={c:data['package']['countries'][c] for c in countries}
        data['package']['readyCountries']=list(countries)
        return data
    def test_ready_country_can_pass_without_unwritten_other_countries(self):
        data=self.scoped(full_fixture())
        self.assertFalse(gate.validate(data,now=self.now,countries=['kz']))
        self.assertEqual(set(gate.quantity_report(data,self.now,countries=['kz'])),{'kz'})
        self.assertTrue(gate.quantity_report(data,self.now,countries=['kz'])['kz']['quantityReady'])
        self.assertTrue(gate.validate(data,now=self.now))
    def test_scope_must_match_package_and_all_evidence_mappings(self):
        full=full_fixture();full['package']['readyCountries']=None
        self.assertTrue(gate.validate(full,now=self.now))
        for ready in (None,[],['uz'],['kz','kz'],['kz','xx']):
            data=self.scoped(full_fixture());data['package']['readyCountries']=ready
            self.assertTrue(gate.validate(data,now=self.now,countries=['kz']),ready)
        data=self.scoped(full_fixture());data['drafts']['uz']=full_fixture()['drafts']['uz']
        self.assertTrue(gate.validate(data,now=self.now,countries=['kz']))
        for scope in ([],['kz','kz'],['xx'],'kz'):
            self.assertTrue(gate.validate(self.scoped(full_fixture()),now=self.now,countries=scope))
    def test_partial_transport_preserves_quantity_and_safety_gates(self):
        short=self.scoped(full_fixture(6))
        self.assertTrue(any('quantity/coverage' in e for e in gate.validate(short,now=self.now,countries=['kz'])))
        self.assertTrue(any('at least ten' in e for e in gate.validate(short,now=self.now,countries=['kz'],delivery_mode='deadline_under_delivery')))
        self.assertFalse(gate.validate(self.scoped(full_fixture(10)),now=self.now,countries=['kz'],delivery_mode='deadline_under_delivery'))
        self.assertTrue(any('07:30' in e for e in gate.validate(short,now=datetime.fromisoformat('2026-11-16T07:29:00+08:00'),countries=['kz'],delivery_mode='deadline_under_delivery')))
        for mutate in (lambda d:d['reviews']['kz'].update(reviewer=d['drafts']['kz']['writerRun']),lambda d:d['reviews']['kz'].update(titleFactReviewCompleted=False),lambda d:d['reviews']['kz'].update(issues=[{'kind':'fact','closed':False}]),lambda d:d['drafts']['kz'].update(coverageEnd='2026-11-16T05:55:00+08:00')):
            data=self.scoped(full_fixture());mutate(data)
            self.assertTrue(gate.validate(data,now=self.now,countries=['kz']))
    def test_partial_cli_never_claims_five_country_completion(self):
        data=self.scoped(gate.fixture())
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'aggregate.json';path.write_text(json.dumps(data))
            result=subprocess.run([sys.executable,str(Path(gate.__file__)),str(path),'--countries','kz'],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr+result.stdout)
        receipt=json.loads(result.stdout)
        self.assertTrue(receipt['transportAllowed']);self.assertTrue(receipt['partialDelivery']);self.assertTrue(receipt['selectedQuantityReady'])
        self.assertFalse(receipt['qualityDeliveryComplete']);self.assertFalse(receipt['quantityReady']);self.assertTrue(receipt['continueExpansion'])
        self.assertEqual(receipt['missingCountries'],['uz','kg','tj','az'])
    def test_revision_matches_cloud_contract(self):
        data=self.scoped(full_fixture());data['package']['version']='2026-11-16-r1'
        self.assertTrue(any('package issue/version mismatch' in e for e in gate.validate(data,now=self.now,countries=['kz'])))
        data['package']['version']='2026-11-16-r2'
        self.assertFalse(gate.validate(data,now=self.now,countries=['kz']))
    def test_deadline_does_not_waive_ten_story_minimum(self):
        for count in (3,6,9):
            data=self.scoped(full_fixture(count))
            self.assertTrue(any('at least ten' in e for e in gate.validate(data,now=self.now,countries=['kz'],delivery_mode='deadline_under_delivery')))
    def test_deadline_cannot_count_duplicate_reviewed_stories_as_ten(self):
        data=self.scoped(full_fixture(10));data['reviews']['kz']['articles']=[copy.deepcopy(data['reviews']['kz']['articles'][0]) for _ in range(10)]
        data['reviews']['kz']['finalBodyHash']=gate.digest(data['reviews']['kz']['articles'])
        errors=gate.validate(data,now=self.now,countries=['kz'],delivery_mode='deadline_under_delivery')
        self.assertTrue(any('duplicate adopted article IDs' in e for e in errors));self.assertTrue(any('duplicate adopted source URLs' in e for e in errors))
    def test_tracking_parameters_cannot_turn_same_source_into_two_stories(self):
        data=self.scoped(full_fixture());entries=data['reviews']['kz']['articles'];entries[1]['source_url']=entries[0]['source_url']+'?utm_source=second#headline'
        data['reviews']['kz']['finalBodyHash']=gate.digest(entries)
        self.assertTrue(any('duplicate adopted source URLs' in e for e in gate.validate(data,now=self.now,countries=['kz'],delivery_mode='deadline_under_delivery')))


if __name__=='__main__':unittest.main()
