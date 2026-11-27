import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { getSupabaseClient } from '../storage/database/supabase-client';
import { deliveryAdapters, deliverReviewedPackage, readPackage, reconcileKnownReviewedDraft } from './reviewed-delivery';
import { contentHash, packageCountries, requirePrivateImages, reviewedCountry, validatePackage } from './reviewed-package';
import { ensurePrivateImage } from './reviewed-private-images';
import { canonicalJson, EDITORIAL_POLICY_FIRST_ISSUE, PLAN_B_COUNTRIES, shaPattern, type PlanBCountry } from './plan-b-handoff';
import { verifyEditorial } from './plan-b-editorial';
import { planBClock } from './plan-b-window';
import { saveFile, verifyObject, wordLink, type ObjectReceipt, type SnapshotReceipt } from './plan-b-store';
import { restoreCache, runCloudScript, scratch, timeWithin } from './plan-b-worker';

type ReleaseReceipt = { prepared: ObjectReceipt; version: string; images: number; editorialHash: string; transportHash?: string;
  coverageState?: string; quantityState?: string; coverageGapCount?: number;
  sourcePhotoChecks?: Record<string, {state:string;candidateCount:number;reason:string|null}> };
export type WordReceipt = { document: ObjectReceipt; version: string; completedAt: string };
type ImageRow = { url: string; sha256: string; bytes: number };

export function planBPackageVersion(issue: string, country: PlanBCountry) {
  return `${issue}-r${102 + PLAN_B_COUNTRIES.indexOf(country)}`;
}

export function planBRecoveryPackageVersion(issue: string, country: PlanBCountry) {
  return issue === '2026-11-27' ? `${issue}-r${202 + PLAN_B_COUNTRIES.indexOf(country)}` : `${issue}-r4`;
}

function assertMayWrite(issue: string) {
  const clock = planBClock();
  if (issue !== clock.issue || !clock.finalizationAllowed) throw new Error('plan_b_delivery_window_closed');
}

export async function prepareCountryRelease(source: SnapshotReceipt, editorial: Record<string, unknown>) {
  const { issue, country } = source.snapshot;
  return scratch(async directory => {
    await restoreCache(directory, source.cache);
    await verifyObject(editorial.archived as ObjectReceipt, join(directory, 'editorial.gz'));
    const version = planBPackageVersion(issue, country);
    await runCloudScript('cloud_release.py', ['prepare', directory, issue, country, version], timeWithin(issue, '09:00:00', 480_000));
    const state = JSON.parse(await readFile(join(directory, 'release-status.json'), 'utf8'));
    if (state.version !== version || state.country !== country) throw new Error('plan_b_release_scope_mismatch');
    const { ready } = await readReleaseTransport(join(directory, 'release'), version, country);
    const prepared = await saveFile(issue, country, 'gz', join(directory, 'prepared.gz'));
    return { prepared, version, images: state.uniqueImages, editorialHash: editorial.editorialHash, transportHash: contentHash(ready),
      coverageState:state.coverageState, quantityState:state.quantityState, coverageGapCount:state.coverageGapCount,
      ...(state.sourcePhotoChecks ? { sourcePhotoChecks: state.sourcePhotoChecks } : {}) };
  });
}

export async function renderCountryWord(issue: string, country: PlanBCountry, release: ReleaseReceipt) {
  return scratch(async directory => {
    await verifyObject(release.prepared, join(directory, 'prepared.gz'));
    await runCloudScript('cloud_release.py', ['word', directory], timeWithin(issue, '09:00:00', 90_000));
    const document = await saveFile(issue, country, 'docx', join(directory, 'word.docx'));
    // Publish readiness only after verifying the object that can be delivered.
    await verifyObject(document);
    const {publishWord}=await import('./plan-b-exchange');
    await publishWord(issue,country,document,await readFile(join(directory,'word.docx')));
    return { version: release.version, document, completedAt: new Date().toISOString() };
  });
}

