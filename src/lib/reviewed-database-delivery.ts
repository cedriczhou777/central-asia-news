import { createHmac, timingSafeEqual } from 'node:crypto';
import cron from 'node-cron';
import { getSupabaseClient } from '../storage/database/supabase-client';
import { canonicalJson, sha256 } from './plan-b-handoff';
import { PLAN_B_CLOCK, planBClock, planBHandlesIssue, planBIngestSecret } from './plan-b-window';
import { deliverReviewedPackage, deliveryAdapters, reconcileKnownReviewedDraft } from './reviewed-delivery';
import { validManualGrant } from './reviewed-manual-authorization';
import { contentHash, imageUrls, issueDate, PACKAGE_COUNTRIES, packageCountries, requirePrivateImages, reviewedCountry, validatePackage, type PackageCountry } from './reviewed-package';
import { REVIEWED_VERSION_CONFLICT, storeReviewedPackage } from './reviewed-package-store';
import { findRecentReviewedDrafts } from './reviewed-wechat';
import { summarizeDraftReadback, verifiedReviewedLayout } from './reviewed-diagnostics';

const TABLE = 'plan_b_exchange';
const REQUEST_PREFIX = 'db-delivery/';
export const DATABASE_APPROVAL_PREFIX = 'db-approval/';
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const AUTHORIZATION_ID = /^[A-Za-z0-9_-]{16,96}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FIRST_RECOVERABLE_ISSUE = '2026-11-26';
const NEXT_COLLECTION_GUARD = 4 * 60 + 30;
const DAY_MS = 24 * 60 * 60_000;
const WORKER_VERSION = 'reviewed-database-recovery-v2';

// The deployment itself carries the edition owner's one-time authorization.
// Database input cannot choose the digest, issue, countries or expiry.
const NOV26_DEPLOYMENT_APPROVAL = {
  issue: '2026-11-26',
  version: '2026-11-26',
  authorizationId: 'nov26-deployment-approved-23c4d8774035339c',
  contentHash: '23c4d8774035339c25ea5e1e48f693a34c236bb3694e83098dce007db3d9273c',
  countries: PACKAGE_COUNTRIES,
  expiresAt: Date.parse('2026-11-26T12:00:00+08:00'),
} as const;
const NOV26_LAYOUT_APPROVAL = {
  ...NOV26_DEPLOYMENT_APPROVAL,
  version: '2026-11-26-r2',
  authorizationId: 'nov26-layout-r2-878ad7c679d22eb5',
  contentHash: '878ad7c679d22eb5962aa5095e6a4e268a9f7696acf47649235d93795fcd5a46',
  expiresAt: Date.parse('2026-11-26T14:00:00+08:00'),
} as const;

