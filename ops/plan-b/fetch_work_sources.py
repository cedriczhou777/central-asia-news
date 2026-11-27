"""Batch fetch public source HTML with validated decoding and bounded retries."""
import argparse,codecs,concurrent.futures,gzip,hashlib,io,json,math,re,subprocess,sys,time,unicodedata,zlib
from datetime import datetime,timedelta,timezone
from pathlib import Path
from urllib.parse import urljoin,urlparse,urlsplit,urlunsplit
import urllib.request,urllib.error
from lxml import html
from discovery_feed import FEED_TYPES, parse_feed
from source_evidence import KHOVAR_RUSSIAN_MONTHS, header_clock, khovar_archive_dateline, khovar_archive_publication_footer
P=Path(__file__).parent;S=P/'sources'
PARSER_VERSION='source-html-v26'
TRANSIENT={429,500,502,503,504}
MAX_NETWORK_SECONDS = 45
MAX_TRANSPORT_BYTES = 10_000_000
class HTMLValidationError(ValueError):
    def __init__(self,message,encoding,evidence):
        super().__init__(message);self.decodedEncoding=encoding;self.encodingEvidence=evidence

def decode_transport(raw,encoding=''):
    encoding=encoding.lower().strip()
    if raw.startswith(b'\x1f\x8b') or encoding=='gzip':
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as zipped:
            decoded=zipped.read(MAX_TRANSPORT_BYTES+1)
    elif encoding=='deflate':
        try: decoder=zlib.decompressobj();decoded=decoder.decompress(raw,MAX_TRANSPORT_BYTES+1)
        except zlib.error: decoder=zlib.decompressobj(-zlib.MAX_WBITS);decoded=decoder.decompress(raw,MAX_TRANSPORT_BYTES+1)
        if len(decoded)<=MAX_TRANSPORT_BYTES and not decoder.eof:raise ValueError('incomplete_deflate_response')
    elif encoding in ('','identity'):decoded=raw
    else:raise ValueError('unsupported_content_encoding_'+encoding)
    if len(decoded)>MAX_TRANSPORT_BYTES:raise ValueError('decoded_source_too_large')
    return decoded

def decode_html(raw,headers):
    """BOM > HTTP charset > HTML charset > strict UTF-8 > Windows-1252.

    Never let lxml guess Latin-1 for undeclared, valid UTF-8. Declarations and
    conflicts remain evidence; a declared legacy charset is not silently fixed.
    """
    content_type=headers.get('content-type','')
    http=re.search(r'charset\s*=\s*[\"\']?([^\s;\"\']+)',content_type,re.I)
    prefix=raw[:16384].decode('ascii',errors='ignore')
    meta=[]
    for tag in re.findall(r'<meta\b[^>]*>',prefix,re.I):
        value=re.search(r'charset\s*=\s*[\"\']?([^\s;\"\'/>]+)',tag,re.I)
        if value:meta.append(value.group(1))
    declarations=[]
    for source,value in [('http',http.group(1) if http else None)]+[('meta',x) for x in meta]:
        if value:
            try:encoding=codecs.lookup(value).name
            except LookupError:raise ValueError('unsupported_HTML_charset_'+value) from None
            declarations.append({'source':source,'raw':value,'encoding':encoding})
    bom=None
    for marker,encoding in ((codecs.BOM_UTF32_LE,'utf-32'),(codecs.BOM_UTF32_BE,'utf-32'),(codecs.BOM_UTF8,'utf-8-sig'),(codecs.BOM_UTF16_LE,'utf-16'),(codecs.BOM_UTF16_BE,'utf-16')):
        if raw.startswith(marker):bom=encoding;break
    if bom:encoding=bom;basis='bom'
    elif declarations:encoding=declarations[0]['encoding'];basis=declarations[0]['source']
    else:
        try:raw.decode('utf-8',errors='strict');encoding='utf-8';basis='valid_utf8_without_charset'
        except UnicodeDecodeError:encoding='cp1252';basis='legacy_fallback_without_charset'
    try:text=raw.decode(encoding,errors='strict')
    except (UnicodeDecodeError,LookupError) as error:
        raise ValueError('HTML_charset_decode_failed_'+encoding+': '+str(error)[:100]) from None
    return text,encoding,{'selectedBy':basis,'declarations':declarations,'bom':bom,'declarationConflict':len({x['encoding'] for x in declarations})>1}

def reject_mojibake(text,encoding,evidence=None):
    # Repeated UTF-8-as-single-byte signatures, rather than a lone legitimate Ð.
    suspicious=len(re.findall(r'[ÐÑÃÂ][\u0080-\u00bf\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2010-\u203f\u20ac]|â[€™œž]',text))
    cyrillic_signatures=len(re.findall(r'[РС][\u0080-\u04ff\u2010-\u203f\u20ac]',text))
    if cyrillic_signatures>=3:
        try:
            repaired=text.encode('cp1251').decode('utf-8')
            if repaired!=text:suspicious+=cyrillic_signatures
        except (UnicodeEncodeError,UnicodeDecodeError):pass
    if suspicious>=3 or '\ufffd' in text:
        raise HTMLValidationError('HTML_mojibake_detected_encoding_'+encoding+'_suspicious_sequences_'+str(suspicious),encoding,evidence or {})

def parse_error_evidence(error):
    return {key:getattr(error,key) for key in ('decodedEncoding','encodingEvidence') if hasattr(error,key)}

def normalized_url(value,base):
    if not isinstance(value,str) or not value.strip():return None
    p=urlsplit(urljoin(base,value.strip()))
    if p.scheme.lower() not in ('http','https') or not p.netloc:return None
    return urlunsplit((p.scheme.lower(),p.netloc.lower(),p.path.rstrip('/') or '/',p.query,''))

def timestamp_precision(raw):
    """Describe source precision without manufacturing a time or timezone."""
    if not isinstance(raw,str):return 'unparsed','not_provided'
    value=raw.strip()
    basic=re.fullmatch(r'(\d{8})[Tt ](\d{4})(\d{2})?(?:[.,](\d+))?(?:[Zz]|[+-]\d{2}:?\d{2})?',value)
    if basic:
        try:parsed=datetime.fromisoformat(value.replace('Z','+00:00').replace('z','+00:00'))
        except ValueError:return 'unparsed','not_provided'
        return ('fractional_seconds' if basic.group(4) else 'seconds' if basic.group(3) else 'minutes'),'explicit' if parsed.tzinfo is not None and parsed.utcoffset() is not None else 'not_provided'
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}',value):
        try:datetime.fromisoformat(value)
        except ValueError:return 'unparsed','not_provided'
        return 'date','not_provided'
    if not re.match(r'^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}',value):return 'unparsed','not_provided'
    try:parsed=datetime.fromisoformat(value.replace('Z','+00:00').replace('z','+00:00'))
    except ValueError:return 'unparsed','not_provided'
    precision='fractional_seconds' if re.search(r':\d{2}[.,]\d+',value) else 'seconds' if re.match(r'^.{10}[Tt ]\d{2}:\d{2}:\d{2}',value) else 'minutes'
    return precision,'explicit' if parsed.tzinfo is not None and parsed.utcoffset() is not None else 'not_provided'

def article_identities(node,base):
    values=[]
    for field in ('mainEntityOfPage','url'):
        for value in node.get(field,[]) if isinstance(node.get(field),list) else [node.get(field)]:
            if isinstance(value,dict):value=value.get('@id') or value.get('url')
            normalized=normalized_url(value,base)
            if normalized:values.append((field,value,normalized))
    return values


def matches_article_identity(url, page_urls):
    if url in page_urls:
        return True
    # TopTJ emits http://www article identities even when it serves https://
    # on either hostname. Bind only the identical, dated article path.
    page = urlsplit(url)
    hosts = ('toptj.com','www.toptj.com')
    if page.netloc not in hosts or not re.fullmatch(r'/news/20\d\d/\d\d/\d\d/[^/]+',page.path):
        return False
    return any(current.netloc in hosts and current.path == page.path and current.query == page.query
               for current in map(urlsplit, filter(None, page_urls)))

def article_date_nodes(article):
    """Compact publication badges/times belonging to this article, not cards."""
    dates=[]
    date_pattern=r'(?<!\d)(?:20\d\d[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]20\d\d)(?!\d)|(?<!\d)\d{1,2}:\d{2}(?!\d)'
    marker_pattern=r'(^|[-_\s])(?:datePublished|pub[-_]?date|publish(?:ed)?(?:[-_]?date)?|publication[-_]?date|article[-_]?date|news[-_]?date)($|[-_\s])'
    for n in article.xpath('.//time|.//p|.//span|.//div|.//*[@itemprop]|.//*[@class]|.//*[@data-published]'):
        ancestors=n.xpath('ancestor::article')
        if not ancestors or ancestors[-1] is not article or n.xpath('ancestor::aside|ancestor::nav|ancestor::footer'):continue
        raw=n.get('datetime') or n.get('content') or n.get('data-published') or ' '.join(n.text_content().split())
        if not raw or len(raw)>160:continue
        itemprop=(n.get('itemprop') or '').split()
        marker=bool(re.search(marker_pattern,n.get('class') or '',re.I)) or 'datePublished' in itemprop or bool(n.get('data-published'))
        labelled=bool(re.match(r'^(?:Published(?: on)?|Publication date|Дата публикации|Опубликовано|发布时间)\s*[:：]?',raw,re.I))
        if not (n.tag=='time' or marker or labelled):continue
        if timestamp_precision(raw)[0]=='unparsed' and not re.search(date_pattern,raw):continue
        kind='modified' if 'dateModified' in itemprop else 'published' if marker or labelled else 'unclassified'
        dates.append((n,raw,kind,'article_time_element' if n.tag=='time' else 'explicit_publication_badge'))
    return dates

