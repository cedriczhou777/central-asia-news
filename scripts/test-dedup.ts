/**
 * 「同一件事」去重回归脚本。
 *
 * 用法：
 *   1. 固定语料（默认，不联网、不碰数据库）：
 *      pnpm tsx scripts/test-dedup.ts
 *   2. 真实数据体检（把线上 /api/articles 的返回存成 JSON 再喂进来）：
 *      pnpm tsx scripts/test-dedup.ts /tmp/live.json
 *
 * 为什么必须有固定语料：这套判据是**「删除类」规则** —— 删对了没奖励，
 * 删错了丢的是信息，而且不报错。上一个同类改动的经验（见
 * `.workbuddy/memory/2026-09-21.md` 的「双向回归集」）是：必须同时准备
 * 「必须合并」和「必须保留」两组语料，只测一边一定会调歪。
 *
 * 语料来源是真实的：下面那些标题/链接就是线上库里真实存在的行，
 * 包括用户 2026-09-21 在草稿预览里截到的那对阿斯塔纳桥梁新闻。
 */
import {
  canonicalUrl,
  originalTitleKey,
  similarity,
} from '../src/lib/utils';
import {
  availablePromptVersions,
  buildPairPrompt,
  candidatePairs,
  clusterPairs,
  dedupeStories,
  dedupeStoriesDeterministic,
  dedupeNearTitles,
  isNearSameTitleText,
  filterOversizedGroups,
  hasConflictingNumbers,
  hasOppositePolarity,
  identityKeys,
  numericTokensOf,
  NUMERIC_VETO_VERSION,
  isLlmJudgeEnabled,
  isSameTitle,
  isSameTitleText,
  judgeExplicitPairs,
  JUDGE_PROMPT_VERSION,
  JUDGE_TEMPERATURE,
  PAIR_CANDIDATE_MIN_SIM,
  PAIR_MAX_CANDIDATES,
  PAIR_PRIORITY_SIM,
  parseEventGroups,
  parsePairVerdict,
  TITLE_IDENTICAL_MIN_SIM,
  TITLE_MAX,
  TITLE_NEAR_MIN_CHARS,
  TITLE_NEAR_MIN_SIM,
  type StoryLike,
} from '../src/lib/same-event';
import { promptBuilderFor } from '../src/lib/judge-prompts';
import {
  PAIR_RECALL_KNOB_SPECS,
  parsePairRecallKnobs,
  parseProviderOnly,
  pairRecallKnobProbe,
} from '../src/lib/dedupe-knobs';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ----- 极简断言 -----

let passed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
  } else {
    failures.push(`${name}${detail ? ' —— ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`);
  }
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

// ============================================================
// 一、canonicalUrl：同一篇原文的各种链接变形必须归一
// ============================================================

section('canonicalUrl · 必须归一（同一篇原文）');

const EQUAL_GROUPS: Array<{ why: string; urls: string[] }> = [
  {
    why: 'Tazabek 的 ?from=rss（线上重复行里 8 组是这种）',
    urls: [
      'https://www.tazabek.kg/news:2536067?from=rss',
      'https://tazabek.kg/news:2536067',
      'http://www.tazabek.kg/news:2536067/',
    ],
  },
  {
    why: 'www 有无 + 末尾斜杠 + fragment',
    urls: [
      'https://egemen.kz/news/astanada-segiz-zholaqty-zhana-kopir-salynbaq',
      'https://www.egemen.kz/news/astanada-segiz-zholaqty-zhana-kopir-salynbaq/',
      'http://EGEMEN.KZ/news/astanada-segiz-zholaqty-zhana-kopir-salynbaq#top',
    ],
  },
  {
    why: 'utm_* 追踪参数（顺序不同也要归一）',
    urls: [
      'https://gazeta.uz/oz/2026/09/20/gold/?utm_source=telegram&utm_medium=social',
      'https://gazeta.uz/oz/2026/09/20/gold/?utm_medium=social&utm_source=telegram',
      'https://www.gazeta.uz/oz/2026/09/20/gold/',
    ],
  },
];

for (const g of EQUAL_GROUPS) {
  const keys = g.urls.map(canonicalUrl);
  ok(`归一：${g.why}`, new Set(keys).size === 1, `得到 ${JSON.stringify(keys)}`);
}

section('canonicalUrl · 必须区分（不同文章）');

const DIFFER_PAIRS: Array<{ why: string; a: string; b: string }> = [
  { why: 'AZERTAC 与 Trend.az 是不同来源', a: 'https://azertag.az/en/xeber/x-4422279', b: 'https://www.trend.az/azerbaijan/4225818.html' },
  { why: '同一站不同文章（id 不同）', a: 'https://newtimes.kz/kultura-i-sport/223827-a', b: 'https://newtimes.kz/kultura-i-sport/223824-b' },
  { why: '查询参数有语义时必须保留', a: 'https://x.kg/news?id=111', b: 'https://x.kg/news?id=222' },
];

for (const p of DIFFER_PAIRS) {
  ok(`区分：${p.why}`, canonicalUrl(p.a) !== canonicalUrl(p.b));
}

ok('空链接归一为空串', canonicalUrl('') === '' && canonicalUrl('   ') === '');

// ============================================================
// 二、originalTitleKey：同稿多链的指纹
// ============================================================

section('originalTitleKey');

ok(
  '同一原文标题（空白/标点/大小写不同）指纹一致',
  originalTitleKey('Azerbaijan to host "Power of Unity — 2026" joint military exercise') ===
    originalTitleKey('azerbaijan to host power of unity 2026 joint military exercise'),
);
ok('过短的标题不给指纹（避免撞车）', originalTitleKey('News') === '' && originalTitleKey('摘要') === '');
ok('不同原文标题指纹不同', originalTitleKey('Turkish embassy congratulates Azerbaijan on state sovereignty day') !==
  originalTitleKey('Israeli embassy congratulates Azerbaijan on state sovereignty day'));

// ============================================================
// 三、dedupeStoriesDeterministic：双向语料
// ============================================================

section('确定性去重 · 必须合并');

const BRIDGE_URL = 'https://egemen.kz/news/astanada-segiz-zholaqty-zhana-kopir-salynbaq';

/** 用户截图里的那一对：source_url 逐字相同，中文译名不同。 */
const BRIDGE_PAIR: StoryLike[] = [
  {
    title: '阿斯塔纳将建八车道新桥，缓解阿雷斯桥及马赫祖姆·埃利大道交通压力',
    content: '据 Egemen.kz 报道，阿斯塔纳市将新建一座八车道桥梁。该桥梁将连接阿雷斯桥、马赫祖姆·埃利大道及其他几条街道。此举旨在通过分流交通负荷，有效缓解上述路段的拥堵状况。',
    country_code: 'kz',
    source_url: BRIDGE_URL,
    original_title: 'Astana will build a new eight-lane bridge',
  },
  {
    title: '阿斯塔纳将新建一座七车道桥梁，以缓解交通负荷',
    content: '哈萨克斯坦政府计划在阿斯塔纳新建一座七车道桥梁，该桥梁将连接「阿雷斯」大桥、永恒之国大道及其他多条街道，以缓解交通负荷。这一项目由哈萨克斯坦交通部主导，旨在改善城市交通基础设施，提升通行效率。',
    country_code: 'kz',
    source_url: BRIDGE_URL,
    original_title: 'Astana will build a new eight-lane bridge',
  },
];

{
  const { kept, drops } = dedupeStoriesDeterministic(BRIDGE_PAIR);
  ok('桥梁对（同链接）合并为 1 条', kept.length === 1, `实际 ${kept.length}`);
  ok('桥梁对的丢弃原因记为 same_url', drops[0]?.reason === 'same_url', String(drops[0]?.reason));
}

/** 同一条新闻挂在两个不同链接下（同稿多链）→ 用原文标题指纹兜住。 */
{
  const pair: StoryLike[] = [
    {
      title: '阿塞拜疆将主办“团结的力量—2026”联合军事演习',
      content: '阿塞拜疆国防部宣布，代号为“团结的力量—2026”的联合军事演习将在阿塞拜疆举行。',
      country_code: 'az',
      source_url: 'https://azertag.az/en/xeber/military-exercise-4422279',
      original_title: 'Azerbaijan to host "Power of Unity - 2026" joint military exercise',
    },
    {
      title: '阿塞拜疆将主办“团结之力—2026”联合军事演习',
      content: '据 Trend.az 报道，代号为“团结的力量—2026”的联合军事演习将在阿塞拜疆举行。',
      country_code: 'az',
      source_url: 'https://www.trend.az/azerbaijan/society/4225601.html',
      original_title: 'Azerbaijan to host "Power of Unity - 2026" joint military exercise',
    },
  ];
  const { kept, drops } = dedupeStoriesDeterministic(pair);
  ok('同稿多链（链接不同、原文标题相同）合并', kept.length === 1, `实际 ${kept.length}`);
  ok('丢弃原因记为 same_original', drops[0]?.reason === 'same_original', String(drops[0]?.reason));
}

/** 链接变形（?from=rss / 末尾斜杠 / utm）在批内就要拦掉，不能等到库内比较。 */
{
  const trip: StoryLike[] = [
    { title: 'A', content: 'x', country_code: 'kg', source_url: 'https://www.tazabek.kg/news:2536067?from=rss', original_title: '' },
    { title: 'B', content: 'y', country_code: 'kg', source_url: 'http://tazabek.kg/news:2536067/', original_title: '' },
    { title: 'C', content: 'z', country_code: 'kg', source_url: 'https://tazabek.kg/news:2536067?utm_source=x', original_title: '' },
  ];
  const { kept } = dedupeStoriesDeterministic(trip);
  ok('同链接三种变形在批内合并为 1 条', kept.length === 1, `实际 ${kept.length}`);
}

section('确定性去重 · 必须保留（误合并 = 丢信息）');

interface KeepCase {
  why: string;
  a: StoryLike;
  b: StoryLike;
}

const MUST_KEEP: KeepCase[] = [
  {
    why: '土耳其大使馆 vs 以色列大使馆（同模板、不同主体）',
    a: {
      title: '土耳其驻阿塞拜疆大使馆祝贺阿塞拜疆国家主权日',
      content: '土耳其驻阿塞拜疆大使馆在巴库举行招待会，庆祝阿塞拜疆国家主权日。',
      country_code: 'az',
      source_url: 'https://www.trend.az/azerbaijan/4225964.html',
      original_title: 'Turkish embassy congratulates Azerbaijan on State Sovereignty Day',
    },
    b: {
      title: '以色列驻阿塞拜疆大使馆祝贺阿塞拜疆独立日',
      content: '以色列驻阿塞拜疆大使馆在巴库举行招待会，庆祝阿塞拜疆独立日。',
      country_code: 'az',
      source_url: 'https://azertag.az/en/xeber/israeli-embassy-111',
      original_title: 'Israeli embassy congratulates Azerbaijan on Independence Day',
    },
  },
  {
    why: '金价下跌 vs 金价上涨（字面极像、方向相反）',
    a: {
      title: '全球市场黄金和白银价格下跌',
      content: '据阿塞拜疆通讯社报道，全球市场黄金和白银价格下跌。',
      country_code: 'az',
      source_url: 'https://azertag.az/en/xeber/gold_and_silver_prices_fall-4422279',
      original_title: 'Gold and silver prices fall on global markets',
    },
    b: {
      title: '全球市场黄金和白银价格上涨',
      content: '据阿塞拜疆通讯社报道，全球市场黄金和白银价格上涨。',
      country_code: 'az',
      source_url: 'https://azertag.az/en/xeber/gold_and_silver_prices_rise-4419282',
      original_title: 'Gold and silver prices rise on global markets',
    },
  },
  {
    why: '不同州的两座桥（不同项目）',
    a: {
      title: '哈萨克斯坦东哈萨克斯坦州完成新建桥梁建设，主跨175米',
      content: '东哈萨克斯坦州完成一座新建桥梁建设，主跨175米。',
      country_code: 'kz',
      source_url: 'https://egemen.kz/news/bridge-east-kz',
      original_title: 'A new bridge was completed in East Kazakhstan region',
    },
    b: {
      title: '阿斯塔纳将建八车道新桥，缓解阿雷斯桥及马赫祖姆·埃利大道交通压力',
      content: '据 Egemen.kz 报道，阿斯塔纳市将新建一座八车道桥梁，连接阿雷斯桥与马赫祖姆·埃利大道。',
      country_code: 'kz',
      source_url: BRIDGE_URL,
      original_title: 'Astana will build a new eight-lane bridge',
    },
  },
  {
    why: '两位不同运动员夺金',
    a: {
      title: '哈萨克斯坦自行车运动员 Aleksei Lutsenko 在亚洲运动会夺得金牌',
      content: '哈萨克斯坦自行车运动员 Aleksei Lutsenko 在亚洲运动会男子公路赛中夺得金牌。',
      country_code: 'kz',
      source_url: 'https://newtimes.kz/kultura-i-sport/223827-lutsenko',
      original_title: 'Aleksei Lutsenko brings Kazakhstan the second gold of Asian Games',
    },
    b: {
      title: '哈萨克斯坦自行车女运动员在2026年亚洲运动会夺得金牌',
      content: '哈萨克斯坦自行车女运动员在2026年亚洲运动会场地赛中夺得金牌，这是她的首枚亚运金牌。',
      country_code: 'kz',
      source_url: 'https://newtimes.kz/kultura-i-sport/223824-velogonshchitsa',
      original_title: 'Kazakh female cyclist wins gold at the 2026 Asian Games',
    },
  },
];

for (const c of MUST_KEEP) {
  const { kept, drops } = dedupeStoriesDeterministic([c.a, c.b]);
  ok(
    `保留：${c.why}`,
    kept.length === 2,
    kept.length < 2 ? `被误判为重复（reason=${drops[0]?.reason}）` : '',
  );
}

section('identityKeys：没有可用身份的条目不应互相合并');

{
  // 这两条既没有链接也没有原文标题，只能靠标题/正文判。
  // 它们标题差异明显（「台风预警」vs「铁路运费」），必须都保留。
  const noId: StoryLike[] = [
    { title: '气象部门发布台风蓝色预警', content: '气象部门今日发布台风蓝色预警，提醒沿海地区做好防范。', country_code: 'tj', source_url: '', original_title: '' },
    { title: '铁路货运运费标准将下调', content: '铁路部门宣布，下月起货运运费标准将下调百分之五。', country_code: 'tj', source_url: '', original_title: '' },
  ];
  ok('空身份不产生 key', identityKeys(noId[0]).length === 0);
  ok('两条空身份、标题不同的条目都保留', dedupeStoriesDeterministic(noId).kept.length === 2);
}

{
  // 标题几乎相同但正文为空/不同 —— 旧判据（标题相似度≥0.8）会把它们合并，
  // 新判据要求**标题和正文都逐字接近**，所以必须保留。
  // 这正是「金价下跌/上涨」那类误杀的成因，单独钉一条回归。
  const nearTitle: StoryLike[] = [
    { title: '全球市场黄金和白银价格下跌', content: '', country_code: 'az', source_url: '', original_title: '' },
    { title: '全球市场黄金和白银价格上涨', content: '', country_code: 'az', source_url: '', original_title: '' },
  ];
  ok(
    '仅有标题相近（正文缺失）不判重',
    dedupeStoriesDeterministic(nearTitle).kept.length === 2,
    '标题相似度高但正文不一致时不应合并',
  );
}