export async function getCountryWord(receipt: WordReceipt) {
  return wordLink(receipt.document);
}

async function readReleaseTransport(root: string, version: string, country: PlanBCountry) {
  const payload = validatePackage(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')));
  if (payload.version !== version || packageCountries(payload).join(',') !== country) {
    throw new Error('plan_b_release_scope_mismatch');
  }
  const manifest = JSON.parse(await readFile(join(root, 'staging_manifest.json'), 'utf8')) as { images: ImageRow[] };
  const item = reviewedCountry(payload, country);
  item.imageAssets = {};
  for (const image of manifest.images) {
    if (!shaPattern.test(image.sha256)) throw new Error('invalid_plan_b_image_hash');
    item.imageAssets[image.url] = { sha256: image.sha256, bytes: image.bytes };
  }
  const ready = validatePackage(payload);
  requirePrivateImages(ready);
  return { ready, images: manifest.images };
}

async function runIsolatedReleaseScript(phase: 'prepare' | 'word', args: string[], timeout: number) {
  try {
    await runCloudScript('cloud_release.py', [phase, ...args], timeout);
  } catch (error) {
    const failure = error as { killed?: boolean; code?: string | number; stderr?: string };
    if (failure.killed) throw new Error(`isolated_${phase}_timeout`);
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error(`isolated_${phase}_output_limit`);
    const lastLine = failure.stderr?.trimEnd().split('\n').at(-1) ?? '';
    const detail = lastLine.replace(/https?:\/\/[^\s\]]+/g, '[url]')
      .replace(/\b[0-9a-f]{16,}\b/gi, '[digest]')
      .replace(/(?:^|\s)\/[^\s\]]+/g, ' [path]')
      .replace(/[^a-zA-Z\d :,._;|()[\]=+\-]/g, ' ').trim().slice(0, 330);
    const stageFailure = (code: string) => Object.assign(new Error(code), {isolatedDiagnostic: detail});
    const reason = lastLine.match(/^(?:ValueError|RuntimeError): ([a-z][a-z0-9_]{0,64})$/)?.[1];
    if (reason) throw new Error(`isolated_${phase}_${reason}`);
    if (/^ValueError: (?:ingest|deliver) gate failed \([0-9]+\): /.test(lastLine)) {
      const classes = [
        ['quantity/coverage/selection incomplete', 'coverage_or_quantity'],
        ['source name does not match', 'source_attribution'],
        ['missing full source/text/time evidence', 'source_evidence'],
        ['publication outside issue window', 'publication_window'],
        ['final content hash mismatch', 'content_hash'],
      ];
      const code = classes.find(([label]) => lastLine.includes(label))?.[1] ?? 'validation';
      throw stageFailure(`isolated_${phase}_ingest_${code}`);
    }
    const type = lastLine.match(/^(AssertionError|AttributeError|FileExistsError|FileNotFoundError|ImportError|KeyError|ModuleNotFoundError|OSError|PermissionError|TypeError|ValueError):?/u)?.[1];
    throw stageFailure(`isolated_${phase}_${type?.replace(/([a-z])([A-Z])/g,'$1_$2').toLowerCase() ?? 'worker_failed'}`);
  }
}

function isolatedStageError(stage:string,error:unknown){
  const value=error as {name?:unknown;message?:unknown;code?:unknown;failureKind?:unknown}|null;
  if(typeof value?.message==='string'&&/^[a-z][a-z0-9_]{0,90}$/.test(value.message))return error instanceof Error?error:new Error(value.message);
  const detail=[value?.failureKind,value?.code,value?.name].find(part=>typeof part==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,35}$/.test(part));
  const kind=typeof detail==='string'?detail.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase():'failed';
  return new Error(`isolated_${stage}_${kind}`);
}

/** Prepare a signed, isolated draft and Word. Draft creation requires a separate
 * exact-package authority, and this preparation never changes normal issue rows. */
