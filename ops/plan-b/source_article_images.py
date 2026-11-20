"""Collect already identified pictures from adopted articles' own source pages."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import fcntl
from hashlib import sha256
from http.client import HTTPSConnection
import ipaddress
import io
import json
from pathlib import Path
import re
import socket
import subprocess
import sys
from tempfile import NamedTemporaryFile
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener

from PIL import Image


MAX_BYTES = 10_000_000
EFFECTIVE_ISSUE = '2026-11-20'
SUPPORTED_FORMATS = {'JPEG', 'PNG', 'WEBP', 'GIF', 'AVIF', 'HEIF', 'TIFF'}


def public_address(value):
    address = ipaddress.ip_address(value)
    return address.is_global and not address.is_multicast and not getattr(address, 'is_site_local', False)


def public_url(url):
    parts = urlsplit(url)
    if (parts.scheme != 'https' or not parts.hostname or parts.username or parts.password
            or parts.port not in (None, 443)):
        raise ValueError('invalid_public_image_URL')
    host = parts.hostname.strip('.').lower()
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None and not public_address(host):
        raise ValueError('nonpublic_image_address')
    if literal is None and ('.' not in host or host.endswith(('.local', '.localhost', '.internal', '.home.arpa'))):
        raise ValueError('nonpublic_image_address')


def connect_public(address, timeout, source_address=None):
    host, port = address
    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not addresses or any(not public_address(row[4][0]) for row in addresses):
        raise ValueError('nonpublic_image_address')
    last_error = None
    for family, kind, protocol, _, target in addresses:
        connection = socket.socket(family, kind, protocol)
        try:
            connection.settimeout(timeout)
            if source_address is not None:
                connection.bind(source_address)
            # Connect to the checked address. TLS still verifies the origin hostname.
            connection.connect(target)
            return connection
        except OSError as error:
            last_error = error
            connection.close()
    raise last_error or OSError('public_connection_unavailable')


class PublicConnection(HTTPSConnection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = connect_public


class PublicHTTPSHandler(HTTPSHandler):
    def https_open(self, request):
        return self.do_open(PublicConnection, request, context=self._context)


class PublicRedirect(HTTPRedirectHandler):
    max_redirections = 3

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def public_opener():
    return build_opener(ProxyHandler({}), PublicRedirect(), PublicHTTPSHandler())


def download(url, page):
    public_url(url)
    request = Request(url, headers={'Referer': page, 'User-Agent': 'Mozilla/5.0',
                                    'Accept': 'image/*'})
    with public_opener().open(request, timeout=10) as response:
        data = response.read(MAX_BYTES + 1)
    if not 0 < len(data) <= MAX_BYTES:
        raise ValueError('invalid_image_length')
    with Image.open(io.BytesIO(data)) as image:
        if image.format not in SUPPORTED_FORMATS:
            raise ValueError('unsupported_original_image_format')
        if image.width * image.height > 40_000_000 or min(image.size) < 80:
            raise ValueError('unsupported_or_placeholder_dimensions')
        image.verify()
    return data


def collect(article, root, cached=None):
    page = article.get('source_url') or article.get('url') or article.get('canonical_url') or article.get('final_url')
    images = article.get('articleImages') or {}
    candidates = {row['url']: row for row in images.get('candidates', [])}
    lookup = {'sourceUrl': page, 'candidateUrls': list(candidates), 'status': 'unavailable'}
    result = {'id': article['id'], 'sourceImage': lookup}
    if not candidates:
        lookup['status'] = 'page_check_needed'
        result['metadataHints'] = images.get('metadataHints', [])
        return result
    attempts = []
    lead = set(images.get('metadataHints', []))
    ordered = sorted(candidates, key=lambda url: url not in lead and
                     candidates[url].get('basis') != 'displayed_publisher_lead')
    plan = ordered[:3]
    if len(plan) == 1:
        plan.append(plan[0])
    for index, url in enumerate(plan):
        if index and url == plan[index - 1] and attempts[-1]['result'] not in (
                'TimeoutExpired', 'URLError', 'HTTP 502', 'HTTP 503', 'HTTP 504'):
            break
        known = (cached or {}).get(url, {})
        key = known.get('sha256')
        if isinstance(key, str) and re.fullmatch(r'[0-9a-f]{64}', key):
            path = root / key
            if path.is_file() and path.stat().st_size == known.get('bytes') and sha256(path.read_bytes()).hexdigest() == key:
                lookup['status'] = 'original'
                return {**result, 'image_url': url, 'image_sha256': key, 'image_bytes': known['bytes'],
                        'image_local_path': str(path)}
        try:
            fetched = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--download',
                                      url, page], timeout=14, capture_output=True)
        except (subprocess.TimeoutExpired, OSError) as error:
            attempts.append({'url': url, 'result': type(error).__name__})
            continue
        if fetched.returncode:
            attempts.append({'url': url, 'result': fetched.stderr.decode(errors='replace')[:120].strip()})
            continue
        data = fetched.stdout
        dig = sha256(data).hexdigest()
        target = root / dig
        if not target.exists() or sha256(target.read_bytes()).hexdigest() != dig:
            with NamedTemporaryFile(dir=root, delete=False) as tmp:
                tmp.write(data)
            Path(tmp.name).replace(target)
        lookup['status'] = 'original'
        result.update(image_url=url, image_sha256=dig, image_bytes=len(data),
                      image_local_path=str(target))
        return result
    lookup['attempts'] = attempts
    result['imageUnavailableReason'] = '原报道有图但未能下载：' + '、'.join(
        dict.fromkeys(a['result'] for a in attempts)
    )
    return result


def read_manifest(path):
    if not path or not path.exists():
        return {}
    return {r['url']: r for r in json.loads(path.read_text())['images']}


def save_manifest(path, results, root):
    path = path.resolve()
    if root != path.parent / 'images':
        raise ValueError('manifest must sit beside its images directory')
    with path.with_name(path.name + '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        rows = read_manifest(path)
        for entry in results:
            if entry.get('image_url'):
                url, dig = entry['image_url'], entry['image_sha256']
                rows[url] = {'url': url, 'sha256': dig, 'bytes': entry['image_bytes'],
                             'path': 'images/' + dig}
        with NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
            tmp.write(json.dumps({'images': list(rows.values())}, ensure_ascii=False, indent=2).encode())
        Path(tmp.name).replace(path)


def origin_error(entry):
    """Check the explicit source-photo decision on the signed article."""
    evidence = entry.get('sourceImage')
    if not isinstance(evidence, dict) or evidence.get('sourceUrl') != entry.get('source_url'):
        return 'image check must refer to the adopted source page'
    candidates = evidence.get('candidateUrls')
    if not isinstance(candidates, list) or any(not isinstance(url, str) for url in candidates):
        return 'missing original article image candidate list'
    url = entry.get('image_url')
    status = evidence.get('status')
    if url:
        if status != 'original' or url not in candidates:
            return 'image must be taken from the adopted original article'
    elif status == 'none':
        if candidates:
            return 'original image found: fetch it or report a concrete retrieval obstacle'
    elif status != 'unavailable' or not candidates or not entry.get('imageUnavailableReason'):
        return 'state whether the original page lacks a photo or give a concrete retrieval obstacle'
    return None


def main():
    if len(sys.argv) == 4 and sys.argv[1] == '--download':
        try:
            sys.stdout.buffer.write(download(sys.argv[2], sys.argv[3]))
        except HTTPError as error:
            sys.exit(f'HTTP {error.code}')
        except ValueError as error:
            sys.exit(str(error).strip()[:100])
        except (OSError, Image.DecompressionBombError) as error:
            sys.exit(type(error).__name__)
        return
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('originals', type=Path, help='Saved candidate-originals JSON')
    p.add_argument('--images-dir', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--manifest', type=Path, help='Accumulate a portable manifest beside images/')
    args = p.parse_args()
    root = args.images_dir.resolve()
    root.mkdir(parents=True, exist_ok=True)
    articles = json.loads(args.originals.read_text())['articles']
    if not 1 <= len(articles) <= 20:
        p.error('expected 1–20 adopted originals')
    cached = read_manifest(args.manifest)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda article: collect(article, root, cached), articles))
    if args.manifest:
        save_manifest(args.manifest, results, root)
    args.output.write_text(json.dumps({'articles': results}, ensure_ascii=False, indent=2))
    print(json.dumps({'checked': len(results), 'downloaded': sum(bool(r.get('image_url')) for r in results),
                      'output': str(args.output)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
