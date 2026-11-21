const BJT_OFFSET_MS = 8 * 60 * 60 * 1000;
const FIRST_SUPPORTED_ISSUE = '2026-11-22';

export const PLAN_B_CLOCK = {
  collectAt: 4 * 60 + 45,
  workAt: 5 * 60 + 30,
  freezeAt: 6 * 60,
  targetAt: 8 * 60,
  deadlineAt: 9 * 60,
  closeAt: 9 * 60 + 30,
};

export function planBEnabled() {
  return process.env.REVIEWED_PLAN_B === '1';
}

export function planBIngestSecret() {
  return process.env.PLAN_B_INGEST_SECRET || process.env.INGEST_SECRET || '';
}

export function planBAdmitted() {
  const firstIssue = process.env.REVIEWED_PLAN_B_FIRST_ISSUE;
  if (!firstIssue || !planBEnabled() || !planBIngestSecret() || !planBHandlesIssue(firstIssue)) return false;
  try { issueWindow(firstIssue); return true; } catch { return false; }
}

export function planBHandlesIssue(issue: string) {
  const configuredIssue = process.env.REVIEWED_PLAN_B_FIRST_ISSUE || FIRST_SUPPORTED_ISSUE;
  return /^\d{4}-\d{2}-\d{2}$/.test(configuredIssue)
    && issue >= FIRST_SUPPORTED_ISSUE && issue >= configuredIssue;
}

export function planBClock(now = Date.now()) {
  const local = new Date(now + BJT_OFFSET_MS);
  const issue = local.toISOString().slice(0, 10);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const supported = planBHandlesIssue(issue);
  return {
    issue, minute,
    previewAllowed: supported && minute >= PLAN_B_CLOCK.collectAt && minute < PLAN_B_CLOCK.freezeAt - 10,
    finalizationAllowed: supported && minute >= PLAN_B_CLOCK.freezeAt && minute < PLAN_B_CLOCK.deadlineAt,
    reconcileAllowed: supported && minute >= PLAN_B_CLOCK.freezeAt && minute < PLAN_B_CLOCK.closeAt,
  };
}

export function issueWindow(issue: string) {
  const end = Date.parse(`${issue}T06:00:00+08:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issue) || !Number.isFinite(end)
      || new Date(end + BJT_OFFSET_MS).toISOString().slice(0, 10) !== issue) {
    throw new Error('invalid_issue');
  }
  return { start: end - 24 * 60 * 60 * 1000, end };
}