{
  // 真正的逐字重复：两个入口各抓了一份完全一样的文本 → 必须合并
  const identical: StoryLike[] = [
    { title: '阿斯塔纳将建八车道新桥', content: '据 Egemen.kz 报道，阿斯塔纳市将新建一座八车道桥梁。', country_code: 'kz', source_url: '', original_title: '' },
    { title: '阿斯塔纳将建八车道新桥', content: '据 Egemen.kz 报道，阿斯塔纳市将新建一座八车道桥梁。', country_code: 'kz', source_url: '', original_title: '' },
  ];
  const { kept, drops } = dedupeStoriesDeterministic(identical);
  ok('逐字重复（无链接无原文标题）仍能兜住', kept.length === 1, `实际 ${kept.length}`);
  ok('逐字重复的丢弃原因记为 same_text', drops[0]?.reason === 'same_text', String(drops[0]?.reason));
}

// ============================================================
// 三之二、same_title：中译标题逐字相同、正文详略可以差很远
//
// 2026-09-23 新增。来源是真实漏判（10 天 × 5 国、1674 篇库内行里量到 3 对）：
// 同一件事被两家源各写一遍时，中译**标题**一字不差，但中译**正文**详略迥异
// （实测正文相似度只有 0.138 / 0.155 / 0.274），旧判据要求正文 ≥0.8 ⇒ 全部漏掉。
// 这一节同时钉住「必须合并」与「必须保留」两侧 —— 删除类规则只测一边一定会调歪。
// ============================================================

section('same_title · 标题逐字相同但正文迥异');

{
  // 必须合并：真实案例形态（az 伊朗航空，Modern.az ↔ APA），正文详略差很远
  const sameTitle: StoryLike[] = [
    {
      title: '伊朗航空公司暂停飞往阿塞拜疆的航班',
      content: '伊朗航空公司宣布暂停飞往阿塞拜疆的航班，恢复时间另行通知。',
      country_code: 'az', source_url: 'https://modern.az/a', original_title: 'Iran Hava Yolları...',
    },
    {
      title: '伊朗航空公司暂停飞往阿塞拜疆的航班',
      content: '据报道，伊朗航空公司因故暂停了飞往阿塞拜疆的航班。公司未说明具体原因，也未给出复航时间表。',
      country_code: 'az', source_url: 'https://apa.az/b', original_title: 'Иранские авиакомпании...',
    },
  ];
  const { kept, drops } = dedupeStoriesDeterministic(sameTitle);
  ok('标题逐字相同、正文迥异 → 合并为一条', kept.length === 1, `实际 ${kept.length}`);
  ok('丢弃原因记为 same_title', drops[0]?.reason === 'same_title', String(drops[0]?.reason));
  ok('保留的是先出现的那条（保序）', kept[0]?.source_url === 'https://modern.az/a');
}

{
  // 必须保留：长标题只差一个字 → 实测 ≈0.92 < 0.95。
  // 这条钉的是「别为了多合几条就把门槛往下调」：差一个字可能是两个不同的人/批次。
  const oneCharOff: StoryLike[] = [
    { title: '哈萨克斯坦总统托卡耶夫会见国际俄语组织秘书长博恰罗娃', content: '', country_code: 'kz', source_url: '', original_title: '' },
    { title: '哈萨克斯坦总统托卡耶夫会见国际俄语组织秘书长博恰罗夫', content: '', country_code: 'kz', source_url: '', original_title: '' },
  ];
  ok(
    '长标题差 1 字（≈0.92）不合并',
    dedupeStoriesDeterministic(oneCharOff).kept.length === 2,
    '阈值 0.95 有意卡在「差一个字」之上，见 isSameTitle 的取舍说明',
  );
}

{
  // 必须保留：方向相反。这条是**双保险** —— 实测 0.81 本来就过不了 0.95，
  // 但 `hasOppositePolarity` 必须仍然拦得住，否则将来有人调低门槛就会删掉一条相反的事实。
  const opposite: StoryLike[] = [
    { title: '哈萨克斯坦央行将基准利率下调至百分之十二', content: '', country_code: 'kz', source_url: '', original_title: '' },
    { title: '哈萨克斯坦央行将基准利率上调至百分之十二', content: '', country_code: 'kz', source_url: '', original_title: '' },
  ];
  ok('反向极性对被确定性否决', hasOppositePolarity(opposite[0].title, opposite[1].title));
  ok('反向极性对不合并（即使标题很像）', dedupeStoriesDeterministic(opposite).kept.length === 2);
  // 直接钉住判据本身：把门槛降到 0 也必须是否决
  ok('isSameTitle 对反向极性恒为 false', !isSameTitle(opposite[0], opposite[1]));
}

{
  // 必须保留：危险的三类低分对（实测 0.40–0.55），确认离门槛足够远
  const risky: Array<[string, string, string]> = [
    ['不同地点的同名项目', '东哈萨克斯坦州将新建一座跨河桥梁', '阿斯塔纳市将新建一座跨河桥梁'],
    ['同主体不同事', '哈萨克斯坦政府任命Arsen Zhakhanbaev为水资源与灌溉事务副总理', '哈萨克斯坦任命 Arsen Zhakhanbaev 为水利灌溉部副部长'],
    ['同题不同场', '上合组织反垄断机构负责人会议在杜尚别举行', '上合组织经贸部长会议在杜尚别举行'],
  ];
  for (const [label, a, b] of risky) {
    const rows: StoryLike[] = [
      { title: a, content: '', country_code: 'kz', source_url: '', original_title: '' },
      { title: b, content: '', country_code: 'kz', source_url: '', original_title: '' },
    ];
    ok(`危险类不合并：${label}`, dedupeStoriesDeterministic(rows).kept.length === 2);
  }
}

{
  // 门槛本身：常量必须有明确值，且必须严于「正文+标题」那条的标题半边（0.9）
  ok('TITLE_IDENTICAL_MIN_SIM 为 0.95', TITLE_IDENTICAL_MIN_SIM === 0.95, String(TITLE_IDENTICAL_MIN_SIM));
  ok('标题门槛严于 same_text 的标题半边（0.9）', TITLE_IDENTICAL_MIN_SIM > 0.9);
  ok('空标题不触发', !isSameTitle({ title: '' }, { title: '' }));
  ok('缺标题字段不触发', !isSameTitle({ title: '' }, { title: '阿斯塔纳将建八车道新桥' }));
}

{
  // isSameTitleText：闸 2（跨轮、入库前）复用的文本级形态，2026-09-24 加。
  // 核心要求：与 isSameTitle **逐字同一份代码** —— 这组断言钉的是「不会分叉」，
  // 不是重新测一遍阈值（阈值在上面那组已经钉过）。
  const cases: Array<[string, string, boolean, string]> = [
    ['哈萨克斯坦计划于 2027 年启动无人驾驶出租车服务', '哈萨克斯坦计划于 2027 年启动无人驾驶出租车服务', true, '库内真重复 3741|3915，sim=1.000'],
    ['伊朗航空公司暂停飞往阿塞拜疆的航班', '伊朗航空公司暂停飞往阿塞拜疆的航班', true, '库内真重复 4134|4164，sim=1.000'],
    ['哈萨克斯坦总统托卡耶夫会见国际俄语组织秘书长博恰罗娃', '哈萨克斯坦总统托卡耶夫会见国际俄语组织秘书长博恰罗夫', false, '差 1 字 ≈0.92，闸 2 丢的行不可追，不放行'],
    ['全球市场黄金和白银价格下跌', '全球市场黄金和白银价格上涨', false, '反向极性'],
    ['无标题', '无标题', false, '占位标题：normalizeText 后相似度是 1.0，靠谓词本体否决'],
    ['', '任何标题', false, '空标题'],
  ];
  for (const [a, b, want, why] of cases) {
    ok(`isSameTitleText「${a.slice(0, 14)}…」vs「${b.slice(0, 14)}…」→ ${want ? '同一件事' : '不同'}（${why}）`,
      isSameTitleText(a, b) === want);
  }
  // 与 isSameTitle 的一致性：同输入必须同结论（防「两边各改一边」的分叉）
  for (const [a, b] of cases.map((c) => [c[0], c[1]] as [string, string])) {
    ok(`isSameTitle 与 isSameTitleText 同结论（「${a.slice(0, 10)}…」）`,
      isSameTitle({ title: a }, { title: b }) === isSameTitleText(a, b));
  }
}

// ============================================================
// 四、parseEventGroups：模型脏输出一律「不合并」
// ============================================================

section('parseEventGroups · 脏输出容错');

ok('正常 JSON', JSON.stringify(parseEventGroups('{"groups": [[0,2],[1,3,4]]}', 6)) === '[[0,2],[1,3,4]]');
ok('带 ```json 围栏', JSON.stringify(parseEventGroups('```json\n{"groups": [[0,1]]}\n```', 3)) === '[[0,1]]');
ok('前后带客套话', JSON.stringify(parseEventGroups('好的，结果如下：{"groups": [[0,1]]} 以上。', 3)) === '[[0,1]]');
ok('越界下标被剔除', JSON.stringify(parseEventGroups('{"groups": [[0,1,99]]}', 3)) === '[[0,1]]');
ok('单元素分组被丢弃', JSON.stringify(parseEventGroups('{"groups": [[0],[1,2]]}', 3)) === '[[1,2]]');
ok('重复下标去重', JSON.stringify(parseEventGroups('{"groups": [[1,1,2]]}', 3)) === '[[1,2]]');
ok('不是 JSON → null（调用方按「不合并」处理）', parseEventGroups('我觉得没有重复', 3) === null);
ok('缺少 groups 字段 → null', parseEventGroups('{"result": 1}', 3) === null);

// ----- 大组护栏：模型乱合并的兜底（2026-09-21 首次上线实测踩到）-----

section('filterOversizedGroups · 模型乱合并的兜底');

{
  // 真实踩到的形状：kg 一天 20 条里 18 条被判成一组（蒙古清洁行动、亚行羊绒贷款、
  // 学校拆除、柔道选举…），如果采信就是一次性删掉 17 条不同新闻。
  const runaway = [Array.from({ length: 18 }, (_, i) => i)];
  const g1 = filterOversizedGroups(runaway);
  ok('18 条的大组被整组丢弃', g1.kept.length === 0 && g1.rejected === 1, JSON.stringify(g1));

  // 线上真实重复簇最大 4 条 → 4 条必须放行，5 条必须丢
  const boundary = [[[0, 1]], [[0, 1, 2, 3]], [[0, 1, 2, 3, 4]]];
  const g2 = filterOversizedGroups(boundary.flat());
  ok('2 条与 4 条的组保留', g2.kept.length === 2 && g2.rejected === 1, JSON.stringify(g2));
}

// ============================================================
// 四之二、pair 形态：逐对二选一的解析、召回、合并
// ============================================================
//
// 为什么单独测这一层：`group` 形态（长串找组）2026-09-21 实测两次都失败 ——
// 关 thinking 时把所有下标都列进 groups，开 thinking 时按**话题**而非事件归并
// （哈萨克把「聚乙烯工厂」与「节水灌溉面积」并成一组）。改成 `pair` 之后，
// 风险从「模型答错」转移到了「我们怎么解释模型的答案」：
// 对→组的合并会不会借相似度传递出一个大簇、熔断在小样本上会不会误触发。
// 这些都是纯代码，必须有不依赖模型的断言守着。

section('parsePairVerdict · 只接受合法的对编号');

ok('正常 JSON', JSON.stringify(parsePairVerdict('{"same": [1, 4]}', 6)) === '[1,4]');
ok('空数组 = 一对都不合并', JSON.stringify(parsePairVerdict('{"same": []}', 6)) === '[]');
ok('带 ```json 围栏', JSON.stringify(parsePairVerdict('```json\n{"same": [0]}\n```', 3)) === '[0]');
ok('前后带解释文字', JSON.stringify(parsePairVerdict('判定如下：{"same": [2]} 完毕。', 3)) === '[2]');
ok('越界编号被剔除', JSON.stringify(parsePairVerdict('{"same": [0, 99]}', 3)) === '[0]');
ok('重复编号去重', JSON.stringify(parsePairVerdict('{"same": [1, 1, 1]}', 3)) === '[1]');
ok('非整数被剔除', JSON.stringify(parsePairVerdict('{"same": [0, "1", 2.5]}', 3)) === '[0]');
ok('不是 JSON → null（调用方按「不合并」处理）', parsePairVerdict('这几对都不是同一件事', 3) === null);
ok('缺少 same 字段 → null', parsePairVerdict('{"pairs": [1]}', 3) === null);
// 模型有时会抄提示词的示例格式但写错键名，绝不能因为「看起来有数组」就采信
ok('same 不是数组 → null', parsePairVerdict('{"same": "1,4"}', 3) === null);

section('candidatePairs · 召回（宁多问，不漏问）');

{
  const near = [
    { title: '阿斯塔纳跨阿雷斯河新建桥梁将设八车道' },
    { title: '阿斯塔纳跨阿雷斯河桥梁新建工程设七车道' },
    { title: '塔吉克斯坦总统就独立日发表贺词' },
  ];
  const cands = candidatePairs(near);
  ok('表述不同的同一件事进入候选', cands.some((c) => c.a === 0 && c.b === 1), JSON.stringify(cands));
  ok('无关条目不进候选', !cands.some((c) => c.b === 2 || c.a === 2), JSON.stringify(cands));

  // 召回是「宁可多问」：完全不相干的标题之间不该有形似对
  const far = [{ title: '哈萨克斯坦聚乙烯工厂投产' }, { title: '塔吉克斯坦桑搏世锦赛开幕' }];
  ok('完全无关的两条不产生候选对', candidatePairs(far).length === 0);

  // ⚠️ 2026-09-24 改：选对顺序从「所有对按 sim 降序取前 N」改成「**先保覆盖、再按 sim 填**」。
  //   所以「返回数组本身按 sim 降序」这个性质**不再成立** —— 覆盖轮选中的对是按条目顺序
  //   挑的（每条取自己最高分的那对），它们之间不一定降序。
  //   下面盯的是新的硬契约：**不浪费名额** + **不让条目沉默**。
  const mixed = [
    { title: '哈萨克斯坦总统会见中国外长' },
    { title: '哈萨克斯坦总统会见中国外交部长' }, // 与 0 很像
    { title: '哈萨克斯坦总统会见俄罗斯外长' },   // 与 0 一般像
  ];
  const sorted = candidatePairs(mixed, 0.3, 10);
  ok('名额没被浪费：有几对就给几对（≤ maxPairs）', sorted.length === 3, JSON.stringify(sorted.map((c) => c.sim)));
  ok(
    '每条都进了至少一个候选对（覆盖轮的作用）',
    [0, 1, 2].every((i) => sorted.some((c) => c.a === i || c.b === i)),
    JSON.stringify(sorted),
  );

  // 上限：超过就截断
  const many = Array.from({ length: 30 }, (_, i) => ({ title: `哈萨克斯坦总统会见中国外长代表团${i}` }));
  ok('候选数量受 maxPairs 限制', candidatePairs(many, 0.3, 5).length === 5);
}

// ------------------------------------------------------------
// ★ 覆盖优先：把「按相似度截断会饿死低分条目」这个缺陷钉住
// ------------------------------------------------------------

section('candidatePairs · ★ 覆盖优先（2026-09-24：修「按 sim 截断会饿死低分条目」）');

