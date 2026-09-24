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
  buildPairPrompt,
  candidatePairs,
  clusterPairs,
  dedupeStories,
  dedupeStoriesDeterministic,
  filterOversizedGroups,
  hasOppositePolarity,
  identityKeys,
  isSameTitle,
  isSameTitleText,
  JUDGE_PROMPT_VERSION,
  JUDGE_TEMPERATURE,
  PAIR_CANDIDATE_MIN_SIM,
  PAIR_MAX_CANDIDATES,
  parseEventGroups,
  parsePairVerdict,
  TITLE_IDENTICAL_MIN_SIM,
  type StoryLike,
} from '../src/lib/same-event';

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
    ok('判「是」的对映射回原下标 0,1', JSON.stringify(res.llm.pairs) === '[{"a":0,"b":1}]', JSON.stringify(res.llm.pairs));

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
    // 5 条几乎同题 → 两两都成候选 → 全答是会连成一个 5 条的簇
    const items = [
      '哈萨克斯坦总统会见中国外交部长讨论经贸合作',
      '哈萨克斯坦总统会见中国外交部长商讨经贸合作',
      '哈萨克斯坦总统会见中国外交部长洽谈经贸合作',
      '哈萨克斯坦总统会见中国外交部长商议经贸合作',
      '哈萨克斯坦总统会见中国外交部长研究经贸合作',
    ].map((title) => ({ title }));
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
    const items = [
      { title: '塔吉克斯坦总统主持新羊毛加工厂投产仪式' },
      { title: '塔吉克斯坦总统主持新羊毛加工厂开工仪式' },
    ];
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

// 异步检查（modeChecks + llmPipelineChecks）必须跑完再汇总，
// 否则这些断言会在打印结果之后才执行、不计入总数。
// 顺序：先测装配（端到端），再测配置通路 —— 端到端挂了的话更该先看到。
llmPipelineChecks()
  .then(modeChecks)
  .then(summarize)
  .catch((err) => {
    console.error('检查过程中抛错：', err);
    process.exit(1);
  });
