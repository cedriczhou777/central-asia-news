/**
 * 投资相关性评分 —— 入库端与推送端共用的唯一实现。
 *
 * ## 为什么要有这个文件（这是一次真实的线上失效）
 *
 * 2026-09-21 用户反馈：*「与投资越相关的新闻越放在靠前」*。
 * 查下来不是排序规则写错了，是这个评分**根本没在工作**：
 *
 * `push` 阶段只用**英文**关键词表打分（`invest` / `oil` / `railway` …），
 * 但推送链路上游已经把文章**翻译成中文**了，于是
 * `text.includes('invest')` 在中文标题上永不命中。
 * 实测线上 1000 篇里评分 > 0 的只有 **28 篇（2.8%）**，而且命中的是
 * `Kazakhstan Travel Forum`、`Kikshering Central Asia` 这类**拉丁字母残留**，
 * 与投资相关性无关 —— 也就是说排序实际只剩「分类优先级」在起作用。
 *
 * 之所以一直没被发现：`fetch-news` 里**有一个同名同实现的函数是对的** ——
 * 它跑在翻译**之前**，文本还是英文原文，英文词表当然有效。
 * 同一个函数名被用在**语言不同**的两个阶段，是这次失效的真正形态。
 *
 * 因此本模块的设计目标是**跨语言**：中英文关键词一起上，
 * 不管调用方拿到的文本是什么语言都能给出有意义的分数。
 * 这样两个阶段可以共用一份实现，不会再出现「一边对一边错」。
 *
 * ## 分级与权重
 *
 * 单纯 `sum(关键词长度)` 在这个语料上有两个问题：中文词普遍 2–4 字、
 * 区分度不足；而 `经济`/`政策`/`建设` 这种高频词几乎每篇都有，
 * 会把真正有信息量的信号（`外资`/`中标`/`私有化`）淹没。
 * 所以按**信号强度**分三档：
 *
 * | 档 | 权重 | 含义 | 例 |
 * |---|---|---|---|
 * | 强 | 3 | 交易/资金/产能事件本身 | 投资、外资、签约、中标、投产、并购、融资、私有化、特许权 |
 * | 中 | 2 | 具体行业或基础设施 | 石油、天然气、铁路、矿产、化工、电力、灌溉、纺织 |
 * | 弱 | 1 | 宏观口径与政策框架 | 经济、政策、出口、进口、贸易、建设、项目 |
 *
 * **刻意不收的词**（写在这里是为了防止以后有人「顺手补上」）：
 *   - **国家名/城市名**。旧英文表里有 `kazakhstan`、`central asia` 之类，
 *     但这类词对「哪篇更相关」毫无区分力（某国的文章几乎篇篇都有），
 *     只会给所有文章加同一个常数，白白稀释其他信号的相对差距。
 *   - **纯官职**（总统、部长）。出现在几乎所有时政稿里，同样没有区分力；
 *     真正有区分力的是它们**做了什么**（签署/批准/启动），那些词已在上表。
 *
 * ## 标题与摘要的权重不同
 *
 * 标题命中按 **3 倍**计。摘要（`summary`）是模型生成的较长文本，
 * 关键词密度天然更高，容易让「顺带提了一句投资」的文章压过标题就是投资主题的文章。
 * 实测里这个偏差很明显，所以标题单独加权。
 */

/** 权重表：**3 = 交易/资金/产能事件本身**。这些词出现，通常说明这篇就是投资新闻。 */
const STRONG_ZH = [
  // 投资与资金
  '投资', '引资', '招商引资', '外资', '外商', '合资', '独资', '控股', '参股',
  '融资', '募资', '贷款', '信贷', '授信', '债券', '发债', '上市', '私有化', '股份制',
  '收购', '并购', '重组', '股权', '股份', '出资', '注册资本', '增资', '注资',
  // 交易与项目落地
  '签约', '签署', '协议', '合同', '招标', '投标', '中标', '承包', '供货',
  '开工', '动工', '奠基', '投产', '竣工', '试产', '达产', '产能', '扩建', '改建',
  '特许经营', '特许权', '特许', '特许协议', '租赁', '入驻', '落地', '开园',
  // 政策与财税（对投资有直接约束力的）
  '关税', '税收', '税制', '免税', '减税', '关税同盟', '补贴', '拨款', '财政预算',
  '利率', '汇率', '通胀', '通货膨胀', '许可证', '审批', '配额',
];

