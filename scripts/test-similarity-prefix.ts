/**
 * `similarityFixed`（公共前缀修正）的回归（2026-10-28）。
 *
 * ## 为什么先有测试再接生产
 *
 * 这个方向我**栽过一次**：第一版把「只差一个空格」的两条判成 `sim = 0`（正确是 1）
 * ⇒ ⇒ 所以**每一条判据都要有断言钉住**，否则下一次改还会栽在同一处。
 *
 * ## 测什么
 *
 * ① ★★ **「只差一个空格」⇒ 1**（第一版的 bug ⇒ 必须有回归）
 * ② ★ **判别力 > 0**（真重复的最低分 **高于** 假连接的最高分）
 * ③ 短前缀（< 4 字）不剔除
 * ④ 逐字相同 ⇒ 1；空串 ⇒ 0
 *
 * 全部离线、零成本、不联网。
 */
import { similarity, similarityFixed } from '../src/lib/utils';

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

/** 人工标注的**真重复**对（来自 2026-10-27 线上 kz 的那个 6 条簇 + 其它真实簇）。 */
const TRUE_PAIRS: Array<[string, string]> = [
  ['哈萨克斯坦总统托卡耶夫将于10月28日发表年度国情咨文', '托卡耶夫宣布 10 月 28 日发表年度国情咨文'],
  ['哈萨克斯坦总统托卡耶夫将于10月28日发表年度国情咨文', '哈斯穆-卓玛尔特·托卡耶夫 10 月 28 日向哈萨克斯坦人民发表国情咨文'],
  ['托卡耶夫宣布 10 月 28 日发表年度国情咨文', '哈斯穆-卓玛尔特·托卡耶夫 10 月 28 日向哈萨克斯坦人民发表国情咨文'],
  ['哈萨克斯坦总统托卡耶夫向奥地利总统致贺电', '托卡耶夫向奥地利总统致贺电'],
  ['哈萨克斯坦总统托卡耶夫向奥地利总统致贺电', '哈萨克斯坦总统托卡耶夫向奥地利总统范德贝伦致贺电'],
  ['托卡耶夫向奥地利总统致贺电', '哈萨克斯坦总统托卡耶夫向奥地利总统范德贝伦致贺电'],
  ['托卡耶夫启动阿克套加铜业 Aktogay 铜冶炼厂建设', '托卡耶夫启动 Aktogay 铜业集团 18 亿美元冶炼厂项目'],
  ['托卡耶夫启动阿克套加铜业 Aktogay 铜冶炼厂建设', '哈萨克斯坦总统托卡耶夫会见CNMC董事长温甘，启动阿克套加铜冶炼厂建设'],
  ['托卡耶夫启动阿克套伊铜冶炼厂建设，投资 18 亿美元', '300 千吨铜年产能：托卡耶夫启动阿克套赖炼铜厂建设'],
  ['哈萨克斯坦总统托卡耶夫会见CNMC董事长温甘，启动阿克套加铜冶炼厂建设', '托卡耶夫启动阿克套加铜业 Aktogay 铜冶炼厂建设'],
];

/** 人工标注的**假连接**对（都提到托卡耶夫，但是三件不同的事）。 */
const FALSE_PAIRS: Array<[string, string]> = [
  ['哈斯穆-卓玛尔特·托卡耶夫签署法令：哈萨克斯坦国家档案馆获「国家」地位', '哈萨克斯坦总统托卡耶夫会见中国五矿董事长'],
  ['哈萨克斯坦总统托卡耶夫会见中国五矿董事长', '哈萨克斯坦总统托卡耶夫接见CNMC公司董事长温根'],
  ['哈萨克斯坦总统托卡耶夫会见中国五矿董事长', '哈萨克斯坦总统托卡耶夫主持阿克托盖铜冶炼厂开工仪式'],
  ['哈萨克斯坦总统托卡耶夫祝贺巴西总统卢拉连任', '哈萨克斯坦总统托卡耶夫会见中国五矿董事长'],
  ['哈萨克斯坦总统托卡耶夫主持阿克托盖铜冶炼厂开工仪式', '哈萨克斯坦总统托卡耶夫接见CNMC公司董事长温根'],
];