// Owner requested a separate five-country production draft check from the reviewed November 26 edition.
const NOV26_REAL_DRAFT_APPROVAL = {
  issue: '2026-11-26',
  version: '2026-11-26-r3',
  authorizationId: 'nov26-owner-live-r3-retry-9a18ba2be332ae6c',
  contentHash: '9a18ba2be332ae6ce361b0de80edca8f4c7fd76aecd691467c08598bdec73ae6',
  countries: PACKAGE_COUNTRIES,
  expiresAt: Date.parse('2026-11-26T15:00:00+08:00'),
} as const;
const NOV26_SHORT_DRAFT_APPROVAL = {
  issue: '2026-11-26',
  version: '2026-11-26-r4',
  authorizationId: 'nov26-owner-verified-short-r4-6ca4e80de36d8b',
  contentHash: '6ca4e80de36d8ba790d8a833f458bf81fc5b2c2c9e9fb8f17a73af623bdc4283',
  countries: PACKAGE_COUNTRIES,
  expiresAt: Date.parse('2026-11-26T22:00:00+08:00'),
} as const;
const VALIDATION_DRAFT_APPROVALS = [NOV26_REAL_DRAFT_APPROVAL, NOV26_SHORT_DRAFT_APPROVAL] as const;
const NOV27_DRAFT_APPROVALS = [{
  issue: '2026-11-27',
  version: '2026-11-27-r206',
  authorizationId: 'nov27-az-owner-draft-r206-b05cf6b1b8c73910',
  contentHash: 'b05cf6b1b8c73910ddfcee2c62b7c26ef012c97cd4030c6b7c3ab0fbd06175af',
  countries: ['az'],
  expiresAt: Date.parse('2026-11-27T20:00:00+08:00'),
}, {
  issue: '2026-11-27',
  version: '2026-11-27-r202',
  authorizationId: 'nov27-kz-owner-draft-r202-e599c4fb759c17ec',
  contentHash: 'e599c4fb759c17ecd6eaaad8c8daf93c48f83a91516a2d5430cc072e51bed8a5',
  countries: ['kz'],
  expiresAt: Date.parse('2026-11-27T20:00:00+08:00'),
}, {
  issue: '2026-11-27',
  version: '2026-11-27-r203',
  authorizationId: 'nov27-uz-owner-draft-r203-cb874c645de517ac',
  contentHash: 'cb874c645de517ac78fc28c12007dbac30f23f4ceadc299db6ad5e6322e67705',
  countries: ['uz'],
  expiresAt: Date.parse('2026-11-27T20:00:00+08:00'),
}, {
  issue: '2026-11-27',
  version: '2026-11-27-r204',
  authorizationId: 'nov27-kg-owner-draft-r204-1f824db5f6d1cfcd',
  contentHash: '1f824db5f6d1cfcd79df68861ee894f67e2c5a23667c142c28a5c9c892d4fcc4',
  countries: ['kg'],
  expiresAt: Date.parse('2026-11-27T20:00:00+08:00'),
}] as const;

type GrantRow = { payload: Record<string, unknown>; content_hash: string; state: string };
type RequestRow = GrantRow & {
  issue_date: string; country: PackageCountry; record_key: string; attempts: number;
  result?: Record<string, unknown> | null;
};
type DeploymentApproval = {
  issue: string; version: string; authorizationId: string; contentHash: string;
  countries: readonly PackageCountry[]; expiresAt: number;
};

// The signing key belongs to the approving operator and the cloud worker.
// A database row or SQL session alone cannot authorize a draft write.
export function databaseApprovalSignature(key: string, id: string, approval: Record<string, unknown>) {
  return createHmac('sha256', key).update(canonicalJson({ scope: 'reviewed-database-delivery-v1', id, approval })).digest('hex');
}

export function isIndependentDatabaseApprovalKey(key: string) {
  return SHA256.test(key) && key !== process.env.INGEST_SECRET && key !== planBIngestSecret();
}

export function reviewedDatabaseRecoveryWindow(now = Date.now()) {
  const { issue: today, minute } = planBClock(now);
  if (minute >= NEXT_COLLECTION_GUARD && minute < PLAN_B_CLOCK.closeAt) return null;
  const issue = minute < NEXT_COLLECTION_GUARD ? planBClock(now - DAY_MS).issue : today;
  if (issue < FIRST_RECOVERABLE_ISSUE || !planBHandlesIssue(issue)) return null;
  return { issue, opensAt: Date.parse(`${issue}T09:30:00+08:00`),
    closesAt: Date.parse(`${issue}T04:30:00+08:00`) + DAY_MS };
}

export function deploymentRecoveryRows(approval: DeploymentApproval, staged: GrantRow, key: string, now: number) {
  const window = reviewedDatabaseRecoveryWindow(now);
  if (!isIndependentDatabaseApprovalKey(key) || window?.issue !== approval.issue || now >= approval.expiresAt ||
      staged.state !== 'available' || sha256(canonicalJson(staged.payload)) !== staged.content_hash) {
    throw new Error('deployment_recovery_not_admitted');
  }
  const release = validatePackage(staged.payload.release);
  requirePrivateImages(release);
  if (release.version !== approval.version || issueDate(release.version) !== approval.issue ||
      contentHash(release) !== approval.contentHash ||
      canonicalJson(packageCountries(release)) !== canonicalJson(approval.countries)) {
    throw new Error('deployment_recovery_package_mismatch');
  }

  const { authorizationId } = approval;
  const grant = {
    issue: approval.issue, version: approval.version, contentHash: approval.contentHash, countries: approval.countries,
    issuedBy: 'production-deployment', reason: 'Edition owner authorized the fixed reviewed package for draft-only backfill',
    approvedAt: new Date(now).toISOString(),
    expiresAt: new Date(Math.min(approval.expiresAt, window.closesAt, now + 60 * 60_000)).toISOString(),
  };
  const proof = { ...grant, signature: databaseApprovalSignature(key, authorizationId, grant) };
  const command = { authorizationId, release };
  return [
    { issue_date: approval.issue, country: 'global', kind: 'manual_authorization',
      record_key: DATABASE_APPROVAL_PREFIX + authorizationId, state: 'available',
      payload: proof, content_hash: sha256(canonicalJson(proof)) },
    ...approval.countries.map(country => ({
      issue_date: approval.issue, country, kind: 'manual_use', record_key: REQUEST_PREFIX + authorizationId,
      state: 'queued', payload: command, content_hash: sha256(canonicalJson(command)),
    })),
  ];
}

