"""Offline round-trip through the source archive, signed package and Word."""

import copy
from datetime import datetime, timedelta
from functools import partial
import gzip
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops' / 'plan-b'))
from cloud_handoff import backup, coverage, inventory_entries, originals, read, restore, write
from source_coverage import assess_coverage
import cloud_release
from fetch_work_sources import decode_transport
import prepare_country_release
from prepare_editorial_input import candidate_row
from source_article_images import collect, connect_public
from test_work_quantity import fixture
from validate_work_package import digest, quantity_report
from verify_rendered_package import verify_rendered_package
from work_quantity_policy import _evidence_errors


ISSUE = '2026-11-21'
STAMP = ISSUE + 'T06:01:00+08:00'


def inputs(directory, *, transport_budget=False, issue=ISSUE, count=15, photo_index=0, follow_up=False, country='kg'):
    end = datetime.fromisoformat(issue + "T06:00:00+08:00")
    stamp = (end + timedelta(minutes=1)).isoformat()
    source = directory / 'source-fixture'
    source.mkdir()
    evidence = source / 'evidence'
    evidence.mkdir()
    draft, audit, _ = fixture(count)
    for registered in draft['sourceRegistry']['sources']:
        registered['country'] = country
    for index, row in enumerate(audit):
        row.update(fetchedAt=stamp, eventId=f'fake-{index}')
    for index, (item, entry) in enumerate(zip(draft['articles'], draft['candidateLedger'], strict=True)):
        text = f'Synthetic original source text for a single test article {index}.'
        photo_list = ([{'url': 'https://source0.example/original.png', 'basis': 'article_body'}] if index == photo_index else [])
        previous = follow_up and index == count - 1
        published = (end - (timedelta(hours=30) if previous else timedelta(seconds=1))).isoformat()
        raw = {'title': f'Synthetic title {index}', 'text': text, 'articleImages': {'candidates': photo_list},
               'publicationEvidence': [{'kind': 'published', 'value': published, 'timezoneEvidence': 'explicit'}]}
        path = evidence / f'article-{index}.json'
        write(path, raw)
        exact = hashlib.sha256(path.read_bytes()).hexdigest()
        source_hash = hashlib.sha256(text.encode()).hexdigest()
        entry.update(sourceJSON=str(path), sourceJSONSha256=exact, sourceHash=source_hash,
                     fullTextValidated=True, firstDisclosureVerified=True,
                     publicationWindowAssessment='outside_window' if previous else 'in_window',
                     discoveredAt=stamp, fullTextFetchedAt=stamp)
        if previous:
            entry.update(decision='rejected', reason='explicit_publication_outside_window', decisionOrigin='mechanical')
        for item_evidence in entry['publicationEvidence'] + entry['evidence']:
            item_evidence['observedAt'] = stamp
        audit[11 + index]['sourceHash'] = source_hash
        item.update(title=f'测试新闻{index}', body='这是离线合成的测试稿件。', category='产业', source='Fixture Media',
                    sourceHash=source_hash, published_at=published,
                    timeEvidence='合成报文显示的带时区发布时间',
                    firstPublicationCheck='合成报文同时提供首次披露和实际发布时间')
        if issue >= '2026-11-27':
            item['revision'] = candidate_row(entry)['editorialFingerprint']
        if previous:
            item.update(title='【延续关注】'+item['title'],previousDay=True,followUpReason='Synthetic continuing interest after the previous publication')
    region = {'issueDate': issue, 'country': country, 'windowStart': (end - timedelta(days=1)).isoformat(),
              'windowEnd': end.isoformat()}
    registry = directory / 'registry.json'
    write(registry, draft['sourceRegistry'])
    write(source / 'candidate_ledger.json', {**region, 'candidateLedger': draft['candidateLedger']})
    inventory = {**region, 'sourceScanAudit': audit, 'sourceScanAuditHistory': [],
                 'listingQueue': [], 'articleQueue': [], 'budgetEvents': []}
    if transport_budget:
        inventory.update(maxSeconds=480.0, observedAt=stamp)
    write(source / 'source_scan_audit.json', inventory)
    backup(source, directory / 'input.gz')
    draft.update(**region, coverageEnd=end.isoformat())
    rows = copy.deepcopy(draft['articles'])
    review = {**region, 'reviewer': 'independent-test', 'stage': 'verified', 'issues': [],
              'articles': rows, 'originalHash': digest(draft['articles']), 'finalBodyHash': digest(rows),
              'fullSourceReviewCompleted': True, 'titleFactReviewCompleted': True, 'bodyFactReviewCompleted': True}
    proof = assess_coverage(read(registry), country, read(source / 'source_scan_audit.json'),
                            end,
                            draft['candidateLedger'], observed_at=stamp)
    if transport_budget:
        # Node JSON.stringify transports the integral Python float as an integer.
        proof['scanBudget']['maxSeconds'] = 480
    final_hash = 'f' * 64
    review['coverageReview'] = {'status': 'verified', 'reviewer': review['reviewer'], 'finalHash': final_hash,
                               'reviewedAt': stamp, 'criticalTopicsReviewed': ['policy', 'energy', 'investment', 'business'],
                               'sourceIdsReviewed': proof['readableSources'] + [g['sourceId'] for g in proof['gaps']],
                               'gapResolutions': [{'sourceId': g['sourceId'], 'reason': 'Synthetic independent coverage of all four critical news topics',
                                                   'alternativeCandidateIds': ['article0']} for g in proof['gaps']]}
    if follow_up:
        review['candidateDecisions'] = {rows[-1]['id']: {'decision': 'selected',
            'reason': 'Verified original retained explicitly as a previous-day follow-up in this fixture'}}
    with gzip.open(directory / 'editorial.gz', 'wt') as out:
        json.dump({'draft': draft, 'review': review, 'coverage': proof, 'finalHash': final_hash}, out)
    return source, registry


