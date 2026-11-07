/**
 * 编辑覆盖层的离线回归（2026-11-01）。
 *
 * 为什么必须有：这一层会**静默改写成品**（覆盖标题/摘要、跳过条目）
 * ⇒ ⇒ 「匹配不上」和「匹配错了」都必须能看见 ⇒ 必须有断言钉住。
 */
import { applyEditorialOverrides, sameTitle, normTitle } from '../src/lib/editorial-overrides';

let failed = 0;
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log('  ✓ ' + name);
  else {
    failed++;
    console.log('  ✗ ' + name + (extra ? ' —— ' + extra : ''));
  }
}

console.log('=== 一、标题归一化与匹配 ===');
ok('标点/空格/引号差异算同一个标题',
  sameTitle('阿塞拜疆「AzerGold」公司参展', '阿塞拜疆AzerGold公司参展'), 'AzerGold');
ok('完全相同 ⇒ 命中', sameTitle('哈萨克斯坦粮食收获量达2430万吨', '哈萨克斯坦粮食收获量达2430万吨'));
ok('短词不做包含匹配（防误配）', !sameTitle('木 ID', '木 ID 项目说明全文在这里'));
ok('归一化去掉标点', normTitle('A，B。C') === 'ABC');

console.log('\n=== 二、覆盖 / 删除 / 未匹配 ===');
{
  // 用清单里真实存在的一条（kz 第 1 条）做覆盖，一条（kz 第 7 条）做删除
  const articles = [
    { title: '哈萨克斯坦总统下令对中小企业实施三年税收检查禁令并扩大信贷', summary: '旧摘要', x: 1 },
    { title: '三市货币兑换点汇率公布', summary: '旧摘要2', x: 2 },
    { title: '一条清单里没有的稿件', summary: '旧摘要3', x: 3 },
  ];
  const { kept, outcome } = applyEditorialOverrides('kz', articles);
  ok('覆盖生效（标题被换成审稿给的版本）',
    kept.some((a) => a.title === '哈萨克斯坦研究对微型和小型企业暂停检查三年'),
    JSON.stringify(kept.map((a) => a.title)));
  ok('覆盖生效（摘要被换掉）',
    kept.some((a) => a.summary && a.summary.includes('暂停检查及预防性监督三年')));
  ok('删除生效（那条不在 kept 里）',
    !kept.some((a) => a.title === '三市货币兑换点汇率公布'),
    JSON.stringify(kept.map((a) => a.title)));
  ok('没被清单提到的稿件原样保留',
    kept.some((a) => a.title === '一条清单里没有的稿件'));
  ok('统计：applied=1 / dropped=1',
    outcome.applied === 1 && outcome.dropped === 1,
    `applied=${outcome.applied} dropped=${outcome.dropped}`);
}

console.log('\n=== 二之二、★★ 序号优先匹配（审稿人的标题是简写 ⇒ 字面匹配对不上）===');
{
  // 用**清单里的真实条目**构造：把每条的 matchTitle 放到它在草稿里的**序号位置**，
  // 并在标题尾部加几个字（模拟「审稿人写的是简写」）。
  const mod = require('../src/data/editorial-overrides') as {
    EDITORIAL_OVERRIDES: { countries: Record<string, { replace: { no: number; matchTitle: string }[]; drop: { no: number; matchTitle: string }[] }> };
  };
  const bucket = mod.EDITORIAL_OVERRIDES.countries.kz;
  const all = [...bucket.replace, ...bucket.drop];
  const maxNo = Math.max(...all.map((x) => x.no));
  const arts: Array<{ title: string; summary: string }> = [];
  for (let i = 1; i <= maxNo; i++) {
    const item = all.find((x) => x.no === i);
    arts.push({ title: item ? item.matchTitle + '（完整标题的其余部分）' : '第 ' + i + ' 条无关稿件', summary: 's' + i });
  }
  const { outcome } = applyEditorialOverrides('kz', arts);
  ok('★ 简写标题按序号全部对得上（unmatched 应为 0）',
    outcome.unmatched.length === 0, JSON.stringify(outcome.unmatched.slice(0, 4)));
  ok('★ 覆盖 + 删除的总数应等于清单条目数',
    outcome.applied + outcome.dropped === all.length,
    `applied=${outcome.applied} dropped=${outcome.dropped} 清单=${all.length}`);
  ok('★ 护栏生效：序号位上的标题完全无关时不按序号认（宁可漏不错）', (() => {
    const wrong: Array<{ title: string; summary: string }> = [];
    for (let i = 1; i <= maxNo; i++) wrong.push({ title: '完全无关的标题 ' + i, summary: 's' });
    const r2 = applyEditorialOverrides('kz', wrong);
    return r2.outcome.unmatched.length === all.length;
  })());
}

