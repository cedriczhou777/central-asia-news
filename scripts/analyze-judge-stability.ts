/**
 * L2 判定「不稳」的**方差归因**工具：把方差拆成「通道间」与「通道内」。
 *
 * 用法（先攒若干轮线上响应，再一起喂进来）：
 *
 *   mkdir -p /tmp/jruns
 *   for i in $(seq 1 10); do
 *     curl -s "$URL/api/dedupe-check?llm=1&days=14" -o /tmp/jruns/run_$i.json
 *   done
 *   pnpm tsx scripts/analyze-judge-stability.ts /tmp/jruns
 *
 * 参数可以是**多个 json 文件**，也可以是**一个目录**（自动取目录下所有 .json）。
 *
 * ## 为什么必须有这个脚本（这是踩过两次的坑）
 *
 * L2 判定「同样输入两次结论不同」有个默认解释：「模型有随机性」。这个解释
 * **默认就被接受了两次**，两次都错，而且错法不同：
 *
 * **坑一：把通道混在一起算频率。**
 * 判定链会按可用性在 `zhipu` / `zhipu-flash` / `deepseek` 之间降级。把两种型号的
 * 结果混在一起统计「某对判『是』的比例 p」，得到的不是「模型的随机性」，
 * 而是**「这一对上，宽松的那条通道占了多大比例的调用次数」**。
 * 表现是 p 呈**双峰**（多数对 p=0 或 p=1，少数对落在中间）—— 双峰的中间那撮
 * 不是「边界案例」，是**通道切换的痕迹**。这个假象会把人引向「模型对边界案例犹豫」，
 * 而真相是「两条通道对同一对给固定但相反的答案」。
 *
 * **坑二：在「没有分歧空间」的样本上下结论。**
 * 曾用 2 天窗口（每国 1 对、全批 3 对）连跑 10 轮，看到两种通道对同一批对
 * 「结论逐次完全一致（0 分歧）」，据此写下「**通道不是原因**」。
 * 但每国只有 1 个候选对时，「一致」几乎是必然的 —— 那不是稳定，是**没有检验力**。
 * 同一套代码换 14 天窗口（每国 8–12 对），通道间立刻差出 3–8 对。
 *
 * ⇒ 所以本脚本做两件事：**按通道分组**，以及**先判有没有检验力再下结论**。
 *
 * ## 读数
 *
 *   · 「通道内标准差」= 模型的随机性（同一条通道、同一批候选，多轮之间抖多少）
 *   · 「通道间差」    = 型号差异（同一批候选，两条通道的均值差多少）
 *   · 前者远小于后者 ⇒ **型号差异是主因**，钉一条固定通道就能消除主要方差源；
 *     此时「给判定钉固定通道」是**廉价且有效**的一步，不要再被「通道不是原因」挡住。
 *   · 但钉通道只解决**可复现性**，不解决**精度**：两条通道各有各的错
 *     （实测 zhipu 在「同主题模板标题」上过度合并，zhipu-flash 对
 *     「同一件事的两种写法」漏合并），见输出的「闸门」段。
 *
 * ## 闸门段（`sim ≥ 阈值`）
 *
 * 对每条通道单独算「只有模型判『是』**且** sim ≥ 阈值 才合并」时的合并数。
 * 要点是**两条通道在同一阈值下的差**：如果差别只体现在**数量**（召回）而不是
 * 「谁留下了错的对」（精度），那说明确定性加证能把「误合并」这个危险方向压住，
 * 通道选谁就退化成召回/成本问题，而不再是正确性问题。
 *
 * ⚠️ **下面这个坑我本人在本脚本里踩过一次，写在这里免得再犯：**
 * 不要用 `(a, b)` 标题当键去 `Set`。**同一批候选里会出现标题一字不差的多对**
 * （实测 uz 的 8 个候选里有 3 对完全相同），用 Set 会把它们折叠成一个，
 * 于是「判同 7 对」被算成 5 对，整张表全错。本脚本用**多重集**（排序后的完整列表）。
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

type PairRec = { a: string; b: string; sim?: number };

type JudgeEntry = {
  country: string;
  ran?: boolean;
  candidatePairs: number;
  judgedPairs: number;
  provider?: string;
  pairs?: PairRec[];
  declined?: PairRec[];
};

type Doc = { llmJudge?: JudgeEntry[] };

/** 检验力下限：候选对少于这些时，「两条通道一致」不构成任何证据。 */
const POWER_MIN_PAIRS = 4;

