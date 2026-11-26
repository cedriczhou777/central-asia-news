"""Recognize publisher-declared discovery formats without treating them as news."""
from datetime import datetime
from email.utils import parsedate_to_datetime
import json
from urllib.parse import urljoin

from lxml import etree


FEED_TYPES = {'application/rss+xml', 'application/atom+xml', 'application/feed+json'}
NAMESPACES = ('rss', 'feed', 'urlset', 'sitemapindex', 'RDF')
LIMIT = 300


def feed_timestamp(raw):
    if not raw:
        return None
    try:
        stamp = datetime.fromisoformat(raw.replace('Z', '+00:00'))
    except ValueError:
        try:
            stamp = parsedate_to_datetime(raw)
        except (ValueError, TypeError, OverflowError):
            return None
    return stamp.isoformat() if stamp.tzinfo and stamp.utcoffset() is not None else None


def feed_link(url, title, published):
    stamp = feed_timestamp(published)
    return {'url': url, 'text': title or url, 'inHeading': bool(title),
            'articleCard': True, 'inNavigation': False, 'feedEntry': True,
            'nearbyTimes': [{'text': stamp, 'datetime': stamp}] if stamp else []}


def parse_json_feed(data, url):
    try:
        feed = json.loads(data)
    except (UnicodeError, ValueError, RecursionError):
        return None
    if (not isinstance(feed, dict) or feed.get('version') not in (
            'https://jsonfeed.org/version/1', 'https://jsonfeed.org/version/1.1')
            or not isinstance(feed.get('items'), list)):
        return None
    links = []
    for item in feed['items'][:LIMIT]:
        if not isinstance(item, dict) or not isinstance(item.get('url'), str):
            continue
        title, published = item.get('title'), item.get('date_published')
        links.append(feed_link(urljoin(url,item['url']), title if isinstance(title,str) else '',
                               published if isinstance(published,str) else None))
    return {'links': links, 'discoveryEntries': [], 'format': 'json_feed',
            'html_lang': feed.get('language') if isinstance(feed.get('language'),str) else None}


def parse_feed(data, url):
    """Use RSS/Atom publication hints and news sitemap dates only for discovery."""
    prefix = data.lstrip()[:1]
    if prefix == b'{':
        return parse_json_feed(data, url)
    if prefix != b'<':
        return None
    if b'<!DOCTYPE' in data[:4096].upper():
        return None
    try:
        root = etree.fromstring(data, etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True))
    except etree.XMLSyntaxError:
        return None
    kind = etree.QName(root).localname
    if kind not in NAMESPACES or root.getroottree().docinfo.doctype:
        return None
    def value(item, tag):
        return next((raw.strip() for raw in item.xpath(f'./*[local-name()="{tag}"]/text()') if raw.strip()), '')
    if kind == 'sitemapindex':
        indexes = []
        for node in root.xpath('./*[local-name()="sitemap"]')[:LIMIT]:
            location = value(node, 'loc')
            if location and 'news' in location.lower():
                indexes.append(urljoin(url, location))
        return {'links': [], 'discoveryEntries': indexes[:3], 'format': kind}
    path = {'rss': './channel/item', 'RDF': './*[local-name()="item"]',
            'feed': './*[local-name()="entry"]', 'urlset': './*[local-name()="url"]'}[kind]
    links = []
    for node in root.xpath(path)[:LIMIT]:
        if kind == 'urlset':
            location = value(node, 'loc')
            news = next(iter(node.xpath('./*[local-name()="news"]')), None)
            title = value(news, 'title') if news is not None else ''
            published = value(news, 'publication_date') if news is not None else ''
        else:
            location = value(node, 'link')
            if not location:
                location = next(iter(node.xpath('./*[local-name()="link"][not(@rel) or @rel="alternate"]/@href')), '')
            title = value(node, 'title')
            published = value(node, 'pubDate') or value(node, 'published')
        if location:
            links.append(feed_link(urljoin(url, location),title,published))
    lang = root.get('{http://www.w3.org/XML/1998/namespace}lang')
    if kind=='rss':
        lang = root.findtext('channel/language') or lang
    return {'links': links, 'discoveryEntries': [], 'format': kind, 'html_lang':lang}
