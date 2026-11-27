"""Bound discovery work without asserting that unfetched news was completed."""
from collections import defaultdict
from datetime import datetime,timedelta
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit

VERSION = 'bounded-news-queue-2'
MAX_ACTIVE_ARTICLES = 96
MAX_ARTICLES_PER_SOURCE = 12
MAX_LISTING_PAGES = 2
ADAPTIVE_LISTING_PAGES = 4
ADAPTIVE_ARTICLES_PER_SOURCE = 24
ADAPTIVE_LISTING_FRACTION = .40
ADAPTIVE_WORKERS = 3
ADAPTIVE_DOMAIN_WORKERS = 1
# Only source evidence can extend per-source collection beyond its base share.
ADAPTIVE_EXTRA_LISTING_PAGES = 3
ADAPTIVE_EXTRA_ARTICLES = 12
ARCHIVE_PUBLICATIONS = json.loads(Path(__file__).with_name('verified_archive_publications.json').read_text())
NOV27_UZ_COVERAGE_EVIDENCE = json.loads(Path(__file__).with_name('nov27_uz_coverage_evidence.json').read_text())
# Exact archive stories whose same substantive disclosure can be dated independently.
# Super's issue 1248 covers Nov 20–26. News.KG already reported the deputy
# minister's 25% growth, ~1,000 new objects and both annual figures on Nov 21.
# https://news.kg/ru/news/potreblenie-elektroenergii-v-kyrgyzstane-vyroslo-na-25-za-5-let-minenergo
PRIOR_DISCLOSURE_DAYS = {
    'https://www.super.kg/article/show/63454': '2026-11-21',
    # The publisher's full special project and the original headline were
    # syndicated under this title by Medichub on 2021-03-15 (story 759461).
    'https://podrobno.uz/lp/ragida-hurmuhametova': '2021-03-15',
    # Four Finprom back issues with dated republications. The named reporting
    # sources repeat the distinctive headlines and explicitly cite Finprom.
    # PRG 39853748 (2021-04-30), Kazinform a3742756 (2021-01-19),
    # Wfin 34573 (2020-01-29), Inbusiness 12.06.20 (links to Finprom).
    'https://finprom.kz/ru/article/kapitalnye-investicii-v-selskoj-mestnosti-ushli-v-minus-srazu-na-36-za-god': '2021-04-30',
    'https://finprom.kz/ru/article/investicii-v-sferu-gosupravleniya-i-oborony-prevysili-proshlogodnie-pokazateli-pochti-na-dve-treti': '2021-01-19',
    'https://finprom.kz/ru/article/kapitalnye-investicii-kompanij-rabotayushih-v-sfere-finansov-i-strahovaniya-na-99-obespechivayutsya-sobstvennymi-sredstvami-biznesa': '2020-01-29',
    'https://finprom.kz/ru/article/v-sfere-gornodobyvayushej-promyshlennosti-11-dejstvuyushih-predpriyatij-inostrannye-v-torgovle-i-nauke-takih-kompanij-bolee-9': '2020-06-12',
}
IMPORTANT = re.compile(
    r'energy|electric|power|renewab|solar|wind|neft|socar|\bgas\b|\boil\b|'
    r'invest|financ|credit|kredit|tender|contract|privatiz|sanction|bankrupt|'
    r'decree|regulat|tariff|\btax\b|nalog|zakon|ukaz|postanovlen|'
    r'energi|enerhe|gazov|tamozh|export|import|promysh|stroitel|transport|'
    r'энерг|электр|нефт|газов|инвест|кредит|финанс|налог|закон|постановлен|'
    r'санкц|тамож|экспорт|импорт|энерг|能源|政策|投资|经营', re.I)

# These are publisher directories, not particular news stories. Keep them in
# independent coverage review; a keyword such as "credit" is not a news lead.
DIRECTORY = re.compile(
    r'/(?:credit-organizations(?:/(?:banks|auditors|microcredit|microfinance|lombards))?'
    r'|arkhiv-kursov-valyut(?:/(?:dinamika-kursov-valyut|informer-kursa-valyut))?'
    r'|page/(?:aciq-melumatlar|elanlar(?:/bankruptcy-announcements)?)'
    r'|about|contacts|contact|sitemap|privacy|terms)/?$',re.I)


