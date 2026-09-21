/**
 * 投资相关性评分 / 排序回归。
 *
 * 用法：
 *   1. 固定语料（默认，不联网、不碰数据库）：
 *      pnpm tsx scripts/test-investment-score.ts
 *   2. 真实数据体检（把线上 /api/articles 的返回存成 JSON 再喂进来）：
 *      pnpm tsx scripts/test-investment-score.ts /tmp/live.json
 *
 * ## 为什么必须有这个脚本
 *
 * 这套评分决定**每国新闻在草稿里的先后顺序**。它坏了不会报错，
 * 只会让顺序悄悄变成「随机」—— 这正是 2026-09-21 用户反馈
 * 「与投资越相关的新闻越放在靠前」时的情况：
 *
 *   `push` 阶段拿**英文**关键词表去匹配**中文**标题，永不命中。
 *   实测线上 1000 篇里只有 2.8% 能得分，且命中的是拉丁字母残留。
 *
 * 所以这里的语料也按「双向」组织（沿用本项目对删除/排序类规则的既有做法）：
 *   - **必须得高分的**：标题就是投资主题（投资/外资/签约/投产/矿产/管道…）
 *   - **必须得低分的**：与投资无关（文化活动、人事、天气、社会新闻…）
 * 只测一边一定会调歪 —— 要么把无关新闻顶上来，要么把投资新闻压下去。
 *
 * 另外专门钉一条**中文必须能得分**的断言：这是那次失效的直接回归点，
 * 而且它用「标题里不含任何拉丁字母」来证明分数只能来自中文词表 ——
 * 否则改了英文表也会「碰巧」通过。
 *
 * ## 顺带钉住的另两件事
 *
 * 1. **闸门词表 ≠ 排序词表**，两张表都要钉，而且**分区本身**也要钉。
 *    `fetch-news` 的闸门决定「稿子收不收」，只能放宽 —— 判严过就会直接复发
 *    「每国不足 15 篇」；排序词表为了区分度刻意丢了国家名/官职名这类
 *    零区分力的词。拿排序词表当闸门用 = 悄悄收紧入库条件，所以在最后一节
 *    把「闸门独有词」的完整名单钉成了快照：动任一张表都会出现 diff。
 * 2. 逐词跑闸门时抓出了一个**死词**：旧表里的 `' BRI'` 是大写、还带前导空格，
 *    而匹配前文本会被 `toLowerCase()` → `lowercased.includes(' BRI')` 恒为 false，
 *    这个词**从来没生效过**。已在 `investment-score.ts` 里于构建闸门时统一
 *    归一化修掉（方向是放宽，符合「只增不减」）。
 */
import { readFileSync } from 'fs';
import { EXCLUDED_CATEGORIES } from '../src/lib/article-format';
import {
  CATEGORY_PRIORITY,
  compareByInvestmentRelevance,
  explainInvestmentRelevance,
  gateKeywords,
  investmentRelevanceOf,
  isInvestmentTopic,
  scoreInvestmentRelevance,
  TITLE_WEIGHT,
  type RankableStory,
} from '../src/lib/investment-score';

// ----- 极简断言（与 scripts/test-dedup.ts 同款，便于一起读输出）-----

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

/** 标题里是否含拉丁字母（≥3 连）。用来证明「分数来自中文词表」而不是英文残留。 */
const hasLatin = (s: string) => /[A-Za-z]{3,}/.test(s);

// ============================================================
// 一、中文必须能得分（这次失效的直接回归点）
// ============================================================
//
// 语料取自线上真实标题。

section('中文标题必须能得分（纯英文词表会全部漏掉）');