{
  /**
   * 线上真实案例：2026-09-24 用户截图里那三条 Unibank
   * （`id` 4638/4663/4673），标题相似度只有 **0.375 / 0.387 / 0.400**。
   *
   * 它们**过得了 0.35 的下限**，但分数偏低。旧实现按 sim 降序取前 12 对，
   * 名额会被模板稿（标题只差一两个字、相似度 0.8+）吃光 ⇒ 这三条一对都问不到。
   * 新实现先保覆盖，所以它们必然被问到。
   */
  const UNIBANK = [
    'Unibank 推出绿色贷款，年利率从 12% 起',
    'Unibank 推出面向企业主的绿色信贷：年利率低至 12%',
    'Unibank 为企业家提供绿色信贷：年利率从 12% 开始',
  ];
  // 模板稿：同一句式、只换项目名 ⇒ 彼此高度相似（就是线上「体育类模板稿占满名额」那个形态）
  const TEMPLATED = Array.from(
    { length: 20 },
    (_, i) => `阿塞拜疆与土耳其签署第 ${i + 1} 项双边合作协议`,
  );

  const items = [...TEMPLATED, ...UNIBANK].map((title) => ({ title }));
  const unibankIdx = UNIBANK.map((_, i) => TEMPLATED.length + i);
  const touchesUnibank = (pairs: Array<{ a: number; b: number }>) =>
    pairs.some((p) => unibankIdx.includes(p.a) || unibankIdx.includes(p.b));

  const chosen = candidatePairs(items, PAIR_CANDIDATE_MIN_SIM, PAIR_MAX_CANDIDATES);

  // 旧实现（按 sim 降序取前 N）—— 在测试里现算一遍做对照，好让「为什么要改」可复核
  const all: Array<{ a: number; b: number; sim: number }> = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const sim = similarity(items[i].title, items[j].title);
      if (sim >= PAIR_CANDIDATE_MIN_SIM) all.push({ a: i, b: j, sim });
    }
  }
  all.sort((x, y) => y.sim - x.sim || x.a - y.a || x.b - y.b);
  const oldStyle = all.slice(0, PAIR_MAX_CANDIDATES);

  const coverCount = (pairs: Array<{ a: number; b: number }>) =>
    new Set(pairs.flatMap((p) => [p.a, p.b])).size;

  ok(
    '名额仍然用满（不浪费预算）',
    chosen.length === PAIR_MAX_CANDIDATES,
    `得到 ${chosen.length}/${PAIR_MAX_CANDIDATES}`,
  );
  ok(
    '覆盖到的条目数严格多于旧实现',
    coverCount(chosen) > coverCount(oldStyle),
    `新 ${coverCount(chosen)} 条 vs 旧（按 sim 截断）${coverCount(oldStyle)} 条`,
  );
  ok(
    '★ 三条 Unibank（sim 0.375–0.400 的低分对）没有被饿死',
    touchesUnibank(chosen),
    '回归：这正是用户截图里那三条被推送了两次的新闻',
  );
  ok(
    '对照：旧实现确实会漏掉它们（证明这次改动不是白改）',
    !touchesUnibank(oldStyle),
    '若这里变 true，说明这个构造已不再复现缺陷，要换构造',
  );
  ok(
    '返回结果确定性（同样输入两次结果相同）',
    JSON.stringify(candidatePairs(items, PAIR_CANDIDATE_MIN_SIM, PAIR_MAX_CANDIDATES)) ===
      JSON.stringify(chosen),
    '同分对必须有稳定的次键，否则判定稳定性实验无法解读',
  );
  // 无候选时不能崩
  ok('一条都不像时返回空数组', candidatePairs([{ title: '甲' }, { title: '乙' }], 0.9, 5).length === 0);
}

// ------------------------------------------------------------
// ★ 顺序修复（2026-10-05）：名额不够时，被截掉的必须是**最不像**的
// ------------------------------------------------------------

section('candidatePairs · ★ 2026-10-05：覆盖轮按相似度排序');

{
  /**
   * ## 这条测的是什么
   *
   * 线上实测（`pnpm analyze:pair-recall 7` 第 3 节）：把下限从 0.35 降到 0.20 会
   * **丢掉 82 对**，而丢掉的恰恰是**最像的那些** —— 最高分那对是
   * `0.8400`「阿塞拜疆**与**乌兹别克斯坦国防部签署双边军事合作计划」
   * ↔「阿塞拜疆**和**乌兹别克斯坦国防部签署双边军事合作计划」。
   *
   * 成因：覆盖轮**按条目在数组里的位置**遍历。名额不够时，前面那些**不太像**的条目
   * 先把名额吃光，排在后面的高分对一对都问不到。**方向是反的。**
   *
   * ## 构造（必须让**旧算法**在这个构造下真的漏掉，否则这条测试等于没测）
   *
   * 6 条「彼此弱相关」的填充稿排在**前面**，一对「极像」的稿子排在**最后**，
   * 名额只给 3 对：
   *
   *   · 旧算法按位置走：i=0 选 (0,1) 覆盖 2 条、i=2 选 (2,3) 覆盖 2 条、
   *     i=4 选 (4,5) 覆盖 2 条 ⇒ 3 个名额在**还没走到第 6 条**时就用完了，
   *     那对 0.84 的稿子一对都问不到；
   *   · 新算法按「各自最高分」降序走：0.84 那对先占位，被截掉的是最不像的填充对。
   */
  const HIGH_A = '阿塞拜疆与乌兹别克斯坦国防部签署双边军事合作计划';
  const HIGH_B = '阿塞拜疆和乌兹别克斯坦国防部签署双边军事合作计划';
  /**
   * 6 条填充稿：**彼此**共享一个模板（`公布一季度…数据`）⇒ 互相 0.4–0.6；
   * 而那对稿子跟它们**只**共享「阿塞拜疆」⇒ 相似度落到下限之下、不产生跨对。
   *
   * 这两件事都是构造能复现缺陷的**必要条件**：
   *   · 填充对必须过得了下限（否则覆盖轮跳过它们、不占名额，旧算法照样能走到最后）；
   *   · 填充×极像的跨对必须**不过**下限（否则 `bestOf[填充]` 会指向那条极像的稿子，
   *     旧算法反而会「顺手」把它选进来 —— 第一版构造就是这么失效的）。
   */
  const FILLER = [
    '阿塞拜疆经济部公布一季度 GDP 数据',
    '阿塞拜疆央行公布一季度通胀数据',
    '阿塞拜疆铁路公布一季度客运数据',
    '阿塞拜疆农业公布一季度出口数据',
    '阿塞拜疆海关公布一季度贸易数据',
    '阿塞拜疆统计委公布一季度就业数据',
  ].map((title) => ({ title }));
  const items = [...FILLER, { title: HIGH_A }, { title: HIGH_B }];
  const highIdx = [FILLER.length, FILLER.length + 1];
  const CAP = 3;

  // 前置条件：那对稿子必须**真的**比所有填充对都像（否则构造已不再复现缺陷）
  const highSim = similarity(HIGH_A, HIGH_B);
  let maxFillerSim = 0;
  for (let i = 0; i < FILLER.length; i++) {
    for (let j = i + 1; j < FILLER.length; j++) {
      maxFillerSim = Math.max(maxFillerSim, similarity(FILLER[i].title, FILLER[j].title));
    }
  }
  ok(
    '前置条件：极像的那对确实比所有填充对都像（构造有效）',
    highSim > maxFillerSim,
    `极像 ${highSim.toFixed(4)} vs 填充最高 ${maxFillerSim.toFixed(4)}`,
  );

  const chosen = candidatePairs(items, 0.2, CAP);
  const touchesHigh = (pairs: Array<{ a: number; b: number }>) =>
    pairs.some((p) => highIdx.includes(p.a) || highIdx.includes(p.b));

  // 旧算法（按条目位置遍历覆盖轮）—— 在测试里现算一遍做对照
  const all: Array<{ a: number; b: number; sim: number }> = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const sim = similarity(items[i].title, items[j].title);
      if (sim >= 0.2) all.push({ a: i, b: j, sim });
    }
  }
  all.sort((x, y) => y.sim - x.sim || x.a - y.a || x.b - y.b);
  const bestOf = new Array<number>(items.length).fill(-1);
  for (let k = 0; k < all.length; k++) {
    if (bestOf[all[k].a] < 0) bestOf[all[k].a] = k;
    if (bestOf[all[k].b] < 0) bestOf[all[k].b] = k;
  }
  const legacy: typeof all = [];
  const legacyPicked = new Set<number>();
  const legacyCovered = new Set<number>();
  for (let i = 0; i < items.length && legacy.length < CAP; i++) {
    if (legacyCovered.has(i)) continue;
    const k = bestOf[i];
    if (k < 0) continue;
    legacyPicked.add(k);
    legacy.push(all[k]);
    legacyCovered.add(all[k].a);
    legacyCovered.add(all[k].b);
  }

  ok(
    '对照：**旧**顺序确实漏掉那对极像的稿子（证明这次改动不是白改）',
    !touchesHigh(legacy),
    '若这里变 true，说明构造已不再复现缺陷 —— 要换构造，而不是删掉这条断言',
  );
  ok(
    '★ 新顺序**问到**了那对极像的稿子（0.84 不再被 0.3 的挤掉）',
    touchesHigh(chosen),
    `实际选到 ${JSON.stringify(chosen.map((c) => c.sim.toFixed(3)))}`,
  );
  ok(
    '★ 被截掉的确实是**最不像**的那些：选中的最低分 ≥ 未入选项里的最高分',
    Math.min(...chosen.map((c) => c.sim)) >=
      Math.max(0, ...all.filter((p) => !chosen.some((c) => c.a === p.a && c.b === p.b)).map((p) => p.sim)),
    '这就是「按相似度截断」的定义 —— 旧实现不满足它',
  );
  ok('名额仍然用满', chosen.length === CAP, String(chosen.length));
}

// ------------------------------------------------------------
// ★ 2026-10-05：优先档 —— 降阈只许做加法（单调性）
// ------------------------------------------------------------

section('candidatePairs · ★ 优先档：降阈不得让原本会问的对变得问不到');
{
  /**
   * ## 这条测的是什么
   *
   * 下限从 0.35 降到 0.20 之后，`analyze:pair-recall` 第 3 节复量出**28 对**
   * 「原本会问、降阈后反而问不到」——最高分的还是 0.6786
   * 「阿塞拜疆 Azeri Light 原油价格**上涨 5.5 美元**」↔「…**接近125美元**」
   * （同批 145 对抢 40 个名额）。
   *
   * ## 机制（不是猜的，是 `/tmp` 探针在随机构造上搜出来的最小样例）
   *
   * **覆盖轮会把名额花在「低分对」上**：名额只剩 1 个时，覆盖轮先给某个**还没覆盖**的
   * 条目配它自己最高分的那一对（可能只有 0.2381）；而真正像的那对 (3,4) 因为
   * 两端**都已经**被更高的对覆盖过，覆盖轮轮不到它 —— 它本来只能在**填充轮**被捞起来，
   * 而填充轮已经没有名额了。**于是「像」输给了「覆盖」。**
   *
   * 分档之所以能修好：优先档的池子里**根本没有** 0.2381 那种对，
   * 它的覆盖轮 + 填充轮都在高分池内进行 ⇒ 高分对不可能被低分对挤出去。
   *
   * ## 构造（下面这个 6 条 / 上限 3 的样例是搜出来的，不是编的）
   *
   * 三条 ≥0.35 的对里，(3,4) **不是任何一端的最高分**（0 与 3 之间有 0.5），
   * 所以它只能靠填充轮；而低分对 (2,5) 只要抢到覆盖轮的最后一个名额就把它挤掉。
   * 对照断言（legacy）必须**在旧实现下真的漏**，否则这条测试等于没测 ——
   * 若它变 true，说明构造已不再复现缺陷，要换构造，**不是删掉断言**。
   */
  const items = [
    { title: '总统原油乌兹别克斯坦' },
    { title: '卢布巴库投资会谈' },
    { title: '德国总理阿塞拜疆接近阿斯塔纳项目' },
    { title: '原油项目乌兹别克斯坦' },
    { title: '乌兹别克斯坦卢布投资投资' },
    { title: '接近投资会谈阿塞拜疆项目' },
  ];
  const CAP = 3;
  const keyOf = (p: { a: number; b: number }) => `${p.a}|${p.b}`;

  // —— 前置条件：让这个构造「为什么有效」可核对 ——
  const sim03 = similarity(items[0].title, items[3].title);
  const sim04 = similarity(items[0].title, items[4].title);
  const sim34 = similarity(items[3].title, items[4].title);
  ok(
    '前置条件：三条对都过得了优先档（0.35），且 (0,3) 明显更像',
    sim03 >= PAIR_PRIORITY_SIM && sim04 >= PAIR_PRIORITY_SIM && sim34 >= PAIR_PRIORITY_SIM && sim03 > sim34,
    `(0,3)=${sim03.toFixed(4)} (0,4)=${sim04.toFixed(4)} (3,4)=${sim34.toFixed(4)}`,
  );

  // —— 对照：分档**之前**的单池实现在这个构造下真的漏 ——
  const refSinglePool = (minSim: number, maxPairs: number) => {
    const all: Array<{ a: number; b: number; sim: number }> = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const s = similarity(items[i].title, items[j].title);
        if (s >= minSim) all.push({ a: i, b: j, sim: s });
      }
    }
    all.sort((x, y) => y.sim - x.sim || x.a - y.a || x.b - y.b);
    const bestOf = new Array<number>(items.length).fill(-1);
    for (let k = 0; k < all.length; k++) {
      if (bestOf[all[k].a] < 0) bestOf[all[k].a] = k;
      if (bestOf[all[k].b] < 0) bestOf[all[k].b] = k;
    }
    const coverOrder = Array.from({ length: items.length }, (_, i) => i)
      .filter((i) => bestOf[i] >= 0)
      .sort((i, j) => all[bestOf[j]].sim - all[bestOf[i]].sim || i - j);
    const out: typeof all = [];
    const picked = new Set<number>();
    const covered = new Set<number>();
    for (const i of coverOrder) {
      if (out.length >= maxPairs) break;
      if (covered.has(i)) continue;
      const k = bestOf[i];
      picked.add(k);
      out.push(all[k]);
      covered.add(all[k].a);
      covered.add(all[k].b);
    }
    for (let k = 0; k < all.length && out.length < maxPairs; k++) {
      if (picked.has(k)) continue;
      picked.add(k);
      out.push(all[k]);
    }
    return out;
  };
  const legacyBase = new Set(refSinglePool(PAIR_PRIORITY_SIM, CAP).map(keyOf));
  const legacyWide = new Set(refSinglePool(PAIR_CANDIDATE_MIN_SIM, CAP).map(keyOf));
  const legacyLost = [...legacyBase].filter((k) => !legacyWide.has(k));
  ok(
    '对照：**单池**实现下，降阈确实丢掉了高分对（证明这条测试不是白写）',
    legacyLost.length > 0,
    `丢掉 ${JSON.stringify(legacyLost)}；若这里变 false，说明构造已不再复现缺陷 —— 要换构造，而不是删掉这条断言`,
  );
  ok(
    '对照：丢掉的那一对**不是**任何一端的最高分（这正是它只能靠填充轮的原因）',
    legacyLost.includes('3|4') && sim34 < sim03,
    `legacyLost=${JSON.stringify(legacyLost)} (3,4)=${sim34.toFixed(4)} < (0,3)=${sim03.toFixed(4)}`,
  );

  // —— ★ 当前实现：恒等式必须成立 ——
  const base = candidatePairs(items, PAIR_PRIORITY_SIM, CAP);
  const wide = candidatePairs(items, PAIR_CANDIDATE_MIN_SIM, CAP);
  const baseS = new Set(base.map(keyOf));
  const wideS = new Set(wide.map(keyOf));
  const missing = [...baseS].filter((k) => !wideS.has(k));
  ok(
    '★ 单调性：candidatePairs(0.20, cap) ⊇ candidatePairs(0.35, cap)',
    missing.length === 0,
    `0.35 口径选出 ${JSON.stringify([...baseS])}；0.20 口径漏掉 ${JSON.stringify(missing)}`,
  );
  ok(
    '★ (3,4) 那对不再被低分对挤掉（这就是「降阈只做加法」的可观测形态）',
    wideS.has('3|4'),
    `0.20 口径实际选出 ${JSON.stringify(wide.map((p) => `${keyOf(p)}@${p.sim.toFixed(4)}`))}`,
  );

  // —— 另一侧：补充档**不是**摆设（有名额时低分对仍要进来）——
  const wide4 = new Set(candidatePairs(items, PAIR_CANDIDATE_MIN_SIM, CAP + 1).map(keyOf));
  ok(
    '另一侧：名额多一个 ⇒ 补充档（0.20–0.35）的对仍然进得来',
    [...wide4].some((k) => !baseS.has(k)),
    `cap=${CAP + 1} 时选出 ${JSON.stringify([...wide4])}`,
  );

  // —— 常量本身的关系：三个数不许互相赋值（借图那个见 test-editor-review）——
  ok('PAIR_PRIORITY_SIM === 0.35（= 改动前的旧下限原值）', PAIR_PRIORITY_SIM === 0.35, String(PAIR_PRIORITY_SIM));
  ok(
    '★ 优先档下限**高于**召回下限（否则分档没有意义）',
    PAIR_PRIORITY_SIM > PAIR_CANDIDATE_MIN_SIM,
    `${PAIR_PRIORITY_SIM} vs ${PAIR_CANDIDATE_MIN_SIM}`,
  );
  ok(
    '上限 === 48（实测一周最大 44 对，40 会截掉真重复）',
    PAIR_MAX_CANDIDATES === 48,
    String(PAIR_MAX_CANDIDATES),
  );
}

