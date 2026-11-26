import cron from 'node-cron';
import { randomUUID } from 'node:crypto';
import { DAILY_MIN_ARTICLES, DAILY_TARGET_ARTICLES, EDITORIAL_POLICY_FIRST_ISSUE, EDITORIAL_POLICY_VERSION, freezeBlockReason, PLAN_B_COUNTRIES,
  retryableStatus, reviewableWindowCount, SHORT_EDITION_FIRST_ISSUE, type PlanBCountry } from './plan-b-handoff';
import { PLAN_B_CLOCK, planBAdmitted, planBClock, planBHandlesIssue } from './plan-b-window';
import { claim, getState, knownLiveReceipts, saveClaim, stagingIsPrivate, type ClaimStep, type SnapshotReceipt, type StateRow } from './plan-b-store';
import { collectCountry, runCloudScript } from './plan-b-worker';
import { deliverCountryWechat, planBPackageVersion, prepareCountryRelease, reconcileCountryWechat, renderCountryWord } from './plan-b-release';
import { planBBusinessStatus } from './plan-b-status';
import {processExchange,publishExchangeHealth,SOURCE_EVIDENCE_VERSION} from './plan-b-exchange';
import { privateImageHealth } from './reviewed-private-images';
import { checkCurrentWechatDrafts, cloudPrerequisitesReady, createCloudPrerequisiteCheck,
  createRuntimeChecks, type ReadinessPhase } from './plan-b-runtime-checks';

export const PLAN_B_RUNTIME_VERSION = 'plan-b-handoff-6-database-exchange';
const stateKey = Symbol.for('central-asia-news.plan-b.runtime');
type RuntimeState = {
  active: Map<string, ClaimStep>; registered: boolean; reading: boolean;
  report: Record<string, unknown> | null; previewSettled: string; completedIssue: string; emitted: Set<string>;
};
const shared = globalThis as typeof globalThis & { [key: symbol]: RuntimeState | undefined };
const runtime = shared[stateKey] ??= { active: new Map(), registered:false, reading:false,
  report:null, previewSettled:'', completedIssue:'', emitted:new Set() };
const { active, emitted } = runtime;
const workerLimit = { preview: 2, final: 2, release: 2, word: 1, wechat: 2, readback: 2 };
const cpuSteps = new Set<ClaimStep>(['preview','final','release','word']);

function runtimeHealth() {
  return {runtime:PLAN_B_RUNTIME_VERSION,commit:process.env.BUILD_GIT_SHA||null,
    activation:{enabled:process.env.REVIEWED_PLAN_B==='1',admitted:planBAdmitted(),
      checksEnabled:process.env.REVIEWED_PLAN_B_CHECKS==='1',firstIssue:process.env.REVIEWED_PLAN_B_FIRST_ISSUE||null},
    registration:{registered:runtime.registered},sourceEvidenceVersion:SOURCE_EVIDENCE_VERSION,
    editorialPolicy:{version:EDITORIAL_POLICY_VERSION,fromIssue:EDITORIAL_POLICY_FIRST_ISSUE,
      targetMin:DAILY_TARGET_ARTICLES,targetMax:20,reviewedShortfallMin:8,minimumFallback:DAILY_MIN_ARTICLES}};
}

const bootId=randomUUID();
const cloudPrerequisites=createCloudPrerequisiteCheck(()=>
  Promise.allSettled([stagingIsPrivate(),privateImageHealth(),runCloudScript('cloud_release.py',['--help'],15_000)])
    .then(([staging,images,word])=>({stagingPrivate:staging.status==='fulfilled'&&staging.value,
      imagesPrivate:images.status==='fulfilled'&&images.value.ready&&images.value.private,wordRenderer:word.status==='fulfilled'})));

const requestReadiness=createRuntimeChecks(async attempt=>{
  const {issue}=attempt;
  const [base,wechat]=await Promise.all([cloudPrerequisites(issue),
    checkCurrentWechatDrafts().catch(()=>({ready:false,transportReady:false,emptyDraftBox:false,
      getStatus:'not_checked' as const,stage:'probe_unavailable'}))]);
  const payload={...runtimeHealth(),attempt:{...attempt,finishedAt:new Date().toISOString()},
    prerequisites:{...base,wechat}};
  try {
    await publishExchangeHealth(issue,payload,`runtime_checks/${bootId}/${attempt.attempt}`);
    await publishExchangeHealth(issue,payload,'runtime_checks');
    if (!cloudPrerequisitesReady(base) || !wechat.transportReady) return 'failed';
    return wechat.getStatus==='missing_test_object' ? 'missing_test_object' : wechat.ready ? 'passed' : 'failed';
  } catch {
    console.warn(JSON.stringify({event:'plan_b_runtime_checks_unavailable',issue,attempt:attempt.attempt}));
    return 'failed';
  }
});

