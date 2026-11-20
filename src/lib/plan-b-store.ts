import { randomUUID } from 'node:crypto';
import { getSupabaseClient, getSupabaseServiceRoleKey } from '../storage/database/supabase-client';
import type { PlanBCountry, Snapshot } from './plan-b-handoff';
import { sha256 } from './plan-b-handoff';

const TABLE = 'plan_b_daily';
const BUCKET = 'plan-b-work';
export type Step = 'preview' | 'final' | 'editorial' | 'release' | 'word' | 'wechat' | 'readback';
export type ClaimStep = Exclude<Step, 'editorial'>;

export type StateRow = {
  issue_date: string; country: PlanBCountry; step: Step;
  state: 'working' | 'retry' | 'blocked' | 'ready';
  attempt: number; receipt: Record<string, unknown> | null; updated_at: string; lease_until: string | null; retry_after: string | null;
};
export type ObjectReceipt = { path: string; sha256: string; bytes: number };
export type SnapshotReceipt = { snapshot: Snapshot; cache: ObjectReceipt; metrics: Record<string, unknown> };

function client() {
  if (!getSupabaseServiceRoleKey()) throw new Error('plan_b_service_role_missing');
  return getSupabaseClient();
}

export async function stagingIsPrivate() {
  const { data, error } = await client().storage.getBucket(BUCKET);
  return !error && data?.public === false;
}

export async function getState(issue: string): Promise<StateRow[]> {
  const { data, error } = await client().from(TABLE).select('issue_date,country,step,state,attempt,receipt,updated_at,lease_until,retry_after').eq('issue_date', issue);
  if (error) throw new Error('plan_b_state_read_failed');
  return (data ?? []) as StateRow[];
}

export async function claim(issue: string, country: PlanBCountry, step: ClaimStep) {
  const lease = randomUUID();
  const { data, error } = await client().rpc('claim_plan_b_step', {
    target_issue: issue, target_country: country, target_step: step, owner: lease,
  });
  if (error || typeof data !== 'boolean') throw new Error('plan_b_claim_failed');
  return data ? lease : null;
}

export async function saveClaim(issue: string, country: PlanBCountry, step: ClaimStep, lease: string,
    state: 'ready' | 'retry' | 'blocked', receipt: object, delayMs = 0) {
  const { data, error } = await client().from(TABLE).update({ state, receipt, lease_id: null, lease_until: null,
    updated_at: new Date().toISOString(), retry_after: delayMs ? new Date(Date.now() + delayMs).toISOString() : null,
  }).eq('issue_date', issue).eq('country', country).eq('step', step).eq('state', 'working')
    .eq('lease_id', lease).gt('lease_until', new Date().toISOString()).select('step');
  if (error || data?.length !== 1) throw new Error('plan_b_claim_lost');
}

export async function saveEditorial(issue: string, country: PlanBCountry, receipt: Record<string, unknown>) {
  const { error } = await client().from(TABLE).insert({ issue_date: issue, country, step: 'editorial', state: 'ready', receipt });
  if (!error) return 'accepted';
  if (error.code !== '23505') throw new Error('plan_b_editorial_save_failed');
  const { data, error: readError } = await client().from(TABLE).select('receipt').eq('issue_date', issue)
    .eq('country', country).eq('step', 'editorial').single();
  if (readError) throw new Error('plan_b_editorial_read_failed');
  if (data?.receipt?.editorialHash !== receipt.editorialHash) throw new Error('signed_revision_conflict');
  return 'duplicate';
}

export async function knownLiveReceipts(issue: string) {
  const { data, error } = await client().from('reviewed_deliveries').select('version,country').like('version', `${issue}-r10%`)
    .in('state', ['uncertain', 'sending', 'updating', 'succeeded']);
  if (error) throw new Error('plan_b_known_receipt_query_failed');
  return (data ?? []) as {version: string; country: PlanBCountry}[];
}

export async function saveObject(issue: string, country: PlanBCountry, suffix: 'gz' | 'docx', bytes: Buffer): Promise<ObjectReceipt> {
  if (!bytes.length || bytes.length > 40 * 1024 * 1024) throw new Error('plan_b_object_size');
  const hash = sha256(bytes);
  const path = `${issue}/${country}/${hash}.${suffix}`;
  const { error } = await client().storage.from(BUCKET).upload(path, bytes, { upsert: false,
    contentType: suffix === 'gz' ? 'application/gzip' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const receipt = { path, sha256: hash, bytes: bytes.length };
  if (error) {
    // Retry only the read on an unknown upload result. The object is content-addressed.
    await readObject(receipt);
  }
  return receipt;
}

export async function readObject(receipt: ObjectReceipt) {
  const { data, error } = await client().storage.from(BUCKET).download(receipt.path);
  if (error || !data || data.size !== receipt.bytes || data.size > 40 * 1024 * 1024) throw new Error('plan_b_object_unavailable');
  const bytes = Buffer.from(await data.arrayBuffer());
  if (sha256(bytes) !== receipt.sha256) throw new Error('plan_b_object_hash_mismatch');
  return bytes;
}

export async function wordLink(receipt: ObjectReceipt) {
  const { data, error } = await client().storage.from(BUCKET).createSignedUrl(receipt.path, 60 * 60 * 24);
  if (error || !data?.signedUrl) throw new Error('plan_b_word_link_unavailable');
  return data.signedUrl;
}