async function enqueueDeploymentRecovery(approval: DeploymentApproval, key: string, sb: ReturnType<typeof getSupabaseClient>) {
  const now = Date.now();
  if (now >= approval.expiresAt || reviewedDatabaseRecoveryWindow(now)?.issue !== approval.issue) return true;
  const { data, error } = await sb.from(TABLE).select('payload,content_hash,state').match({
    issue_date: approval.issue, country: 'global', kind: 'manual_use',
    record_key: 'deployment-reviewed/' + approval.authorizationId, state: 'available',
  }).maybeSingle();
  if (error) throw new Error('deployment_recovery_read_failed');
  if (!data) return false;
  const rows = deploymentRecoveryRows(approval, data, key, Date.now());
  const saved = await sb.from(TABLE).upsert(rows, {
    onConflict: 'issue_date,country,kind,record_key', ignoreDuplicates: true,
  });
  if (saved.error) throw new Error('deployment_recovery_queue_failed');
  return true;
}

export function verifyDatabaseDeliveryRequest(row: RequestRow, grant: GrantRow | null, key: string, now: number) {
  if (!isIndependentDatabaseApprovalKey(key)) throw new Error('invalid_manual_approval_key');
  const { authorizationId, release } = row.payload;
  if (typeof authorizationId !== 'string' || !AUTHORIZATION_ID.test(authorizationId)
      || row.record_key !== REQUEST_PREFIX + authorizationId
      || row.content_hash !== sha256(canonicalJson(row.payload))) throw new Error('invalid_delivery_request');

  let payload;
  try {
    payload = validatePackage(release);
    requirePrivateImages(payload);
    reviewedCountry(payload, row.country);
  } catch {
    throw new Error('invalid_reviewed_package');
  }
  const issue = issueDate(payload.version);
  const window = reviewedDatabaseRecoveryWindow(now);
  if (issue !== row.issue_date || issue !== window?.issue) {
    throw new Error('manual_issue_outside_window');
  }

  if (!grant || grant.state !== 'available' || grant.content_hash !== sha256(canonicalJson(grant.payload))) {
    throw new Error('manual_approval_missing');
  }
  const { signature, ...approval } = grant.payload;
  const countries = packageCountries(payload);
  const approvedAt = Date.parse(String(approval.approvedAt));
  const expiresAt = Date.parse(String(approval.expiresAt));
  if (typeof signature !== 'string' || !SHA256.test(signature)
      || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(databaseApprovalSignature(key, authorizationId, approval), 'hex'))
      || !Array.isArray(approval.countries) || approval.countries.length !== countries.length
      || approvedAt < window.opensAt || expiresAt > window.closesAt
      || !validManualGrant(approval, String(approval.approvedAt), issue, payload.version, contentHash(payload), countries, now)) {
    throw new Error('manual_approval_mismatch');
  }
  return { payload, authorizationId, expiresAt };
}

const wechat = { ...deliveryAdapters, find: findRecentReviewedDrafts };

type DraftProof = { media_id: string | null; detail: Record<string, unknown> };