/** 闸门要看的阈值。0 表示不加证（基准）。 */
const GATES = [0, 0.35, 0.45, 0.5, 0.6];

// ---------------------------------------------------------------------------
// 读文件
// ---------------------------------------------------------------------------

function collectJson(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    let st;
    try {
      st = statSync(p);
    } catch {
      console.error(`跳过（读不到）：${p}`);
      continue;
    }
    if (st.isDirectory()) {
      for (const f of readdirSync(p).sort()) {
        if (f.endsWith('.json')) out.push(join(p, f));
      }
    } else if (p.endsWith('.json')) {
      out.push(p);
    }
  }
  return out;
}

const inputPaths = process.argv.slice(2);
if (inputPaths.length === 0) {
  console.error('用法：pnpm tsx scripts/analyze-judge-stability.ts <目录|json...>');
  process.exit(2);
}

const files = collectJson(inputPaths);
if (files.length === 0) {
  console.error('没找到任何 .json。');
  process.exit(2);
}

const docs: { file: string; doc: Doc }[] = [];
for (const f of files) {
  try {
    docs.push({ file: f, doc: JSON.parse(readFileSync(f, 'utf8')) as Doc });
  } catch (e) {
    console.error(`跳过（解析失败）：${f} ${e instanceof Error ? e.message : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 按 (国家, 通道) 聚合
// ---------------------------------------------------------------------------

/** 保留重复的「判同」多重集：标题可能一字不差地重复，用 Set 会折叠掉。 */
function multiset(ps: PairRec[]): string[] {
  return ps.map((p) => `${p.a}\u0000${p.b}\u0000${p.sim ?? -1}`).sort();
}

type Cell = {
  /** 每轮判同的对数 */
  judged: number[];
  /** 每轮「判同」的多重集（用来数通道内有多少对在动摇） */
  sets: string[][];
};

/** country → provider → Cell */
const table = new Map<string, Map<string, Cell>>();
/** country → 候选对规模（应当各轮恒定；不稳的话下面会报） */
const candSize = new Map<string, Set<number>>();
/** country → pair(a\0b) → { sim, provider → [同, 异] } */
const pairView = new Map<string, Map<string, { sim: number; ch: Map<string, [number, number]> }>>();
let entryCount = 0;

for (const { file, doc } of docs) {
  for (const e of doc.llmJudge ?? []) {
    if (!e || e.candidatePairs === 0) continue; // 0 = 没真调用模型，不是数据点
    entryCount++;
    const cc = e.country;
    const prov = e.provider ?? '(未报)';
    const pairs = e.pairs ?? [];
    const declined = e.declined ?? [];

    if (e.judgedPairs !== pairs.length) {
      console.error(
        `⚠ ${file} [${cc}] judgedPairs=${e.judgedPairs} 但 pairs 有 ${pairs.length} 条 —— 字段语义可能变了，请先核对。`,
      );
    }

    const byProv = table.get(cc) ?? new Map<string, Cell>();
    table.set(cc, byProv);
    const cell = byProv.get(prov) ?? { judged: [], sets: [] };
    byProv.set(prov, cell);
    cell.judged.push(e.judgedPairs);
    cell.sets.push(multiset(pairs));

    const cs = candSize.get(cc) ?? new Set<number>();
    candSize.set(cc, cs);
    cs.add(e.candidatePairs);

    const pv = pairView.get(cc) ?? new Map<string, { sim: number; ch: Map<string, [number, number]> }>();
    pairView.set(cc, pv);
    for (const [rec, idx] of [
      ...pairs.map((p) => [p, 1] as const),
      ...declined.map((p) => [p, 2] as const),
    ]) {
      const k = `${rec.a}\u0000${rec.b}`;
      const row = pv.get(k) ?? { sim: rec.sim ?? 0, ch: new Map<string, [number, number]>() };
      if (typeof rec.sim === 'number' && rec.sim > row.sim) row.sim = rec.sim;
      const cur = row.ch.get(prov) ?? [0, 0];
      cur[idx - 1]++;
      row.ch.set(prov, cur);
      pv.set(k, row);
    }
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);

function sd(v: number[]): number | null {
  if (v.length < 2) return null; // 1 个样本估不出标准差，别报 0 骗自己
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

const f2 = (x: number) => x.toFixed(2);

/** 一条通道内，有多少对「判同」在多轮之间动摇（既同过也异过）。 */
function wavering(cell: Cell): number {
  const n = cell.sets.length;
  if (n < 2) return 0;
  const freq = new Map<string, number>();
  for (const s of cell.sets) for (const k of s) freq.set(k, (freq.get(k) ?? 0) + 1);
  let w = 0;
  for (const c of freq.values()) if (c > 0 && c < n) w++;
  return w;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

console.log(`样本：${files.length} 个文件 / ${entryCount} 次国别判定（候选对为 0 的不计）`);
const allProv = [...new Set([...table.values()].flatMap((m) => [...m.keys()]))].sort();
console.log(`出现过的通道：${allProv.join(', ') || '(无)'}`);
if (allProv.length < 2) {
  console.log(
    '\n⚠ 本批数据只用到 1 条通道 —— **无法做通道归因**。' +
      '\n   这正是历史上那次错误的形态：只看到一条通道的表现，把「通道差异」漏掉了。',
  );
}
console.log('');

const withinAll: number[] = [];
const betweenAll: number[] = [];
const unattributable: string[] = [];
let powered = 0;
let unpowered = 0;

for (const cc of [...table.keys()].sort()) {
  const provs = table.get(cc)!;
  const sizes = [...(candSize.get(cc) ?? [])];
  const nPairs = Math.max(...sizes, 0);
  const usedProvs = [...provs.keys()].sort();
  const hasPower = nPairs >= POWER_MIN_PAIRS && usedProvs.length >= 2;

  console.log('='.repeat(92));
  console.log(
    `【${cc}】候选 ${nPairs} 对` +
      (sizes.length > 1 ? `  ⚠ 各轮候选规模不一致：${sizes.join('/')}（不是同一批候选，慎比）` : '') +
      `  通道使用：${usedProvs.map((p) => `${p}×${provs.get(p)!.judged.length}`).join(' / ')}`,
  );

  for (const prov of usedProvs) {
    const cell = provs.get(prov)!;
    const s = sd(cell.judged);
    console.log(
      `   通道=${prov.padEnd(13)} n=${String(cell.judged.length).padEnd(2)}` +
        ` 判同=[${cell.judged.join(', ')}]  均值=${f2(mean(cell.judged))}` +
        `  通道内标准差=${s === null ? 'n=1 估不出' : f2(s)}` +
        `  通道内动摇的对=${wavering(cell)}`,
    );
  }

  if (usedProvs.length >= 2) {
    const gaps: number[] = [];
    for (let i = 0; i < usedProvs.length; i++) {
      for (let j = i + 1; j < usedProvs.length; j++) {
        gaps.push(Math.abs(mean(provs.get(usedProvs[i])!.judged) - mean(provs.get(usedProvs[j])!.judged)));
      }
    }
    const gap = Math.max(...gaps);
    const sds = usedProvs.map((p) => sd(provs.get(p)!.judged)).filter((x): x is number => x !== null);
    const maxSd = sds.length ? Math.max(...sds) : null;

    if (!hasPower) {
      console.log(
        `   ⚠ **无检验力**：候选只有 ${nPairs} 对` +
          (usedProvs.length < 2 ? '、且只用到 1 条通道' : '') +
          ` —— 这个规模下「两条通道一致」几乎是必然的，**不能**据此说「通道不是原因」。`,
      );
      unpowered++;
    } else {
      powered++;
      withinAll.push(...sds);
      betweenAll.push(gap);
      const dominant =
        maxSd === null
          ? '通道内标准差估不出（某条通道只有 1 次），只能看通道间差'
          : gap > 2 * maxSd
            ? `**型号差异是主因**（通道间差 ${f2(gap)} > 2×通道内标准差 ${f2(maxSd)}）`
            : maxSd > 0
              ? `通道内随机与型号差异量级相当（差 ${f2(gap)} / 标准差 ${f2(maxSd)}）`
              : `通道间有稳定差 ${f2(gap)}，且通道内为 0（各通道完全确定）`;
      console.log(`   → 通道间差 ${f2(gap)} 对；${dominant}`);
    }
  } else {
    // 只出现过一条通道：归因不了。**必须显式说出来**，否则看起来像「已检查、没问题」。
    unattributable.push(`${cc}（只用到 ${usedProvs.join('/')}）`);
    console.log(
      `   · **无法归因**：本批数据 ${cc} 只用到 1 条通道，看不到通道差异。` +
        `要归因必须等到两条通道都答过同一批候选。`,
    );
  }

  // 闸门：两条通道在同一 sim 阈值下各留几对
  const pv = pairView.get(cc);
  if (pv && pv.size > 0) {
    console.log(`   加证闸门（只有「模型判同 且 sim≥阈值」才合并），按通道分：`);
    console.log('   ' + '阈值'.padEnd(8) + usedProvs.map((p) => p.padEnd(14)).join(''));
    for (const th of GATES) {
      const cells: string[] = [];
      for (const prov of usedProvs) {
        // 该通道每一轮在闸门下的合并数
        const per: number[] = [];
        for (const { doc } of docs) {
          for (const e of doc.llmJudge ?? []) {
            if (!e || e.country !== cc || e.candidatePairs === 0) continue;
            if ((e.provider ?? '(未报)') !== prov) continue;
            per.push((e.pairs ?? []).filter((p) => (p.sim ?? 0) >= th).length);
          }
        }
        cells.push(`${f2(mean(per))} (n=${per.length})`.padEnd(14));
      }
      console.log('   ' + (th === 0 ? '基准'.padEnd(8) : f2(th).padEnd(8)) + cells.join(''));
    }
    console.log(`   闸门后仍合并的对（用于人眼核对精度，取 sim ≥ 0.5）：`);
    for (const [k, row] of [...pv.entries()].filter(([, r]) => r.sim >= 0.5).sort((a, b) => b[1].sim - a[1].sim)) {
      const [a, b] = k.split('\u0000');
      const verdicts = [...row.ch.entries()]
        .map(([p, [same, diff]]) => `${p}=${same && !diff ? '同' : diff && !same ? '异' : `${same}/${same + diff}同`}`)
        .join(' ');
      console.log(`     ${f2(row.sim)}  [${verdicts}]  「${a.slice(0, 40)}」`);
      console.log(`                              「${b.slice(0, 40)}」`);
    }
  }
  console.log('');
}

console.log('='.repeat(92));
if (unattributable.length) {
  console.log(`无法归因（单通道）：${unattributable.join('、')}`);
}
if (powered === 0) {
  console.log(
    `没有任何国家达到检验力下限（候选对 ≥ ${POWER_MIN_PAIRS} 且 ≥2 条通道），**不要下结论**。`,
  );
} else {
  console.log(
    `有检验力的国家：${powered} 个${unpowered ? `；无检验力被排除：${unpowered} 个` : ''}\n` +
      `  通道内标准差（均值/最大）：${f2(mean(withinAll))} / ${f2(Math.max(...withinAll, 0))}\n` +
      `  通道间差（均值/最大）：    ${f2(mean(betweenAll))} / ${f2(Math.max(...betweenAll, 0))}\n` +
      (mean(betweenAll) > 2 * mean(withinAll)
        ? '  ⇒ 汇总看：**型号差异是主因**。给判定钉一条固定通道是消除主要方差源的有效一步。'
        : '  ⇒ 汇总看：通道内随机与型号差异量级相当，两者都要处理。'),
  );
}
console.log(
  '\n提醒：钉固定通道只换来**可复现性**，不换来**精度** —— ' +
    '结合上面闸门段看两条通道留下的对是不是同一批；不是的话，通道选谁仍是精度问题。',
);
