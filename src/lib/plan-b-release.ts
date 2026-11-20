import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSupabaseClient } from '../storage/database/supabase-client';
import { deliveryAdapters, deliverReviewedPackage, readPackage, reconcileKnownReviewedDraft } from './reviewed-delivery';
import { contentHash, packageCountries, requirePrivateImages, reviewedCountry, validatePackage } from './reviewed-package';
import { ensurePrivateImage } from './reviewed-private-images';
import { PLAN_B_COUNTRIES, shaPattern, type PlanBCountry } from './plan-b-handoff';
import { planBClock } from './plan-b-window';
import { readObject, saveObject, wordLink, type ObjectReceipt, type SnapshotReceipt } from './plan-b-store';
import { restoreCache, runCloudScript, scratch, timeWithin } from './plan-b-worker';

type ReleaseReceipt = { prepared: ObjectReceipt; version: string; images: number; editorialHash: string };
export type WordReceipt = { document: ObjectReceipt; version: string; completedAt: string };
type ImageRow = { url: string; sha256: string; bytes: number };

export function planBPackageVersion(issue: string, country: PlanBCountry) {
  return `${issue}-r${102 + PLAN_B_COUNTRIES.indexOf(country)}`;
}

function assertMayWrite(issue: string) {
  const clock = planBClock();
  if (issue !== clock.issue || !clock.finalizationAllowed) throw new Error('plan_b_delivery_window_closed');
}

export async function prepareCountryRelease(source: SnapshotReceipt, editorial: Record<string, unknown>) {
  const { issue, country } = source.snapshot;
  return scratch(async directory => {
    await restoreCache(directory, source.cache);
    await writeFile(join(directory, 'editorial.gz'), await readObject(editorial.archived as ObjectReceipt), { mode: 0o600 });
    const version = planBPackageVersion(issue, country);
    await runCloudScript('cloud_release.py', ['prepare', directory, issue, country, version], timeWithin(issue, '09:00:00', 480_000));
    const state = JSON.parse(await readFile(join(directory, 'release-status.json'), 'utf8'));
    if (state.version !== version || state.country !== country) throw new Error('plan_b_release_scope_mismatch');
    const prepared = await saveObject(issue, country, 'gz', await readFile(join(directory, 'prepared.gz')));
    return { prepared, version, images: state.uniqueImages, editorialHash: editorial.editorialHash };
  });
}

export async function renderCountryWord(issue: string, country: PlanBCountry, release: ReleaseReceipt) {
  return scratch(async directory => {
    await writeFile(join(directory, 'prepared.gz'), await readObject(release.prepared), { mode: 0o600 });
    await runCloudScript('cloud_release.py', ['word', directory], timeWithin(issue, '09:00:00', 90_000));
    const document = await saveObject(issue, country, 'docx', await readFile(join(directory, 'word.docx')));
    // Publish readiness only after verifying the object that can be delivered.
    await readObject(document);
    return { version: release.version, document, completedAt: new Date().toISOString() };
  });
}

export async function getCountryWord(receipt: WordReceipt) {
  return wordLink(receipt.document);
}

async function storeReviewedTransports(issue: string, country: PlanBCountry, release: ReleaseReceipt) {
  return scratch(async directory => {
    await writeFile(join(directory, 'prepared.gz'), await readObject(release.prepared), { mode: 0o600 });
    await runCloudScript('cloud_release.py', ['unpack', directory], timeWithin(issue, '09:00:00', 90_000));
    const root = join(directory, 'release');
    const payload = validatePackage(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')));
    if (payload.version !== release.version || packageCountries(payload).join(',') !== country) {
      throw new Error('plan_b_release_scope_mismatch');
    }
    const manifest = JSON.parse(await readFile(join(root, 'staging_manifest.json'), 'utf8')) as { images: ImageRow[] };
    const item = reviewedCountry(payload, country);
    item.imageAssets = {};
    const verified = new Set<string>();
    for (const image of manifest.images) {
      if (!shaPattern.test(image.sha256)) throw new Error('invalid_plan_b_image_hash');
      if (!verified.has(image.sha256)) {
        assertMayWrite(issue);
        const bytes = await readFile(join(root, 'images', image.sha256));
        if (bytes.length !== image.bytes) throw new Error('invalid_plan_b_image_length');
        await ensurePrivateImage(bytes, image.sha256);
        verified.add(image.sha256);
      }
      item.imageAssets[image.url] = { sha256: image.sha256, bytes: image.bytes };
    }
    const ready = validatePackage(payload);
    requirePrivateImages(ready);
    assertMayWrite(issue);
    const sb = getSupabaseClient();
    const hash = contentHash(ready);
    const inserted = await sb.from('reviewed_packages').insert({ issue_date: issue, version: ready.version, content_hash: hash, payload: ready });
    if (inserted.error) {
      if (inserted.error.code !== '23505') throw new Error('plan_b_transport_save_failed');
      const existing = await readPackage(ready.version);
      if (!existing || contentHash(existing) !== hash) throw new Error('plan_b_transport_hash_conflict');
    }
    return ready;
  });
}

export async function deliverCountryWechat(issue: string, country: PlanBCountry, release: ReleaseReceipt) {
  const check = () => assertMayWrite(issue);
  check();
  const payload = await readPackage(release.version) || await storeReviewedTransports(issue, country, release);
  const result = await deliverReviewedPackage(payload, getSupabaseClient(), {
    ...deliveryAdapters,
    prepare: (draft, progress) => {
      check();
      return deliveryAdapters.prepare(draft, async () => { check(); await progress?.(); });
    },
    beforeWrite: check,
    create: article => { check(); return deliveryAdapters.create(article); },
    // A known but mismatching draft is assigned to read-only reconciliation.
    update: undefined,
  }, [country]);
  if (result.ok) return { version: release.version, completedAt: new Date().toISOString(), ...result.drafts[0] };
  const failure = result.failures[0] as { state?: string; error?: string } | undefined;
  if (failure?.state === 'uncertain' || failure?.state === 'sending' || failure?.state === 'updating') {
    return { version: release.version, pendingReadback: true, state: failure.state };
  }
  throw new Error(failure?.error || 'plan_b_wechat_delivery_failed');
}

export async function reconcileCountryWechat(issue: string, country: PlanBCountry) {
  const version = planBPackageVersion(issue, country);
  const payload = await readPackage(version);
  if (!payload) return null;
  const receipt = await reconcileKnownReviewedDraft(payload, country);
  return receipt && { version, completedAt: new Date().toISOString(), ...receipt };
}
