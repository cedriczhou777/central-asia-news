"""Offline structure and narrow numeric-unit gate; sends no requests.
Input: {issueDate,drafts:{kz:...},reviews:{kz:...},package:{version,countries:{...}}}.
Exit 0 only if all checks pass. Real source reading and independent review remain required.
"""
import argparse,copy,hashlib,html,json,re,sys,unicodedata
from decimal import Decimal,InvalidOperation
from datetime import date,datetime,timedelta,timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit,urlunsplit,parse_qsl,urlencode
COUNTRIES=('kz','uz','kg','tj','az')
NUM=r'\d+(?:[ \u00a0\u202f,]\d{3})*(?:[.,]\d+)?'
def number(raw,decimal_comma=False):
 raw=re.sub(r'[\s\u00a0\u202f]','',raw)
 if ',' in raw:
  raw=raw.replace(',','.') if decimal_comma else raw.replace(',','')
 try:return Decimal(raw)
 except InvalidOperation:return None
def numeric_unit_errors(source,target,field=None):
 """Fail only high-confidence patterns; not a general fact verifier.

 Multi-amount currencies and unknown syntax deliberately remain manual review.
 No automatic repairs, no bypass based on self-reported review flags.
 """
 source=unicodedata.normalize('NFKC',source or '')
 target=unicodedata.normalize('NFKC',target or '')
 errors=[]
 # Headlines must stand alone. Body paragraphs can carry an already stated currency.
 if field=='title' and re.search(r'(?:营业额|投资额|投资|收入|预算|融资|费用|赠款|贷款|资本|市值|估值|利润|资产)[^\d。；!?]{0,10}'+NUM+r'\s*(?:万亿|亿|万|千)(?=的|[，,、。；;:：]|$)',target):
  errors.append('headline monetary amount missing currency unit')
 capacity=[('school',r'(?:школ\w*[^.!?\n]{0,60}?на\s+('+NUM+r')\s+(?:ученических\s+|учебных\s+)?мест|school\b[^.!?\n]{0,60}?(?:for|with|capacity\s+of)\s+('+NUM+r')\s+(?:students|pupils|seats))',r'(?:座|所|间)\s*(?:新)?学校'),('hospital',r'(?:больниц\w*[^.!?\n]{0,60}?на\s+('+NUM+r')\s+ко[её]к|hospital\b[^.!?\n]{0,60}?(?:with|for|capacity\s+of)\s+('+NUM+r')\s+beds)',r'(?:家|座|所)\s*医院')]
 for entity,pattern,wrong_unit in capacity:
  for m in re.finditer(pattern,source,re.I):
   n=number(next(x for x in m.groups() if x))
   if n is None or n!=n.to_integral() or n<=1:continue
   # Do not infer an error where the source also explicitly counts that many buildings.
   if re.search(re.escape(str(n))+r'\s+(?:schools\b|hospitals\b|школ\b|больниц\b)',source,re.I):continue
   for cm in re.finditer('('+NUM+r')\s*'+wrong_unit,target):
    if number(cm.group(1))==n:errors.append(f'{entity} capacity {n} mistranslated as building count')
 currency_codes=[('JPY',r'(?:японских\s+иен|иен|Japanese\s+yen|yen|JPY)',r'(?:日元|日圆|JPY)'),('USD',r'(?:долларов(?:\s+США)?|US\s+dollars|U\.S\.\s+dollars|dollars|USD)',r'(?:美元|美金|USD)'),('EUR',r'(?:евро|euros?|EUR)',r'(?:欧元|EUR)')]
 scale=r'(thousand|million|billion|тыс\.?|млн\.?|млрд\.?)'
 for code,original_unit,chinese_unit in currency_codes:
  amounts=set()
  for m in re.finditer('('+NUM+r')\s*'+scale+r'\s*'+original_unit,source,re.I):
   s=m.group(2).lower().rstrip('.');n=number(m.group(1),decimal_comma=bool(re.search('[а-я]',s)))
   if n is not None:amounts.add(n*({'thousand':1000,'тыс':1000,'million':1000000,'млн':1000000,'billion':1000000000,'млрд':1000000000}[s]))
  if len(amounts)!=1:continue
  expected=next(iter(amounts))
  if expected<=0:continue
  for m in re.finditer('('+NUM+r')\s*(万亿|亿|万|千)?\s*'+chinese_unit,target,re.I):
   n=number(m.group(1))
   if n is None:continue
   actual=n*{None:1,'千':1000,'万':10000,'亿':100000000,'万亿':1000000000000}[m.group(2)]
   ratio=actual/expected
   if ratio>=5 or ratio<=Decimal('0.2'):errors.append(f'{code} amount scale mismatch: source={expected}, target={actual}')
 source_power=[];source_energy=[];source_invalid=[]
 for m in re.finditer('('+NUM+r')\s*(кВт/ч|кВт·ч|МВт·ч|кВт|МВт|kWh|MWh|kW|MW)\b',source,re.I):
  unit=m.group(2).lower();n=number(m.group(1),decimal_comma=bool(re.search('[а-я]',unit)))
  if n is None:continue
  base=1000 if unit in ('мвт','mw','мвт·ч','mwh') else 1
  (source_invalid if unit=='квт/ч' else source_energy if unit in ('квт·ч','мвт·ч','kwh','mwh') else source_power).append(n*base)
 for m in re.finditer('('+NUM+r')\s*(兆瓦时|千瓦时|兆瓦|千瓦|MWh|kWh|MW|kW)',target,re.I):
  unit=m.group(2).lower();n=number(m.group(1))
  if n is None:continue
  n*=1000 if unit in ('兆瓦','兆瓦时','mw','mwh') else 1
  energy=unit in ('兆瓦时','千瓦时','mwh','kwh')
  if n in source_invalid and n not in source_power+source_energy:errors.append('ambiguous source power unit silently normalized')
  elif energy and n in source_power and n not in source_energy:errors.append('power capacity mistranslated as energy')
  elif not energy and n in source_energy and n not in source_power:errors.append('energy mistranslated as power capacity')
 return list(dict.fromkeys(errors))