# These exact index/reference paths were discovered as pending work in the
# Nov 24 production queue. They are not article URLs merely because a path
# contains investment, credit or tender. Leave them in independent coverage
# review, retaining queue identities; never mark them as fetched/verified.
# Restrict by publisher hostname and match the entire path. A news article
# beneath any of these paths must NOT match.
STATIC_DIRECTORY_BY_HOST = {
    'cbu.uz': re.compile(
        r'^/(?:ru|uz|en)/(?:'
        r'credit-organizations(?:/(?:banks(?:/(?:branches|exchange-offices|head-offices|rating-scores))?'
        r'|auditors|microcredit|microfinance|lombards|bureaus|factoring|guarantee'
        r'|licensing|mortgage|offices-foreign-banks))?'
        r'|financial-inclusion(?:/(?:indicators|reviews|strategy|womens))?'
        r'|financial-stability(?:/(?:banks-list(?:/(?:list|procedure))?|enterprises'
        r'|macroprudential-policy-(?:strategy|tools(?:/(?:buffer-for-systemically-important-banks'
        r'|capital-conservation-buffer|countercyclical-capital-buffer|debt-service-to-income'
        r'|debt-to-income|loan-to-value))?)|press-releases|report|research-analysis'
        r'|votes/(?:debt-burden-survey|systemic-risk-survey)))?'
        r'|monetary-policy/refinancing-rate(?:/schedule-of-meetings)?'
        r'|monetary-policy/(?:local-currency-yield-curve|standards-required-reserves'
        r'|money-market-operations(?:/interbank-(?:money|repo)-market)?)'
        r'|banknotes-coins(?:/gold-bars/sale-and-buy-back-offices)?|combating-money-laundering'
        r'|arkhiv-kursov-valyut/veb-masteram|anti-corruption/send'
        r'|consumer-protection/(?:reminder-of-consumer-banking-services|work-with-consumers-of-banking-services)'
        r'|documents/list-projects-normative|payment-systems/(?:registers/operators-of-payment-systems|remote-banking-services)'
        r'|press_center/(?:articles-and-interviews|forums-and-conferences)'
        r'|press_center/forums-and-conferences/samarkand-islamic-finance-forum-2026'
        r'|publications/balance-of-payments'
        r'|services/(?:regulations|regulatory-sandbox|results-of-applications|task-execution-states'
        r'|citizens/(?:helpline-commercial-banks|request-for-information))'
        r'|statistics/(?:credit|financing|calendar-statistical-data)'
        r'|anti-corruption/(?:documents|handouts)'
        r')/?$', re.I),
    'economy.gov.az': re.compile(
        r'^/(?:az/page/(?:iqtisadiyyat/investisiya|itm'
        r'|beynelxalq-elaqeler/maliyye-institutlari-ile-emekdasliq/asiya-infrastruktur-investisiya-banki-aiib)'
        r'|en/page/(?:iqtisadiyyat/investisiya|beynelxalq-elaqeler/maliyye-institutlari-ile-emekdasliq))/?$', re.I),
    'customs.gov.az': re.compile(r'^/az/faydali/(?:satınalmalar/tender|gomruk-statistikasi/tariff-statistics)/?$', re.I),
    'nuz.uz': re.compile(r'^/(?:politika|zdorove|obschestvo)/?$', re.I),
    'gov.uz': re.compile(r'^/(?:ru|uz|en)/soliq/pages/soliq-qo-mitasi-faoliyat-sohasi/?$', re.I),
    'uzdaily.uz': re.compile(r'^/(?:ru|uz|en)/special-projects(?:/islamic-finance-2026)?/?$', re.I),
    'sputnik.tj': re.compile(r'^/(?:telegram_export/?|docs/(?:cookie_policy|privacy_policy|terms_of_use|index)\.html)$', re.I),
    'ozodi.org': re.compile(r'^/(?:z/(?:538|3537|22610|23512|17274|17632|23080|23154)|p/(?:4447|8609|8803)\.html|qissai-khudro-bigu)/?$', re.I),
    'vecherka.tj': re.compile(
        r'^/(?:istorii/(?:borba-s-radikalizmom|dney-16-protiv-nasiliya|grazhdanskie-zhurnalisty'
        r'|otkritie-uroki|prava-jenshin|reforma-militsii|roditeli-i-deti|svoboda-slova|zashita_zhivotnikh)'
        r'|spets-proekti/(?:blogotvoritelniye|ekologicheskiye|mediagramotnost|obrazovatelniye|razvlekatelniye)'
        r'|podrobno/cpravochnaja-informacija|reklamodatelyam)/?$', re.I),
    'kz.kursiv.media': re.compile(r'^/(?:en/category/economics/banks-finance|expert/marlen-sihaev|guide/czifrovye-ekosistemy-v-kazahstane)/?$', re.I),
    'transport.ec.europa.eu': re.compile(r'^/(?:news-events/news_(?:nl|sk|sl|uk)|select-language)/?$', re.I),
    'spot.uz': re.compile(r'^/ru/legislation/?$', re.I),
    'president.uz': re.compile(r'^/ru/site/document/2/?$', re.I),
    'fm.gov.om': re.compile(r'^/en/royal-decrees/?$', re.I),
    # Exact KZ reference/index pages from the 11/24 queue. Actual KASE news
    # items and Inbusiness article URLs remain hard-blocking article work.
    'kase.kz': re.compile(r'^/(?:en/investors/esg-data-platform/knowledge-hub|en/markets/dfa)/?$', re.I),
    'inbusiness.kz': re.compile(
        r'^/ru/(?:cat/(?:biznes/transport-i-logistika|ekonomika/nalogi-i-sbory|finansy/pravila-igry-finance)'
        r'|specprojects/(?:kak-qazaq-oil-kontroliruet-klyuchevye-protsessy|qazaq-oil-itogi-2023'
        r'|tulpar-toplivo-novogo-pokoleniya-ot-qazaq-oil))/?$', re.I),
}


