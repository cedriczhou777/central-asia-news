import { freezeBlockReason, PLAN_B_COUNTRIES, shaPattern } from './plan-b-handoff';
import { planBPackageVersion } from './plan-b-release';
import type { SnapshotReceipt, StateRow } from './plan-b-store';
import { issueWindow, PLAN_B_CLOCK } from './plan-b-window';

export const PLAN_B_BUSINESS_VERSION = 'plan-b-business-1';

// Status is a progress envelope, not the source/coverage archive. Real crawls
// can contain thousands of deferred URLs; repeating them here exceeded the
// protected Work client's 4 MiB limit and prevented checkpoint continuation.
// Keep exact counts and block states. Full evidence remains in manifest/cache.
export function planBProgressRows(rows: StateRow[]) {
  return rows.map(({country,step,state,attempt,receipt:value,updated_at,lease_until,retry_after}) => {
    const result = {country,step,state,attempt,updatedAt:updated_at,leaseUntil:lease_until,retryAfter:retry_after};
    if (step !== 'preview' && step !== 'final') return {...result,receipt:value};
    const saved = value as SnapshotReceipt | null;
    const coverage = saved?.snapshot?.coverage;
    const metrics = saved?.metrics ?? {};
    return {...result,reason:value?.reason,hash:saved?.snapshot?.hash,
      candidateCount:saved?.snapshot?.candidates?.length ?? 0,
      workCheckpoint:value?.workCheckpoint ?? null,
      metrics:{registeredSources:metrics.registeredSources,listingQueueRemaining:metrics.listingQueueRemaining,
        articleQueueRemaining:metrics.articleQueueRemaining,rawLeadsQueued:metrics.rawLeadsQueued,
        elapsedSeconds:metrics.elapsedSeconds},
      coverage:coverage ? {version:coverage.version,state:coverage.state,windowEnd:coverage.windowEnd,
        observedAt:coverage.observedAt,queues:coverage.queues,
        pendingWorkCount:coverage.pendingWork.length,reviewWorkCount:coverage.reviewWork?.length ?? 0,
        gapCount:coverage.gaps.length,readableSourceCount:coverage.readableSources.length,
        detailsComplete:false,detailsView:'manifest'} : undefined};
  });
}

// A platform execution result is deliberately absent from this contract.
// Only durable, scoped source/signature/document/live-readback evidence counts.
export function planBBusinessStatus(issue: string, rows: StateRow[], now = Date.now()) {
  const window = issueWindow(issue);
  const minute = (now - (window.end - 6 * 60 * 60_000)) / 60_000;
  const countries = PLAN_B_COUNTRIES.map(country => {
    const row = (step: StateRow['step']) => rows.find(r => r.issue_date === issue && r.country === country && r.step === step);
    const ready = (step: StateRow['step']) => {
      const found = row(step);
      return found?.state === 'ready' ? found.receipt : null;
    };
    const final = ready('final') as SnapshotReceipt | null;
    let candidatesReady = false;
    try {
      candidatesReady = !!final && final.snapshot.issue === issue && final.snapshot.country === country
        && final.snapshot.candidates.length > 0 && shaPattern.test(final.snapshot.hash) && !freezeBlockReason(final.snapshot);
    } catch { /* Incomplete evidence remains unfinished. */ }
    const editorial = ready('editorial');
    const signed = !!editorial && typeof editorial.editorialHash === 'string' && shaPattern.test(editorial.editorialHash)
      && typeof editorial.writerRun === 'string' && typeof editorial.reviewerRun === 'string'
      && !!editorial.writerRun && !!editorial.reviewerRun && editorial.writerRun !== editorial.reviewerRun;
    const release = ready('release');
    const version = planBPackageVersion(issue, country);
    const prepared = release?.prepared as { sha256?: string } | undefined;
    const releaseReady = release?.version === version && release.editorialHash === editorial?.editorialHash
      && typeof prepared?.sha256 === 'string' && shaPattern.test(prepared.sha256);
    const word = ready('word');
    const document = word?.document as { path?: string; sha256?: string; bytes?: number } | undefined;
    const wordReady = word?.version === version && !!document && typeof document.sha256 === 'string'
      && shaPattern.test(document.sha256) && document.path === `${issue}/${country}/${document.sha256}.docx`
      && Number.isSafeInteger(document.bytes) && Number(document.bytes) > 0;
    const verifiedDraft = (step: 'wechat' | 'readback') => {
      const value = ready(step);
      const media = value?.media_id || value?.mediaId;
      return value?.version === version && value.verified === true && typeof media === 'string' && !!media.trim();
    };
    const wechatReady = verifiedDraft('wechat') || verifiedDraft('readback');
    const draft = verifiedDraft('readback') ? ready('readback') : verifiedDraft('wechat') ? ready('wechat') : null;
    const missing = [!candidatesReady && 'candidates', !signed && 'signed_review',
      !releaseReady && 'release', !wordReady && 'word', !wechatReady && 'wechat_readback'].filter(Boolean) as string[];
    const checkpoints = rows.filter(r => r.country === country && r.issue_date === issue && r.receipt?.workCheckpoint)
      .map(r => r.receipt!.workCheckpoint as { savedAt?: string; stage?: string; checkpointHash?: string })
      .sort((a,b) => Date.parse(b.savedAt || '') - Date.parse(a.savedAt || ''));
    return { country, candidatesReady, candidateCount: final?.snapshot?.candidates?.length ?? 0,
      frozenHash: final?.snapshot?.hash ?? null, signed, articleCount: editorial?.articleCount ?? null,
      coverageState: release?.coverageState ?? final?.snapshot?.coverage?.state ?? null,
      quantityState: release?.quantityState ?? null, wordReady, wechatReady, missing,
      mediaId:draft?.media_id || draft?.mediaId || null,
      workCheckpoint: checkpoints[0] ?? null,
      blockedSteps: rows.filter(r => r.country === country && r.state === 'blocked')
        .map(r => ({ step:r.step, reason:r.receipt?.reason ?? null })),
    };
  });
  const mediaIds = countries.map(c => c.mediaId).filter(Boolean);
  for (const country of countries) {
    if (country.mediaId && mediaIds.filter(id => id === country.mediaId).length > 1) {
      country.wechatReady = false;
      country.missing.push('duplicate_media_id');
    }
  }
  const pending = countries.filter(c => c.missing.length);
  const complete = pending.length === 0;
  const overdue = !complete && minute >= PLAN_B_CLOCK.targetAt;
  return { version:PLAN_B_BUSINESS_VERSION, issue, observedAt:new Date(now).toISOString(),
    businessSucceeded:complete, state:complete ? 'complete' : overdue ? 'incomplete' : rows.length ? 'running' : 'waiting',
    normalQuantityReady:countries.every(c => typeof c.articleCount === 'number' && c.articleCount >= 15 && c.articleCount <= 20),
    countries, remainingCountries:pending.map(c => c.country),
    alert:overdue ? { code:minute >= PLAN_B_CLOCK.deadlineAt ? 'delivery_deadline_missed' : 'delivery_target_missed',
      severity:minute >= PLAN_B_CLOCK.deadlineAt ? 'error' : 'warning',
      countries:pending.map(c => ({ country:c.country, missing:c.missing })), modelApiUsed:false } : null,
  };
}
