// 候选修法的预备测量：**「同模板、不同对象」能不能用确定性的国名/对象词判据拦掉？**
//
// 这是两个负结果之后唯一还站着的方向：
//   · 「拆分大组护栏」——量出来是净负（16 真 / 26 误），否掉；
//   · 「削掉公共前缀再算相似度」——AUC 只 +0.03，却把 13 条**真**对压到召回下限以下（漏合并），否掉。
// 剩下的一条：**误合并共享的是「谁」（对象），真重复共享的是「什么事」（话题）**。
// 「谁」是可以用现有词表确定性查出来的，所以先量它。
//
// 语料：两份**已标注**的真实语料
//   ① scripts/fixtures/guard-clusters-2026-10-07.json（96 条模型判「是」的边，按节点标注判真假）
//   ② scripts/fixtures/judge-gold.json（23 条，人工标注 expect=same/diff）
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SELF_KEYWORDS, FOREIGN_KEYWORDS } from '../src/lib/country-relevance';
import { clusterPairs, filterOversizedGroups } from '../src/lib/same-event';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
type FixtureCountry = {
  titles: string[];
  labels: Record<string, string>;
  edges: Array<{ a: number; b: number; sim: number }>;
};

type Row = { src: string; cc: string; a: string; b: string; same: boolean };

const rows: Row[] = [];

const fx = JSON.parse(
  readFileSync(join(FIXTURES, 'guard-clusters-2026-10-07.json'), 'utf8'),
) as { countries: Record<string, FixtureCountry> };
for (const [cc, c] of Object.entries(fx.countries)) {
  for (const e of c.edges) {
    const la = c.labels[String(e.a)];
    const lb = c.labels[String(e.b)];
    if (!la || !lb) continue;
    rows.push({ src: 'cluster', cc, a: c.titles[e.a], b: c.titles[e.b], same: la === lb });
  }
}

const gold = JSON.parse(readFileSync(join(FIXTURES, 'judge-gold.json'), 'utf8')) as {
  pairs: Array<{ a: string; b: string; expect: string }>;
};
for (const p of gold.pairs) rows.push({ src: 'gold', cc: 'az', a: p.a, b: p.b, same: p.expect === 'same' });

/** 全部对象词：本国词 + 外国词。顺序无关，只取命中集合。 */
const FOREIGN = [...new Set(FOREIGN_KEYWORDS.map((w) => w.trim().toLowerCase()))].filter(Boolean);
const SELF_FLAT: Record<string, string[]> = Object.fromEntries(
  Object.entries(SELF_KEYWORDS).map(([k, v]) => [k, v.map((w) => w.toLowerCase())]),
);

function hits(text: string, words: string[]): Set<string> {
  const t = (text || '').toLowerCase();
  const out = new Set<string>();
  for (const w of words) if (w && t.includes(w)) out.add(w);
  return out;
}

function tokens(title: string, cc: string): { self: Set<string>; foreign: Set<string> } {
  const self = hits(title, SELF_FLAT[cc] ?? []);
  const all = hits(title, FOREIGN);
  for (const s of self) all.delete(s);
  return { self, foreign: all };
}

function keyset(s: Set<string>): string {
  return [...s].sort().join('|');
}

// 三种口径
function vetoStrictDiff(a: string, b: string, cc: string): boolean {
  const ta = tokens(a, cc);
  const tb = tokens(b, cc);
  // 两边都有「对象」，且对象集合不同 ⇒ 不同事件
  if (ta.foreign.size === 0 || tb.foreign.size === 0) return false;
  return keyset(ta.foreign) !== keyset(tb.foreign);
}
function vetoInclEmpty(a: string, b: string, cc: string): boolean {
  const ta = tokens(a, cc);
  const tb = tokens(b, cc);
  if (ta.foreign.size === 0 && tb.foreign.size === 0) return false;
  return keyset(ta.foreign) !== keyset(tb.foreign);
}
function vetoDisjointOnly(a: string, b: string, cc: string): boolean {
  const ta = tokens(a, cc);
  const tb = tokens(b, cc);
  for (const x of ta.foreign) if (tb.foreign.has(x)) return false;
  return ta.foreign.size > 0 && tb.foreign.size > 0;
}

