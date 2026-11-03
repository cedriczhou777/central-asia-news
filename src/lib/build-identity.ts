import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function buildIdentity(): { sourceDigest: string | null; builtAt: string | null } {
  try {
    const data = JSON.parse(readFileSync(resolve(process.cwd(), 'dist/build-identity.json'), 'utf8')) as Record<string, unknown>;
    return { sourceDigest: typeof data.sourceDigest === 'string' ? data.sourceDigest : null, builtAt: typeof data.builtAt === 'string' ? data.builtAt : null };
  } catch { return { sourceDigest: null, builtAt: null }; }
}
