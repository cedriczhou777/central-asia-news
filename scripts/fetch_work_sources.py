"""Batch fetch public source HTML with validated decoding and bounded retries."""
import argparse,concurrent.futures,gzip,hashlib,json,re,sys,time,zlib
from datetime import datetime,timezone
from pathlib import Path
from urllib.parse import urljoin,urlparse
import urllib.request,urllib.error
from lxml import html
P=Path(__file__).parent;S=P/'sources';S.mkdir(exist_ok=True)
PARSER_VERSION='source-html-v12'
TRANSIENT={500,502,503,504}
def decode_transport(raw,encoding=''):
    encoding=encoding.lower().strip()
    if raw.startswith(b'\x1f\x8b') or encoding=='gzip':return gzip.decompress(raw)
    if encoding=='deflate':
        try:return zlib.decompress(raw)
        except zlib.error:return zlib.decompress(raw,-zlib.MAX_WBITS)
    if encoding not in ('','identity'):raise ValueError('unsupported_content_encoding_'+encoding)
    return raw
def parse_response(url,final_url,raw,headers):
    decoded=decode_transport(raw,headers.get('content-encoding',''))
    if len(decoded)>20_000_000:raise ValueError('decompressed_HTML_exceeds_20MB')
    if b'<html' not in decoded[:5000].lower() and b'<!doctype' not in decoded[:5000].lower():
        raise ValueError('response_is_not_HTML')
    tree=html.fromstring(decoded,base_url=final_url);meta={}
    for n in tree.xpath('//meta[@content]'):
        k=n.get('property') or n.get('name')
        if k:meta[k]=n.get('content')
    headings=[' '.join(n.text_content().split()) for n in tree.xpath('//h1') if len(' '.join(n.text_content().split()))<500]
    title=meta.get('og:title') or next((t for t in headings if t),'') or ''.join(tree.xpath('//title/text()'))
    times=[{'text':n.text_content(),'datetime':n.get('datetime')} for n in tree.xpath('//time')]
    linked_data=[n.text for n in tree.xpath('//script[@type="application/ld+json"]')]
    links=[{'text':' '.join(n.text_content().split()),'url':urljoin(final_url,n.get('href'))} for n in tree.xpath('//a[@href]') if n.text_content().strip()]
    images=[{'url':urljoin(final_url,n.get('src') or n.get('data-src') or ''),'alt':n.get('alt'),'title':n.get('title')} for n in tree.xpath('//img')]
    for n in tree.xpath('//script|//style|//nav|//header|//footer|//aside|//noscript|//iframe|//svg'):n.drop_tree()
    candidates=tree.xpath('//article') or tree.xpath('//main') or [tree]
    el=max(candidates,key=lambda n:len(n.text_content()))
    text='\n'.join(' '.join(t.split()) for t in el.itertext() if t.strip())
    if len(text)<80 or '\ufffd' in text[:100]:raise ValueError('unreadable_or_empty_HTML')
    path=urlparse(final_url).path.strip('/')
    listing=path in ('','ru','rus','uz','en','kg') or any(x in path.split('/') for x in ('category','tag','categories','archive','archives'))
    article=(not listing) and (meta.get('og:type')=='article' or bool(meta.get('article:published_time')) or any('"NewsArticle"' in (s or '') or '"Article"' in (s or '') for s in linked_data))
    return {'meta':meta,'title':title,'time_tags':times,'linked_data':linked_data,'links':links,'images':images,'text':text,'source_sha256':hashlib.sha256(text.encode()).hexdigest(),'source_kind':'article' if article else 'listing','parser_version':PARSER_VERSION,'contentValidated':True,'transport_sha256':hashlib.sha256(raw).hexdigest()}
def fetch(url):
    key=hashlib.sha256(url.encode()).hexdigest()[:18];dest=S/(key+'.json');archive=S/(key+'.html.gz')
    now=datetime.now(timezone.utc)
    if dest.exists():
        old=json.loads(dest.read_text());status=old.get('status')
        if status in (401,403,404,410):return old
        if status==200 and archive.exists() and old.get('parser_version')!=PARSER_VERSION:
            try:
                raw=gzip.open(archive,'rb').read();old.update(parse_response(url,old.get('final_url',url),raw,old.get('response_headers',{})));old.pop('error',None);dest.write_text(json.dumps(old,ensure_ascii=False,indent=2))
            except Exception as error:
                old['contentValidated']=False;old['error']='cached_parse_'+str(error);dest.write_text(json.dumps(old,ensure_ascii=False,indent=2));return old
        if status==200 and old.get('contentValidated'):
            # Article evidence is immutable for this run; listings must advance after midnight.
            if old.get('source_kind')=='article':return old
            try:age=(now-datetime.fromisoformat(old['fetchedAt'])).total_seconds()
            except (KeyError,ValueError):age=10**9
            if age<900:return old
    result={'url':url,'fetchedAt':now.isoformat(),'key':key,'contentValidated':False,'parser_version':PARSER_VERSION}
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url,timeout=25) as response:
                raw=response.read(10_000_001);status=response.status;final_url=response.url
                headers={k.lower():v for k,v in response.headers.items() if k.lower() in ('content-encoding','content-type','etag','last-modified')}
            result.update(status=status,final_url=final_url,response_headers=headers,attempts=attempt+1)
            if len(raw)>10_000_000:raise ValueError('transport_exceeds_10MB')
            gzip.open(archive,'wb').write(raw)
            result.update(parse_response(url,final_url,raw,headers));break
        except urllib.error.HTTPError as error:
            result.update(status=error.code,error='source_http_'+str(error.code),attempts=attempt+1)
            if error.code not in TRANSIENT or attempt==2:break
        except (urllib.error.URLError,TimeoutError) as error:
            result.update(error=type(error).__name__+': '+str(error)[:120],attempts=attempt+1)
            if attempt==2:break
        except Exception as error:
            result.update(error=type(error).__name__+': '+str(error)[:120]);break
        time.sleep(attempt+1)
    if result.get('contentValidated'):result.pop('error',None)
    dest.write_text(json.dumps(result,ensure_ascii=False,indent=2));return result
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--audit',type=Path);args=parser.parse_args()
    urls=json.load(sys.stdin)
    if not isinstance(urls,list) or not all(isinstance(u,str) and urlparse(u).scheme in ('http','https') for u in urls):raise SystemExit('expected_public_URL_array')
    records=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for r in pool.map(fetch,dict.fromkeys(urls)):
            records.append({'url':r.get('url'),'fetchedAt':r.get('fetchedAt'),'status':r.get('status'),'contentValidated':r.get('contentValidated',False),'kind':r.get('source_kind','unknown'),'error':r.get('error')})
            print(json.dumps({k:r.get(k) for k in ['url','key','fetchedAt','source_kind','status','contentValidated','title','error','attempts']},ensure_ascii=False),flush=True)
    if args.audit:args.audit.write_text(json.dumps(records,ensure_ascii=False,indent=2))
