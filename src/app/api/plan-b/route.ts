import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { changes, idPattern, isCountry, type PlanBCountry } from '@/lib/plan-b-handoff';
import { verifyEditorial } from '@/lib/plan-b-editorial';
import { getState, saveEditorial, stagingIsPrivate, type SnapshotReceipt, type StateRow } from '@/lib/plan-b-store';
import { archiveEditorial, runCloudScript, sourceOriginals } from '@/lib/plan-b-worker';
import { planBAdmitted, planBClock, planBHandlesIssue, planBIngestSecret } from '@/lib/plan-b-window';
import { PLAN_B_RUNTIME_VERSION, planBRegistration } from '@/lib/plan-b-runtime';
import { getCountryWord, type WordReceipt } from '@/lib/plan-b-release';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) => NextResponse.json(value, {
  status, headers: { 'Cache-Control': 'private, no-store' },
});

function authorized(req: Request) {
  const secret = Buffer.from(planBIngestSecret());
  const supplied = Buffer.from(req.headers.get('x-ingest-secret') || '');
  return secret.length > 0 && secret.length === supplied.length && timingSafeEqual(secret, supplied);
}

function admitted(req: Request) {
  if (!authorized(req)) return json({ ok: false, reason: 'unauthorized' }, 401);
  if (!planBAdmitted()) return json({ ok: false, reason: 'plan_b_disabled' }, 404);
}

function receipt(rows: StateRow[], country: PlanBCountry, phase: 'preview' | 'final') {
  const row = rows.find(row => row.country === country && row.state === 'ready' && row.step === phase);
  return row?.receipt as SnapshotReceipt | undefined;
}

function report(rows: StateRow[]) {
  return rows.map(({ country, step, state, attempt, receipt: value, updated_at }) => {
    const result = { country, step, state, attempt, updatedAt: updated_at };
    if (step === 'preview' || step === 'final') return { ...result, metrics: value?.metrics, reason: value?.reason,
      hash: (value as SnapshotReceipt | null)?.snapshot?.hash,
      candidateCount: (value as SnapshotReceipt | null)?.snapshot?.candidates.length };
    return { ...result, receipt: value };
  });
}

export async function GET(req: Request) {
  const { searchParams: params } = new URL(req.url);
  const clock = planBClock();
  if (params.get('health') === '1') {
    if (!authorized(req)) return json({ ok: false, reason: 'unauthorized' }, 401);
    if (!planBAdmitted() && process.env.REVIEWED_PLAN_B_CHECKS !== '1') {
      return json({ ok: false, reason: 'plan_b_disabled' }, 404);
    }
    let prerequisites;
    if (params.get('verify') === '1') {
      const [table, bucket, renderer] = await Promise.allSettled([getState(clock.issue), stagingIsPrivate(),
        runCloudScript('cloud_release.py', ['--help'], 15_000)]);
      prerequisites = { table: table.status === 'fulfilled', privateBucket: bucket.status === 'fulfilled' && bucket.value,
        renderer: renderer.status === 'fulfilled' };
    }
    const verified = !prerequisites || Object.values(prerequisites).every(Boolean);
    return json({ ok: verified, runtime: PLAN_B_RUNTIME_VERSION, commit: process.env.BUILD_GIT_SHA || null,
      registration: planBRegistration(), clock, aiApiUsed: false, prerequisites }, verified ? 200 : 503);
  }
  const denied = admitted(req);
  if (denied) return denied;
  const issue = params.get('issue') || clock.issue;
  const view = params.get('view') || 'manifest';
  const archiveView = view === 'word' || view === 'status';
  const archiveAge = (Date.parse(clock.issue) - Date.parse(issue)) / 86_400_000;
  if (!planBHandlesIssue(issue) || (!archiveView && issue !== clock.issue) || !Number.isInteger(archiveAge)
        || archiveAge < 0 || archiveAge > 7) return json({ ok: false, reason: 'issue_outside_cutover' }, 409);
  try {
    if (view === 'status') return json({ ok: true, issue, rows: report(await getState(issue)) });
    const country = params.get('country') || '';
    if (!isCountry(country)) return json({ ok: false, reason: 'invalid_country' }, 400);
    const rows = await getState(issue, country);
    if (view === 'word') {
      const word = rows.find(row => row.country === country && row.step === 'word' && row.state === 'ready');
      if (!word?.receipt) return json({ ok: true, state: 'waiting', issue, country }, 202);
      return json({ ok: true, state: 'ready', issue, country, url: await getCountryWord(word.receipt as WordReceipt),
        sha256: (word.receipt as WordReceipt).document.sha256 });
    }
    const preview = receipt(rows, country, 'preview');
    const frozen = receipt(rows, country, 'final');
    const final = params.get('phase') === 'final';
    const selected = final ? frozen : preview;
    if (!selected) {
      const waiting = rows.find(row => row.country === country && row.step === (final ? 'final' : 'preview'));
      return json({ ok: true, issue, country, state: waiting?.state === 'blocked' ? 'blocked' : 'waiting',
        observed: false, pending: waiting?.receipt?.pendingSources ?? [], phase: final ? 'final' : 'preview',
        clock, availablePreviewHash: preview?.snapshot.hash || null }, waiting?.state === 'blocked' ? 409 : 202);
    }
    if (view === 'manifest') return json({ ok: true, state: 'ready', snapshot: selected.snapshot, metrics: selected.metrics });
    if (view === 'changes' && final && frozen) {
      return json({ ok: true, state: 'ready', issue, country, delta: changes(preview?.snapshot || null, frozen.snapshot),
        frozenIds: frozen.snapshot.candidates.map(candidate => candidate.id) });
    }
    if (view === 'originals') {
      const ids = (params.get('ids') || '').split(',');
      if (params.get('hash') !== selected.snapshot.hash) return json({ ok: false, reason: 'snapshot_changed' }, 409);
      const allowed = new Set(selected.snapshot.candidates.map(entry => entry.id));
      if (ids.length > 5 || new Set(ids).size !== ids.length || ids.some(id => !idPattern.test(id) || !allowed.has(id))) {
        return json({ ok: false, reason: 'original_selection_invalid' }, 400);
      }
      return json({ ok: true, snapshotHash: selected.snapshot.hash, originals: await sourceOriginals(selected, ids) });
    }
    return json({ ok: false, reason: 'unknown_view' }, 400);
  } catch {
    return json({ ok: false, reason: 'plan_b_read_unavailable' }, 503);
  }
}