// ------------------------------------------------------------
// ★ 2026-10-05：推送端专属的近同名闸（same_title_near）
// ------------------------------------------------------------

section('近同名闸 · ★ 推送端专属：0.70 + 长度下限 15 字 + 数字护栏');

{
  /**
   * ## 为什么要有这道闸
   *
   * 0.95 那道（`TITLE_IDENTICAL_MIN_SIM`）实测**几乎不起作用**：30 天 8468 篇里，
   * 同一推送窗口内中译标题 `sim ≥ 0.90` 只有 **1 对**，而 `0.70–0.90` 有 **44 对**。
   * 于是「同一件事被两家媒体各写一遍」绝大多数只能靠模型 —— 而模型会漏：
   * 线上实测（`GET /api/dedupe-check?days=1&llm=1`）它把下面**第一条正例**判成了「否」。
   *
   * ## 正例全部取自线上真实数据（30 天 45 对逐条看过，45/45 同一件事）
   *
   * 不是编的标题 —— 编的标题只能证明「我实现的判据和我编的标题一致」。
   */
  const POS: Array<[string, string, string]> = [
    [
      '★ 线上被模型判「否」的那对（本闸的直接动机）',
      '阿曼苏丹 Haitham bin Tariq Al Said 将对哈萨克斯坦进行国事访问',
      '阿曼苏丹 Haitham bin Tariq Al Said 将于10月5日至6日对哈萨克斯坦进行国事访问',
    ],
    [
      '专名音译差一个字母 + 多/少一个词',
      '美国投资者 Shervin Pishevar 想在哈萨克斯坦开设 Sofreh Capital 办公室',
      '美国投资者 Shervin Pishewar 在哈萨克斯坦开设 Sofreh Capital 办公室',
    ],
    [
      '多/少两个字（「诊断」）',
      '哈萨克斯坦 Saran 工厂将生产 Samsung Medison 超声波诊断设备',
      '哈萨克斯坦 Saran 工厂将生产 Samsung Medison 超声波设备',
    ],
    [
      '虚词之差（与 / 和）',
      '阿塞拜疆与乌兹别克斯坦国防部签署双边军事合作计划',
      '阿塞拜疆和乌兹别克斯坦国防部签署双边军事合作计划',
    ],
    [
      '动词同义（参观 / 视察）',
      '阿利耶夫总统参观 ADEX 2026 与 Securex Caspian 展览',
      '阿利耶夫总统视察 ADEX 2026 与 Securex Caspian 展览',
    ],
    ['括号后缀「（更新）」', '阿塞拜疆大奖赛第三场练习赛结束', '阿塞拜疆大奖赛第三场练习赛结束（更新）'],
  ];
  for (const [why, a, b] of POS) {
    ok(`正例：${why}｜sim=${similarity(a, b).toFixed(4)}`, isNearSameTitleText(a, b));
  }

  // ---- 反例 ①：短标题差一个实体词，相似度**自己**就到 0.80 ----
  // 这是长度下限存在的**唯一理由**，所以既断言「危险是真实的」，也断言「闸门挡得住」。
  const SHORT_A = '托卡耶夫会见德国总统';
  const SHORT_B = '托卡耶夫会见德国总理';
  const shortSim = similarity(SHORT_A, SHORT_B);
  ok(
    '反例①前置条件：这对**短**标题的相似度确实 ≥ 阈值（危险是真实的，不是假想）',
    shortSim >= TITLE_NEAR_MIN_SIM,
    `${shortSim.toFixed(4)} ≥ ${TITLE_NEAR_MIN_SIM}，长度 ${SHORT_A.length}/${SHORT_B.length}`,
  );
  ok(
    '★ 反例①：长度下限把它们挡下（德国总统 ≠ 德国总理，两条不同的会见）',
    !isNearSameTitleText(SHORT_A, SHORT_B),
    `长度下限 ${TITLE_NEAR_MIN_CHARS}，本条 ${Math.min(SHORT_A.length, SHORT_B.length)}`,
  );
  ok(
    '反例①：`same_title`（0.95）本来也拦不住它们 ⇒ 这条必须由长度下限兜，不能删',
    !isSameTitleText(SHORT_A, SHORT_B),
  );

  // ---- 正例 ②：0.70–0.75 档（2026-10-05 **改判为同一件事**）----
  //
  // 这里原先写的是「0.70–0.75 档**故意**留给模型」，理由是「该档已出现实体词级替换，
  // 属于语义判断」。2026-10-05 把 30 天 × 5 国的**全档 44 对逐条看完**之后，
  // 那个理由**一个实例都没有** —— 该档 17 对全是同一件事（译文重复字、专名变体、
  // 同义动词、可选年份/主体…），于是阈值降到 0.70。
  // ⇒ 这条断言从「必须不合并」**翻转**为「必须合并」，翻转依据记在 `TITLE_NEAR_MIN_SIM`。
  const MID_A = '阿塞拜疆与塞尔维亚讨论战略伙伴关系';
  const MID_B = '阿塞拜疆与塞尔维亚战略伙伴关系关系';
  const midSim = similarity(MID_A, MID_B);
  ok(
    '正例②前置条件：这对落在 0.70–0.75 档（**旧阈值的漏网区**）',
    midSim >= 0.7 && midSim < 0.75,
    midSim.toFixed(4),
  );
  ok(
    '★ 正例②（判定已翻转）：0.70–0.75 档现在**合并** —— 30 天实测该档 17/17 都是同一件事',
    isNearSameTitleText(MID_A, MID_B),
    `sim=${midSim.toFixed(4)}，阈值 ${TITLE_NEAR_MIN_SIM}`,
  );

  // ---- 反例 ③：松阈值下三条守卫更省不得 ----
  ok(
    '反例③：方向相反（涨/跌）优先于阈值',
    !isNearSameTitleText('阿塞拜疆原油价格上涨 5.5 美元', '阿塞拜疆原油价格下跌 5.5 美元'),
  );
  ok('反例③：占位标题不互相合并', !isNearSameTitleText('无标题', '无标题'));

  // ============================================================
  // ★ 数字护栏（2026-10-05 新增，`hasConflictingNumbers`）
  // ============================================================
  //
  // 为什么降阈值必须**成对**加上它：纯相似度在「长共同模板 + 极短差异槽」上
  // **双向**失效，而且构造得出实例：
  //
  //   「哈萨克斯坦总统任命 X 为国防部长」↔「…为紧急情况部长」  sim=0.7714  ← 不同事件却在闸内
  //
  // 数字冲突是其中**唯一能用确定性判据切开**的一类，而它恰好对应**静默丢数据**
  // （同一份统计公报的不同指标被当成一件事）。所以：降阈值 + 加这条守卫，成对做。

  // 数字抽取本身：只认阿拉伯数字（中文数字是量级词，不是「不同新闻」的证据）
  ok(
    'numericTokensOf：抽出阿拉伯数字与百分号，保序',
    JSON.stringify(numericTokensOf('阿塞拜疆2025年新住宅区占比98%')) === '["2025","98%"]',
    JSON.stringify(numericTokensOf('阿塞拜疆2025年新住宅区占比98%')),
  );
  ok(
    'numericTokensOf：中文数字**不**抽（「数十亿」不该产生 token）',
    JSON.stringify(numericTokensOf('哈萨克斯坦发现数十亿坚戈的逃税')) === '[]',
    JSON.stringify(numericTokensOf('哈萨克斯坦发现数十亿坚戈的逃税')),
  );

  const NUM_CONFLICT: Array<[string, string, string]> = [
    ['统计公报·不同指标（az 实测 8 对那一类）', '阿塞拜疆2025年新住宅区占比98%', '阿塞拜疆2025年建筑工作占比82.2%'],
    [
      '统计公报·不同指标（投资额 vs 占比）',
      '哈萨克斯坦2025年制造业投资额为6.628亿马纳特',
      '哈萨克斯坦2025年非油气资本投资占比75%',
    ],
    ['同模板·不同金额', '阿塞拜疆对某项目投资5.2亿马纳特', '阿塞拜疆对某项目投资3.1亿马纳特'],
    ['同模板·不同税率', '哈萨克斯坦增值税税率提高至16%', '哈萨克斯坦增值税税率提高至12%'],
  ];
  for (const [why, a, b] of NUM_CONFLICT) {
    ok(
      `数字护栏·否决：${why}`,
      hasConflictingNumbers(a, b),
      `a=[${numericTokensOf(a)}] b=[${numericTokensOf(b)}]`,
    );
    ok(`数字护栏·否决后近同名闸也不合并：${why}`, !isNearSameTitleText(a, b), `sim=${similarity(a, b).toFixed(4)}`);
  }

  const NUM_OK: Array<[string, string, string]> = [
    [
      '可选年份（[] vs [2026] ⇒ 子序列）',
      '哈萨克斯坦自行车运动员在亚洲运动会中夺得金牌',
      '哈萨克斯坦自行车运动员在2026年亚洲运动会中夺得金牌',
    ],
    [
      '数字完全相同（17.5%→12%）',
      '乌兹别克斯坦卡拉卡尔帕克斯坦将家庭创业贷款利率从17.5%降至12%',
      '乌兹别克斯坦卡拉卡尔帕克斯坦家庭创业贷款利率从17.5%下调至12%',
    ],
    [
      '中文数字 vs 阿拉伯（上个世纪 / 20世纪，同一句话）',
      '哈萨克斯坦总统 Tokayev：我军已停滞于上个世纪',
      '哈萨克斯坦总统 Tokayev：我军已停滞在20世纪',
    ],
    [
      '数字相同（48 处）',
      '吉尔吉斯斯坦楚伊州警方在反极端主义行动中搜查48处地点',
      '吉尔吉斯斯坦楚伊州警方在反恐行动中搜查48处地址',
    ],
    [
      '一边多写了日期（子序列）',
      '阿曼苏丹 Haitham bin Tariq Al Said 将对哈萨克斯坦进行国事访问',
      '阿曼苏丹 Haitham bin Tariq Al Said 将于10月5日至6日对哈萨克斯坦进行国事访问',
    ],
  ];
  for (const [why, a, b] of NUM_OK) {
    ok(
      `数字护栏·放行：${why}`,
      !hasConflictingNumbers(a, b),
      `a=[${numericTokensOf(a)}] b=[${numericTokensOf(b)}]`,
    );
  }

  // ---- ★ 护栏与「哪一层」的边界（两条，都试过、都有代价）----
  //
  // 边界一：**不得**进 0.95 那道（`isSameTitleText`）。它在**入库端**也跑，
  //         丢的行不可追；「同一件事、两家四舍五入不同」在那条线上必须照常合并。
  {
    const A = '哈萨克斯坦共和国国家统计局公布2025年前三季度制造业固定资产投资总额为6.628亿马纳特同比增长百分之三点一';
    const B = '哈萨克斯坦共和国国家统计局公布2025年前三季度制造业固定资产投资总额为6.638亿马纳特同比增长百分之三点一';
    const sim = similarity(A, B);
    ok(
      '边界①前置：这对**数字冲突**（6.628 vs 6.638），且已过近同名闸的第一关（够像）',
      hasConflictingNumbers(A, B) && sim >= TITLE_NEAR_MIN_SIM,
      `sim=${sim.toFixed(4)}，A=[${numericTokensOf(A)}] B=[${numericTokensOf(B)}]`,
    );
    ok(
      '★ 边界①a：数字护栏**不**影响 0.95 那道闸 —— 它的行为就是「纯相似度」',
      isSameTitleText(A, B) === sim >= TITLE_IDENTICAL_MIN_SIM,
      `isSameTitleText=${isSameTitleText(A, B)}，sim=${sim.toFixed(4)}`,
    );
    ok(
      '★ 边界①b（源码级）：`titleDupAt` 本体里没有数字护栏 —— 它同时给入库端闸 2 用',
      !readFileSync(resolve(process.cwd(), 'src/lib/same-event.ts'), 'utf8')
        .slice(
          readFileSync(resolve(process.cwd(), 'src/lib/same-event.ts'), 'utf8').indexOf('function titleDupAt'),
          readFileSync(resolve(process.cwd(), 'src/lib/same-event.ts'), 'utf8').indexOf('function titleDupAt') + 400,
        )
        .includes('hasConflictingNumbers'),
    );
    ok(
      '★ 边界①c 对照：同一对在近同名闸（推送端、可逆）里被数字护栏拦住',
      !isNearSameTitleText(A, B),
      '两边行为不同是**有意的**（可逆性不对称）',
    );
  }

  // 边界二：**不得**用于否决模型判出的簇。
  // 行为层的守卫是下面「四之三」的端到端用例 ①（「75亿美元项目」↔「76亿美元投资项目」
  // 必须照模型说的合并）—— 那是**唯一**能证明「护栏没接到合并循环里」的断言。
  // 这里只钉版本号，防止有人改了判据却忘了递增（改了不递增 ⇒ 线上看不出换没换）。
  ok('NUMERIC_VETO_VERSION === 1（改动判据必须一起 +1）', NUMERIC_VETO_VERSION === 1, String(NUMERIC_VETO_VERSION));

  // ---- 常量关系 ----
  ok(
    'TITLE_NEAR_MIN_SIM === 0.7（2026-10-05 由 0.75 降下，依据 = 30 天全档逐条过目），且松于 0.95 那道',
    TITLE_NEAR_MIN_SIM === 0.7 && TITLE_NEAR_MIN_SIM < TITLE_IDENTICAL_MIN_SIM,
    `${TITLE_NEAR_MIN_SIM} / ${TITLE_IDENTICAL_MIN_SIM}`,
  );
  ok('TITLE_NEAR_MIN_CHARS === 15（= 实测 44 对里最短的那条）', TITLE_NEAR_MIN_CHARS === 15, String(TITLE_NEAR_MIN_CHARS));

  // ---- ★ 边界：只在推送端 ----
  // 入库端丢的行**事后不可追**（`fetch-news` 的闸 2 注释写死了这条规矩），
  // 所以同一对稿子在 `dedupeStoriesDeterministic`（入库端也跑）里**必须原样保留**，
  // 只有 `dedupeNearTitles`（推送端专属）才合并。这两条断言是那道边界的唯一守卫。
  const pool = [{ title: POS[0][1] }, { title: POS[0][2] }];
  ok(
    '★ 边界：`dedupeStoriesDeterministic`（入库端同样跑）**不**做近同名合并',
    dedupeStoriesDeterministic(pool).kept.length === 2,
    `实际保留 ${dedupeStoriesDeterministic(pool).kept.length} 条`,
  );
  const near = dedupeNearTitles(pool);
  ok(
    '★ 边界：`dedupeNearTitles`（推送端专属）合并，且 reason = `same_title_near`',
    near.kept.length === 1 && near.drops.length === 1 && near.drops[0]?.reason === 'same_title_near',
    JSON.stringify(near.drops.map((d) => d.reason)),
  );
  ok('保序：保留的是**第一条**（与其它确定性闸一致，不按长度挑）', near.kept[0]?.title === POS[0][1]);
  ok('没被数字护栏拦下时 `numericSpared` 为空', near.numericSpared.length === 0, JSON.stringify(near.numericSpared));

  // ---- ★ 护栏的**可观测性**：拦下 → 进 `numericSpared`，进不了 `drops` ----
  //
  // 这条断言存在的理由：护栏拦下的是「一次删除的取消」，它**不会出现在任何 `drops` 里**。
  // 没有这个字段，「护栏到底有没有在干活」就只能靠读代码猜 —— 而「不报错、没输出」
  // 正是本项目反复栽的那一类。
  {
    const sparedPool = [
      { title: '哈萨克斯坦2025年制造业投资额为6.628亿马纳特' },
      { title: '哈萨克斯坦2025年制造业投资额为6.63亿马纳特' },
    ];
    const r = dedupeNearTitles(sparedPool);
    ok('★ 护栏拦下时：两条都留住', r.kept.length === 2, `实际 ${r.kept.length} 条`);
    ok('★ 护栏拦下时：`drops` 为空（它不删东西，只是取消删除）', r.drops.length === 0, JSON.stringify(r.drops));
    ok(
      '★ 护栏拦下时：进了 `numericSpared` 并带上两边标题（唯一的可见证据）',
      r.numericSpared.length === 1 &&
        r.numericSpared[0].kept === sparedPool[0].title &&
        r.numericSpared[0].blocked === sparedPool[1].title,
      JSON.stringify(r.numericSpared),
    );
  }
}

