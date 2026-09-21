/**
 * 召回层体检：看看**会把哪些对交给模型**。
 *
 * 用法（把线上 /api/articles 的返回存成 JSON 再喂进来）：
 *   pnpm tsx scripts/peek-pairs.ts /tmp/live.json [相似度下限]
 *
 * ## 为什么需要单独看「召回」
 *
 * L2（模型判定）是一条「召回 + 判定」的流水线：
 *
 *   确定性去重(L0/L1) → candidatePairs 召回 → 模型逐对二选一 → 簇合并 + 护栏
 *
 * 其中**召回只要漏了，后面再准也没用** —— 那两条重复永远不会被问给模型。
 * 而召回是纯代码、不依赖模型、可以在本地断言，所以它必须能单独观察。
 *
 * 反过来，召回故意放得很宽（默认 0.35）——它只需要「不漏」，
 * 判得准不准是模型的职责。因此这个脚本的输出**不是**「这些会合并」，
 * 而是「这些会被问到」：宁可列表长一点带着噪声，也不能漏掉真重复。
 *
 * 排查时的读法：
 *   · 列表里出现「明显是同一件事」的一对 → 目标：模型必须答「是」。
 *   · 列表里出现「明显不是同一件事」的一对 → 那是召回的噪声，正常；
 *     模型答「否」即可，只浪费一点 token。
 *   · 列表里**没有**「明明同一件事」的一对 → 召回漏了，需要调低下限。
 */
import { readFileSync } from 'fs';
import {
  candidatePairs,
  dedupeStoriesDeterministic,
  hasOppositePolarity,
  type StoryLike,
} from '../src/lib/same-event';

const dataPath = process.argv[2];
if (!dataPath) {
  console.error('用法：pnpm tsx scripts/peek-pairs.ts <数据.json> [相似度下限]');
  process.exit(2);
}
const minSim = Number(process.argv[3]) || undefined;

const raw = JSON.parse(readFileSync(dataPath, 'utf8')) as
  | { articles: Array<Record<string, unknown>> }
  | Array<Record<string, unknown>>;
const rows = Array.isArray(raw) ? raw : raw.articles;

const stories: StoryLike[] = rows.map((r) => ({
  title: String(r.title ?? ''),
  content: String(r.content ?? ''),
  summary: String(r.summary ?? ''),
  country_code: String(r.country ?? r.country_code ?? ''),
  source_url: String(r.sourceUrl ?? r.source_url ?? ''),
  original_title: String(r.originalTitle ?? r.original_title ?? ''),
}));

const byCountry = new Map<string, StoryLike[]>();
for (const s of stories) {
  const k = s.country_code || 'intl';
  const list = byCountry.get(k);
  if (list) list.push(s);
  else byCountry.set(k, [s]);
}

console.log(`数据：${dataPath}（${stories.length} 篇 / ${byCountry.size} 个国家）`);
console.log(`相似度下限：${minSim ?? '默认'}\n`);

let totalPairs = 0;
let totalVetoed = 0;
let totalKept = 0;

for (const [cc, list] of [...byCountry.entries()].sort((a, b) => b[1].length - a[1].length)) {
  // 与生产链路一致：先确定性去重，再在剩下的条目上召回
  const { kept } = dedupeStoriesDeterministic(list);
  totalKept += kept.length;
  const pairs = candidatePairs(kept, minSim);
  totalPairs += pairs.length;

  if (pairs.length === 0) continue;

  // 与生产链路一致：反向极性对在问模型之前就被确定性拦下，模型看不到它们。
  // 这里用 `✗ 已拦` 标出来，是为了能一眼看出「该拦的拦住了没有」。
  const asked = pairs.filter((p) => !hasOppositePolarity(kept[p.a].title, kept[p.b].title));
  const vetoed = pairs.filter((p) => hasOppositePolarity(kept[p.a].title, kept[p.b].title));
  totalVetoed += vetoed.length;

  console.log(
    `[${cc}] ${list.length} → 去重后 ${kept.length}，候选 ${pairs.length} 对` +
      `（问模型 ${asked.length}，极性拦下 ${vetoed.length}）`,
  );
  for (const p of pairs) {
    const veto = hasOppositePolarity(kept[p.a].title, kept[p.b].title);
    console.log(`   ${p.sim.toFixed(2)}${veto ? ' ✗已拦' : '      '}「${kept[p.a].title.slice(0, 46)}」`);
    console.log(`               「${kept[p.b].title.slice(0, 46)}」`);
  }
  console.log('');
}

console.log('='.repeat(60));
console.log(`去重后共 ${totalKept} 条；候选 ${totalPairs} 对，其中 ${totalVetoed} 对因方向相反被确定性拦下。`);
console.log('带 ✗已拦 的不会经过模型（模型答什么都无效），其余每一对都值得人眼过一遍：');
console.log('同一件事的必须在列，且模型应判「是」；不同事的模型应判「否」。');
