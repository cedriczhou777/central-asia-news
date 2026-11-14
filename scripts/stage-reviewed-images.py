"""Stage already reviewed source bytes privately. Never creates a WeChat draft.

Input: {"images":[{"url":...,"sha256":...,"path":...,"bytes":...}]}
Paths may be relative to the manifest. SHA-256 comes from the actual review.
Optional --package attaches imageAssets to a NEW output package, preserving text.
"""
import argparse, concurrent.futures, hashlib, json, os, re, time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest',required=True,type=Path)
    p.add_argument('--contract',type=Path)
    p.add_argument('--base-url')
    p.add_argument('--package',type=Path)
    p.add_argument('--output',type=Path)
    p.add_argument('--receipt',required=True,type=Path)
    a=p.parse_args()
    contract=json.loads(a.contract.read_text()) if a.contract else {}
    base=(a.base_url or contract.get('base_url') or '').rstrip('/')
    secret=os.environ.get('INGEST_SECRET') or contract.get('ingest_secret')
    parsed=urlparse(base)
    if parsed.scheme!='https' or parsed.username or parsed.password or not secret:raise ValueError('HTTPS service URL and private ingest credential required')
    raw=json.loads(a.manifest.read_text());items=raw.get('images',[])
    if not isinstance(items,list) or len(items)>200:raise ValueError('Expected at most 200 reviewed images')
    if len({e['url'] for e in items})!=len(items):raise ValueError('Duplicate source URL in manifest')
    def api(method,path,data=None,extra=None):
        headers={'X-Ingest-Secret':secret,**(extra or {})}
        for attempt in range(3):
            try:
                with urlopen(Request(base+path,data=data,headers=headers,method=method),timeout=60) as r:return json.load(r)
            except HTTPError as e:
                if e.code not in (500,502,503,504) or attempt==2:raise ValueError('Image service HTTP '+str(e.code)) from None
            except (URLError,TimeoutError):
                if attempt==2:raise ValueError('Image service network timeout') from None
            time.sleep(attempt+1)
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
    receipt={'ok':not failures,'images':results,'failures':failures,'createdDrafts':False}
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
