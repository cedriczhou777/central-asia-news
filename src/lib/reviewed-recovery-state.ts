/** Next instrumentation and routes can bundle this module separately. Keep the
 * process-local scheduler lock and status on the shared JavaScript global. The
 * database remains the authority for cross-process delivery ownership. */
export interface ReviewedRecoveryState {
  running: boolean;
  registered: boolean;
  lastRecovery: Record<string, unknown> | null;
  acceptedOrigin?: string;
}

const stateKey = Symbol.for('central-asia-news.reviewed-recovery.state.v1');
const processGlobal = globalThis as typeof globalThis & {
  [key: symbol]: ReviewedRecoveryState | undefined;
};

export function getReviewedRecoveryState(): ReviewedRecoveryState {
  return processGlobal[stateKey] ??= {
    running: false,
    registered: false,
    lastRecovery: null,
  };
}