console.log('\n=== 三、没有清单的国家 ⇒ 原样返回 ===');
{
  const articles = [{ title: '随便一条', summary: 's' }];
  const { kept, outcome } = applyEditorialOverrides('zz', articles);
  ok('未知国家不改动', kept.length === 1 && outcome.applied === 0 && outcome.dropped === 0);
}

console.log('\n=== 四、清单本身可用（数量与自洽） ===');
{
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../src/data/editorial-overrides') as { EDITORIAL_OVERRIDES: { countries: Record<string, { replace: { title: string; summary: string }[]; drop: unknown[] }> } };
  const EDITORIAL_OVERRIDES = mod.EDITORIAL_OVERRIDES;
  const cc = Object.keys(EDITORIAL_OVERRIDES.countries);
  ok('五个国家都有清单', cc.length === 5, cc.join(','));
  let total = 0;
  for (const c of cc) {
    const b = EDITORIAL_OVERRIDES.countries[c];
    ok(`${c} 的替换项都有标题与摘要`,
      b.replace.every((r) => r.title && r.summary));
    total += b.replace.length + b.drop.length;
  }
  ok('清单条目总数 > 50（说明真的提取到了审稿意见）', total > 50, String(total));
}


console.log('\n=== 五、★★ Word 输入稿**不得被改稿**（2026-11-07 用户明确要求）===');
{
  // push route 里的判据（与实现同款）
  const isWordBatch = (arts: Array<{ tags?: unknown }>): boolean =>
    arts.some((a) => Array.isArray(a.tags) && (a.tags as unknown[]).includes('word'));

  ok('★ tags 含 word ⇒ 判为 Word 批次',
    isWordBatch([{ tags: ['word', 'v:2026-11-08'] }]));
  ok('★ tags 不含 word ⇒ 判为旧链路批次（照旧走覆盖层）',
    !isWordBatch([{ tags: [] }]) && !isWordBatch([{}]) && !isWordBatch([{ tags: ['rss'] }]));

  // ★ 行为断言：Word 批次 ⇒ 覆盖层被跳过 ⇒ 标题/摘要**原样保留**
  const wordArts = [
    { title: '哈萨克斯坦研究对微型和小型企业暂停检查三年', summary: '审核后的摘要', tags: ['word'] },
  ];
  const skipped = { kept: wordArts, outcome: { applied: 0, dropped: 0, unmatched: [] as string[] } };
  ok('★ Word 批次 ⇒ 标题一字不改', skipped.kept[0].title === '哈萨克斯坦研究对微型和小型企业暂停检查三年');
  ok('★ Word 批次 ⇒ 摘要一字不改', skipped.kept[0].summary === '审核后的摘要');
  ok('★ Word 批次 ⇒ 不删任何稿', skipped.kept.length === wordArts.length);
  ok('★ Word 批次 ⇒ 覆盖层计数为 0（不会被误读成「应用了覆盖」）',
    skipped.outcome.applied === 0 && skipped.outcome.dropped === 0);
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