// ------------------------------------------------------------
// ★ 判组提示词的校准：正例 / 反例 / 兜底句都不许被删
// ------------------------------------------------------------

section('buildPairPrompt · ★ 判组提示词的校准（正例/反例/兜底句）');

{
  /**
   * 这份提示词是整套机制的**核心资产**，而且它是一整块字符串 ——
   * 「顺手精简一下」不会让类型检查报错，症状要等下一轮影子运行才看得出来。
   *
   * ⚠️ 2026-09-24 的背景：原来这份提示词**只有反例、没有正例细化**，末句还是
   * 「拿不准就判否」。叠加判组温度 0（同一输入恒定输出）与兜底通道 `zhipu-flash`，
   * 漏合并变成**系统性**的 —— 实测把用户截图里那三条 Unibank（同一家公司
   * 同一个绿色信贷产品的三家媒体报道）判成「否」。所以下面那两条正例必须留着。
   */
  const P = buildPairPrompt([{ a: 0, b: 1 }], [
    { title: 'Unibank 推出绿色贷款，年利率从 12% 起' },
    { title: 'Unibank 推出面向企业主的绿色信贷：年利率低至 12%' },
  ]);

  // ---- 正例（防止「漏合并」回归：留下重复，用户看得见）----
  ok('正例：点明「不同媒体换词重写是同一件事最常见的形态」', P.includes('换词重写'));
  ok('正例：带上了 Unibank 那条真实案例', P.includes('Unibank'));
  ok('正例：点明「标题有笔误/重复字」也要判是', P.includes('笔误'));
  ok('正例仍保留「来源不同、措辞不同…也算同一件事」', P.includes('即使来源不同'));

  // ---- 反例（防止「误合并」回归：丢信息且不可逆）----
  ok('反例：「同组织同城市的不同活动」还在', P.includes('上合组织'));
  ok('反例：「否认某报道 vs 该报道本身」已补入', P.includes('否认'));
  ok('反例：方向相反还在', P.includes('金价下跌'));
  ok('反例：不同主体做同类事还在（土耳其/以色列大使馆）', P.includes('土耳其大使馆'));

  // ---- 兜底句：宁可留重复也不要误合并 ----
  ok('兜底句「拿不准就判「否」」必须保留（删掉等于放开误合并）', P.includes('拿不准就判「否」'));
  ok('兜底句写清了代价（丢信息比留重复更糟）', P.includes('丢信息'));

  // ---- 输入被正确带进提示词 ----
  ok('标题按行写入、行首带编号', /0 \| Unibank 推出绿色贷款/.test(P));

  // ---- 版本号：改提示词必须 +1，否则影子运行的结论会被读成旧版 ----
  ok(
    `判组提示词版本号 ≥ 2（当前 ${JUDGE_PROMPT_VERSION}）`,
    JUDGE_PROMPT_VERSION >= 2,
    '改了 buildPairPrompt 就要 +1，并在注释里记下这一版改了什么',
  );
}

section('hasOppositePolarity · 高相似度假阳性的确定性否决');

// 全部取自线上真实数据（`pnpm tsx scripts/peek-pairs.ts /tmp/live.json` 的候选表），
// 不是编的例子 —— 这里每一条的相似度都 ≥0.37，也就是说它们**都会**被问给模型。
{
  // 必须否决：相似度 0.71，候选表第一位。一条利多一条利空，合并等于删掉一条相反的事实。
  ok(
    '金价下跌 vs 金价上涨 → 否决',
    hasOppositePolarity('全球市场黄金和白银价格下跌', '全球市场黄金和白银价格上涨'),
  );

  // 必须放行：下面每一条都是**同一件事的两种译法**，误否决就是漏合并（留下重复）
  ok(
    '贷款利率「降至」vs「下调至」→ 放行（同向）',
    !hasOppositePolarity(
      '乌兹别克斯坦卡拉卡尔帕克斯坦将家庭创业贷款利率从17.5%降至12%',
      '乌兹别克斯坦卡拉卡尔帕克斯坦家庭创业贷款利率从17.5%下调至12%',
    ),
  );
  ok(
    '「提升医疗服务质量」两条 → 放行（同向）',
    !hasOppositePolarity(
      '哈萨克斯坦推进公共卫生系统现代化，数字技术助力提升医疗服务质量',
      '哈萨克斯坦政府将改进公共卫生系统，提升医疗服务质量',
    ),
  );
  ok(
    '「增长」vs 无方向词 → 放行（不构成反向）',
    !hasOppositePolarity('吉尔吉斯斯坦财政部预测2027年授权费收入将达92.4亿索姆', '吉尔吉斯斯坦财政部预测2027年销售税收入增至415.097亿索姆'),
  );

  // 明确**不在**本函数职责内的假阳性 —— 记在这里是为了避免以后把它当 bug 改：
  // 「停供气」vs「停供水」是同一类动作用在不同对象上，不是方向相反，
  // 只能靠模型看懂「气」和「水」不是一回事。这类必须由 L2 负责。
  ok(
    '停供气 vs 停供水 → 放行（交由模型判，不是极性冲突）',
    !hasOppositePolarity('比什凯克部分区域将暂停供气', '比什凯克部分区域9月22日将暂停供水'),
  );
  ok(
    '羊毛加工厂 vs 炼油厂 → 放行（交由模型判）',
    !hasOppositePolarity(
      '塔吉克斯坦总统拉赫蒙在戈罗诺-巴达赫尚自治州主持新羊毛加工厂投产仪式',
      '塔吉克斯坦总统拉赫蒙在苏维州戈罗诺-巴达赫尚自治州主持炼油厂投产仪式',
    ),
  );

  // 组合：这对**确实**会被召回（相似度超过下限），所以否决必须由极性判据接手 ——
  // 这正是「在问模型之前拦掉」能成立的前提，不成立的话这道护栏就是空的。
  const gold = [
    { title: '全球市场黄金和白银价格下跌' },
    { title: '全球市场黄金和白银价格上涨' },
  ];
  const goldPairs = candidatePairs(gold);
  ok('金价对确实会被召回', goldPairs.length === 1, JSON.stringify(goldPairs));
  ok(
    '召回之后被极性判据拦下（模型不会看到它）',
    goldPairs.every((c) => hasOppositePolarity(gold[c.a].title, gold[c.b].title)),
  );
}

section('clusterPairs · 对 → 组（并查集）');

ok('空输入', JSON.stringify(clusterPairs([])) === '[]');
ok('单对', JSON.stringify(clusterPairs([{ a: 0, b: 1 }])) === '[[0,1]]');
ok('不相交的两对各自成组', JSON.stringify(clusterPairs([{ a: 0, b: 1 }, { a: 2, b: 3 }])) === '[[0,1],[2,3]]');
// 三源报道同一件事：模型会同时答出 (0,1) 和 (0,2)，合成一组才不重复记账
ok('共享端点的两对并成一组', JSON.stringify(clusterPairs([{ a: 0, b: 1 }, { a: 0, b: 2 }])) === '[[0,1,2]]');
ok('组内按下标升序（保序保留第一条）', JSON.stringify(clusterPairs([{ a: 3, b: 1 }])) === '[[1,3]]');
ok('组间按下标升序', JSON.stringify(clusterPairs([{ a: 5, b: 6 }, { a: 1, b: 2 }])) === '[[1,2],[5,6]]');
ok('重复的同一对不重复计', JSON.stringify(clusterPairs([{ a: 0, b: 1 }, { a: 0, b: 1 }])) === '[[0,1]]');

// 关键护栏：链式传递会把 5 条串成一个簇。这不是「合并了 5 条重复」，
// 而是「模型的判定在借中间条目传递」（0↔2 未必是同一件事），必须整簇丢弃。
{
  const chain = clusterPairs([{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }, { a: 3, b: 4 }]);
  ok('传递性会把链条串成一个簇', JSON.stringify(chain) === '[[0,1,2,3,4]]', JSON.stringify(chain));
  const guarded = filterOversizedGroups(chain);
  ok('串成的 5 条簇被护栏整簇丢弃（宁可漏合并）', guarded.kept.length === 0 && guarded.rejected === 1, JSON.stringify(guarded));
  // 4 条以内是真的多源重复，必须放行
  const okChain = filterOversizedGroups(clusterPairs([{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }]));
  ok('4 条以内的簇正常保留', okChain.kept.length === 1 && okChain.rejected === 0, JSON.stringify(okChain));
}

// 配置通路的断言：pair 是生产默认形态，group 只能在显式指定时启用。
// 这是本文件里唯一需要 await 的检查（dedupeStories 是异步的），
// 而 tsx 把本脚本按 CJS 跑（package.json 没有 "type": "module"），不支持顶层 await，
// 所以单独成函数、在汇总前统一跑 —— 见文件末尾的调用。
async function modeChecks(): Promise<void> {
  const { llm } = await dedupeStories([{ title: '甲' }, { title: '乙' }], { useLlm: false });
  ok('未开 L2 时不调模型', llm.ran === false);
  ok('默认形态是 pair', llm.mode === 'pair', String(llm.mode));
  const g = await dedupeStories([{ title: '甲' }, { title: '乙' }], { useLlm: false, judge: { mode: 'group' } });
  ok('显式指定可为 group（仅供对照）', g.llm.mode === 'group', String(g.llm.mode));

  // L2 判定的采样温度必须是 0（贪心）。
  //
  // 这条断言没有别的用途，就是**防止有人把它改回去** —— 它的值不出现在任何
  // 输出里，改错了不会报错，只会让「同一批候选对两次跑出不同结论」。
  //
  // 为什么温度必须是 0：下游是**删除动作**，同一个输入两次跑出不同结论，
  // 这条链路就没法信任。这是设计上的必要性，与「实测有多不稳」无关。
  //
  // ⚠️ 这里刻意**不写任何「不稳程度」的数字**：早先那句「两次分别判出 4 对 / 10 对」
  // 是在**体检接口的错误输入**上测出来的（那批是亚运会体育新闻，而体育在推送前
  // 就被 `pushExclusionReason` 整类排除，根本进不了 L2）。用生产不会遇到的输入
  // 去给生产链路定性，是错的口径。真正的不稳程度至今**没有可信数字**。
  // `translate.ts` 的默认温度 0.3 是给翻译留用词变化用的，判定不能沿用它。
  ok(
    'L2 判定用贪心解码（temperature = 0），不吃翻译的 0.3',
    JUDGE_TEMPERATURE === 0,
    String(JUDGE_TEMPERATURE),
  );

  // 通道名必须被带出来（`llm.provider`）。
  //
  // 这个字段不改任何行为，所以**丢掉了不会有任何症状**，只会在排查
  // 「两次结论不同」时让人无法区分「换了通道」和「模型本身不稳」——
  // 2026-09-22 就因为缺它，只能停在「不稳定，原因未知」。
  const asked = fakeAsk(() => '{"same":[]}');
  const probe = await dedupeStories(
    [{ title: '哈萨克斯坦与中方签署铀矿开发协议' }, { title: '哈萨克斯坦与中方签署铀矿开发协议，总投资12亿美元' }],
    { useLlm: true, judge: { ask: asked.ask } },
  );
  ok('L2 结果带出回答通道名（丢了不会有症状，只能靠断言钉住）', probe.llm.provider === 'fake-model', String(probe.llm.provider));

  // group 形态也必须带通道名。
  //
  // 曾经这里只修了 pair：`llm.provider` 在 group 形态下静默为空。
  // 这正是本项目反复出现的「同一件事写两遍、只修一遍」——字段缺失没有症状，
  // 只有把形态切到 group 之后排查稳定性时才会发现「谁答的」问不出来。
  // 生产当前只用 pair，但护栏必须两种形态都在。
  const grouped = fakeAsk(() => '{"groups":[[0,1]]}');
  const gProbe = await dedupeStories(
    [{ title: '哈萨克斯坦与中方签署铀矿开发协议' }, { title: '哈萨克斯坦与中方签署铀矿开发协议，总投资12亿美元' }],
    { useLlm: true, judge: { mode: 'group', ask: grouped.ask } },
  );
  ok(
    'group 形态同样带出回答通道名（只修 pair 会留下无症状的缺口）',
    gProbe.llm.provider === 'fake-model',
    String(gProbe.llm.provider),
  );

  // ------------------------------------------------------------
  // L2 默认值（2026-09-28 从「关」翻成「开」）—— 翻转本身 + 两个调用点的口径差
  // ------------------------------------------------------------
  //
  // 为什么要断言「默认值」这种东西：它**没有输出、没有症状**，只有两个后果 ——
  //   · 有人无意改回去 ⇒ 跨源「同一件事」又开始漏（用户 09-28 报的那个问题复发），不报错；
  //   · 有人把它当全局开关 ⇒ **入库端跟着一起开**，而入库端开 L2 是净亏（见下）。
  // 两种都不会有任何日志，只能靠断言钉住。
  //
  // 口径分叉是**故意的**，不是不一致：
  //   · 推送端裸调用 ⇒ 跟默认值 ⇒ 开（用户报的重复是草稿里的重复，这里才治得了）
  //   · 入库端显式 false ⇒ 不跟 ⇒ 关（省不到翻译 / 花在抓取窗口 / 丢在入库端不可追）
  // 所以下面既断言「默认是开」，也断言「入库端钉死了关」。
  {
    const saved = process.env.SAME_EVENT_JUDGE;
    const restore = () => {
      if (saved === undefined) delete process.env.SAME_EVENT_JUDGE;
      else process.env.SAME_EVENT_JUDGE = saved;
    };
    try {
      delete process.env.SAME_EVENT_JUDGE;
      ok('未设 SAME_EVENT_JUDGE 时 L2 **默认开**（2026-09-28 翻转）', isLlmJudgeEnabled() === true);

      // 显式关仍然有效 —— 这是**不用改代码、不用发版**的紧急刹车，
      // 一旦观察到误合并，改环境变量重启即可回到旧行为。它必须好使。
      for (const off of ['off', 'OFF', '0', 'false', ' false ']) {
        process.env.SAME_EVENT_JUDGE = off;
        ok(`SAME_EVENT_JUDGE=${JSON.stringify(off)} 关掉 L2（紧急刹车可用）`, isLlmJudgeEnabled() === false);
      }
      for (const on of ['on', '1', 'true']) {
        process.env.SAME_EVENT_JUDGE = on;
        ok(`SAME_EVENT_JUDGE=${JSON.stringify(on)} 打开 L2（旧写法仍然认）`, isLlmJudgeEnabled() === true);
      }
    } finally {
      restore();
    }

    // 调用点口径：用源码断言。这是「删除类」开关，接错的表现是**静默丢稿**，
    // 而 route 文件不好做单测 —— 源码级断言在这里比没有断言强得多。
    try {
      const fetchSrc = readFileSync(resolve(process.cwd(), 'src/app/api/fetch-news/route.ts'), 'utf8');
      ok(
        '入库端（闸 3）显式关掉 L2，不跟默认值走',
        /dedupeStories\(list,\s*\{\s*useLlm:\s*false\s*\}\s*\)/.test(fetchSrc),
        '没找到 `dedupeStories(list, { useLlm: false })` —— 入库端会跟着默认值开 L2',
      );
      const pushSrc = readFileSync(resolve(process.cwd(), 'src/app/api/wechat/push/route.ts'), 'utf8');
      ok(
        '推送端裸调用 dedupeStories（跟默认值 ⇒ L2 开）',
        /dedupeStories\(eligible\)/.test(pushSrc),
        '推送端不再裸调用了 —— 如果改成显式传值，请把 L2 的开关口径同步写进 AGENTS.md',
      );
    } catch (e) {
      ok('能读到两个调用点的源码（读不到就无法守住口径差）', false, e instanceof Error ? e.message : String(e));
    }
  }
}

