export async function register() {
  if (process.env.REVIEWED_RUNTIME_ONLY === '1' && process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('./lib/scheduler');
    startScheduler();
  }
}