/** 权重表：**2 = 具体行业或基础设施**。行业性新闻，投资含义明确但不一定是交易。 */
const MEDIUM_ZH = [
  // 能源
  '石油', '天然气', '油气', '原油', '炼油', '石化', '管道', '输气', '输油',
  '电力', '电站', '电厂', '发电', '电网', '输电', '光伏', '太阳能', '风电', '水电',
  '可再生', '能源', '煤炭', '煤矿', '核能', '铀',
  // 矿产与材料
  '矿产', '采矿', '选矿', '冶炼', '冶金', '铜', '金矿', '黄金', '稀土', '锂',
  '煤', '铁矿', '金属', '水泥', '钢铁', '化肥', '化工', '聚乙烯', '聚丙烯', '塑料',
  // 基建与交通
  '铁路', '公路', '高速公路', '道路', '路段', '路面', '路基', '桥梁', '隧道',
  '铺设', '沥青', '港口', '码头', '机场', '地铁',
  '物流', '运输', '货运', '通道', '枢纽', '班列', '集装箱', '管线',
  // 制造与农业
  '制造业', '工厂', '工业', '产业园', '工业园', '经济特区', '纺织', '服装',
  '汽车', '机车', '机械', '农业', '灌溉', '水利', '棉花', '小麦', '畜牧', '温室',
  '粮食', '仓储',
  // 城建
  '房地产', '住房', '基础设施', '基建', '城建',
];

/** 权重表：**1 = 宏观口径与政策框架**。几乎是背景词，只用来打破同档平局。 */
const WEAK_ZH = [
  '经济', '国内生产总值', '贸易', '出口', '进口', '外贸', '顺差', '逆差',
  '供应链', '产业链', '营收', '利润', '增长', '增长率', '消费', '市场',
  '政策', '改革', '法规', '法令', '法案', '战略', '规划', '纲要', '总统令',
  '监管', '标准', '建设', '项目', '发展', '合作', '谅解备忘录',
];

/**
 * 拉丁字母关键词（保留原表语义）。
 *
 * 入库端（`fetch-news`）跑在翻译**之前**，文本是英文/俄文原文，
 * 这一份才是那边的主力；推送端的文本是中文，中文表才是主力。
 * 两份放在同一个函数里一起算，两端各取所需，不再需要「记住自己该用哪张表」。
 */
const LATIN = [
  // 强：交易/资金
  'invest', 'investment', 'investor', 'shareholder', 'privatization', 'acquisition',
  'merger', 'ipo', 'loan', 'credit', 'bond', 'tender', 'contract', 'concession',
  'commissioning', 'feasibility', 'tariff', 'subsidy',
  // 中：行业/基建
  'oil', 'gas', 'petroleum', 'pipeline', 'refinery', 'petrochemical', 'lng',
  'energy', 'power', 'electricity', 'renewable', 'solar', 'wind', 'hydro', 'coal', 'uranium',
  'mining', 'mineral', 'copper', 'gold', 'lithium', 'ore', 'metal', 'steel', 'cement',
  'chemical', 'fertilizer', 'polymer', 'plastic', 'textile',
  'infrastructure', 'railway', 'rail', 'road', 'highway', 'bridge', 'tunnel', 'port',
  'airport', 'logistics', 'freight', 'transit', 'corridor', 'terminal',
  'manufacturing', 'factory', 'industrial', 'industrial zone', 'special economic zone',
  'agriculture', 'irrigation', 'cotton', 'wheat', 'livestock', 'greenhouse',
  'construction', 'real estate', 'housing', 'property',
  // 弱：宏观/政策
  'economy', 'gdp', 'trade', 'export', 'import', 'supply chain', 'revenue', 'profit',
  'growth', 'market', 'policy', 'reform', 'regulation', 'legislation', 'decree',
  'strategy', 'programme', 'program', 'agreement', 'memorandum', 'development',
];

/**
 * 拉丁词的权重按长度粗分：短词（`gas`/`oil`/`ore`）在不同语境下歧义大（例如
 * `gas` 会命中「加油站起火」这类非投资新闻），给低档；长词
 * （`privatization`/`infrastructure`/`concession`）几乎不会误命中，给高档。
 * 这也是旧版「长关键词权重更高」那条直觉的保留形式。
 */
const LATIN_WEIGHT = (word: string): number => (word.length >= 8 ? 3 : word.length >= 5 ? 2 : 1);

/** 预展开成 [词, 权重] 列表，避免每次调用都重建结构。 */
const ALL_KEYWORDS: Array<{ word: string; weight: number }> = [
  ...STRONG_ZH.map((word) => ({ word, weight: 3 })),
  ...MEDIUM_ZH.map((word) => ({ word, weight: 2 })),
  ...WEAK_ZH.map((word) => ({ word, weight: 1 })),
  ...LATIN.map((word) => ({ word, weight: LATIN_WEIGHT(word) })),
];

