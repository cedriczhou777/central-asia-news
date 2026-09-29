/**
 * 「删冗余西里尔括注」确定性后处理的离线回归（不联网、不调模型）。
 *
 * 用法：`pnpm test:cyrillic-strip`
 *
 * ## 为什么这个套件必须存在（而且必须双向）
 *
 * `utils.stripCyrillicParentheticals` **会改成品文字** —— 项目里目前唯一一个
 * 会改字的确定性后处理。它没有丢稿风险，但「删多了」是**不可逆**的，
 * 所以它的回归比闸门更依赖**反例**：只测「该删的删掉了」是不够的，
 * 一个「什么都删」的实现能让所有正例全绿。
 *
 * ⇒ 三组断言缺一不可：
 *   ① 正例（**全部是线上真实命中**，每条注明 id 与字段）；
 *   ② 反例（该留的**一个字都不能动**）；
 *   ③ 源码断言（它有没有被接进 `normalizeResult`、**接在闸前还是闸后**）。
 *
 * ⚠️ 第 ③ 组里「接在闸前」那一条不是风格洁癖：实测 3528 篇里有 **18 篇**
 * 的闸命中**只**长在冗余括注内部，接在闸后等于让这 18 篇照旧走
 * 「重试 ×3 → 可能静默丢稿」。见 `translate.ts` 的 `normalizeResult` 注释。
 */
import {
  cyrillicParentheticalNotes,
  stripCyrillicParentheticals,
  mixedScriptTokens,
  mixedScriptTokensLatin,
  latinCyrillicTokens,
  descendingMultiplePhrases,
} from '../src/lib/utils';
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

/** 「删掉了这一处」= 输出里不再有原括注，且前面的可读文字还在。 */
function strips(text: string, expected: string, name: string) {
  const got = stripCyrillicParentheticals(text);
  ok(name, got === expected, `期望「${expected}」，得到「${got}」`);
}

/** 「一个字都不许动」。 */
function keeps(text: string, name: string) {
  const got = stripCyrillicParentheticals(text);
  ok(name, got === text, `期望原样，得到「${got}」`);
}

// ============================================================
// 一、★ 正例：线上真实命中，逐条注明 id / 字段（全部来自 3528 篇样本）
// ============================================================

section('一、★ 正例 —— 线上真实命中（括注该被删掉）');

