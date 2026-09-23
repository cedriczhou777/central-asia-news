/**
 * 语言闸 + 书写系统闸的离线回归（不联网、不调模型）。
 *
 * 用法：`pnpm test:zh-gate`
 *
 * ## 为什么必须有这个脚本
 *
 * 2026-09-23 把专有名词口径改成「人名/公司名/机构名保留拉丁，国名/州名/城市继续中文」之后，
 * **同一个提交里**必须把语言闸从「汉字**占比** ≥ 0.4」改成「汉字**个数** ≥ 6/60」。
 * 这两件事是**耦合**的：人名与公司名改成拉丁会把标题占比往下压，
 * 而占比判据的下游是「判不合格 → 重试 → 三次不过就丢弃该篇」，
 * 另一处下游 `isPushableText` 更是「稿子入库了却永远推不出去」。
 *
 * ⚠️ 定稿口径下**大部分**标题的占比回到 0.6–0.9（国名地名是中文），
 * 所以误杀面比「专有名词全部拉丁」那版小得多 —— 但**没有消失**：
 * 被公司名/人名占去大半的标题（如「乌兹别克斯坦总统 Mirziyoyev 会见 Google 副总裁 …」
 * 实测占比 0.31）旧判据一定会拒。下面专门用这批样例做回归。
 * 两种失败都**不报错**，只在成品里少稿子 —— 正是本项目反复踩的那类形态。
 * 谁要是把判据改回占比，这条会立刻红。
 */
import {
  isChineseText, hanCount, hanRatio, mixedScriptTokens,
  MIN_HAN_TITLE, MIN_HAN_CONTENT,
} from '../src/lib/utils';
import { isPushableText, pushExclusionReason } from '../src/lib/article-format';

let passed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function section(title: string) {
  console.log(`\n${'─'.repeat(64)}\n${title}\n`);
}

// ============================================================
// 一、汉字个数 / 占比
// ============================================================

section('一、hanCount / hanRatio');

ok('hanCount 忽略 HTML 标签与标点', hanCount('<p>你好，世界！</p>') === 4, `得到 ${hanCount('<p>你好，世界！</p>')}`);
ok('hanCount 不把拉丁字母算作汉字', hanCount('Tokayev') === 0);
ok('hanCount 不把西里尔字母算作汉字', hanCount('Токаев') === 0);
ok('hanCount 空串为 0', hanCount('') === 0);
ok('hanRatio 空串为 0（不是 NaN）', hanRatio('') === 0);

// ============================================================
// 二、★ 核心回归：新口径下的合格标题
// ============================================================

section('二、★ 核心回归：专有名词拉丁化后的合格译文不许被判不合格');

/**
 * 这几条都是**定稿口径下完全正确**的标题：
 * 人名 / 公司名 → 拉丁，国名 / 州名 / 城市 → 中文。
 *
 * ⚠️ 挑样例的标准是「**旧占比判据会拒**」—— 也就是汉字**占比** < 0.4。
 * 定稿口径下大部分标题的占比会回到 0.6–0.9（因为国名地名是中文），
 * 真正会被旧判据误杀的，是**被公司名/人名占据大半**的那些。
 */
const lowRatioTitles = [
  '乌兹别克斯坦总统 Mirziyoyev 会见 Google 副总裁 Kent Walker 讨论 YouTube 变现',
  '哈萨克斯坦 Nazarbayev 基金会与 Kazakhmys 签署 KazMunayGas 项目协议',
  '乌兹别克斯坦总统 Mirziyoyev 会见 Google 副总裁 Kent Walker',
];

for (const t of lowRatioTitles) {
  const ratio = hanRatio(t);
  ok(
    `「${t.slice(0, 24)}…」旧占比判据会拒它（占比 ${ratio.toFixed(3)} < 0.4）`,
    ratio < 0.4,
    `占比 ${ratio.toFixed(3)} —— 若这里不再是 <0.4，说明这批样例已不代表新口径，换一批`,
  );
  ok(
    `  └ 新个数判据放行它（汉字 ${hanCount(t)} ≥ ${MIN_HAN_TITLE}）`,
    isChineseText(t, MIN_HAN_TITLE),
    `汉字只有 ${hanCount(t)} 个，低于 MIN_HAN_TITLE=${MIN_HAN_TITLE} ⇒ 会静默丢稿`,
  );
}

section('二之一之二、国名/州名/城市用中文的常规标题必须放行（占比本来就够）');
for (const t of [
  '哈萨克斯坦总统 Tokayev 任命 10 名新宪法法院法官',
  '阿塞拜疆总统 Aliyev 会见瑞典新任大使',
  '阿斯塔纳机场截获 223 部未申报 iPhone 18',
  '东哈萨克斯坦州与 Kazakhmys 签署合作协议',
]) {
  ok(`放行「${t.slice(0, 28)}…」（占比 ${hanRatio(t).toFixed(3)}）`, isChineseText(t, MIN_HAN_TITLE));
}