function checkRuntime(issue:string,phase:Exclude<ReadinessPhase,'retry'>) {
  if (process.env.REVIEWED_PLAN_B_CHECKS==='1') return requestReadiness(issue,phase);
}

export function planBRegistration() {
  return { registered:runtime.registered, activeSteps: active.size, report:runtime.report };
}

export function eligible(row: StateRow | undefined, now: number, step?: ClaimStep) {
  const recovery=step==='final' && !!row && row.issue_date>='2026-11-23';
  return !row || (row.attempt < (recovery?3:2) && (
    row.state === 'retry' && Date.parse(row.retry_after || '') <= now
    || row.state === 'working' && Date.parse(row.lease_until || '') <= now
    || recovery && row.state==='blocked' && row.receipt?.reason==='freeze_incomplete' && !!row.receipt.cache
  ));
}

type Outcome = { state: 'ready' | 'retry' | 'blocked'; receipt: object; delay?: number };
const ready = (receipt: object): Outcome => ({ state: 'ready', receipt });

export function finalCoverageOutcome(receipt: SnapshotReceipt, attempt: number): Outcome {
  const shortEditionsAllowed = receipt.snapshot.issue >= SHORT_EDITION_FIRST_ISSUE;
  const reviewableCandidates = shortEditionsAllowed ? reviewableWindowCount(receipt.snapshot) : receipt.snapshot.candidates.length;
  const shortage = reviewableCandidates < (shortEditionsAllowed ? 1 : 10);
  const dailyPolicy = receipt.snapshot.issue >= EDITORIAL_POLICY_FIRST_ISSUE;
  const belowTarget = dailyPolicy && reviewableCandidates < DAILY_TARGET_ARTICLES;
  const belowMinimum = dailyPolicy && reviewableCandidates < DAILY_MIN_ARTICLES;
  const reason = freezeBlockReason(receipt.snapshot) || (shortage ? 'insufficient_reviewable_candidates'
    : (belowTarget && attempt === 0) || (belowMinimum && attempt === 1) ? 'candidate_supply_below_target' : null);
  const limit=receipt.snapshot.issue>='2026-11-23'?3:2;
  const coverageRecovery = shortage || reason === 'candidate_supply_below_target';
  return reason ? { state: attempt+1<limit ? 'retry' : 'blocked', delay:120_000,
    receipt:{ ...receipt, pendingSources:receipt.snapshot.pendingSources, coverage:receipt.snapshot.coverage, reason, reviewableCandidates,
      inventoryCandidates:receipt.snapshot.candidates.length,
      recovery:attempt+1<limit ? {mode:coverageRecovery?'fresh_candidate_refresh':attempt>=1?'focused_source_refresh':'bounded_retry',remainingAttempts:limit-attempt-1}
        : {mode:coverageRecovery?'candidate_supply_shortfall':'important_evidence_required',automaticAttemptsExhausted:true,checkpointsPreserved:true} } }
    : ready(dailyPolicy ? { ...receipt, reviewableCandidates, supplyBelowTarget: belowTarget } : receipt);
}

export function recoverySources(coverage: SnapshotReceipt['snapshot']['coverage'] | undefined) {
  const pending = coverage?.pendingWork ?? [];
  const sources = new Map<string, { bodies: Set<string>; leads: Set<string> }>();
  for (const work of pending) {
    if (work.sourceId === 'discovery') continue;
    const source = sources.get(work.sourceId) ?? { bodies: new Set<string>(), leads: new Set<string>() };
    sources.set(work.sourceId, source);
    if (work.kind === 'article' && work.url) source.bodies.add(work.url);
    if (work.kind === 'lead' && work.url) source.leads.add(work.url);
  }
  // The final pass has two slots. Use actual article identities to choose
  // those slots, independent of the coverage report's publisher-name sort.
  return [...sources].sort(([, a], [, b]) => b.bodies.size - a.bodies.size || b.leads.size - a.leads.size)
    .slice(0, 2).map(([id]) => id);
}

function boundedFailure(error: unknown, nextAttempt: number, step: ClaimStep): Outcome {
  const message = error instanceof Error ? error.message : '';
  const http = message.match(/(?:HTTP|错误码|status)[ :]*(\d{3})/i)?.[1];
  const status = http ? Number(http) : /timeout|network|temporar|unavailable|ECONN|exchange_publish_failed|超时|连接/i.test(message) ? null : 400;
  const category = retryableStatus(status);
  const reason = /^[a-z][a-z0-9_]{0,80}$/.test(message) ? message : category === 'stop' ? 'operation_failed' : category;
  return { state: nextAttempt < 2 && category !== 'stop' ? 'retry' : 'blocked',
    receipt: { reason, httpStatus: status === 400 && !http ? null : status, stage: step }, delay: category === 'rate_limited' ? 120_000 : 30_000 };
}

