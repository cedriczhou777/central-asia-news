"""Build verifiable source packets. Extracted hints are never editorial findings."""
from datetime import datetime, timezone
from pathlib import Path
import re
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


PACKET_VERSION = 'source-evidence-1'
NUMERIC_CUE = re.compile(
    r'(?<!\w)(?:[$€₽]\s*)?\d[\d.,]*(?:[ \u00a0\u202f]\d{3})*'
    r'(?:\s*(?:billion|million|thousand|bn|mln|млрд|млн|тыс\.?|亿|万))?'
    r'\s*(?:%|USD\b|EUR\b|KZT\b|UZS\b|TJS\b|KGS\b|AZN\b|'
    r'доллар\w*|евро|тенге|сум\w*|сомон\w*|сом\w*|манат\w*|'
    r'[kmg]w(?:h)?\b|[кмг]вт(?:[·.-]?ч)?\b|km\b|км\b|tonnes?\b|тонн\w*|千瓦时|兆瓦|公里|吨)'
    r'|[$€₽]\s*\d[\d.,]*', re.I)
PERIOD_CUE = re.compile(
    r'\b20\d{2}\b|\b(?:quarter|half.year|q[1-4]|квартал\w*|полугоди\w*|'
    r'с января|первых?\s+\d+\s+месяц\w*|first\s+\d+\s+months)\b', re.I)
ENTITY_CUE = re.compile(
    r'(?:[A-ZА-ЯЁ][\w-]+\s+){1,4}[A-ZА-ЯЁ][\w-]+|'
    r'\b[A-ZА-ЯЁ][A-ZА-ЯЁ\d.-]{2,}\b|[«“][^»”\n]{2,90}[»”]', re.UNICODE)
SENTENCE_BOUNDARY = re.compile(r'(?<=[.!?。！？])\s+')


def page_key(url):
    if not isinstance(url, str) or not url:
        return None
    p = urlsplit(url)
    if not p.hostname:
        return None
    return p.hostname.lower(), p.path.rstrip('/') or '/', p.query


def local_timestamp(value, zone):
    """Resolve an unambiguous wall-clock timestamp, rejecting DST folds and gaps."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    numeric_badge = re.fullmatch(r'(\d\d)\.(\d\d)\.(\d{4})[ T](\d\d)[.:](\d\d)(?::(\d\d))?', value)
    if numeric_badge:
        day, month, year, hour, minute, second = numeric_badge.groups()
        value = f'{year}-{month}-{day}T{hour}:{minute}:{second or "00"}'
    if not re.fullmatch(r'\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?', value):
        return None
    try:
        wall = datetime.fromisoformat(value)
        tz = ZoneInfo(zone)
    except (ValueError, TypeError, ZoneInfoNotFoundError):
        return None
    possible = {at.astimezone(timezone.utc) for at in (
        wall.replace(tzinfo=tz, fold=0), wall.replace(tzinfo=tz, fold=1))
        if at.astimezone(timezone.utc).astimezone(tz).replace(tzinfo=None) == wall}
    return next(iter(possible)).astimezone(tz).isoformat() if len(possible)==1 else None


def source_time(record, zone):
    """Bind a registry zone to actual article time fields. Preserve each raw value."""
    if record.get('source_kind')!='article' or not record.get('fullTextValidated'):
        return record
    entries = record.get('publicationEvidence')
    if not isinstance(entries, list):
        return record
    identities = {page_key(record.get(k)) for k in ('final_url','canonical_url','url')} - {None}
    times = []
    for item in entries:
        if not isinstance(item, dict):
            continue
        raw = item.get('raw')
        field = str(item.get('field') or '')
        item = dict(item)
        if (item.get('kind') in ('published','modified') and page_key(item.get('articleUrl')) in identities
                and item.get('timezoneEvidence')=='not_provided'
                and (field.startswith(('jsonld','meta.','publisher.')) or field.startswith(('time[','html.publicationBadge[')))):
            value = local_timestamp(item.get('localWallTime', raw), zone)
            if value:
                item.update(normalizedAt=value, timezone=zone, timezoneEvidence='registered_publisher_timezone')
        times.append(item)
    return {**record, 'publicationEvidence':times}


def fact_locations(text):
    """Point to exact sentences in the retained body, with deterministic bounds."""
    facts, names = [], {}
    for para_index, line in enumerate(text.splitlines(), 1):
        for sentence in SENTENCE_BOUNDARY.split(line.strip()):
            numeric = list(dict.fromkeys(m.group().strip() for m in NUMERIC_CUE.finditer(sentence)))
            periods = list(dict.fromkeys(m.group() for m in PERIOD_CUE.finditer(sentence)))
            if (numeric or periods) and len(facts)<24:
                if len(sentence)<=480:
                    facts.append({'paragraph':para_index, 'text':sentence, 'numbers':numeric[:10], 'periods':periods[:6]})
                else:
                    facts.append({'paragraph':para_index, 'numbers':numeric[:10], 'periods':periods[:6],
                                  'readFullParagraph':True})
            for m in ENTITY_CUE.finditer(sentence):
                if len(names)<18:
                    names.setdefault(m.group().strip(), para_index)
    return {'numbersAndPeriods':facts, 'entityHints':[{'text':name,'paragraph':idx} for name,idx in names.items()],
            'verification':'machine_locations_only', 'allEvidenceInFullText':True}


def evidence_packet(record, ledger, original):
    images = record.get('articleImages') or {}
    html = ledger.get('sourceHTML')
    return {'version':PACKET_VERSION,
            'source':{'id':ledger['sourceId'],'family':ledger['family'],'type':ledger.get('sourceType'),
                      'institutionType':ledger.get('institutionType'), 'publisher':original.get('source'),
                      'language':ledger.get('language') or record.get('html_lang'), 'author':record.get('author')},
            'urls':{'requested':original['source_url'],'final':record.get('final_url'),'canonical':record.get('canonical_url')},
            'time':{'publicationAndUpdateEvidence':record.get('publicationEvidence') or [],
                    'fetchedAt':record.get('fetchedAt'),'windowAssessment':ledger.get('publicationWindowAssessment'),
                    'firstDisclosure':'editorial_review_required'},
            'archive':{'jsonMember':'evidence/'+Path(ledger['sourceJSON']).name,'jsonSha256':ledger['sourceJSONSha256'],
                       'htmlMember':'evidence/'+Path(html).name if html else None,'htmlSha256':ledger.get('sourceHTMLSha256'),
                       'bodySha256':original['sourceHash']},
            'imageCandidates':len({row['url'] for row in images.get('candidates',[]) if row.get('url')}),
            'factLocations':fact_locations(original['text'])}
