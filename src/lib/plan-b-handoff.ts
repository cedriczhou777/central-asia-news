import { createHash } from 'node:crypto';
import { issueWindow } from './plan-b-window';

export const PLAN_B_COUNTRIES = ['kz', 'uz', 'kg', 'tj', 'az'] as const;
export type PlanBCountry = typeof PLAN_B_COUNTRIES[number];
export type Phase = 'preview' | 'final';
export const COVERAGE_VERSION = 'plan-b-coverage-2';
export const SHORT_EDITION_FIRST_ISSUE = '2026-11-26';
export const EDITORIAL_POLICY_FIRST_ISSUE = '2026-11-27';
export const EDITORIAL_POLICY_VERSION = 'plan-b-editorial-2';
export const DAILY_TARGET_ARTICLES = 15;
export const DAILY_MIN_ARTICLES = 6;

export interface SourceCoverage {
  version: string;
  country: PlanBCountry;
  windowEnd: string;
  observedAt: string;
  state: 'blocked' | 'review_required' | 'observed';
  readableSources: string[];
  gaps: { sourceId: string; reason: string; evidence: {
    url: string; status: number | null; error?: string | null; observedAt: string;
    retryBudgetExhausted: boolean; transportAttemptsTotal?: number | null;
    failureType?: string; contentValidated?: boolean;
  }[] }[];
  pendingWork: { sourceId: string; kind: string; url: string | null; reason: string }[];
  reviewWork: { sourceId: string; kind: string; url: string | null; reason: string;
    count?: number; queueHash?: string; examples?: string[] }[];
  queues: { listing: number; article: number; lead: number };
  closedQueueWork: { sourceId: string; kind: string; url: string; reason: string }[];
  queueAccounting?: Record<'listing' | 'article' | 'lead', {
    total:number; pending:number; review:number; closed:number; identityHash:string;
  }>;
  deferredCandidates?: {id:string;sourceId:string;sourceUrl:string;sourceHash:string;sourceJSONSha256:string}[];
}

export interface Candidate {
  id: string;
  revision: string;
  title: string;
  sourceUrl: string;
  sourceHash: string;
  publishedAt: string | null;
  timeEvidence?: string;
  publicationOptions?: { url:string; publishedAt:string; evidenceSha256:string }[];
  languageVersions?: {candidateIds:string[]; preferredId:string; differingNumbers:boolean;
    versions: {candidateId:string;language:string|null;url:string;title:string;publishedAt:string|null}[]}[];
  needsTimeReview: boolean;
  previousDay?: true;
  photoCandidates?: number;
  eventHints?: { candidateId:string; kind:'same_text'|'similar_title'; score:number }[];
  sourceId?: string;
  family?: string;
}

export interface Snapshot {
  issue: string;
  country: PlanBCountry;
  phase: Phase;
  observedAt: string;
  provisional: boolean;
  pendingSources: string[];
  coverage: SourceCoverage;
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
  if (entry.previousDay === true) return null;
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
    coverage: after.coverage,
  };
}

export function freezeBlockReason(state: Snapshot | null) {
  if (state?.phase !== 'final' || state.provisional) return 'freeze_incomplete';
  const coverage = state.coverage;
  if (!coverage || coverage.version !== COVERAGE_VERSION || coverage.country !== state.country
      || Date.parse(coverage.windowEnd) !== issueWindow(state.issue).end
      || Date.parse(coverage.observedAt) !== Date.parse(state.observedAt)) return 'coverage_evidence_invalid';
  if (state.pendingSources.length || coverage.pendingWork.length || coverage.state === 'blocked') return 'freeze_incomplete';
  for (const kind of ['listing','article','lead'] as const) {
    const counts=coverage.queueAccounting?.[kind];
    const reviewed=coverage.reviewWork.filter(row=>row.kind===kind).reduce((n,row)=>n+(row.count ?? 1),0);
    const closed=coverage.closedQueueWork.filter(row=>row.kind===kind).length;
    if (!counts || ![counts.total,counts.pending,counts.review,counts.closed].every(n=>Number.isSafeInteger(n)&&n>=0)
        || !shaPattern.test(counts.identityHash) || counts.total!==coverage.queues[kind] || counts.pending!==0
        || counts.review!==reviewed || counts.closed!==closed || counts.total!==reviewed+closed) return 'coverage_evidence_invalid';
  }
  if (coverage.reviewWork.some(row=>!Number.isSafeInteger(row.count ?? 1) || (row.count ?? 1)<1
      || !row.queueHash || !shaPattern.test(row.queueHash))) return 'coverage_evidence_invalid';
  if (coverage.reviewWork.some(row => !coverage.gaps.some(gap => gap.sourceId === row.sourceId))) return 'coverage_evidence_invalid';
  if (coverage.gaps.length && coverage.state !== 'review_required'
      || !coverage.gaps.length && coverage.state !== 'observed') return 'coverage_evidence_invalid';
  return null;
}

export function requireFrozenVersion(state: Snapshot | null, hash: string, inspected: string[], selected: string[]) {
  const blocked = freezeBlockReason(state);
  if (blocked || !state) throw new Error(blocked || 'freeze_incomplete');
  if (state.hash !== hash) throw new Error('frozen_revision_mismatch');
  const current = new Set(state.candidates.map(c => c.id));
  if (inspected.length !== current.size || new Set(inspected).size !== current.size || inspected.some(id => !current.has(id))) {
    throw new Error('frozen_candidate_ack_incomplete');
  }
  if (!selected.length || selected.length > 20 || new Set(selected).size !== selected.length || selected.some(id => !current.has(id))) {
    throw new Error('selection_outside_frozen_snapshot');
  }
}

/** The inventory may include originals whose publication time still needs review. */
export function reviewableWindowCount(state: Snapshot) {
  const window = issueWindow(state.issue);
  const confirmed = state.candidates.filter(candidate => {
    if (candidate.needsTimeReview || !candidate.publishedAt || !/(?:Z|[+-]\d\d:\d\d)$/.test(candidate.publishedAt)) return false;
    const published = Date.parse(candidate.publishedAt);
    return published >= window.start && published < window.end;
  });
  return state.issue >= EDITORIAL_POLICY_FIRST_ISSUE
    ? new Set(confirmed.map(candidate => candidate.sourceHash)).size : confirmed.length;
}

export function retryableStatus(status: number | null) {
  if (status === 429) return 'rate_limited';
  if (status === null || [500, 502, 503, 504].includes(status)) return 'transient';
  return 'stop';
}
