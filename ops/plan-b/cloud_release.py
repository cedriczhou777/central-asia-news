"""Bind the signed content to its original archive and render a country release."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import gzip
import json
from pathlib import Path
import shutil
import tarfile

from build_reviewed_word import build_word
from cloud_handoff import LIMIT, REGISTRY, inventory_entries, read, recovery_registry, restore, write
from prepare_country_release import prepare
from prepare_editorial_input import candidate_originals, discovery_index
from editorial_policy import EFFECTIVE_ISSUE, TARGET_ARTICLES
from source_article_images import collect, save_manifest
from validate_work_package import digest
from source_coverage import assess_coverage, require_coverage_review
from work_quantity_policy import _dt, terminal_source_failure


def release_path(name):
    path = Path(name)
    return path.name in {'aggregate_ingest.json', 'package.json', 'prepared.json', 'staging_manifest.json'} and len(path.parts) == 1 \
        or len(path.parts) == 2 and path.parts[0] == 'images' and len(path.name) == 64 and all(c in '0123456789abcdef' for c in path.name)


def save_release(root, archive):
    total = 0
    with tarfile.open(archive, 'w:gz', compresslevel=2) as tar:
        for path in sorted(root.rglob('*')):
            relative = path.relative_to(root).as_posix()
            if not path.is_file() or not release_path(relative):
                continue
            total += path.stat().st_size
            if total > LIMIT:
                raise ValueError('prepared_release_size_limit')
            tar.add(path, arcname=relative, recursive=False)


def open_release(root, archive):
    root.mkdir(exist_ok=True)
    total = 0
    with tarfile.open(archive, 'r|gz') as tar:
        for entry in tar:
            total += entry.size
            if not entry.isfile() or not release_path(entry.name) or total > LIMIT:
                raise ValueError('invalid_release_archive')
            file = root / entry.name
            file.parent.mkdir(exist_ok=True)
            with file.open('xb') as out, tar.extractfile(entry) as data:
                shutil.copyfileobj(data, out)


def read_originals(source_root, issue, country, draft, review):
    ids = list(dict.fromkeys(article['id'] for article in draft['articles'] + review['articles']))
    index = discovery_index(source_root, issue, country)
    originals = {}
    for offset in range(0, len(ids), 5):
        result = candidate_originals(index, ids[offset:offset + 5])
        originals.update({row['id']: row for row in result['articles']})
    return originals


def bind_original(article, original, require_revision=False):
    if article['source_url'] != original['source_url'] or article['sourceHash'] != original['sourceHash']:
        raise ValueError('frozen_source_binding_mismatch')
    if require_revision and (not article.get('revision') or article['revision'] != original.get('revision')):
        raise ValueError('frozen_source_binding_mismatch')
    # Replace delivery metadata only. Signed titles, bodies and source identity
    # stay byte-for-byte identical to the Work handoff.
    fields = {k: v for k, v in article.items() if k not in {
        'original_full_text', 'sourceImage', 'imageUnavailableReason', 'cloudImageProbe',
        'image_url', 'image_sha256', 'image_bytes', 'image_local_path', 'image_caption',
    }}
    fields['original_full_text'] = original['text']
    return fields


def attach_audit(source, issue, country, draft, review, registry=None):
    registry = registry if registry is not None else read(REGISTRY)
    audit = read(source / 'source_scan_audit.json')
    events = {row['eventId']: row for row in audit['sourceScanAuditHistory'] + audit['sourceScanAudit']
              if (row.get('fetchedAt') or terminal_source_failure(row) and row.get('attemptedAt'))
              and not row.get('fetchRetryable')}
    conclusion = review.pop('candidateDecisions', draft.pop('candidateDecisions', {}))
    ledger = read(source / 'candidate_ledger.json')['candidateLedger']
    adopted = {article['id'] for article in review['articles']}
    deferred = {row['id']:row for row in draft.get('planBCoverage',{}).get('deferredCandidates',[])}
    editorial_ledger=[]
    for entry in ledger:
        if entry['id'] in deferred:
            expected=deferred[entry['id']]
            if (entry['id'] in adopted or entry.get('fullTextValidated') is True
                    or expected.get('sourceId')!=entry.get('sourceId')
                    or expected.get('sourceUrl')!=entry.get('source_url')
                    or expected.get('sourceHash')!=entry.get('sourceHash')
                    or expected.get('sourceJSONSha256')!=entry.get('sourceJSONSha256')):
                raise ValueError('deferred_candidate_evidence_invalid')
            continue
        editorial_ledger.append(entry)
        decision = conclusion.get(entry['id'])
        if decision:
            for key in ('decision', 'reason', 'languageReview', 'articleIdentityReview', 'firstDisclosureEvidence',
                        'firstDisclosureVerified', 'reviewedAt', 'reviewedBy',
                        'editorialState', 'publicationTimeResolution', 'priorPublicationEvidence', 'contradictionEvidence', 'duplicateOf', 'eventGroup', 'eventPhase', 'newFact'):
                if key in decision:
                    entry[key] = decision[key]
            held = (issue >= EFFECTIVE_ISSUE and entry['id'] not in adopted
                    and entry.get('editorialState') in ('pending_source_check','pending_time_check'))
            if held:
                entry['reviewedBy'] = review['reviewer']
            if entry['decision'] != ('selected' if entry['id'] in adopted else 'pending' if held else 'rejected'):
                raise ValueError('candidate_selection_mismatch')
        if entry['id'] in adopted and (entry.get('decision') != 'selected' or not entry.get('firstDisclosureVerified')):
            raise ValueError('selected_candidate_missing_first_disclosure_evidence')
    for role in (draft, review):
        role.pop('candidateLedger', None)
        role.pop('sourceScanAudit', None)
        role.pop('sourceRegistry', None)
    draft.update(sourceRegistry={'sources': [row for row in registry['sources'] if row['country'].lower() == country]},
                 sourceScanAudit=list(events.values()), candidateLedger=editorial_ledger,
                 deferredCandidateLedger=[entry for entry in ledger if entry['id'] in deferred])
    # Keep the actual queue/budget state for the independent scarcity gate.
    draft['discoveryState'] = {**audit, 'country': country, 'issueDate': issue,
                              'listingQueueRemaining': audit.get('listingQueueRemaining', len(audit.get('listingQueue', []))),
                              'articleQueueRemaining': audit.get('articleQueueRemaining', len(audit.get('articleQueue', []))),
                              'observedAt': audit.get('observedAt', draft['planBCoverage']['observedAt']),
                              'complete': audit.get('complete', not draft['planBCoverage']['pendingWork']),
                              'needs_expansion': audit.get('needs_expansion', bool(draft['planBCoverage']['pendingWork']))}


def source_photo(original, image_root):
    result = collect(original, image_root)
    image = result['sourceImage']
    if image['status'] == 'page_check_needed':
        if result.get('metadataHints'):
            # Metadata alone never authorizes using an image. Preserve the
            # unresolved page evidence as an image gap, not a country failure
            # or a false assertion that the publisher had no photo.
            image.update(status='unavailable', candidateUrls=result['metadataHints'],
                         candidateEvidence='metadata_only_unconfirmed',
                         attempts=[{'kind': 'page_evidence_check', 'url': original['source_url'],
                                    'result': 'displayed_original_image_not_identified'}])
            result['imageUnavailableReason'] = '原报道有图片元数据线索，但未确认页面实际展示的本篇原图；未采用图片，不认定原文无图'
            return result
        image['status'] = 'none'
        result['imageUnavailableReason'] = '原文正文未识别到本篇配图'
    return result


def prepare_from_handoff(directory, issue, country, version, fetch_photo=source_photo):
    source = directory / 'source'
    restore(source, directory / 'input.gz')
    with gzip.open(directory / 'editorial.gz', 'rb') as editorial:
        supplied = json.load(editorial)
    draft, review = supplied['draft'], supplied['review']
    if digest(draft['articles']) != review['originalHash'] or digest(review['articles']) != review['finalBodyHash']:
        raise ValueError('manual_handoff_hash_mismatch')
    audit = read(source / 'source_scan_audit.json')
    ledger = read(source / 'candidate_ledger.json')['candidateLedger']
    leads = read(source / 'lead_queue.json').get('leadLedger', []) if (source / 'lead_queue.json').exists() else []
    proof = supplied.get('coverage') or {}
    if not proof.get('observedAt'):
        raise ValueError('coverage_evidence_required')
    registry = recovery_registry(issue, country, version == '2026-11-27-r206', REGISTRY)
    actual = assess_coverage(registry, country, audit, _dt(issue + 'T06:00:00+08:00'),
                             ledger, leads, proof['observedAt'])
    if digest(actual) != digest(proof):
        raise ValueError('coverage_archive_binding_mismatch')
    require_coverage_review(actual, draft, review, supplied.get('finalHash'), inventory_entries(source, issue, country))
    draft['planBCoverage'] = actual
    draft['planBCoverageReview'] = review.get('coverageReview')
    draft['planBReviewerRun'] = review.get('reviewer')
    draft['planBFinalHash'] = supplied.get('finalHash')
    originals = read_originals(source, issue, country, draft, review)
    attach_audit(source, issue, country, draft, review, registry)
    for role in (draft, review):
        role['articles'] = [bind_original(article, originals[article['id']], issue >= EFFECTIVE_ISSUE)
                            for article in role['articles']]
    saved = directory / 'photos'
    saved.mkdir()
    root = saved / 'images'
    root.mkdir()
    final = review['articles']
    with ThreadPoolExecutor(max_workers=2) as pool:
        photos = list(pool.map(lambda entry: fetch_photo(originals[entry['id']], root), final))
    save_manifest(saved / 'manifest.json', photos, root)
    for entry, photo in zip(final, photos, strict=True):
        for key in ('sourceImage', 'imageUnavailableReason', 'image_url', 'image_sha256', 'image_bytes'):
            if key in photo:
                entry[key] = photo[key]
    # v57's rendering proof covers derived image/original metadata as well as
    # editorial content. Keep the Work hash in the DB receipt independently.
    review['originalHash'], review['finalBodyHash'] = digest(draft['articles']), digest(final)
    release = directory / 'release'
    result = prepare(release, draft, review, issue, country, version, 'normal', saved / 'manifest.json')
    target = TARGET_ARTICLES if issue >= EFFECTIVE_ISSUE else 15
    result.update(coverageState='checked_with_gaps' if actual['gaps'] else 'checked',
                  quantityState='target_met' if len(final) >= target else 'scarcity_approved',
                  coverageGapCount=len(actual['gaps']))
    if issue >= EFFECTIVE_ISSUE:
        result['sourcePhotoChecks'] = {
            photo['id']: {'state': photo['sourceImage']['status'],
                          'candidateCount': len(photo['sourceImage']['candidateUrls']),
                          'reason': photo.get('imageUnavailableReason')}
            for photo in photos
        }
    write(directory / 'release-status.json', result)
    save_release(release, directory / 'prepared.gz')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['prepare', 'word', 'unpack'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('extra', nargs='*')
    args = parser.parse_args()
    directory = args.directory
    if args.command == 'prepare':
        issue, country, version = args.extra
        prepare_from_handoff(directory, issue, country, version)
    else:
        open_release(directory / 'release', directory / 'prepared.gz')
        if args.command == 'word':
            result = build_word(directory / 'release', directory / 'word.docx')
            result.pop('wordPath', None)
            write(directory / 'word-status.json', result)


if __name__ == '__main__':
    main()
