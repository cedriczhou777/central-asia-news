"""Stage already reviewed source bytes privately. Never creates a WeChat draft.

Input: {"images":[{"url":...,"sha256":...,"path":...,"bytes":...}]}
Paths may be relative to the manifest. SHA-256 comes from the actual review.
Optional --package attaches imageAssets to a NEW output package, preserving text.
"""
import argparse, concurrent.futures, hashlib, json, os, re, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

class ImageServiceError(ValueError):
    def __init__(self,status=None):
        self.status=status
        super().__init__('Image service HTTP '+str(status) if status is not None else 'Image service network timeout')

class CloudWindowClosed(ValueError):
    pass

def cloud_request_budget(request_timeout,manual=False,now=None):
    """Scheduled uploads never wake the service before its paid warm window.

    Stop new requests at 09:20, leaving ten minutes for accepted operations to
    settle before the photographed 09:30 warm-window end. This does not change
    the provider's billing or scaling settings.
    """
    if manual:return request_timeout
    now=(now or datetime.now(timezone.utc)).astimezone(timezone(timedelta(hours=8)))
    start=now.replace(hour=5,minute=50,second=0,microsecond=0)
    end=now.replace(hour=9,minute=20,second=0,microsecond=0)
    if not start<=now<end:
        raise CloudWindowClosed('Automatic cloud window closed: new image requests require 05:50–09:20 Beijing time; preserve progress without waking the service')
    return min(request_timeout,(end-now).total_seconds())

