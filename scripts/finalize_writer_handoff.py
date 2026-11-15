"""Validate writer handoff readiness without certifying independent review."""
import argparse,hashlib,json,re
from datetime import datetime,timedelta,timezone
from pathlib import Path
from PIL import Image
from work_quantity_policy import evaluate_quantity

def dt(value):
    if not isinstance(value,str) or not value:raise ValueError('valid timezone-aware timestamp required')
    result=datetime.fromisoformat(value.replace('Z','+00:00'))
    if result.tzinfo is None:raise ValueError('timezone required')
    return result
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def restore_image_paths(draft,image_root,now=None):
    """Rebind extracted originals using their existing manifest and byte proofs.

    Only local recovery metadata changes. The existing all-fields handoff hash
    remains authoritative, so a path change explicitly needs review rebinding.
    No visual-review flag, source URL, image hash or article text is invented.
    """
    now=now or datetime.now(timezone.utc)
    root=Path(image_root).resolve()
    if not root.is_dir():raise ValueError('image-root must be the extracted image package directory')
    entries=[e for e in draft.get('articles',[]) if e.get('image_url')]
    if not entries:return {'reboundImages':0,'reviewRebindingRequired':False}
    manifest_path=root/'manifest.json'
    if not manifest_path.is_file() or manifest_path.is_symlink():raise ValueError('image-root needs a regular manifest.json')
    if manifest_path.stat().st_size>2_000_000:raise ValueError('image manifest is too large')
    document=json.loads(manifest_path.read_text())
    images=document.get('images') if isinstance(document,dict) else None
    if not isinstance(images,list) or len(images)>200:raise ValueError('image manifest requires at most 200 images')
    by_url={}
    for image in images:
        if not isinstance(image,dict) or not isinstance(image.get('url'),str):raise ValueError('invalid image manifest entry')
        if image['url'] in by_url:raise ValueError('ambiguous duplicate image URL in manifest')
        by_url[image['url']]=image

    def safe_path(value):
        if not isinstance(value,str) or not value or '\\' in value or '\x00' in value:raise ValueError('unsafe image manifest path')
        path=Path(value)
        if '..' in path.parts:raise ValueError('unsafe image manifest traversal')
        if path.is_absolute():
            # A producer's old absolute directory is not a path to read here.
            # Rebase only the documented images/... suffix inside this package.
            markers=[i for i,part in enumerate(path.parts) if part=='images']
            if not markers:raise ValueError('absolute image path has no portable images suffix')
            path=Path(*path.parts[markers[-1]:])
        target=root/path
        current=root
        for part in path.parts:
            current=current/part
            if current.is_symlink():raise ValueError('image manifest symlink is not allowed')
        target=target.resolve()
        if not target.is_relative_to(root):raise ValueError('image manifest path escapes image-root')
        return target

    bindings=[]
    for entry in entries:
        sha=entry.get('image_sha256');size=entry.get('image_bytes')
        if not re.fullmatch('[a-f0-9]{64}',str(sha or '')) or not isinstance(size,int) or isinstance(size,bool) or not 0<size<=10_000_000:
            raise ValueError(entry.get('id','?')+': existing adopted image hash/length required')
        image=by_url.get(entry['image_url'])
        if not image or image.get('sha256')!=sha or image.get('bytes')!=size:
            raise ValueError(entry.get('id','?')+': manifest does not match adopted URL/hash/length')
        value=image.get('path') or image.get('local_path')
        if value:
            target=safe_path(value)
        else:
            target=safe_path('images/'+sha)
        if not target.is_file():raise ValueError(entry.get('id','?')+': restored image bytes are missing')
        if target.stat().st_size!=size or hashlib.sha256(target.read_bytes()).hexdigest()!=sha:
            raise ValueError(entry.get('id','?')+': restored image byte identity mismatch')
        bindings.append((entry,str(target)))
    before=digest(draft['articles'])
    editorial_before=digest([{k:v for k,v in e.items() if k!='image_local_path'} for e in draft['articles']])
    changed=sum(entry.get('image_local_path')!=path for entry,path in bindings)
    for entry,path in bindings:entry['image_local_path']=path
    after=digest(draft['articles'])
    editorial_after=digest([{k:v for k,v in e.items() if k!='image_local_path'} for e in draft['articles']])
    assert editorial_before==editorial_after,'image recovery changed editorial content'
    receipt={'restoredAt':now.isoformat(),'reboundImages':changed,'previousHandoffHash':before,
             'restoredHandoffHash':after,'editorialContentHash':editorial_after,
             'editorialContentChanged':False,'reviewRebindingRequired':before!=after,
             'note':'Local paths only; old all-fields review hashes are not silently rewritten'}
    if before!=after:
        draft.setdefault('imagePathRestoreHistory',[]).append(receipt)
        review=dict(draft.get('review') or {})
        review.update(independentReviewCompleted=False,reviewer=None)
        draft['review']=review
    draft['imagePathRestore']=receipt
    return receipt

def finalize(draft,audit,now=None,image_root=None):
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
    if image_root is not None:restore_image_paths(draft,image_root,now)
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
    draft['coverageEnd']=covered.isoformat();draft['stage']='drafted' if covered==end and now>=end else 'precollected'
    draft['manuscriptReady']=True;draft['writerHandoffComplete']=True
    # Preserve unresolved review issues and their original wording. A useful small
    # manuscript can be handed over, but cannot silently become a complete issue.
    review=dict(draft.get('review') or {})
    review.update(independentReviewCompleted=False,reviewer=None)
    draft['review']=review
    draft['sourceScanAudit']=audit;draft['bodyHash']=digest(entries)
    draft.update(evaluate_quantity(draft,audit,now))
    draft['updatedAt']=now.isoformat()
    return draft
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--draft',required=True,type=Path);p.add_argument('--source-audit',required=True,type=Path);p.add_argument('--output',required=True,type=Path);p.add_argument('--image-root',type=Path,help='Safely extracted original-image package with manifest.json; rebind paths using existing URL/hash/length proofs');a=p.parse_args()
    d=finalize(json.loads(a.draft.read_text()),json.loads(a.source_audit.read_text()),image_root=a.image_root)
    a.output.write_text(json.dumps(d,ensure_ascii=False,indent=2))
    print(json.dumps({'issueDate':d['issueDate'],'country':d['country'],'stage':d['stage'],'manuscriptReady':True,'articles':len(d['articles']),'independentReviewCompleted':False,'quantityStatus':d['quantityStatus'],'quantityReady':d['quantityReady'],'qualityDeliveryComplete':d['qualityDeliveryComplete'],'shortfallOpen':d['shortfallOpen'],'sourceCoverage':d['sourceCoverage'],'candidateLedgerValidation':d['candidateLedgerValidation']}))