def structural_article_evidence(article):
    headings=[n for n in article.xpath('.//h1') if n.text_content().strip() and not n.xpath('ancestor::aside|ancestor::nav')]
    dates=article_date_nodes(article)
    # Count prose after removing navigation, dates, headers and link-only cards.
    body=html.fromstring(html.tostring(article))
    for n in body.xpath('.//script|.//style|.//nav|.//header|.//footer|.//aside|.//noscript|.//iframe|.//svg|.//h1|.//time'):n.drop_tree()
    text=' '.join(body.text_content().split())
    linked_chars=sum(len(' '.join(n.text_content().split())) for n in body.xpath('.//a[@href]'))
    density=linked_chars/max(1,len(text))
    facts={'headingCount':len(headings),'proseChars':len(text),'linkedTextRatio':round(density,3),'articleDates':[{'raw':raw,'kind':kind,'basis':basis} for _,raw,kind,basis in dates]}
    return len(headings)==1 and len(text)>=240 and density<0.35 and bool(dates),facts

def classify_source(tree,final_url,canonical_url,meta,linked_data):
    """Conservative article identity, with unknown pages kept for human review."""
    parts=[x.lower() for x in urlparse(final_url).path.strip('/').split('/') if x]
    home=not parts or len(parts)==1 and parts[0] in ('ru','rus','uz','en','kg','kz','kk','tg','tj','az')
    sections={'category','categories','tag','tags','archive','archives','news','novosti','press','press-releases','articles','publications','search','sitemap'}
    section=bool(parts and parts[-1] in sections) or len(parts)>=2 and parts[-2]=='page' and parts[-1].isdigit()
    for marker in ('category','categories','tag','tags','archive','archives'):
        if marker in parts and len(parts)-parts.index(marker)-1<=1:section=True
    articles=tree.xpath('//article[not(ancestor::aside or ancestor::nav or ancestor::footer)]')
    primary=max(articles,key=lambda n:len(n.text_content())) if articles else None
    if home or section:return 'listing',['home_or_section_path'],None
    if meta.get('og:type','').lower()=='article':return 'article',['og_article_type'],primary
    if meta.get('article:published_time'):return 'article',['page_publication_metadata'],primary
    identities={normalized_url(final_url,final_url),normalized_url(canonical_url,final_url)}
    def current_article(node):
        if isinstance(node,dict):
            kinds=node.get('@type',[]);kinds=kinds if isinstance(kinds,list) else [kinds]
            if any(isinstance(t,str) and t.rsplit('/',1)[-1] in ('NewsArticle','Article') for t in kinds) and any(matches_article_identity(x[2],identities) for x in article_identities(node,final_url)):return True
            return any(current_article(v) for v in node.values() if isinstance(v,(dict,list)))
        if isinstance(node,list):return any(current_article(v) for v in node)
        return False
    for raw in linked_data:
        try:
            if current_article(json.loads(raw)):return 'article',['current_article_jsonld'],primary
        except (TypeError,ValueError):pass
    if len(articles)==1:
        qualifies,facts=structural_article_evidence(primary)
        if qualifies:return 'article',[{'basis':'single_article_heading_prose_and_date','structure':facts}],primary
        return 'unknown',[{'basis':'single_article_structure_needs_review','structure':facts}],None
    # A collection of short, linked cards is a listing. Ambiguous multi-article
    # pages remain unknown rather than being mechanically ruled out as no news.
    if len(articles)>1 and all(n.xpath('.//a[@href]') and not structural_article_evidence(n)[0] for n in articles):return 'listing',['multiple_linked_article_cards'],None
    return 'unknown',['article_identity_needs_manual_verification'],None


def publisher_header_clocks(tree, source_url, canonical_url, selected, body_evidence):
    """Observe compact dates by the current heading of known article routes."""
    page = urlsplit(source_url)
    host = (page.hostname or '').removeprefix('www.')
    route = {
        'review.uz': r'^/post/[^/]+/?$',
        'podrobno.uz': r'^/cat/[^/]+/[^/]+/?$',
        'alau.kz': r'^/[^/]+/?$',
        'sugd.tj': r'^/(?:ru|tj)/(?:[^/]+/)+\d+-[^/]+/?$',
        'taxes.gov.az': r'^/az/post/\d+/?$',
        'minenergy.gov.az': r'^/(?:az|en)/xeberler-arxivi/\d+/?$',
        'customs.gov.az': r'^/az/faydali/xeberler/\d+/?$',
    }.get(host)
    if (not route or not re.fullmatch(route,page.path)
            or (canonical_url and normalized_url(canonical_url,source_url)!=normalized_url(source_url,source_url))):
        return []
    headings = [node for node in tree.xpath('//h1[not(ancestor::aside or ancestor::nav or ancestor::footer)]')
                if ' '.join(node.text_content().split()) in body_evidence.get('headingTexts',[])]
    if len(headings)!=1:
        return []
    heading = headings[0]
    badges = {}
    for anchor in [heading, heading.getparent()]:
        if anchor is None or selected in anchor.iterdescendants():
            continue
        for sibling in list(anchor.itersiblings())[:4]:
            if not isinstance(sibling.tag,str):
                continue
            if (sibling is selected or selected in sibling.iterdescendants()
                    or sibling.tag in ('article','section','main','aside','nav','footer','ul','ol')
                    or sibling.xpath('.//h1|.//h2|.//h3') or recommendation_card(sibling)):
                break
            for node in [sibling, *sibling.xpath('.//time|./*|./*/*')]:
                if (node.xpath('ancestor::aside|ancestor::nav|ancestor::footer')
                        or any(recommendation_card(parent) for parent in [node, *node.iterancestors()])):
                    continue
                value = ' '.join(node.text_content().split())
                marker = (node.get('class','')+' '+node.get('itemprop','')).lower()
                if re.search('updat|modif|обнов|измен', marker+' '+value, re.I):
                    continue
                created = re.fullmatch(r'Создано:\s*(.+?)(?:\s+Просмотров:\s*\d+)?',value,re.I) if host=='sugd.tj' else None
                if host=='sugd.tj' and not created:
                    continue
                kind = 'created' if created else 'published'
                plain = created[1] if created else re.sub(r'^Опубликовано:\s*','',value,flags=re.I)
                if host == 'minenergy.gov.az' and re.fullmatch(r'\d{2}-\d{2}-20\d{2} \d{2}:\d{2}', plain):
                    plain = plain.replace('-', '.')
                wall = header_clock(plain)
                if wall:
                    badges[(kind,wall)] = value
                elif host=='alau.kz' and re.search(r'(?:^|[—–]\s*)(?:Сегодня|Вчера),?\s+\d{1,2}:[0-5]\d$',value,re.I):
                    badges[('unclassified',value)] = value
    if len(badges) != 1:
        return []
    (kind, clock), raw = next(iter(badges.items()))
    explicit = kind != 'unclassified'
    return [{'field':'publisher.sugd.article_created_label' if kind=='created' else
                     'publisher.current_heading_adjacent_date' if explicit else 'publisher.alau.relative_article_clock',
             'raw':raw, **({'localWallTime':clock} if explicit else {}),
             'kind':kind, 'precision':timestamp_precision(clock)[0] if explicit else 'relative_clock',
             'timezoneEvidence':'not_provided' if explicit else 'reference_day_missing',
             'articleUrl':canonical_url or source_url,
             'confidenceBasis':['unique_date_in_compact_current_article_header'],'priority':35 if kind=='published' else 95}]