def wait_for_private_service(api,timeout_seconds=180,clock=time.monotonic,pause=time.sleep):
    started=clock();deadline=started+timeout_seconds;attempts=0
    while True:
        remaining=deadline-clock()
        if remaining<=0:raise ValueError('Private image service readiness timed out; no draft was created')
        attempts+=1
        try:
            result=api('GET','/api/wechat/push?health=1',request_timeout=min(15,remaining),attempts=1)
            images=result.get('images',{})
            if not(result.get('ok') is True and isinstance(images,dict)):
                raise ValueError('Private image storage is not ready or not private; no upload attempted')
            if images.get('ready') is True and images.get('private') is True:
                return {'ready':True,'attempts':attempts,'elapsedSeconds':round(clock()-started,3),
                        'serviceRelease':result.get('recovery',{}).get('version')}
            # A HTTP 200 health envelope can still report a transient storage
            # dependency failure. Retry reads only, within the same deadline;
            # known public/denied/misconfigured storage must fail immediately.
            transient=images.get('ready') is False and images.get('retryable') is True and images.get('failureKind') in ('network','timeout','service_unavailable')
            if not transient:
                raise ValueError('Private image storage is not ready or not private; no upload attempted')
        except ImageServiceError as error:
            if error.status is not None and not 500<=error.status<=599:raise
        remaining=deadline-clock()
        if remaining<=0:raise ValueError('Private image service readiness timed out; no draft was created')
        pause(min(5,remaining))

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest',required=True,type=Path)
    p.add_argument('--contract',type=Path)
    p.add_argument('--base-url')
    p.add_argument('--package',type=Path)
    p.add_argument('--output',type=Path)
    p.add_argument('--receipt',required=True,type=Path)
    p.add_argument('--ready-timeout',type=int,default=180)
    p.add_argument('--manual-outside-window',action='store_true',help='Only for an explicitly requested one-off manual recovery; never for scheduled runs')
    a=p.parse_args()
    contract=json.loads(a.contract.read_text()) if a.contract else {}
    base=(a.base_url or contract.get('base_url') or '').rstrip('/')
    secret=os.environ.get('INGEST_SECRET') or contract.get('ingest_secret')
    parsed=urlparse(base)
    if parsed.scheme!='https' or parsed.username or parsed.password or not secret:raise ValueError('HTTPS service URL and private ingest credential required')
    raw=json.loads(a.manifest.read_text());items=raw.get('images',[])
    if not isinstance(items,list) or len(items)>200:raise ValueError('Expected at most 200 reviewed images')
    if len({e['url'] for e in items})!=len(items):raise ValueError('Duplicate source URL in manifest')
    if not 1<=a.ready_timeout<=600:raise ValueError('ready-timeout must be between 1 and 600 seconds')
    def api(method,path,data=None,extra=None,request_timeout=60,attempts=3):
        headers={'X-Ingest-Secret':secret,**(extra or {})}
        for attempt in range(attempts):
            bounded_timeout=cloud_request_budget(request_timeout,manual=a.manual_outside_window)
            try:
                with urlopen(Request(base+path,data=data,headers=headers,method=method),timeout=bounded_timeout) as r:return json.load(r)
            except HTTPError as e:
                if e.code not in (500,502,503,504) or attempt==attempts-1:raise ImageServiceError(e.code) from None
            except (URLError,TimeoutError):
                if attempt==attempts-1:raise ImageServiceError() from None
            time.sleep(attempt+1)
    try:readiness=wait_for_private_service(api,a.ready_timeout) if items else {'required':False}
    except Exception as error:
        a.receipt.write_text(json.dumps({'ok':False,'images':[],'failures':[{'stage':'readiness','error':str(error)}],'createdDrafts':False},ensure_ascii=False,indent=2))
        raise
    def stage(e):
        url=e['url'];sha=e['sha256']
        if urlparse(url).scheme!='https' or not re.fullmatch('[a-f0-9]{64}',sha):raise ValueError('Invalid reviewed URL/hash')
        path=Path(e.get('path') or e.get('local_path') or '')
        if not path.is_absolute():path=a.manifest.parent/path
        if path.is_file():
            data=path.read_bytes()
            if not 0<len(data)<=10_000_000 or hashlib.sha256(data).hexdigest()!=sha:raise ValueError('Reviewed original byte identity mismatch')
            result=api('POST','/api/reviewed-images',data,{'Content-Type':'application/octet-stream','X-Content-Sha256':sha,'X-Source-Url':quote(url,safe='')})
            expected=len(data)
        else:
            expected=e.get('bytes')
            if not isinstance(expected,int) or not 0<expected<=10_000_000:raise ValueError('Reviewed local file missing and no prior stored byte length')
            result=api('GET',f'/api/reviewed-images?sha256={sha}&bytes={expected}')
        if not(result.get('ok') and result.get('ready') and result.get('private') and result.get('sha256')==sha and result.get('bytes')==expected):raise ValueError('Private persistent image readback failed')
        return {'url':url,'sha256':sha,'bytes':expected,'ready':True,'private':True}
    results=[];failures=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        jobs={pool.submit(stage,e):e for e in items}
        for future in concurrent.futures.as_completed(jobs):
            e=jobs[future]
            try:results.append(future.result())
            except Exception as error:failures.append({'url':e.get('url'),'error':str(error)[:180]})
    receipt={'ok':not failures,'images':results,'failures':failures,'createdDrafts':False,'readiness':readiness}
    a.receipt.write_text(json.dumps(receipt,ensure_ascii=False,indent=2))
    if failures:raise ValueError(f'{len(failures)} images not staged; see receipt. No package submitted')
    if a.package:
        if not a.output or a.output.resolve()==a.package.resolve():raise ValueError('Choose a separate output package path')
        from html.parser import HTMLParser
        class Images(HTMLParser):
            def __init__(self):super().__init__();self.urls=[]
            def handle_starttag(self,tag,attrs):
                if tag=='img':self.urls.append(dict(attrs).get('src'))
        package=json.loads(a.package.read_text());mapping={e['url']:{'sha256':e['sha256'],'bytes':e['bytes']} for e in results}
        for country in package['countries'].values():
            html=Images();html.feed(country['bodyHtml'])
            if any(url not in mapping for url in html.urls):raise ValueError('Package references an unstaged image')
            country['imageAssets']={url:mapping[url] for url in html.urls}
        a.output.write_text(json.dumps(package,ensure_ascii=False,indent=2))
    print(json.dumps({'ok':True,'staged':len(results),'private':True,'createdDrafts':False},ensure_ascii=False))
if __name__=='__main__':
    try:main()
    except Exception as e:raise SystemExit(str(e))