def publisher_reference_directory(url):
    parsed = urlsplit(url)
    path = unquote(parsed.path)
    if DIRECTORY.search(path):
        return True
    host = (parsed.hostname or '').lower()
    if host.startswith('www.'):
        host = host[4:]
    rule = STATIC_DIRECTORY_BY_HOST.get(host)
    return bool(rule and rule.fullmatch(path))




def _parse_listing_date_hint(raw):
    """Parse an article-card date for triage only; never treat it as publication proof."""
    if not isinstance(raw, str) or not raw.strip() or len(raw)>160:
        return None, False
    value=raw.strip()
    try:
        parsed=datetime.fromisoformat(value.replace('Z','+00:00').replace('z','+00:00'))
        return parsed, bool(parsed.tzinfo and parsed.utcoffset() is not None)
    except ValueError:
        pass
    match=re.fullmatch(r'(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})',value)
    if match:
        try:return datetime(int(match[1]),int(match[2]),int(match[3])),False
        except ValueError:return None,False
    match=re.fullmatch(r'(\d{1,2})[./-](\d{1,2})[./-](20\d{2})',value)
    if match:
        try:return datetime(int(match[3]),int(match[2]),int(match[1])),False
        except ValueError:return None,False
    months={
        'january':1,'jan':1,'январь':1,'января':1,'yanvar':1,
        'february':2,'feb':2,'февраль':2,'февраля':2,'fevral':2,
        'march':3,'mar':3,'март':3,'марта':3,'mart':3,
        'april':4,'apr':4,'апрель':4,'апреля':4,'aprel':4,
        'may':5,'май':5,'мая':5,
        'june':6,'jun':6,'июнь':6,'июня':6,'iyun':6,
        'july':7,'jul':7,'июль':7,'июля':7,'iyul':7,
        'august':8,'aug':8,'август':8,'августа':8,'avgust':8,
        'september':9,'sep':9,'сентябрь':9,'сентября':9,'sentyabr':9,
        'october':10,'oct':10,'октябрь':10,'октября':10,'oktyabr':10,
        'november':11,'nov':11,'ноябрь':11,'ноября':11,'noyabr':11,
        'december':12,'dec':12,'декабрь':12,'декабря':12,'dekabr':12,
    }
    match=re.fullmatch(r'(\d{1,2})[\s,]+([A-Za-zА-Яа-яЁё]+)[\s,]+(20\d{2})',value,re.I)
    if match:
        month=months.get(match[2].casefold())
        if month:
            try:return datetime(int(match[3]),month,int(match[1])),False
            except ValueError:return None,False
    return None,False