def publication_evidence(tree,linked_data,final_url,canonical_url,primary_article,publisher_template=None):
    """Collect article-bound observations, not a first-publication verdict.

    Other Article nodes stay in raw linked_data and the exclusion ledger. In
    particular, recommendations cannot donate a timestamp to the current page.
    """
    accepted=[];excluded=[]
    identities={normalized_url(final_url,final_url)}
    if canonical_url:identities.add(normalized_url(canonical_url,final_url))
    def evidence(field,raw,kind,article_url,basis,priority):
        precision,tz=timestamp_precision(raw)
        return {'field':field,'raw':raw,'kind':kind,'precision':precision,'timezoneEvidence':tz,'articleUrl':article_url,'confidenceBasis':basis,'priority':priority}
    def walk(value,path):
        if isinstance(value,dict):
            types=value.get('@type',[]);types=types if isinstance(types,list) else [types]
            if any(isinstance(t,str) and t.rsplit('/',1)[-1] in ('NewsArticle','Article') for t in types):
                bound=article_identities(value,final_url)
                match=next((x for x in bound if matches_article_identity(x[2],identities)),None)
                for key,kind in (('datePublished','published'),('dateModified','modified')):
                    if key not in value:continue
                    raws=value[key] if isinstance(value[key],list) else [value[key]]
                    for raw in raws:
                        ev=evidence(path+'.'+key,raw,kind,match[2] if match else bound[0][2] if bound else None,['jsonld_article_identity_matches_'+match[0]] if match else ['article_identity_mismatch' if bound else 'article_identity_missing'],10 if kind=='published' else 80)
                        if match and match[2] not in identities:
                            ev.update(articleUrl=final_url, observedArticleIdentity=match[1])
                            ev['confidenceBasis'].append('toptj_http_www_same_article_alias')
                        (accepted if match else excluded).append(ev)
            for k,v in value.items():
                if isinstance(v,(dict,list)):walk(v,path+'.'+k)
        elif isinstance(value,list):
            for i,v in enumerate(value):walk(v,path+'['+str(i)+']')
    for i,raw in enumerate(linked_data):
        try:walk(json.loads(raw),'jsonld['+str(i)+']')
        except (TypeError,ValueError):pass # The original script is preserved verbatim.
    published={'article:published_time','og:published_time','datepublished','pubdate','publishdate','publication_date','dc.date.issued','dcterms.issued'}
    modified={'article:modified_time','og:updated_time','datemodified','last-modified'}
    for n in tree.xpath('//meta[@content]'):
        key=n.get('property') or n.get('name') or ''
        kind='published' if key.lower() in published else 'modified' if key.lower() in modified else None
        if kind:accepted.append(evidence('meta.'+key,n.get('content'),kind,canonical_url or final_url,['page_metadata_on_current_response'],20 if kind=='published' else 90))
    for i,n in enumerate(tree.xpath('//time')):
        # Only a time inside the primary article, outside nested recommendation
        # articles, is bound. Listing times are retained separately with links.
        ancestors=n.xpath('ancestor::article')
        if primary_article is None or not ancestors or ancestors[-1] is not primary_article:continue
        if n.xpath('ancestor::aside|ancestor::nav|ancestor::footer'):continue
        itemprop=(n.get('itemprop') or '').split()
        kind='published' if 'datePublished' in itemprop else 'modified' if 'dateModified' in itemprop else 'unclassified'
        raw=n.get('datetime') or n.text_content()
        accepted.append(evidence('time['+str(i)+']',raw,kind,canonical_url or final_url,['time_inside_primary_article'],30 if kind=='published' else 95))
    if primary_article is not None:
        for i,(node,raw,kind,basis) in enumerate(article_date_nodes(primary_article)):
            if node.tag!='time':accepted.append(evidence('html.publicationBadge['+str(i)+']',raw,kind,canonical_url or final_url,[basis],35 if kind=='published' else 95))
    # Some observed publisher article bodies are divs, not semantic <article>.
    # Only a validated, current-URL-bound template can donate its author time;
    # the generic page's other times and dates remain ineligible.
    for i,node in enumerate((publisher_template or {}).get('publicationNodes',[])):
        accepted.append(evidence('publisher.'+publisher_template['name']+'.time['+str(i)+']',node.get('datetime'),'published',canonical_url or final_url,['unique_publisher_author_publication_time','current_heading_data_id_and_url_bound'],30))
    publisher_date = (publisher_template or {}).get('publicationDay')
    if publisher_date:
        accepted.append(evidence('publisher.' + publisher_template['name'] + '.publicationDay',
                                 publisher_date, 'published', canonical_url or final_url,
                                 ['unique_date_beside_current_article_heading'], 35))
    badge = (publisher_template or {}).get('publicationBadge')
    if badge:
        raw, stamp = badge
        accepted.append({**evidence('publisher.khovar.currentArticlePublicationBadge', stamp, 'published',
                                    canonical_url or final_url,
                                    ['unique_visible_date_above_current_article_body', 'Asia/Dushanbe'], 35),
                         'rawLocalTime': raw, 'timezoneEvidence': 'publisher_local'})
    local_badge = (publisher_template or {}).get('localPublicationBadge')
    if local_badge:
        raw, wall_time = local_badge
        accepted.append({**evidence('publisher.' + publisher_template['name'] + '.currentPublicationBadge',raw,
                                    'published',canonical_url or final_url,
                                    ['unique_date_next_to_url_bound_current_heading'],35),
                         'precision':'minutes', 'localWallTime':wall_time})
    return sorted(accepted,key=lambda e:e['priority']),excluded


def superkg_publication_evidence(publications):
    """Suppress only the known epoch placeholder backed by a unique author time."""
    stamps, footer_stamps, epoch, issues = set(), set(), [], []
    for item in publications:
        if item.get('kind')!='published' or item.get('timezoneEvidence')!='explicit':
            continue
        stamp=datetime.fromisoformat(item['raw'].replace('Z','+00:00').replace('z','+00:00'))
        if item['field']=='meta.article:published_time' and stamp.timestamp()==0:
            epoch.append(item)
            continue
        stamps.add(stamp)
        if item['field'].startswith('publisher.superkg_current_news_inside_text_author_time.') and stamp.timestamp()>0:
            footer_stamps.add(stamp)
    excluded = []
    if epoch:
        if len(stamps)==1 and stamps==footer_stamps:
            publications = [item for item in publications if item not in epoch]
            excluded = [{**item, 'confidenceBasis':['publisher_unix_epoch_placeholder']} for item in epoch]
        else:
            issues.append({'kind':'unix_epoch_publication_metadata','field':epoch[0]['field'],'raw':epoch[0]['raw']})
    if len(stamps)>1:
        issues.append({'kind':'publisher_publication_time_conflict','requiresManualReview':True,
                       'fields':[item['field'] for item in publications if item.get('kind')=='published']})
    return publications, excluded, issues


def link_time_context(node):
    # Stop at the closest compact card; never attach every date in a page to
    # every link. Raw time text remains available even when not an ISO date.
    for ancestor in list(node.iterancestors())[:4]:
        if ancestor.tag in ('html','body','main','nav','header','footer'):break
        links=ancestor.xpath('.//a[@href]');times=ancestor.xpath('.//time')
        if times and len(links)<=4:
            return [{'text':n.text_content(),'datetime':n.get('datetime')} for n in times]
        if ancestor.tag in ('article','li'):break
    return []

def link_in_navigation(node):
    for n in [node]+list(node.iterancestors()):
        if n.tag=='nav' or 'navigation' in (n.get('role') or '').lower().split():return True
        # Article headers contain valid headline links; article footers can
        # contain source citations. They are not site navigation.
        if n.tag in ('header','footer') and not n.xpath('ancestor::article'):return True
    return False

def link_article_features(node):
    ancestors=list(node.iterancestors())
    heading=any(n.tag in ('h1','h2','h3','h4','h5','h6') for n in ancestors)
    card=any(n.tag=='article' or re.search(r'(^|\s)(?:jeg-pl-\S+|(?:news|post|article|story|result)[-_](?:item|card)|(?:item|news|post)[-_]teaser)(\s|$)',n.get('class') or '',re.I) for n in ancestors)
    return {'inHeading':heading,'articleCard':card}

def title_matches(a,b):
    def normalized(value):return ' '.join(re.sub(r'[\W_]+',' ',unicodedata.normalize('NFKC',value).casefold()).split())
    a=normalized(a);b=normalized(b)
    return bool(a and b) and (a==b or min(len(a),len(b))>=20 and (a.startswith(b+' ') or b.startswith(a+' ')) and min(len(a),len(b))/max(len(a),len(b))>=0.65)

def recommendation_card(node):
    classes=node.get('class') or ''
    if re.search(r'(^|\s)(?:jeg-pl-\S+|(?:news|post|article|story|result)[-_](?:item|card)|teaser|related[-_]\S+)(\s|$)',classes,re.I):return True
    return node.tag=='article' and bool(node.xpath('.//h2/a[@href]|.//h3/a[@href]')) and not node.xpath('.//h1')

def clean_content(node,preserve_article_metadata=False,drop_recommendation_cards=True):
    copy=html.fromstring(html.tostring(node))
    for n in copy.xpath('.//script|.//style|.//nav|.//noscript|.//iframe|.//svg'):n.drop_tree()
    if drop_recommendation_cards:
        for n in copy.xpath('.//article'):
            if recommendation_card(n):n.drop_tree()
    if not preserve_article_metadata:
        for n in copy.xpath('.//header|.//footer|.//aside'):
            if not n.xpath('ancestor::article'):n.drop_tree()
    return '\n'.join(' '.join(t.split()) for t in copy.itertext() if t.strip())