function schedule(issue: string, country: PlanBCountry, step: ClaimStep, row: StateRow | undefined,
    perform: () => Promise<Outcome>) {
  const key = `${issue}/${country}/${step}`;
  if (!eligible(row, Date.now(), step) || active.has(key)) return;
  const lane = step === 'preview' ? 'final' : step;
  const current = [...active.values()];
  if (current.filter(value => (value === 'preview' ? 'final' : value) === lane).length >= workerLimit[lane]) return;
  if (cpuSteps.has(step) && current.filter(value => cpuSteps.has(value)).length >= 2) return;
  active.set(key, step);
  void (async () => {
    const lease = await claim(issue, country, step);
    if (!lease) return;
    const start = Date.now();
    let result: Outcome;
    try { result = await perform(); }
    catch (error) {
      result = boundedFailure(error, (row?.attempt || 0) + 1, step);
      // A failed retry must never erase the last useful snapshot/cache or Work
      // checkpoint. The row remains blocked/retry, never falsely approved.
      const saved=(error as {snapshotReceipt?:SnapshotReceipt})?.snapshotReceipt;
      result.receipt={...row?.receipt,...saved,...result.receipt,lastUsefulProgressAt:
        (row?.receipt?.snapshot as {observedAt?:string}|undefined)?.observedAt ?? row?.updated_at ?? null};
    }
    await saveClaim(issue, country, step, lease, result.state, { ...result.receipt,
      elapsedMs: Date.now() - start }, result.delay);
  })().catch(() => {
    console.warn(JSON.stringify({ event: 'plan_b_checkpoint_failed', issue, country, step }));
  }).finally(() => active.delete(key));
}

