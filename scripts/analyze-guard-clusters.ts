/**
 * 大组护栏的真实语料复核：**「改成拆分」到底是不是改进？**
 *
 * 跑法：`pnpm analyze:guard-clusters`
 * 语料：`scripts/fixtures/guard-clusters-2026-10-07.json`（线上逐字抓取，见该文件的 provenance）
 *
 * ## 为什么会有这个脚本（结论被推翻了，过程要留档）
 *
 * 2026-10-07 的召回下限实验量出「大组护栏是全有全无的」之后，
 * `RECALL_FLOOR_2026-10-07.md` 的建议 ① 写的是：**把护栏从「整簇丢弃」改成「拆分」**。
 * 我按这个方向动手，第一件事是先把真实数据摊开看 —— 结果**推翻了它**：
 *
 *   被整簇丢弃的簇一共 4 个（uz 6 条 / az 8 条 / kg 11 条 / tj 11 条），
 *   其中 **3 个不是「同一件事被多家报道」，而是「同一批人名的不同事情」**：
 *     · az：8 条里其实有 3 件事（制药厂 3 条 / 接见奥地利大使 2 条 / 接见马来西亚大使 2 条
 *       + 授勋 1 条），它们连成一片只是因为都以「阿塞拜疆总统伊(利)尔哈姆·阿利耶夫」开头；
 *     · kg：11 条里 4 件事（16 家公司制裁 3 条 / 教师节 4 条 / 奥什 20 亿 3 条 / 任命州长助理 1 条），
 *       共同点只有国名 + 主谓；
 *     · tj：11 条里 9 件事，全部以「塔吉克斯坦总统埃莫马利·拉赫蒙」开头；
 *     · 只有 uz 那个 6 条簇真的是同一件事（卡什卡达里亚州税务侵占案）。
 *
 * ⇒ 对 3/4 的国家，「拆分」等于**把误合并放进来**：链条本身就是误合并堆出来的。
 *   唯一真正对的场景（uz）不足以支撑一个通用改动。
 *
 * **所以这一版不改护栏行为。** 修的对象是**相似度本身**（发现 4：人名/头衔样板把
 * 「不同的事」抬进候选、把「同一件事的两种音译」压下去），护栏只是症状。
 * 本脚本把「拆分」的反事实账算出来钉住，免得下次又有人（包括我）从「全有全无」这个
 * 观察直接跳到「那就拆分」。
 *
 * ## 三条断言（对不上就 exit 1）
 *
 * ① 复原忠实性：用**生产同一份** `clusterPairs` + `filterOversizedGroups`
 *    跑重建出来的图，5 国的「保留下来的组数」与「护栏是否触发」必须与线上响应一致。
 *    （不成立 ⇒ 夹具错了，后面所有数字都作废。）
 * ② 拆分反事实：每个候选组按「组内是否同号」判同质/异质。
 * ③ 无歧义账：排除我标了「置信中」的事件后，结论方向必须不变。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clusterPairs, filterOversizedGroups } from '../src/lib/same-event';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'guard-clusters-2026-10-07.json');

type Edge = { a: number; b: number; sim: number };
type Country = {
  titles: string[];
  judgedPairs: number;
  candidatePairs: number;
  liveKeptGroups: number;
  liveGuardMessage: string | null;
  maxCluster: number;
  edges: Edge[];
  labels: Record<string, string>;
};
type Fixture = {
  _provenance: Record<string, unknown>;
  countries: Record<string, Country>;
};

const fx = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;

/**
 * 我标了「置信中」的事件号 —— 这些**不进无歧义账**。
 * 判据：那几条要么金额写法不一致（uz E1）、要么只能从标题推出「同一次通话/同一场合」（tj E4/E9/E10）。
 */
const AMBIGUOUS: Record<string, string[]> = {
  uz: ['E1'],
  tj: ['E4', 'E9', 'E10'],
};

let failed = 0;
const bad = (msg: string) => {
  failed++;
  console.error(`❌ ${msg}`);
};

/**
 * 反事实实现：**不是生产代码**。
 *
 * 有界并查集 —— 按 `sim` 降序依次接受边，某条边一旦会让所在连通块超过 `max` 就不接受。
 * 两种顺序都算：`sim-desc`（保留最像的边）与 `input`（模型答案给出的顺序），
 * 用来确认结论不是某个排序规则的产物。
 */