def article_headline_aliases(linked_data,final_url,canonical_url):
    """SEO/OG titles can differ from the current article's bound headline."""
    identities={normalized_url(final_url,final_url),normalized_url(canonical_url,final_url)};aliases=[]
    def walk(value):
        if isinstance(value,dict):
            kinds=value.get('@type',[]);kinds=kinds if isinstance(kinds,list) else [kinds]
            if any(isinstance(t,str) and t.rsplit('/',1)[-1] in ('NewsArticle','Article') for t in kinds) and any(matches_article_identity(x[2],identities) for x in article_identities(value,final_url)):
                headline=value.get('headline')
                if isinstance(headline,str) and headline.strip():aliases.append(headline)
            for child in value.values():
                if isinstance(child,(dict,list)):walk(child)
        elif isinstance(value,list):
            for child in value:walk(child)
    for raw in linked_data:
        try:walk(json.loads(raw))
        except (TypeError,ValueError):pass
    return list(dict.fromkeys(aliases))

def publisher_article_template(tree,final_url,canonical_url,meta,title,alternative_titles):
    """Observed publisher templates, guarded by host, article route and DOM.

    These selectors identify bodies, not relevance, freshness or first public
    disclosure. They cannot turn a generic main/listing into an article.
    """
    parsed=urlparse(final_url);host=parsed.hostname or '';path=parsed.path
    allowed=[title]+(alternative_titles or []);profile=None
    def has_class(node,name):return name in (node.get('class') or '').split()
    def headings_match(nodes):return any(any(title_matches(' '.join(n.text_content().split()),x) for x in allowed) for n in nodes)
    def make(name,bodies,headings=None,extra=None,editorial=False):
        if len(bodies)!=1:return None
        return {'name':name,'bodies':bodies,'headings':headings,'identityBindings':['publisher_host_and_article_route','unique_publisher_body_selector']+(extra or []),'editorialCoverHeading':editorial}
    if (host=='apa.az' or host.endswith('.apa.az')) and re.search(r'-\d+/?$',path):
        scopes=[n for n in tree.xpath('//div[@class]') if has_class(n,'content_main')]
        for scope in scopes:
            heads=[n for n in scope.xpath('.//h2[@class]') if has_class(n,'title_news')]
            bodies=[n for n in scope.xpath('.//*[@itemprop]') if 'articleBody' in (n.get('itemprop') or '').split()]
            if headings_match(heads):profile=make('apa_content_main_title_news_articleBody',bodies,heads,['news_h2_matches_current_title']);break
    elif host=='report.az' or host.endswith('.report.az'):
        identities={normalized_url(final_url,final_url),normalized_url(canonical_url,final_url)}
        for scope in tree.xpath('//*[@data-url][@data-title]'):
            if not has_class(scope,'news-detail__item') or not has_class(scope,'post-detail-area'):continue
            if normalized_url(scope.get('data-url'),final_url) not in identities or not any(title_matches(scope.get('data-title'),x) for x in allowed):continue
            heads=scope.xpath('.//h1')
            bodies=[n for n in scope.xpath('.//*[@class]') if has_class(n,'news-detail__desc')]
            if headings_match(heads):profile=make('report_current_data_url_title_news_detail_desc',bodies,heads,['data_url_matches_response_identity','data_title_and_h1_match_current_title']);break
    elif host=='inbusiness.kz' or host.endswith('.inbusiness.kz'):
        if re.match(r'^/ru/(?:last|news|specprojects)/[^/]+/?$',path):
            bodies=[n for n in tree.xpath('//div[@class]') if has_class(n,'text') and n.xpath('.//p') and not n.xpath('ancestor::nav|ancestor::aside|ancestor::footer')]
            if headings_match(tree.xpath('//h1')):profile=make('inbusiness_current_news_text',bodies,extra=['current_h1_matches_title'])
    elif host in ('navonews.tj', 'www.navonews.tj') and re.fullmatch(r'/article/[^/]+/?', path):
        own = normalized_url(meta.get('og:url'), final_url)
        if own == normalized_url(final_url, final_url):
            scope = tree.xpath('//main[@id="main-content"]')
            if len(scope) == 1:
                heads = scope[0].xpath('.//h1')
                required = {'font-serif', 'text-[1.125rem]', 'leading-relaxed', 'text-ink'}
                bodies = [node for node in scope[0].xpath('.//div[p]')
                          if required <= set((node.get('class') or '').split())]
                site = (meta.get('og:site_name') or '').strip()
                headline = title.removeprefix(site + ' | ') if site else title
                if len(heads) == 1 and title_matches(' '.join(heads[0].text_content().split()), headline):
                    profile = make('navo_current_article_body', bodies, heads,
                                   ['same_og_article_url', 'publisher_prefixed_current_h1'])
                    if profile:
                        profile['headlineAlias'] = headline
    elif host in ('socar.az', 'www.socar.az') and re.fullmatch(r'/az/post/[a-z0-9-]+/?', path):
        scopes = tree.xpath('//main/section[@id="section-to-scroll"]')
        if len(scopes) == 1:
            scope = scopes[0]
            heads = scope.xpath('.//h1')
            page_title = ' '.join(' '.join(tree.xpath('//title/text()')).split()).removesuffix(' | SOCAR')
            bodies = scope.xpath('.//div[@id="pageContent"][p]')
            if len(heads) == 1 and title_matches(heads[0].text_content(), page_title):
                profile = make('socar_az_current_post', bodies, heads,
                               ['current_h1_matches_document_title', 'unique_current_post_section'])
                if profile:
                    profile['headlineAlias'] = page_title
                    raw = heads[0].getparent().xpath('./h5[normalize-space()]')
                    if len(raw) == 1:
                        try:
                            profile['publicationDay'] = datetime.strptime(raw[0].text_content().strip(), '%d/%m/%Y').date().isoformat()
                        except ValueError:
                            pass
    elif host=='invest.gov.kg' and re.fullmatch(r'/ru/news/[0-9]+/?', path):
        if normalized_url(meta.get('og:url'), final_url) == normalized_url(final_url, final_url):
            heads = [n for n in tree.xpath('//main//h1') if has_class(n, 'portal-page-title')]
            bodies = [n for n in tree.xpath('//main//article[./p]') if has_class(n, 'prose')]
            if len(heads) == 1 and headings_match(heads):
                profile = make('kg_invest_current_article_prose', bodies, heads,
                               ['same_og_article_url', 'current_h1_matches_title'])
    elif host=='azertag.az' and re.fullmatch(r'/(?:[a-z]{2}/)?xeber/[^/]+-\d+/?',path):
        if normalized_url(meta.get('og:url'),final_url)==normalized_url(final_url,final_url):
            scopes=[n for n in tree.xpath('//div[@class]') if has_class(n,'sa-post') and has_class(n,'app-post')]
            if len(scopes)==1:
                scope=scopes[0]
                heads=[n for n in scope.xpath('.//h2[@class]') if has_class(n,'entry-title')]
                bodies=[n for n in scope.xpath('.//div[@class]') if has_class(n,'news-body')]
                if len(heads)==1 and headings_match(heads):
                    profile=make('azertac_current_entry_title_news_body',bodies,heads,
                                 ['same_og_article_url','unique_app_post_heading'])
                    dates=scope.xpath('.//div[@class="entry-meta"]/ul/li[1]')
                    if profile and len(dates)==1:
                        raw=' '.join(dates[0].text_content().split())
                        match=re.fullmatch(r'(\d\d)\.(\d\d)\.(20\d\d)\s*\[(\d\d:\d\d)\]',raw)
                        if match:
                            day,month,year,clock=match.groups()
                            profile['localPublicationBadge']=(raw,f'{year}-{month}-{day}T{clock}')
    elif host=='economy.gov.az' and re.fullmatch(r'/(?:az|en|ru)/post/\d+/[^/]+/?',path):
        if normalized_url(meta.get('og:url'),final_url)==normalized_url(final_url,final_url):
            scopes=[n for n in tree.xpath('//section[@class]//div[@class]')
                    if has_class(n,'content-block') and n.xpath('./h1')]
            if len(scopes)==1:
                scope=scopes[0]
                heads=scope.xpath('./h1')
                bodies=[n for n in scope.xpath('./div[@class]') if has_class(n,'content-block__text')]
                if len(heads)==1 and headings_match(heads):
                    profile=make('az_economy_ministry_current_post',bodies,heads,
                                 ['same_og_article_url','heading_and_text_share_current_post'])
                    dates=[n for n in scope.xpath('./span[@class]') if has_class(n,'news-section__date')]
                    if profile and len(dates)==1:
                        raw=' '.join(dates[0].text_content().split())
                        match=re.fullmatch(r'([^\W\d_]+)\s+(\d{1,2}),\s*(20\d\d)\s+(\d\d:\d\d)',raw)
                        months=('yanvar','fevral','mart','aprel','may','iyun','iyul','avqust','sentyabr','oktyabr','noyabr','dekabr')
                        if match and match[1].casefold() in months:
                            profile['localPublicationBadge']=(raw,f'{match[3]}-{months.index(match[1].casefold())+1:02d}-{int(match[2]):02d}T{match[4]}')
    elif host=='nuz.uz' and re.fullmatch(r'/20\d\d/\d\d/\d\d/[^/]+/?',path):
        if normalized_url(canonical_url,final_url)==normalized_url(final_url,final_url):
            heads=[n for n in tree.xpath('//article//h1') if has_class(n,'tdb-title-text')]
            if len(heads)==1 and headings_match(heads):
                article=next(iter(heads[0].xpath('ancestor::article[1]')),None)
                bodies=[n for n in article.xpath('.//div[@class]') if has_class(n,'tdb_single_content')]
                profile=make('nuz_tagdiv_current_post',bodies,heads,['same_canonical_article_url','unique_published_heading'])
                stamps=article.xpath('.//div[contains(concat(" ",normalize-space(@class)," ")," tdb_single_date ")]//time[@datetime]')
                if profile and len(stamps)==1:
                    profile['publicationNodes']=stamps
    elif host=='24.kg' or host.endswith('.24.kg'):
        if re.match(r'^/article/[^/]+/?$',path):
            bodies=[n for n in tree.xpath('//*[@id="article-content"]') if has_class(n,'article-viewer-content')]
            if headings_match(tree.xpath('//h1')):profile=make('24kg_current_article_viewer_content',bodies,extra=['current_h1_matches_title'])
    elif host in ('super.kg','www.super.kg'):
        route=re.fullmatch(r'/kabar/news/(\d+)/?',path)
        identities={normalized_url(final_url,final_url),normalized_url(canonical_url,final_url)}
        heads=tree.xpath('//h1[not(ancestor::nav or ancestor::aside or ancestor::footer or ancestor::svg)]')
        if route and len(heads)==1 and has_class(heads[0],'news_title') and heads[0].get('data-id')==route.group(1) and headings_match(heads) and normalized_url(meta.get('og:url'),final_url) in identities:
            # In the observed layout this wrapper contains only the current
            # prose, author and publication footer; recommendations are sibling
            # blocks outside it. Never choose arbitrary page-level dates.
            scope=heads[0].getparent()
            bodies=[n for n in scope.xpath('.//div[@id="inside-texts"]') if has_class(n,'inside-text')]
            if len(bodies)==1 and len(tree.xpath('//*[@id="inside-texts"]'))==1:
                wrapper=bodies[0].getparent()
                authors=wrapper.xpath('./div/section[@itemprop="author"][@itemscope]')
                times=[n for footer in wrapper.xpath('./div[@class]') if all(has_class(footer,c) for c in ('my-3','text-end','text-secondary')) for n in footer.xpath('./div/time[@datetime]') if 'datePublished' in (n.get('itemprop') or '').split()]
                named_author=len(authors)==1 and bool(authors[0].xpath('.//*[@itemprop="additionalName"][normalize-space()]'))
                if wrapper.getparent() is scope and has_class(wrapper,'my-4') and named_author and len(times)==1 and timestamp_precision(times[0].get('datetime'))[0]!='unparsed':
                    profile=make('superkg_current_news_inside_text_author_time',bodies,heads,['current_h1_matches_title','heading_data_id_matches_article_route','og_article_url_matches_response','same_wrapper_named_author_and_unique_publication_time'])
                    if profile:profile['publicationNodes']=times
    elif host=='khovar.tj' or host.endswith('.khovar.tj'):
        dated_route=r'^/(?:rus/)?20\d\d/\d\d/[^/]+/?$'
        canonical_path=urlparse(canonical_url or '').path
        same_slug_alias=(host=='khovar.tj' and urlparse(canonical_url or '').hostname==host
                         and re.fullmatch(dated_route,canonical_path)
                         and normalized_url(meta.get('og:url'),final_url)==normalized_url(final_url,final_url)
                         and tuple(p for p in path.strip('/').split('/') if p!='rus')
                             == (canonical_path.rstrip('/').rsplit('/',1)[-1],)
                         and path.startswith('/rus/')==canonical_path.startswith('/rus/'))
        if re.fullmatch(dated_route,path) or same_slug_alias:
            scopes=[n for n in tree.xpath('//div[@class]') if has_class(n,'block-content') and has_class(n,'type-post') and has_class(n,'status-publish') and any(re.fullmatch(r'post-\d+',c) for c in (n.get('class') or '').split())]
            bodies=[n for scope in scopes for n in scope.xpath('.//div[@class]') if has_class(n,'shortcode-content')]
            heads=tree.xpath('//h1[not(ancestor::nav or ancestor::aside or ancestor::footer)]')
            if headings_match(heads):
                profile=make('khovar_published_post_shortcode_content',bodies,extra=['wordpress_published_post_identity','current_h1_matches_title'])
                if profile and host=='khovar.tj' and len(heads)==1:
                    profile['publicationBadge']=khovar_publication_badge(
                        tree,heads[0],bodies[0],canonical_path if same_slug_alias else path)
    elif host=='tengrinews.kz' or host.endswith('.tengrinews.kz'):
        # Tilda longreads use an editorial cover H1 which can differ from the
        # SEO/OG headline. Both belong to one explicitly identified article URL.
        identities={normalized_url(final_url,final_url),normalized_url(canonical_url,final_url)}
        own_url=normalized_url(meta.get('og:url'),final_url)
        bodies=tree.xpath('//*[@id="allrecords"][@data-tilda-page-id][@data-tilda-project-id]')
        if re.match(r'^/article/[^/]+-\d+/?$',path) and own_url in identities and meta.get('og:type','').lower()=='article' and len(bodies)==1:
            heads=bodies[0].xpath('.//h1')
            if len(heads)==1 and len(' '.join(heads[0].text_content().split()))>=15:profile=make('tengri_url_bound_tilda_longread',bodies,heads,['og_article_url_matches_response','unique_tilda_article_page','unique_editorial_cover_h1'],True)
    return profile


