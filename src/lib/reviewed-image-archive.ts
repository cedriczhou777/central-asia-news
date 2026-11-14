import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** Deployed, immutable copies of publicly obtained source bytes. No runtime writes,
 * arbitrary paths, alternate hosts or changes to the accepted editorial package. */
export async function readArchivedImage(url: string, directory = join(process.cwd(), 'public/reviewed-image-archive')): Promise<Buffer | null> {
  let raw: string;
  try { raw = await readFile(join(directory, 'manifest.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const manifest = JSON.parse(raw) as { images?: Array<{ url: string; sha256: string; bytes: number }> };
  if (!Array.isArray(manifest.images)) throw new Error('原图存档清单无效');
  const matches = manifest.images.filter(entry => entry.url === url);
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error('原图存档记录冲突');
  const entry = matches[0];
  if (!/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 10_000_000) throw new Error('原图存档记录无效');
  const bytes = await readFile(join(directory, entry.sha256));
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('原图存档哈希不一致');
  return bytes;
}