def listing_card_date_is_old(row, window_end):
    """A unique date adjacent to this article card may flag stale discovery for review."""
    if not window_end:return False
    try:window_start=datetime.fromisoformat(window_end)-timedelta(days=1)
    except ValueError:return False
    hints=[]
    for anchor in row.get('anchorEvidence',[]):
        if not isinstance(anchor,dict) or not (anchor.get('articleCard') or anchor.get('inHeading')) or anchor.get('inNavigation'):
            continue
        for item in anchor.get('nearbyTimes') or []:
            raw=(item.get('datetime') or item.get('text')) if isinstance(item,dict) else item
            parsed,has_timezone=_parse_listing_date_hint(raw)
            if parsed is None or has_timezone and window_start.tzinfo is None:
                return False
            if isinstance(item,dict) and item.get('datetime') and item.get('text'):
                label,_=_parse_listing_date_hint(item['text'])
                if label is not None and label.date()!=parsed.date():
                    return False
            hints.append((parsed,has_timezone))
    unique={(value.isoformat(),has_timezone) for value,has_timezone in hints}
    if len(unique)!=1:return False
    raw,has_timezone=next(iter(unique))
    parsed=datetime.fromisoformat(raw)
    if has_timezone:return parsed<window_start
    # A date-only label may be local to the publisher. Leave the preceding
    # calendar day ambiguous; only clearly older dates become triage hints.
    return parsed.date() < (window_start.date()-timedelta(days=1))



def requires_body_evidence(work, info):
    """Direct in-window or explicit evidence outranks route and archive hints."""
    return work.get('kind') in ('article', 'lead') and any(
        row.get('mustProcess') is True or row.get('important') is True
        or row.get('priority') in ('critical', 'important')
        or row.get('publicationWindowAssessment') == 'in_window'
        for row in (work, info.get('lead') or {}, info.get('candidate') or {}))


def archived_publication_is_old(url, row, window_end, dates=ARCHIVE_PUBLICATIONS):
    """A previously dated publisher URL is a review hint, never editorial approval."""
    address = urlsplit(url)
    if address.scheme != 'https' or address.fragment or not window_end or row.get('rawPublicationEvidence'):
        return False
    published = dates.get(url.rstrip('/'))
    if not published:
        return False
    window_start = datetime.fromisoformat(window_end) - timedelta(days=1)
    safe_day = window_start.date() - timedelta(days=1)
    published_at = datetime.fromisoformat(published)
    exact = published_at.tzinfo is not None and window_start.tzinfo is not None
    if (published_at >= window_start if exact else published_at.date() >= safe_day):
        return False
    confirmed_earlier_local_day = exact and published_at.date() < window_start.astimezone(published_at.tzinfo).date()
    for anchor in row.get('anchorEvidence') or []:
        if not isinstance(anchor, dict) or anchor.get('inNavigation'):
            continue
        for item in anchor.get('nearbyTimes') or []:
            raw = (item.get('datetime') or item.get('text')) if isinstance(item, dict) else item
            stamp, _ = _parse_listing_date_hint(raw)
            if stamp is None:
                return False
            if stamp.tzinfo is not None and window_start.tzinfo is not None:
                if stamp >= window_start:
                    return False
            elif stamp.date() >= safe_day and not (confirmed_earlier_local_day and stamp.date() == published_at.date()):
                return False
    return True


