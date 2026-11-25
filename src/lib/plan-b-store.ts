import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getSupabaseClient, getSupabaseServiceRoleKey } from '../storage/database/supabase-client';
import type { PlanBCountry, Snapshot } from './plan-b-handoff';
import { sha256 } from './plan-b-handoff';
import type { WorkCheckpoint } from './plan-b-checkpoint';
import { contentHash, reviewedCountry, validatePackage, type PackageCountry } from './reviewed-package';
import type { VerifiedWechatDraft } from './reviewed-wechat';

const TABLE = 'plan_b_daily';
const BUCKET = 'plan-b-work';
const OBJECT_LIMIT = 40 * 1024 * 1024;
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

export async function getState(issue: string, country?: PlanBCountry): Promise<StateRow[]> {
  const query = client().from(TABLE).select('issue_date,country,step,state,attempt,receipt,updated_at,lease_until,retry_after').eq('issue_date', issue);
  const { data, error } = await (country ? query.eq('country', country) : query);
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
  // Checkpoint writes are forbidden while working. Read the pointer after
  // claiming, so a checkpoint saved just before the lease cannot be overwritten
  // by the scheduler's earlier in-memory row.
  const current=await client().from(TABLE).select('workCheckpoint:receipt->workCheckpoint')
    .eq('issue_date',issue).eq('country',country).eq('step',step).eq('state','working').eq('lease_id',lease).maybeSingle();
  if(current.error)throw new Error('plan_b_checkpoint_pointer_read_failed');
  const checkpoint=(current.data as {workCheckpoint?:WorkCheckpoint}|null)?.workCheckpoint;
  const kept=checkpoint?{...receipt,workCheckpoint:checkpoint}:receipt;
  const { data, error } = await client().from(TABLE).update({ state, receipt:kept, lease_id: null, lease_until: null,
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

export async function saveWorkCheckpoint(row: StateRow, checkpoint: WorkCheckpoint) {
  // Preserve the immutable snapshot/cache and use the row version as a lease.
  // A partial manuscript never creates an editorial approval or a delivery row.
  const { data, error } = await client().from(TABLE).update({
    receipt:{ ...row.receipt, workCheckpoint:checkpoint }, updated_at:checkpoint.savedAt,
  }).eq('issue_date', row.issue_date).eq('country', row.country).eq('step', row.step)
    .eq('state', row.state).eq('updated_at', row.updated_at).select('step');
  if (error || data?.length !== 1) throw new Error('checkpoint_conflict');
}

export async function verifiedDraftReferences(issue: string): Promise<VerifiedWechatDraft[]> {
  const sb=client();
  const receipts=()=>sb.from('reviewed_deliveries').select('version,country,media_id,detail')
    .eq('state','succeeded').contains('detail',{verified:true}).not('media_id','is',null)
    .lt('version',issue).order('updated_at',{ascending:false}).limit(5);
  const preferred=issue<='2026-11-26' ? await receipts().like('version','2026-11-23%') : null;
  if (preferred?.error) throw new Error('plan_b_verified_draft_read_failed');
  const result=preferred?.data?.length ? preferred : await receipts();
  if (result.error) throw new Error('plan_b_verified_draft_read_failed');
  const rows=result.data??[];
  if (!rows.length) return [];
  const saved=await sb.from('reviewed_packages').select('version,payload,content_hash').in('version',[...new Set(rows.map(row=>row.version))]);
  if (saved.error) throw new Error('plan_b_verified_package_read_failed');
  const packages=new Map((saved.data??[]).map(row=>[row.version,row]));
  return rows.flatMap(row=>{
    if (typeof row.media_id!=='string' || !row.media_id || !/^[a-f0-9]{64}$/.test(row.detail?.readbackHash ?? '')) return [];
    const saved=packages.get(row.version);
    if (!saved) return [];
    const payload=validatePackage(saved.payload);
    if (payload.version!==row.version || contentHash(payload)!==saved.content_hash) return [];
    const draft=reviewedCountry(payload,row.country as PackageCountry);
    if (contentHash(draft.bodyHtml)!==row.detail.inputHash) return [];
    return [{mediaId:row.media_id,version:payload.version,country:row.country,title:draft.title,summary:draft.summary,readbackHash:row.detail.readbackHash}];
  });
}

export async function knownLiveReceipts(issue: string) {
  const { data, error } = await client().from('reviewed_deliveries').select('version,country').like('version', `${issue}-r10%`)
    .in('state', ['uncertain', 'sending', 'updating', 'succeeded']);
  if (error) throw new Error('plan_b_known_receipt_query_failed');
  return (data ?? []) as {version: string; country: PlanBCountry}[];
}

async function uploadObject(issue: string, country: PlanBCountry, suffix: 'gz' | 'docx', hash: string,
    bytes: number, body: Buffer | ReturnType<typeof createReadStream>): Promise<ObjectReceipt> {
  const path = `${issue}/${country}/${hash}.${suffix}`;
  const { error } = await client().storage.from(BUCKET).upload(path, body, { upsert: false, duplex: 'half',
    contentType: suffix === 'gz' ? 'application/gzip' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const receipt = { path, sha256: hash, bytes };
  // An unknown upload result is settled by an exact read, never an overwrite.
  if (error) await verifyObject(receipt);
  return receipt;
}

export async function saveObject(issue: string, country: PlanBCountry, suffix: 'gz', bytes: Buffer) {
  if (!bytes.length || bytes.length > OBJECT_LIMIT) throw new Error('plan_b_object_size');
  return uploadObject(issue, country, suffix, sha256(bytes), bytes.length, bytes);
}

export async function saveFile(issue: string, country: PlanBCountry, suffix: 'gz' | 'docx', filename: string) {
  const { size } = await stat(filename);
  if (!size || size > OBJECT_LIMIT) throw new Error('plan_b_object_size');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  const stream = createReadStream(filename);
  try { return await uploadObject(issue, country, suffix, hash.digest('hex'), size, stream); }
  finally { stream.destroy(); }
}

export async function verifyObject(receipt: ObjectReceipt, filename?: string) {
  if (!Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1 || receipt.bytes > OBJECT_LIMIT) {
    throw new Error('plan_b_object_size');
  }
  const { data, error } = await client().storage.from(BUCKET).download(receipt.path).asStream();
  if (error || !data) throw new Error('plan_b_object_unavailable');
  const hash = createHash('sha256');
  const body = Readable.fromWeb(data as Parameters<typeof Readable.fromWeb>[0]);
  async function* verify(chunks: AsyncIterable<Buffer>) {
    let bytes = 0;
    for await (const chunk of chunks) {
      bytes += chunk.length;
      if (bytes > receipt.bytes) throw new Error('plan_b_object_size');
      hash.update(chunk);
      yield chunk;
    }
    if (bytes !== receipt.bytes || hash.digest('hex') !== receipt.sha256) throw new Error('plan_b_object_hash_mismatch');
  }
  await pipeline(body, verify, filename ? createWriteStream(filename, { flags:'wx', mode:0o600 })
    : new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
}

export async function wordLink(receipt: ObjectReceipt) {
  const { data, error } = await client().storage.from(BUCKET).createSignedUrl(receipt.path, 60 * 60 * 24);
  if (error || !data?.signedUrl) throw new Error('plan_b_word_link_unavailable');
  return data.signedUrl;
}