const ZH_INVESTMENT_TITLES = [
  '乌兹别克斯坦卡拉卡尔帕克斯坦将家庭创业贷款利率从17.5%降至12%',
  '乌兹别克斯坦总统在卡拉卡尔帕克斯坦启动总额75亿美元项目',
  '塔吉克斯坦总统拉赫蒙在戈罗诺-巴达赫尚自治州主持新羊毛加工厂投产仪式',
  '吉尔吉斯斯坦交通部：比什凯克至库恩-图路段铺设第二层沥青',
  '乌兹别克斯坦卡拉卡尔帕克斯坦企业将获3000亿苏姆优惠贷款，利率降至12%',
  '塔什干车辆制造与维修厂私有化：受托管理方无优先权，90%国有股将公开出售',
  '吉尔吉斯斯坦财政部预测2027年特许权使用费收入将达92.4亿索姆',
  '哈萨克斯坦与中方签署铀矿开发协议，总投资12亿美元',
];

for (const t of ZH_INVESTMENT_TITLES) {
  const s = scoreInvestmentRelevance(t);
  ok(`中文能得分：${t.slice(0, 22)}…`, s > 0, `得分 ${s}`);
  ok(`  且分数只能来自中文词表（标题无拉丁字母）`, !hasLatin(t), t);
}

// 反向：把中文标题里唯一可能是英文的信号排除掉之后，仍必须有分。
// 换言之，如果哪天有人把中文词表删了只留英文表，这一段会全红。
const pureZh = ZH_INVESTMENT_TITLES.filter((t) => !hasLatin(t));
ok('存在足够多的纯中文语料（否则本段测试没有意义）', pureZh.length >= 6, String(pureZh.length));

// ============================================================
// 二、高投资 vs 低投资必须分得开（双向语料）
// ============================================================

section('高投资新闻必须排在无关新闻前面');

const ZH_HIGH = [
  { t: '哈萨克斯坦与中方签署铀矿开发协议，总投资12亿美元', s: '双方还就铁路通道建设交换意见。' },
  { t: '阿塞拜疆天然气管道扩建项目投产，年输气量提升至200亿立方米', s: '项目由外资联合体承建。' },
  { t: '乌兹别克斯坦铜矿开采合资企业完成股权收购', s: '交易金额未披露。' },
  { t: '吉尔吉斯斯坦国有企业私有化招标启动，涉及三家工厂', s: '投标截止到下月。' },
];

const ZH_LOW = [
  { t: '阿拉木图举办国际爵士音乐节', s: '来自多国的乐队参加演出。' },
  { t: '哈萨克斯坦国家队在亚洲杯预选赛中获胜', s: '比赛在阿斯塔纳举行。' },
  { t: '比什凯克出现降雪天气，市民出行受影响', s: '气象部门发布提示。' },
  { t: '阿塞拜疆诗人获颁文学奖', s: '颁奖仪式在巴库举行。' },
  // 这条是线上真实标题，且是**刻意**判 0 的：讲公共卫生与数字技术，
  // 对「中亚投资新闻」这个产品来说不是投资题材。
  // （它曾被误放进「应得分」组，正好说明双向语料有多必要。）
  { t: '哈萨克斯坦推进公共卫生系统现代化，数字技术助力提升医疗服务质量', s: '政府将改进公共卫生系统。' },
];

const highs = ZH_HIGH.map((x) => investmentRelevanceOf(x.t, x.s));
const lows = ZH_LOW.map((x) => investmentRelevanceOf(x.t, x.s));

ok(
  '每一条高投资新闻都有分',
  highs.every((v) => v > 0),
  JSON.stringify(ZH_HIGH.map((x, i) => `${highs[i]} ${x.t.slice(0, 16)}`)),
);
ok(
  '最低的高投资分 > 最高的无关分（两个区间不重叠）',
  Math.min(...highs) > Math.max(...lows),
  `高 ${JSON.stringify(highs)} vs 低 ${JSON.stringify(lows)}`,
);
ok(
  '无关新闻全部 0 分',
  lows.every((v) => v === 0),
  JSON.stringify(ZH_LOW.map((x, i) => `${lows[i]} ${x.t.slice(0, 16)}`)),
);