def khovar_publication_badge(tree, heading, body, path):
    # The publisher shows the local publication time between the unique story
    # heading and the already bound prose. A sidebar or the body dateline
    # cannot donate a timestamp. Reject conflicts and URL-month mismatches.
    values = {}
    after_heading = False
    for node in tree.iter():
        if node is heading:
            after_heading = True
        if node is body:
            break
        if (not after_heading or node.tag not in ('time', 'span', 'p', 'div')
                or node.xpath('ancestor-or-self::aside|ancestor-or-self::nav|ancestor-or-self::footer')
                or any(recommendation_card(parent) for parent in node.iterancestors())):
            continue
        raw = ' '.join(node.text_content().split())
        match = re.fullmatch(r'([а-яё]+) (\d{1,2}), (20\d{2}) (\d\d):(\d\d)', raw, re.I)
        if not match or match[1].casefold() not in KHOVAR_RUSSIAN_MONTHS:
            continue
        month = KHOVAR_RUSSIAN_MONTHS.index(match[1].casefold()) + 1
        if not path.removeprefix('/rus').startswith(f'/{match[3]}/{month:02d}/'):
            return None
        try:
            stamp = datetime(int(match[3]), month, int(match[2]), int(match[4]), int(match[5]),
                             tzinfo=timezone(timedelta(hours=5))).isoformat()
        except ValueError:
            return None
        values[stamp] = raw
    if len(values) == 1:
        stamp, raw = next(iter(values.items()))
        return raw, stamp
    return None

