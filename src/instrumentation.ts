import { planBAdmitted } from './lib/plan-b-window';

export async function register() {
  if (process.env.REVIEWED_RUNTIME_ONLY === '1' && process.env.NEXT_RUNTIME === 'nodejs') {
    if (planBAdmitted()) {
      const { startPlanB } = await import('./lib/plan-b-runtime');
      startPlanB();
      void import('./lib/reviewed-database-delivery').then(
        ({ startReviewedDatabaseRecovery }) => startReviewedDatabaseRecovery(),
      ).catch(() => console.warn('manual_recovery_registration_failed'));
    } else {
      const { startReviewedRecovery } = await import('./lib/reviewed-recovery');
      startReviewedRecovery();
    }
  }
}
