/**
 * 术语闸的离线回归（不联网、不调模型）。
 *
 * 用法：`pnpm test:proper-nouns`
 *
 * ## 这个脚本存在的理由
 *
 * 用户在 2026-10-04 一次列出六处术语错，而且他说过**不止一次**
 * （阿塞拜疆写坚戈、吉尔吉斯写苏姆/坚戈、Almaty→阿利穆特、Alamedin→阿拉木图区、
 * 阿曼苏丹→苏丹国王）。这批错的共同点是「要判对必须知道稿子属于哪个国家」，
 * 而在此之前**代码里一条保障都没有**（详见 `proper-nouns.ts` 头部）。
 *
 * 现在有了闸门，就有了一个新风险：**闸门本身写错会静默丢稿**。
 * 这个脚本钉住三件事：
 *   ① 国家→货币这张表**逐国正确**（这是用户报的错里最刺眼的一条）；
 *   ② 判据是**双向**的 —— 错写法必须拦，正确写法与三个**实测过的**假阳性陷阱必须放行；
 *   ③ 闸门**真的接在主链路上**（源码级断言）—— 判据写在库里却没人调用，
 *      是本项目反复踩过的形态（「加了一条很正确的判据但现象没变化」）。
 *
 * ⚠️ ② 里那三个「必须放行」的样例**不是凑数的**，每一个都对应一次真实误报：
 *   · `苏姆盖蒂` —— 阿塞拜疆城市名含「苏姆」，第一版判据当场误报（见 `CURRENCY_FALSE_FRIENDS`）
 *   · 归错国的稿子 —— uz 栏目里的哈萨克斯坦稿，第一版实测 27 篇这一类（见 `ownCountryMentioned`）
 *   · 塔吉克的 `苏姆尼` 异写 —— 第一版当成乌兹别克货币（见 `COUNTRY_CURRENCY.tj` 的注释）
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { CountryCode } from '../src/lib/data/types';
import {
  PROPER_NOUN_VERSION,
  COUNTRY_CURRENCY,
  WRONG_PROPER_NOUN_FORMS,
  HEAD_OF_STATE,
  currencyPromptTable,
  checkCurrencyCountryFit,
  checkWrongProperNouns,
  checkHeadOfStateNames,
  checkDateMonthAmbiguity,
  headOfStatePromptLine,
  countryCodeByName,
  termGateProbe,
  TERM_GATE_PROBE_EXPECT,
} from '../src/lib/proper-nouns';

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
// 一、国家 → 货币这张表本身
// ============================================================

section('一、国家 → 货币（表值必须逐国正确）');

{
  const EXPECT: Record<CountryCode, string> = {
    kz: '坚戈',
    uz: '苏姆',
    kg: '索姆',
    tj: '索莫尼',
    az: '马纳特',
  };
  for (const [code, zh] of Object.entries(EXPECT) as Array<[CountryCode, string]>) {
    ok(`${code} → ${zh}`, COUNTRY_CURRENCY[code].zh === zh, `得到「${COUNTRY_CURRENCY[code].zh}」`);
  }

  // ⚠️ 这一条是**用户报的原话**：「吉尔吉斯坚戈？！」—— 吉尔吉斯的货币与哈萨克斯坦的
  // **必须是两个不同的词**。谁把这张表改成一国一名共用，这条立刻红。
  ok(
    '吉尔吉斯斯坦与哈萨克斯坦的货币名不同（用户报过「吉尔吉斯坚戈」）',
    COUNTRY_CURRENCY.kg.zh !== COUNTRY_CURRENCY.kz.zh,
  );
  ok(
    '吉尔吉斯斯坦与乌兹别克斯坦的货币名不同（kg 大量写成「苏姆」）',
    COUNTRY_CURRENCY.kg.zh !== COUNTRY_CURRENCY.uz.zh,
  );
  ok(
    '标出「马纳特」不唯一（阿塞拜疆与土库曼斯坦同名）',
    COUNTRY_CURRENCY.az.zh === '马纳特',
    '如果哪天给 tm 建了条目，这条要跟着改成一国一条',
  );

  // ISO 代码也不能错
  ok('az 的 ISO 代码是 AZN', COUNTRY_CURRENCY.az.code === 'AZN');
  ok('kg 的 ISO 代码是 KGS', COUNTRY_CURRENCY.kg.code === 'KGS');
  ok('tj 的 ISO 代码是 TJS', COUNTRY_CURRENCY.tj.code === 'TJS');
}

section('二、货币表的提示词投影（提示词与闸门共用的那一份）');

{
  const table = currencyPromptTable();
  ok('表里 5 个国家一个不少', (table.match(/→/g) || []).length === 5, table);
  for (const [code, spec] of Object.entries(COUNTRY_CURRENCY) as Array<[CountryCode, typeof COUNTRY_CURRENCY.kz]>) {
    ok(`表里含「${code} → ${spec.zh}（${spec.code}）」`, table.includes(`${spec.zh}（${spec.code}）`), table);
  }
  // ⚠️ 这一条对应**根因**：老提示词里那串平铺枚举是「坚戈、马纳特、苏姆、美元」——
  // 连「索姆」都没有，于是模型只能拿它见过的「苏姆」去填吉尔吉斯斯坦。
  ok('表里含「索姆」（老提示词的枚举里根本没有这个词）', table.includes('索姆'));
  ok('表里含「索莫尼」（老提示词里也没有）', table.includes('索莫尼'));
}

section('三、★ 双向回归：错写法必须拦');

{
  const reject: Array<[CountryCode, string, string]> = [
    ['az', '阿塞拜疆制造业平均工资达 1335 坚戈，采矿行业达 3700 坚戈。', '用户原话：阿塞拜疆工资写成坚戈'],
    ['az', '阿塞拜疆坚戈本周对美元汇率保持不变，阿塞拜疆中央银行公布数据。', '连货币名都编成了「阿塞拜疆坚戈」'],
    ['az', '巴库西高加索大学 2025 年前员工税后收入增长 17.3% 至 496 万坚戈。', '巴库（本国城市）+ 坚戈'],
    ['kg', '欧元更新年最低点至 98.3813 坚戈，欧元兑吉尔吉斯斯坦坚戈下降。', '用户原话：吉尔吉斯坚戈'],
    ['kg', '吉尔吉斯斯坦 8 个月金属产量达 276.5 亿苏姆。', '用户原话：吉尔吉斯用苏姆'],
    ['kg', '吉尔吉斯斯坦财政部预计从吉尔吉斯斯坦证券交易所获得 15 亿苏姆收益。', '同上'],
    ['kg', '比什凯克当局要求商家以每公斤 770 苏姆的牛肉销售。', '本国城市 + 苏姆'],
    ['uz', '乌兹别克斯坦国家银行公布数据，多楼层公寓价格上涨 6%（索姆计价）。', '乌兹别克用索姆'],
    ['uz', '卡拉卡尔帕克斯坦共和国发现 317 笔 321 亿坚戈政府采购违规行为。', '本国自治共和国 + 坚戈'],
    ['kz', '哈萨克斯坦托克马克市的废物处理公司被罚款 17 万苏姆。', '坚戈国写苏姆'],
  ];
  for (const [code, text, why] of reject) {
    const r = checkCurrencyCountryFit(code, text);
    ok(`拦下 ${code}：${why}`, r !== null, '没拦 —— 判据漏了');
  }
}

section('四、★ 双向回归：正确写法与**三个实测过的假阳性陷阱**必须放行');

{
  const pass: Array<[CountryCode, string, string]> = [
    ['az', '阿塞拜疆 2025 年资本投资中，预算资金为 8 亿 8114 万马纳特。', '本国货币正确'],
    ['kg', '吉尔吉斯斯坦 8 月平均月薪为 25000 索姆，比什凯克物价同比上涨。', '本国货币正确'],
    ['uz', '乌兹别克斯坦国家银行数据显示，公寓价格上涨 6%（苏姆计价）。', '本国货币正确'],
    ['tj', '塔吉克斯坦 1 至 8 月平均月薪约 3,500 索莫尼。', '本国货币正确'],
    ['kz', '哈萨克斯坦向 61,548 户安装太阳能的家庭发放 105.4 亿坚戈补贴。', '本国货币正确'],
    [
      'az',
      '阿塞拜疆与哈萨克斯坦贸易额以马纳特与坚戈结算，双方签署协议。',
      '本国 + 别国货币同时出现 → 必须留（`isCountryRelevant` 同一纪律）',
    ],
    ['az', '阿塞拜疆企业 2025 年出口额为 12 亿美元，同比增长 4%。', '只有美元 —— 任何国家都能用'],
    ['kz', '阿斯塔纳市政府批准了 2026 年预算修正案，未披露具体金额。', '通篇没提货币'],
    // —— 下面三条是**实测过的误报**，各自钉住一个具体机制 ——
    [
      'az',
      '阿塞拜疆巴库与苏姆盖特的体育场将举行比赛。',
      '❗假阳性陷阱①：苏姆盖特/苏姆盖蒂是阿塞拜疆城市，不是乌兹别克货币',
    ],
    [
      'az',
      '当时分别在吉尔吉斯斯坦苏姆盖蒂的 Mehti Guseinzade 体育场进行比赛。',
      '❗假阳性陷阱①之二：换成「苏姆盖蒂」也不能绕过排除（id=9804，第一版就是这样漏的）',
    ],
    [
      'uz',
      '哈萨克斯坦向 61,548 户安装太阳能的家庭发放 105.4 亿坚戈补贴。',
      '❗假阳性陷阱②：这是归错国的 kz 稿子，货币本来是对的，不能拦（拦了会把好稿改成假消息）',
    ],
    [
      'tj',
      '塔吉克斯坦 2026 年 1 至 8 月平均月薪约 3,500 苏姆尼。',
      '❗假阳性陷阱③：苏姆尼是塔吉克货币的异写，不是乌兹别克货币',
    ],
    [
      'kg',
      '吉尔吉斯斯坦索姆对美元汇率走强，索姆（KGS）兑美元升至 87.45。',
      '本国货币 + ISO 代码都要认',
    ],
  ];
  for (const [code, text, why] of pass) {
    const r = checkCurrencyCountryFit(code, text);
    ok(`放行 ${code}：${why}`, r === null, r ? `被误拦：${r.reason}` : '');
  }
}

section('五、错译写法黑名单');

{
  ok('拦下「阿利穆特」', checkWrongProperNouns('kz', '阿利穆特市新建住宅区').length > 0);
  ok('拦下「阿利穆拉特」（用户报的第二种写法）', checkWrongProperNouns('kz', '阿利穆拉特市市长要求检查街道美化项目承包商').length > 0);
  ok('拦下「苏丹国王」', checkWrongProperNouns('kz', '苏丹国王访问哈萨克斯坦').length > 0);
  ok('拦下「国王苏丹」（另一种语序）', checkWrongProperNouns('kz', '国王苏丹抵达阿斯塔纳').length > 0);

  ok(
    '「阿拉木图区」只在 kg 稿子里算错（它是吉尔吉斯楚河州的区）',
    checkWrongProperNouns('kg', '楚河州阿拉木图区近 70 公顷灌溉农田将用于建设多层住宅').length > 0,
  );
  ok(
    '「阿拉木图区」在 kz 稿子里**不**算错（限定国家生效）',
    checkWrongProperNouns('kz', '阿拉木图区划调整方案公布').length === 0,
    '国家限定没生效 —— 会误伤哈萨克斯坦的稿子',
  );

  // 正确写法必须放行
  ok('「阿拉木图」是正确写法，不拦', checkWrongProperNouns('kz', '阿拉木图市新建住宅区').length === 0);
  ok('「阿拉梅金区」是正确写法，不拦', checkWrongProperNouns('kg', '楚河州阿拉梅金区近 70 公顷农田').length === 0);
  ok('「阿曼苏丹」是正确写法，不拦', checkWrongProperNouns('kz', '阿曼苏丹访问哈萨克斯坦').length === 0);
  ok('`countryCode` 为 null 时不误报', checkWrongProperNouns(null, '阿利穆拉特市') .length === 1,
    '不限国家的条目在 code 为 null 时仍应命中');

  // 黑名单自身的写法质量
  for (const f of WRONG_PROPER_NOUN_FORMS) {
    ok(`黑名单条目「${f.wrong}」写了 why`, f.why.length >= 8, f.why);
    ok(`黑名单条目「${f.wrong}」的 right 非空且与 wrong 不同`, f.right.length > 0 && f.right !== f.wrong);
  }
}

// ============================================================
// 五之二、★ 国家元首写法（2026-10-11 加，用户第二次报的「低级错误」核心一条）
// ============================================================
//
// 用户原话：「总统的名字，固定用中文，并且请翻译好，用约定俗成的，比如，吉尔吉斯的是
// 扎帕罗夫，但是你看看你怎么翻译的，要么用英文，要么用不同的汉字，贾帕罗夫，朱帕罗夫，
// SadyrZhaparov」。
//
// ## 这些样例**全部取自线上真实产出**（括号里是文章 id）
//
// 判据的构造、三种写法并存的实测表、以及「为什么白名单必须用前缀比对」，
// 都写在 `proper-nouns.ts` 的 `checkHeadOfStateNames` 注释里。
// ⚠️ 下面「必须放行」的前两条是**实测过的误报**（初版 `{2,8}` 时命中过），
// 谁要是把字宽放宽回去，这一节会立刻红。

section('五之二、★ 国家元首写法：该写中文却写拉丁');

{
  // ---- (1) 按职务词命中：〈总统〉+ 拉丁写法 ----
  //     第 4 列是**该国的中文元首名**（判据要能给出「该写成什么」）。
  const latinMustCatch: Array<[CountryCode, string, string, string]> = [
    ['kz', '哈萨克斯坦总统 Tokayev 警告恐怖分子和贩毒集团利用数字技术', '托卡耶夫', '11692'],
    ['az', '阿塞拜疆总统 Ilham Aliyev 出席仪式', '阿利耶夫', '12590/12541 一类'],
    ['kg', '吉尔吉斯斯坦总统 Sadyr Zhaparov 签署了法令', '扎帕罗夫', '12504 一类'],
    ['uz', '乌兹别克斯坦总统Shavkat Mirziyoyev提议建立区域地图', '米尔济约耶夫', '12039'],
    // 只给了姓氏（没带名）也要认：`Ilham` / `Shavkat` 都在各表的 latin 列里
    ['kz', '哈萨克斯坦总统 Kassym-Jomart 在会议上发言', '托卡耶夫', '11289'],
  ];
  for (const [code, text, expectZh, src] of latinMustCatch) {
    const hits = checkHeadOfStateNames(code, text);
    const hit = hits.find((h) => h.kind === 'latin');
    ok(
      `拦下拉丁写法（${src}）「${text.slice(0, 26)}…」`,
      !!hit && hit.right.includes(expectZh) && hit.why.includes('约定俗成'),
      JSON.stringify(hits.map((h) => `${h.kind}:${h.sample}→${h.right}`)),
    );
  }

  // ---- (2) 紧跟在国名后的拉丁写法（「总统」被省略或写在后面时）----
  ok(
    '拦下「〈国名〉〈拉丁名〉」这种不带职务词的写法',
    checkHeadOfStateNames('kg', '吉尔吉斯斯坦 Sadyr Zhaparov 表示').some((h) => h.kind === 'latin'),
  );

  // ---- (3) 「总统」后面跟了一个「名·姓」，但那人不是元首 ----
  //        —— 这一类**不能靠替换名字修**，必须按原文职务改写（见 buildRepairHint）。
  const imposterMustCatch: Array<[CountryCode, string, string, string]> = [
    [
      'tj',
      '塔吉克斯坦总统伊斯坎德尔·萨德洛夫谈论了该国 2040 年战略、数字主权和互联网发展。',
      '伊斯坎德尔·萨德洛夫',
      '11360（用户 2026-10-11 报的那条：他其实是该部门的官员）',
    ],
    ['kg', '吉尔吉斯斯坦总统萨德尔·贾帕罗夫更换海关与边防部门负责人', '贾帕罗夫', '12521'],
    ['kg', '吉尔吉斯斯坦总统萨德尔·朱帕罗夫在比什凯克主持楚河州成立100周年庆典', '朱帕罗夫', '12509'],
    ['kg', '吉尔吉斯斯坦总统萨迪尔·扎帕罗夫赴土库曼斯坦参加会议', '萨迪尔', '11828'],
    ['uz', '乌兹别克斯坦总统沙夫卡特·米尔济约夫提出中央亚细亚与阿塞拜疆新合作模式', '米尔济约夫', '11772'],
    ['az', '阿塞拜疆总统伊尔哈姆·阿里夫在巴库会见了英国商业大臣', '伊尔哈姆·阿里夫', '10755'],
    // ⚠️ 简写国名也要认（「吉尔吉斯」在提示词里与全称并列）—— 线上真有：12323
    ['az', '吉尔吉斯总统萨德尔·贾帕罗夫在土库曼斯坦提议举办全球山地峰会', '贾帕罗夫', '12323'],
    // ⚠️ 用户报的第三种错法没带「总统」前缀时也抓得到（国名 + 总统 + 名字）
    ['az', '吉尔吉斯斯坦总统萨达尔·贾帕罗夫提议创建统一电子贸易平台', '萨达尔', '11939'],
  ];
  for (const [code, text, needle, src] of imposterMustCatch) {
    const hits = checkHeadOfStateNames(code, text);
    const hit = hits.find((h) => h.kind === 'not-head-of-state');
    ok(
      `拦下「总统+非元首」（${src}）「${needle}」`,
      !!hit && hit.sample.includes(needle),
      JSON.stringify(hits.map((h) => `${h.kind}:${h.sample}`)),
    );
  }

  // 命中必须给出「该用哪个写法」，否则修正指令无从下手
  const sample = checkHeadOfStateNames('kg', '吉尔吉斯斯坦总统萨德尔·贾帕罗夫免去海关总局局长职务');
  ok('命中里带着该国的正确写法（修正指令要用）', sample[0]?.right === '萨德尔·扎帕罗夫', JSON.stringify(sample[0]));
  ok('命中里带着 why（要写给人看）', (sample[0]?.why.length ?? 0) >= 20, sample[0]?.why);
  ok('非元首那一条的 why 明确禁止「加元首头衔」', (sample[0]?.why ?? '').includes('不要给他加上元首头衔'));
}

section('五之二之二、★ 元首写法：正确写法与**实测过的**假阳性必须放行');

{
  const mustPass: Array<[CountryCode, string, string]> = [
    // —— 正确写法（全名 / 别名 / 只有姓氏）——
    ['kg', '吉尔吉斯斯坦总统萨德尔·扎帕罗夫签署了法令。', '正确全名'],
    ['kg', '吉尔吉斯斯坦总统扎帕罗夫表示，过去六年建成 1075 个大项目。', '只写姓氏（无中点 ⇒ 本就不该匹配）'],
    [
      'uz',
      '乌兹别克斯坦总统沙夫卡特·米尔济约耶夫提出推动中亚与阿塞拜疆合作发展的四项方向',
      '❗前缀版的关键回归：正确名字后面粘着动词+宾语（全等比对在这一条上会误杀）',
    ],
    ['tj', '塔吉克斯坦总统埃莫马利·拉赫蒙出席斯皮塔梅恩区学校落成典礼', '正确全名'],
    ['az', '阿塞拜疆总统伊利哈姆·阿利耶夫会见瑞典新任大使', '正确全名'],
    ['kz', '哈萨克斯坦总统哈斯穆卓玛尔特·托卡耶夫签署法令', '别名（无连字符写法）在表里'],
    // —— 实测过的两类误报：都是**正确地**提到官员的稿子 ——
    ['az', '阿塞拜疆总统特别代表马西姆·马马多夫陪同代表团访问卡拉巴赫地区。', '❗误报①：总统**特别代表**被当成了名字首段（12553）'],
    [
      'tj',
      '乌兹别克斯坦总统府发言人谢尔兹德·阿萨多夫于 2026 年 10 月 3 日宣布重组教育管理体系。',
      '❗误报②：总统**府**发言人被当成了名字首段（11364）',
    ],
    // —— 别国元首 / 同姓的部长 ——
    ['az', '阿塞拜疆总统阿利耶夫会见俄罗斯总统普京', '别国元首（普京）不在本表 ⇒ 不放行它就等于乱改'],
    ['az', '阿塞拜疆交通部长 Aliyev 出席会议', '无「总统/国家元首」做上下文 ⇒ 不判（误杀代价是丢稿）'],
    ['kz', '哈萨克斯坦政府总理别克捷诺夫召开会议', '总理不在本表（表里只有元首）'],
  ];
  for (const [code, text, why] of mustPass) {
    const hits = checkHeadOfStateNames(code, text);
    ok(
      `放行 ${code}：${why}`,
      hits.length === 0,
      hits.map((h) => `${h.kind}:${h.sample}（${h.why}）`).join(' / '),
    );
  }

  // ---- 判据**不看「稿子属于哪个国家」** ⇒ 传 null 也要照常工作 ----
  // 理由：五国元首的中文写法是同一套标准；稿子被归错国时写法照样是错的。
  ok(
    'countryCode 为 null 时仍能抓到别国元首的错写法（不抛错、不静默放行）',
    checkHeadOfStateNames(null, '吉尔吉斯斯坦总统萨德尔·贾帕罗夫表示').length > 0,
  );
  ok(
    'countryCode 为 null 时正确写法照样放行',
    checkHeadOfStateNames(null, '吉尔吉斯斯坦总统萨德尔·扎帕罗夫表示').length === 0,
  );

  // ---- 空串安全 ----
  ok('空串安全', checkHeadOfStateNames('kg', '').length === 0);

  // ---- 表自身的完整性 ----
  for (const [code, spec] of Object.entries(HEAD_OF_STATE) as Array<[CountryCode, typeof HEAD_OF_STATE.kz]>) {
    ok(`${code} 的元首表有 zh / zhFull / office / latin`, !!spec.zh && !!spec.zhFull && !!spec.office && spec.latin.length > 0);
    ok(`${code} 的 zhFull 以 zh 结尾（姓氏是唯一口径）`, spec.zhFull.endsWith(spec.zh), `${spec.zhFull} / ${spec.zh}`);
  }
  // ⚠️ 用户点名要「扎帕罗夫」：谁把表改回「贾帕罗夫」，这条立刻红。
  ok('吉尔吉斯斯坦元首的中文名是「扎帕罗夫」（用户点名的写法）', HEAD_OF_STATE.kg.zh === '扎帕罗夫');
  ok(
    '五国元首的中文名两两不同（不会互串）',
    new Set(Object.values(HEAD_OF_STATE).map((s) => s.zh)).size === 5,
  );
}

section('五之二之三、★ 元首名字的提示词注入（与闸门共用同一张表）');

{
  for (const code of ['kz', 'uz', 'kg', 'tj', 'az'] as CountryCode[]) {
    const name = countryCodeByName(code) ?? code;
    const line = headOfStatePromptLine(name);
    ok(`注入行里含 ${code} 的约定俗成中文名「${HEAD_OF_STATE[code].zh}」`, line.includes(HEAD_OF_STATE[code].zhFull));
  }
  ok(
    '注入行含「不许写拉丁转写」',
    headOfStatePromptLine('吉尔吉斯斯坦').includes('不要写拉丁转写'),
  );
  // ⚠️ 这一句**不能省**：2026-10-01 实测过「提示词里的领导人名被搬去当正文主语」。
  ok(
    '注入行含禁令「原文没有提到元首时不许出现元首姓名」（防 2026-10-01 那个坑）',
    headOfStatePromptLine('吉尔吉斯斯坦').includes('原文没有提到元首时，译文里就不许出现元首的姓名或职务'),
  );
  ok('未知国名返回空串（不抛错、不编）', headOfStatePromptLine('阿曼') === '');
  // 生成式注入的意义：注入的名字必须**就是**闸门认的那个，不能两处各写一份
  ok(
    '注入行里的名字与闸门白名单同源（改表两边一起变）',
    headOfStatePromptLine('哈萨克斯坦').includes(HEAD_OF_STATE.kz.zhFull) &&
      checkHeadOfStateNames('kz', '哈萨克斯坦总统托卡耶夫表示').length === 0,
  );
}

// ============================================================
// 五之三、★ 日期缺月份（2026-10-11 加）
// ============================================================
//
// 用户原话：「这个新闻就写了个23-25号，是几月呢？我查了才知道，是10月，
// 也就是即将举行这个活动，歧义太重了」。
//
// ⚠️ 这一节的「必须放行」里有一大半是**实测出来的误报** ——
// 初版判据在 2154 篇语料上命中 16 条、其中 8 条是误报（门牌号 6 + 刑期 1 + 许可证 1），
// 误报率 50%。下面每条都对应其中一类，**别把它们当成凑数的样例删掉**。

section('五之三、★ 日期缺月份：必须命中');

{
  const mustCatch: Array<[string, string[]]> = [
    ['吉尔吉斯斯坦 23 日至 25 日在比什凯克举办"AgroTechExpo-2026"展会', ['23日', '25日']], // 12510，用户报的
    ['萨德尔·朱帕罗夫 8-9 日访问土库曼斯坦', ['9日']], // 11503
    ['9日，阿斯塔纳与阿拉木图的外汇兑换点公布了美元兑坚戈的汇率。', ['9日']], // 12179
    ['6日凌晨起，莫斯科三大机场因无人机袭击取消或延误超过 200 个航班。', ['6日']], // 10744
    ['扎帕罗夫5日在比什凯克体育场开幕仪式上表示', ['5日']], // 10684
    ['阿塞拜疆代表团将出席 8-9 日在土耳其伊斯坦布尔举行的国际经济论坛', ['9日']], // 10740
  ];
  for (const [text, expect] of mustCatch) {
    const r = checkDateMonthAmbiguity(text);
    ok(
      `命中「${text.slice(0, 30)}…」⇒ ${expect.join('/')}`,
      !!r && expect.every((e) => r.samples.includes(e)),
      JSON.stringify(r),
    );
  }
  ok('命中时给出可读的 why（要拼进修正指令）', (checkDateMonthAmbiguity('吉尔吉斯斯坦 23 日至 25 日举办展会')?.why.length ?? 0) >= 30);
  ok('空串安全', checkDateMonthAmbiguity('') === null);
}

section('五之三之二、★ 日期缺月份：必须放行（含**七类实测误报**）');

{
  const mustPass: Array<[string, string]> = [
    // —— 正确写法 ——
    ['哈萨克斯坦将于 2027 年 1 月 10 日举行选举。', '有月份'],
    ['吉尔吉斯斯坦 10 月 23 日至 25 日举办展会', '有月份（就是上面那条命中修好的样子）'],
    ['会议于本月 5 日举行', '相对月份「本月」也是月份（只认「数字+月」会误报这里）'],
    ['塔吉克斯坦 1 至 8 月平均月薪约 3,500 索莫尼', '汉字/数字月份'],
    ['原文写 8-9 октябрда，译成 10 月 8 日至 9 日', '有月份'],
    // —— 实测误报 1：门牌 / 地址（6 条）——
    ['APEX BANK 在布哈拉市伊斯拉姆·卡里莫夫街 8 号开设新银行服务中心', '❗门牌：「街 8 号」（11195）'],
    ['比什凯克市政府将位于米恩-库什街 21 号的 15 套住宅分配给居民', '❗门牌：「街 21 号」（12261）'],
    ['巴库内沙米区28号街至The Ritz-Carlton Baku酒店区域内的建筑将被拆除', '❗「28号街」是街区名（12152）'],
    ['阿塞拜疆紧急情况部门暂停了巴库市亚萨马尔区塔布里兹·哈利勒巴耶夫街7号酒店的经营许可', '❗门牌：「街7号」（12124）'],
    ['AccessBank 总部位于巴库的 Tbilisi 大道3号', '❗门牌：「大道 3 号」（12090）'],
    ['位于楚河州楚河区Tunguch微区的36/1号建筑工地基坑被回填', '❗楼号：「36/1 号」（10682）'],
    // —— 实测误报 2：编号 ——
    ['AccessBank 在阿塞拜疆中央银行获得第245号许可证', '❗许可证编号（`第` / 数字连写都挡）'],
    ['根据第 5 号总统令，政府批准了该法案。', '❗提示词第 7 条(d) 规定的写法'],
    // —— 实测误报 3：时长量词 ——
    ['22 岁的司机被判处 10 日行政拘留', '❗「N 日」是刑期不是日期（10850）'],
    // —— 其他非日期用例 ——
    ['蒙古国 1 号公路将进行大修', '公路编号'],
    ['该市 3 号线的运营时间延长', '线路编号'],
    ['该项目覆盖 2 号机组', '机组编号'],
  ];
  for (const [text, why] of mustPass) {
    const r = checkDateMonthAmbiguity(text);
    ok(
      `放行「${text.slice(0, 30)}…」（${why}）`,
      r === null,
      JSON.stringify(r),
    );
  }

  // ⚠️ 反过来：真日期前面恰好是「区」时**必须仍然命中** ——
  // 「区」刻意没进排除表，因为 `塔什干州奇纳兹区 9 日举行…` 是**真**缺月份。
  // 这条断言钉的是「排除项没有扩得太大」。
  ok(
    '❗「区」不算地址通名：真日期照样命中',
    checkDateMonthAmbiguity('塔什干州奇纳兹区 9 日举行了揭牌仪式') !== null,
    '若这条变成 null，说明排除表被放宽到把「区」也吞了 —— 那是真缺陷在漏',
  );
}

section('五之三之三、★ 日期闸的「原文没有月份就不管」出口');

{
  // 为什么这个出口必须有：原文本身就没月份时，逼模型补一个月份等于让它**编**，
  // 编不出来就重试三次然后**丢稿** —— 而项目纪律是「宁可留重复，不要丢稿」。
  const zh = '吉尔吉斯斯坦 23 日至 25 日在比什凯克举办展会';

  ok(
    '原文有月份 ⇒ 照常命中（`23-25-октябрь`）',
    !!checkDateMonthAmbiguity(zh, 'Иш-чаралар 23-25-октябрь күндөрү Бишкек шаарындагы…'),
  );
  ok('原文有月份（哈萨克语 қазан）⇒ 照常命中', !!checkDateMonthAmbiguity(zh, '… 9 қазан бойынша …'));
  ok('原文有月份（俄语 октября）⇒ 照常命中', !!checkDateMonthAmbiguity(zh, 'С полуночи 6 октября в московских аэропортах…'));
  ok('原文有月份（吉语 октябрда）⇒ 照常命中', !!checkDateMonthAmbiguity(zh, '8-9-октябрда Түркмөнстанга иш сапар…'));
  ok('原文有月份（阿语 oktyabr）⇒ 照常命中', !!checkDateMonthAmbiguity(zh, '8-9 oktyabr tarixlərində keçiriləcək'));
  ok(
    '原文只有序数、没有月份 ⇒ 放行（这一条实测过：id=11206 的原文是 «14-я выставка»）',
    checkDateMonthAmbiguity(zh, 'В столичном НВК «Узэкспоцентр» распахнула свои двери 14-я Международная выставка Aquatherm Tashkent') === null,
  );
  // ⚠️ 这两条防的是「月份词干是别的词的子串」——`nov` 会命中 `novosti`、`май` 会命中 `майдан`
  ok(
    '原文里的「новости」不算月份（`nov` 必须带词边界）',
    checkDateMonthAmbiguity(zh, 'Последние новости Узбекистана сегодня') === null,
  );
  ok(
    '原文里的「майдан」（广场）不算月份（ма[йя] 必须带后缀边界）',
    checkDateMonthAmbiguity(zh, 'Ала-Тоо майданындагы иш-чаралар') === null,
  );
  ok('不传原文 ⇒ 照常判（探针与单测的用法）', !!checkDateMonthAmbiguity(zh));
}

section('六、国名 → 代码（提示词与闸门必须同一输入）');
{
  ok('阿塞拜疆 → az', countryCodeByName('阿塞拜疆') === 'az');
  ok('吉尔吉斯斯坦 → kg', countryCodeByName('吉尔吉斯斯坦') === 'kg');
  ok('代码本身也认（az）', countryCodeByName('az') === 'az');
  ok('未知输入返回 null（不抛错、不猜）', countryCodeByName('阿曼') === null);
}

section('七、活体探针（必须跑真判据，且双向）');

{
  ok(
    '探针输出与期望值逐字一致',
    termGateProbe() === TERM_GATE_PROBE_EXPECT,
    `得到「${termGateProbe()}」／期望「${TERM_GATE_PROBE_EXPECT}」`,
  );
  ok(
    '期望值里六项「拦」六项「放行」（双向）',
    (TERM_GATE_PROBE_EXPECT.match(/拦\(/g) || []).length === 6 &&
      (TERM_GATE_PROBE_EXPECT.match(/放行/g) || []).length === 6,
    TERM_GATE_PROBE_EXPECT,
  );

  // ⚠️ 探针**必须调用真判据**。手写 `return 'A:拦'` 也能让上面两条断言全绿，
  // 但那样测的是探针自己、不是闸门 —— 于是「判据被改坏」这件事永远测不出来。
  const self = readFileSync(resolve(process.cwd(), 'src/lib/proper-nouns.ts'), 'utf8');
  const body = self.slice(self.indexOf('export function termGateProbe'));
  ok('探针体内调用了 checkCurrencyCountryFit', body.includes('checkCurrencyCountryFit('), '手写结论 = 探针失效');
  ok('探针体内调用了 checkWrongProperNouns', body.includes('checkWrongProperNouns('), '手写结论 = 探针失效');
  ok('探针体内调用了 checkHeadOfStateNames', body.includes('checkHeadOfStateNames('), '手写结论 = 探针失效');
  ok('探针体内调用了 checkDateMonthAmbiguity', body.includes('checkDateMonthAmbiguity('), '手写结论 = 探针失效');

  // ⚠️ 两个新闸**必须**各有一条「拦」和一条「放行」写在探针里 ——
  // 只写「拦」的话，一个「什么都拦」的坏判据也能让探针全绿。
  ok('元首判据有「拦」也有「放行」（F 拦 / I 放行）', /\bF:拦\(拉丁\)/.test(TERM_GATE_PROBE_EXPECT) && /\bI:放行/.test(TERM_GATE_PROBE_EXPECT));
  ok('日期判据有「拦」也有「放行」（H 拦 / J,K 放行）', /\bH:拦\(23日\/25日\)/.test(TERM_GATE_PROBE_EXPECT) && /\bJ:放行/.test(TERM_GATE_PROBE_EXPECT) && /\bK:放行/.test(TERM_GATE_PROBE_EXPECT));
}

// ============================================================
// 八、★ 接线断言：判据真的在链路上吗
// ============================================================
//
// ⚠️ 本节测的是**接线**，不是判据。判据再对，只要没被调用，线上一个字节都不会变 ——
// 而这正是本项目最反复踩的形态：项目记忆里「加了一条很正确的判据但现象没变化」。

section('八、★ 接线断言');

{
  const tr = readFileSync(resolve(process.cwd(), 'src/lib/translate.ts'), 'utf8');
  const fetchSrc = readFileSync(resolve(process.cwd(), 'src/app/api/fetch-news/route.ts'), 'utf8');

  ok('translate.ts 引入了术语闸', /from '\.\/proper-nouns'/.test(tr));
  ok('闸门读的是同一个 countryCode（不是另算一个）', /countryCodeByName\(countryName\)/.test(tr));
  ok(
    '`currencyIssue` 进了 `ok`（否则拦了等于没拦）',
    /const ok =[\s\S]{0,400}!currencyIssue/.test(tr),
  );
  ok(
    '`wrongNouns` 进了 `ok`',
    /const ok =[\s\S]{0,400}wrongNouns\.length === 0/.test(tr),
  );
  ok('reject 里带上了 currency', /\.\.\.\(currencyIssue \? \{ currency: currencyIssue \}/.test(tr));
  ok('reject 里带上了 wrongNouns', /\.\.\.\(wrongNouns\.length > 0 \? \{ wrongNouns \}/.test(tr));

  // ---- 2026-10-11 加的两条闸：判据对了但**没接进闸门**的话线上一个字节都不会变 ----
  ok(
    'translate.ts 调用了元首判据（且**不被 countryCode 限制** —— 见判据注释）',
    /checkHeadOfStateNames\(countryCode, combined\)/.test(tr),
    '元首写法是五国同一套标准，稿子归错国时也要修 ⇒ 不能写成 `countryCode ? … : []`',
  );
  ok(
    'translate.ts 调用了日期判据，且**把原文一起传进去**',
    /checkDateMonthAmbiguity\(combined, `\$\{originalTitle\} \$\{originalContent\}`\)/.test(tr),
    '不传原文 ⇒ 原文本来就没月份的稿子会被逼着编月份，三次不过就丢稿',
  );
  ok('`headOfState` 进了 `ok`', /const ok =[\s\S]{0,400}headOfState\.length === 0/.test(tr));
  ok('`dateIssue` 进了 `ok`', /const ok =[\s\S]{0,400}!dateIssue/.test(tr));
  ok('reject 里带上了 headOfState', /\.\.\.\(headOfState\.length > 0 \? \{ headOfState \}/.test(tr));
  ok('reject 里带上了 dateAmbiguous', /\.\.\.\(dateIssue \? \{ dateAmbiguous: dateIssue \}/.test(tr));
  ok(
    'termKind 覆盖了两个新 kind（否则 reject 存在但 kind 落在 impossible-multiple 上）',
    tr.includes("'wrong-head-of-state'") && tr.includes("'date-no-month'"),
  );
  ok(
    '丢稿记账把两条新闸也算进去了（否则稿子在丢但看不见）',
    /lastReject\?\.headOfState\?\.length/.test(tr) && /lastReject\?\.dateAmbiguous/.test(tr),
  );
  ok('统计里报了 headOfState / dateAmbiguous 两个计数', /headOfState:\s*0/.test(tr) && /dateAmbiguous:\s*0/.test(tr));
  ok(
    '拒绝原因拼进了重试修正指令（否则重试拿不到「该改成什么」）',
    /reject\.currency[\s\S]{0,600}替换成/.test(tr) && /reject\.wrongNouns[\s\S]{0,400}h\.right/.test(tr),
  );
  ok('`normalizeResult` 收到了 countryName（缺它就判不了国家）', /normalizeResult\(parsed, title, content, provider\.name, countryName\)/.test(tr));

  // 提示词侧
  ok('提示词里有 {CURRENCIES} 占位符', tr.includes('{CURRENCIES}'), '占位符被删了 → 表就发不出去');
  ok('buildPrompt 会替换 {CURRENCIES}', /\.replace\('\{CURRENCIES\}', currencyPromptTable\(\)\)/.test(tr));
  ok('提示词要求「原文里是什么货币就写什么货币」', tr.includes('原文里是什么货币就写什么货币'));
  ok('提示词禁掉了「苏丹国王」', tr.includes('苏丹国王'));

  // ---- 2026-10-11 加的提示词侧接线（缺一样，模型就不会写对，闸门只能一遍遍重试）----
  ok('提示词里有 {HEADSOFSTATE} 占位符', tr.includes('{HEADSOFSTATE}'), '占位符被删了 → 元首名发不出去');
  ok(
    'buildPrompt 会替换 {HEADSOFSTATE}（生成式注入，与闸门同一张表）',
    /\.replace\('\{HEADSOFSTATE\}', headOfStatePromptLine\(countryName\)\)/.test(tr),
  );
  ok('提示词要求元首写法「必须用约定俗成的中文译名」', tr.includes('必须用约定俗成的中文译名'));
  ok('提示词要求元首写法「全篇统一」', tr.includes('全篇统一'));
  // ⚠️ 2026-10-01 实测过「提示词里列出来的领导人名字被搬去当正文主语」——
  // 注入名字的同时**必须**带上这句禁令，否则等于用新错误换掉旧错误。
  ok(
    '提示词带上了「元首名字只是写法标准、不是素材」的禁令',
    tr.includes('写法标准') && tr.includes('不许**出现他的名字或职务'),
  );
  ok('提示词第 7 条要求日期带月份', tr.includes('日期必须带月份'));
  ok('提示词提醒「别把序数当日期」（14-я 不是 14 日）', tr.includes('别把序数当日期'));

  // ---- 修正指令（重试只有一次机会，分不清类的指令会把一种错换成另一种错）----
  ok(
    '修正指令把元首问题分成「拉丁写法」与「非元首」两类讲',
    /latinHits/.test(tr) && /impersonate/.test(tr),
    '合成一段的后果：模型会把非元首那个人直接替换成元首名字 —— 把一处错改成另一处更严重的错',
  );
  ok('修正指令明确「非元首那类不要靠替换名字修」', tr.includes('不要靠替换名字修'));
  ok(
    '修正指令说清了「原文确实没有月份时不要自己补」',
    tr.includes('确实没有') && tr.includes('就不要自己补一个'),
    '不说清的话，这段修正指令自己会制造凭空出现的日期',
  );

  // 可观测性侧
  ok('fetch-news 报出了术语闸计数', /termGate:\s*\{/.test(fetchSrc));
  ok(
    'fetch-news 报出了 headOfState / dateAmbiguous 两个计数（这两条闸首日要盯）',
    /headOfState:\s*translation\.termGate\.headOfState/.test(fetchSrc) &&
      /dateAmbiguous:\s*translation\.termGate\.dateAmbiguous/.test(fetchSrc),
  );
  ok('fetch-news 报出了表版本号', /tableVersion:\s*PROPER_NOUN_VERSION/.test(fetchSrc));
  ok('fetch-news 报出了活体探针与期望值', /probe:\s*termGateProbe\(\)/.test(fetchSrc) && /expected:\s*TERM_GATE_PROBE_EXPECT/.test(fetchSrc));
  // ⚠️ 硬闸必须报「丢了多少」—— 否则又回到「看不见的丢失」，那是本项目最忌讳的形态。
  ok('translate.ts 统计了「因术语闸丢稿」的篇数', /termGate\.dropped\+\+/.test(tr));
  ok('丢稿时打了一行**区分于网络失败**的日志', /是因为\*\*术语闸\*\*丢的/.test(tr));
  ok('fetch-news 报出了 dropped 与 dropSamples', /dropped:\s*translation\.termGate\.dropped/.test(fetchSrc) && /dropSamples:\s*translation\.termGate\.dropSamples/.test(fetchSrc));
  ok('丢稿样本记录了国名与标题（能直接定位到是哪一篇）', /dropSamples\.push\(/.test(tr));
}

// ============================================================
// 九、版本号
// ============================================================

section('九、版本号');

{
  ok('PROPER_NOUN_VERSION 非空', typeof PROPER_NOUN_VERSION === 'string' && PROPER_NOUN_VERSION.length > 0);
  const src = readFileSync(resolve(process.cwd(), 'src/lib/proper-nouns.ts'), 'utf8');
  ok(
    `术语表版本号与源码一致（当前 ${PROPER_NOUN_VERSION}）`,
    new RegExp(`PROPER_NOUN_VERSION = '${PROPER_NOUN_VERSION}'`).test(src),
    '改了表却没改版本号 —— 线上就没法用版本号区分两轮数据',
  );
}

console.log(`\n${'='.repeat(64)}`);
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项断言`);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
