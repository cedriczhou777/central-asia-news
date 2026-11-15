/** Bounds the entire native fetch, including response-body consumption.
 * AbortSignal.timeout stays active after headers arrive; a Promise.race or a
 * timer cleared at fetch() resolution would leave a stalled body running. */
export const SUPABASE_REQUEST_TIMEOUT_MS = 60_000;

export function createDeadlineFetch(fetcher: typeof fetch, timeoutMs = SUPABASE_REQUEST_TIMEOUT_MS): typeof fetch {
  return async (input, init) => {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (input instanceof Request) signals.push(input.signal);
    if (init?.signal) signals.push(init.signal);
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    return fetcher(input, { ...init, signal });
  };
}