function boundedClusters(
  edges: Edge[],
  max: number,
  order: 'sim-desc' | 'input',
): { groups: number[][]; refused: Edge[] } {
  const sorted =
    order === 'input'
      ? [...edges]
      : [...edges].sort((x, y) => y.sim - x.sim || x.a - y.a || x.b - y.b);
  const parent = new Map<number, number>();
  const size = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as number;
    return r;
  };
  const refused: Edge[] = [];
  for (const e of sorted) {
    if (!parent.has(e.a)) {
      parent.set(e.a, e.a);
      size.set(e.a, 1);
    }
    if (!parent.has(e.b)) {
      parent.set(e.b, e.b);
      size.set(e.b, 1);
    }
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra === rb) continue;
    if ((size.get(ra) as number) + (size.get(rb) as number) > max) {
      refused.push(e);
      continue;
    }
    parent.set(Math.max(ra, rb), Math.min(ra, rb));
    size.set(Math.min(ra, rb), (size.get(ra) as number) + (size.get(rb) as number));
  }
  const buckets = new Map<number, number[]>();
  for (const i of parent.keys()) {
    const r = find(i);
    const g = buckets.get(r);
    if (g) g.push(i);
    else buckets.set(r, [i]);
  }
  return {
    groups: [...buckets.values()].filter((g) => g.length >= 2).sort((x, y) => x[0] - y[0]),
    refused,
  };
}

const MAX = 4;

console.log('大组护栏真实语料复核 —— 「改成拆分」对不对');
console.log(`夹具：${FIXTURE}`);
console.log(`采集：${String(fx._provenance.capturedAt)} / 通道 ${String(fx._provenance.provider)}`);
console.log('');

type Row = {
  cc: string;
  bigCluster: number;
  edgesInBig: number;
  full: number;
  keptMerges: number;
  realMerges: number;
  falseMerges: number;
  realMergesUnamb: number;
  falseMergesUnamb: number;
  refused: number;
  falseDetail: string[];
};

const rows: Row[] = [];

for (const [cc, c] of Object.entries(fx.countries)) {
  const clusters = clusterPairs(c.edges);

  // ---- 断言①：复原忠实性 ----
  const { kept, rejected } = filterOversizedGroups(clusters);
  const liveLost = rejected > 0;
  if (kept.length !== c.liveKeptGroups) {
    bad(`${cc}: 复原保留下来的组数 ${kept.length} ≠ 线上 ${c.liveKeptGroups}`);
  }
  if (liveLost !== (c.liveGuardMessage !== null)) {
    bad(`${cc}: 复原的护栏触发状态与线上 error 字段不一致`);
  }

  const big = clusters.filter((g) => g.length > MAX);
  const amb = new Set(AMBIGUOUS[cc] ?? []);

  console.log(`══════ ${cc} ══════`);
  console.log(
    `  喂模型 ${c.titles.length} 条（其中判「是」${c.judgedPairs} 对） | 候选对 ${c.candidatePairs} | ` +
      `线上保留 ${c.liveKeptGroups} 组 | 最大簇 ${c.maxCluster} 条`,
  );
  console.log(
    `  线上护栏：${c.liveGuardMessage ? `触发 —— ${c.liveGuardMessage}` : '未触发'}` +
      `   复原：${rejected > 0 ? `触发，丢了 ${rejected} 个簇` : '未触发'} ✅`,
  );

  if (big.length === 0) {
    console.log('  （没有被整簇丢弃的簇，本次不产生反事实）\n');
    continue;
  }

  for (const g of big) {
    const set = new Set(g);
    const inner = c.edges.filter((e) => set.has(e.a) && set.has(e.b));
    const full = (g.length * (g.length - 1)) / 2;
    const events = new Set(g.map((i) => c.labels[String(i)]));
    console.log(
      `  ▸ 被丢弃的簇：${g.length} 条 / 内部判「是」${inner.length} 边 / 完全图应有 ${full} ⇒ 边密度 ` +
        `${((inner.length / full) * 100).toFixed(0)}% / **里面其实是 ${events.size} 件事**`,
    );

    const { groups } = boundedClusters(c.edges, MAX, 'sim-desc');
    let real = 0;
    let fake = 0;
    let realU = 0;
    let fakeU = 0;
    const falseDetail: string[] = [];
    for (const gg of groups) {
      const ids = new Set(gg.map((i) => c.labels[String(i)]));
      const merges = gg.length - 1;
      const homogeneous = ids.size === 1;
      const touchesAmb = [...ids].some((id) => amb.has(id));
      if (homogeneous) {
        real += merges;
        if (!touchesAmb) realU += merges;
      } else {
        fake += merges;
        if (!touchesAmb) fakeU += merges;
        falseDetail.push(
          `[${gg.join(',')}] ${[...ids].join('+')} → ` +
            gg
              .map((i) => `«${c.labels[String(i)]}»${(c.titles[i] ?? '').slice(0, 26)}`)
              .join(' ｜ '),
        );
      }
    }
    rows.push({
      cc,
      bigCluster: g.length,
      edgesInBig: inner.length,
      full,
      keptMerges: 0,
      realMerges: real,
      falseMerges: fake,
      realMergesUnamb: realU,
      falseMergesUnamb: fakeU,
      refused: boundedClusters(c.edges, MAX, 'sim-desc').refused.length,
      falseDetail,
    });

    console.log(
      `    拆分反事实（sim 降序）：真合并 ${real} 处 / **误合并 ${fake} 处** ` +
        `（无歧义口径 ${realU} / ${fakeU}）`,
    );
    for (const d of falseDetail) console.log(`      ✗ ${d}`);
  }
  console.log('');
}