def translation_errors(source,target):
 """Narrow role mismatch only; ambiguous multi-role sources remain human review."""
 source=unicodedata.normalize('NFKC',source or '')
 target=unicodedata.normalize('NFKC',target or '')
 executive=re.search(r'председател\w*\s+правления|chair(?:man|person)?\s+of\s+(?:the\s+)?management\s+board',source,re.I)
 directors=re.search(r'совет\w*\s+директор\w*|board\s+of\s+directors',source,re.I)
 if executive and not directors and '董事会主席' in target:
  return ['management board chair mistranslated as board of directors chair']
 return []
def editorial_remnants(text):
 # Do not reject ordinary business instructions containing 核对/复核.
 return bool(re.search(r'待核实|建议核对|编辑注意|本稿|本条.{0,12}按.{0,30}表述|独审时|正文不据此|原稿未列|不能写成|不写成|不能扩写为',text or ''))
def digest(value):
 if isinstance(value,list):value=[{k:v for k,v in item.items() if k!='cloudImageProbe'} if isinstance(item,dict) else item for item in value]
 return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def story_source_key(url):
 parts=urlsplit(url)
 query=[(k,v) for k,v in parse_qsl(parts.query,keep_blank_values=True) if not k.lower().startswith('utm_') and k.lower() not in ('fbclid','gclid','_ga')]
 return urlunsplit((parts.scheme.lower(),parts.netloc.lower(),parts.path,urlencode(sorted(query)),''))
class Markup(HTMLParser):
 def __init__(self):super().__init__();self.images=[];self.styles=[];self.text=[]
 def handle_starttag(self,tag,attrs):
  a=dict(attrs)
  if tag=='img':self.images.append(a.get('src',''))
  if tag=='p':self.styles.append(a.get('style','').replace(' ',''))
 def handle_data(self,data):self.text.append(data)
