import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile()) files.push(path);
  }
}
walk('src');
files.push('package.json', 'pnpm-lock.yaml', 'next.config.mjs', 'scripts/build.sh');
const hash = createHash('sha256');
for (const file of files.sort()) hash.update(file).update('\0').update(readFileSync(file)).update('\0');
mkdirSync('dist', { recursive: true });
writeFileSync('dist/build-identity.json', JSON.stringify({ sourceDigest: hash.digest('hex'), builtAt: new Date().toISOString() }) + '\n');
