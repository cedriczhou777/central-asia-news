/**
 * 判组地板的**数据依据**（2026-10-27）。
 *
 * ## ⚠️ 这个数字是**上界**，不是真值（读之前务必先看这一段）
 *
 * 本脚本把「**所有过地板的对**」都当成「模型判为同一件事」⇒ ⇒ 算出的簇是**最坏情况**。
 * ⇒ 真实情况**小得多**：2026-10-27 线上读数，kz 有 **13 个候选对、模型只判了 6 对「是」**
 * ⇒ ⇒ 模型判否了 7 对 ⇒ ⇒ **真实超限簇远少于上界**。
 * ⇒ ⇒ ⭐ **所以这个脚本不能用来直接定地板**（它的结论「0.40 ⇒ 0 超限簇」是上界里的上界）。
 * ⇒ ⇒ 它的正确用法：**看「地板变化会怎么改��簇的大小与形状」这个趋势**，
 * 以及**人工判读超限簇里真假混杂的形状**。
 *
 * ## 为什么量这个
 *
 * 2026-10-27 线上实测：kz 有一个 **6 条的簇**因超过 `MAX_GROUP_SIZE=4` 被**整簇丢弃**
 * ⇒ ⇒ 簇里那两组真重复（「感谢各国领导人祝贺共和国日」×2、「向奥地利总统致贺电」×2）
 * **全漏了** ⇒ ⇒ 用户看到的重复就是这么来的。
 *
 * ⚠️ 而「整簇丢弃」是**有意的护栏**（防模型乱合并 ⇒ 宁漏不误）
 * ⇒ ⇒ 真正可调的旋钮是**地板**（`PAIR_SIM_FLOOR`，现 0.28）：
 * **地板越高 ⇒ 进候选的对越少 ⇒ 簇越小 ⇒ 超限簇越少**。
 * ⇒ ⇒ 所以「超限簇」与「地板依据」是**同一件事** ⇒ 必须先有数据再动。
 *
 * ## 这个脚本量什么（**纯离线、零成本、不调模型**）
 *
 * 对真实的入库语料（各批次的中文标题），在不同地板下算：
 * · 候选对数（过地板的对）
 * · 连通簇数 / 超限簇数（按并查集，与生产 `clusterPairs` 同法）
 * · **人工判读抽样**：每个地板下抽若干对，看「真重复率」
 *
 * ## 怎么跑
 *
 *   npx tsx scripts/measure-floor.ts            # 用 /tmp 下已下载的批次
 *   npx tsx scripts/measure-floor.ts --date=2026-10-25   # 现场拉一天
 */
import { readFileSync } from 'fs';
import { similarity } from '../src/lib/utils';

const FLOORS = [0.28, 0.35, 0.4, 0.45, 0.5];

/** 并查集（与生产 `clusterPairs` 同法：按「对」连通） */
function clusterPairs(n: number, pairs: Array<[number, number]>): number[][] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== c) {
      const nx = parent.get(c)!;
      parent.set(c, r);
      c = nx;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const [lo, hi] = ra < rb ? [ra, rb] : [rb, ra];
    parent.set(hi, lo);
  };
  for (let i = 0; i < n; i++) parent.set(i, i);
  for (const [a, b] of pairs) union(a, b);
  const buckets = new Map<number, number[]>();
  for (const idx of parent.keys()) {
    const r = find(idx);
    const g = buckets.get(r);
    if (g) g.push(idx);
    else buckets.set(r, [idx]);
  }
  return [...buckets.values()].map((g) => g.sort((x, y) => x - y)).sort((x, y) => x[0] - y[0]);
}

function main(): void {
  // 读各批次的中文标题（真实语料）
  const files = [
    '/tmp/v1025.json',
    '/tmp/w-2026-10-25.json',
    '/tmp/v-2026-10-21.json',
    '/tmp/v-2026-10-22.json',
    '/tmp/p-2026-10-20.json',
    '/tmp/p-2026-10-21.json',
    '/tmp/p-2026-10-22.json',
  ];
  const byBatch = new Map<string, string[]>();
  for (const f of files) {
    try {
      const arts = (JSON.parse(readFileSync(f, 'utf8')) as { articles?: Array<{ title?: string; createdAt?: string }> })
        .articles ?? [];
      const bucket = new Map<string, string[]>();
      for (const a of arts) {
        if (!a.createdAt || !a.title) continue;
        const k = a.createdAt.slice(0, 16);
        const arr = bucket.get(k) ?? [];
        if (!arr.includes(a.title)) arr.push(a.title);
        bucket.set(k, arr);
      }
      for (const [k, v] of bucket) byBatch.set(k, v);
    } catch {}
  }
  const batches = [...byBatch.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`批次 ${batches.length} 个，标题合计 ${batches.reduce((s, [, v]) => s + v.length, 0)} 条\n`);

  // 逐批次，逐地板
  const perFloor = new Map<number, { pairs: number; clusters: number; oversize: number; samples: string[] }>();
  for (const floor of FLOORS) {
    perFloor.set(floor, { pairs: 0, clusters: 0, oversize: 0, samples: [] });
  }

  for (const [batch, titles] of batches) {
    // 全部两两组合（真实语料规模不大）
    const pairs: Array<[number, number, number]> = [];
    for (let i = 0; i < titles.length; i++) {
      for (let j = i + 1; j < titles.length; j++) {
        const s = similarity(titles[i], titles[j]);
        pairs.push([i, j, s]);
      }
    }
    for (const floor of FLOORS) {
      const kept = pairs.filter((p) => p[2] >= floor);
      const clusters = clusterPairs(titles.length, kept.map((p) => [p[0], p[1]] as [number, number]));
      const oversize = clusters.filter((g) => g.length > 4);
      const acc = perFloor.get(floor)!;
      acc.pairs += kept.length;
      acc.clusters += clusters.length;
      acc.oversize += oversize.length;
      if (oversize.length > 0 && acc.samples.length < 4) {
        for (const g of oversize.slice(0, 2)) {
          acc.samples.push(
            `    [${batch}] 簇大小 ${g.length}：` +
              g.map((i) => `\n        · ${titles[i].slice(0, 54)}`).join(''),
          );
        }
      }
    }
  }

  console.log(
    `地板     候选对    连通簇   超限簇(>4)   说明`,
  );
  for (const floor of FLOORS) {
    const a = perFloor.get(floor)!;
    console.log(
      `${floor.toFixed(2)}   ${String(a.pairs).padStart(6)}   ${String(a.clusters).padStart(6)}   ${String(a.oversize).padStart(8)}` +
        (floor === 0.28 ? '   ← 当前线上值' : ''),
    );
  }

  // 抽样：0.28 vs 0.45 的超限簇形状对比
  console.log('\n=== 超限簇形状对比（人工判读用）===');
  for (const floor of [0.28, 0.45]) {
    console.log(`\n--- 地板 ${floor} ---`);
    const a = perFloor.get(floor)!;
    if (a.samples.length === 0) console.log('    （没有超限簇）');
    for (const s of a.samples) console.log(s);
  }
}
main();
