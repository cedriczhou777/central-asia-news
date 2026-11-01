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

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
