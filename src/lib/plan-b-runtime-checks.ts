export type ReadinessPhase = 'startup' | 'collection' | 'before_signoff' | 'before_delivery' | 'retry';
export type ReadinessAttempt = { issue:string; attempt:number; phase:ReadinessPhase; startedAt:string; inspectNetwork:boolean };
const RETRY_DELAYS = [30_000,60_000,120_000];
const FRESH_MS = 5 * 60_000;

/** One check at a time. Startup retries and one recheck at each production stage have separate bounds. */
export function createRuntimeChecks(run:(attempt:ReadinessAttempt)=>Promise<boolean>,
    now = Date.now, wait = (action:()=>void, delay:number) => { setTimeout(action,delay).unref(); }) {
  let current: { issue:string; attempts:number; retries:number; retryPending:boolean; ready:boolean; lastAt:number;
    checks:Set<ReadinessPhase>; active?:Promise<void> } | undefined;

  function launch(state:NonNullable<typeof current>, phase:ReadinessPhase) {
    const attempt = ++state.attempts;
    // Deferring execution makes an immediate tick share the startup check.
    const active = Promise.resolve().then(async()=>{
      let ready = false;
      try { ready = await run({issue:state.issue,attempt,phase,startedAt:new Date(now()).toISOString(),inspectNetwork:attempt===1}); }
      finally {
        state.lastAt=now();
        state.ready=ready;
        state.active=undefined;
        const delay=RETRY_DELAYS[state.retries];
        if (!ready && current===state && delay!==undefined) {
          state.retries++;
          state.retryPending=true;
          wait(()=>{
            state.retryPending=false;
            if (current===state && !state.ready) void launch(state,'retry');
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
      current={issue,attempts:0,retries:0,retryPending:false,ready:false,lastAt:0,checks:new Set([phase])};
      return launch(current,phase);
    }
    if (current.active) return current.active;
    if (phase==='startup' || current.retryPending || current.checks.has(phase) || current.ready && now()-current.lastAt<FRESH_MS) return;
    current.checks.add(phase);
    return launch(current,phase);
  };
}
