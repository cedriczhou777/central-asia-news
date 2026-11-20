"""Offline round-trip through the source archive, signed package and Word."""

import copy
from datetime import datetime
from functools import partial
import gzip
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops' / 'plan-b'))
from cloud_handoff import backup, coverage, inventory_entries, read, restore, write
import cloud_release
import prepare_country_release
from test_work_quantity import fixture
from validate_work_package import digest
from verify_rendered_package import verify_rendered_package


ISSUE = '2026-11-21'
STAMP = ISSUE + 'T06:01:00+08:00'


def inputs(directory):
    source = directory / 'source-fixture'
    source.mkdir()
    evidence = source / 'evidence'
    evidence.mkdir()
    draft, audit, _ = fixture()
    for index, row in enumerate(audit):
        row.update(fetchedAt=STAMP, eventId=f'fake-{index}')
    for index, (item, entry) in enumerate(zip(draft['articles'], draft['candidateLedger'], strict=True)):
        text = f'Synthetic original source text for a single test article {index}.'
        photo_list = ([{'url': 'https://source0.example/original.png', 'basis': 'article_body'}] if index == 0 else [])
        raw = {'title': f'Synthetic title {index}', 'text': text, 'articleImages': {'candidates': photo_list},
               'publicationEvidence': [{'kind': 'published', 'value': ISSUE + 'T05:59:59+08:00', 'timezoneEvidence': 'explicit'}]}
        path = evidence / f'article-{index}.json'
        write(path, raw)
        exact = hashlib.sha256(path.read_bytes()).hexdigest()
        source_hash = hashlib.sha256(text.encode()).hexdigest()
        entry.update(sourceJSON=str(path), sourceJSONSha256=exact, sourceHash=source_hash,
                     fullTextValidated=True, firstDisclosureVerified=True,
                     publicationWindowAssessment='in_window', discoveredAt=STAMP, fullTextFetchedAt=STAMP)
        for item_evidence in entry['publicationEvidence'] + entry['evidence']:
            item_evidence['observedAt'] = STAMP
        audit[11 + index]['sourceHash'] = source_hash
        item.update(title=f'测试新闻{index}', body='这是离线合成的测试稿件。', category='产业', source='Fixture Media',
                    sourceHash=source_hash, published_at=ISSUE + 'T05:59:59+08:00',
                    timeEvidence='合成报文显示的带时区发布时间',
                    firstPublicationCheck='合成报文同时提供首次披露和实际发布时间')
    region = {'issueDate': ISSUE, 'country': 'kg', 'windowStart': '2026-11-20T06:00:00+08:00',
              'windowEnd': ISSUE + 'T06:00:00+08:00'}
    registry = directory / 'registry.json'
    write(registry, draft['sourceRegistry'])
    write(source / 'candidate_ledger.json', {**region, 'candidateLedger': draft['candidateLedger']})
    write(source / 'source_scan_audit.json', {**region, 'sourceScanAudit': audit, 'sourceScanAuditHistory': [],
                                              'listingQueue': [], 'articleQueue': [], 'budgetEvents': []})
    backup(source, directory / 'input.gz')
    draft.update(**region, coverageEnd=ISSUE + 'T06:00:00+08:00')
    rows = copy.deepcopy(draft['articles'])
    review = {**region, 'reviewer': 'independent-test', 'stage': 'verified', 'issues': [],
              'articles': rows, 'originalHash': digest(draft['articles']), 'finalBodyHash': digest(rows),
              'fullSourceReviewCompleted': True, 'titleFactReviewCompleted': True, 'bodyFactReviewCompleted': True}
    with gzip.open(directory / 'editorial.gz', 'wt') as out:
        json.dump({'draft': draft, 'review': review}, out)
    return source, registry


def photo(original, image_root):
    urls = [row['url'] for row in original['articleImages']['candidates']]
    decision = {'sourceUrl': original['source_url'], 'candidateUrls': urls, 'status': 'original' if urls else 'none'}
    if not urls:
        return {'sourceImage': decision, 'imageUnavailableReason': '合成原文无图'}
    target = image_root / 'test.png'
    Image.new('RGB', (120, 90), 'blue').save(target)
    sha = hashlib.sha256(target.read_bytes()).hexdigest()
    ready = image_root / sha
    target.rename(ready)
    return {'sourceImage': decision, 'image_url': urls[0], 'image_sha256': sha, 'image_bytes': ready.stat().st_size}


class CloudReleaseTest(unittest.TestCase):
    def test_fifteen_reviewed_items_render_in_word_and_transport(self):
        with tempfile.TemporaryDirectory() as td:
            directory = Path(td)
            source, registry = inputs(directory)
            restored = directory / 'rehydrated'
            restore(restored, directory / 'input.gz')
            self.assertEqual(len(inventory_entries(restored, ISSUE, 'kg')), 15)
            scan = read(source / 'source_scan_audit.json')
            missing, observed = coverage(read(registry), 'kg', scan, datetime.fromisoformat(STAMP))
            self.assertEqual(missing, [])
            self.assertEqual(len(observed['freshReadableSources']), 3)
            gate = partial(verify_rendered_package, now=datetime.fromisoformat(ISSUE + 'T07:00:00+08:00'))
            with patch.object(cloud_release, 'REGISTRY', registry), patch.object(prepare_country_release, 'verify_rendered_package', gate):
                cloud_release.prepare_from_handoff(directory, ISSUE, 'kg', ISSUE + '-r104', fetch_photo=photo)
            output = directory / 'output'
            cloud_release.open_release(output, directory / 'prepared.gz')
            rendered = cloud_release.build_word(output, directory / 'test.docx')
            self.assertEqual(rendered['articles'], 15)
            self.assertEqual(rendered['images'], 1)
            with ZipFile(directory / 'test.docx') as doc:
                markup = doc.read('word/document.xml').decode()
                self.assertIn('这是离线合成的测试稿件。', markup)
                self.assertEqual(markup.count('<w:drawing>'), 1)
            package = read(output / 'package.json')
            self.assertEqual(package['readyCountries'], ['kg'])
            self.assertEqual(package['countries']['kg']['bodyHtml'].count('<img '), 1)
            self.assertIn('https://source0.example/original.png', package['countries']['kg']['bodyHtml'])

    def test_source_timeout_is_neither_success_nor_empty_source(self):
        registry = {'sources': [{'id': 'missing', 'country': 'kg'}, {'id': 'retrying', 'country': 'kg'}]}
        inventory = {'sourceScanAudit': [{'sourceId': 'retrying', 'role': 'home', 'fetchedAt': STAMP,
                                         'status': 503, 'fetchRetryable': True}]}
        pending, _ = coverage(registry, 'kg', inventory, datetime.fromisoformat(STAMP))
        self.assertEqual(pending, ['missing', 'retrying'])


if __name__ == '__main__':
    unittest.main()