strips(
  '吉尔吉斯斯坦国家税务局（ГНС）已将知名博主伊利亚·瓦尔拉莫夫列入名单。',
  '吉尔吉斯斯坦国家税务局已将知名博主伊利亚·瓦尔拉莫夫列入名单。',
  'id=6658 正文：机构缩写括注（ГНС）',
);
strips(
  '外国公司在吉尔吉斯斯坦提供在线服务所缴纳的增值税（НДС）收入同比增长了 63.9%。',
  '外国公司在吉尔吉斯斯坦提供在线服务所缴纳的增值税收入同比增长了 63.9%。',
  'id=5532 正文：专有名词括注（НДС）',
);
strips(
  '在吉尔吉斯斯坦议会（Жогорку Кенеш）的一次会议上，议员们向与会者汇报了问题。',
  '在吉尔吉斯斯坦议会的一次会议上，议员们向与会者汇报了问题。',
  'id=4614 正文：**含空格的多词**括注（Жогорку Кенеш）',
);
strips(
  '哈萨克斯坦紧急情况部（MЧС）在阿拉木图地震后对水工建筑物进行了检查。',
  '哈萨克斯坦紧急情况部在阿拉木图地震后对水工建筑物进行了检查。',
  'id=6548 正文：**混排**括注（MЧС）—— 这一条同时会被闸 4 命中，是「救回」那 18 篇的形态',
);
strips(
  '白俄罗斯统一商品交易所（BUТБ）通过其官方通讯社宣布了这一消息。',
  '白俄罗斯统一商品交易所通过其官方通讯社宣布了这一消息。',
  'id=4555 正文：混排括注（BUТБ）',
);
strips(
  '哈萨克斯坦总统 Tokayev 通过阿斯塔纳总统府（Akorда）新闻办公室表示祝贺。',
  '哈萨克斯坦总统 Tokayev 通过阿斯塔纳总统府新闻办公室表示祝贺。',
  'id=6081 摘要：混排括注（Akorда）',
);
strips(
  '哈萨克斯坦国家石油天然气公司（НАИ）与乌兹别克斯坦-吉尔吉斯斯坦发展基金（УКФР）达成协议。',
  '哈萨克斯坦国家石油天然气公司与乌兹别克斯坦-吉尔吉斯斯坦发展基金达成协议。',
  'id=6922 **标题**：同一句里**两处**括注都要删',
);
strips(
  '哈萨克国立大学（ КазНУ）附近区域突发巨响，扬起大量尘土。',
  '哈萨克国立大学附近区域突发巨响，扬起大量尘土。',
  'id=4803 正文：括号内**带前导全角空格**',
);
strips(
  '乌兹别克斯坦铁路公司 (УТЙ) 管理层与 Hyundai Rotem 公司讨论了供应计划。',
  '乌兹别克斯坦铁路公司管理层与 Hyundai Rotem 公司讨论了供应计划。',
  'id=6571 摘要：**半角括号**形态 —— 连它两侧的空格一起吃，否则会留下两个空格',
);
strips(
  '塔什干市议会（Кенгаш народных депутатов）宣布，自 2023 年 10 月 1 日起调整票价。',
  '塔什干市议会宣布，自 2023 年 10 月 1 日起调整票价。',
  'id=6574 正文：**三个词的长括注**',
);
strips(
  '塔吉克斯坦国家金融监管和反腐败局（Агентство по государственному финансовому контролю и борьбе с коррупцией）发起会议。',
  '塔吉克斯坦国家金融监管和反腐败局发起会议。',
  'id=3888 正文：**整句长相**的括注（68 字符）',
);
strips(
  '吉尔吉斯斯坦商业银行（КСБ）推出Visa Business Platinum商务白金卡。',
  '吉尔吉斯斯坦商业银行推出Visa Business Platinum商务白金卡。',
  'id=3506 **标题**',
);
strips(
  '哈萨克斯坦人民委员会（Қазақстан Халық Кеңесі）成员没有薪酬。',
  '哈萨克斯坦人民委员会成员没有薪酬。',
  'id=5075 正文：哈语西里尔（带 Қ / ә / ң）',
);
strips(
  '塔吉克斯坦总统民用航空事务代理机构（Агентство гражданской авиации при Президенте Республики Таджикистан）召开会议。',
  '塔吉克斯坦总统民用航空事务代理机构召开会议。',
  'id=5839 正文：西里尔全称（84 字符）',
);
strips(
  '检查工作由“哈萨克斯坦土地保护”（Kazselezащиты）机构的专业人员实施。',
  '检查工作由“哈萨克斯坦土地保护”机构的专业人员实施。',
  'id=6548 正文：括注前是**右引号**（不是汉字）—— 仍要删，因为中文名就在引号里',
);

// ============================================================
// 二、★ 反例：该留的一个字都不许动
// ============================================================

section('二、★ 反例 —— 不该动的（任何一个被删都是回归）');

// ---- 2.1 括注内含汉字 ⇒ 它在提供信息，不是冗余原文（线上 3 处，全部列为反例）----
keeps(
  '观测到300多头水牛（当地称「аркар」和「кулжа」）在同一区域内聚集。',
  '括注内含汉字：id=4307（`（当地称「аркар」和「кулжа」）`）',
);
keeps(
  '哈萨克斯坦女子步枪队（成员为 Arina Malinovskaya, Sofia Shulzhенко, Elizaveta Bezrukova）获得金牌。',
  '括注内含汉字：id=5906（队员名单）',
);
keeps(
  '哈萨克斯坦人权保护者（阿克亚к特）Джамиля Джаманбаева 指出……',
  '括注内含汉字：id=3530（含混排缺陷，但整括注有汉字 ⇒ 交给闸，不由后处理删）',
);

// ---- 2.2 《》 是提示词第 6 条明确允许放原文的地方 ----
keeps(
  '《Q2 2026: Азербайcan və Qlobal İqtisadiyyata və Kapital Baza》这份报告已发布。',
  'id=4166：《》内的原文标题**必须保留**（提示词明文允许）',
);
keeps(
  '财政部发布《2026年预算（НДС部分）》全文。',
  '《》内部不清理 —— 即便里面还套着一个括注',
);