def country_scope(countries=None):
 """A partial transport scope must be requested explicitly; default is all five."""
 if countries is None:return COUNTRIES
 if not isinstance(countries,(list,tuple)) or not countries or any(not isinstance(c,str) or c not in COUNTRIES for c in countries) or len(set(countries))!=len(countries):
  raise ValueError('countries must be a nonempty unique list of known country codes')
 return tuple(c for c in COUNTRIES if c in countries)
def quantity_report(data,now=None,countries=None):
 """Recompute supply/selection coverage; never trust a ready flag in a draft."""
 if str(data.get('issueDate',''))<'2026-11-16':return {}
 try:from work_quantity_policy import evaluate_quantity
 except ImportError:return {c:{'quantityReady':False,'quantityStatus':'needs_expansion','shortfallOpen':True,'error':'work_quantity_policy helper missing'} for c in country_scope(countries)}
 result={}
 for code in country_scope(countries):
  draft=copy.deepcopy(data.get('drafts',{}).get(code,{}));review=data.get('reviews',{}).get(code,{})
  draft['articles']=review.get('articles',[])
  for key in ('candidateLedger','quantityExceptionReview'):
   if key in review:draft[key]=copy.deepcopy(review[key])
  # A reviewer may extend the evidence, but never replace the author's scan history.
  scans=[];seen=set()
  for scan in draft.get('sourceScanAudit',[])+review.get('sourceScanAudit',[]):
   identity=json.dumps(scan,sort_keys=True,ensure_ascii=False)
   if identity not in seen:scans.append(scan);seen.add(identity)
  try:
   result[code]=evaluate_quantity(draft,scans,now=now)
   exception=draft.get('quantityExceptionReview')
   if 10<=len(draft['articles'])<15 and (not isinstance(exception,dict) or exception.get('reviewer')!=review.get('reviewer')):
    result[code].update(quantityReady=False,quantityStatus='needs_expansion',shortfallOpen=True,error='quantity exception must be approved by the actual independent reviewer')
  except (TypeError,ValueError,KeyError,AssertionError) as error:
   result[code]={'quantityReady':False,'quantityStatus':'needs_expansion','shortfallOpen':True,'error':str(error)}
 return result