async function verifyPreviousSuccess(payload: ReturnType<typeof validatePackage>, country: PackageCountry,
    existing: DraftProof, read: typeof wechat.read, checkLayout = false) {
  const expected = reviewedCountry(payload, country);
  const { imageUrls, expectedThumbMediaId, inputHash } = existing.detail;
  if (!existing.media_id || inputHash !== contentHash(expected.bodyHtml)
      || typeof expectedThumbMediaId !== 'string' || !expectedThumbMediaId
      || !Array.isArray(imageUrls) || !imageUrls.every(url => typeof url === 'string')) return null;
  const draft = await read(existing.media_id);
  const proof = summarizeDraftReadback(expected, draft, imageUrls, expectedThumbMediaId);
  const normalize = (value: { host: string; path: string } | null | undefined) => value &&
    value.host + (value.host.endsWith('.qpic.cn') ? value.path.replace(/\/(0|640)$/, '') : value.path);
  const imageMatch = proof.actualImageIdentities.length === proof.expectedImageIdentities.length
    && proof.actualImageIdentities.every((value, i) => value && normalize(value) === normalize(proof.expectedImageIdentities[i]));
  if (!proof.titleMatch || !proof.digestMatch || !proof.expectedTextMatch || !imageMatch || proof.thumbnailMatchesPrepared !== true) return null;
  const { layout, footer } = proof;
  if (checkLayout && !verifiedReviewedLayout(proof)) return null;
  return { ...existing.detail, mediaId: existing.media_id, verified: true, expectedTextMatch: true,
    imageMatch, thumbnailMatchesPrepared: true, readbackAt: new Date().toISOString(), readbackHash: contentHash(draft.content),
    ...(checkLayout ? { layoutVerified: true, layout, footer } : {}) };
}

type ValidationDraft = {
  startedAt: string;
  mediaId: string | null;
  detail: DraftProof['detail'];
};

// A signed, visibly marked acceptance copy has its own durable receipt on
// the exact approval command. The normal per-issue delivery lock stays intact.
export async function deliverValidationDraft(payload: ReturnType<typeof validatePackage>, country: PackageCountry,
    checkpoint: ValidationDraft | undefined, adapters: Pick<typeof wechat, 'prepare' | 'create' | 'read' | 'find'>,
    save: (draft: ValidationDraft) => Promise<void>, assertActive: () => void) {
  const expected = reviewedCountry(payload, country);
  if (!expected.title.startsWith('【实跑验收】')) throw new Error('invalid_validation_title');
  let draft = checkpoint;
  if (!draft) {
    assertActive();
    const prepared = await adapters.prepare(expected, async () => { assertActive(); });
    draft = { startedAt: new Date().toISOString(), mediaId: null, detail: {
      inputHash: contentHash(expected.bodyHtml), expectedThumbMediaId: prepared.article.thumb_media_id,
      imageUrls: imageUrls(prepared.html),
    } };
    // A lost response or process crash after this checkpoint can only reconcile.
    await save(draft);
    assertActive();
    draft = { ...draft, mediaId: await adapters.create(prepared.article) };
    await save(draft);
  }

  let { mediaId } = draft;
  if (!mediaId) {
    const since = Date.parse(draft.startedAt);
    if (!Number.isFinite(since)) throw new Error('invalid_validation_checkpoint');
    const matches = await adapters.find(expected.title, expected.summary, since - 120_000);
    if (matches.length !== 1) return null;
    [mediaId] = matches;
  }
  const verified = await verifyPreviousSuccess(payload, country, { media_id: mediaId, detail: draft.detail }, adapters.read, true);
  if (verified && mediaId !== draft.mediaId) await save({ ...draft, mediaId });
  return verified;
}