async function tick() {
  const clock = planBClock();
  const inboxOpen = planBHandlesIssue(clock.issue) && clock.minute >= PLAN_B_CLOCK.workAt && clock.minute < PLAN_B_CLOCK.deadlineAt;
  if (runtime.reading || !(clock.previewAllowed || clock.reconcileAllowed || inboxOpen)) return;
  if (runtime.completedIssue === clock.issue || (clock.previewAllowed && clock.minute<330 && runtime.previewSettled === clock.issue)
      || (!inboxOpen && !clock.finalizationAllowed && !clock.previewAllowed && clock.minute % 5 !== 0)) return;
  runtime.reading = true;
  try {
    const issue = clock.issue;
    if (clock.previewAllowed || clock.reconcileAllowed) void checkRuntime(issue,'collection');
    if (inboxOpen) {
      try { await processExchange(issue,undefined,()=>{ void checkRuntime(issue,'before_signoff'); }); }
      catch { console.warn(JSON.stringify({event:'plan_b_exchange_inbox_unavailable',issue})); }
    }
    // Collection stops at 05:50. Work can still save checkpoints until the 06:00 freeze.
    if (!clock.previewAllowed && !clock.reconcileAllowed) return;
    const rows = await getState(issue);
    const complete = (country: PlanBCountry, steps: string[]) =>
      rows.some(row => row.country === country && steps.includes(row.step) && row.state === 'ready');
    const scope = PLAN_B_COUNTRIES.map(country => ({ country, preview: complete(country, ['preview']),
      editorial: complete(country, ['editorial']), word: complete(country, ['word']),
      wechat: complete(country, ['wechat','readback']) }));
    if (clock.previewAllowed && scope.every(item => item.preview)) {
      runtime.previewSettled = issue;
      return;
    }
    const business = planBBusinessStatus(issue, rows);
    runtime.report = business;
    await publishExchangeHealth(issue,{...runtimeHealth(),business})
      .catch(()=>console.warn(JSON.stringify({event:'plan_b_exchange_health_unavailable',issue})));
    if (business.businessSucceeded) {
      runtime.completedIssue = issue;
      console.info(JSON.stringify({ event: 'plan_b_delivered', ...business }));
      return;
    }
    // A late/restarted container also reports missed delivery; exact-minute
    // checks alone would silently miss the same failure as a late Work run.
    if (business.alert) {
      const key = `${issue}/undelivered/${Math.floor(clock.minute / 5)}`;
      if (!emitted.has(key)) {
        emitted.add(key);
        for (const previous of emitted) if (!previous.startsWith(issue + '/')) emitted.delete(previous);
        console.warn(JSON.stringify({ event:'plan_b_undelivered', ...business }));
      }
    }
    if ([450,470,480,540].includes(clock.minute)) {
      const key = `${issue}/${clock.minute}`;
      if (!emitted.has(key)) {
        emitted.add(key);
        for (const previous of emitted) if (!previous.startsWith(issue + '/')) emitted.delete(previous);
        console.warn(JSON.stringify({ event: 'plan_b_delivery_checkpoint', issue, minute: clock.minute, countries: scope }));
      }
    }
    const known = clock.reconcileAllowed
      && (!clock.finalizationAllowed || rows.some(r => r.step === 'wechat' && r.receipt?.pendingReadback === true))
      ? await knownLiveReceipts(issue) : [];
    for (const country of PLAN_B_COUNTRIES) {
      const state = (step: ClaimStep | 'editorial') => rows.find(row => row.country === country && row.step === step);
      const preview = state('preview');
      if (clock.previewAllowed) {
        const saved=preview?.receipt?.cache as SnapshotReceipt['cache']|undefined;
        schedule(issue, country, 'preview', preview, async () => ready(await collectCountry(issue, country, 'preview', saved,
          saved&&preview?.receipt?.reason==='exchange_publish_failed'?[]:undefined)));
        continue;
      }
      const row = state('final');
      const final = row?.state === 'ready' ? row.receipt as SnapshotReceipt | null : null;
      const editorial = state('editorial')?.receipt;
      const release = state('release');
      const wechat = state('wechat');
      if (known.some(entry => entry.country === country && entry.version === planBPackageVersion(issue, country)) && wechat?.state !== 'ready') {
        const readback = state('readback');
        schedule(issue, country, 'readback', readback, async () => {
          const receipt = await reconcileCountryWechat(issue, country);
          return receipt ? ready(receipt) : {
            state: (readback?.attempt || 0) < 1 ? 'retry' : 'blocked',
            receipt: { reason: 'known_draft_readback_mismatch' }, delay: 120_000,
          };
        });
      }
      if (!clock.finalizationAllowed) continue;
      const prior = (row?.receipt?.cache || preview?.receipt?.cache) as SnapshotReceipt['cache'] | undefined;
      const previewStillActive = preview?.state === 'working' && Date.parse(preview.lease_until || '') > Date.now();
      if (!previewStillActive && !final) schedule(issue, country, 'final', row, async () => {
        const reason = row?.receipt?.reason;
        let focus: string[] | undefined;
        if (reason === 'exchange_publish_failed') focus = [];
        else if ((row?.attempt || 0) >= 2) {
          const previous = (row?.receipt as SnapshotReceipt | undefined)?.snapshot;
          const targets = previous && reviewableWindowCount(previous)>0 ? recoverySources(previous.coverage) : [];
          if (targets.length) focus = targets;
        }
        const snapshot = await collectCountry(issue, country, 'final', prior, focus);
        return finalCoverageOutcome(snapshot, row?.attempt || 0);
      });
      if (final && editorial) schedule(issue, country, 'release', release, async () => ready(await prepareCountryRelease(final, editorial)));
      if (release?.state === 'ready' && release.receipt) {
        const proven = release.receipt as Parameters<typeof renderCountryWord>[2];
        schedule(issue, country, 'word', state('word'), async () => ready(await renderCountryWord(issue, country, proven)));
        schedule(issue, country, 'wechat', wechat, async () => {
          await checkRuntime(issue,'before_delivery');
          const result = await deliverCountryWechat(issue, country, proven);
          return 'pendingReadback' in result ? { state: 'blocked', receipt: result } : ready(result);
        });
      }
    }
  } catch {
    runtime.report = { issue: clock.issue, checkedAt: new Date().toISOString(),
      businessSucceeded:false, state:'state_unavailable' };
    const key = `${clock.issue}/state-unavailable/${Math.floor(clock.minute / 5)}`;
    if (clock.minute >= 480 && !emitted.has(key)) {
      emitted.add(key);
      console.warn(JSON.stringify({ event:'plan_b_business_state_unavailable', ...runtime.report }));
    }
  } finally { runtime.reading = false; }
}

export function startPlanB() {
  if (runtime.registered || !planBAdmitted()) return;
  runtime.registered = true;
  const {issue} = planBClock();
  void checkRuntime(issue,'startup');
  void publishExchangeHealth(issue,{...runtimeHealth(),businessSucceeded:false,startup:true})
    .catch(()=>console.warn(JSON.stringify({event:'plan_b_exchange_startup_unavailable'})));
  // Catch up when a reserved instance starts late. State is shared across
  // revision restarts and instances and the database admits each job once.
  void tick();
  cron.schedule('* 4-9 * * *', () => { void tick(); }, { timezone: 'Asia/Shanghai' });
  console.info(JSON.stringify({ event: 'plan_b_registered', version: PLAN_B_RUNTIME_VERSION,
    timeZone: 'Asia/Shanghai', collection: '04:45', freeze: '06:00', deadline: '09:00', close: '09:30' }));
}