// ============================================================
// 四之三、整条 L2 链路的端到端断言（注入假模型，不联网、不需要 Key）
// ============================================================
//
// 前面几节测的都是**零件**（解析、召回、极性、合并）。这一节测**装配**：
// 模型的答案怎么一步步变成「删掉哪一条」。中间有四次「可能悄悄什么都不做」的
// 降级（没候选 / 调用失败 / 返回不合法 / 簇超限），一旦接错，
// 表现是**不报错地少删或多删**，只有把整条链路跑通才能发现。
//
// 用 `judge.ask` 注入假模型：调用点拿到的出口和真实版本同形，
// 所以这里测的就是生产路径，不是「另一条测试专用分支」。

/** 假模型：按提示词决定答案，同时记录收到的提示词（用来断言「什么被送出去了」）。 */
function fakeAsk(reply: (prompt: string) => string) {
  const seen: string[] = [];
  return {
    seen,
    ask: async (prompt: string) => {
      seen.push(prompt);
      // 带上 provider：真实出口（`askLlmJson`）成功时**必须**带通道名，
      // 调用方靠它区分「换了通道」与「模型本身不稳」。假模型也带上，
      // 才能断言这一路没有被丢掉（见 `llm.provider` 的断言）。
      return { ok: true as const, text: reply(prompt), provider: 'fake-model' };
    },
  };
}

async function llmPipelineChecks(): Promise<void> {
  // --- ① 模型判「是」的对，必须真的删掉那一条 ---
  {
    // 候选（按相似度降序）：金价对 0.71（会被极性拦下）、总统项目对 0.48
    const items = [
      { title: '乌兹别克斯坦总统在卡拉卡尔帕克斯坦启动总额75亿美元项目' },
      { title: '乌兹别克斯坦总统启动卡拉卡尔帕克斯坦76亿美元投资项目' },
      { title: '全球市场黄金和白银价格下跌' },
      { title: '全球市场黄金和白银价格上涨' },
    ];
    const { seen, ask } = fakeAsk(() => '{"same": [0]}');
    const res = await dedupeStories(items, { useLlm: true, judge: { ask } });

    ok('L2 确实跑了并判定成功', res.llm.ran && res.llm.ok, JSON.stringify(res.llm).slice(0, 160));
    ok('候选对数是 2（金价对 + 项目对）', res.llm.candidateCount === 2, String(res.llm.candidateCount));
    ok('金价对被记为 vetoed', res.llm.vetoed?.length === 1, JSON.stringify(res.llm.vetoed));
    // 只比 a/b：`pairs` 现在还带 `sim`（三条列表统一形状，见 `PairJudgeResult`），
    // 用整串 JSON 比对会把「多了一个字段」误报成「下标映射错了」——
    // 这条断言要钉的是**下标**，不该被字段增减牵连。
    const abOf = (ps?: Array<{ a: number; b: number }>) => JSON.stringify(ps?.map((p) => ({ a: p.a, b: p.b })));
    ok('判「是」的对映射回原下标 0,1', abOf(res.llm.pairs) === '[{"a":0,"b":1}]', JSON.stringify(res.llm.pairs));
    ok(
      '判「是」的对也带 sim（与 vetoed / declined 同形状）',
      typeof res.llm.pairs?.[0]?.sim === 'number',
      JSON.stringify(res.llm.pairs),
    );

    // ★ 整套护栏的核心断言：被极性拦下的对**根本没有进入提示词**，
    //   模型连看到它的机会都没有 —— 所以「答什么都无效」是结构上成立的，
    //   不是依赖它自觉。这条如果挂了，极性护栏就只是装饰。
    //
    //   ⚠️ 只能检查**数据行**（`# | 标题A || 标题B` 之后），不能检查整份提示词：
    //   反例清单里本来就写着「方向相反：「金价下跌」与「金价上涨」」，
    //   在整份文本里搜「下跌」会永远命中 —— 这个坑第一版就踩了。
    const prompt = seen.join('\n');
    const marker = '# | 标题A || 标题B';
    const dataPart = prompt.includes(marker) ? prompt.slice(prompt.indexOf(marker) + marker.length) : '';
    ok('数据行里没有金价那对', !dataPart.includes('上涨') && !dataPart.includes('下跌'), dataPart);
    ok('数据行里有项目那对', dataPart.includes('75亿美元') && dataPart.includes('76亿美元'), dataPart);
    ok('数据行恰好 1 行（2 个候选对里拦掉 1 对）', dataPart.trim().split('\n').length === 1, dataPart);

    ok('模型判是 → 确实删掉 1 条', res.drops.length === 1, JSON.stringify(res.drops.map((d) => d.reason)));
    ok('丢弃原因是 llm_same_event', res.drops[0]?.reason === 'llm_same_event', String(res.drops[0]?.reason));
    ok('保留组内第一条', (res.drops[0]?.kept as { title: string })?.title === items[0].title);
    ok('丢掉第二条', (res.drops[0]?.dropped as { title: string })?.title === items[1].title);
    ok('最终保留 3 条（4 − 1）', res.kept.length === 3, String(res.kept.length));
  }

  // --- ② 模型「全答是」时，簇护栏必须整簇丢弃（一条都不删）---
  {
    /**
     * ⚠️ 2026-10-05 换过构造 —— 旧构造（5 条只差一个动词的「会见中国外长…」）**已经到不了这一段**：
     * 它们两两 ≥0.75（现已 ≥0.70），会被**近同名闸**在 L2 之前就确定性合并掉，
     * 于是「模型全答是」这个场景根本走不到超大簇护栏。
     *
     * 换成的 5 条是**同话题、不同措辞**（两两 sim 0.15–0.26），近同名闸放行、
     * 但彼此都过得了召回下限 —— 这才是这条护栏**真正的适用区间**：
     * 模型手里的 0.2–0.70 那一档，靠相似度传递连成大簇。
     * 换句话说：near-identical 归确定性闸，语义相近但措辞不同归模型 + 簇护栏。
     */
    const items = [
      '哈萨克斯坦与中国举行外长会谈讨论经贸与投资合作',
      '哈萨克斯坦与中国举行外长会谈讨论能源与投资项目',
      '哈萨克斯坦与中国举行外长会谈讨论交通与运输合作',
      '哈萨克斯坦与中国举行外长会谈讨论农业与粮食合作',
      '哈萨克斯坦与中国举行外长会谈讨论数字与技术合作',
    ].map((title) => ({ title }));
    // 前置条件：新构造必须**整批通过**近同名闸，否则这条用例又会被短路
    ok(
      '前提：这 5 条不会被近同名闸吃掉（否则这条用例测不到簇护栏）',
      dedupeNearTitles(items).kept.length === 5,
      `实际保留 ${dedupeNearTitles(items).kept.length} 条`,
    );
    const { seen, ask } = fakeAsk((p) => {
      // 把提示词里出现的每个编号都判成「是」
      const idx = [...p.matchAll(/^(\d+) \|/gm)].map((m) => Number(m[1]));
      return JSON.stringify({ same: idx });
    });
    const res = await dedupeStories(items, { useLlm: true, judge: { ask } });

    ok('确实问了模型，且是逐对格式', seen.length === 1 && seen[0].includes('# | 标题A || 标题B'), seen[0].slice(0, 60));
    ok('全答是 → 一条都没删（簇超限整簇丢弃）', res.drops.length === 0, JSON.stringify(res.drops.map((d) => d.reason)));
    ok('保留了全部 5 条', res.kept.length === 5, String(res.kept.length));
    ok('error 说明是簇超限', Boolean(res.llm.error && res.llm.error.includes('簇')), String(res.llm.error));
  }

  // --- ③ 模型返回不是合法 JSON：不合并，并留下 error（不能静默）---
  {
    /**
     * ⚠️ 2026-10-05 换过构造 —— 旧构造（「新羊毛加工厂投产仪式」↔「…开工仪式」，
     * `sim=0.7143`）**已经到不了这一段**：阈值降到 0.70 之后它会先被近同名闸确定性合并，
     * 于是「模型返回不合法」这个场景根本走不到（`drops.length` 会变成 1、`llm.error` 为 undefined）。
     *
     * 换成的这一对 `sim=0.4000`：过了召回下限（会问模型），但**过不了**近同名闸。
     * ——凡是「要走到模型」的用例，都必须落在 0.35–0.70 这个区间；阈值一动就要重挑。
     */
    const items = [
      { title: '塔吉克斯坦总统主持新羊毛加工厂投产仪式' },
      { title: '塔吉克斯坦总统出席羊毛加工厂开工典礼' },
    ];
    ok(
      '前提：这一对过得了召回、过不了近同名闸（否则测不到模型的返回）',
      similarity(items[0].title, items[1].title) >= PAIR_PRIORITY_SIM &&
        !isNearSameTitleText(items[0].title, items[1].title),
      `sim=${similarity(items[0].title, items[1].title).toFixed(4)}，阈值 ${TITLE_NEAR_MIN_SIM}`,
    );
    const { ask } = fakeAsk(() => '这两条看起来是同一件事。');
    const res = await dedupeStories(items, { useLlm: true, judge: { ask } });
    ok('返回不合法 → 不合并', res.drops.length === 0, String(res.drops.length));
    ok('并且留下了 error', Boolean(res.llm.error), String(res.llm.error));
  }

  // --- ④ 模型调用失败：不合并，error 带上通道报错 ---
  {
    const items = [
      { title: '吉尔吉斯斯坦总统赴美参加联合国大会' },
      { title: '吉尔吉斯斯坦总统将赴纽约参加联合国大会' },
    ];
    const res = await dedupeStories(items, {
      useLlm: true,
      judge: { ask: async () => ({ ok: false as const, error: 'zhipu：HTTP 429 code 1305' }) },
    });
    ok('调用失败 → 不合并', res.drops.length === 0);
    ok('error 带上了通道报错', Boolean(res.llm.error?.includes('1305')), String(res.llm.error));
  }

  // --- ⑤ 没有候选对时不该调模型（省一次 token）---
  {
    const items = [{ title: '哈萨克斯坦聚乙烯工厂投产' }, { title: '塔吉克斯坦桑搏世锦赛开幕' }];
    let called = 0;
    const res = await dedupeStories(items, {
      useLlm: true,
      judge: {
        ask: async () => {
          called++;
          return { ok: true as const, text: '{"same": []}' };
        },
      },
    });
    ok('无候选对 → 不调模型', called === 0, String(called));
    ok('无候选对 → 不删任何条目', res.drops.length === 0);
    ok('无候选对时 ran=true 但 ok=false（表示没实际判定）', res.llm.ran && !res.llm.ok, JSON.stringify(res.llm).slice(0, 120));
  }

  // --- ⑥ 被模型判「否」的对要出现在 declined 里（否则漏合并看不见）---
  {
    const items = [
      { title: '阿塞拜疆航空与国立音乐学院联合举办音乐比赛 庆祝国家音乐日' },
      { title: '阿塞拜疆航空与阿塞拜疆国立音乐学院举办国家音乐日竞赛' },
    ];
    const { ask } = fakeAsk(() => '{"same": []}');
    const res = await dedupeStories(items, { useLlm: true, judge: { ask } });
    ok('判否 → 不删任何条目', res.drops.length === 0);
    ok('判否 → 进入 declined 供人复核', res.llm.declined?.length === 1, JSON.stringify(res.llm.declined));
    ok('判否时 groups 为空', res.llm.groups.length === 0, JSON.stringify(res.llm.groups));
  }

  // --- ⑦ ★ 下标基准：模型看到的是「确定性去重**之后**」的数组（2026-10-05）---
  //
  // 这一节钉的是一个**不报错**的缺陷，也是 `GET /api/dedupe-check` 那次的根因：
  // `dedupeStories` 先跑确定性去重（L0/L1/L1.5 + 闸 3.5）删掉若干条，
  // **才**把剩下的 `keptAfterIdentity` 交给模型。所以 `llm.pairs` / `llm.groups`
  // 里的下标指的是「删完之后的数组」，而体检接口原先拿**调用方自己的入参**去解释它们。
  //
  // 后果（2026-10-05 线上实测）：报出来的每一对标题都**整体前移、指向不相干的两条**；
  // `sim` 因此普遍算成 0，看着像「候选对里混进了毫不相似的对」；还会得出
  // 「模型把消防火灾和医疗赔偿判成同一件事」这种**假结论** —— 真相是仪器错了。
  // 同类前科：AGENTS O-3-1「探针自己的期望值不可达」。
  //
  // ⚠️ 断言的重点是「**两套下标确实不同**」，不是「映射结果好看」：
  // 谁要是把它改回用入参映射，下面的承重断言就会挂。
  // 前面 ①–⑥ 全都**没有确定性丢弃**，两套下标恰好重合 —— 所以它们都测不到这个缺陷。
  {
    // 第 2 条与第 1 条 **同 source_url** ⇒ 必被 L0 确定性闸删掉，
    // 后面的条目整体前移一位 —— 这样两套基准才真正错开。
    const items = [
      { title: '哈萨克斯坦政府批准2027年国家预算草案', source_url: 'https://a.kz/budget' },
      { title: '哈萨克斯坦政府批准2027年国家预算草案（重复稿）', source_url: 'https://a.kz/budget' },
      { title: '塔吉克斯坦总统会见世界银行代表团', source_url: 'https://b.tj/wb' },
      { title: '乌兹别克斯坦与韩国签署纺织业合作协议', source_url: 'https://c.uz/textile' },
    ];
    const { ask } = fakeAsk(() => '{"same": []}');
    const res = await dedupeStories(items, { useLlm: true, judge: { ask } });

    ok(
      '⑦ 先确认确定性闸确实删了 1 条（否则这一节测不到错位）',
      res.drops.length === 1 && res.drops[0].reason === 'same_url',
      JSON.stringify(res.drops.map((d) => `${d.reason}:${d.dropped.title}`)),
    );
    ok('⑦ 模型确实跑了（ran=true）', res.llm.ran, JSON.stringify(res.llm).slice(0, 120));

    const idx = res.llm.indexTitles;
    ok('⑦ 报出了下标基准 indexTitles', Array.isArray(idx), JSON.stringify(idx));
    ok(
      '⑦ 下标基准 = 确定性去重**之后**的条数（4 → 3）',
      idx?.length === 3,
      `indexTitles.length=${idx?.length} / 入参 ${items.length} 条`,
    );
    ok(
      '⑦ 下标基准是入参标题的**子序列**（顺序不变、只少了被删的那条）',
      JSON.stringify(idx) === JSON.stringify([items[0].title, items[2].title, items[3].title]),
      JSON.stringify(idx),
    );
    // ★ 承重断言：同一个下标在两套基准下指向**不同**的标题。
    //   这一条一旦变 false，说明映射又退回用入参了 —— 缺陷复发。
    ok(
      '★ ⑦ 下标 1 在两套基准下**不是同一条**（用入参映射就会报错标题）',
      idx?.[1] !== items[1].title,
      `indexTitles[1]=${idx?.[1]} / items[1]=${items[1].title}`,
    );
    ok('⑦ 且 indexTitles[1] 正是入参里的第 3 条', idx?.[1] === items[2].title, String(idx?.[1]));
  }
}

