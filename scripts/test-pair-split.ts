/**
 * `pair-split`（超限簇「簇内再问一次」）的回归（2026-10-27）。
 *
 * ## 为什么要有这个
 *
 * 线上实测（2026-10-27）：kz 有一个 **6 条的簇**因超过 `MAX_GROUP_SIZE=4` 被**整簇丢弃**
 * ⇒ ⇒ 簇里「感谢各国领导人祝贺共和国日」×2、「向奥地利总统致贺电」×2 两组**真重复**全漏了
 * ⇒ ⇒ 用户在草稿里看到重复。
 *
 * ## 测什么
 *
 * ① 超限簇 ⇒ 模型在簇内细分 ⇒ **子组被采信**、整簇不再被丢
 * ② 不超限的簇 ⇒ **不额外问模型**（成本不增）
 * ③ 模型失败 / 返回不合法 ⇒ **退回「整簇丢弃」**（不会比原来更差）
 * ④ 成本上限 ⇒ 问的次数有硬顶
 * ⑤ 下标映射 ⇒ 子组的相对下标要正确映回原始下标
 *
 * 全部离线（用 `ask` 注入假模型），不联网、不配 Key。
 */
import { splitOversizedClusters, MAX_GROUP_SIZE } from '../src/lib/same-event';

let passed = 0;
const failures: string[] = [];

function section(name: string): void {
  console.log(`\n${'-'.repeat(60)}\n${name}\n${'-'.repeat(60)}`);
}
function ok(desc: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${desc}`);
  } else {
    failures.push(`${desc}${detail ? `　→ ${detail}` : ''}`);
    console.log(`  ✗ ${desc}${detail ? `　→ ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const items = Array.from({ length: 8 }, (_, i) => ({ title: `稿件${i}`, summary: `摘要${i}` }));

  section('一、超限簇：模型在簇内细分 ⇒ 子组被采信');
  {
    let asked = 0;
    const res = await splitOversizedClusters(
      [[0, 1, 2, 3, 4, 5]],
      items,
      {
        ask: async () => {
          asked++;
          // 簇内相对下标：0-2 一组、3-5 一组
          return { ok: true, text: JSON.stringify({ groups: [[0, 1, 2], [3, 4, 5]] }) };
        },
      },
    );
    ok('★ 超限簇被拆分后保留了两个子组', res.kept.length === 2, `kept=${JSON.stringify(res.kept)}`);
    ok('★ 子组下标正确映回原始下标',
      JSON.stringify(res.kept) === JSON.stringify([[0, 1, 2], [3, 4, 5]]),
      JSON.stringify(res.kept));
    ok('★ 整簇不再被丢弃（rejected=0）', res.rejected === 0, `rejected=${res.rejected}`);
    ok('★ 实际问了一次模型', res.splitsAsked === 1 && asked === 1, `splitsAsked=${res.splitsAsked} asked=${asked}`);
  }

  section('二、不超限的簇：★ 不额外问模型（成本不增）');
  {
    let asked = 0;
    const small = Array.from({ length: MAX_GROUP_SIZE }, (_, i) => i);
    const res = await splitOversizedClusters(
      [small],
      items,
      { ask: async () => { asked++; return { ok: true, text: '{"groups":[[0,1]]}' }; } },
    );
    ok('★ 小簇原样保留', res.kept.length === 1 && JSON.stringify(res.kept[0]) === JSON.stringify(small));
    ok('★ 没有问模型', asked === 0 && res.splitsAsked === 0, `asked=${asked}`);
  }

  section('三、模型失败：★ 退回「整簇丢弃」（不会比原来更差）');
  {
    const res = await splitOversizedClusters(
      [[0, 1, 2, 3, 4, 5]],
      items,
      { ask: async () => ({ ok: false, error: '模型不可用' }) },
    );
    ok('★ 失败时整簇丢弃（与旧行为一致）', res.rejected === 1 && res.kept.length === 0);
    ok('★ 失败被记进 splitFailed', res.splitFailed === 1, `splitFailed=${res.splitFailed}`);
    ok('★ 失败也记了 splitsAsked（成本照实算）', res.splitsAsked === 1);
  }
  {
    const res = await splitOversizedClusters(
      [[0, 1, 2, 3, 4, 5]],
      items,
      { ask: async () => ({ ok: true, text: '这不是合法 JSON' }) },
    );
    ok('★ 返回不合法 JSON 时也退回整簇丢弃', res.rejected === 1 && res.kept.length === 0);
  }

  section('四、成本上限：★ 问的次数有硬顶');
  {
    let asked = 0;
    const big = [
      [0, 1, 2, 3, 4, 5],
      [0, 1, 2, 3, 4, 5],
      [0, 1, 2, 3, 4, 5],
      [0, 1, 2, 3, 4, 5],
    ];
    const res = await splitOversizedClusters(
      big,
      items,
      { ask: async () => { asked++; return { ok: true, text: '{"groups":[[0,1,2],[3,4,5]]}' }; } },
      MAX_GROUP_SIZE,
      3,
    );
    ok('★ 只问了 3 次（硬上限生效）', res.splitsAsked === 3 && asked === 3, `splitsAsked=${res.splitsAsked} asked=${asked}`);
    ok('★ 第 4 个簇按旧行为整簇丢弃', res.rejected === 1, `rejected=${res.rejected}`);
  }

  section('五、下标映射：★ 子簇下标是「簇内相对下标」');
  {
    const res = await splitOversizedClusters(
      [[2, 3, 4, 5, 6, 7]],
      items,
      { ask: async () => ({ ok: true, text: '{"groups":[[0,1,2],[3,4,5]]}' }) },
    );
    ok('★ 相对下标 0-2 映回原始 2-4', JSON.stringify(res.kept[0]) === JSON.stringify([2, 3, 4]), JSON.stringify(res.kept[0]));
    ok('★ 相对下标 3-5 映回原始 5-7', JSON.stringify(res.kept[1]) === JSON.stringify([5, 6, 7]), JSON.stringify(res.kept[1]));
  }

  console.log(`\n${'='.repeat(64)}`);
  if (failures.length === 0) {
    console.log(`✅ 全部通过：${passed} 项断言`);
    process.exit(0);
  } else {
    console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

void main();