def verified_source_date_is_old(url, candidate, window_end):
    """Check article-bound archived publication evidence, even if prose was unavailable."""
    if (not window_end or candidate.get('machineArticleKind') != 'article'
            or not re.fullmatch(r'[0-9a-f]{64}', str(candidate.get('sourceJSONSha256', '')))):
        return False
    raw = candidate.get('rawPublicationEvidence')
    if isinstance(raw, dict):
        raw = raw.get('items', [raw])
    if not isinstance(raw, list):
        return False
    published = [item for item in raw if isinstance(item, dict) and item.get('kind') == 'published']
    start = datetime.fromisoformat(window_end) - timedelta(days=1)
    if not published:
        return False
    for item in published:
        if str(item.get('articleUrl') or '').rstrip('/') != url.rstrip('/'):
            return False
        stamp, has_timezone = _parse_listing_date_hint(item.get('raw'))
        if stamp is None or (stamp >= start if has_timezone and start.tzinfo
                             else stamp.date() >= start.date() - timedelta(days=1)):
            return False
    return True


def bounded_review_reason(work, info, window_end):
    """Classify discovery obligations, never mark unread stories completed."""
    candidate, lead = info.get('candidate') or {}, info.get('lead') or {}
    row = {**lead, **candidate, 'url': work.get('url')}
    if requires_body_evidence(work, info) or not work.get('url'):
        return None
    if publisher_reference_directory(work['url']):
        return 'publisher_directory_requires_coverage_review'
    if window_end=='2026-11-27T06:00:00+08:00' and work.get('kind') in ('article','lead'):
        recovery = NOV27_UZ_COVERAGE_EVIDENCE.get(work['url'].rstrip('/'))
        if recovery and recovery['sourceId']==work.get('sourceId'):
            return recovery['reason']
    priority = importance(row, window_end)
    if work.get('kind') in ('article','lead') and priority.get('listingCardDateHint'):
        return 'listing_card_old_date_requires_coverage_review'
    if work.get('kind') in ('article','lead') and (
            verified_source_date_is_old(work['url'], candidate, window_end)
            or archived_publication_is_old(work['url'], row, window_end)):
        return 'archived_publication_requires_coverage_review'
    if work.get('kind') in ('article', 'lead') and archived_publication_is_old(
            work['url'], row, window_end, PRIOR_DISCLOSURE_DAYS):
        return 'prior_first_disclosure_requires_coverage_review'
    if priority['archiveUrlHint'] and not priority['important']:
        # A dated URL is only a triage hint. It does not prove an article's
        # publication date; a genuinely identified important headline
        # must still be checked even if the URL has an older date.
        return 'archive_url_discovery_requires_coverage_review'
    # An unread article without a recorded queue assessment is not proven
    # ordinary merely because its URL lacks a priority keyword. Only leads
    # can use this broad fallback; article bodies need stronger evidence in
    # partition_coverage below (or an exact static/directory URL above).
    if not priority['important'] and work['kind'] == 'lead':
        return 'ordinary_discovery_requires_coverage_review'
    return None


def digest(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,
                                     separators=(',', ':')).encode()).hexdigest()


def importance(row, window_end=None):
    """Positive priority only; an archive hint is never publication proof."""
    explicit = row.get('important') is True or row.get('mustProcess') is True
    explicit |= row.get('priority') in ('critical','important')
    url = row.get('source_url') or row.get('url') or ''
    labels = [str(row.get('title') or '')]
    labels += [str(a.get('text') or '') for a in row.get('anchorEvidence', [])
               if (a.get('inHeading') or a.get('articleCard')) and not a.get('inNavigation')]
    archive_hint = False
    listing_date_hint = listing_card_date_is_old(row, window_end)
    # Publishers use both /YYYY/MM/DD/ and /YYYY-MM-DD/ path segments.
    # Only a complete date segment is a triage hint, never publication proof.
    date = re.search(r'/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})(?:/|$)', urlsplit(url).path)
    if window_end and date:
        try:
            archive_hint = datetime(int(date[1]),int(date[2]),int(date[3])).date() < (datetime.fromisoformat(window_end)-timedelta(days=1)).date()
        except ValueError:
            pass
    # Explicitly identified important work remains blocking even on a dated URL.
    return {'important': bool(explicit or IMPORTANT.search(' '.join(labels))
                              or not archive_hint and IMPORTANT.search(unquote(url))),
            'archiveUrlHint': archive_hint, 'listingCardDateHint': listing_date_hint,
            'explicitImportant': bool(explicit),
            'basis': 'positive_headline_or_url_priority_not_publication_proof'}