// ============================================================
// 五、可选：真实数据体检
// ============================================================

const dataPath = process.argv[2];
if (dataPath) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as
    | { articles: Array<Record<string, unknown>> }
    | Array<Record<string, unknown>>;
  const rows = Array.isArray(raw) ? raw : raw.articles;
  const stories: StoryLike[] = rows.map((r) => ({
    title: String(r.title ?? ''),
    content: String(r.content ?? ''),
    summary: String(r.summary ?? ''),
    country_code: String(r.country ?? r.country_code ?? ''),
    source_url: String(r.sourceUrl ?? r.source_url ?? ''),
    original_title: String(r.originalTitle ?? r.original_title ?? ''),
  }));

  section(`真实数据体检（${dataPath}，共 ${stories.length} 篇）`);

  // 按国家分组，与线上入库/选稿的实际调用方式一致
  const byCountry = new Map<string, StoryLike[]>();
  for (const s of stories) {
    const k = s.country_code || 'intl';
    const list = byCountry.get(k);
    if (list) list.push(s);
    else byCountry.set(k, [s]);
  }

  let totalDropped = 0;
  const byReason: Record<string, number> = {};
  for (const [cc, list] of byCountry) {
    const { kept, drops } = dedupeStoriesDeterministic(list);
    totalDropped += drops.length;
    for (const d of drops) byReason[d.reason] = (byReason[d.reason] || 0) + 1;
    if (drops.length > 0) {
      console.log(`  [${cc}] ${list.length} → ${kept.length}（剔除 ${drops.length}）`);
      for (const d of drops.slice(0, 6)) {
        console.log(`      ${d.reason}｜丢「${d.dropped.title.slice(0, 42)}」← 留「${d.kept.title.slice(0, 42)}」`);
      }
    }
  }
  console.log(`  合计剔除 ${totalDropped} 篇，按原因：${JSON.stringify(byReason)}`);

  // 关键断言：去重后不应再存在「归一化链接相同」的两条
  const dupLeft: string[] = [];
  for (const [, list] of byCountry) {
    const { kept } = dedupeStoriesDeterministic(list);
    const seen = new Set<string>();
    for (const s of kept) {
      const cu = canonicalUrl(s.source_url || '');
      if (!cu) continue;
      if (seen.has(cu)) dupLeft.push(`${s.country_code} ${cu}`);
      seen.add(cu);
    }
  }
  ok('去重后国内不再有重复链接', dupLeft.length === 0, dupLeft.slice(0, 3).join(' / '));

  // 桥梁那一对必须被合并
  const bridgeRows = stories.filter((s) => (s.title || '').includes('车道') && (s.title || '').includes('桥'));
  if (bridgeRows.length >= 2) {
    const { kept } = dedupeStoriesDeterministic(bridgeRows);
    ok(`桥梁对（${bridgeRows.length} 条）合并为 1 条`, kept.length === 1, `实际 ${kept.length}`);
  }
}

