import { createHmac, timingSafeEqual } from 'node:crypto';
import cron from 'node-cron';
import { getSupabaseClient } from '../storage/database/supabase-client';
import { canonicalJson, sha256 } from './plan-b-handoff';
import { PLAN_B_CLOCK, planBClock, planBHandlesIssue, planBIngestSecret } from './plan-b-window';
import { deliverReviewedPackage, deliveryAdapters, reconcileKnownReviewedDraft } from './reviewed-delivery';
import { validManualGrant } from './reviewed-manual-authorization';
import { contentHash, issueDate, packageCountries, requirePrivateImages, reviewedCountry, validatePackage, type PackageCountry } from './reviewed-package';
import { REVIEWED_VERSION_CONFLICT, storeReviewedPackage } from './reviewed-package-store';
import { findRecentReviewedDrafts } from './reviewed-wechat';
import { summarizeDraftReadback } from './reviewed-diagnostics';

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

type GrantRow = { payload: Record<string, unknown>; content_hash: string; state: string };
type RequestRow = GrantRow & {
  issue_date: string; country: PackageCountry; record_key: string; attempts: number;
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

async function verifyPreviousSuccess(payload: ReturnType<typeof validatePackage>, country: PackageCountry,
    existing: { media_id: string | null; detail: Record<string, unknown> }, read: typeof wechat.read) {
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
  return { ...existing.detail, mediaId: existing.media_id, verified: true, expectedTextMatch: true,
    imageMatch, thumbnailMatchesPrepared: true, readbackAt: new Date().toISOString(), readbackHash: contentHash(draft.content) };
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
    const { hash } = await storeReviewedPackage(payload, sb);
    const saved = await sb.from('reviewed_deliveries').select('state,media_id,detail')
      .match({ version: payload.version, country: row.country }).maybeSingle();
    if (saved.error) throw new Error('reviewed_receipt_read_failed');
    const existing = saved.data;
    let receipt: Record<string, unknown> | null = existing?.state === 'succeeded'
      ? await verifyPreviousSuccess(payload, row.country, existing, adapters.read)
      : await reconcileKnownReviewedDraft(payload, row.country, sb, adapters.read, adapters.find);
    if (!receipt && !existing?.media_id && (!existing || ['preparing', 'failed'].includes(existing.state))) {
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
    const ok = typeof mediaId === 'string' && !!mediaId && receipt?.verified === true
      && receipt.imageMatch === true && receipt.thumbnailMatchesPrepared === true && receipt.sourceUrlsVisible === true;
    state = ok ? 'accepted' : attempt < MAX_ATTEMPTS ? 'working' : 'rejected';
    result = { ok, authorizationId, version: payload.version, contentHash: hash,
      ...(ok ? { mediaId, readbackAt: receipt?.readbackAt ?? null, readbackHash: receipt?.readbackHash ?? null,
        title: reviewedCountry(payload, row.country).title, verified: true, expectedTextMatch: receipt?.expectedTextMatch,
        imageMatch: receipt?.imageMatch, coverMatch: receipt?.thumbnailMatchesPrepared, sourceUrlsVisible: receipt?.sourceUrlsVisible }
        : { reason: 'delivery_not_verified', nextAction: 'check_delivery_receipt_before_retry' }) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    const permanent = /^(invalid_|manual_approval_missing$|manual_approval_mismatch$|manual_approval_expired$|manual_issue_outside_window$)/.test(reason)
      || reason === REVIEWED_VERSION_CONFLICT;
    state = permanent || attempt >= MAX_ATTEMPTS ? 'rejected' : 'working';
    result = { ok: false, reason: reason === REVIEWED_VERSION_CONFLICT ? 'reviewed_version_conflict' :
      /^[a-z][a-z0-9_]{0,80}$/.test(reason) ? reason : 'manual_delivery_failed' };
  }
  const saved = await sb.from(TABLE).update({ state, result, updated_at: new Date().toISOString(),
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
    .select('issue_date,country,record_key,state,attempts,payload,content_hash')
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
      if (registered) await processDatabaseDeliveries(key, sb);
    })().catch(() => console.warn('manual_delivery_queue_unavailable')).finally(() => { running = false; });
  };
  cron.schedule('*/5 * * * *', tick, { timezone: 'Asia/Shanghai' });
  tick();
}