const GUARDS: Array<[string, (a: string, b: string, cc: string) => boolean]> = [
  ['严格：两边都有对象才比（不含空集对）', vetoStrictDiff],
  ['含空集：一边有对象就算不同', vetoInclEmpty],
  ['只拦「对象完全不相交」', vetoDisjointOnly],
];

console.log('「同模板、不同对象」的确定性判据 —— 两份真实标注语料上的代价/收益');
console.log(`语料合计 ${rows.length} 条对：真同事件 ${rows.filter((r) => r.same).length} / 真不同事件 ${rows.filter((r) => !r.same).length}`);
console.log('（其中 cluster 语料只覆盖模型已经判「是」的对；gold 语料是人标的）\n');

for (const [name, fn] of GUARDS) {
  let killedSame = 0;
  let killedDiff = 0;
  const perSrc: Record<string, { ks: number; kd: number }> = {};
  const examples: string[] = [];
  for (const r of rows) {
    if (!fn(r.a, r.b, r.cc)) continue;
    perSrc[r.src] = perSrc[r.src] ?? { ks: 0, kd: 0 };
    if (r.same) {
      killedSame++;
      perSrc[r.src].ks++;
      if (examples.length < 4) examples.push(`   ✗误杀真对 「${r.a.slice(0, 24)}」 ⇄ 「${r.b.slice(0, 24)}」`);
    } else {
      killedDiff++;
      perSrc[r.src].kd++;
    }
  }
  console.log(`${name}`);
  console.log(
    `  拦下真不同事件 ${killedDiff} / 共 ${rows.filter((r) => !r.same).length}` +
      `   代价：误杀真同事件 ${killedSame} / 共 ${rows.filter((r) => r.same).length}` +
      `   精确率 ${killedDiff + killedSame ? ((killedDiff / (killedDiff + killedSame)) * 100).toFixed(0) : '-'}%`,
  );
  console.log(`  分部：${Object.entries(perSrc).map(([k, v]) => `${k}(拦误${v.kd}/误杀真${v.ks})`).join(' ')}`);
  for (const e of examples) console.log(e);
  console.log('');
}

console.log('基线参照：这些对**全部**都被模型判成了「是」，也就是全部会变成合并（或进护栏）。');

// ---------------------------------------------------------------------------
// 预演：把「只拦对象完全不相交」这一条接进 pair 合并那一步，生产会变成什么样
// ---------------------------------------------------------------------------
//
// 关键不只是「拦掉几条误边」，而是**链条会不会因此断掉** —— 链条一断，
// 大组护栏就不再触发，原本被整簇丢掉的那些**真**合并（az 的制药厂 3 条、
// kg 的 16 家公司 3 条…）就能留下来。这才是这条判据的间接收益。
console.log('\n══════ 预演：接上这条判据后，各国会怎样 ══════');
console.log('（右列用节点标注算真/误合并；基线一列是线上现状）');
let totReal = 0;
let totFake = 0;
for (const [cc, c] of Object.entries(fx.countries)) {
  const before = clusterPairs(c.edges);
  const beforeKept = filterOversizedGroups(before).kept;
  const keptEdges = c.edges.filter((e) => !vetoDisjointOnly(c.titles[e.a], c.titles[e.b], cc));
  const after = clusterPairs(keptEdges);
  const { kept: afterKept, rejected } = filterOversizedGroups(after);

  const judge = (groups: number[][]) => {
    let real = 0;
    let fake = 0;
    for (const g of groups) {
      const ids = new Set(g.map((i) => c.labels[String(i)]));
      if (ids.size === 1) real += g.length - 1;
      else fake += g.length - 1;
    }
    return { real, fake, groups: groups.length };
  };
  const jb = judge(beforeKept);
  const ja = judge(afterKept);
  totReal += ja.real - jb.real;
  totFake += ja.fake - jb.fake;
  console.log(
    `  ${cc.padEnd(3)} 基线 保留${jb.groups}组(真${jb.real}/误${jb.fake})  ` +
      `→ 接判据后 保留${ja.groups}组(真${ja.real}/误${ja.fake})  护栏${rejected > 0 ? `仍触发(丢${rejected})` : '不再触发'}`,
  );
}
console.log(`  合计变化：真合并 ${totReal >= 0 ? '+' : ''}${totReal}   误合并 ${totFake >= 0 ? '+' : ''}${totFake}`);

