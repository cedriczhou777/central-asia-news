import { createHmac, timingSafeEqual } from 'node:crypto';
import { getSupabaseClient } from '../storage/database/supabase-client';
import { canonicalJson, sha256 } from './plan-b-handoff';
import { PLAN_B_CLOCK, planBClock, planBHandlesIssue } from './plan-b-window';
import { deliverReviewedPackage, deliveryAdapters, reconcileKnownReviewedDraft } from './reviewed-delivery';
import { validManualGrant } from './reviewed-manual-authorization';
import { contentHash, issueDate, packageCountries, requirePrivateImages, reviewedCountry, validatePackage, type PackageCountry } from './reviewed-package';
import { REVIEWED_VERSION_CONFLICT, storeReviewedPackage } from './reviewed-package-store';
import { findRecentReviewedDrafts } from './reviewed-wechat';

const TABLE = 'plan_b_exchange';
const REQUEST_PREFIX = 'db-delivery/';
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const AUTHORIZATION_ID = /^[A-Za-z0-9_-]{16,96}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type GrantRow = { payload: Record<string, unknown>; content_hash: string; state: string };
type RequestRow = GrantRow & {
  issue_date: string; country: PackageCountry; record_key: string; attempts: number;
};

// The signing key belongs to the approving operator and the cloud worker.
// A database row or SQL session alone cannot authorize a draft write.
export function databaseApprovalSignature(key: string, id: string, approval: Record<string, unknown>) {
  return createHmac('sha256', key).update(canonicalJson({ scope: 'reviewed-database-delivery-v1', id, approval })).digest('hex');
}

export function verifyDatabaseDeliveryRequest(row: RequestRow, grant: GrantRow | null, key: string, now: number) {
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
  const clock = planBClock(now);
  if (issue !== row.issue_date || !planBHandlesIssue(issue) || issue > clock.issue
      || (issue === clock.issue && clock.minute < PLAN_B_CLOCK.closeAt)) throw new Error('manual_issue_outside_window');

  if (!grant || grant.state !== 'available' || grant.content_hash !== sha256(canonicalJson(grant.payload))) {
    throw new Error('manual_approval_missing');
  }
  const { signature, ...approval } = grant.payload;
  const countries = packageCountries(payload);
  if (typeof signature !== 'string' || !SHA256.test(signature)
      || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(databaseApprovalSignature(key, authorizationId, approval), 'hex'))
      || !Array.isArray(approval.countries) || approval.countries.length !== countries.length
      || !validManualGrant(approval, String(approval.approvedAt), issue, payload.version, contentHash(payload), countries, now)) {
    throw new Error('manual_approval_mismatch');
  }
  return { payload, authorizationId, expiresAt: Date.parse(String(approval.expiresAt)) };
}

const wechat = { ...deliveryAdapters, find: findRecentReviewedDrafts };

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
        .match({ issue_date: row.issue_date, country: 'global', kind: 'manual_authorization', record_key: id }).maybeSingle();
      if (read.error) throw new Error('manual_approval_read_failed');
      grant = read.data;
    }
    const { payload, authorizationId, expiresAt } = verifyDatabaseDeliveryRequest(row, grant, key, Date.now());
    const { hash } = await storeReviewedPackage(payload, sb);
    const reconciled = await reconcileKnownReviewedDraft(payload, row.country, sb, adapters.read, adapters.find);
    const proof = reconciled ?? (await deliverReviewedPackage(payload, sb, { ...adapters, update: undefined,
      beforeWrite() {
        if (Date.now() >= expiresAt) throw new Error('manual_approval_expired');
      },
    }, [row.country])).drafts.map(d => d as Record<string, unknown>)[0];
    const receipt = proof as Record<string, unknown> | undefined;
    const mediaId = receipt?.mediaId ?? receipt?.media_id;
    const ok = typeof mediaId === 'string' && !!mediaId && receipt?.verified === true;
    state = ok ? 'accepted' : attempt < MAX_ATTEMPTS ? 'working' : 'rejected';
    result = { ok, authorizationId, version: payload.version, contentHash: hash,
      ...(ok ? { mediaId, readbackAt: receipt?.readbackAt ?? null, readbackHash: receipt?.readbackHash ?? null }
        : { reason: 'delivery_not_verified', nextAction: 'check_delivery_receipt_before_retry' }) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    const permanent = /^(invalid_|manual_approval_missing$|manual_approval_mismatch$|manual_issue_outside_window$)/.test(reason)
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
  const { issue, minute } = planBClock(timestamp);
  const firstIssue = process.env.REVIEWED_PLAN_B_FIRST_ISSUE;
  if (!firstIssue || !/^[0-9a-f]{64}$/.test(key)) return;
  const { data, error } = await sb.from(TABLE)
    .select('issue_date,country,record_key,state,attempts,payload,content_hash')
    .eq('kind', 'manual_use').like('record_key', `${REQUEST_PREFIX}%`)
    .gte('issue_date', firstIssue)
    [minute < PLAN_B_CLOCK.closeAt ? 'lt' : 'lte']('issue_date', issue)
    .or(`state.eq.queued,and(state.eq.working,lease_until.lt.${now})`)
    .order('created_at').limit(5);
  if (error) throw new Error('manual_delivery_queue_read_failed');
  for (const row of (data ?? []) as RequestRow[]) {
    try { await processRequest(sb, row, key, adapters); }
    catch { console.warn(JSON.stringify({ event: 'manual_delivery_checkpoint_failed', issue: row.issue_date, country: row.country })); }
  }
}