// ============================================================
// 三、标题加权与其余结构性约定
// ============================================================

section('标题加权 / 逐词只计一次 / 边界');

{
  // 同一个词在标题里 vs 只在摘要里，前者应恰好是后者的 TITLE_WEIGHT 倍。
  // ⚠️ 对照组的**标题必须不含任何关键词**，否则它自己也会贡献分数 ——
  // 第一版就踩了这个坑（对照组标题写成「与投资无关的标题」，里面有「投资」）。
  const inTitle = investmentRelevanceOf('铁路项目开工', '');
  const inSummary = investmentRelevanceOf('某某文化活动', '铁路项目开工');
  ok(
    `标题命中按 ${TITLE_WEIGHT} 倍计`,
    inTitle === inSummary * TITLE_WEIGHT,
    `标题 ${inTitle} vs 摘要 ${inSummary}`,
  );
  ok('对照组标题本身 0 分（证明上一条的对比是干净的）', scoreInvestmentRelevance('某某文化活动') === 0);
}

{
  // 复读不刷分
  const once = scoreInvestmentRelevance('投资');
  const repeated = scoreInvestmentRelevance('投资投资投资投资');
  ok('同一关键词重复出现只计一次', once === repeated, `${once} vs ${repeated}`);
}

{
  ok('空文本 0 分', scoreInvestmentRelevance('') === 0);
  ok('缺少摘要不报错', investmentRelevanceOf('铁路开工', null) > 0);
  ok('全部为空时 0 分', investmentRelevanceOf(null, undefined) === 0);
}

// 刻意的设计决定：**国家名不加分**（见 investment-score.ts 文件头的说明）。
// 钉住它是为了防止以后有人「顺手把 country 加回关键词表」——
// 那会给所有文章加同一个常数、白白稀释真正信号的相对差距。
{
  ok('国家名（中文）不加分', scoreInvestmentRelevance('哈萨克斯坦') === 0);
  ok('国家名（拉丁）不加分', scoreInvestmentRelevance('kazakhstan') === 0);
  ok('官职名（中文）不加分', scoreInvestmentRelevance('总统') === 0);
}

section('拉丁词（入库端翻译前用）仍然有效');

{
  const en = 'Oil pipeline construction agreement signed with foreign investors';
  ok('英文投资标题能得分', scoreInvestmentRelevance(en) > 0, String(scoreInvestmentRelevance(en)));
  ok('privatization 命中', scoreInvestmentRelevance('Privatization of state assets') > 0);
  ok('infrastructure 命中', scoreInvestmentRelevance('infrastructure upgrade') > 0);
  ok('纯无关英文 0 分', scoreInvestmentRelevance('A poetry festival was held in Baku') === 0);
  // 长词权重更高（旧版直觉的保留形式）
  ok(
    '长词权重高于短词',
    scoreInvestmentRelevance('privatization') > scoreInvestmentRelevance('gas'),
    `privatization ${scoreInvestmentRelevance('privatization')} vs gas ${scoreInvestmentRelevance('gas')}`,
  );
}

section('排序规则本体：投资相关性优先，分类次之');

{
  // 用户 2026-09-21 的要求就是这一条：**越相关越靠前**。
  // 这条断言直接钉住「相关性是主键」—— 如果哪天有人把主次改回
  // 「分类优先」，highScoreLowPriority 会被排到 lowScoreHighPriority 后面，这里立刻红。
  const highScoreLowPriority: RankableStory = {
    relevanceScore: 40,
    category: 'society', // 分类优先级 40，很低
    published_at: '2026-09-20T00:00:00Z',
  };
  const lowScoreHighPriority: RankableStory = {
    relevanceScore: 0,
    category: 'economy', // 分类优先级 100，最高
    published_at: '2026-09-21T00:00:00Z',
  };
  const sorted = [lowScoreHighPriority, highScoreLowPriority].sort(compareByInvestmentRelevance);
  ok(
    '相关但分类低的，排在无关但分类高的前面',
    sorted[0] === highScoreLowPriority,
    JSON.stringify(sorted.map((x) => `${x.relevanceScore}/${x.category}`)),
  );
}