// ---- 2.3 HTML 标签是代码不是译文 ----
keeps(
  '<img src="https://cdn.example.com/фото-2-1.jpeg" alt="现场照片" /> 事件发生在清晨。',
  'HTML 标签内的西里尔文件名（2445 个 <img src> 里实测有 6 个）',
);
keeps(
  '<a href="https://example.com/изображение">链接</a>已失效。',
  '带西里尔的 href 同样是代码',
);
keeps(
  '现场照片（<img src="https://cdn.example.com/фото.jpeg" />）由读者提供。',
  '括注里套着 HTML 标签 ⇒ 占位符保证**整个不匹配**（宁可漏，不可误删）',
);

// ---- 2.4 括注里没有西里尔 / 西里尔不足 2 个 ----
keeps('哈萨克斯坦总统 Tokayev（托卡耶夫）出席会议。', '括注是纯中文（无西里尔）');
keeps('哈萨克斯坦总统 Tokayev (Tokayev) 出席会议。', '括注是纯拉丁（无西里尔）');
keeps('会议定于（2026）年举行。', '括注是数字');
keeps('请在选项（Б）上打勾。', '单个西里尔字母（如选项字母）含义不明 ⇒ 放过');
// ⚠️ 下面这条是**已知的粗糙处**，故意写成正例而不是假装没有：
// 若模型写成「注册形式为（ЖШС）」——前面是「为」而不是中文名，删完读起来会别扭
// （「注册形式为，依据当地法律」）。本函数分辨不出「前面那个汉字是不是名字」，
// 而原文口径又**明文禁止**译文里出现西里尔（提示词第 6 条），所以仍然删。
// 实测 3528 篇里这种形态**一次都没出现过**（100 种括注全部是「中文名（原文）」），
// 所以接受这个代价；真要修，得让模型写出中文名，那属于提示词的事。
strips(
  '公司注册形式为（ЖШС），依据当地法律。',
  '公司注册形式为，依据当地法律。',
  '已知粗糙处：括注前是「为」而非中文名 ⇒ 仍删（口径禁止西里尔），实测未出现',
);

// ---- 2.5 裸露（非括注）的西里尔一律不动：删了就没名字了 ----
keeps(
  '吉尔吉斯斯坦外交部长 Жээнбек Кулубаев 与科摩罗代表签署了协议。',
  'id=4844 正文：**括注外**的西里尔人名（删掉读者就不知道是谁了）',
);
keeps(
  'Жапаров：到2026年底通过 GIK 项目将向2万多户家庭提供住房。',
  'id=5548 标题：人名裸露在句首 —— 这一类的解法是专名表，不是删除',
);
keeps(
  '哈萨克斯坦唯一彩票运营商「Сәтті жұлдыз」决定将其普通股上市。',
  'id=5419 `「」` 内的西里尔**不碰**（引号还有「引用原话」的用法，无法区分）',
);

// ---- 2.6 无关文本原样返回 ----
keeps('', '空串');
keeps('完全干净的一段中文，没有任何外文。', '无西里尔 ⇒ 提前返回，不做替换');

// ============================================================
// 三、性质：清理后**不再引入**新的闸命中（后处理的自我约束）
// ============================================================

section('三、清理不会「制造」闸命中');

/** 清理前/后各跑一遍生产闸，断言「后 ⊄ 前」。 */
function gateHits(text: string): string[] {
  const kinds: string[] = [];
  if (mixedScriptTokens(text).length) kinds.push('汉字+西里尔');
  if (mixedScriptTokensLatin(text).length) kinds.push('汉字+拉丁');
  if (latinCyrillicTokens(text).length) kinds.push('拉丁+西里尔');
  if (descendingMultiplePhrases(text).length) kinds.push('下降N倍');
  return kinds;
}