def select_article_body(tree,title,alternative_titles=None,publisher_template=None):
    """Bind the current heading to a prose container, never the longest card.

    Alau places its H1 in a header before main.content > .content-inner, while
    its recommendation snippets use <article>. Semantic body containers and a
    matching page headline take precedence over generic article elements.
    """
    template=publisher_template or {}
    heading_nodes=template.get('headings') or tree.xpath('//h1')
    headings=[n for n in heading_nodes if n.text_content().strip() and not n.xpath('ancestor::svg|ancestor::nav|ancestor::aside|ancestor::footer')]
    allowed_titles=[title]+(alternative_titles or [])
    matches=headings if template.get('editorialCoverHeading') else [n for n in headings if any(title_matches(' '.join(n.text_content().split()),allowed) for allowed in allowed_titles)]
    heading_basis='publisher_url_bound_editorial_cover' if template.get('editorialCoverHeading') else 'og_or_page_title' if any(title_matches(' '.join(n.text_content().split()),title) for n in matches) else 'current_article_jsonld_headline'
    if headings and not matches:return None,{'status':'heading_title_conflict','headingTexts':[' '.join(n.text_content().split()) for n in headings]},None
    if not matches:return None,{'status':'current_article_heading_missing'},None
    if template and not any(len(clean_content(n,True))>=80 for n in template['bodies']):
        return None,{'status':'publisher_body_has_no_substantive_text','publisherTemplate':template['name'],'headingTexts':[' '.join(n.text_content().split()) for n in matches]},None
    def bound(node):
        if node.xpath('ancestor::nav|ancestor::aside|ancestor::footer') or recommendation_card(node):return False
        local_headings=node.xpath('.//h1')
        if local_headings and not any(n in matches for n in local_headings):return False
        enclosing=node if node.tag=='article' else next(iter(node.xpath('ancestor::article')[::-1]),None)
        if enclosing is not None and recommendation_card(enclosing):return False
        # A nested article with its own unrelated headline cannot inherit the
        # page's OG title from elsewhere in the document.
        if enclosing is not None and enclosing.xpath('.//h1|.//h2|.//h3') and not any(n in matches for n in enclosing.xpath('.//h1')):return False
        return True
    explicit=[]
    body_class=r'(^|\s)(?:entry[-_]content|post[-_]content|article[-_]content|article[-_]body|article__body|post[-_]body|story[-_]body|news[-_]text|content[-_]inner|content[-_]body|entry__content)(\s|$)'
    for n in tree.xpath('//*[@itemprop]|//*[@class]'):
        if 'articleBody' in (n.get('itemprop') or '').split() or re.search(body_class,n.get('class') or '',re.I):
            if bound(n):explicit.append(n)
    groups=[]
    if template:groups.append(('publisher_template:'+template['name'],[n for n in template['bodies'] if bound(n)]))
    groups.extend([('explicit_article_body',explicit),('article_with_current_heading',[n for n in tree.xpath('//article') if bound(n) and any(h in matches for h in n.xpath('.//h1'))]),('main_with_current_heading',[n for n in tree.xpath('//main') if bound(n) and any(h in matches for h in n.xpath('.//h1'))])])
    for basis,nodes in groups:
        candidates=[(n,clean_content(n,True)) for n in nodes]
        candidates=[(n,text) for n,text in candidates if len(text)>=80]
        if candidates:
            n,text=max(candidates,key=lambda pair:len(pair[1]))
            enclosing=n if n.tag=='article' else next(iter(n.xpath('ancestor::article')[::-1]),None)
            proof={'status':'bound','basis':basis,'headingIdentityBasis':heading_basis,'headingTexts':[' '.join(h.text_content().split()) for h in matches],'bodyChars':len(text)}
            if basis.startswith('publisher_template:'):proof['publisherIdentityBindings']=template['identityBindings']
            return n,proof,enclosing
    return None,{'status':'article_body_not_identified','headingTexts':[' '.join(n.text_content().split()) for n in matches]},None

def publisher_hero_nodes(body, page_url):
    """Front-of-story photos in publisher templates with separate text and hero."""
    host = (urlparse(page_url).hostname or '').removeprefix('www.')
    def has(node, name):
        return name in (node.get('class') or '').split()
    if host == 'inbusiness.kz':
        scope = next((p for p in body.iterancestors() if has(p, 'newscont')), None)
        if scope is not None:
            return [(n, None) for p in scope.xpath('./*') if has(p, 'newscover') for n in p.xpath('.//img')]
    elif host == 'gazeta.uz':
        scope = next((p for p in body.iterancestors() if has(p, 'articlePage')), None)
        if scope is not None:
            return [(n, None) for p in scope.xpath('./*') if has(p, 'articleTopBG')
                    for n in p.xpath('.//img') if has(n, 'articleBigPic')]
    elif host == 'caliber.az':
        scope = next((p for p in body.iterancestors() if has(p, 'post')), None)
        if scope is not None:
            return [(n, re.findall(r"""url\(\s*['"]?([^'")]+)['"]?\s*\)""", n.get('style') or ''))
                    for n in scope.xpath('./*') if has(n, 'post_cover')]
    elif host == 'yuz.uz':
        scope = next((p for p in body.iterancestors() if has(p, 'article-card')), None)
        if scope is not None and len(scope.xpath('.//h1')) == 1:
            return [(n, None) for n in scope.xpath('.//img') if has(n, 'gallery-img')]
    elif host == 'invest.gov.kg':
        mains = body.xpath('ancestor::main')
        if not mains and body.tag == 'main':
            mains = [body]
        if len(mains) == 1:
            heads = [n for n in mains[0].xpath('.//h1') if has(n, 'portal-page-title')]
            if len(heads) == 1:
                scope = heads[0].getparent().getparent()
                return [(n, None) for n in scope.xpath('.//img') if has(n, 'cursor-pointer')
                        and urlparse(n.get('src') or '').path.startswith('/uploads/news-images/')]
    elif host == 'socar.az' and body.get('id') == 'pageContent':
        section = next(iter(body.xpath('ancestor::section[@id="section-to-scroll"]')), None)
        if section is not None:
            galleries = section.xpath('following-sibling::section[1]//*[@id="mygallery"]')
            if len(galleries) == 1:
                return [(n, [n.get('original-src')]) for n in galleries[0].xpath('.//img[@original-src]')
                        if n.get('original-src').startswith('/mediafiles/mediafiles/dropzone_files/Post/')
                        and n.getparent().get('data-original') == n.get('original-src')]
    elif host == 'azertag.az' and has(body, 'news-body'):
        scope = next((p for p in body.iterancestors() if has(p,'sa-post') and has(p,'app-post')),None)
        if scope is not None:
            galleries=[n for n in scope.xpath('.//div[@class]') if has(n,'news-gallery')]
            return [(n, [n.getparent().get('href')]) if n.getparent().tag=='a'
                    and re.search(r'\.(?:jpe?g|png|webp)(?:\?|$)',n.getparent().get('href') or '',re.I)
                    else (n,None) for gallery in galleries for n in gallery.xpath('.//img')]
    elif host == 'avesta.tj':
        for scope in list(body.iterancestors())[:5]:
            heroes = [n for n in scope.xpath('.//img') if has(n, 'wp-post-image') and
                      any(has(p, 'jeg_featured') for p in n.iterancestors())]
            if len(heroes) == 1 and len(scope.xpath('.//h1')) == 1:
                headline = ' '.join(scope.xpath('.//h1')[0].text_content().split())
                if title_matches(heroes[0].get('alt') or '', headline):
                    return [(heroes[0], None)]
    return []


def article_image_candidates(tree, body, enclosing, page_url, meta):
    """Find displayed pictures tied to this article, excluding recommendation cards."""
    excluded = re.compile(r'logo|favicon|placeholder|default[-_]|spacer|avatar|sprite|tracking|\.svg(?:[?#]|$)', re.I)
    lead_images = {
        urljoin(page_url, meta[key]) for key in ('og:image', 'og:image:secure_url', 'twitter:image')
        if meta.get(key)
    }
    candidates = {}
    heroes = dict(publisher_hero_nodes(body, page_url))
    for node in dict.fromkeys([*heroes, *tree.xpath('//img')]):
        parents = list(node.iterancestors())
        if any(p.tag in ('nav', 'aside', 'footer') for p in parents):
            continue
        if node not in heroes and any(recommendation_card(p) for p in parents if p is not enclosing):
            continue
        if node.get('width') in ('0', '1') or node.get('height') in ('0', '1'):
            continue
        urls = [urljoin(page_url, v.strip()) for v in (heroes.get(node) or [])]
        for key in ('data-original', 'data-original-src', 'data-src', 'data-lazy-src', 'src'):
            value = (node.get(key) or '').strip()
            if value and not value.startswith(('data:', 'blob:')):
                urls.append(urljoin(page_url, value))
        responsive = node.xpath('../source') if node.getparent().tag == 'picture' else []
        for image_node in [node, *responsive]:
            for attribute in ('data-srcset', 'srcset'):
                value = image_node.get(attribute) or ''
                if value and not value.startswith('data:'):
                    urls.extend(urljoin(page_url, variant.split()[0]) for variant in value.split(',') if variant.strip())
        urls = [url for url in urls if urlparse(url).scheme == 'https' and not excluded.search(urlparse(url).path)]
        if not urls:
            continue
        figure = next((p for p in parents if p.tag == 'figure'), None)
        if node in heroes:
            basis = 'displayed_publisher_lead'
        elif body.tag != 'main' and body in parents:
            basis = 'article_body'
        elif enclosing is not None and enclosing in parents:
            basis = 'current_article'
        elif lead_images.intersection(urls):
            basis = 'displayed_publisher_lead'
        else:
            continue
        captions = figure.xpath('./figcaption') if figure is not None else []
        credit = ' '.join(captions[0].text_content().split())[:240] if captions else ''
        for url in urls:
            candidates.setdefault(url, {'url': url, 'basis': basis, 'publisherCaption': credit,
                                        'alt': (node.get('alt') or '')[:160]})
    return {'candidates': list(candidates.values())[:24],
            'metadataHints': sorted(url for url in lead_images if urlparse(url).scheme == 'https'
                                    and not excluded.search(urlparse(url).path))[:4]}