def partition_coverage(proof, sources, metadata=None):
    """Keep all queue counts; only bounded discovery becomes signed review work.

    Known/unknown article bodies remain blocking unless their actual structural
    identity is a nonarticle or the collector explicitly assessed them as an
    unfetched ordinary discovery lead. No count or failed publisher clears a
    specific important story.
    """
    from discover_work_sources import lead_route, source_entries
    metadata = metadata or {}
    original = proof['pendingWork'] + proof.get('reviewWork', []) + proof.get('closedQueueWork', [])
    before = list(proof['pendingWork'])
    originals_by_source = defaultdict(set)
    for row in original:
        if row.get('url') and row['kind'] in ('lead','article'):
            originals_by_source[row['sourceId']].add(row['url'])
    bounded = proof.get('scanBudget',{}).get('bounded') is True
    pending, review = [], list(proof.get('reviewWork', []))
    gaps = proof['gaps']
    deferred_ids = []

    def defer(row, reason, kind=None):
        value = {**row, 'kind':kind or row['kind'], 'reason':reason}
        review.append(value)
        gap = next((g for g in gaps if g['sourceId']==row['sourceId']),None)
        if gap is None:
            gaps.append({'sourceId':row['sourceId'],'reason':'unfinished_discovery_requires_review','evidence':[]})
        if kind == 'candidate':
            candidate = metadata.get((row['sourceId'],row.get('url')),{}).get('candidate')
            if candidate:
                deferred_ids.append({'id':candidate['id'],'sourceId':row['sourceId'],
                    'sourceUrl':row.get('url'),'sourceHash':candidate.get('sourceHash'),
                    'sourceJSONSha256':candidate.get('sourceJSONSha256')})

    for work in before:
        sid, url, kind = work['sourceId'], work.get('url'), work['kind']
        info = metadata.get((sid,url),{})
        if requires_body_evidence(work, info):
            pending.append(work)
            continue
        candidate = info.get('candidate') or {}
        lead = info.get('lead') or {}
        source = sources.get(sid, {'id':sid,'entrypoints':[]})
        route = lead_route(url,source,{e['url'] for e in source_entries(source)})[0] if url else None
        priority = importance({**lead, **candidate, 'url':url}, proof['windowEnd'])
        triage = bounded_review_reason(work, info, proof['windowEnd']) if bounded else None
        if triage:
            defer(work,triage,'candidate' if work['reason']=='discovered_article_needs_body_or_review' else None)
            continue
        if not bounded or not url or kind in ('source','increment'):
            # Budget summaries can be reviewed only when the saved source queue
            # actually accounts for their remaining jobs. Anonymous work blocks.
            evidence = info.get('budget')
            accounted = len(originals_by_source[sid])
            if (bounded and kind=='article' and not url and evidence
                    and 0 < evidence.get('remaining',0) <= accounted):
                defer(work,'accounted_article_budget_requires_review','budget')
            else:
                pending.append(work)
        elif kind == 'listing':
            defer(work,'bounded_incremental_discovery_requires_review')
        elif kind == 'lead' and (route in ('listing','static_page') or not priority['important']):
            defer(work,'unread_discovery_lead_requires_coverage_review')
        elif kind == 'article' and route in ('listing','static_page'):
            defer(work,'structural_nonarticle_requires_coverage_review',
                  'candidate' if work['reason']=='discovered_article_needs_body_or_review' else None)
        elif (kind == 'article' and not priority['important']
              and work['reason']=='article_body_pending'
              and lead.get('queueAssessment',{}).get('version')==VERSION
              and lead['queueAssessment'].get('important') is False):
            defer(work,'unfetched_ordinary_discovery_body_requires_review')
        elif (kind == 'article' and not priority['important'] and candidate
              and candidate.get('fullTextValidated') is not True
              and candidate.get('machineArticleKind') not in ('article',None)
              and candidate.get('queueAssessment',{}).get('version')==VERSION):
            defer(work,'unverified_nonarticle_body_requires_coverage_review','candidate')
        else:
            pending.append(work)

    def queue_kind(row):
        if row['kind'] in ('listing','lead'):return row['kind']
        if row['kind']=='article' and row['reason'] not in (
                'discovered_article_needs_body_or_review','unresolved_discovery_budget'):
            return 'article'
        return None

    # Recover queue identities from the actual assessment, not guessed counts.
    members = {kind:{} for kind in ('listing','article','lead')}
    for row in original:
        kind=queue_kind(row)
        if kind and row.get('url'):
            members[kind][(row['sourceId'],row['url'])]=row
    pending_keys={(r['sourceId'],r.get('url'),queue_kind(r)) for r in pending}
    closed_keys={(r['sourceId'],r.get('url'),r['kind']) for r in proof.get('closedQueueWork',[])}
    account = {}
    for kind, entries in members.items():
        states = {'pending':0,'review':0,'closed':0}
        for sid,url in entries:
            if (sid,url,kind) in pending_keys:
                states['pending']+=1
            elif (sid,url,kind) in closed_keys:
                states['closed']+=1
            else:states['review']+=1
        total = proof['queues'][kind]
        if total != len(entries):
            pending.append({'sourceId':'discovery','kind':kind,'url':None,'reason':'unaccounted_queue_identity'})
        account[kind]={'total':total,**states,'identityHash':digest(sorted(entries))}

    groups=defaultdict(list)
    for row in review:groups[(row['sourceId'],row['kind'])].append(row)
    grouped=[]
    for (sid,kind),rows in sorted(groups.items()):
        unique={json.dumps(r,sort_keys=True,ensure_ascii=False):r for r in rows}
        rows=[unique[k] for k in sorted(unique)]
        urls=sorted({r['url'] for r in rows if r.get('url')})
        grouped.append({'sourceId':sid,'kind':kind,'url':urls[0] if len(urls)==1 else None,
            'reason':'bounded_unfinished_work_requires_independent_review','count':len(rows),
            'queueHash':digest(rows),'examples':urls[:3]})
    proof.update(pendingWork=sorted(pending,key=lambda r:(r['sourceId'],r['kind'],r.get('url') or '',r['reason'])),
        reviewWork=grouped, queueAccounting=account,deferredCandidates=sorted(deferred_ids,key=lambda r:r['id']),
        discoveryEnd={'version':VERSION,'bounded':bounded,'originalPendingCount':len(before),
            'originalWorkHash':digest(original),'unfinishedWorkCompleted':False},
        state='blocked' if pending else 'review_required' if gaps else 'observed')
    return proof


def validate_queue_accounting(coverage):
    """Reject deleted queues or unsigned discovery summaries before release."""
    for kind in ('listing','article','lead'):
        counts=coverage.get('queueAccounting',{}).get(kind,{})
        expected=coverage.get('queues',{}).get(kind)
        review=sum(row.get('count',1) for row in coverage.get('reviewWork',[]) if row['kind']==kind)
        closed=sum(row['kind']==kind for row in coverage.get('closedQueueWork',[]))
        if (any(type(counts.get(key)) is not int or counts[key]<0 for key in ('total','pending','review','closed'))
                or not re.fullmatch(r'[0-9a-f]{64}',str(counts.get('identityHash','')))
                or counts['total']!=expected or counts['pending']!=0
                or counts['review']!=review or counts['closed']!=closed or counts['total']!=review+closed):
            raise ValueError('coverage_evidence_invalid')
    for row in coverage.get('reviewWork',[]):
        if (type(row.get('count')) is not int or row['count']<1
                or not re.fullmatch(r'[0-9a-f]{64}',str(row.get('queueHash','')))
                or not any(g['sourceId']==row['sourceId'] for g in coverage.get('gaps',[]))):
            raise ValueError('coverage_evidence_invalid')