def validate(data,require_cloud_images=True,now=None,delivery_mode='normal',countries=None):
 errors=[]
 def check(ok,message):
  if not ok:errors.append(message)
 try:scope=country_scope(countries)
 except ValueError as error:return [str(error)]
 issue=data.get('issueDate','')
 try:
  d=date.fromisoformat(issue);tz=timezone(timedelta(hours=8))
  end=datetime.combine(d,datetime.min.time(),tz)+timedelta(hours=6);start=end-timedelta(days=1)
 except (ValueError,TypeError):return ['invalid issueDate']
 current=now or datetime.now(timezone.utc)
 check(delivery_mode in ('normal','deadline_under_delivery'),'invalid delivery mode')
 under_delivery=delivery_mode=='deadline_under_delivery'
 if under_delivery:check(current>=end+timedelta(hours=1,minutes=30),'under-delivery fallback is only available from real 07:30 Beijing time')
 quantities=quantity_report(data,now=current,countries=scope)
 check(end <= (now or datetime.now(timezone.utc)), 'issue cutoff has not elapsed')
 pack=data.get('package',{});drafts=data.get('drafts',{});reviews=data.get('reviews',{})
 declared=pack.get('readyCountries')
 if countries is not None or 'readyCountries' in pack:
  try:declared_scope=country_scope(declared) if declared is not None else ()
  except ValueError:declared_scope=()
  check(declared_scope==scope,'package.readyCountries must exactly match the explicitly selected countries')
 check(re.fullmatch(re.escape(issue)+r'(?:-r(?:[2-9]|[1-9]\d+))?',str(pack.get('version',''))) is not None,'package issue/version mismatch')
 for name,value in [('drafts',drafts),('reviews',reviews),('package.countries',pack.get('countries',{}))]:
  check(isinstance(value,dict) and set(value)==set(scope),name+(': require exactly five countries' if countries is None else ': require exactly the selected countries'))
 for code in scope:
  draft=drafts.get(code,{});review=reviews.get(code,{});country=pack.get('countries',{}).get(code,{})
  prefix=code+': '
  check(draft.get('issueDate')==issue and draft.get('country')==code,prefix+'draft identity mismatch')
  for field,expected in [('windowStart',start),('windowEnd',end),('coverageEnd',end)]:
   try:valid=datetime.fromisoformat(draft.get(field,''))==expected
   except (ValueError,TypeError):valid=False
   check(valid,prefix+field+' mismatch')
  check(review.get('issueDate')==issue and review.get('country')==code,prefix+'review identity mismatch')
  check(review.get('stage')=='verified',prefix+'not independently verified')
  check(bool(draft.get('writerRun')) and bool(review.get('reviewer')) and review.get('reviewer')!=draft.get('writerRun'),prefix+'independent reviewer identity required')
  check(review.get('originalHash')==digest(draft.get('articles',[])),prefix+'review does not match current draft')
  entries=review.get('articles',[])
  check(isinstance(entries,list) and 0<len(entries)<=20,prefix+'invalid article count')
  if not isinstance(entries,list):continue
  ids=[e.get('id') for e in entries if isinstance(e,dict)]
  urls=[story_source_key(e.get('source_url','')) for e in entries if isinstance(e,dict) and isinstance(e.get('source_url'),str)]
  check(len(ids)==len(entries) and len(set(map(str,ids)))==len(entries),prefix+'duplicate adopted article IDs')
  check(len(urls)==len(entries) and len(set(urls))==len(entries),prefix+'duplicate adopted source URLs')
  check(review.get('finalBodyHash')==digest(entries),prefix+'final content hash mismatch')
  check(review.get('fullSourceReviewCompleted') is True,prefix+'independent full-source review incomplete')
  if issue < '2026-11-20':
   check(review.get('revisedFullTextRechecked') is True,prefix+'legacy revised full-text check incomplete')
  if issue>='2026-11-14':
   check(review.get('titleFactReviewCompleted') is True,prefix+'separate title fact review incomplete')
   check(review.get('bodyFactReviewCompleted') is True,prefix+'separate body fact review incomplete')
  check(isinstance(review.get('issues'),list) and all(i.get('closed') is True or (under_delivery and i.get('kind')=='quantity_shortfall') for i in review.get('issues',[])),prefix+'unclosed or missing review issues')
  if issue>='2026-11-16':
   if under_delivery:check(len(entries)>=10,prefix+'deadline transport requires at least ten real reviewed stories; continue source expansion')
   else:check(quantities.get(code,{}).get('quantityReady') is True,prefix+'quantity/coverage/selection incomplete; continue source expansion')
  else:check(len(entries)>=10 or bool(review.get('coverageShortfallExplanation')),prefix+'shortfall coverage explanation required')
  for i,e in enumerate(entries):
   item=prefix+str(i+1)+': '
   check(all(isinstance(e.get(k),str) and bool(e.get(k).strip()) for k in ['id','title','body','category','source','source_url','original_full_text','timeEvidence','firstPublicationCheck']),item+'missing full source/text/time evidence')
   if issue>='2026-11-17':
    # Reviewers can revise entries and rehash them after writer finalization.
    # Recheck the actual transported entries, including deadline fallback.
    published=None;value=e.get('published_at')
    if isinstance(value,str) and value.strip():
     try:published=datetime.fromisoformat(value.replace('Z','+00:00'))
     except ValueError:pass
    valid_time=published is not None and published.tzinfo is not None
    check(valid_time,item+'publication time must be a valid timezone-aware timestamp')
    if valid_time:
     check(start<=published<end,item+'publication outside issue window')
     check(published<=current,item+'future publication')
   check(e.get('source_url','').startswith('https://'),item+'invalid source URL')
   if issue>='2026-11-20':
    from source_attribution import source_name_error
    error=source_name_error(e)
    check(error is None,item+(error or ''))
   check(not editorial_remnants(e.get('body','')),item+'editorial remnant')
   for field in ('title','body'):
    for error in numeric_unit_errors(e.get('original_full_text',''),e.get(field,''),field=field):
     errors.append(item+field+': '+error)
    for error in translation_errors(e.get('original_full_text',''),e.get(field,'')):
     errors.append(item+field+': '+error)
   if e.get('image_url'):
    check(e['image_url'].startswith('https://'),item+'image URL invalid')
    if issue<'2026-11-20':check(bool(e.get('image_caption')),item+'historical image caption missing')
    if require_cloud_images:check(e.get('cloudImageProbe',{}).get('accessible') is True,item+'cloud image not verified')
   else:check(bool(e.get('imageUnavailableReason')),item+'missing image search/unavailability record')
  check(country.get('sourceUrl')=='',prefix+'original link must be empty')
  check(0<len(country.get('title',''))<=60,prefix+'invalid title length')
  check(0<len(country.get('summary',''))<=120,prefix+'invalid summary length')
  body=country.get('bodyHtml','');markup=Markup();markup.feed(body)
  expected_images=[e['image_url'] for e in entries if e.get('image_url')]
  check(markup.images==expected_images,prefix+'images missing/reordered')
  check(not expected_images or country.get('coverUrl')==expected_images[0],prefix+'cover does not match first body image')
  visible=''.join(markup.text)
  for e in entries:
   check(e.get('title','') in visible,prefix+'title missing from HTML')
   for para in e.get('body','').splitlines():
    if para.strip():check(para.strip() in visible,prefix+'body missing/modified in HTML')
  body_styles=[s for s in markup.styles if 'font-size:16px' in s]
  check(bool(body_styles) and all('text-align:justify' in s and 'text-align-last:left' in s for s in body_styles),prefix+'body justification missing')
  compact=body.replace(' ','')
  check('padding:010px20px' in compact and 'padding:20px12px' in compact,prefix+'mobile margins mismatch')
  check(f'{d.year}年{d.month}月{d.day}日' in visible,prefix+'display date mismatch')
 return errors
