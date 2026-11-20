"""Check saved country receipts/readbacks offline. A complete transport is not publication."""
import argparse
import json
import re
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

COUNTRIES = ('kz', 'uz', 'kg', 'tj', 'az')
BJT = timezone(timedelta(hours=8))
RECEIPT_FLAGS = ('verified', 'expectedTextMatch', 'imageMatch', 'thumbnailMatchesPrepared')
READBACK_FLAGS = ('titleMatch', 'digestMatch', 'expectedTextMatch', 'originalLinkEmpty',
                  'thumbnailPresent', 'thumbnailMatchesPrepared')
LAYOUT_FLAGS = ('bodyCountMatch', 'justified', 'lastLineLeft', 'lineHeight19',
                'outerMargin10', 'innerMargin12')
FOOTER_FLAGS = ('textOrderMatch', 'atEnd', 'centered', 'fontSize12', 'gray', 'backgroundF7F5EF', 'passed')


def obj(value):
    return value if isinstance(value, dict) else {}


def timestamp(value):
    try:
        result = datetime.fromisoformat(value)
    except (ValueError, TypeError):
        return None
    return result if result.utcoffset() is not None else None


def image_key(host, path):
    if not isinstance(host, str) or not isinstance(path, str) or not host or not path.startswith('/'):
        return None
    host = host.lower()
    if host == 'mmbiz.qpic.cn' or host.endswith('.qpic.cn'):
        path = re.sub(r'/(?:0|640)$', '', path)
    return host, path


def image_order(checks, detail):
    expected, actual, urls = (checks.get('expectedImageIdentities'),
                              checks.get('actualImageIdentities'), detail.get('imageUrls'))
    count = checks.get('expectedImages')
    if type(count) is not int or count < 0 or not all(isinstance(x, list) for x in (expected, actual, urls)):
        return False
    counts = (checks.get('actualImageTags'), detail.get('draftImages'), detail.get('inputImages'),
              detail.get('transferredImages'), len(expected), len(actual), len(urls))
    if any(type(x) is not int or x != count for x in counts):
        return False
    def keys(rows):
        return [image_key(obj(r).get('host'), obj(r).get('path')) for r in rows]
    try:
        receipt_paths = [urlsplit(u) for u in urls if isinstance(u, str)]
        receipt_keys = [image_key(u.hostname, u.path) for u in receipt_paths]
    except ValueError:
        return False
    expected_keys = keys(expected)
    return None not in expected_keys and expected_keys == keys(actual) == receipt_keys


def layout_and_footer(checks):
    layout, footer = obj(checks.get('layout')), obj(checks.get('footer'))
    paragraphs, lines = layout.get('expectedBodyParagraphs'), footer.get('expectedLines')
    return (all(layout.get(k) is True for k in LAYOUT_FLAGS)
            and type(paragraphs) is int and paragraphs > 0 and paragraphs == layout.get('actualBodyParagraphs')
            and all(footer.get(k) is True for k in FOOTER_FLAGS)
            and isinstance(lines, list) and bool(lines) and lines == footer.get('actualLines'))


def receipt_status(country, row, issue, cutoff, now, duplicate_media):
    receipt, readback = obj(row.get('actualDeliveryReceipt')), obj(row.get('draftDiagnostic'))
    detail, checks = obj(receipt.get('detail')), obj(readback.get('checks'))
    version, media = receipt.get('version'), receipt.get('media_id')
    if any(node.get('conflict') is True for node in (row, receipt, readback)):
        return 'conflicting_receipt', None
    if not isinstance(version, str) or not re.fullmatch(re.escape(issue) + r'(?:-r(?:[2-9]|[1-9]\d+))?', version):
        return 'missing_or_wrong_issue_version', None
    if receipt.get('country') != country or row.get('deliveryVersion') != version:
        return 'conflicting_country_or_version', None
    if receipt.get('state') != 'succeeded' or not isinstance(media, str) or not media.strip():
        return 'draft_receipt_unconfirmed', None
    if media in duplicate_media:
        return 'duplicate_media_id', None
    verified_at = timestamp(receipt.get('updated_at'))
    if not verified_at or not cutoff <= verified_at <= now:
        return 'invalid_receipt_time', None
    if (readback.get('ok') is not True or readback.get('state') != 'succeeded'
            or readback.get('country') != country or readback.get('version') != version):
        return 'missing_or_conflicting_readback', None
    if 'media_id' in readback and readback['media_id'] != media:
        return 'readback_media_id_mismatch', None
    if (not all(detail.get(k) is True for k in RECEIPT_FLAGS)
            or not all(checks.get(k) is True for k in READBACK_FLAGS)
            or not layout_and_footer(checks) or not image_order(checks, detail)
            or (checks['expectedImages'] > 0 and not
                (checks.get('coverMatchesFirstBodyImage') is True
                 and detail.get('coverMatchesFirstBodyImage') is True))):
        return 'readback_checks_failed', None
    return 'ready', verified_at