export async function reviseTextLayout(original: ReturnType<typeof validatePackage>, revised: ReturnType<typeof validatePackage>,
    country: PackageCountry, existing: DraftProof, adapters: Pick<typeof wechat, 'read' | 'update'>,
    writeStarted: boolean, recordWrite: () => Promise<void>, assertActive: () => void) {
  const before = reviewedCountry(original, country);
  const after = reviewedCountry(revised, country);
  const thumb = existing.detail.expectedThumbMediaId;
  const mediaId = existing.media_id;
  if (!mediaId || typeof thumb !== 'string' || !thumb || before.title !== after.title || before.summary !== after.summary ||
      imageUrls(before.bodyHtml).length || imageUrls(after.bodyHtml).length || !adapters.update) {
    throw new Error('invalid_reviewed_layout_revision');
  }
  if (!writeStarted) {
    if (!await verifyPreviousSuccess(original, country, existing, adapters.read)) throw new Error('invalid_layout_baseline');
    assertActive();
    await recordWrite();
    assertActive();
    await adapters.update(mediaId, { title: after.title, digest: after.summary, content: after.bodyHtml,
      author: '中亚动态–INVEST', thumb_media_id: thumb, content_source_url: '', need_open_comment: 0, only_fans_can_comment: 0 });
  }
  return verifyPreviousSuccess(revised, country, {
    media_id: mediaId, detail: { inputHash: contentHash(after.bodyHtml), expectedThumbMediaId: thumb, imageUrls: [] },
  }, adapters.read, true);
}

