/** Compile a dated review; optional manifest binds review numbers to stable identities. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseEditorialReview } from '../src/lib/editorial-review-parser';

const args = process.argv.slice(2);
const input = args[0];
if (!input || input.startsWith('--')) throw new Error('用法：tsx scripts/build-editorial-overrides.ts <审稿.md> [--out <文件前缀>] [--manifest <批次.json>]');
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const output = resolve(option('--out') || 'src/data/editorial-overrides');
const result = parseEditorialReview(readFileSync(input, 'utf8'), basename(input), new Date().toISOString());
if (result.unparsed.length) throw new Error('以下处置未识别，停止生成：' + JSON.stringify(result.unparsed));
const manifestPath = option('--manifest');
if (manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    reviewDate: string;
    countries: Record<string, Array<{ no: number; id: string | number; source_url: string }>>;
  };
  if (manifest.reviewDate !== result.reviewDate) throw new Error('批次清单与审稿日期不一致');
  for (const [country, bucket] of Object.entries(result.countries)) {
    for (const entry of [...bucket.replace, ...bucket.drop]) {
      const hits = (manifest.countries[country] || []).filter((row) => row.no === entry.no);
      if (hits.length !== 1 || !hits[0].id || !/^https?:\/\//.test(hits[0].source_url)) throw new Error('审稿身份未绑定：' + country + ' #' + entry.no);
      entry.articleId = hits[0].id;
      entry.sourceUrl = hits[0].source_url;
    }
  }
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output + '.json', JSON.stringify(result, null, 2) + '\n');
writeFileSync(output + '.ts', [
  '// 自动生成。保留完整正文；只允许在对应日期与文章身份上应用。',
  "import type { EditorialReviewSet } from '../lib/editorial-review-parser';",
  'export const EDITORIAL_OVERRIDES: EditorialReviewSet = ' + JSON.stringify(result, null, 2) + ';',
  'export default EDITORIAL_OVERRIDES;', '',
].join('\n'));
let replacements = 0; let drops = 0;
for (const [country, bucket] of Object.entries(result.countries)) {
  replacements += bucket.replace.length; drops += bucket.drop.length;
  console.log(country + ': 覆盖 ' + bucket.replace.length + ' / 删除 ' + bucket.drop.length);
}
console.log('日期 ' + result.reviewDate + '：覆盖 ' + replacements + ' / 删除 ' + drops + ' / 未识别 ' + result.unparsed.length);
