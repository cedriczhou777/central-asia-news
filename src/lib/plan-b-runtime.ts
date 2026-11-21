import cron from 'node-cron';
import { freezeBlockReason, PLAN_B_COUNTRIES, retryableStatus, type PlanBCountry } from './plan-b-handoff';
import { planBAdmitted, planBClock } from './plan-b-window';
import { claim, getState, knownLiveReceipts, saveClaim, type ClaimStep, type SnapshotReceipt, type StateRow } from './plan-b-store';
import { collectCountry } from './plan-b-worker';
import { deliverCountryWechat, planBPackageVersion, prepareCountryRelease, reconcileCountryWechat, renderCountryWord } from './plan-b-release';
import { planBBusinessStatus } from './plan-b-status';

export const PLAN_B_RUNTIME_VERSION = 'plan-b-handoff-3-production-state';
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

export function planBRegistration() {
  return { registered:runtime.registered, activeSteps: active.size, report:runtime.report };
}

function eligible(row: StateRow | undefined, now: number) {
  return !row || (row.attempt < 2 && (
    row.state === 'retry' && Date.parse(row.retry_after || '') <= now
    || row.state === 'working' && Date.parse(row.lease_until || '') <= now
  ));
}

type Outcome = { state: 'ready' | 'retry' | 'blocked'; receipt: object; delay?: number };
const ready = (receipt: object): Outcome => ({ state: 'ready', receipt });

export function finalCoverageOutcome(receipt: SnapshotReceipt, attempt: number): Outcome {
  const reason = freezeBlockReason(receipt.snapshot);
  return reason ? { state: attempt < 1 ? 'retry' : 'blocked', delay:120_000,
    receipt:{ ...receipt, pendingSources:receipt.snapshot.pendingSources, coverage:receipt.snapshot.coverage, reason } }
    : ready(receipt);
}

function boundedFailure(error: unknown, nextAttempt: number, step: ClaimStep): Outcome {
  const message = error instanceof Error ? error.message : '';
  const http = message.match(/(?:HTTP|错误码|status)[ :]*(\d{3})/i)?.[1];
  const status = http ? Number(http) : /timeout|network|temporar|unavailable|ECONN|超时|连接/i.test(message) ? null : 400;
  const category = retryableStatus(status);
  const reason = /^[a-z][a-z0-9_]{0,80}$/.test(message) ? message : category === 'stop' ? 'operation_failed' : category;
  return { state: nextAttempt < 2 && category !== 'stop' ? 'retry' : 'blocked',
    receipt: { reason, httpStatus: status === 400 && !http ? null : status, stage: step }, delay: category === 'rate_limited' ? 120_000 : 30_000 };
}

function schedule(issue: string, country: PlanBCountry, step: ClaimStep, row: StateRow | undefined,
    perform: () => Promise<Outcome>) {
  const key = `${issue}/${country}/${step}`;
  if (!eligible(row, Date.now()) || active.has(key)) return;
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
    catch (error) { result = boundedFailure(error, (row?.attempt || 0) + 1, step); }
    await saveClaim(issue, country, step, lease, result.state, { ...result.receipt,
      elapsedMs: Date.now() - start }, result.delay);
  })().catch(() => {
    console.warn(JSON.stringify({ event: 'plan_b_checkpoint_failed', issue, country, step }));
  }).finally(() => active.delete(key));
}

async function tick() {
  const clock = planBClock();
  if (runtime.reading || !(clock.previewAllowed || clock.reconcileAllowed)) return;
  if (runtime.completedIssue === clock.issue || (clock.previewAllowed && runtime.previewSettled === clock.issue)
      || (!clock.finalizationAllowed && !clock.previewAllowed && clock.minute % 5 !== 0)) return;
  runtime.reading = true;
  try {
    const issue = clock.issue;
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
        schedule(issue, country, 'preview', preview, async () => ready(await collectCountry(issue, country, 'preview', undefined)));
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
        const snapshot = await collectCountry(issue, country, 'final', prior);
        return finalCoverageOutcome(snapshot, row?.attempt || 0);
      });
      if (final && editorial) schedule(issue, country, 'release', release, async () => ready(await prepareCountryRelease(final, editorial)));
      if (release?.state === 'ready' && release.receipt) {
        const proven = release.receipt as Parameters<typeof renderCountryWord>[2];
        schedule(issue, country, 'word', state('word'), async () => ready(await renderCountryWord(issue, country, proven)));
        schedule(issue, country, 'wechat', wechat, async () => {
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
  // Catch up when a reserved instance starts late. State is shared across
  // revision restarts and instances and the database admits each job once.
  void tick();
  cron.schedule('* 4-9 * * *', () => { void tick(); }, { timezone: 'Asia/Shanghai' });
  console.info(JSON.stringify({ event: 'plan_b_registered', version: PLAN_B_RUNTIME_VERSION,
    timeZone: 'Asia/Shanghai', collection: '04:45', freeze: '06:00', deadline: '09:00', close: '09:30' }));
}