/**
 * ## 入库闸门（`isInvestmentTopic`）与排序评分是**两件事**，词表必须分开
 *
 * `fetch-news` 里那个 `isInvestmentRelevant` 是**闸门**：不通过的稿子直接不收。
 * 历史上判据过严导致过「每国不足 15 篇」（见 AGENTS.md），所以它**只能放宽、不能收紧**。
 *
 * 而本文件上面那套加权词表是**排序器**，为了区分度刻意丢掉了
 * `president` / `government` / `development` / `resource` 这类无区分力的词 ——
 * 如果拿它当闸门用，等于**悄悄收紧了入库条件**，可能直接复发那次「篇数不足」。
 *
 * 所以：把 2026-09-21 之前的旧词表**逐字保留**下来做闸门，
 * 只在其上**追加**可用的词，永不删减。`scripts/test-investment-score.ts`
 * 里有一条断言逐词检查「旧表的每一个词仍然能通过闸门」——
 * 想删词的话那条断言会先红。
 */
const GATE_KEYWORDS_LEGACY = [
  // 投资主题
  'invest', 'investment', 'investor', 'foreign investment', 'direct investment',
  // 能源
  'oil', 'gas', 'energy', 'petroleum', 'fuel', 'pipeline', 'renewable', 'power', 'electricity',
  // 化工
  'chemical', 'petrochemical', 'fertilizer', 'plastic', 'polymer',
  // 矿产
  'mining', 'mineral', 'copper', 'gold', 'uranium', 'ore', 'metal', 'resource', 'lithium',
  // 基建
  'infrastructure', 'railway', 'road', 'bridge', 'construction', 'transport', 'logistics', 'highway',
  // 房地产
  'real estate', 'property', 'housing', 'building', 'development',
  // 制造业
  'manufacturing', 'factory', 'industrial', 'production', 'textile', 'automotive',
  // 政治经济政策
  'policy', 'reform', 'regulation', 'law', 'legislation', 'decree', 'strategy',
  'tax', 'legal', 'compliance', 'company law', 'commercial', 'corporate',
  'economy', 'gdp', 'trade', 'export', 'import', 'business', 'finance', 'bank',
  'president', 'parliament', 'government', 'minister', 'diplomat', 'bilateral', 'agreement',
  // 中亚／里海特定（对「哪篇更相关」没有区分力，但做闸门时是必要的兜底 —— 见上面的说明）
  'central asia', 'kazakhstan', 'uzbekistan', 'kyrgyzstan', 'azerbaijan', 'tajikistan',
  'south caucasus', 'caspian',
  'silk road', 'belt and road', ' BRI',
];

/**
 * 闸门词表 = 旧表（逐字保留）+ 新的中文词。**只增不减。**
 *
 * ⚠️ 构建时统一 `toLowerCase()`，这是修一个**一直存在的死词**：
 * 匹配处会先把文本转小写，而旧表里的 `' BRI'` 是**大写**的 ——
 * `lowercased.includes(' BRI')` 永远为 false，这个词从来没生效过。
 * （`scripts/test-investment-score.ts` 的逐词检查就是把它抓出来的。）
 *
 * 归一化只影响这一个词，且方向是**放宽**（多放行一类稿子），
 * 符合本表「只能放宽、不能收紧」的约定，不是收紧入库条件。
 */
const GATE_KEYWORDS: string[] = [
  ...GATE_KEYWORDS_LEGACY,
  ...STRONG_ZH,
  ...MEDIUM_ZH,
  ...WEAK_ZH,
].map((kw) => kw.toLowerCase());

/**
 * 入库端的粗筛：这篇稿子**沾不沾投资主题**（决定收不收，不是排序）。
 *
 * 为什么不直接用 `scoreInvestmentRelevance(text) > 0`：
 * 那会连带把上面刻意精简过的加权词表当成闸门，等于收紧入库条件。
 * 这里的语义是「宽松兜底」，宁可多收进来、让评分在后面把它们排下去。
 */
export function isInvestmentTopic(text: string): boolean {
  const t = (text || '').toLowerCase();
  return GATE_KEYWORDS.some((kw) => t.includes(kw));
}

/** 供回归脚本逐词校验「旧词表一个都没被删」。 */
export function gateKeywords(): readonly string[] {
  return GATE_KEYWORDS_LEGACY;
}

/** 命中的关键词（供测试与排查用：能直接看出「为什么这篇分高」）。 */
export function matchedInvestmentKeywords(text: string): string[] {
  const t = text.toLowerCase();
  return ALL_KEYWORDS.filter((k) => t.includes(k.word)).map((k) => k.word);
}

/**
 * 一段文本的投资相关性得分。**同一关键词只计一次**（复读不刷分）。
 *
 * 传进来的文本可以是中文、英文或混合 —— 这正是本模块存在的理由。
 */
