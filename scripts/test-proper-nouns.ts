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
  currencyPromptTable,
  checkCurrencyCountryFit,
  checkWrongProperNouns,
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
  ok('期望值里三项「拦」三项「放行」（双向）', (TERM_GATE_PROBE_EXPECT.match(/拦\(/g) || []).length === 3
    && (TERM_GATE_PROBE_EXPECT.match(/放行/g) || []).length === 3, TERM_GATE_PROBE_EXPECT);

  // ⚠️ 探针**必须调用真判据**。手写 `return 'A:拦'` 也能让上面两条断言全绿，
  // 但那样测的是探针自己、不是闸门 —— 于是「判据被改坏」这件事永远测不出来。
  const self = readFileSync(resolve(process.cwd(), 'src/lib/proper-nouns.ts'), 'utf8');
  const body = self.slice(self.indexOf('export function termGateProbe'));
  ok('探针体内调用了 checkCurrencyCountryFit', body.includes('checkCurrencyCountryFit('), '手写结论 = 探针失效');
  ok('探针体内调用了 checkWrongProperNouns', body.includes('checkWrongProperNouns('), '手写结论 = 探针失效');
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

  // 可观测性侧
  ok('fetch-news 报出了术语闸计数', /termGate:\s*\{/.test(fetchSrc));
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
