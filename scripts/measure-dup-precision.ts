/**
 * **重复判定精度的金标准评测**（2026-10-27）
 *
 * ## 为什么必须有这个脚本
 *
 * 2026-10-27 同一晚内在两处栽了**同一个错**：
 * ① `pair-split` 的「两个版本对比」不可信（同一 mode 连跑两次结果不同）；
 * ② `similarityFixed` 的判据用错（「判别力必须 > 0」过严）。
 *
 * ⇒ ⇒ 两次的共同病根：**没有一把可靠的尺子**。
 * ⇒ ⇒ 这个脚本就是那把尺子：**同一批人工标注的对**，两个口径各跑一遍，
 * ⇒ ⇒ 比的是「**同一地板下的召回 / 误入**」⇒ ⇒ **地板本来就是切分线**。
 *
 * ## 读法
 *
 * · **召回**：54 条真重复里，有多少条 `sim ≥ 地板`（⇒ 会进候选、模型有机会判「是」）
 * · **误入**：6 条假连接里，有多少条 `sim ≥ 地板`（⇒ 会白花模型调用、还可能误合并）
 * · 两个都要看：**召回不降、误入不升**才算改进
 *
 * ## 用法
 *
 *   npx tsx scripts/measure-dup-precision.ts            # 默认地板 0.28
 *   npx tsx scripts/measure-dup-precision.ts 0.35       # 换地板
 */
import { similarity, similarityFixed } from '../src/lib/utils';
import { GOLD_ALL } from './fixtures/dup-goldset';

type SimFn = (a: string, b: string) => number;

function evaluate(fn: SimFn, floor: number): { tp: number; fp: number; totalTrue: number; totalFalse: number } {
  let tp = 0;
  let fp = 0;
  let totalTrue = 0;
  let totalFalse = 0;
  for (const p of GOLD_ALL) {
    const s = fn(p.a, p.b);
    if (p.same) {
      totalTrue++;
      if (s >= floor) tp++;
    } else {
      totalFalse++;
      if (s >= floor) fp++;
    }
  }
  return { tp, fp, totalTrue, totalFalse };
}

function main(): void {
  const floor = Number(process.argv[2] ?? 0.28);
  const trueCount = GOLD_ALL.filter((p) => p.same).length;
  const falseCount = GOLD_ALL.length - trueCount;
  console.log(
    `金标准：${GOLD_ALL.length} 条（真重复 ${trueCount} / 假连接 ${falseCount}）｜地板 ${floor}\n`,
  );
  console.log('口径              召回(真重复过线)   误入(假连接过线)');
  const rows: Array<[string, SimFn]> = [
    ['旧 similarity    ', similarity],
    ['新 similarityFixed', similarityFixed],
  ];
  for (const [name, fn] of rows) {
    const r = evaluate(fn, floor);
    console.log(
      `${name}   ${String(r.tp).padStart(2)}/${r.totalTrue}（${Math.round((r.tp / r.totalTrue) * 100)}%）` +
        `        ${String(r.fp).padStart(2)}/${r.totalFalse}`,
    );
  }

  console.log('\n逐条明细（只看假连接 —— 它们才是「该被挡住却没挡住」的）：');
  for (const p of GOLD_ALL.filter((x) => !x.same)) {
    const oldS = similarity(p.a, p.b);
    const newS = similarityFixed(p.a, p.b);
    console.log(
      `  旧 ${oldS.toFixed(3)} ${oldS >= floor ? '过线' : '挡下'} → 新 ${newS.toFixed(3)} ${newS >= floor ? '过线' : '挡下'}` +
        `　${p.a.slice(0, 30)}｜${p.b.slice(0, 30)}`,
    );
  }

  console.log('\n（口径说明：召回低 ⇒ 真重复被挡掉 ⇒ 用户会看到重复；误入高 ⇒ 不相关稿被送去问模型。）');
}
main();