def photo(original, image_root):
    urls = [row['url'] for row in original['articleImages']['candidates']]
    decision = {'sourceUrl': original['source_url'], 'candidateUrls': urls, 'status': 'original' if urls else 'none'}
    if not urls:
        return {'id': original['id'], 'sourceImage': decision, 'imageUnavailableReason': '合成原文无图'}
    target = image_root / 'test.png'
    Image.new('RGB', (120, 90), 'blue').save(target)
    sha = hashlib.sha256(target.read_bytes()).hexdigest()
    ready = image_root / sha
    target.rename(ready)
    return {'id': original['id'], 'sourceImage': decision, 'image_url': urls[0], 'image_sha256': sha, 'image_bytes': ready.stat().st_size}


class CloudReleaseTest(unittest.TestCase):
    def test_publisher_date_evidence_preserves_exact_article_scope(self):
        stamp = datetime.fromisoformat(STAMP)
        date_record = {'row': {'role':'article'},'urls': {'https://source0.example/news/report/'},'time': stamp}
        publication = {'url':'https://source0.example/news/report', 'observedAt':STAMP,
                       'description':'Article-bound timestamp in publisher metadata'}
        self.assertEqual(_evidence_errors([publication],[date_record],stamp,'publication',publisher_article_aliases=True), [])
        self.assertTrue(_evidence_errors([publication],[date_record],stamp,'publication'))
        for wrong in ('https://source0.example/news/other', 'https://other.example/news/report',
                      'https://source0.example/news/report?edition=2'):
            self.assertTrue(_evidence_errors([{**publication,'url':wrong}],[date_record],stamp,'publication',publisher_article_aliases=True))

    def test_language_review_binds_to_the_exact_frozen_archive_member(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            archive = root / 'evidence' / 'original.json'
            archive.parent.mkdir()
            raw = b'{"text":"archive member read by the independent reviewer"}'
            archive.write_bytes(raw)
            row = {
                'id': 'story', 'sourceId': 'tj-khovar',
                'source_url': 'https://khovar.tj/2026/11/story/',
                'sourceJSON': '/old/runtime/evidence/original.json',
                'sourceJSONSha256': hashlib.sha256(raw).hexdigest(),
                'sourceHash': 'a' * 64, 'sourceRevisionHash': 'b' * 64,
            }
            proof = {
                'reviewer': 'independent', 'language': 'tg',
                'sourceHash': row['sourceHash'], 'sourceJSONSha256': row['sourceJSONSha256'],
                'revision': candidate_row(row)['editorialFingerprint'],
            }
            bound = cloud_release.bind_archived_language_review(root, row, proof, 'independent')
            self.assertEqual(bound['sourceRevisionHash'], row['sourceRevisionHash'])
            self.assertNotIn('sourceRevisionHash', proof)
            with self.assertRaisesRegex(ValueError, 'archived_language_review_binding_mismatch'):
                cloud_release.bind_archived_language_review(root, row, {**proof, 'revision': '0' * 64}, 'independent')
            archive.write_bytes(raw + b' ')
            with self.assertRaisesRegex(ValueError, 'archived_language_review_evidence_changed'):
                cloud_release.bind_archived_language_review(root, row, proof, 'independent')

    def test_deferred_unverified_navigation_is_not_an_adoptable_article(self):
        with tempfile.TemporaryDirectory() as td:
            directory=Path(td);source,registry=inputs(directory)
            supplied=json.loads(gzip.decompress((directory/'editorial.gz').read_bytes()))
            ledger=read(source/'candidate_ledger.json')
            row={**ledger['candidateLedger'][0],'id':'navigation','source_url':'https://source0.example/privacy#contact',
                 'fullTextValidated':True,'fullTextFetchedAt':None,'decision':'pending'}
            ledger['candidateLedger'].append(row);write(source/'candidate_ledger.json',ledger)
            deferred={k:row[k] for k in ('id','sourceId','sourceHash','sourceJSONSha256')}
            deferred['sourceUrl']='https://source0.example/privacy'
            supplied['draft']['planBCoverage']={**supplied['coverage'],'deferredCandidates':[deferred]}
            with patch.object(cloud_release,'REGISTRY',registry):
                draft=copy.deepcopy(supplied['draft']);review=copy.deepcopy(supplied['review'])
                cloud_release.attach_audit(source,ISSUE,'kg',draft,review)
                self.assertEqual(len(draft['candidateLedger']),15)
                self.assertEqual(draft['deferredCandidateLedger'][0]['id'],'navigation')
                self.assertEqual(len(read(source/'candidate_ledger.json')['candidateLedger']),16,'original archive stays intact')
                bad=copy.deepcopy(supplied);bad['draft']['planBCoverage']['deferredCandidates'][0]['sourceHash']='0'*64
                with self.assertRaisesRegex(ValueError,'deferred_candidate_hash_mismatch'):
                    cloud_release.attach_audit(source,ISSUE,'kg',bad['draft'],bad['review'])
                bad=copy.deepcopy(supplied);bad['review']['articles'].append({'id':'navigation'})
                with self.assertRaisesRegex(ValueError,'deferred_candidate_already_reviewable'):
                    cloud_release.attach_audit(source,ISSUE,'kg',bad['draft'],bad['review'])
                row['fullTextFetchedAt']=STAMP
                write(source/'candidate_ledger.json',ledger)
                bad=copy.deepcopy(supplied)
                with self.assertRaisesRegex(ValueError,'deferred_candidate_already_reviewable'):
                    cloud_release.attach_audit(source,ISSUE,'kg',bad['draft'],bad['review'])

    def test_fifteen_reviewed_items_render_in_word_and_transport(self):
        with tempfile.TemporaryDirectory() as td:
            directory = Path(td)
            source, registry = inputs(directory, transport_budget=True)
            restored = directory / 'rehydrated'
            restore(restored, directory / 'input.gz')
            self.assertEqual(len(inventory_entries(restored, ISSUE, 'kg')), 15)
            scan = read(source / 'source_scan_audit.json')
            missing, observed = coverage(read(registry), 'kg', scan, datetime.fromisoformat(STAMP), observed_at=STAMP)
            self.assertEqual(missing, [])
            self.assertEqual(len(observed['freshReadableSources']), 3)
            gate = partial(verify_rendered_package, now=datetime.fromisoformat(ISSUE + 'T07:00:00+08:00'))
            with patch.object(cloud_release, 'REGISTRY', registry), patch.object(prepare_country_release, 'verify_rendered_package', gate), \
                    patch('source_coverage.datetime') as clock:
                clock.now.return_value = datetime.fromisoformat(ISSUE + 'T07:00:00+08:00')
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

    def test_daily_edition_renders_fifteen_and_uses_second_story_cover(self):
        for country in ('kz', 'uz', 'kg', 'tj', 'az'):
            with self.subTest(country=country):
                self.check_daily_edition(country)

    def check_daily_edition(self, country):
        issue = '2026-11-27'
        now = datetime.fromisoformat(issue + 'T07:00:00+08:00')
        with tempfile.TemporaryDirectory() as td:
            directory = Path(td)
            source, registry = inputs(directory, issue=issue, count=15, photo_index=1, country=country)
            inventory = {row['id']: row for row in inventory_entries(source, issue, country)}
            self.assertEqual(inventory['article14']['publishedAt'], issue + 'T05:59:59+08:00')
            self.assertEqual(inventory['article1']['photoCandidates'], 1)
            gate = partial(verify_rendered_package, now=now)
            with patch.object(cloud_release, 'REGISTRY', registry), patch.object(prepare_country_release, 'verify_rendered_package', gate), \
                    patch('source_coverage.datetime') as clock:
                clock.now.return_value = now
                cloud_release.prepare_from_handoff(directory, issue, country, issue + '-r104', fetch_photo=photo)
            release = directory / 'release'
            result = read(directory / 'release-status.json')
            self.assertEqual(result['quantityState'], 'target_met')
            self.assertEqual(result['sourcePhotoChecks']['article0']['state'], 'none')
            self.assertEqual(result['sourcePhotoChecks']['article1']['state'], 'original')
            package = read(release / 'package.json')['countries'][country]
            self.assertEqual(package['coverUrl'], 'https://source0.example/original.png')
            self.assertLess(package['bodyHtml'].index('测试新闻0'), package['bodyHtml'].index('<img '))
            self.assertIn('测试新闻14', package['bodyHtml'])
            if country == 'tj':
                aggregate = read(release / 'aggregate_ingest.json')
                audit = aggregate['drafts'][country]['sourceScanAudit']
                ghost = {**next(row for row in audit if row['role']=='article'),
                         'eventId':'fixture-landing-page-report', 'role':'section',
                         'url':'https://source0.example/news/landing',
                         'final_url':'https://source0.example/news/landing'}
                audit.append(ghost)
                self.assertTrue(quantity_report(aggregate, now=now, countries=[country])[country]['quantityReady'])
                ghost['role'] = 'article'
                check = quantity_report(aggregate, now=now, countries=[country])[country]
                self.assertFalse(check['quantityReady'])
                self.assertTrue(any('missing from candidate ledger' in msg for msg in check['candidateLedgerValidation']['errors']))
                invalid_output = directory / 'directory-not-word.docx'
                invalid_output.mkdir()
                with self.assertRaises(OSError):
                    cloud_release.build_word(release, invalid_output)
            cloud_release.render_archived_word(directory)
            word = read(directory / 'word-status.json')
            self.assertEqual((word['articles'],word['images']), (15,1))
            with ZipFile(directory / 'word.docx') as doc:
                self.assertIn('测试新闻14', doc.read('word/document.xml').decode())

    def test_source_timeout_is_neither_success_nor_empty_source(self):
        registry = {'sources': [{'id': 'missing', 'country': 'kg'}, {'id': 'retrying', 'country': 'kg'}]}
        inventory = {'sourceScanAudit': [{'sourceId': 'retrying', 'role': 'home', 'fetchedAt': STAMP,
                                         'status': 503, 'fetchRetryable': True}]}
        pending, _ = coverage(registry, 'kg', inventory, datetime.fromisoformat(STAMP))
        self.assertEqual(pending, ['missing', 'retrying'])

    def test_cached_originals_and_bounded_fetch(self):
        with tempfile.TemporaryDirectory() as td:
            directory = Path(td)
            inputs(directory)
            cache = directory / 'cache'
            restore(cache, directory / 'input.gz', editorial_only=True)
            self.assertEqual(originals(cache, ISSUE, 'kg', ['article0']),
                             originals(cache, ISSUE, 'kg', ['article0']))
        with patch('fetch_work_sources.MAX_TRANSPORT_BYTES', 8):
            with self.assertRaisesRegex(ValueError, 'decoded_source_too_large'):
                decode_transport(gzip.compress(b'0123456789'), 'gzip')
        with patch('source_article_images.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('127.0.0.1', 443))]):
            with self.assertRaisesRegex(ValueError, 'nonpublic'):
                connect_public(('test.example', 443), 1)

    def test_image_retry_is_bounded_and_classifies_permanent_errors(self):
        original = {'id': 'fixture', 'source_url': 'https://source.example/article',
                    'articleImages': {'candidates': [{'url': 'https://source.example/image.jpg'}]}}
        with tempfile.TemporaryDirectory() as td:
            for status, calls in (('HTTP 404', 1), ('HTTP 403', 1), ('HTTP 503', 2), ('HTTP 429', 1)):
                failure = SimpleNamespace(returncode=1, stderr=status.encode())
                with patch('source_article_images.subprocess.run', return_value=failure) as download:
                    result = collect(original, Path(td))
                    self.assertEqual(download.call_count, calls)
                    self.assertEqual(result['sourceImage']['status'], 'unavailable')
                    self.assertIn(status, result['imageUnavailableReason'])


if __name__ == '__main__':
    unittest.main()
