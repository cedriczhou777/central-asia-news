"""Use the publisher of the adopted original, never a generic source label."""

from functools import lru_cache
import json
from pathlib import Path
import re
import unicodedata
from urllib.parse import urlsplit


EFFECTIVE_ISSUE = '2026-11-20'
REGISTRY = Path(__file__).with_name('source_registry.json')
SHARED_SITES = {'gov.uz', 'gov.kz', 'gov.kg'}
DISPLAY_NAMES = {'Informburo': 'Informburo.kz'}


def host_key(host):
    host = (host or '').lower().removeprefix('www.')
    return 't.me' if host == 'telegram.me' else host


@lru_cache(maxsize=1)
def registered_publishers():
    records = json.loads(REGISTRY.read_text())['sources'] if REGISTRY.is_file() else []
    direct, scoped = {}, {}
    for record in records:
        family = record['family']
        if record.get('kind') != 'social':
            for host in record.get('allowedHosts', []):
                host = host_key(host)
                if host not in SHARED_SITES:
                    direct.setdefault(host, set()).add(family)
                else:
                    for row in record.get('entrypoints', []):
                        page = urlsplit(row['url'])
                        path = page.path.rstrip('/')
                        if host_key(page.hostname) == host and len(path.split('/')) > 2:
                            scoped.setdefault((host, path), set()).add(family)
        if (record.get('platform') or '').casefold() == 'telegram':
            for row in record.get('entrypoints', []):
                page = urlsplit(row['url'])
                if host_key(page.hostname) == 't.me' and page.path.strip('/'):
                    path = '/' + page.path.strip('/').split('/')[0].casefold()
                    scoped.setdefault(('t.me', path), set()).add(family)
    return direct, scoped


def publisher_family(url):
    page = urlsplit(url or '')
    host = host_key(page.hostname)
    path = page.path.rstrip('/')
    if host == 't.me':
        path = path.casefold()
        if path.startswith('/s/'):
            path = path[2:]
    direct, scoped = registered_publishers()
    candidates = [(len(prefix), names) for (site, prefix), names in scoped.items()
                  if site == host and (path == prefix or path.startswith(prefix + '/'))]
    names = max(candidates, key=lambda item: item[0])[1] if candidates else direct.get(host, set())
    return next(iter(names)) if len(names) == 1 else None


def publisher_name(url):
    family = publisher_family(url)
    return DISPLAY_NAMES.get(family, family)


def name_key(name):
    normalized = unicodedata.normalize('NFKC', name).casefold()
    return re.sub(r'[\W_]+', '', normalized)


GENERIC = {
    name_key(value) for value in (
        '原文', '原文报道', '原文来源', '原文报导', '原始报道', '原报道', '新闻原文', '媒体', '新闻媒体',
        '外媒', '当地媒体', '官方', '官方报道', '官方消息', '官网', '网络', '本站', '转载', '来源',
        '综合报道', '媒体报道', '相关报道', '未注明', '未知', '待核实', '无',
        'original report', 'source', 'unknown', 'official source', 'media report', 'original article',
        'Instagram', 'Telegram', 'Facebook',
    )
}


def source_name_error(entry):
    value = entry.get('source')
    if not isinstance(value, str) or not name_key(value):
        return 'missing actual publisher name'
    value = value.strip()
    without_prefix = re.sub(r'^来源\s*[:：]\s*', '', value)
    if (without_prefix != value or name_key(value) in GENERIC
            or re.match(r'^(?:原文报道|原文报导|原文来源|原始报道|原报道)(?:$|\s|[:：(/（])', value)
            or re.search(r'https?://', value, re.I)):
        return 'source must name the actual publisher, not a placeholder or raw URL'
    family = publisher_family(entry.get('source_url'))
    if family and name_key(value) not in {name_key(family), name_key(DISPLAY_NAMES.get(family, family))}:
        return f'source name does not match the original URL; use {DISPLAY_NAMES.get(family, family)}'
    return None