def fixture():
 data={'issueDate':'2026-11-12','drafts':{},'reviews':{},'package':{'version':'2026-11-12','countries':{}}}
 for code in COUNTRIES:
  e={'id':code+'01','title':'测试标题','body':'测试正文，仅供结构验证。','category':'测试','source':'test fixture','source_url':'https://example.com/test','original_full_text':'Synthetic test fixture, not news.','timeEvidence':'test only','firstPublicationCheck':'test only','image_url':'','imageUnavailableReason':'test only'}
  draft={'issueDate':data['issueDate'],'country':code,'writerRun':'writer-test','windowStart':'2026-11-11T06:00:00+08:00','windowEnd':'2026-11-12T06:00:00+08:00','coverageEnd':'2026-11-12T06:00:00+08:00','articles':[e]}
  review={'issueDate':data['issueDate'],'country':code,'reviewer':'reviewer-test','stage':'verified','originalHash':digest([e]),'articles':[e],'finalBodyHash':digest([e]),'issues':[],'fullSourceReviewCompleted':True,'revisedFullTextRechecked':True,'coverageShortfallExplanation':'synthetic test only'}
  data['drafts'][code]=copy.deepcopy(draft);data['reviews'][code]=copy.deepcopy(review)
  data['package']['countries'][code]={'title':'测试标题','summary':'测试摘要','sourceUrl':'','coverUrl':'','bodyHtml':'<section style="padding:0 10px 20px"><section style="padding:20px 12px"><p>2026年11月12日</p><p>测试标题</p><p style="font-size:16px;text-align:justify;text-align-last:left">测试正文，仅供结构验证。</p></section></section>'}
 return data