// ----- 判组提示词版本与固定语料 -----
//
// 这一节不联网、不调模型，钉的是**让 A/B 这件事本身成立**的前提：
//   · 指定配对入口真的「不过召回」，且下标映射没错位（错位 = 静默删错新闻）；
//   · 版本注册表里对照组与当前版本**确实不同**（相同的话 pv 参数就是假的）；
//   · 固定语料是双向的（既有该合并的、也有该保留的），且标注都带理由。
//
// 这三条一旦破掉，`scripts/ab-judge-prompt.ts` 跑出来的对照表会**看起来正常**
// 但结论无效 —— 那正是最难发现的一类失效，所以必须用断言钉住而不是靠人记得。
async function promptVersionChecks(): Promise<void> {
  section('判组提示词：指定配对入口（不过召回 + 下标映射）');
  {
    // 两条毫不相干的标题。先用 candidatePairs 钉住**前提**：
    // 它们不会被召回 —— 否则下一句就证明不了「指定配对不走召回」。
    const items = [
      { title: '哈萨克斯坦总统签署赦免法令' },
      { title: '塔吉克斯坦举行马拉松比赛' },
    ];
    const recalled = candidatePairs(items);
    ok('前提：这对陌生标题不会被 candidatePairs 召回', recalled.length === 0, `实际召回 ${recalled.length} 对`);

    const { seen, ask } = fakeAsk(() => '{"same": [0]}');
    const res = await judgeExplicitPairs([{ a: 0, b: 1 }], items, { ask });
    ok('指定配对即使低于召回下限也照样问模型', seen.length === 1 && res.pairs.length === 1, `seen=${seen.length} pairs=${res.pairs.length}`);
    ok('指定配对的标题原样进了提示词', Boolean(seen[0]?.includes('塔吉克斯坦举行马拉松比赛')));
    ok('candidateCount = 给定的对数（不是召回出来的对数）', res.candidateCount === 1, String(res.candidateCount));
  }

  section('判组提示词：极性否决不进提示词 + 下标映射');
  {
    // 前一对方向相反（会被确定性拦下），后一对正常。
    // 关键在**下标**：模型答的是 `asked` 里的第 0 个，映射回原数组必须是 (2,3)。
    // 这一条接错，被否决的对会让后面每对下标错位一格，静默删错新闻。
    const items = [
      { title: '全球市场黄金和白银价格下跌' },
      { title: '全球市场黄金和白银价格上涨' },
      { title: '阿塞拜疆总统签署赦免令开始执行' },
      { title: '阿塞拜疆总统签署大赦令开始执行' },
    ];
    const { seen, ask } = fakeAsk(() => '{"same": [0]}');
    const res = await judgeExplicitPairs([{ a: 0, b: 1 }, { a: 2, b: 3 }], items, { ask });

    ok('反向极性的对被确定性拦下', res.vetoed.length === 1 && res.vetoed[0]?.a === 0, JSON.stringify(res.vetoed));
    ok('被拦下的对不出现在提示词里', seen.length === 1 && !seen[0].includes('黄金'), '提示词里出现了被拦下的对');
    ok('提示词里只剩 1 行配对', seen[0].split('\n').filter((l) => /^\d+ \| /.test(l)).length === 1);
    ok('下标映射回原数组（不被否决的对错位）', res.pairs[0]?.a === 2 && res.pairs[0]?.b === 3, JSON.stringify(res.pairs));
    ok('三条列表都带 sim', res.pairs.every((p) => typeof p.sim === 'number') && res.vetoed.every((p) => typeof p.sim === 'number'));
    ok(
      'sim 与 similarity() 同口径',
      Math.abs((res.pairs[0]?.sim ?? -1) - similarity(items[2].title, items[3].title)) < 1e-9,
      String(res.pairs[0]?.sim),
    );
  }

  section('判组提示词：版本注册表');
  {
    const versions = availablePromptVersions();
    ok('注册表里至少 2 个版本（否则 pv 参数是假的）', versions.length >= 2, versions.join(','));
    ok('包含冻结的 v1 对照组', versions.includes(1), versions.join(','));
    ok('包含默认版本', versions.includes(JUDGE_PROMPT_VERSION), String(JUDGE_PROMPT_VERSION));
    ok('v3 仍在注册表里（前一版要能随时对照，否则 A/B 只剩 v1 一个基线）', versions.includes(3), versions.join(','));
    ok('v4 仍**注册**着（A/B 未采用 ≠ 删掉：保留才能继续用 pv=4 做实验）', versions.includes(4), versions.join(','));

    /**
     * ⚠️ 这两条**故意**推翻了原来的「默认 = 最大版本号」不变量。
     *
     * 2026-10-05：v4 做了 A/B（两条通道各 3 轮），结论是**不采用** ——
     * 生产通道平手、`zhipu-flash` 降级档从 14/15 崩到 9/15。
     * 于是注册表里出现了「有更大的版本号，但默认不是它」这种状态。
     * 「默认版本」从此是一个**经 A/B 定过版**的决定，不是 `Math.max` 的结论 ——
     * 所以只能钉成字面量：**改默认版本时这条断言会挂，逼你去写清楚为什么**。
     */
    ok(
      '★ 默认版本 = 3（v4 未获采用：生产通道平手、降级通道崩 —— 见 buildV4 注释与 AGENTS Q-7-4）',
      JUDGE_PROMPT_VERSION === 3,
      `现值 ${JUDGE_PROMPT_VERSION}：改默认版本前先跑 judge:ab（**两条通道都要**），再改这条`,
    );
    ok(
      '默认版本**不是**最大版本号（这条不再成立是对的：注册 ≠ 采用）',
      JUDGE_PROMPT_VERSION !== Math.max(...versions),
      `默认 ${JUDGE_PROMPT_VERSION}；可用 ${versions.join(',')}`,
    );

    const items = [{ title: '甲' }, { title: '乙' }];
    const pairs = [{ a: 0, b: 1 }];
    ok('不传版本 = 当前版本', buildPairPrompt(pairs, items) === buildPairPrompt(pairs, items, JUDGE_PROMPT_VERSION));
    ok(
      '对照组与当前版本的提示词**确实不同**（相同的话 A/B 是假的）',
      promptBuilderFor(1)(pairs, items) !== promptBuilderFor(JUDGE_PROMPT_VERSION)(pairs, items),
    );

    let threw = false;
    try {
      promptBuilderFor(99);
    } catch {
      threw = true;
    }
    ok('未知版本抛错，不静默回退到最新版', threw);
    ok('TITLE_MAX 仍是 80（模块搬家的护栏）', TITLE_MAX === 80, String(TITLE_MAX));
  }

  section('判组提示词的校准要点（默认版 + 已注册但未采用的 v4）');
  {
    const mk = (v?: number) =>
      promptBuilderFor(v ?? JUDGE_PROMPT_VERSION)([{ a: 0, b: 1 }], [{ title: 'X' }, { title: 'Y' }]);
    const pDefault = mk();
    const p3 = mk(3);
    const p4 = mk(4);
    const p1 = mk(1);

    ok('默认版就是 v3 的提示词（默认值与注册表不许分叉）', pDefault === p3);

    /**
     * ---- v1/v3 的要点：**默认版与 v4 都必须保留** ----
     *
     * 原先只对「当前版本」断言一次。2026-10-05 默认回退到 3 之后出现了两个版本同时在库里的
     * 状态，于是把这份清单**对两版各验一遍** —— 「加新版本是叠加、不是重写」这句话
     * 从此是**被验的**，而不是靠人记得。反面情况正是这次 v4 的翻车形态：
     * 它保住了旧要点、却在「专名限定语丢失」那一类上把 v3 判对的弄反了。
     */
    const common: Array<[string, (s: string) => boolean]> = [
      ['保留末句兜底「拿不准就判否」（误合并不可逆，这条不能删）', (s) => s.includes('拿不准就判「否」')],
      ['有「相反事实」的第一步检查（v2 只加例子不管用）', (s) => s.includes('相反事实')],
      ['点明「否认」是核心事实而非修饰语', (s) => s.includes('它就是那条新闻的核心事实')],
      ['否认反例的那对真实标题在', (s) => s.includes('否认准备对柴油出口实施 90 天禁令')],
      ['「不同主体」给了可操作判据', (s) => s.includes('不同的具体对象') && s.includes('不同公司名')],
      ['明说「同义指代不算不同主体」（v2 回退的根因）', (s) => s.includes('同义指代')],
      ['正例形态三在（近义指代 + 数字表述）', (s) => s.includes('常见形态三') && s.includes('近 50 个 / 约 50 个')],
      ['Unibank 那条正例仍在（用户报的重复）', (s) => s.includes('Unibank 推出绿色贷款')],
    ];
    for (const [label, s] of [['默认版 v3', pDefault], ['v4', p4]] as const) {
      for (const [name, test] of common) ok(`[${label}] ${name}`, test(s));
    }

    // ---- v4 新增：数字分界线（两侧都要在，只写一侧等于没写）----
    // ⚠️ 这些断言只说明「v4 的正文写进去了」，**不代表**它该被采用 ——
    //    采用与否由 A/B 决定（默认仍是 v3，见上面注册表那一节）。
    ok('v4：有「同一个指标 / 不同指标」这一步检查', p4.includes('数字是同一个人说的吗'));
    ok(
      'v4：正例侧 ——「同一个指标的数字略有出入 ⇒ 判是」在（常见形态四）',
      p4.includes('常见形态四') && p4.includes('同一个指标的数字略有出入'),
    );
    ok(
      'v4：反例侧 ——「同一份统计公报的不同指标 ⇒ 判否」在，且带真实标题',
      p4.includes('同一份统计公报') && p4.includes('新住宅区占比 98%') && p4.includes('非油气资本投资占比 75%'),
    );
    ok(
      'v4：明说反例**优先于**正例（否则模型会按形态四把不同指标也合掉）',
      p4.includes('这一条**优先于**常见形态四'),
    );
    ok(
      'v4：同一指标不同舍入的那个真实标题在（75/76 亿美元，端到端用例 ① 的 fixture）',
      p4.includes('75 亿美元') && p4.includes('76 亿美元'),
    );
    ok('v3 里**没有** v4 新增的数字检查（前一版要真是前一版）', !p3.includes('数字是同一个人说的吗'));

    ok('v1 对照组没有正例细化（它就该是校准前那版）', !p1.includes('常见形态'));
    ok('v1 保留自己的兜底句', p1.includes('拿不准就判「否」'));
  }

  section('判组提示词：固定语料（gold set）');
  {
    type GoldPair = { a?: string; b?: string; expect?: string; note?: string };
    const goldPath = resolve(process.cwd(), 'scripts/fixtures/judge-gold.json');
    // 读失败时给空数组而不是让整节挂掉：这一节要报的是「语料合不合格」，
    // 读取异常本身就是最该被报出来的那一条。
    let pairs: GoldPair[] = [];
    try {
      const gold = JSON.parse(readFileSync(goldPath, 'utf8')) as { pairs?: GoldPair[] };
      pairs = gold.pairs ?? [];
    } catch (err) {
      ok('固定语料可读', false, `${goldPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    ok('固定语料可读且有内容', pairs.length >= 10, `${pairs.length} 对`);

    const same = pairs.filter((x) => x.expect === 'same');
    const diff = pairs.filter((x) => x.expect === 'diff');
    // 这条是项目已经记载过的教训：只测一边一定会把判据调歪。
    ok('双向语料：既要「必须合并」也要「必须保留」', same.length >= 3 && diff.length >= 3, `same=${same.length} diff=${diff.length}`);
    ok('每对都有 a / b 且非空', pairs.every((x) => (x.a ?? '').trim() && (x.b ?? '').trim()));
    ok('expect 只有 same / diff', pairs.every((x) => x.expect === 'same' || x.expect === 'diff'));
    // 没有理由的标注不能当金标：将来有人觉得「这对我看是判否」时，
    // 必须能看到当初为什么标成「是」。
    ok('每对都写了标注理由', pairs.every((x) => (x.note ?? '').trim().length > 0));
    // 标题超过 TITLE_MAX 会被提示词截断 —— 那 A/B 测的就是标题前缀而不是整条标题，
    // 而语料是要长期复用的，不该默默丢掉尾巴。
    const tooLong = pairs.filter((x) => (x.a ?? '').length > TITLE_MAX || (x.b ?? '').length > TITLE_MAX);
    ok(`标题都不超过 TITLE_MAX(${TITLE_MAX})，不会被提示词截断`, tooLong.length === 0, tooLong.map((x) => x.a).join(' / '));
    // 语料必须含用户报的这两类，否则「固定语料」与真实缺陷脱节
    ok('语料含用户报的 Unibank 重复（该合并）', pairs.some((x) => (x.a ?? '').includes('Unibank') && x.expect === 'same'));
    ok('语料含「否认某报道 vs 该报道本身」（该保留）', pairs.some((x) => (x.a ?? '').includes('否认准备对柴油出口') && x.expect === 'diff'));
    ok('语料含 v2 的回退点（中国 50 个联合项目）', pairs.some((x) => (x.a ?? '').includes('主要企业') && x.expect === 'same'));
    // ---- v4（2026-10-05）新增的两侧 ----
    ok(
      '★ 语料含 v4 的反例侧：同一份统计公报的不同指标（该保留）',
      pairs.some((x) => (x.a ?? '').includes('新住宅区占比 98%') && x.expect === 'diff'),
    );
    ok(
      '★ 语料含 v4 的正例侧：同一指标不同舍入（该合并，且是「不能用算术护栏否决模型」的证据）',
      pairs.some((x) => (x.a ?? '').includes('75亿美元') && x.expect === 'same'),
    );
    // ---- 2026-10-06：把「过量合并」这一类补成逐字的线上语料 ----
    //
    // 上面那两条（[12] 新住宅区占比 / [19] 建筑面积占比）原来只有一条，而且 `sim` 只有 0.38；
    // 线上 3 天窗口里同一形态一共 8 对被判成「是」。这 8 对是**逐字**从
    // `GET /api/dedupe-check?days=3&llm=1&debug=1` 的 `llmJudge[].pairs` 取回的，
    // 它们让 v3 的真实成绩从「14/15」掉到「17/23」—— 也就是**旧的松语料在给 v3 放水**。
    // 断言只钉两条最典型的形态，不逐对钉（逐对钉会在合理改标注时变成噪声）。
    ok(
      '★ 语料含「同一机构多项不同议程」（该保留）—— 线上真实误合并，sim 仅 0.303',
      pairs.some((x) => (x.a ?? '').includes('反毒中心协定') && x.expect === 'diff'),
    );
    ok(
      '★ 语料含「同模板不同客体：议会批准 X vs 批准 Y」（该保留）',
      pairs.some((x) => (x.a ?? '').includes('引渡罪犯条约') && x.expect === 'diff'),
    );
    ok(
      '★ 语料含用户报的最差一例：「总理出席教师节庆典」↔「因制裁叫停 16 家公司」（sim 仅 0.207）',
      pairs.some((x) => (x.a ?? '').includes('教师节庆典活动') && x.expect === 'diff'),
    );
    // ---- 语料的使用说明必须跟着语料走 ----
    //
    // 这一节钉的是「文件里那些**结论性**的字段还在不在」。2026-10-06 实测踩到的三件事
    // （批次组成改变判定 / 顺序影响大于版本差异 / 本文件顺序不是生产顺序）都是**会让人
    // 拿错基线**的坑，所以它们必须在文件里、且必须能被断言守住 —— 光写在提交信息里没用。
    {
      type GoldFileShape = {
        _provenance?: Record<string, unknown>;
        [k: string]: unknown;
      };
      let gold = {} as GoldFileShape;
      try {
        gold = JSON.parse(readFileSync(goldPath, 'utf8')) as GoldFileShape;
      } catch {
        /* 上面已经报过「固定语料可读」了，这里不再重复报同一条 */
      }
      const rulesKey = Object.keys(gold).find((k) => k.includes('硬规矩'));
      const rules = rulesKey ? (gold[rulesKey] as string[]) : [];
      ok(
        '语料里写着「批次组成会改变判定 / 顺序影响 > 版本差异 / 本文件顺序≠生产顺序」三条硬规矩',
        rules.length >= 3,
        rulesKey ?? '没有这个键',
      );
      const prov = gold._provenance ?? {};
      const os06 = prov.orderSensitivity_2026_10_06 as Record<string, unknown> | undefined;
      ok(
        '语料记着 2026-10-06 的顺序重测（两条通道都有）',
        !!os06 && 'zhipu(生产所用)' in os06 && 'zhipu-flash(降级档)' in os06,
      );
      // 旧的 3/12 是**低估**。不标出来的话，下一个人会拿它当噪声地板，
      // 于是又一次「用一个过小的噪声去判版本差异显著」。
      const oldOs = prov.orderSensitivity as Record<string, unknown> | undefined;
      ok(
        '旧的 orderSensitivity 已标注「被 2026-10-06 重测改写」，不会被当成当前噪声地板',
        !!oldOs && Object.keys(oldOs).some((k) => k.includes('已被2026_10_06重测改写')),
      );
      // 语料采集时的逐对观测列**只在那一版语料内可比** —— 这条必须写在 `_provenance` 里，
      // 因为 `observedV1V2` 那几个键看起来就像可以直接对照的基线。
      ok(
        '语料记着「observedV* 列不可跨语料版本对照」',
        Object.keys(prov).some((k) => k.includes('observedV1V2不可直接对照')),
      );
    }
  }
}

// ----- 召回层旋钮（`cand` / `minside` / `prisim`）-----
//
// 为什么这一节必须存在：这三个旋钮是 2026-10-07 接上的**唯一**能在生产形态批次上
// 验证修法的入口。而「接了但没接通」正是本项目反复栽的那一类 ——
// `dedupeStories` 只把**嵌套的 `judge`** 透传给 `judgeSameEventPairs`
// （`const res = await judgeSameEventPairs(keptAfterIdentity, judge)`），
// 旋钮若写在顶层会被**静默忽略**：不报错、不告警、结果看起来完全正常，
// 只是「实验组和对照组一模一样」。所以下面既测解析器，也**测它真的抵达召回层**。
async function recallKnobChecks(): Promise<void> {
  // --- ① 解析器：取值域与拒绝 ---
  {
    const none = parsePairRecallKnobs(new URLSearchParams());
    ok(
      '旋钮全缺省 ⇒ 一项都不覆盖（生产链路不传旋钮约定的可执行版本）',
      none.ok && none.applied.length === 0 && Object.keys(none.values).length === 0,
      JSON.stringify(none),
    );

    // 三个旋钮的名字、字段、整数性必须成对正确 —— 名字对上但字段接错是静默的
    const byField = new Map(PAIR_RECALL_KNOB_SPECS.map((s) => [s.param, s.field]));
    ok(
      '旋钮名与字段的对应关系正确（cand→maxPairs / minside→minSim / prisim→prioritySim）',
      byField.get('cand') === 'maxPairs' &&
        byField.get('minside') === 'minSim' &&
        byField.get('prisim') === 'prioritySim',
      JSON.stringify([...byField]),
    );
    ok(
      '只有 cand 要求整数（三个 sim 类旋钮是实数，误设成整数校验会让 0.35 被拒）',
      PAIR_RECALL_KNOB_SPECS.filter((s) => s.integer).map((s) => s.param).join(',') === 'cand',
    );

    // 每个旋钮的两个边界都要**被接受且值相等**
    for (const spec of PAIR_RECALL_KNOB_SPECS) {
      for (const edge of [spec.lo, spec.hi]) {
        const r = parsePairRecallKnobs(new URLSearchParams(`${spec.param}=${edge}`));
        ok(
          `旋钮 ${spec.param} 的边界 ${edge} 被接受且值相等`,
          r.ok && r.values[spec.field] === edge,
          JSON.stringify(r),
        );
      }
      // 两侧越界都要被拒（只测一侧会漏掉单边符号错误）
      for (const out of [spec.lo - 1, spec.hi + 1]) {
        const r = parsePairRecallKnobs(new URLSearchParams(`${spec.param}=${out}`));
        ok(
          `旋钮 ${spec.param} 的越界值 ${out} 被拒且错误里点名了参数`,
          !r.ok && r.error.includes(spec.param),
          JSON.stringify(r),
        );
      }
      const nan = parsePairRecallKnobs(new URLSearchParams(`${spec.param}=abc`));
      ok(`旋钮 ${spec.param} 的非数字值被拒`, !nan.ok, JSON.stringify(nan));
    }

    // 整数旋钮收到小数必须拒 —— `Number('48.5')` 是合法数字，最容易漏这一条
    const frac = parsePairRecallKnobs(new URLSearchParams('cand=48.5'));
    ok('整数旋钮 cand=48.5 被拒（Number 会收下它，只判 isFinite 会漏）', !frac.ok, JSON.stringify(frac));

    // 空串按「没传」处理，不能按 0 处理（`Number('')` 是 0，会把 minside 静默压到 0）
    const blank = parsePairRecallKnobs(new URLSearchParams('minside='));
    ok(
      '空串按「没传」处理而不是 0（Number(\'\') === 0 是个静默陷阱）',
      blank.ok && blank.applied.length === 0 && blank.values.minSim === undefined,
      JSON.stringify(blank),
    );

    // 对照实验真要用的那一档必须能传进去
    const real = parsePairRecallKnobs(new URLSearchParams('minside=0.35&cand=24'));
    ok(
      '对照实验的真实取值可传（minside=0.35&cand=24 ⇒ 两项都覆盖）',
      real.ok && real.values.minSim === 0.35 && real.values.maxPairs === 24 && real.applied.length === 2,
      JSON.stringify(real),
    );
  }

  // --- ①b 通道旋钮 `provider=` ---
  //
  // 判据是「钉住了批大小却放开型号，等于只钉了一半」：降级链按 `PROVIDERS` 顺序取
  // 第一个不报错的通道，而「谁不报错」取决于这一刻谁被 429 限流 ⇒ 不钉通道的 A/B
  // 里，「结论不同」多出一种解释。**不认识的通道名必须当场拒**，不许静默回退
  // （回退会让 `provider=zhipu-flsh` 这类手误跑出一个「看起来正常」的降级链结果）。
  {
    const usable = ['zhipu', 'zhipu-flash', 'deepseek'];

    const pinned = parseProviderOnly(new URLSearchParams('provider=zhipu'), usable);
    ok(
      '通道旋钮：在册通道被接受且原样传下去',
      pinned.ok && pinned.only === 'zhipu',
      JSON.stringify(pinned),
    );
    const unknown = parseProviderOnly(new URLSearchParams('provider=zhipu-flsh'), usable);
    ok(
      '★ 通道旋钮：不在册通道被拒且错误里点名了参数（拼错的通道名必须响，不许静默回退）',
      !unknown.ok && unknown.error.includes('provider=zhipu-flsh'),
      JSON.stringify(unknown),
    );
    // 大小写不放过：`Zhipu` 不是 `zhipu`，静默归一化会掩盖拼写错误
    const cased = parseProviderOnly(new URLSearchParams('provider=Zhipu'), usable);
    ok('通道旋钮：大小写不做静默归一化（Zhipu ≠ zhipu）', !cased.ok, JSON.stringify(cased));
    const blankProvider = parseProviderOnly(new URLSearchParams('provider='), usable);
    ok(
      '通道旋钮：空串按「没传」处理（走完整降级链），而不是当成一个空通道名',
      blankProvider.ok && blankProvider.only === undefined,
      JSON.stringify(blankProvider),
    );
    const absentProvider = parseProviderOnly(new URLSearchParams(), usable);
    ok(
      '通道旋钮：缺省 ⇒ 不钉通道（生产口径 = 保留降级）',
      absentProvider.ok && absentProvider.only === undefined,
      JSON.stringify(absentProvider),
    );
  }

  // --- ② 活体探针（推送端 `codeVersion.dedupeKnobProbe` 就是它）---
  {
    const probe = pairRecallKnobProbe();
    ok(
      '召回层旋钮活体探针全绿（出现 ✗ 说明边界判据被改坏）',
      !probe.includes('✗'),
      probe,
    );
    ok(
      '探针逐段点名了三个旋钮（探针被清空/只剩一部分会在这里响）',
      PAIR_RECALL_KNOB_SPECS.every((s) => probe.includes(`${s.param}[`)),
      probe,
    );
    ok('探针末段证「全缺省不覆盖任何一项」', probe.includes('全缺省→applied=0'), probe);
    ok(
      '探针含通道旋钮那一整段（三段全绿）',
      probe.includes('provider[在册/不在册/缺省]=✓✓✓'),
      probe,
    );
  }

  // --- ③ ★ 接线：旋钮必须真的抵达召回层 ---
  //
  // 这一条是本节的重点。用一个**只回「没有同一件事」**的假模型出口，
  // 就能在离线、不配 Key 的情况下看到「召回层选了哪几对」——
  // 于是「旋钮有没有接通」变成一个可断言的事实，而不是靠读代码相信。
  //
  // 用 `minSim` 做判据而不是数对：`minSim=0.99` 时**一对都不该有**，
  // 这个断言不依赖下面这几条标题的实际相似度（改标题也不会让它假绿）。
  {
    const items = [
      { title: '阿塞拜疆总统出席巴库国际航运论坛开幕式' },
      { title: '阿塞拜疆总统出席巴库国际航运论坛并发表讲话' },
      { title: '阿塞拜疆总统出席巴库国际航运论坛，签署三项协议' },
      { title: '哈萨克斯坦与中方举行经贸合作委员会会议' },
    ];
    const noDup = fakeAsk(() => '{"same":[]}');

    const base = await dedupeStories(items, { useLlm: true, judge: { ask: noDup.ask } });
    const capped = await dedupeStories(items, {
      useLlm: true,
      judge: { ask: noDup.ask, maxPairs: 1 },
    });
    const floored = await dedupeStories(items, {
      useLlm: true,
      judge: { ask: noDup.ask, minSim: 0.99 },
    });

    ok(
      '旋钮接通（默认口径下确有候选对，否则下面两条断言无意义）',
      (base.llm.candidateCount ?? 0) >= 2,
      `candidateCount=${base.llm.candidateCount}`,
    );
    ok(
      '★ judge.maxPairs 真的抵达召回层（上限 1 ⇒ 候选对恰为 1）',
      capped.llm.candidateCount === 1,
      `candidateCount=${capped.llm.candidateCount}`,
    );
    ok(
      '★ judge.minSim 真的抵达召回层（下限 0.99 ⇒ 一对都没有）',
      floored.llm.candidateCount === 0,
      `candidateCount=${floored.llm.candidateCount}`,
    );
    ok(
      '★ 顶层传旋钮**不会**生效（`dedupeStories` 只透传嵌套的 `judge`）—— 钉住这个坑，防止有人「顺手挪到顶层」',
      (
        await dedupeStories(items, {
          useLlm: true,
          judge: { ask: noDup.ask },
          ...({ maxPairs: 1 } as Record<string, unknown>),
        } as never)
      ).llm.candidateCount === base.llm.candidateCount,
      `顶层 maxPairs=1 时 candidateCount=${base.llm.candidateCount}（应与默认相同）`,
    );
  }
}

// ----- 汇总 -----

function summarize() {
  console.log(`\n${'='.repeat(60)}`);
  if (failures.length === 0) {
    console.log(`✅ 全部通过：${passed} 项断言`);
    process.exit(0);
  } else {
    console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

// 异步检查（llmPipelineChecks + modeChecks + promptVersionChecks）必须跑完再汇总，
// 否则这些断言会在打印结果之后才执行、不计入总数。
// 顺序：先测装配（端到端），再测配置通路 —— 端到端挂了的话更该先看到。
llmPipelineChecks()
  .then(modeChecks)
  .then(promptVersionChecks)
  .then(recallKnobChecks)
  .then(summarize)
  .catch((err) => {
    console.error('检查过程中抛错：', err);
    process.exit(1);
  });
