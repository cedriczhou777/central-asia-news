import cron from 'node-cron';
import { PLAN_B_COUNTRIES, retryableStatus, type PlanBCountry } from './plan-b-handoff';
import { planBAdmitted, planBClock } from './plan-b-window';
import { claim, getState, knownLiveReceipts, saveClaim, type ClaimStep, type SnapshotReceipt, type StateRow } from './plan-b-store';
import { collectCountry } from './plan-b-worker';
import { deliverCountryWechat, planBPackageVersion, prepareCountryRelease, reconcileCountryWechat, renderCountryWord } from './plan-b-release';

export const PLAN_B_RUNTIME_VERSION = 'plan-b-handoff-1';
const active = new Map<string, ClaimStep>();
let registered = false;
let reading = false;
let report: Record<string, unknown> | null = null;
let previewSettled = '';
let completedIssue = '';
const emitted = new Set<string>();
const workerLimit = { preview: 2, final: 2, release: 2, word: 2, wechat: 2, readback: 2 };

export function planBRegistration() {
  return { registered, activeSteps: active.size, report };
}

function eligible(row: StateRow | undefined, now: number) {
  return !row || (row.attempt < 2 && (
    row.state === 'retry' && Date.parse(row.retry_after || '') <= now
    || row.state === 'working' && Date.parse(row.lease_until || '') <= now
  ));
}

type Outcome = { state: 'ready' | 'retry' | 'blocked'; receipt: object; delay?: number };
const ready = (receipt: object): Outcome => ({ state: 'ready', receipt });

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
  if ([...active.values()].filter(value => (value === 'preview' ? 'final' : value) === lane).length >= workerLimit[lane]) return;
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
  if (reading || !(clock.previewAllowed || clock.reconcileAllowed)) return;
  if (completedIssue === clock.issue || (clock.previewAllowed && previewSettled === clock.issue)
      || (!clock.finalizationAllowed && !clock.previewAllowed && clock.minute % 5 !== 0)) return;
  reading = true;
  try {
    const issue = clock.issue;
    const rows = await getState(issue);
    const complete = (country: PlanBCountry, steps: string[]) =>
      rows.some(row => row.country === country && steps.includes(row.step) && row.state === 'ready');
    const scope = PLAN_B_COUNTRIES.map(country => ({ country, preview: complete(country, ['preview']),
      editorial: complete(country, ['editorial']), word: complete(country, ['word']),
      wechat: complete(country, ['wechat','readback']) }));
    if (clock.previewAllowed && scope.every(item => item.preview)) {
      previewSettled = issue;
      return;
    }
    if (scope.every(item => item.word && item.wechat)) {
      completedIssue = issue;
      report = { issue, finishedAt: new Date().toISOString(), status: 'complete', countries: scope };
      console.info(JSON.stringify({ event: 'plan_b_delivered', ...report }));
      return;
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
        const pendingSources = snapshot.snapshot.pendingSources;
        if (pendingSources.length) return { state: (row?.attempt || 0) < 1 ? 'retry' : 'blocked',
          receipt: { ...snapshot, pendingSources, reason: 'increment_not_fully_observed' }, delay: 120_000 };
        return ready(snapshot);
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
    report = { issue, checkedAt: new Date().toISOString(), status: 'running' };
  } catch {
    report = { issue: clock.issue, checkedAt: new Date().toISOString(), status: 'state_unavailable' };
  } finally { reading = false; }
}

export function startPlanB() {
  if (registered || !planBAdmitted()) return;
  registered = true;
  // Catch up when a reserved instance starts late. State is shared across
  // revision restarts and instances and the database admits each job once.
  void tick();
  cron.schedule('* 4-9 * * *', () => { void tick(); }, { timezone: 'Asia/Shanghai' });
  console.info(JSON.stringify({ event: 'plan_b_registered', version: PLAN_B_RUNTIME_VERSION,
    timeZone: 'Asia/Shanghai', collection: '04:45', freeze: '06:00', deadline: '09:00', close: '09:30' }));
}