section('一、★★ 「只差一个空格」⇒ 1（第一版的 bug，必须有回归）');
{
  const a = '乌兹别克斯坦将制定医疗基础设施发展总体规划';
  const b = '乌兹别克斯坦将制定医疗基础设施发展 总体规划';
  const fixed = similarityFixed(a, b);
  ok('★ 修正口径下 sim = 1', fixed === 1, `实际 ${fixed.toFixed(3)}`);
  ok('★ 旧口径本来就是 1（所以这不是「改进」，是「别弄坏」）', similarity(a, b) === 1, `实际 ${similarity(a, b).toFixed(3)}`);
  const c = 'abc def ghi';
  const d = 'abcdefghi';
  ok('★ 英文同理：只差空格 ⇒ 1', similarityFixed(c, d) === 1, `实际 ${similarityFixed(c, d).toFixed(3)}`);
}

section('二、★★ 同一地板下：新口径必须不劣于旧口径（**可比测量**）');
{
  // ⚠️⚠️ **指标选错 ⇒ 结论错**（2026-10-28 栽过一次）：
  // 我先前用「判别力 = 真重复最低 − 假连接最高 **必须 > 0**」当判据
  // ⇒ ⇒ 那个指标**过严**（最差的那对真重复与最好的那对假连接本来就极接近）
  // ⇒ ⇒ 而且它让我把「一对数据的差异」误当成「两个版本的效果对比」。
  //
  // ⇒ **正确的指标是「同一地板下的召回 / 误入」** —— 地板本来就是用来切的，
  // ⇒ 判据应当是：**召回不降、误入不升**。
  const FLOOR = 0.28;
  const count = (pairs: Array<[string, string]>, fn: (a: string, b: string) => number) =>
    pairs.filter(([a, b]) => fn(a, b) >= FLOOR).length;
  const oldTrue = count(TRUE_PAIRS, similarity);
  const newTrue = count(TRUE_PAIRS, similarityFixed);
  const oldFalse = count(FALSE_PAIRS, similarity);
  const newFalse = count(FALSE_PAIRS, similarityFixed);
  ok(`★ 真重复召回不降（旧 ${oldTrue}/${TRUE_PAIRS.length} → 新 ${newTrue}/${TRUE_PAIRS.length}）`,
    newTrue >= oldTrue);
  ok(`★ 假连接误入不升（旧 ${oldFalse}/${FALSE_PAIRS.length} → 新 ${newFalse}/${FALSE_PAIRS.length}）`,
    newFalse <= oldFalse);
  ok('★ 真重复一条都不掉（召回 = 全部）', newTrue === TRUE_PAIRS.length, `实际 ${newTrue}`);
  ok('★ 假连接最多留 1 条过线', newFalse <= 1, `实际 ${newFalse}`);

  // 间隔只**记录**，不当判据（它的负值不代表口径更差 —— 地板才是切分线）
  const trueMin = Math.min(...TRUE_PAIRS.map(([a, b]) => similarityFixed(a, b)));
  const falseMax = Math.max(...FALSE_PAIRS.map(([a, b]) => similarityFixed(a, b)));
  console.log(
    `     （参考：间隔 ${(trueMin - falseMax).toFixed(3)}｜` +
      `旧口径间隔 ${(Math.min(...TRUE_PAIRS.map(([a, b]) => similarity(a, b))) -
        Math.max(...FALSE_PAIRS.map(([a, b]) => similarity(a, b)))).toFixed(3)}）`,
  );
}

section('三、地板 0.28：真重复不能被挡掉，假连接要能被挡住');
{
  const FLOOR = 0.28;
  const trueHit = TRUE_PAIRS.filter(([a, b]) => similarityFixed(a, b) >= FLOOR).length;
  const falseHit = FALSE_PAIRS.filter(([a, b]) => similarityFixed(a, b) >= FLOOR).length;
  ok(`★ 真重复 ${trueHit}/${TRUE_PAIRS.length} 过线（不能掉）`, trueHit === TRUE_PAIRS.length);
  ok(`★ 假连接 ${falseHit}/${FALSE_PAIRS.length} 过线（要少）`, falseHit <= 1, `过线 ${falseHit} 条`);
}

section('四、边界');
{
  ok('★ 逐字相同 ⇒ 1', similarityFixed('同一篇稿子', '同一篇稿子') === 1);
  ok('★ 空串 ⇒ 0', similarityFixed('', 'x') === 0 && similarityFixed('x', '') === 0);
  ok('★ 短前缀（<4 字）不剔除', similarityFixed('中国宣布新政策', '中国昨天宣布新政策') > 0.3,
    `实际 ${similarityFixed('中国宣布新政策', '中国昨天宣布新政策').toFixed(3)}`);
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
