"""Summarize persisted collection evidence without inferring editorial pass rates."""
from collections import Counter, defaultdict
import re
import unicodedata
from urllib.parse import urlsplit


def stage_loss(before, after):
    return round((before - after) / before, 4) if before and 0 <= after <= before else None


def scan_funnel(sources, audit, leads, candidates):
    by_source = defaultdict(Counter)
    pages = defaultdict(dict)
    articles = defaultdict(dict)
    for row in audit:
        sid = row['sourceId']
        url = row.get('url')
        if not url or not (row.get('fetchedAt') or row.get('attemptedAt')):
            continue
        kind = row.get('role')
        if kind == 'article':
            previous = articles[sid].get(url)
            if previous is None or (row.get('fetchedAt') or row.get('attemptedAt')) >= (
                    previous.get('fetchedAt') or previous.get('attemptedAt')):
                articles[sid][url] = row
            continue
        if kind not in ('home', 'listing', 'section', 'pagination', 'archive', 'date_archive', 'language', 'feed', 'sitemap'):
            continue
        previous = pages[sid].get(url)
        if previous is None or (row.get('fetchedAt') or row.get('attemptedAt')) >= previous['at']:
            pages[sid][url] = {'url':url, 'at':row.get('fetchedAt') or row.get('attemptedAt'),
                               'httpStatus':row.get('status'), 'readable':row.get('contentValidated') is True,
                               'newsLinks':row.get('newsLinksFound'), 'format':row.get('discoveryFormat'),
                               'error':row.get('error')}
    for row in leads:
        if row.get('leadType') not in ('static_page','listing'):
            by_source[row['sourceId']]['discoveredUrls'] += 1
            if row.get('status')=='queued':
                by_source[row['sourceId']]['unfetchedUrls'] += 1
    for row in candidates:
        stats = by_source[row['sourceId']]
        stats['articleCandidates'] += 1
        if row.get('fullTextValidated') is not True or not row.get('fullTextFetchedAt'):
            continue
        stats['fullText'] += 1
        stage = {'in_window':'inWindow','outside_window':'outsideWindow'}.get(row.get('publicationWindowAssessment'),'timeUncertain')
        stats[stage] += 1
    result = []
    for source in sources:
        sid = source['id']
        observed = sorted(pages[sid].values(), key=lambda row: row['url'])
        stats = by_source[sid]
        attempted = list(articles[sid].values())
        not_articles = [row for row in attempted if row.get('status') == 200
                        and row.get('kind') in ('listing', 'static_page', 'social_profile')]
        parse_failures = [row for row in attempted if row.get('status') == 200
                          and row.get('kind') not in ('listing', 'static_page', 'social_profile')
                          and row.get('fullTextValidated') is False
                          and row.get('error') not in ('unexpected_final_host', 'unexpected_page_language')]
        result.append({'sourceId':sid,'family':source.get('family', sid),'type':source.get('kind','media'),
                       'institutionType':source.get('institutionType'),
                       'attemptedPages':len(observed),'readablePages':sum(p['readable'] for p in observed),
                       'http403Pages':sum(p['httpStatus']==403 for p in observed),
                       'articleAttemptedUrls':len(attempted),
                       'articleHttpFailures':sum(r.get('status') != 200 for r in attempted),
                       'articleScopeFailures':sum(r.get('error') in ('unexpected_final_host', 'unexpected_page_language') for r in attempted),
                       'nonArticleResponses':len(not_articles),'articleParseFailures':len(parse_failures),'pages':observed,
                       **{stage:stats[stage] for stage in (
                           'discoveredUrls','unfetchedUrls','articleCandidates','fullText','inWindow','outsideWindow','timeUncertain')},
                       'loss':{'discoveryToFullText':stage_loss(stats['discoveredUrls'],stats['fullText']),
                               'fullTextToInWindow':stage_loss(stats['fullText'],stats['inWindow'])}})
    return sorted(result, key=lambda row:(-row['inWindow'],-row['fullText'],row['sourceId']))


def title_tokens(value):
    return set(re.findall(r'[^\W_]+', unicodedata.normalize('NFKC', value).casefold()))


def event_pairs(candidates, max_hints=3):
    """Suggest bounded exact-text or title matches. Keep all candidate records."""
    by_hash, by_token = defaultdict(list), defaultdict(list)
    for row in candidates:
        if row.get('needsTimeReview') or row.get('previousDay'):
            continue
        by_hash[row['sourceHash']].append(row['id'])
        for token in title_tokens(row['title']):
            if len(token)>=4:
                by_token[token].append(row['id'])
    tokens = {row['id']:title_tokens(row['title']) for row in candidates}
    hints = {}
    for row in candidates:
        if row.get('needsTimeReview') or row.get('previousDay'):
            continue
        row_id = row['id']
        exact = set(by_hash[row['sourceHash']]) - {row_id}
        neighbors = set()
        for token in tokens[row_id]:
            group = by_token[token]
            if len(group)<=45:
                neighbors.update(group)
        matches = []
        for other in (neighbors | exact) - {row_id}:
            overlap = len(tokens[row_id] & tokens[other]) / max(1,len(tokens[row_id] | tokens[other]))
            if other in exact or (len(tokens[row_id] & tokens[other])>=3 and overlap>=.68):
                matches.append((other in exact,round(overlap,3),other))
        if matches:
            hints[row_id] = [{'candidateId':other,'kind':'same_text' if same else 'similar_title','score':score}
                             for same,score,other in sorted(matches,key=lambda value: (-value[0],-value[1],value[2]))[:max_hints]]
    return hints
