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
  mixedScriptTokensLatinCapitalized, latinCyrillicTokens, descendingMultiplePhrases,
  MIN_HAN_TITLE, MIN_HAN_CONTENT,
} from '../src/lib/utils';
import { isPushableText, pushExclusionReason } from '../src/lib/article-format';
import { readFileSync } from 'fs';
import { resolve } from 'path';

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
// 三之四、★ 体检指标（**故意不进闸**）：汉字 + 首字母大写拉丁片段
// ============================================================
//
// 2026-09-28：用户报 `卡赫拉莫恩·库罗诺Boyev`。判据本体在
// `utils.mixedScriptTokensLatinCapitalized` —— **它只做体检、不能进闸**，
// 因为放宽「全小写」之后必然误伤「职务中文 + 人名拉丁」这种**规定写法**。
// 这一节断言的是**这个取舍本身**：该抓的抓到、该放行的也必须放行。
// 谁要是把它接进 `translate.ts` 的闸门，这里会立刻红。

section('三之四、体检指标（不进闸）：汉字 + 首字母大写拉丁片段');

const capMustCatch: Array<[string, string]> = [
  ['卡赫拉莫恩·库罗诺Boyev被任命为乌兹别克斯坦内阁社会发展部门负责人', '用户 2026-09-28 报的原始形态'],
  ['Mukaş在任命前担任阿克套市朱纳奥Zen市副市长', '地名被译了一半（Жаңаөзен）'],
];
for (const [t, why] of capMustCatch) {
  const hits = mixedScriptTokensLatinCapitalized(t);
  ok(`抓到「${t.slice(0, 24)}…」（${why}）`, hits.length > 0, '没抓到，判据退化了');
}

// 这些都是**按现行口径正确的写法**，放宽版会误伤 —— 所以它不能当闸。
const capMustNotGate: Array<[string, string]> = [
  ['哈萨克斯坦国际象棋联合会主席Timur', '职务中文 + 人名拉丁 = 规定写法'],
  ['美国国务卿Rubio将访问撒马尔罕', '同上'],
  ['阿塞拜疆总统Ilham Aliyev出席仪式', '同上'],
];
for (const [t] of capMustNotGate) {
  const hits = mixedScriptTokensLatinCapitalized(t);
  ok(
    `放宽版**会**误伤「${t.slice(0, 24)}…」—— 这正是它不能进闸的证据`,
    hits.length > 0,
    '若这里变成 0 命中，说明判据被收紧了，请重新评估能否进闸',
  );
}

// 全大写缩写（2 个及以上连续大写）仍然放行 —— 这一条是**真的**安全，别把它也放宽掉。
const capMustAllow: Array<[string, string]> = [
  ['CEO表示公司将在哈萨克斯坦扩大投资', '大写缩写贴汉字旁（原判据就放行的正常写法）'],
  ['GDP增长带动 AIIB 贷款需求', '同上'],
];
for (const [t, why] of capMustAllow) {
  const hits = mixedScriptTokensLatinCapitalized(t);
  ok(`仍放行「${t.slice(0, 24)}…」（${why}）`, hits.length === 0, `却抓到了 ${hits.join('/')}`);
}

