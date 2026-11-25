import { probeReviewedDraftReadiness } from './reviewed-wechat';
import { fetchWechat } from './reviewed-wechat-transport';

export type ReadinessPhase = 'startup' | 'collection' | 'before_signoff' | 'before_delivery' | 'retry';
export type ReadinessAttempt = { issue:string; attempt:number; phase:ReadinessPhase; startedAt:string };
type ReadinessResult = 'passed' | 'failed' | 'missing_test_object';
const RETRY_DELAYS = [30_000,60_000,120_000];
const FRESH_MS = 5 * 60_000;

export async function checkCurrentWechatDrafts(request = fetchWechat) {
  // Published or deleted drafts can still have successful delivery receipts.
  // Use only a current draft from the list and the existing production client.
  const probe = await probeReviewedDraftReadiness(null, {clients:[{id:'node_fetch',protocol:'http',request}]});
  const verifiedList = probe.observed.find(row => row.batchget.ok && row.batchget.httpStatus === 200
    && (probe.transport === 'access_token' || row.batchget.openApiSeqid));
  const list = verifiedList?.batchget.list;
  const readback = verifiedList?.get;
  const getStatus = !readback ? 'not_checked'
    : readback.ok ? 'passed'
    : readback.stage === 'stored_reference_missing' || readback.errcode === '40007' ? 'missing_test_object'
    : 'failed';
  return {...probe, ready:getStatus === 'passed', transportReady:!!verifiedList,
    emptyDraftBox:list?.total === 0 && list.returned === 0, getStatus};
}

/** One check at a time. Startup retries and one recheck at each production stage have separate bounds. */
export function createRuntimeChecks(run:(attempt:ReadinessAttempt)=>Promise<ReadinessResult>,
    now = Date.now, wait = (action:()=>void, delay:number) => { setTimeout(action,delay).unref(); }) {
  let current: { issue:string; attempts:number; retries:number; retryPending:boolean; result:ReadinessResult; lastAt:number;
    checks:Set<ReadinessPhase>; active?:Promise<void> } | undefined;

  function launch(state:NonNullable<typeof current>, phase:ReadinessPhase) {
    const attempt = ++state.attempts;
    // Deferring execution makes an immediate tick share the startup check.
    const active = Promise.resolve().then(async()=>{
      let result:ReadinessResult = 'failed';
      try { result = await run({issue:state.issue,attempt,phase,startedAt:new Date(now()).toISOString()}); }
      finally {
        state.lastAt=now();
        state.result=result;
        state.active=undefined;
        const delay=RETRY_DELAYS[state.retries];
        if (result==='failed' && current===state && delay!==undefined) {
          state.retries++;
          state.retryPending=true;
          wait(()=>{
            state.retryPending=false;
            if (current===state && state.result==='failed') void launch(state,'retry');
          },delay);
        }
      }
    }).catch(()=>{});
    state.active=active;
    return active;
  }

  return (issue:string, phase:Exclude<ReadinessPhase,'retry'>) => {
    if (current && issue<current.issue) return;
    if (!current || issue!==current.issue) {
      current={issue,attempts:0,retries:0,retryPending:false,result:'failed',lastAt:0,checks:new Set([phase])};
      return launch(current,phase);
    }
    if (current.active) return current.active;
    if (current.result==='missing_test_object' || phase==='startup' || current.retryPending || current.checks.has(phase)
        || current.result==='passed' && now()-current.lastAt<FRESH_MS) return;
    current.checks.add(phase);
    return launch(current,phase);
  };
}
