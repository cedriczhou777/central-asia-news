import { createHash } from 'node:crypto';
import { issueWindow } from './plan-b-window';

export const PLAN_B_COUNTRIES = ['kz', 'uz', 'kg', 'tj', 'az'] as const;
export type PlanBCountry = typeof PLAN_B_COUNTRIES[number];
export type Phase = 'preview' | 'final';

export interface Candidate {
  id: string;
  revision: string;
  title: string;
  sourceUrl: string;
  sourceHash: string;
  publishedAt: string | null;
  timeEvidence?: string;
  needsTimeReview: boolean;
}

export interface Snapshot {
  issue: string;
  country: PlanBCountry;
  phase: Phase;
  observedAt: string;
  provisional: boolean;
  pendingSources: string[];
  candidates: Candidate[];
  hash: string;
}

export const idPattern = /^[A-Za-z0-9_-]{1,96}$/;
export const shaPattern = /^[0-9a-f]{64}$/;
export const isCountry = (name: string): name is PlanBCountry => PLAN_B_COUNTRIES.some(code => code === name);

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return '{' + Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function timestamp(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !/(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error('invalid_timestamp');
  return parsed;
}

function canonicalCandidate(entry: Candidate, start: number, end: number, observation: number) {
  if (!idPattern.test(entry.id) || !shaPattern.test(entry.revision) || !shaPattern.test(entry.sourceHash)) {
    throw new Error('invalid_candidate_evidence');
  }
  const url = new URL(entry.sourceUrl);
  if (url.protocol !== 'https:' || url.username || url.password || !entry.title.trim()) throw new Error('invalid_candidate');
  if (entry.publishedAt !== null && !entry.needsTimeReview) {
    const at = timestamp(entry.publishedAt);
    if (at < start || at >= end || at > observation) return null;
  }
  return entry;
}

export function snapshot(input: Omit<Snapshot, 'hash' | 'provisional'>): Snapshot {
  const window = issueWindow(input.issue);
  const observation = timestamp(input.observedAt);
  if (!isCountry(input.country) || !['preview', 'final'].includes(input.phase)) throw new Error('invalid_snapshot_scope');
  if (input.phase === 'preview' ? observation >= window.end : observation < window.end) throw new Error('wrong_observation_phase');
  const indexed = new Map<string, Candidate>();
  for (const item of input.candidates) {
    const entry = canonicalCandidate(item, window.start, window.end, observation);
    if (!entry) continue;
    const earlier = indexed.get(entry.id);
    if (earlier && canonicalJson(earlier) !== canonicalJson(entry)) throw new Error('ambiguous_candidate_identity');
    indexed.set(entry.id, entry);
  }
  const value = { ...input, provisional: input.phase === 'preview',
    candidates: [...indexed.values()].sort((a,b) => a.id.localeCompare(b.id)),
    pendingSources: [...new Set(input.pendingSources)].sort() };
  return { ...value, hash: sha256(canonicalJson(value)) };
}

export function changes(before: Snapshot | null, after: Snapshot) {
  if (after.phase !== 'final' || (before && (before.phase !== 'preview' || before.issue !== after.issue || before.country !== after.country))) {
    throw new Error('snapshot_scope_mismatch');
  }
  const preview = new Map(before?.candidates.map(entry => [entry.id, entry]));
  const final = new Set(after.candidates.map(entry => entry.id));
  return {
    previewHash: before?.hash ?? null,
    finalHash: after.hash,
    added: after.candidates.filter(c => !preview.has(c.id)),
    changed: after.candidates.filter(c => preview.has(c.id) && preview.get(c.id)?.revision !== c.revision),
    retained: after.candidates.filter(c => preview.get(c.id)?.revision === c.revision).map(c => c.id),
    removed: [...preview.keys()].filter(id => !final.has(id)),
    pendingSources: after.pendingSources,
  };
}

export function requireFrozenVersion(state: Snapshot | null, hash: string, inspected: string[], selected: string[]) {
  if (state?.phase !== 'final' || state.provisional || state.pendingSources.length) throw new Error('freeze_incomplete');
  if (state.hash !== hash) throw new Error('frozen_revision_mismatch');
  const current = new Set(state.candidates.map(c => c.id));
  if (inspected.length !== current.size || new Set(inspected).size !== current.size || inspected.some(id => !current.has(id))) {
    throw new Error('frozen_candidate_ack_incomplete');
  }
  if (!selected.length || selected.length > 20 || new Set(selected).size !== selected.length || selected.some(id => !current.has(id))) {
    throw new Error('selection_outside_frozen_snapshot');
  }
}

export function retryableStatus(status: number | null) {
  if (status === 429) return 'rate_limited';
  if (status === null || [500, 502, 503, 504].includes(status)) return 'transient';
  return 'stop';
}