const gateCases = [
  '吉尔吉斯斯坦国家税务局（ГНС）已将博主列入名单。',
  '哈萨克斯坦紧急情况部（MЧС）在阿拉木图地震后进行了检查。',
  '白俄罗斯统一商品交易所（BUТБ）宣布了新机制。',
  '外国公司缴纳的增值税（НДС）收入同比增长了 63.9%。',
  '哈萨克斯坦计划在年底前确定第四个炼油厂（NПЗ）的参数。',
  '在吉尔吉斯斯坦议会（Жогорку Кенеш）的一次会议上，议员们汇报了问题。',
  '阿塞拜疆大学（BГУ）举办了一场活动。',
  '国家医疗基金（FOМС）仍有超过 2 亿美元未使用。',
];
let introduced = 0;
for (const c of gateCases) {
  const before = gateHits(c);
  const after = gateHits(stripCyrillicParentheticals(c));
  const added = after.filter((k) => !before.includes(k));
  if (added.length) {
    introduced++;
    console.log(`     ✗ 「${c}」删后新增命中：${added.join('/')}`);
  }
}
ok(
  `8 条真实样例上「删完才被闸拦」= 0（实测 ${introduced}）`,
  introduced === 0,
  '清理是纯删除，不该把两个词贴到一起制造出新缺陷',
);

// 清洗掉括注里的混排词之后，本来会被闸 4 拦下的样例**应当变成干净** —— 这正是「救回」的机制
ok(
  '★ 混排括注删掉后闸 4 不再命中（这就是那 18 篇被救回的机制）',
  latinCyrillicTokens('白俄罗斯统一商品交易所（BUТБ）').length === 1 &&
    latinCyrillicTokens(stripCyrillicParentheticals('白俄罗斯统一商品交易所（BUТБ）')).length === 0,
);

// ============================================================
// 四、★ 源码断言：它接在哪、有没有被误用成闸
// ============================================================

section('四、★ 源码断言（接线与顺序）');

