import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { canonicalJson, snapshot, type Phase, type PlanBCountry, type Snapshot } from './plan-b-handoff';
import { saveFile, saveObject, verifyObject, type ObjectReceipt, type SnapshotReceipt } from './plan-b-store';

const worker = promisify(execFile);
const scripts = join(process.cwd(), 'ops/plan-b');
const originalsCache = new Map<string, { root: Promise<string>; users: number; touched: number }>();
const MAX_ORIGINAL_CACHES = 5;
const ORIGINAL_CACHE_TTL_MS = 2 * 60 * 60_000;

export async function scratch<T>(run: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 'plan-b-'));
  try { return await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

export async function runCloudScript(script: 'cloud_handoff.py' | 'cloud_release.py' | 'fetch_work_sources.py', args: string[], timeout: number) {
  // The child has no model or database credentials. Python public-source
  // operations use only these runtime settings and the task's own arguments.
  return worker('python3', [join(scripts, script), ...args], {
    env: { PATH: process.env.PATH, NODE_ENV: 'production', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
    timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
  });
}

export async function restoreCache(directory: string, cache: ObjectReceipt | undefined) {
  if (cache) await verifyObject(cache, join(directory, 'input.gz'));
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
    const cache = await saveFile(issue, country, 'gz', join(directory, 'output.gz'));
    return { snapshot: frozen, cache, metrics };
  });
}

export async function sourceOriginals(scope: SnapshotReceipt, ids: string[]) {
  const { issue, country } = scope.snapshot;
  const key = `${issue}/${country}/${scope.cache.sha256}`;
  function evict(id: string, entry: NonNullable<ReturnType<typeof originalsCache.get>>) {
    originalsCache.delete(id);
    void entry.root.then(directory => rm(directory, { recursive:true, force:true })).catch(() => undefined);
  }
  for (const [id, entry] of originalsCache) {
    if (entry.users === 0 && Date.now() - entry.touched >= ORIGINAL_CACHE_TTL_MS) evict(id, entry);
  }
  let entry = originalsCache.get(key);
  if (!entry) {
    if (originalsCache.size >= MAX_ORIGINAL_CACHES) {
      const idle = [...originalsCache.entries()].filter(([, item]) => item.users === 0)
        .sort((a,b) => a[1].touched - b[1].touched)[0];
      if (!idle) throw new Error('plan_b_cache_busy');
      evict(...idle);
    }
    const root = (async () => {
      const directory = await mkdtemp(join(tmpdir(), 'plan-b-originals-'));
      try {
        await restoreCache(directory, scope.cache);
        await runCloudScript('cloud_handoff.py', ['extract-originals', directory, issue, country], 60_000);
        await rm(join(directory, 'input.gz'));
        return directory;
      } catch (error) {
        await rm(directory, { recursive:true, force:true });
        throw error;
      }
    })();
    entry = { root, users:0, touched:Date.now() };
    originalsCache.set(key, entry);
    const current = entry;
    void root.catch(() => { if (originalsCache.get(key) === current) originalsCache.delete(key); });
  }
  entry.users++;
  try {
    const cache = await entry.root;
    return await scratch(async directory => {
      await runCloudScript('cloud_handoff.py', ['originals', directory, issue, country, cache, ...ids], 15_000);
      return JSON.parse(await readFile(join(directory, 'originals.json'), 'utf8')) as unknown;
    });
  } finally {
    entry.users--;
    entry.touched = Date.now();
  }
}

export async function archiveEditorial(issue: string, country: PlanBCountry, value: object) {
  const { gzip } = await import('node:zlib');
  return saveObject(issue, country, 'gz', await promisify(gzip)(canonicalJson(value)));
}