{
  // 相关性相同时，分类优先级接手（这是它保留为第二键的价值）
  const a: RankableStory = { relevanceScore: 0, category: 'society' };
  const b: RankableStory = { relevanceScore: 0, category: 'politics' };
  const sorted = [a, b].sort(compareByInvestmentRelevance);
  ok('同分时按分类优先级', sorted[0] === b, JSON.stringify(sorted.map((x) => x.category)));
}

{
  // 同分同类时按时间倒序（新的在前），避免顺序变成随机
  const older: RankableStory = { relevanceScore: 12, category: 'economy', published_at: '2026-09-19T00:00:00Z' };
  const newer: RankableStory = { relevanceScore: 12, category: 'economy', published_at: '2026-09-21T00:00:00Z' };
  const sorted = [older, newer].sort(compareByInvestmentRelevance);
  ok('同分同类时新的在前', sorted[0] === newer, JSON.stringify(sorted.map((x) => x.published_at)));
}

{
  // 未知分类不能崩，也不该被当成最高优先级。
  // `compare(a, b) > 0` 表示 a 排在 b **后面** —— 第一版把符号写反了，正好被这条抓出来。
  const unknown: RankableStory = { relevanceScore: 0, category: 'some_new_category' };
  const society: RankableStory = { relevanceScore: 0, category: 'society' };
  const economy: RankableStory = { relevanceScore: 0, category: 'economy' };
  ok(
    '未知分类排在 society 之后（比较器正负号约定）',
    compareByInvestmentRelevance(society, unknown) < 0,
    String(compareByInvestmentRelevance(society, unknown)),
  );
  ok(
    '未知分类排在 economy 之前（默认档低于 economy）',
    compareByInvestmentRelevance(unknown, economy) > 0,
    String(compareByInvestmentRelevance(unknown, economy)),
  );
}

section('入库闸门：旧词表一个都不能少，且与排序词表严格分家');

