"""Exercise the quantity gate and deadline fallback together, without requests."""
import copy
import json
import unittest
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
    def test_six_with_arbitrary_explanation_cannot_complete(self):
        data=full_fixture(6)
        for review in data['reviews'].values():review['coverageShortfallExplanation']='All checked, no news today'
        errors=gate.validate(data,now=self.now)
        self.assertEqual(sum('quantity/coverage/selection incomplete' in e for e in errors),5)
    def test_deadline_fallback_keeps_quantity_failure_and_open_issue(self):
        data=full_fixture(6);issue={'kind':'quantity_shortfall','closed':False,'detail':'Six real articles; expansion continues'}
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


if __name__=='__main__':unittest.main()