// ------------------------------------------------------------
// 2026-09-29：这个判据现在**多了一个用法** —— 终审（`editor-review.ts`）拿它当护栏。
//
// 为什么同一判据在两处可以有不同结论：**误报代价不对称**。
//   翻译层误报 ⇒ `translated:false` ⇒ 重试 ×3 后**静默丢稿**（少一条消息）；
//   终审误报   ⇒ 只丢掉一条**改写提议**，原稿一字不动（少改一个字）。
// 一侧是丢消息，一侧是少改字，所以「翻译层只体检、终审可进闸」不矛盾。
//
// ⚠️ 下面两条源码断言把**这个分裂本身**钉死：防止以后有人拿终审当先例，
// 把放宽版接进翻译层的闸门（那会误伤「职务中文 + 人名拉丁」这种规定写法）。
// ------------------------------------------------------------
try {
  const translateSrc = readFileSync(resolve(process.cwd(), 'src/lib/translate.ts'), 'utf8');
  const editorSrc = readFileSync(resolve(process.cwd(), 'src/lib/editor-review.ts'), 'utf8');
  ok(
    '翻译层**没有**接放宽版半译判据（接了就是误伤规定写法）',
    // 只认「调用」：translate.ts 的注释里**确实**会提到这个名字（说明为什么不用它），
    // 所以不能用 `includes` 裸匹配 —— 那样连注释都会被当成违规。
    !/\bmixedScriptTokensLatinCapitalized\s*\(/.test(translateSrc),
    '若新增的只是日志/体检用途，请把这条断言改精确到闸门那几行，不要直接删掉 —— 它拦的是「接进闸门」这件事',
  );
  ok(
    '终审**确实**用了放宽版（这是有意的取舍，别当成笔误删掉）',
    /\bmixedScriptTokensLatinCapitalized\s*\(/.test(editorSrc),
    'editor-review.ts 不再调用它了 —— 若是有意收紧，请同步改这条断言与 fixRejectReason 的注释',
  );
} catch (err) {
  ok('能读到 translate.ts / editor-review.ts 做源码断言', false, err instanceof Error ? err.message : String(err));
}

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
// 四之二、「下降 N 倍」闸（2026-09-29 新增）—— 这一类**进了闸**，双向都要钉
// ============================================================
//
// 与上面「体检指标」那一节的区别值得盯住：`mixedScriptTokensLatinCapitalized`
// 实测 5% 误伤 ⇒ **只做体检**；而本判据实测 **500 篇 0 误报** ⇒ **敢进闸**。
// 两者待遇不同，依据只有一条：实测误报率。
// 谁要是觉得「这个看着也不准，干脆别进闸」，请先看下面的 mustNotCatch 清单
// —— 它已经把刻意的放行边界写全了，不是没想过。

section('四之二、「下降 N 倍」闸（descendingMultiplePhrases）');

// (1) 必须命中：中文里逻辑不成立（1 元下调 1.5 倍 = −0.5 元）
const multMustCatch = [
  '乌兹别克斯坦大型电力用户白天电价下调1.5倍',
  '电价下调 1.5 倍',
  '电价下降了1.5倍',
  '赔偿金额下调 13000 倍',
  '成本降低2倍',
  '库存减少3倍',
  '房价下跌 2 倍',
  '销量下滑1.5倍',
  '降幅2倍',
  '补贴削减 4 倍',
  '排放量缩减 3 倍',
];
for (const s of multMustCatch) {
  ok(`必须命中：${s}`, descendingMultiplePhrases(s).length > 0);
}

// (2) 必须放行：方向是**增长**，或句式不构成「动词+数字+倍」
const multMustNotCatch = [
  '出口额增长2倍',
  '营收翻一番',
  '投资者收益提高1.5倍',
  '电价下调 33%',
  '电价降至原来的 1/1.5（约低 33%）',
  '按 1/1.5 的系数下调',
  '电价下调，幅度为原来的三分之一',
  '该指标是上季度的 1.5 倍',
  '跌幅收窄至 2%',
  '减少 3 亿元',
];
for (const s of multMustNotCatch) {
  const hit = descendingMultiplePhrases(s);
  ok(`必须放行：${s}`, hit.length === 0, JSON.stringify(hit));
}

// (3) ⚠️ **刻意放行的边界**，写成断言免得后人以为是漏写：
//     「下降至 / 降低到」与「下降了」语义不同（「降至 1.5 倍」是「变成 1.5 倍」），
//     跨过「至/到」会把误报引进来，而误报的代价是**静默丢稿**。
ok(
  '刻意放行：「下降至 1.5 倍」（至/到 另一层语义，放行以免误报）',
  descendingMultiplePhrases('电价下降至 1.5 倍').length === 0,
);
ok(
  '刻意放行：「降低到 2 倍」',
  descendingMultiplePhrases('成本降低到 2 倍').length === 0,
);

// (4) 命中时返回**原文片段**（不是布尔）—— 上游要把它拼进重试的修正指令
ok(
  '返回的是命中片段本身（要拼进修正指令）',
  descendingMultiplePhrases('电价下调 1.5 倍').includes('下调 1.5 倍'),
  JSON.stringify(descendingMultiplePhrases('电价下调 1.5 倍')),
);

// (5) 线上真实回归锚点（语料实测的两条，见 translate.ts 提示词第 7 条）
ok(
  '锚点：id=6886「白天电价下调1.5倍」（用户 2026-09-28 报的）',
  descendingMultiplePhrases('乌兹别克斯坦大型电力用户白天电价下调1.5倍').length === 1,
);
ok(
  '锚点：id=6569「生态赔偿金额下调 13000 倍」（同类，用户未报）',
  descendingMultiplePhrases('法院将生态赔偿金额下调 13000 倍').length === 1,
);
// 增长方向不得被这条锚点带偏
ok('锚点反向：同一句话改成「上调」不命中', descendingMultiplePhrases('白天下调电价').length === 0);

// (6) 与同族判据一致：必须能处理**空串 / 无数字**而不抛
ok('空串安全', descendingMultiplePhrases('').length === 0);
ok('无数字安全', descendingMultiplePhrases('电价下调').length === 0);

// ============================================================
// 五、★「拉丁 + 西里尔」同词判据（2026-09-29 进闸）
// ============================================================

section('五、★「拉丁+西里尔」同词（latinCyrillicTokens）');

// 为什么要单独一节：这条判据是**前两条闸的盲区补丁**。
// `mixedScriptTokens`（汉字+西里尔）与 `mixedScriptTokensLatin`（汉字+拉丁）
// 的锚点都是**汉字**，所以「名字被翻了一半、且那半截旁边没有汉字」这一类
// （`Kaрабалиева`／`Aйдос`／`MЧС`）**两条闸一条都抓不到**。
// 实测：1152 篇抽样里两条闸命中 0 篇，本判据 22 篇 —— 全是增量。
//
// 进闸依据（与 `mixedScriptTokens` 当年同标准）：线上 6 天 2837 篇，
// 命中 53 篇 1.87%、60 个词种**逐条人工判读、误报 0**。详见 utils 的实测表。

// ---- (1) 真实锚点：**全部取自线上语料**，不是编的样例 ----
// 每条后面注明出处，改判据时拿这些回放，别凭想象。
const lcMustCatch: Array<[string, string]> = [
  ['Aйдос', 'id=6787 标题：国防部长 Aйдос Мырзахметов（标题级，最严重）'],
  ['Мырзахметov', 'id=6195 正文：Tokayev 对 Мырзахметov 提出指示'],
  ['Kosанов', 'id=5904 正文：国防部长科沙诺夫（Dauren Kosанов）'],
  ['Kazselezащиты', 'id=6548 正文：土地保护机构 Kazselezащиты'],
  ['Akorда', 'id=6197 正文：总统府（Akorда）'],
  ['Aкорду', 'id=4761 正文：通讯社 Aкорду'],
  ['MЧС', 'id=6549 正文：紧急情况委员会（MЧС РК）'],
  ['MЧS', 'id=6548 正文：同一机构另写成了 MЧS（同一批里两种错法）'],
  ['ENPФ', 'id=5379 摘要：国家养老基金（ENPФ）'],
  ['NПЗ', 'id=4210 正文：炼油厂（NПЗ）'],
  ['MFCА', 'id=5121 正文：国际金融中心（MFCА）'],
  ['TОО', 'id=5907 摘要：TОО «ADC TAZA ALEM»'],
  ['BUТБ', 'id=4555 正文：白俄罗斯统一商品交易所（BUТБ）'],
  ['Tоксанбаева', 'id=6821 标题：运动员 Yasmina Tоксанбаева'],
  ['Kыргызалтын', 'id=5965 正文：吉尔吉斯铝业（Kыргызалтын）'],
  ['dastorкон', 'id=6132 正文：烤肉架（dastorкон）'],
  ['Kuruлtyа', 'id=5898 正文：议会（Kuruлtyа）'],
  ['N.O.Алиев', 'id=6963 标题：任命 N.O.Алиев'],
  ['«Khовар»', 'id=6325 摘要：杜尚别消息社（Amit «Khовар»）'],
  ['Janги', 'id=5439 正文：Janги Тошкент'],
];
for (const [w, why] of lcMustCatch) {
  ok(`必须命中：${w}`, latinCyrillicTokens(w).includes(w), why);
}

// ---- (2) 句子级：在真实上下文里也要抓得到 ----
ok(
  '句子级：正文里夹在中文中间时仍命中',
  latinCyrillicTokens('哈萨克斯坦计划在年底前确定第四个炼油厂（NПЗ）的参数').includes('NПЗ'),
);
ok(
  '句子级：token 边界含 ASCII 逗号时仍命中（`Shulzhенко,` —— ASCII 逗号不在分隔符集合里）',
  latinCyrillicTokens('Sofia Shulzhенко, Elizaveta Bezrukova').some((t) => t.startsWith('Shulzhенко')),
  JSON.stringify(latinCyrillicTokens('Sofia Shulzhенко, Elizaveta Bezrukova')),
);

// ---- (3) ★ 反向断言：单文字系统与正常写法**一律不许命中** ----
// 这些是「看着像、其实对」的写法；命中了就是误杀一篇好稿。
const lcMustNotCatch: Array<[string, string]> = [
  ['Мирзиёев', '纯西里尔（引用原文标题时合法）'],
  ['Mirziyoyev', '纯拉丁（人名按规定写法）'],
  ['托卡耶夫', '纯汉字'],
  ['哈萨克斯坦总统 Tokayev 会见 Google 副总裁', '职务中文 + 人名拉丁 = 规定的写法，必须放行'],
  ['米尔зиёё夫', '汉字+西里尔 ⇒ 归 mixedScriptTokens 管，不是本判据'],
  ['斯皮塔梅en区', '汉字+拉丁 ⇒ 归 mixedScriptTokensLatin 管，不是本判据'],
  ['CEO表示', '正常缩写'],
  ['60kg', '计量'],
  ['Egemen.kz', '域名'],
  ['KEGOC', '本来就通行的拉丁缩写'],
];
for (const [s, why] of lcMustNotCatch) {
  ok(`必须放行：${s}`, latinCyrillicTokens(s).length === 0, why);
}

// ---- (4) ★ 两条结构排除：都是实测出来的，不是预防性加码 ----
// 排除只会让判据**漏**、不会让它**多杀** —— 下游是「重试→丢稿」时这是唯一安全的方向。
// 排除 2 的依据：2837 篇里 2445 个 `<img src>`，其中 6 个文件名含西里尔（实测见 utils 注释）。
ok(
  '★ 排除 1：邮箱/句柄（`@`）不算混排',
  latinCyrillicTokens('info@почта.кз').length === 0,
  '含 `@` 就放行',
);
ok(
  '★ 排除 2：文件扩展名（`.<2-4 拉丁字母>`）不算混排',
  latinCyrillicTokens('фото.jpeg').length === 0,
  '这是实测里差一点就误杀的那类：`фото-2-1.jpeg` 只因连字符恰好被切开才没命中',
);
ok(
  '★ 排除 2 回放：实测那个图片文件名不命中',
  latinCyrillicTokens('Изображение-JPEG-4AF0-A230-E1-0.jpeg').length === 0 &&
    latinCyrillicTokens('https://astanatimes.com/x/фото.jpeg').length === 0,
);
// ⚠️ 反向的边界：上面的排除**不许**把真缺陷一起吞掉
ok(
  '★ 排除项不吞真缺陷：`Kosанов` 结尾不是扩展名，仍命中',
  latinCyrillicTokens('Kosанов').length === 1,
);
ok('空串安全', latinCyrillicTokens('').length === 0);

// ---- (5) 源码断言：**确实接进了闸门**（与放宽版那条方向相反）----
// 为什么这条必要：判据写在 utils 里、测试也绿，但**没接进 normalizeResult**
// 的话，线上一条都不会被拦 —— 那就是「测试全绿、功能为零」。
try {
  const src = readFileSync(resolve(process.cwd(), 'src/lib/translate.ts'), 'utf8');
  ok(
    '翻译层**确实**调用了 latinCyrillicTokens',
    /\blatinCyrillicTokens\s*\(/.test(src),
    '只在 utils 里定义、没在闸门里调用 = 判定永远为 0',
  );
  ok(
    '闸门判定 `ok` 里带上了 latinCyr.length === 0',
    /latinCyr\.length\s*===\s*0/.test(src),
    '没进 ok 的话，命中也不会判不合格',
  );
  ok(
    "命中时走 'latin-cyrillic' 这个 kind（修正指令据此换措辞）",
    src.includes("'latin-cyrillic'"),
    'kind 不区分的话，重试会给「汉字+字母」那套答非所问的示例',
  );

  // ⚠️ 「接进闸门」只保证行为正确；**它有没有上线**是另一件事。
  // 2026-09-29 上午就在这上面绕过远路：`git push` 即部署，但没有可观测指纹
  // ⇒「没上线」和「上线了但没效果」分不开。探针必须**跑一次真判据**，
  // 不能是手写的 `true`（闸被删掉之后它还是 true）。
  const pushSrc = readFileSync(resolve(process.cwd(), 'src/app/api/wechat/push/route.ts'), 'utf8');
  ok(
    '★ `codeVersion` 里有本闸的**活体探针**（跑一次真判据，不是手写的 true）',
    /cyrillicLatinGateProbe:\s*latinCyrillicTokens\(/.test(pushSrc),
    '没有探针 = 「上没上线」只能靠猜，这正是 2026-09-29 上午绕远路的成因',
  );
  ok(
    '★ 探针的入参是一个**线上真实命中词**（`Aйдос`，id=6787），不是编造的样例',
    /cyrillicLatinGateProbe:[^,]*Aйдос/.test(pushSrc) && latinCyrillicTokens('Aйдос').length === 1,
    '探针词若被改成干净词，值会变成 0，等于探针失效',
  );
} catch (err) {
  ok('能读到 translate.ts 做源码断言', false, err instanceof Error ? err.message : String(err));
}

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