def selftest():
 good=fixture();assert not validate(good),validate(good)
 assert 'issue cutoff has not elapsed' in validate(good,now=datetime.fromisoformat('2026-11-12T05:59:00+08:00'))
 cases=[]
 def bad(name,mutate):
  d=copy.deepcopy(good);mutate(d);assert validate(d),name;cases.append(name)
 bad('missing country',lambda d:d['package']['countries'].pop('tj'))
 bad('stale issue',lambda d:d['package'].update(version='2026-11-11'))
 bad('unreviewed draft',lambda d:d['reviews']['kz'].update(stage='reviewing'))
 bad('same author/reviewer',lambda d:d['reviews']['kz'].update(reviewer='writer-test'))
 bad('draft changed after review',lambda d:d['drafts']['kz']['articles'][0].update(body='changed'))
 bad('final changed after review',lambda d:d['reviews']['kz']['articles'][0].update(body='changed'))
 bad('window mismatch',lambda d:d['drafts']['kz'].update(coverageEnd='2026-11-12T05:00:00+08:00'))
 bad('unclosed issue',lambda d:d['reviews']['kz'].update(issues=[{'closed':False}]))
 bad('original link',lambda d:d['package']['countries']['kz'].update(sourceUrl='https://example.com'))
 bad('left aligned body',lambda d:d['package']['countries']['kz'].update(bodyHtml=d['package']['countries']['kz']['bodyHtml'].replace('text-align:justify','text-align:left')))
 bad('missing/reordered image',lambda d:d['package']['countries']['kz'].update(bodyHtml=d['package']['countries']['kz']['bodyHtml']+'<img src="https://example.com/test.jpg">'))
 imaged=copy.deepcopy(good)
 for c in COUNTRIES:
  e=imaged['reviews'][c]['articles'][0];e.update(image_url='https://example.com/test.jpg',image_caption='test fixture',cloudImageProbe={'accessible':True})
  imaged['reviews'][c]['finalBodyHash']=digest(imaged['reviews'][c]['articles'])
  p=imaged['package']['countries'][c];p['coverUrl']=e['image_url'];p['bodyHtml']+='<img src="https://example.com/test.jpg">'
 assert not validate(imaged),validate(imaged)
 d=copy.deepcopy(imaged);d['reviews']['kz']['articles'][0]['cloudImageProbe']['accessible']=False;assert validate(d);cases.append('cloud image rejected')
 d=copy.deepcopy(imaged);d['package']['countries']['kz']['coverUrl']='https://example.com/other.jpg';assert validate(d);cases.append('wrong cover')
 print(json.dumps({'passed':True,'validSyntheticFixture':True,'rejections':cases},ensure_ascii=False))
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('input',nargs='?');parser.add_argument('--selftest',action='store_true');parser.add_argument('--stage',choices=['ingest','deliver'],default='deliver');parser.add_argument('--delivery-mode',choices=['normal','deadline_under_delivery'],default='normal');parser.add_argument('--countries',help='Explicit partial transport scope, e.g. kz,uz; requires identical package.readyCountries and scoped drafts/reviews/countries');args=parser.parse_args()
 if args.selftest:selftest()
 elif args.input:
  data=json.loads(Path(args.input).read_text());selected=args.countries.split(',') if args.countries is not None else None
  try:scope=country_scope(selected)
  except ValueError as error:parser.error(str(error))
  quantities=quantity_report(data,countries=scope)
  errors=validate(data,require_cloud_images=args.stage=='deliver',delivery_mode=args.delivery_mode,countries=selected)
  quantity_ok=not quantities or all(q.get('quantityReady') is True for q in quantities.values())
  missing=[c for c in COUNTRIES if c not in scope]
  print(json.dumps({'ok':not errors,'stage':args.stage,'deliveryMode':args.delivery_mode,'transportAllowed':not errors,'selectedCountries':list(scope),'missingCountries':missing,'partialDelivery':bool(missing),'selectedQuantityReady':quantity_ok,'quantityReady':quantity_ok and not missing,'qualityDeliveryComplete':not errors and quantity_ok and not missing,'underDelivery':not quantity_ok,'continueExpansion':not quantity_ok or bool(missing),'quantities':quantities,'errors':errors},ensure_ascii=False,indent=2));sys.exit(bool(errors))
 else:parser.error('input file or --selftest required')
