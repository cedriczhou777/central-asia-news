import { canonicalJson, sha256, shaPattern } from './plan-b-handoff';
import type { ObjectReceipt, SnapshotReceipt, StateRow } from './plan-b-store';

export type WorkCheckpoint = { snapshotHash: string; checkpointHash: string; stage: 'draft' | 'review';
  archived: ObjectReceipt; savedAt: string };

export function checkpointInput(value: unknown, rows: StateRow[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_checkpoint');
  const body = value as Record<string, unknown>;
  if (typeof body.snapshotHash !== 'string' || !shaPattern.test(body.snapshotHash)
      || !['draft','review'].includes(String(body.stage)) || !body.document || typeof body.document !== 'object'
      || Array.isArray(body.document) || body.checkpointHash !== sha256(canonicalJson(body.document))) {
    throw new Error('invalid_checkpoint');
  }
  const row = rows.find(r => r.state !== 'working' && (r.step === 'preview' || r.step === 'final')
    && (r.receipt as SnapshotReceipt | null)?.snapshot?.hash === body.snapshotHash);
  if (!row) throw new Error('checkpoint_source_changed');
  const previous=row.receipt?.workCheckpoint as WorkCheckpoint|undefined;
  if (previous && (previous.checkpointHash!==body.checkpointHash || previous.stage!==body.stage)
      && body.baseCheckpointHash!==previous.checkpointHash) throw new Error('checkpoint_conflict');
  return { row, document:body.document as Record<string, unknown>, snapshotHash:body.snapshotHash,
    checkpointHash:body.checkpointHash as string, stage:body.stage as WorkCheckpoint['stage'] };
}

export function latestWorkCheckpoint(rows: StateRow[]) {
  return rows.filter(r => (r.step === 'preview' || r.step === 'final') && r.receipt?.workCheckpoint)
    .map(r => ({ row:r, checkpoint:r.receipt!.workCheckpoint as WorkCheckpoint }))
    .filter(({checkpoint}) => shaPattern.test(checkpoint.snapshotHash) && shaPattern.test(checkpoint.checkpointHash))
    .sort((a,b) => Date.parse(b.checkpoint.savedAt) - Date.parse(a.checkpoint.savedAt))[0];
}
