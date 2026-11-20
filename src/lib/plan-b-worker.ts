import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { canonicalJson, snapshot, type Phase, type PlanBCountry, type Snapshot } from './plan-b-handoff';
import { readObject, saveObject, type ObjectReceipt, type SnapshotReceipt } from './plan-b-store';

const worker = promisify(execFile);
const scripts = join(process.cwd(), 'ops/plan-b');

export async function scratch<T>(run: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 'plan-b-'));
  try { return await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

export async function runCloudScript(script: 'cloud_handoff.py' | 'cloud_release.py', args: string[], timeout: number) {
  // The child has no model or database credentials. Python public-source
  // operations use only these runtime settings and the task's own arguments.
  await worker('python3', [join(scripts, script), ...args], {
    env: { PATH: process.env.PATH, NODE_ENV: 'production', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
    timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
  });
}

export async function restoreCache(directory: string, cache: ObjectReceipt | undefined) {
  if (cache) await writeFile(join(directory, 'input.gz'), await readObject(cache), { mode: 0o600 });
}

export function timeWithin(issue: string, hms: '06:00:00' | '09:00:00', maximum: number) {
  const remaining = Date.parse(`${issue}T${hms}+08:00`) - Date.now();
  if (remaining < 2_000) throw new Error('plan_b_delivery_window_closed');
  return Math.min(maximum, remaining);
}

export async function collectCountry(issue: string, country: PlanBCountry,
    phase: Phase, prior: ObjectReceipt | undefined): Promise<SnapshotReceipt> {
  return scratch(async directory => {
    await restoreCache(directory, prior);
    const timeout = timeWithin(issue, phase === 'preview' ? '06:00:00' : '09:00:00', 520_000);
    await runCloudScript('cloud_handoff.py', ['scan', directory, issue, country, phase,
      String(Math.min(480, Math.max(1, (timeout - 20_000) / 1_000)))], timeout);
    const { metrics, ...input } = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8')) as
      Omit<Snapshot, 'hash' | 'provisional'> & { metrics: Record<string, unknown> };
    const frozen = snapshot(input);
    if (frozen.issue !== issue || frozen.country !== country || frozen.phase !== phase) throw new Error('scan_scope_mismatch');
    const cache = await saveObject(issue, country, 'gz', await readFile(join(directory, 'output.gz')));
    return { snapshot: frozen, cache, metrics };
  });
}

export async function sourceOriginals(scope: SnapshotReceipt, ids: string[]) {
  return scratch(async directory => {
    await restoreCache(directory, scope.cache);
    await runCloudScript('cloud_handoff.py', ['originals', directory, scope.snapshot.issue, scope.snapshot.country, ...ids], 15_000);
    return JSON.parse(await readFile(join(directory, 'originals.json'), 'utf8')) as unknown;
  });
}

export async function archiveEditorial(issue: string, country: PlanBCountry, value: object) {
  const { gzip } = await import('node:zlib');
  return saveObject(issue, country, 'gz', await promisify(gzip)(canonicalJson(value)));
}