def parse_response(url,final_url,raw,headers):
    headers={k.lower():v for k,v in headers.items()}
    decoded=decode_transport(raw,headers.get('content-encoding',''))
    if len(decoded)>20_000_000:raise ValueError('decompressed_HTML_exceeds_20MB')
    probe=decoded.lstrip()[:400].lower()
    if any(m in headers.get('content-type','') for m in ('xml','json')) or any(
            marker in probe for marker in (b'<?xml',b'<rss',b'<feed',b'<urlset',b'<sitemapindex',b'<rdf:rdf')):
        feed=parse_feed(decoded,final_url)
        if feed is not None:
            return {**feed,'title':feed['format'],'text':'','source_kind':'listing',
                    'contentValidated':bool(feed['links'] or feed['discoveryEntries']),'fullTextValidated':False,
                    'parser_version':PARSER_VERSION,'transport_sha256':hashlib.sha256(raw).hexdigest(),
                    'final_url':final_url,'publicationEvidence':[]}
    decoded_text,decoded_encoding,encoding_evidence=decode_html(decoded,headers)
    if '<html' not in decoded_text[:5000].lower() and '<!doctype' not in decoded_text[:5000].lower():
        raise ValueError('response_is_not_HTML')
    tree=html.fromstring(decoded_text.encode('utf-8'),parser=html.HTMLParser(encoding='utf-8'),base_url=final_url);meta={}
    for n in tree.xpath('//meta[@content]'):
        k=n.get('property') or n.get('name')
        if k:meta[k]=n.get('content')
    headings=[' '.join(n.text_content().split()) for n in tree.xpath('//h1[not(ancestor::svg or ancestor::nav or ancestor::aside or ancestor::footer)]') if len(' '.join(n.text_content().split()))<500]
    title=meta.get('og:title') or next((t for t in headings if t),'') or ''.join(tree.xpath('//title/text()'))
    times=[{'text':n.text_content(),'datetime':n.get('datetime')} for n in tree.xpath('//time')]
    linked_data=[n.text for n in tree.xpath('//script[@type="application/ld+json"]')]
    page_links=[{'rel':n.get('rel'),'href':n.get('href'),'url':urljoin(final_url,n.get('href'))} for n in tree.xpath('//link[@href][@rel]') if {'canonical','next'} & set(n.get('rel').lower().split())]
    canonical=next((n['url'] for n in page_links if 'canonical' in n['rel'].lower().split()),None)
    discovery_entries=[urljoin(final_url,n.get('href')) for n in tree.xpath('//link[@href][@type][@rel]')
                       if n.get('type').lower().split(';')[0].strip() in FEED_TYPES
                       and 'alternate' in n.get('rel').lower().split()
                       and 'comment' not in n.get('href').lower()]
    source_kind,source_kind_evidence,primary_article=classify_source(tree,final_url,canonical,meta,linked_data)
    aliases=article_headline_aliases(linked_data,final_url,canonical)
    publisher_template=publisher_article_template(tree,final_url,canonical,meta,title,aliases)
    if publisher_template and publisher_template.get('headlineAlias'):
        aliases.append(publisher_template['headlineAlias'])
        if publisher_template['name'] == 'socar_az_current_post':
            title = publisher_template['headlineAlias']
    selected_body,body_evidence,bound_article=select_article_body(tree,title,aliases,publisher_template)
    if publisher_template and selected_body is not None and body_evidence.get('basis','').startswith('publisher_template:') and source_kind=='unknown':
        source_kind='article';source_kind_evidence.append({'basis':'publisher_article_template','template':publisher_template['name'],'identityBindings':publisher_template['identityBindings']})
    full_text_validated=source_kind=='article' and selected_body is not None
    if source_kind=='article':primary_article=bound_article
    publications,excluded_publications=publication_evidence(tree,linked_data,final_url,canonical,primary_article,publisher_template if full_text_validated else None)
    if full_text_validated and not (publisher_template or {}).get('localPublicationBadge'):
        publications.extend(publisher_header_clocks(tree,final_url,canonical,selected_body,body_evidence))
    links=[{'text':' '.join(n.text_content().split()),'url':urljoin(final_url,n.get('href')),'rel':n.get('rel'),'nearbyTimes':link_time_context(n),'inNavigation':link_in_navigation(n),**link_article_features(n)} for n in tree.xpath('//a[@href]') if n.text_content().strip()]
    images=[{'url':urljoin(final_url,n.get('src') or n.get('data-src') or ''),'alt':n.get('alt'),'title':n.get('title')} for n in tree.xpath('//img')]
    candidates=tree.xpath('//main') or tree.xpath('//body') or [tree]
    el=selected_body if selected_body is not None else max(candidates,key=lambda n:len(n.text_content()))
    text=clean_content(el,selected_body is not None,selected_body is not None or source_kind=='article')
    if full_text_validated and body_evidence.get('basis')=='publisher_template:khovar_published_post_shortcode_content':
        dateline=khovar_archive_dateline(canonical or final_url,text)
        if dateline:
            publications.append(dateline)
        footer=khovar_archive_publication_footer(canonical or final_url,text)
        if footer:
            publications.append(footer)
    reject_mojibake(title+'\n'+text,decoded_encoding,encoding_evidence)
    if (len(text)<80 or '\ufffd' in text[:100]) and not (source_kind=='article' and not full_text_validated):raise ValueError('unreadable_or_empty_HTML')
    result={'meta':meta,'title':title,'time_tags':times,'linked_data':linked_data,'links':links,'images':images,'text':text,'source_sha256':hashlib.sha256(text.encode()).hexdigest(),'source_kind':source_kind,'sourceKindEvidence':source_kind_evidence,'parser_version':PARSER_VERSION,'contentValidated':source_kind!='article' or full_text_validated,'fullTextValidated':full_text_validated,'articleBodyEvidence':body_evidence,'transport_sha256':hashlib.sha256(raw).hexdigest(),'final_url':final_url,'html_lang':tree.get('lang'),'canonical_url':canonical,'page_links':page_links,'publicationEvidence':publications,'excludedPublicationEvidence':excluded_publications,'decodedEncoding':decoded_encoding,'encodingEvidence':encoding_evidence}
    result['discoveryEntries']=list(dict.fromkeys(discovery_entries))[:5]
    if full_text_validated:
        lang_seen = set()
        language_alternates = []
        for ref in tree.xpath('//head/link[@hreflang][@href][@rel]'):
            lang = ref.get('hreflang').lower()
            target = normalized_url(ref.get('href'), final_url)
            if (not target or not target.startswith('https://') or target in lang_seen
                   or 'alternate' not in ref.get('rel').lower().split()
                   or not re.fullmatch(r'[a-z]{2,3}(?:-[a-z0-9]{2,8})*', lang)):
                continue
            if target != normalized_url(final_url,final_url):
                lang_seen.add(target)
                language_alternates.append({'language':lang,'url':target})
        if language_alternates:
            result['languageAlternates'] = language_alternates[:12]
        result['articleImages'] = article_image_candidates(tree, selected_body, bound_article, final_url, meta)
        author = meta.get('author') or meta.get('article:author')
        if author and len(author.strip())<=160 and not re.match(r'https?://',author):
            result['author'] = author.strip()
    if publisher_template and publisher_template['name']=='superkg_current_news_inside_text_author_time' and full_text_validated:
        publications, excluded, issues = superkg_publication_evidence(publications)
        result['publicationEvidence'] = publications
        excluded_publications.extend(excluded)
        if issues:result['publicationEvidenceIssues']=issues;result['publicationReviewRequired']=True
    if source_kind=='article' and not full_text_validated:result['error']='current_article_body_unverified_'+body_evidence['status']
    return result
def listing_minimum(value,now):
    if value is None:return None
    if not isinstance(value,str) or not value.strip():raise ValueError('listing-not-before requires a timezone-aware ISO timestamp')
    try:minimum=datetime.fromisoformat(value.replace('Z','+00:00'))
    except ValueError:raise ValueError('listing-not-before requires a timezone-aware ISO timestamp') from None
    if minimum.tzinfo is None or minimum.utcoffset() is None:raise ValueError('listing-not-before requires a timezone-aware ISO timestamp')
    if minimum>now:raise ValueError('listing-not-before cannot be in the future')
    return minimum
def network_worker(url, socket_timeout):
    """Read one response in an isolated process without touching the cache."""
    body = b''
    try:
        from source_article_images import public_opener, public_url
        public_url(url)
        with public_opener().open(url, timeout=socket_timeout) as response:
            body = response.read(MAX_TRANSPORT_BYTES + 1)
            result = {'status': response.status, 'final_url': response.url, 'response_headers': {
                k.lower(): v for k,v in response.headers.items()
                if k.lower() in ('content-encoding', 'content-type', 'etag', 'last-modified')}}
    except urllib.error.HTTPError as error:
        result = {'status': error.code, 'error': 'source_http_' + str(error.code),
                  'fetchRetryable': error.code in TRANSIENT}
        if error.code == 429:
            try:
                result['retryAfterSeconds'] = min(120, max(10, int(error.headers.get('Retry-After', '30'))))
            except ValueError:
                result['retryAfterSeconds'] = 30
    except ValueError:
        result = {'error': 'source_public_https_only', 'fetchRetryable': False}
    except (urllib.error.URLError, TimeoutError) as error:
        result = {'error': type(error).__name__ + ': ' + str(error)[:120], 'fetchRetryable': True}
    sys.stdout.buffer.write(json.dumps(result).encode() + b'\n' + body)