try {
  const utilsSrc = readFileSync(resolve(__dirname, '../src/lib/utils.ts'), 'utf8');
  const translateSrc = readFileSync(resolve(__dirname, '../src/lib/translate.ts'), 'utf8');
  const pushSrc = readFileSync(resolve(__dirname, '../src/app/api/wechat/push/route.ts'), 'utf8');

  const fnAt = utilsSrc.indexOf('export function stripCyrillicParentheticals');
  ok('★ `stripCyrillicParentheticals` 在 utils.ts 里存在且导出', fnAt > 0);

  // 顺序：清理调用必须出现在 `const zhOk` **之前**（= 先清理、再过闸）
  const callAt = translateSrc.indexOf('stripCyrillicParentheticals(');
  const zhOkAt = translateSrc.indexOf('const zhOk');
  ok(
    '★ 清理调用在 `normalizeResult` 里、且在语言闸 `const zhOk` **之前**（先清理、再过闸）',
    callAt > 0 && zhOkAt > 0 && callAt < zhOkAt,
    `call@${callAt} zhOk@${zhOkAt}`,
  );

  // 清理必须作用到**三个字段**上（漏掉摘要 = 草稿里那段还会露出西里尔）
  const triple =
    /stripNote\(\s*typeof parsed\.title/.test(translateSrc) &&
    /stripNote\(\s*typeof parsed\.summary/.test(translateSrc) &&
    /stripNote\(\s*typeof parsed\.content/.test(translateSrc);
  ok('★ 三个字段（标题/摘要/正文）都被清理（漏一个就会在成品里露出来）', triple);

  // 不许进闸：`ok` 的合取里不能出现清理函数
  const okExpr = translateSrc.slice(translateSrc.indexOf('const ok ='), translateSrc.indexOf('const rawCategory'));
  ok(
    '★ 清理**没有**被写进 `ok` 的合取里（它是清理，不是判据 ⇒ 不会造成丢稿）',
    !okExpr.includes('stripCyrillicParentheticals') && !okExpr.includes('stripNote'),
  );

  // 失败回退必须是**原文**（本来就该带西里尔），不能被清理
  ok(
    '★ `translated:false` 时返回的是 `originalTitle` / `originalContent`（原文回退，不清理）',
    /titleZh:\s*ok\s*\?\s*titleZh\s*:\s*originalTitle/.test(translateSrc) &&
      /contentZh:\s*ok\s*\?\s*contentZh\s*:\s*originalContent/.test(translateSrc),
  );

  // 指纹：新增的行为必须自己带一个跑真代码的探针
  ok(
    '★ `codeVersion` 里有本后处理的**活体探针**（跑一次真函数，不是手写的 true）',
    /cyrillicNoteStripProbe:\s*stripCyrillicParentheticals\(/.test(pushSrc),
  );
  ok(
    '★ 探针的入参是**线上真实命中**（`吉尔吉斯斯坦国家税务局（ГНС）`，id=6658）',
    /cyrillicNoteStripProbe:[^,]*吉尔吉斯斯坦国家税务局（ГНС）/.test(pushSrc) &&
      stripCyrillicParentheticals('吉尔吉斯斯坦国家税务局（ГНС）') === '吉尔吉斯斯坦国家税务局',
    '探针词若被改成干净词，值就不会变，等于探针失效',
  );
} catch (err) {
  ok('能读到源码做断言', false, err instanceof Error ? err.message : String(err));
}

// ============================================================
// 五、★ 体检与生产必须共用同一份判据
// ============================================================

section('五、★ 「删」与「数」不许各写一份正则');

const noteCases: Array<[string, string[]]> = [
  ['吉尔吉斯斯坦国家税务局（ГНС）已将博主列入名单。', ['ГНС']],
  ['哈萨克斯坦国家石油天然气公司（НАИ）与基金（УКФР）达成协议。', ['НАИ', 'УКФР']],
  ['乌兹别克斯坦铁路公司 (УТЙ) 管理层与 Hyundai Rotem 讨论了计划。', ['УТЙ']],
  ['哈萨克国立大学（ КазНУ）附近突发巨响。', ['КазНУ']],
  ['观测到300多头水牛（当地称「аркар」和「кулжа」）在同一区域聚集。', []],
  ['《Q2 2026: Азербайcan və Qlobal İqtisadiyyata》报告已发布。', []],
  ['<img src="https://cdn.example.com/фото-2-1.jpeg" /> 事件发生在清晨。', []],
  ['请在选项（Б）上打勾。', []],
  ['吉尔吉斯斯坦外交部长 Жээнбек Кулубаев 签署了协议。', []],
];
for (const [text, expected] of noteCases) {
  const got = cyrillicParentheticalNotes(text);
  ok(
    `数出来的与「删掉」的一致：${expected.length ? expected.join('/') : '（空）'}`,
    got.length === expected.length && expected.every((e) => got.includes(e)),
    `得到 [${got.join(', ')}]`,
  );
}
// 「数出来的」与「真的删掉」必须同源：数到的每一个都确实从输出里消失了
const multi = '哈萨克斯坦国家石油天然气公司（НАИ）与基金（УКФР）达成协议。';
const multiOut = stripCyrillicParentheticals(multi);
ok(
  '★ 「数到的每一处」都真的从输出里消失（数了不删 / 删了不数都是分叉）',
  cyrillicParentheticalNotes(multi).every((n) => !multiOut.includes(n)) &&
    multiOut === '哈萨克斯坦国家石油天然气公司与基金达成协议。',
);
// 生产函数已经把这个**生产判据**导出给仪器用；若有人在仪器里另写一条正则，这里不会红，
// 所以再钉一条源码断言：括注正则在整个 utils.ts 里**只允许出现一次**。
// （用纯字符串数，别拿正则去匹配正则 —— 转义会把人绕进去。）
const vsrc = readFileSync(resolve(__dirname, '../src/lib/utils.ts'), 'utf8');
const NEEDLE = '[ \\t]?[（(]';
let noteReOccurrences = 0;
for (let at = vsrc.indexOf(NEEDLE); at >= 0; at = vsrc.indexOf(NEEDLE, at + 1)) noteReOccurrences++;
ok(
  '★ 括注正则只剩一处定义（`CYRILLIC_NOTE_RE`），生产与体检共用',
  noteReOccurrences === 1,
  `在 utils.ts 里找到 ${noteReOccurrences} 处`,
);
ok(
  '★ `cyrillicParentheticalNotes` 用的是那份共用正则，不是自写的',
  /matchAll\(CYRILLIC_NOTE_RE\)/.test(vsrc),
);

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
