import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { canonicalJson, snapshot, type Phase, type PlanBCountry, type Snapshot } from './plan-b-handoff';
import { saveFile, saveObject, verifyObject, type ObjectReceipt, type SnapshotReceipt } from './plan-b-store';
import type { WorkCheckpoint } from './plan-b-checkpoint';
import { sha256 } from './plan-b-handoff';

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

export async function runCloudScript(script: 'cloud_handoff.py' | 'cloud_release.py', args: string[], timeout: number) {
  // The child has no model or database credentials. Python public-source
  // operations use only these runtime settings and the task's own arguments.
  await worker('python3', [join(scripts, script), ...args], {
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
    phase: Phase, prior: ObjectReceipt | undefined, focus?: string[],
    isolated?: { namespace: string; deadline: number; scanSeconds?: number; nov27Recovery?: boolean }): Promise<SnapshotReceipt> {
  return scratch(async directory => {
    await restoreCache(directory, prior);
    const maximum = focus && !isolated?.scanSeconds ? 160_000 : 520_000;
    const timeout = isolated ? Math.min(maximum, isolated.deadline - Date.now())
      : timeWithin(issue, phase === 'preview' ? '06:00:00' : '09:00:00', maximum);
    const archiveReserve = isolated?.scanSeconds ? 120_000 : 20_000;
    if (isolated && timeout <= archiveReserve) throw new Error('isolated_scan_window_closed');
    const networkSeconds = Math.min(isolated?.scanSeconds ?? (focus ? 120 : 480), Math.max(1, (timeout - archiveReserve) / 1_000));
    const args=focus && !focus.length ? ['reassess',directory,issue,country,phase]
      : ['scan', directory, issue, country, phase, String(networkSeconds), ...(focus ?? [])];
    try {
      await runCloudScript('cloud_handoff.py', isolated?.nov27Recovery ? ['--nov27-recovery', ...args] : args, timeout);
    } catch (error) {
      if (isolated?.scanSeconds) {
        const failure = error as { killed?: boolean; code?: string | number; stderr?: string };
        if (failure.killed) throw new Error('isolated_scan_timeout');
        if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('isolated_scan_output_limit');
        const reason = failure.stderr?.trimEnd().split('\n').at(-1)?.match(/^(?:ValueError|RuntimeError): ([a-z][a-z0-9_]{0,80})$/)?.[1];
        if (reason) throw new Error(reason);
      }
      throw error;
    }
    const { metrics, ...input } = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8')) as
      Omit<Snapshot, 'hash' | 'provisional'> & { metrics: Record<string, unknown> };
    const frozen = snapshot(input);
    if (frozen.issue !== issue || frozen.country !== country || frozen.phase !== phase) throw new Error('scan_scope_mismatch');
    const cache = await saveFile(issue, country, 'gz', join(directory, 'output.gz'));
    const receipt={ snapshot: frozen, cache, metrics };
    const {publishScan}=await import('./plan-b-exchange');
    try{await publishScan(receipt,join(directory,'originals.jsonl'),isolated?.namespace);}
    catch{throw Object.assign(new Error('exchange_publish_failed'),{snapshotReceipt:receipt});}
    return receipt;
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

export async function readWorkCheckpoint(checkpoint: WorkCheckpoint) {
  const { gunzip } = await import('node:zlib');
  return scratch(async directory => {
    const file = join(directory, 'checkpoint.gz');
    await verifyObject(checkpoint.archived, file);
    const plain = await promisify(gunzip)(await readFile(file), { maxOutputLength:2 * 1024 * 1024 });
    const value = JSON.parse(plain.toString('utf8')) as unknown;
    if (sha256(canonicalJson(value)) !== checkpoint.checkpointHash) throw new Error('checkpoint_hash_mismatch');
    return value;
  });
}