export async function prepareIsolatedRelease(source: SnapshotReceipt, input: unknown, version: string, deadline: number) {
  const { issue, country } = source.snapshot;
  if (version !== planBRecoveryPackageVersion(issue, country)) throw new Error('invalid_isolated_release_version');
  const checked = verifyEditorial(input, source.snapshot);
  const remaining = (maximum: number) => {
    const value = Math.min(maximum, deadline - Date.now());
    if (value < 2_000) throw new Error('isolated_release_window_closed');
    return value;
  };
  let stage='scratch';
  try{
    return await scratch(async directory => {
      stage='archive_restore';
      await restoreCache(directory, source.cache);
      stage='editorial_archive';
      await writeFile(join(directory,'editorial.gz'),await promisify(gzip)(canonicalJson(checked.value)));
      stage='archive_prepare';
      await runIsolatedReleaseScript('prepare',[directory,issue,country,version],remaining(480_000));
      stage='transport_read';
      const root=join(directory,'release');
      const {ready,images}=await readReleaseTransport(root,version,country);
      stage='image_stage';
      for(const image of images){
        remaining(30_000);
        const bytes=await readFile(join(root,'images',image.sha256));
        if(bytes.length!==image.bytes)throw new Error('invalid_plan_b_image_length');
        await ensurePrivateImage(bytes,image.sha256);
      }
      stage='word_render';
      await runIsolatedReleaseScript('word',[directory],remaining(90_000));
      const wordPath=join(directory,'word.docx');
      stage='word_store';
      const document=await saveFile(issue,country,'docx',wordPath);
      await verifyObject(document);
      stage='word_exchange';
      const {publishWord}=await import('./plan-b-exchange');
      await publishWord(issue,country,document,await readFile(wordPath));
      stage='transport_validate';
      const release=validatePackage(ready);
      stage='word_link';
      return {release,word:{document,url:await wordLink(document)},editorialHash:checked.editorialHash,
        articles:checked.articleCount,images:images.length,transportHash:contentHash(release)};
    });
  }catch(error){throw isolatedStageError(stage,error);}
}

async function storeReviewedTransports(issue: string, country: PlanBCountry, release: ReleaseReceipt) {
  return scratch(async directory => {
    await verifyObject(release.prepared, join(directory, 'prepared.gz'));
    await runCloudScript('cloud_release.py', ['unpack', directory], timeWithin(issue, '09:00:00', 90_000));
    const root = join(directory, 'release');
    const { ready, images } = await readReleaseTransport(root, release.version, country);
    const hash = contentHash(ready);
    if (release.transportHash && release.transportHash !== hash) throw new Error('plan_b_transport_hash_conflict');
    const verified = new Set<string>();
    for (const image of images) {
      if (!verified.has(image.sha256)) {
        assertMayWrite(issue);
        const bytes = await readFile(join(root, 'images', image.sha256));
        if (bytes.length !== image.bytes) throw new Error('invalid_plan_b_image_length');
        try {
          await ensurePrivateImage(bytes, image.sha256);
        } catch (error) {
          if (issue < EDITORIAL_POLICY_FIRST_ISSUE) throw error;
          // The signed package stays intact. Transport may omit unavailable
          // pinned images on future issues and records each omission.
        }
        verified.add(image.sha256);
      }
    }
    assertMayWrite(issue);
    const sb = getSupabaseClient();
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
  const existing = await readPackage(release.version);
  if (existing && release.transportHash && contentHash(existing) !== release.transportHash) {
    throw new Error('plan_b_transport_hash_conflict');
  }
  const payload = existing && release.transportHash ? existing : await storeReviewedTransports(issue, country, release);
  const result = await deliverReviewedPackage(payload, getSupabaseClient(), {
    ...deliveryAdapters,
    prepare: (draft, progress) => {
      check();
      return deliveryAdapters.prepare(draft, async () => { check(); await progress?.(); }, true, issue>=EDITORIAL_POLICY_FIRST_ISSUE);
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