export function scoreInvestmentRelevance(text: string): number {
  const t = text.toLowerCase();
  let score = 0;
  for (const { word, weight } of ALL_KEYWORDS) {
    if (t.includes(word)) score += weight;
  }
  return score;
}

/**
 * 一篇新闻的投资相关性得分：**标题按 3 倍计**（理由见文件头）。
 *
 * `summary` 允许缺失/为 null（部分行在抓取时没拿到摘要）。
 */
export const TITLE_WEIGHT = 3;

export function investmentRelevanceOf(title: string | null | undefined, summary?: string | null): number {
  return TITLE_WEIGHT * scoreInvestmentRelevance(title || '') + scoreInvestmentRelevance(summary || '');
}

/**
 * 一次性拿到「分数 + 命中词」，用于把排序结果讲清楚
 * （排查「为什么这篇排前面」时只有总分是不够的）。
 */
export function explainInvestmentRelevance(
  title: string | null | undefined,
  summary?: string | null,
): { score: number; hits: string[] } {
  const hits = [
    ...new Set([...matchedInvestmentKeywords(title || ''), ...matchedInvestmentKeywords(summary || '')]),
  ];
  return { score: investmentRelevanceOf(title, summary), hits };
}

/**
 * 分类优先级。原来是 `wechat/push` 里的局部常量，2026-09-21 挪到这里 ——
 * 因为「投资相关性为主、分类为辅」这条**排序规则**必须是可测的，
 * 而规则里包含这两份数据；只把分数抽出来、优先级留在路由文件里，
 * 回归就只能覆盖一半，规则照样能被改漂。
 *
 * 数值含义：经济/政策/能源/矿产在前，社会/民生/医疗在后。数字本身不重要，
 * 重要的是相对顺序。
 *
 * 历史依据（来自原注释，别丢）：用户 2026-09-19 明确要求「与投资者最相关的
 * （经济形势、行业动态、外汇储备、国家政策、政治变动）放最前面」——
 * 当时是用**分类优先级**近似表达的；2026-09-21 又提出「与投资越相关的新闻
 * 越放在靠前」，于是细化到**文章级**。两次要求方向一致。
 *
 * 表里**刻意没有 culture / sports** —— 那两类在入库后就被 `EXCLUDED_CATEGORIES`
 * 整类剔除（用户 2026-09-21：「演艺娱乐，体育类新闻全部取消」），走不到这里的排序。
 * 留着它们只会让人误以为还有「文体类排最后」这回事。
 */
export const CATEGORY_PRIORITY: Record<string, number> = {
  economy: 100, policy: 95, oil_gas: 90, renewable_energy: 90, energy: 88,
  minerals: 88, politics: 85, transport: 80, infrastructure: 80, manufacturing: 78,
  chemicals: 75, housing: 70, law: 65, security: 60, livelihood: 55,
  healthcare: 50, society: 40,
};

/** 排序所需的最小字段集。真实行字段更多，这里只要排序用到的三个。 */
export interface RankableStory {
  relevanceScore: number;
  category?: string | null;
  published_at?: string | null;
}

/**
 * 推送端的排序规则 —— **投资相关性为主，分类优先级为辅，时间兜底**。
 *
 * 2026-09-21 用户要求「与投资越相关的新闻越放在靠前」，于是把两个键的主次
 * **对调**：原来是「分类优先级 → 相关性」，现在是「相关性 → 分类优先级」。
 *
 * 为什么旧顺序满足不了这个要求：相关性分数在线上恒为 0（英文词表匹配中文），
 * 于是同分类内所有文章同分，组内顺序退化成数据库给什么就什么；
 * 而 `energy`(88) 这类高投资含义的分类又会整体排在 `politics`(85) 之后 ——
 * 与「相关性优先」的直觉相反。
 *
 * 分类优先级**保留为第二键**而不是删掉：相关性同为 0 时它仍然有用，
 * 能把 `politics`/`livelihood` 排到 `society` 前面，避免尾部顺序变成随机。
 */
export function compareByInvestmentRelevance(a: RankableStory, b: RankableStory): number {
  if (a.relevanceScore !== b.relevanceScore) return b.relevanceScore - a.relevanceScore;
  const pa = CATEGORY_PRIORITY[a.category || ''] ?? 30;
  const pb = CATEGORY_PRIORITY[b.category || ''] ?? 30;
  if (pa !== pb) return pb - pa;
  // 第三键：新的在前。调用方（`getArticlesByDateRange`）已按 published_at 倒序返回，
  // 但 `Array.prototype.sort` 的稳定性不该被依赖来表达业务顺序，这里显式写出来。
  return String(b.published_at || '').localeCompare(String(a.published_at || ''));
}