{
  // ★ 这是本文件最重要的一条。`fetch-news` 的闸门决定「稿子收不收」——
  //   收紧它会直接减少每国篇数，而本项目历史上正因为判据过严出现过
  //   「每国不足 15 篇」（见 AGENTS.md）。
  //
  //   所以：**排序用的加权词表**和**闸门词表**是两回事。加权表为了区分度
  //   刻意丢掉了 president / government / development 这类无区分力的词；
  //   如果哪天有人把闸门也改成 `scoreInvestmentRelevance(...) > 0`，
  //   下面这一轮逐词检查会立刻红。
  const legacy = gateKeywords();
  ok(
    `旧闸门词表不少于 86 个词（只增不减）`,
    legacy.length >= 86,
    `实际 ${legacy.length}`,
  );
  const nowFailing = legacy.filter((kw) => !isInvestmentTopic(`xxx ${kw} xxx`));
  ok(
    `旧闸门词表 ${legacy.length} 个词全部仍然通过（一个都没被删）`,
    nowFailing.length === 0,
    nowFailing.join(', '),
  );

  // 反向：闸门词表里**哪些不该**进排序表？
  //
  // 这是「闸门 vs 排序器」职责分离的核心断言，所以把当前分区**完整钉住**：
  // 以后任何人改动任一张表，这里都会出现 diff，逼他解释为什么。
  //
  // ★ `' BRI'` 这条就是这套断言的价值实证：它带前导空格、又是大写，
  //   而匹配时文本会转小写 —— 也就是说它**一直是个死词**。
  //   分区快照把它单独暴露了出来（它是唯一一个前导空格的条目）。
  //   修复方式是在构建闸门时统一转小写（放宽方向，符合「只增不减」）。
  const zeroScoring = legacy.filter((kw) => scoreInvestmentRelevance(kw) === 0).sort();
  const EXPECTED_GATE_ONLY = [
    ' BRI', 'automotive', 'azerbaijan', 'bank', 'bilateral', 'building', 'business',
    'caspian', 'central asia', 'commercial', 'company law', 'compliance', 'corporate',
    'diplomat', 'finance', 'fuel', 'government', 'kazakhstan', 'kyrgyzstan', 'law',
    'legal', 'minister', 'parliament', 'president', 'production', 'resource',
    'south caucasus', 'tajikistan', 'tax', 'uzbekistan',
  ].sort();
  const added = zeroScoring.filter((kw) => !EXPECTED_GATE_ONLY.includes(kw));
  const removed = EXPECTED_GATE_ONLY.filter((kw) => !zeroScoring.includes(kw));
  ok(
    '闸门独有词（排序 0 分）与预期分区完全一致',
    added.length === 0 && removed.length === 0,
    [
      added.length ? `新变成 0 分（被踢出排序表？）：${added.join(', ')}` : '',
      removed.length ? `不再 0 分（被加进排序表？）：${removed.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('；'),
  );

  // 上面那条是「快照」，失败信息是 diff；这一条是它背后的**设计意图**，
  // 失败信息直接说明后果，便于不熟悉本项目的人读懂为什么不能加这些词。
  const NO_DISCRIMINATION = [
    // 国家／地区名：某国的文章几乎篇篇都有，零区分力
    'central asia', 'kazakhstan', 'uzbekistan', 'kyrgyzstan', 'tajikistan',
    'azerbaijan', 'south caucasus', 'caspian',
    // 官职／机构名：出现在几乎所有时政稿里，同样零区分力
    'president', 'parliament', 'government', 'minister', 'diplomat', 'bilateral',
  ];
  const polluted = NO_DISCRIMINATION.filter((kw) => scoreInvestmentRelevance(kw) > 0);
  ok(
    '国家名/地区名/官职名不给排序加分（加了等于给所有文章加同一常数）',
    polluted.length === 0,
    polluted.join(', '),
  );
  // 但它们**必须**仍然是闸门词 —— 闸门要宽松兜底，宁可多收再靠排序压下去。
  const gateMissing = NO_DISCRIMINATION.filter((kw) => !isInvestmentTopic(`xxx ${kw} xxx`));
  ok(
    '同上这些词仍然通过闸门（宽松兜底，先收进来再说）',
    gateMissing.length === 0,
    gateMissing.join(', '),
  );

  // 闸门的实际语义：旧实现在英文文本上的行为必须不变
  ok('闸门对英文投资标题放行', isInvestmentTopic('Oil pipeline construction starts'));
  ok('闸门对英文无关标题拒收', !isInvestmentTopic('A poetry festival was held in Baku'));
  ok('闸门对中文投资标题放行', isInvestmentTopic('哈萨克斯坦与中方签署铀矿开发协议'));
  ok('闸门遇到空文本不崩', !isInvestmentTopic(''));
}

section('explainInvestmentRelevance 能说清「为什么这篇分高」');

{
  const { score, hits } = explainInvestmentRelevance('哈萨克斯坦与中方签署铀矿开发协议', '总投资12亿美元');
  ok('给出分数', score > 0, String(score));
  ok('给出命中词', hits.includes('签署') && hits.includes('投资'), JSON.stringify(hits));
  ok('命中词去重', new Set(hits).size === hits.length, JSON.stringify(hits));
}

// ============================================================
// 四、可选：真实数据体检 + 新旧排序对比
// ============================================================

const dataPath = process.argv[2];
if (dataPath) {
  const raw = JSON.parse(readFileSync(dataPath, 'utf8')) as
    | { articles: Array<Record<string, unknown>> }
    | Array<Record<string, unknown>>;
  const rows = Array.isArray(raw) ? raw : raw.articles;

  section(`真实数据体检（${dataPath}，共 ${rows.length} 篇）`);

  const scored = rows
    // 与生产一致：`push` 会先用 `EXCLUDED_CATEGORIES` 整类剔掉文体类，
    // 排序只发生在剩下的文章上。诊断不套这层过滤会把「实际不会出现的条目」
    // 排进前几名，得出错误结论（第一版就是这样：一条 sports 排到 kz 第 4）。
    .filter((r) => !EXCLUDED_CATEGORIES.has(String(r.category ?? '')))
    .map((r) => ({
      country: String(r.country ?? r.country_code ?? ''),
      title: String(r.title ?? ''),
      summary: String(r.summary ?? ''),
      category: String(r.category ?? ''),
      score: investmentRelevanceOf(String(r.title ?? ''), String(r.summary ?? '')),
    }));

  const withScore = scored.filter((x) => x.score > 0);
  const pct = (withScore.length / scored.length) * 100;
  console.log(`  剔除文体类后 ${scored.length} 篇，其中评分 > 0：${withScore.length}（${pct.toFixed(1)}%）`);
  ok(
    '真实数据上大部分文章能拿到分数（旧英文表只有 2.8%）',
    pct > 60,
    `实际 ${pct.toFixed(1)}%`,
  );

  // 旧排序失灵的量化证据：最大分类里的文章会全部并列、
  // 组内顺序由相关性（恒为 0）决定 → 实际就是数据库给的顺序（任意）。
  const byCat = new Map<string, number>();
  for (const x of scored) byCat.set(x.category, (byCat.get(x.category) ?? 0) + 1);
  const biggest = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0];
  if (biggest) {
    const share = (biggest[1] / scored.length) * 100;
    const zeroInBiggest = scored.filter((x) => x.category === biggest[0] && x.score === 0).length;
    console.log(
      `  最大分类 ${biggest[0]} 占 ${biggest[1]} 篇（${share.toFixed(1)}%），` +
        `其中旧评分为 0 的 ${zeroInBiggest} 篇 —— 旧排序下它们全部并列，顺序任意`,
    );
  }

  // 排序结果：分数最高的若干条应当确实是投资题材
  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, 10);
  console.log('  分数最高的 10 条：');
  for (const x of top) console.log(`    ${String(x.score).padStart(3)} [${x.category}] ${x.title.slice(0, 48)}`);

  const zeroCount = scored.filter((x) => x.score === 0).length;
  console.log(`  0 分：${zeroCount} 篇（${((zeroCount / scored.length) * 100).toFixed(1)}%）`);

  // 逐国对比「新排序」与「旧排序」的前几名，让改动效果肉眼可见。
  // 旧排序 = 分类优先级优先、相关性次之（2026-09-21 之前的线上行为）。
  const byCountry = new Map<string, typeof scored>();
  for (const x of scored) {
    const g = byCountry.get(x.country);
    if (g) g.push(x);
    else byCountry.set(x.country, [x]);
  }

  for (const [cc, list] of [...byCountry.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const next = [...list].sort((a, b) =>
      compareByInvestmentRelevance(
        { relevanceScore: a.score, category: a.category, published_at: null },
        { relevanceScore: b.score, category: b.category, published_at: null },
      ),
    );
    const old = [...list].sort((a, b) => {
      const pa = CATEGORY_PRIORITY[a.category] ?? 30;
      const pb = CATEGORY_PRIORITY[b.category] ?? 30;
      if (pa !== pb) return pb - pa;
      return b.score - a.score;
    });
    console.log(`\n  [${cc}] ${list.length} 篇 —— 新排序前 5 / 旧排序前 5`);
    for (let i = 0; i < 5; i++) {
      const n = next[i];
      const o = old[i];
      console.log(`    ${i + 1}. 新 ${String(n.score).padStart(3)} [${n.category}] ${n.title.slice(0, 34)}`);
      console.log(`       旧 ${String(o.score).padStart(3)} [${o.category}] ${o.title.slice(0, 34)}`);
    }
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