def bounded_response(url, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('source network deadline exceeded')
    try:
        # Socket timeouts cover inactivity only. The subprocess deadline also
        # covers DNS, redirects, and bodies that keep sending a trickle of data.
        worker = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--network-worker', url,
                                 str(min(25, remaining))], capture_output=True, timeout=remaining, check=True)
    except subprocess.TimeoutExpired as error:
        raise TimeoutError('source network deadline exceeded') from error
    metadata, separator, body = worker.stdout.partition(b'\n')
    if not separator:
        raise ValueError('source network worker returned no response')
    return json.loads(metadata), body


def fetch(url,listing_not_before=None,source_role='auto',network_timeout=MAX_NETWORK_SECONDS,*,fetch_metrics=None,recheck_article_body=False):
    if source_role is None:source_role='auto'
    if source_role not in ('auto','article','listing'):raise ValueError('source-role must be auto, article or listing')
    if not math.isfinite(network_timeout) or network_timeout <= 0:raise ValueError('network timeout must be finite and positive')
    deadline = time.monotonic() + min(network_timeout, MAX_NETWORK_SECONDS)
    S.mkdir(parents=True,exist_ok=True)
    key=hashlib.sha256(url.encode()).hexdigest()[:18];dest=S/(key+'.json');archive=S/(key+'.html.gz')
    retry_path=S/(key+'.retry.json')
    now=datetime.now(timezone.utc)
    minimum=listing_minimum(listing_not_before,now)
    metrics = fetch_metrics if fetch_metrics is not None else {}
    metrics.update(transportAttempts=0, cacheHits=0, archiveReparses=0)
    recheck = False

    def reuse(record):
        metrics['cacheHits'] += 1
        return record

    if dest.exists():
        old=json.loads(dest.read_text());status=old.get('status')
        if status in (401,403,404,410):return reuse(old)
        if status==200 and archive.exists() and old.get('parser_version')!=PARSER_VERSION:
            metrics['archiveReparses'] += 1
            try:
                raw=gzip.open(archive,'rb').read();parsed=parse_response(url,old.get('final_url',url),raw,old.get('response_headers',{}));old.update(parsed)
                if parsed.get('contentValidated'):old.pop('error',None)
                dest.write_text(json.dumps(old,ensure_ascii=False,indent=2))
            except Exception as error:
                old['contentValidated']=False;old['error']='cached_parse_'+str(error);old.update(parse_error_evidence(error));dest.write_text(json.dumps(old,ensure_ascii=False,indent=2));return reuse(old)
        if status == 200 and old.get('parser_version') == PARSER_VERSION and old.get('fullTextValidated') is False:
            # A confirmed article may first expose a placeholder and later a
            # real body. The focused pass gets at most one new request.
            incomplete = old.get('source_kind') == 'article'
            recheck = recheck_article_body and source_role == 'article' and not old.get('bodyRecheckedAt')
            recheck = recheck and (incomplete or old.get('source_kind') == 'unknown')
            if incomplete and not recheck:
                return reuse(old)
        if status==200 and old.get('contentValidated'):
            # Article and unresolved body evidence are immutable for this run.
            # Explicit registry listing jobs may refresh an unknown listing,
            # without asserting its identity. Confirmed article evidence stays
            # frozen even if a caller mistakenly supplies the listing hint.
            if old.get('source_kind') == 'article' or old.get('source_kind') == 'unknown' and source_role != 'listing':
                if not recheck:
                    return reuse(old)
            try:
                fetched=datetime.fromisoformat(old['fetchedAt'])
                age=(now-fetched).total_seconds()
            except (KeyError,ValueError,TypeError):age=10**9;fetched=None
            if not recheck and 0<=age<900 and (minimum is None or fetched>=minimum):return reuse(old)
    retry=json.loads(retry_path.read_text()) if retry_path.exists() else {}
    if retry and (retry['attempts'] >= 3 or now < datetime.fromisoformat(retry['resumeAt'])):
        result = retry['result']
        result['transportAttemptsTotal'] = retry['attempts']
        result['retryBudgetExhausted'] = retry['attempts'] >= 3
        # Older checkpoints stored the start time plus this exact backoff.
        # Recover that real attempt time; a cache read is never a new attempt.
        if not result.get('attemptedAt'):
            result['attemptedAt'] = (datetime.fromisoformat(retry['resumeAt'])
                - timedelta(seconds=result.get('retryAfterSeconds', 15))).isoformat()
        return reuse(result)
    result={'url':url,'fetchedAt':now.isoformat(),'key':key,'contentValidated':False,'parser_version':PARSER_VERSION}
    prior_attempts=retry.get('attempts',0)
    remaining_attempts = min(1 if recheck else 3, 3 - prior_attempts)
    for attempt in range(remaining_attempts):
        for field in ('status', 'error', 'fetchRetryable', 'retryAfterSeconds'):
            result.pop(field, None)
        try:
            if time.monotonic() >= deadline:
                raise TimeoutError('source network deadline exceeded')
            metrics['transportAttempts'] += 1
            result['attemptedAt'] = datetime.now(timezone.utc).isoformat()
            if recheck:
                old['bodyRecheckedAt'] = result['attemptedAt']
                dest.write_text(json.dumps(old,ensure_ascii=False,indent=2))
                result['bodyRecheckedAt'] = result['attemptedAt']
            result['transportAttemptsTotal'] = prior_attempts + metrics['transportAttempts']
            response, raw = bounded_response(url, deadline)
            result.update(response, attempts=attempt + 1)
            if not result.get('error'):
                if len(raw) > MAX_TRANSPORT_BYTES:
                    raise ValueError('transport_exceeds_10MB')
                with gzip.open(archive, 'wb') as handle:
                    handle.write(raw)
                result.update(parse_response(url, result['final_url'], raw, result['response_headers']))
                break
            if not result.pop('fetchRetryable'):
                break
            result['fetchRetryable'] = True
        except TimeoutError:
            result.update(error='source_network_deadline_exceeded', fetchRetryable=True, attempts=attempt+1)
            break
        except (subprocess.SubprocessError, OSError) as error:
            result.update(error=type(error).__name__+': '+str(error)[:120], fetchRetryable=True, attempts=attempt+1)
            break
        except Exception as error:
            result.update(error=type(error).__name__+': '+str(error)[:120],**parse_error_evidence(error));break
        delay = attempt + 1
        if result.get('status') == 429 or attempt + 1 >= remaining_attempts or time.monotonic() + delay >= deadline:
            break
        time.sleep(delay)
    if result.get('fetchRetryable'):
        attempts=prior_attempts+metrics['transportAttempts']
        result['retryBudgetExhausted']=attempts>=3
        if result['retryBudgetExhausted']:
            result['fetchRetryable']=False
        if result.get('status') is None:
            result['fetchedAt'] = None
        retry_path.write_text(json.dumps({'attempts':attempts,'result':result,
            'resumeAt':(now+timedelta(seconds=result.get('retryAfterSeconds', 15))).isoformat()}))
        return result
    retry_path.unlink(missing_ok=True)
    if result.get('contentValidated'):result.pop('error',None)
    dest.write_text(json.dumps(result,ensure_ascii=False,indent=2));return result
if __name__=='__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--network-worker':
        network_worker(sys.argv[2], float(sys.argv[3]));sys.exit(0)
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--audit',type=Path);parser.add_argument('--listing-not-before',help='Require a real listing fetch at or after this timezone-aware ISO timestamp; must not be future');parser.add_argument('--source-role',choices=('auto','article','listing'),default='auto',help='Registry job role for cache freshness only; does not establish article/listing identity');args=parser.parse_args()
    try:listing_minimum(args.listing_not_before,datetime.now(timezone.utc))
    except ValueError as error:parser.error(str(error))
    urls=json.load(sys.stdin)
    if not isinstance(urls,list) or not all(isinstance(u,str) and urlparse(u).scheme in ('http','https') for u in urls):raise SystemExit('expected_public_URL_array')
    records=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for r in pool.map(lambda url:fetch(url,args.listing_not_before,args.source_role),dict.fromkeys(urls)):
            records.append({'url':r.get('url'),'fetchedAt':r.get('fetchedAt'),'status':r.get('status'),'contentValidated':r.get('contentValidated',False),'kind':r.get('source_kind','unknown'),'error':r.get('error')})
            print(json.dumps({k:r.get(k) for k in ['url','key','fetchedAt','source_kind','status','contentValidated','title','error','attempts']},ensure_ascii=False),flush=True)
    if args.audit:args.audit.write_text(json.dumps(records,ensure_ascii=False,indent=2))