async function boundedJson(req: Request) {
  const limit = 2 * 1024 * 1024;
  if (Number(req.headers.get('content-length')) > limit || !req.body) throw new Error('invalid_body');
  const stream = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await stream.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await stream.cancel();
      throw new Error('invalid_body');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function POST(req: Request) {
  const denied = admitted(req);
  if (denied) return denied;
  const clock = planBClock();
  const { searchParams: params } = new URL(req.url);
  const issue = params.get('issue') || '';
  const country = params.get('country') || '';
  if (!isCountry(country) || !clock.finalizationAllowed || issue !== clock.issue) {
    return json({ ok: false, reason: 'handoff_outside_production_window' }, 409);
  }
  let value: unknown;
  try { value = await boundedJson(req); } catch { return json({ ok: false, reason: 'invalid_body' }, 400); }
  try {
    const rows = await getState(issue, country);
    const frozen = receipt(rows, country, 'final');
    if (!frozen) return json({ ok: false, reason: 'freeze_incomplete' }, 409);
    let editorial;
    try { editorial = verifyEditorial(value, frozen.snapshot); }
    catch (e) { return json({ ok: false, reason: (e as Error).message }, 409); }
    const { value: content, ...evidence } = editorial;
    const existing = rows.find(row => row.country === country && row.step === 'editorial');
    if (existing) return existing.receipt?.editorialHash === evidence.editorialHash
      ? json({ ok: true, state: 'duplicate', issue, country, ...evidence })
      : json({ ok: false, reason: 'signed_revision_conflict' }, 409);
    if (!planBClock().finalizationAllowed) return json({ ok: false, reason: 'handoff_outside_production_window' }, 409);
    const archived = await archiveEditorial(issue, country, content);
    const accepted = await saveEditorial(issue, country, { ...evidence, archived,
      acceptedAt: new Date().toISOString(), actualModel: null, actualReasoning: null, actualSpeed: null, actualCredits: null });
    return json({ ok: true, state: accepted, issue, country, ...evidence });
  } catch (e) {
    return (e as Error).message === 'signed_revision_conflict'
      ? json({ ok: false, reason: 'signed_revision_conflict' }, 409)
      : json({ ok: false, reason: 'handoff_storage_unavailable' }, 503);
  }
}
