"""Bound discovery work without asserting that unfetched news was completed."""
from collections import defaultdict
from datetime import datetime,timedelta
import hashlib
import json
import re
from urllib.parse import unquote, urlsplit

VERSION = 'bounded-news-queue-2'
MAX_ACTIVE_ARTICLES = 96
MAX_ARTICLES_PER_SOURCE = 12
MAX_LISTING_PAGES = 2
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
        r'|press_center/forums-and-conferences/samarkand-islamic-finance-forum-2026'
        r'|services/(?:regulations|regulatory-sandbox)|statistics/(?:credit|financing)'
        r')/?$', re.I),
    'economy.gov.az': re.compile(r'^/az/page/(?:iqtisadiyyat/investisiya|itm)/?$', re.I),
    'customs.gov.az': re.compile(r'^/az/faydali/satınalmalar/tender/?$', re.I),
    'gov.uz': re.compile(r'^/(?:ru|uz|en)/soliq/pages/soliq-qo-mitasi-faoliyat-sohasi/?$', re.I),
    'uzdaily.uz': re.compile(r'^/(?:ru|uz|en)/special-projects/islamic-finance-2026/?$', re.I),
    'sputnik.tj': re.compile(r'^/telegram_export/?$', re.I),
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



def bounded_review_reason(work, info, window_end):
    """Classify discovery obligations, never mark unread stories completed."""
    candidate, lead = info.get('candidate') or {}, info.get('lead') or {}
    row = {**lead, **candidate, 'url': work.get('url')}
    explicit = any(r.get('important') is True or r.get('mustProcess') is True
                   or r.get('priority') in ('critical','important') for r in (lead,candidate,work))
    if explicit or not work.get('url'):
        return None
    if publisher_reference_directory(work['url']):
        return 'publisher_directory_requires_coverage_review'
    priority = importance(row, window_end)
    if priority['archiveUrlHint']:
        # A dated URL is only a triage hint. It does not prove an article's
        # publication date or resolve a genuinely identified current event.
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
    date = re.search(r'/(20\d{2})/(\d{1,2})/(\d{1,2})/', urlsplit(url).path)
    if window_end and date:
        try:
            archive_hint = datetime(int(date[1]),int(date[2]),int(date[3])).date() < (datetime.fromisoformat(window_end)-timedelta(days=1)).date()
        except ValueError:
            pass
    # Explicitly identified important work remains blocking even on a dated URL.
    return {'important': bool(explicit or IMPORTANT.search(' '.join(labels))
                              or not archive_hint and IMPORTANT.search(unquote(url))),
            'archiveUrlHint': archive_hint, 'basis': 'positive_headline_or_url_priority_not_publication_proof'}


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
