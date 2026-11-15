"""Validate writer handoff readiness without certifying independent review."""
import argparse,hashlib,json,re
from datetime import datetime,timedelta,timezone
from pathlib import Path
from PIL import Image

def dt(value):
    if not isinstance(value,str) or not value:raise ValueError('valid timezone-aware timestamp required')
    result=datetime.fromisoformat(value.replace('Z','+00:00'))
    if result.tzinfo is None:raise ValueError('timezone required')
    return result
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def finalize(draft,audit,now=None):
    now=now or datetime.now(timezone.utc)
    country=str(draft.get('country','')).lower()
    assert country in ('kz','uz','kg','tj','az'),'unknown country'
    assert isinstance(draft.get('writerRun'),str) and draft['writerRun'].strip(),'writer identity required for independent review'
    draft['country']=country
    end=dt(draft['issueDate']+'T06:00:00+08:00');start=end-timedelta(days=1)
    assert draft.get('windowStart') and dt(draft['windowStart'])==start,'windowStart mismatch'
    assert draft.get('windowEnd') and dt(draft['windowEnd'])==end,'windowEnd mismatch'
    entries=draft.get('articles',[]);assert 0<len(entries)<=20,'need 1-20 real selected articles'
    assert len({e['id'] for e in entries})==len(entries),'duplicate article IDs'
    for e in entries:
        for key in ('id','title','body','category','source_url','source','original_full_text','timeEvidence','firstPublicationCheck'):
            assert isinstance(e.get(key),str) and e[key].strip(),e.get('id','?')+': missing '+key
        published=dt(e['published_at']);assert start<=published<end and published<=now,e['id']+': publication outside actual window'
        assert e['source_url'].startswith('https://'),e['id']+': source must be public HTTPS'
        if e.get('image_url'):
            p=Path(e.get('image_local_path',''));assert p.is_file(),e['id']+': missing adopted image bytes'
            b=p.read_bytes();assert hashlib.sha256(b).hexdigest()==e.get('image_sha256') and len(b)==e.get('image_bytes'),e['id']+': image hash/length mismatch'
            assert 0<len(b)<=10_000_000,e['id']+': adopted image size exceeds transport limit'
            with Image.open(p) as im:
                assert im.width*im.height<=40_000_000,e['id']+': keep original evidence and prepare a visually reviewed publication copy under 40MP'
                im.verify()
            assert e.get('imageReviewCompleted') is True and bool(e.get('image_caption')),e['id']+': actual author visual review/caption required'
        else:assert e.get('imageUnavailableReason'),e['id']+': missing actual image-search gap explanation'
    scans=[dt(r['fetchedAt']) for r in audit if r.get('kind')=='listing' and r.get('status')==200 and r.get('contentValidated') is True]
    assert scans and all(t<=now for t in scans),'need actual valid listing scan, never future evidence'
    last=max(scans);assert last>=start,'source scan is older than issue window'
    covered=min(last,end)
    if now>=end:assert last>=end,'after cutoff, actually scan the window end before finalizing'
    assert len(entries)>=10 or draft.get('coverageShortfallExplanation'),'shortfall needs concrete source/selection explanation'
    draft['coverageEnd']=covered.isoformat();draft['stage']='drafted' if covered==end and now>=end else 'precollected'
    draft['manuscriptReady']=True;draft['writerHandoffComplete']=True
    draft['review']={'independentReviewCompleted':False,'reviewer':None}
    draft['sourceScanAudit']=audit;draft['bodyHash']=digest(entries)
    draft['updatedAt']=now.isoformat()
    return draft
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--draft',required=True,type=Path);p.add_argument('--source-audit',required=True,type=Path);p.add_argument('--output',required=True,type=Path);a=p.parse_args()
    d=finalize(json.loads(a.draft.read_text()),json.loads(a.source_audit.read_text()))
    a.output.write_text(json.dumps(d,ensure_ascii=False,indent=2))
    print(json.dumps({'issueDate':d['issueDate'],'country':d['country'],'stage':d['stage'],'manuscriptReady':True,'articles':len(d['articles']),'independentReviewCompleted':False}))
