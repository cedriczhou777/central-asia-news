export async function register() {
  if (process.env.REVIEWED_RUNTIME_ONLY === '1' && process.env.NEXT_RUNTIME === 'nodejs') {
    const { startReviewedRecovery } = await import('./lib/reviewed-recovery');
    startReviewedRecovery();
  }
}
