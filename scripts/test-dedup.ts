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
} from '../src/lib/utils';
import {
  dedupeStoriesDeterministic,
  identityKeys,
  parseEventGroups,
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

console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