def assess(state, issue, now=None):
    now = now or datetime.now(timezone.utc)
    day = date.fromisoformat(issue)
    cutoff = datetime(day.year, day.month, day.day, 6, tzinfo=BJT)
    if (day.isoformat() != issue or state.get('issueDate') != issue or
            timestamp(state.get('windowStart')) != cutoff - timedelta(days=1) or
            timestamp(state.get('windowEnd')) != cutoff or cutoff > now):
        raise ValueError('wrong, future or mismatched issue window')
    countries = obj(state.get('countries'))
    if set(countries) - set(COUNTRIES):
        raise ValueError('unexpected country keys in issue index')
    masks = [obj(obj(row).get('actualDeliveryReceipt')).get('media_id') for row in countries.values()]
    duplicate_media = {m for m, n in Counter(x for x in masks if isinstance(x, str) and x.strip()).items() if n > 1}
    deadline = cutoff + timedelta(hours=2)
    snapshot = timestamp(state.get('updatedAt'))
    ready, blocked, by_deadline, known_late = [], {}, [], []
    for country in COUNTRIES:
        row = obj(countries.get(country))
        status, receipt_time = receipt_status(country, row, issue, cutoff, now, duplicate_media)
        if status != 'ready':
            blocked[country] = status
            continue
        diagnostic_time = timestamp(row.get('draftDiagnosticAt'))
        # This is the first actual diagnosis for the pinned draft. A receipt can
        # later be rewritten and its updated_at is not the first delivery time.
        if 'draftDiagnosticAt' in row and (not diagnostic_time or not cutoff <= diagnostic_time <= now):
            blocked[country] = 'invalid_readback_time'
            continue
        ready.append(country)
        if diagnostic_time and diagnostic_time >= deadline:
            known_late.append(country)
        elif (diagnostic_time and diagnostic_time < deadline) or (
                diagnostic_time is None and snapshot and receipt_time <= snapshot <= now and snapshot < deadline):
            by_deadline.append(country)
    published = (state.get('userConfirmedPublished') is True or state.get('published_by_user') is True
                 or state.get('publicationDisposition') == 'published_by_user'
                 or state.get('publicationStatus') == 'published_by_user' or state.get('stage') == 'published_by_user')
    closed = published or any(state.get(k) is True for k in ('contentWorkClosed', 'suppressRecovery'))
    quantity_gaps = [c for c in COUNTRIES if obj(countries.get(c)).get('quantityReady') is not True]
    transport_complete = len(ready) == len(COUNTRIES)
    cutpoint = obj(state.get('statusAt0800'))
    observed_at = timestamp(cutpoint.get('observedAt'))
    if (state.get('timeliness') is False and state.get('transportComplete') is True
            and snapshot and deadline <= snapshot <= now):
        timeliness, timing_basis = False, 'saved_final_missed_deadline'
    elif (cutpoint.get('timeliness') is False and observed_at and deadline <= observed_at <= now):
        timeliness, timing_basis = False, 'saved_missed_deadline_cutpoint'
    elif known_late:
        timeliness, timing_basis = False, 'first_diagnostic_after_deadline'
    elif len(by_deadline) == len(COUNTRIES):
        timeliness, timing_basis = True, 'all_countries_verified_before_deadline'
    else:
        timeliness, timing_basis = None, 'insufficient_timing_evidence'
    return {'issueDate': issue, 'ready': ready, 'blocked': blocked, 'transportComplete': transport_complete,
            'quantityReady': not quantity_gaps, 'quantityGaps': quantity_gaps,
            'qualityDeliveryComplete': transport_complete and not quantity_gaps
            and state.get('qualityDeliveryComplete') is True,
            'userConfirmedPublished': published, 'contentWorkClosed': closed,
            'verifiedBefore0800': by_deadline, 'knownLate': known_late,
            'timeliness': timeliness, 'timelinessBasis': timing_basis}


def unique_object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError('duplicate key in issue index')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('summary', type=Path)
    parser.add_argument('--issue-date', required=True, help='Expected canonical YYYY-MM-DD in Beijing time')
    args = parser.parse_args()
    try:
        state = json.loads(args.summary.read_text(encoding='utf-8'), object_pairs_hook=unique_object)
        if not isinstance(state, dict):
            raise ValueError('issue index is not an object')
        result = assess(state, args.issue_date)
    except (ValueError, OSError) as error:
        parser.exit(2, json.dumps({'error': str(error)}, ensure_ascii=False) + '\n')
    print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
    return 0 if result['transportComplete'] or result['contentWorkClosed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