async function processRequest(sb: ReturnType<typeof getSupabaseClient>, row: RequestRow, key: string, adapters: typeof wechat) {
  const now = Date.now();
  const match = { issue_date: row.issue_date, country: row.country, kind: 'manual_use', record_key: row.record_key };
  const attempt = row.attempts + 1;
  if (attempt > MAX_ATTEMPTS) {
    const { error } = await sb.from(TABLE).update({ state: 'rejected', lease_until: null, updated_at: new Date(now).toISOString(),
      result: { ok: false, reason: 'delivery_attempts_exhausted', nextAction: 'check_delivery_receipt_before_retry' },
    }).match(match).eq('state', row.state).eq('attempts', row.attempts);
    if (error) throw new Error('manual_delivery_result_save_failed');
    return;
  }
  const claim = await sb.from(TABLE).update({ state: 'working', attempts: attempt, updated_at: new Date(now).toISOString(),
    lease_until: new Date(now + LEASE_MS).toISOString(),
  }).match(match).eq('state', row.state).eq('attempts', row.attempts).eq('content_hash', row.content_hash).select('attempts');
  if (claim.error) throw new Error('manual_delivery_claim_failed');
  if (claim.data?.length !== 1) return;

  let result: Record<string, unknown>;
  let layoutWriteStarted = row.result?.layoutWriteStarted === true;
  let validationDraft = row.result?.validationDraft as ValidationDraft | undefined;
  let state = 'rejected';
  try {
    const id = row.payload.authorizationId;
    let grant = null;
    if (typeof id === 'string' && AUTHORIZATION_ID.test(id)) {
      const read = await sb.from(TABLE).select('payload,content_hash,state')
        .match({ issue_date: row.issue_date, country: 'global', kind: 'manual_authorization', record_key: DATABASE_APPROVAL_PREFIX + id }).maybeSingle();
      if (read.error) throw new Error('manual_approval_read_failed');
      grant = read.data;
    }
    const { payload, authorizationId, expiresAt } = verifyDatabaseDeliveryRequest(row, grant, key, Date.now());
    const assertActive = () => {
      const stamp = Date.now();
      if (stamp >= expiresAt || reviewedDatabaseRecoveryWindow(stamp)?.issue !== row.issue_date) {
        throw new Error('manual_approval_expired');
      }
    };
    assertActive();
    const reviseLayout = authorizationId === NOV26_LAYOUT_APPROVAL.authorizationId;
    const validation = VALIDATION_DRAFT_APPROVALS.find(item => item.authorizationId === authorizationId);
    const validationCopy = Boolean(validation);
    if (reviseLayout && (payload.version !== NOV26_LAYOUT_APPROVAL.version || contentHash(payload) !== NOV26_LAYOUT_APPROVAL.contentHash)) {
      throw new Error('invalid_reviewed_layout_revision');
    }
    if (validation && (payload.version !== validation.version
        || contentHash(payload) !== validation.contentHash || now >= validation.expiresAt)) {
      throw new Error('invalid_validation_package');
    }
    const { hash } = await storeReviewedPackage(payload, sb);
    const receiptVersion = reviseLayout ? NOV26_DEPLOYMENT_APPROVAL.version : payload.version;
    const saved = await sb.from('reviewed_deliveries').select('state,media_id,detail')
      .match({ version: receiptVersion, country: row.country }).maybeSingle();
    if (saved.error) throw new Error('reviewed_receipt_read_failed');
    const existing = saved.data;
    let receipt: Record<string, unknown> | null;
    if (validationCopy) {
      receipt = await deliverValidationDraft(payload, row.country, validationDraft, adapters, async draft => {
        const kept = await sb.from(TABLE).update({ result: { validationDraft: draft } }).match(match)
          .eq('state', 'working').eq('attempts', attempt).eq('content_hash', row.content_hash).select('country');
        if (kept.error || kept.data?.length !== 1) throw new Error('manual_validation_checkpoint_failed');
        validationDraft = draft;
      }, assertActive);
    } else if (reviseLayout) {
      const base = await sb.from('reviewed_packages').select('payload,content_hash').eq('version', receiptVersion).single();
      if (base.error || base.data?.content_hash !== NOV26_DEPLOYMENT_APPROVAL.contentHash || existing?.state !== 'succeeded') {
        throw new Error('invalid_layout_baseline');
      }
      const original = validatePackage(base.data.payload);
      if (contentHash(original) !== base.data.content_hash) throw new Error('invalid_layout_baseline');
      receipt = await reviseTextLayout(original, payload, row.country, existing, adapters, layoutWriteStarted, async () => {
        const recorded = await sb.from(TABLE).update({ result: { layoutWriteStarted: true } }).match(match)
          .eq('state', 'working').eq('attempts', attempt).eq('content_hash', row.content_hash).select('country');
        if (recorded.error || recorded.data?.length !== 1) throw new Error('layout_write_checkpoint_failed');
        layoutWriteStarted = true;
      }, assertActive);
    } else {
      receipt = existing?.state === 'succeeded'
        ? await verifyPreviousSuccess(payload, row.country, existing, adapters.read)
        : await reconcileKnownReviewedDraft(payload, row.country, sb, adapters.read, adapters.find);
    }
    if (!validationCopy && !reviseLayout && !receipt && !existing?.media_id && (!existing || ['preparing', 'failed'].includes(existing.state))) {
      assertActive();
      const delivery = await deliverReviewedPackage(payload, sb, { ...adapters, update: undefined,
        prepare(draft, progress) {
          assertActive();
          return adapters.prepare(draft, async () => {
            assertActive();
            await progress?.();
            assertActive();
          });
        },
        beforeWrite: assertActive,
        create(article) {
          assertActive();
          return adapters.create(article);
        },
      }, [row.country]);
      receipt = delivery.drafts[0] as Record<string, unknown> | undefined ?? null;
    }
    const mediaId = receipt?.mediaId ?? receipt?.media_id;
    // Exact display text covers the source labels. WeChat can omit link targets on readback.
    const ok = typeof mediaId === 'string' && !!mediaId && receipt?.verified === true
      && receipt.expectedTextMatch === true && receipt.imageMatch === true && receipt.thumbnailMatchesPrepared === true;
    state = ok ? 'accepted' : attempt < MAX_ATTEMPTS ? 'working' : 'rejected';
    result = { ok, authorizationId, version: payload.version, contentHash: hash,
      ...(ok ? { mediaId, readbackAt: receipt?.readbackAt ?? null, readbackHash: receipt?.readbackHash ?? null,
        title: reviewedCountry(payload, row.country).title, verified: true, expectedTextMatch: receipt?.expectedTextMatch,
        imageMatch: receipt?.imageMatch, coverMatch: receipt?.thumbnailMatchesPrepared, sourceUrlsVisible: receipt?.sourceUrlsVisible,
        ...(reviseLayout || validationCopy ? { layoutVerified: receipt?.layoutVerified } : {}) }
        : { reason: 'delivery_not_verified', nextAction: 'check_delivery_receipt_before_retry' }) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    const permanent = /^(invalid_|manual_approval_missing$|manual_approval_mismatch$|manual_approval_expired$|manual_issue_outside_window$)/.test(reason)
      || reason === REVIEWED_VERSION_CONFLICT;
    state = permanent || attempt >= MAX_ATTEMPTS ? 'rejected' : 'working';
    result = { ok: false, reason: reason === REVIEWED_VERSION_CONFLICT ? 'reviewed_version_conflict' :
      /^[a-z][a-z0-9_]{0,80}$/.test(reason) ? reason : 'manual_delivery_failed' };
  }
  const saved = await sb.from(TABLE).update({ state, result: { ...result, ...(layoutWriteStarted ? { layoutWriteStarted: true } : {}),
    ...(validationDraft ? { validationDraft } : {}) }, updated_at: new Date().toISOString(),
    ...(state === 'working' ? {} : { lease_until: null }),
  }).match(match).eq('state', 'working').eq('attempts', attempt).eq('content_hash', row.content_hash);
  if (saved.error) throw new Error('manual_delivery_result_save_failed');
}

export async function processDatabaseDeliveries(key: string, sb = getSupabaseClient(), adapters = wechat) {
  const timestamp = Date.now();
  const now = new Date(timestamp).toISOString();
  const window = reviewedDatabaseRecoveryWindow(timestamp);
  if (!isIndependentDatabaseApprovalKey(key) || !window) return;
  const { data, error } = await sb.from(TABLE)
    .select('issue_date,country,record_key,state,attempts,payload,content_hash,result')
    .eq('kind', 'manual_use').like('record_key', `${REQUEST_PREFIX}%`)
    .eq('issue_date', window.issue)
    .or(`state.eq.queued,and(state.eq.working,lease_until.lt.${now})`)
    .order('created_at').limit(5);
  if (error) throw new Error('manual_delivery_queue_read_failed');
  for (const row of (data ?? []) as RequestRow[]) {
    if (reviewedDatabaseRecoveryWindow()?.issue !== window.issue) return;
    try { await processRequest(sb, row, key, adapters); }
    catch { console.warn(JSON.stringify({ event: 'manual_delivery_checkpoint_failed', issue: row.issue_date, country: row.country })); }
  }
}

// This worker is inactive during normal production and only consumes
// exact-issue, signed requests in the current recovery window.
let started = false;
export function startReviewedDatabaseRecovery() {
  if (started) return;
  started = true;
  const key = process.env.REVIEWED_DATABASE_APPROVAL_KEY || '';
  const registered = isIndependentDatabaseApprovalKey(key);
  let statusIssue = '';
  let running = false;
  const pendingDeployments = new Set<DeploymentApproval>([
    NOV26_DEPLOYMENT_APPROVAL, NOV26_LAYOUT_APPROVAL, ...VALIDATION_DRAFT_APPROVALS, ...NOV27_DRAFT_APPROVALS,
  ]);
  const tick = () => {
    const window = reviewedDatabaseRecoveryWindow();
    if (running || !window) return;
    running = true;
    void (async () => {
      const sb = getSupabaseClient();
      if (statusIssue !== window.issue) {
        const payload = { worker: WORKER_VERSION, keyPresent: !!key, independentKey: registered, registered,
          expiresAt: new Date(window.closesAt).toISOString() };
        const { error } = await sb.from(TABLE).upsert({
          issue_date: window.issue, country: 'global', kind: 'manual_use', record_key: `db-recovery-status/${window.issue}`,
          payload, content_hash: sha256(canonicalJson(payload)), state: 'available', updated_at: new Date().toISOString(),
        }, { onConflict: 'issue_date,country,kind,record_key' });
        if (error) console.warn('manual_recovery_registration_failed');
        else statusIssue = window.issue;
      }
      if (registered) {
        for (const approval of pendingDeployments) {
          try { if (await enqueueDeploymentRecovery(approval, key, sb)) pendingDeployments.delete(approval); }
          catch { console.warn('deployment_recovery_not_queued'); }
        }
        await processDatabaseDeliveries(key, sb);
        const {processFreshRun}=await import('./plan-b-fresh-run');
        await processFreshRun(sb);
      }
    })().catch(() => console.warn('manual_delivery_queue_unavailable')).finally(() => { running = false; });
  };
  cron.schedule('*/5 * * * *', tick, { timezone: 'Asia/Shanghai' });
  tick();
}
