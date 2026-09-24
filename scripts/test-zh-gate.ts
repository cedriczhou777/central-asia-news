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
  isChineseText, hanCount, hanRatio, mixedScriptTokens, mixedScriptTokensLatin,
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
// 三之三、★ 书写系统闸（二）：汉字 + 小写拉丁片段 = 专名译了一半
// ============================================================

/**
 * 2026-09-24 新增。判据本体在 `utils.mixedScriptTokensLatin`。
 *
 * 为什么必须有这一节：这条判据的**误报代价是静默丢稿**（重试三次不过就丢弃），
 * 而它刚从「误报 44%」迭代到「0 误报」，中间淘汰了三类误报
 * （域名 `inbusiness.kz`、计量 `60kg`、变音符/引号切碎的人名 `G‘aniyev`）。
 * 那三类**必须留在测试里** —— 谁哪天为了「多抓一点」把规则放宽，这一节会立刻红，
 * 而不是等到线上少了一批稿子才发现。
 *
 * ⚠️ 提示词那边**早就逐字写着** `斯皮塔梅en`／`霍贾and` 作为禁止反例
 * （`translate.ts` 第 6 条），而口径改完之后它们照样出现在新产出里
 * （`阿克tau市` id=4512 / `霍贾and` id=4556）。所以别再往提示词里加例子。
 */
section('三之三、★ 书写系统闸（二）：汉字 + 小写拉丁片段（专名译了一半）');

/** 全部取自线上真实产出，括号里是文章 id —— 改判据时拿它们复现即可 */
const halfMustCatch: Array<[string, string]> = [
  ['塔吉克斯坦总统埃莫马利·拉赫蒙出席斯皮塔梅en区库鲁什村学校落成典礼', '4492 标题'],
  ['拉赫蒙于9月23日在霍贾and会晤苏盖德省主要领导人', '4491 摘要'],
  ['阿克tau市NZM工作人员醉酒状态下发生冲突', '4512 标题'],
  ['哈萨克mys公司为改善员工工作条件投入资金', '4219 摘要'],
  ['不承认格鲁吉亚茨khinvali地区所谓的公投', '4088 标题'],
  ['该地区是纳赫ichevan自治共和国的一部分', '4088 正文'],
  ['阿塞拜疆总统帕什inyan随后宣布将采取新的外交行动', '3866 正文'],
  ['塔吉克斯坦与巴林议会合作项目在曼ama举行汇报', '3603 标题'],
  ['沙霍比丁hon', '3462 标题'],
];
for (const [t, src] of halfMustCatch) {
  const hits = mixedScriptTokensLatin(t);
  ok(`抓到（${src}）「${t.slice(0, 26)}…」`, hits.length > 0, '这条是真缺陷，漏了就等于闸没起作用');
}

/**
 * 下面每一条都对应一类**实测过的误报**。第一条注释写它是为了什么。
 * 判断标准：**译文本身是正确的**，只是「汉字旁边恰好有个小写拉丁片段」。
 */
const halfMustNotCatch: Array<[string, string]> = [
  ['哈萨克斯坦运动员在60kg级别中夺冠', '计量：片段前是数字'],
  ['政府批准100kg以下货物免税', '计量：同上'],
  ['信息由inbusiness.kz报道，此举意在简化流程', '域名左半段（小写且≥2）'],
  ['该裁决援引Egemen.kz的报道', '域名右半段'],
  ['美国资产管理公司贝莱德在Banker.az报道中指出', '域名右半段'],
  ['现代.az援引RIA通讯社的报道', '域名右半段'],
  ['Cəfərli在接受Modern.az采访时表示', '变音符人名 + 域名'],
  ['Alagözov在社交媒体上发布了视频', '变音符人名（旧版被切成 Alag+zov）'],
  ['G‘aniyev因涉嫌指导企业逃税被立案', '弯引号人名（旧版被切成 G+aniyev）'],
  ['据当地媒体NewTimes.kz报道，此举意在简化流程', '域名（大写驼峰）'],
  ['哈萨克斯坦总检察院发布预警：防范针对iPhone 18的预售诈骗', '驼峰专名'],
  ['阿塞拜疆教育部与OpenAI签署协议', '大写缩写'],
  ['CEO表示公司将在哈萨克斯坦扩大投资', '大写缩写贴在汉字旁'],
  ['哈萨克斯坦 Nazarbayev 基金会与 Kazakhmys 签署协议', '按口径本应拉丁的公司名/人名'],
  ['乌兹别克斯坦总统 Mirziyoyev 会见 Google 副总裁 Kent Walker', '按口径本应拉丁的人名/公司名'],
];
for (const [t, why] of halfMustNotCatch) {
  const hits = mixedScriptTokensLatin(t);
  ok(`不误报「${t.slice(0, 26)}…」（${why}）`, hits.length === 0, `却抓到了 ${hits.join('/')}`);
}

/**
 * 已知且**接受**的漏网形态：拉丁片段在词首（`aktau市`）。
 *
 * 判据要求「片段前一个字符是汉字」，所以词首的片段抓不到。
 * 为什么接受：真实产出里这类错误的成因是「模型把专名的**前半截**音译了」，
 * 所以形态恒为「汉字在前、残片在后」；词首形态在 1977 篇语料里一条都没有。
 * 这条断言是为了让这个限制**显式**，而不是让人以为判据是全覆盖的。
 */
ok(
  '已知漏网（接受）：片段在词首的「aktau市」抓不到',
  mixedScriptTokensLatin('aktau市发生火灾').length === 0,
  '若这里开始抓到了，说明规则 2 被放宽了 —— 请重新量一遍误报率再决定',
);

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
