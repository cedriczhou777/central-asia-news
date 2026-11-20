"""Mechanical handoff client for the existing Work issue run."""

import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def protected_connection():
    base = os.environ.get('CENTRAL_ASIA_PLAN_B_URL', '').rstrip('/')
    secret = os.environ.get('CENTRAL_ASIA_INGEST_SECRET', '')
    parts = urlsplit(base)
    if (parts.scheme != 'https' or not parts.hostname or parts.username or parts.password
            or parts.port not in (None, 443) or parts.path or parts.query or parts.fragment):
        raise ValueError('secure_plan_b_connection_missing')
    return base, secret


def handshake(base, secret, query, body=None, opener=None):
    headers = {'Content-Type': 'application/json'}
    if secret:
        headers['X-Ingest-Secret'] = secret
    request = Request(base + '/api/plan-b?' + urlencode(query),
                      data=json.dumps(body, ensure_ascii=False).encode() if body is not None else None,
                      headers=headers)
    try:
        with (opener or build_opener(NoRedirect())).open(request, timeout=25) as response:
            raw, status = response.read(4 * 1024 * 1024 + 1), response.status
    except HTTPError as error:
        raw, status = error.read(128 * 1024), error.code
    if len(raw) > 4 * 1024 * 1024:
        raise ValueError('plan_b_response_too_large')
    try:
        result = json.loads(raw)
    except (ValueError, UnicodeError):
        result = {'ok': False, 'reason': 'invalid_cloud_response'}
    return {'httpStatus': status, **result}


def checksum(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':')).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('view', choices=['health', 'manifest', 'changes', 'originals', 'submit', 'status', 'word'])
    parser.add_argument('--issue', required=False)
    parser.add_argument('--country', choices=['kz', 'uz', 'kg', 'tj', 'az'])
    parser.add_argument('--phase', choices=['preview', 'final'], default='preview')
    parser.add_argument('--ids', nargs='*')
    parser.add_argument('--hash')
    parser.add_argument('--document', type=Path)
    args = parser.parse_args()
    try:
        base, secret = protected_connection()
        if args.issue and not re.fullmatch(r'\d{4}-\d{2}-\d{2}', args.issue):
            raise ValueError('invalid_issue')
        if args.view == 'health':
            query, body = {'health': 1}, None
        else:
            query = {'view': args.view, 'phase': 'final' if args.view == 'changes' else args.phase}
            if args.issue:
                query['issue'] = args.issue
            if args.country:
                query['country'] = args.country
            if args.ids:
                query['ids'] = ','.join(args.ids)
            if args.hash:
                query['hash'] = args.hash
            body = None
            if args.view == 'submit':
                body = json.loads(args.document.read_bytes())
                # Work supplies both hashes as independent sign-off. A hash
                # mismatch is surfaced, never silently patched at submission.
                if (body['review']['originalHash'] != checksum(body['draft']['articles'])
                        or body['review']['finalBodyHash'] != checksum(body['review']['articles'])):
                    raise ValueError('signed_content_changed')
        result = handshake(base, secret, query, body)
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0 if result.get('ok') else 1)
    except (ValueError, AttributeError, OSError, KeyError) as error:
        reason = str(error)
        print(json.dumps({'ok': False, 'reason': reason if re.fullmatch(r'[a-z0-9_]{1,80}', reason)
                          else 'plan_b_connection_or_input_unavailable'}))
        sys.exit(1)


if __name__ == '__main__':
    main()