// 反面对照：源语言原文必须被拒（源语言 ru/kk/ky/az 里汉字个数恒为 0）
section('二之二、源语言原文必须被拒（否则会把原文当译文入库）');
const sourceLangTexts = [
  'Токаев назначил 10 новых судей Конституционного суда',
  'Казакстан Конституциялык сотунун судьяларын дайындады',
  'Prezident İlham Əliyev yeni səfiri qəbul edib',
  'Таможня остановила пассажиров в Астане с 223 iPhone 18',
];
for (const t of sourceLangTexts) {
  ok(`源语言原文被拒「${t.slice(0, 24)}…」`, !isChineseText(t, MIN_HAN_TITLE));
}

// 标题闸与正文闸必须分开：同一段文本在正文闸下应被拒
section('二之三、标题闸与正文闸必须不同');
ok(
  `同一段短文本：过标题闸(${MIN_HAN_TITLE}) 但不过正文闸(${MIN_HAN_CONTENT})`,
  isChineseText('哈萨克斯坦通过法案扩大与 AIIB 合作') &&
    !isChineseText('哈萨克斯坦通过法案扩大与 AIIB 合作', MIN_HAN_CONTENT),
  '若两个阈值被调成一样，正文这一侧就形同虚设',
);
ok(`MIN_HAN_TITLE (${MIN_HAN_TITLE}) < MIN_HAN_CONTENT (${MIN_HAN_CONTENT})`, MIN_HAN_TITLE < MIN_HAN_CONTENT);

// ============================================================
// 三、书写系统闸：汉字 + 西里尔同词
// ============================================================

section('三、书写系统闸（汉字 + 西里尔挤在一个词里）');

const mustCatch = [
  '乌兹别克斯坦总统米尔зиёё夫指示启动塔什干',
  '肯еш通过决议',
  '议员Владимир Киян通过请求提醒',
  '议员DaстанBekeshev批评比什凯克市府',
  '东哈萨克斯坦州州长Нұрымбет Сақтағанов出席',
];
for (const t of mustCatch) {
  const hits = mixedScriptTokens(t);
  ok(`抓到「${t.slice(0, 22)}…」→ ${hits.join('/') || '(空)'}`, hits.length > 0);
}

// ⚠️ 这些是**故意不抓**的：误报的代价是「重试三次后静默丢稿」，不是排版难看。
section('三之二、故意不抓的（误报会静默丢稿，所以宁可不抓）');
const mustNotCatch = [
  '哈萨克斯坦运动员在60kg级别中夺冠',
  '政府批准100kg以下货物免税',
  '据当地媒体NewTimes.kz报道，此举意在简化流程',
  '哈萨克斯坦总检察院发布预警：防范针对iPhone 18的预售诈骗',
  '阿塞拜疆教育部与OpenAI签署协议',
  '该体重级别的100kg以上选手',
];
for (const t of mustNotCatch) {
  const hits = mixedScriptTokens(t);
  ok(`不误报「${t.slice(0, 24)}…」`, hits.length === 0, `却抓到了 ${hits.join('/')}`);
}
ok('干净的纯中文标题不触发', mixedScriptTokens('哈萨克斯坦总统任命宪法法院法官').length === 0);
ok('纯西里尔词不触发（那是另一回事，本闸只管「同一个词里混」）', mixedScriptTokens('Токаев назначил судей').length === 0);

// ============================================================
// 四、推送资格闸：新口径的稿子必须仍然推得出去
// ============================================================

section('四、推送资格闸（isPushableText / pushExclusionReason）');

const zhContent = '哈萨克斯坦议会于近日通过两项法案，批准政府与 AIIB 关于伙伴关系的框架协议，'
  + '旨在扩大双方在基础设施领域的合作。据 Egemen.kz 报道，此举标志着双方合作进入新阶段。'
  + '协议具体细节及未来项目规模未在报道中披露。该法案的通过将为未来在基础设施领域的投资和项目开发提供法律框架。'
  + '阿斯塔纳市与阿拉木图市的相关项目将优先纳入讨论范围，双方计划在下一年度完成首批项目的可行性评估。'
  + '哈萨克斯坦政府表示，与 AIIB 的合作将重点覆盖交通、能源与数字基础设施三个方向，'
  + '并将在年内确定首批项目的清单与出资安排。';

const newStyleTitle = '哈萨克斯坦通过法案扩大与 AIIB 合作';
ok(
  '新口径稿子仍判定为「可推送」',
  isPushableText(newStyleTitle, zhContent),
  `标题汉字 ${hanCount(newStyleTitle)} / 正文汉字 ${hanCount(zhContent)}`,
);
ok(
  'pushExclusionReason 对新口径稿子返回 null（合格）',
  pushExclusionReason({ title: newStyleTitle, content: zhContent, category: 'politics' }, 'kz') === null,
  `得到 ${pushExclusionReason({ title: newStyleTitle, content: zhContent, category: 'politics' }, 'kz')}`,
);

// 未翻译的行仍然要被挡住（历史存量里有 212 篇 tm + 16 篇 intl 这类）
ok(
  '未翻译（俄文）行仍被判 untranslated',
  pushExclusionReason({
    title: 'Токаев назначил 10 новых судей',
    content: 'Токаев назначил 10 новых судей Конституционного суда Казахстана.',
    category: 'politics',
  }, 'kz') === 'untranslated',
);
ok('空正文仍不可推送', !isPushableText(newStyleTitle, ''));

// ============================================================
// 汇总
// ============================================================

console.log(`\n${'='.repeat(64)}`);
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