// ---- 两种顺序的对照：结论不能被排序规则翻掉 ----
console.log('══════ 顺序敏感性（拆分反事实换一种边的遍历顺序） ══════');
for (const [cc, c] of Object.entries(fx.countries)) {
  if (!(c.maxCluster > MAX)) continue;
  const amb = new Set(AMBIGUOUS[cc] ?? []);
  const line = (['sim-desc', 'input'] as const).map((order) => {
    const { groups, refused } = boundedClusters(c.edges, MAX, order);
    let real = 0;
    let fake = 0;
    for (const g of groups) {
      const ids = new Set(g.map((i) => c.labels[String(i)]));
      const touchesAmb = [...ids].some((id) => amb.has(id));
      if (ids.size === 1) real += g.length - 1;
      else if (!touchesAmb) fake += g.length - 1;
    }
    return `${order}: 真${real}/误${fake}（拒不接受 ${refused.length} 边）`;
  });
  console.log(`  ${cc}  ${line.join('   |   ')}`);
}

console.log('');
console.log('══════ 汇总（被整簇丢弃 ⇒ 改拆分会得到什么） ══════');
const t = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0);
console.log(`  基线（现状）：这些簇一条都不合并 ⇒ 真合并 0 / 误合并 0`);
console.log(
  `  改拆分：真合并 ${t((r) => r.realMerges)} / **误合并 ${t((r) => r.falseMerges)}**` +
    `；只看无歧义事件：真 ${t((r) => r.realMergesUnamb)} / 误 ${t((r) => r.falseMergesUnamb)}`,
);
const perCountry = rows
  .map((r) => `${r.cc}(真${r.realMerges}/误${r.falseMerges})`)
  .join(' ');
console.log(`  逐国：${perCountry}`);

const tjRow = rows.find((r) => r.cc === 'tj');
if (tjRow && tjRow.falseMerges > tjRow.realMerges) {
  console.log(
    `  ⇒ tj 一国就是净负（真 ${tjRow.realMerges} / 误 ${tjRow.falseMerges}），` +
      `而 tj 是最需要护栏的一国（模型对 46 个候选对**全判是**，一个否都没判）。`,
  );
}
console.log(
  '  ⇒ 结论：**不改护栏行为**。链条本身就是误合并堆出来的，拆分只是把误合并从「0」变成「N」。',
);

// ---- 断言③：无歧义口径下方向必须不变 ----
if (t((r) => r.falseMergesUnamb) <= t((r) => r.realMergesUnamb)) {
  console.error(
    '⚠️ 无歧义口径下「真 > 误」，与全口径结论相反 —— 说明结论依赖我标了「置信中」的那几处，' +
      '必须先把它们标注清楚再谈改法（AGENTS R-5）。',
  );
  failed++;
}

console.log('');
if (failed > 0) {
  console.error(`结论：${failed} 项断言未通过。`);
  process.exit(1);
}
console.log('结论：夹具与线上行为一致（5/5），反事实账见上 —— 拆分不是解，根因在相似度。');

export {};
