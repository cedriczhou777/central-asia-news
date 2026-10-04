/**
 * 量「配图缺口」：有多少稿子没图，以及**「只挪真图」能补上多少**。
 *
 * 用法：
 *   # ① 先抓一份样本（线上接口，按 UTC 日聚合，多抓几天更稳）
 *   BASE=https://<你的服务域名>
 *   for d in 2026-09-26 2026-09-27 2026-09-28; do
 *     curl -s "$BASE/api/articles?date=$d&limit=1000" -o "/tmp/arts-$d.json"
 *   done
 *   # ② 合并去重成一个数组文件
 *   python3 - <<'PY'
 *   import json,glob
 *   seen={}
 *   for f in glob.glob('/tmp/arts-*.json'):
 *       for a in json.load(open(f)).get('articles',[]): seen[a['id']]=a
 *   json.dump(list(seen.values()),open('/tmp/sample.json','w'),ensure_ascii=False)
 *   PY
 *   # ③ 量
 *   pnpm analyze:cover-gaps /tmp/sample.json
 *
 * ## 为什么这个脚本要留
 *
 * `planCoverBorrows`（借图）只解决**一种**情况：同一件事有两份稿子、有图那份被删了。
 * 它的覆盖率是一个**必须先量再承诺**的数字 —— 2026-09-29 量出来：
 * 3 天 1152 篇里 **187 篇完全没图（16.2%）**，其中能借到图的**上限约 20%**（同国 35 篇），
 * 而「仅跨国」只多 **2 篇（1%）**。
 * ⇒ 这个数字直接决定了「不做跨国路径」这个决定，也决定了「别把缺图率下降当成疗效指标」。
 *
 * ⚠️ 这里算的是**上限**：判据只用 `COVER_BORROW_MIN_SIM` 的标题相似度，
 * （⚠️ 2026-10-05 起它与召回下限 `PAIR_CANDIDATE_MIN_SIM` **不是同一个值** ——
 *   召回降到 0.20、借图仍是 0.35。本脚本量的是**借图**，所以必须用前者。）
 * 真正采纳还要总审**确实把重复那条删掉**（`kind === 'duplicate'`）。
 */
import { readFileSync } from 'fs';
import { similarity } from '../src/lib/utils';
import { COVER_BORROW_MIN_SIM } from '../src/lib/editor-review';

type A = { id: number; title: string; content: string | null; country: string };

const path = process.argv[2];
if (!path) {
  console.error('用法：pnpm analyze:cover-gaps <articles.json>（见本文件头部注释，含怎么生成它）');
  process.exit(2);
}

const arts: A[] = JSON.parse(readFileSync(path, 'utf8'));
const hasImg = (a: A) => /<img/i.test(a.content || '');
const noImg = arts.filter((a) => !hasImg(a));
const withImg = arts.filter(hasImg);

const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(1)}%`;

console.log(`样本 ${arts.length} 篇｜有图 ${withImg.length}｜没图 ${noImg.length}（${pct(noImg.length, arts.length)}）`);

const byCountry = new Map<string, { total: number; noImg: number }>();
for (const a of arts) {
  const c = byCountry.get(a.country) ?? { total: 0, noImg: 0 };
  c.total++;
  if (!hasImg(a)) c.noImg++;
  byCountry.set(a.country, c);
}
console.log('\n按国缺图率：');
for (const [c, v] of [...byCountry.entries()].sort((x, y) => y[1].noImg - x[1].noImg)) {
  console.log(`  ${c}  ${String(v.noImg).padStart(4)} / ${String(v.total).padStart(4)}  ${pct(v.noImg, v.total)}`);
}

let sameCountry = 0;
let crossCountryOnly = 0;
let none = 0;
const examples: string[] = [];

for (const a of noImg) {
  const best = (pool: A[]) =>
    pool
      .map((b) => ({ b, s: similarity(a.title, b.title) }))
      .filter((x) => x.s >= COVER_BORROW_MIN_SIM)
      .sort((x, y) => y.s - x.s)[0];

  const same = best(withImg.filter((b) => b.country === a.country));
  const cross = best(withImg.filter((b) => b.country !== a.country));

  if (same) sameCountry++;
  else if (cross) crossCountryOnly++;
  else none++;

  if (examples.length < 8 && (same || cross)) {
    const h = same ?? cross!;
    examples.push(
      `  [${same ? '同国' : '跨国'}] ${h.s.toFixed(3)}  「${a.title.slice(0, 36)}」\n` +
        `                        ←→ 「${h.b.title.slice(0, 36)}」`,
    );
  }
}

console.log('\n没图的稿子里，能不能找到「同一件事且有图」的同胞（借图的上限）：');
console.log(`  同国命中      ${sameCountry} / ${noImg.length}`);
console.log(`  仅跨国命中    ${crossCountryOnly} / ${noImg.length}   ← 为 1% 级的收益不值得做跨国路径`);
console.log(`  都找不到      ${none} / ${noImg.length}`);
console.log(`  ⇒ 借图覆盖上限 ${pct(sameCountry + crossCountryOnly, noImg.length)}（占全部稿件 ${pct(sameCountry + crossCountryOnly, arts.length)}）`);
console.log('\n命中示例（相似度只是上界，真正采纳还要总审确实把重复那条删掉）：');
console.log(examples.join('\n'));
