import { NextRequest, NextResponse } from 'next/server';
import { insertArticles, getRecentCanonicalUrls, getRecentOriginalTitleKeys } from '@/lib/db-articles';
import { fetchTelegramRSS } from '@/lib/scraper';
import { isChineseText, beijingDate, canonicalUrl, originalTitleKey } from '@/lib/utils';
import { dedupeStories } from '@/lib/same-event';
import { scoreInvestmentRelevance, isInvestmentTopic } from '@/lib/investment-score';
import { countryList } from '@/lib/data/countries';
import { RSS_SOURCES, type RSSSource } from '@/lib/data/rss-sources';
import { fetchFeed, FeedFetchError, type FeedItem } from '@/lib/feed-fetch';
import { translateNews, resetTranslationStats, getTranslationStats, fallbackCategory } from '@/lib/translate';
import { DEFAULT_TELEGRAM_CHANNELS, parseTelegramChannels } from '@/lib/telegram-channels';

// ⚠️ 不要在这里 new Parser / 直接调 parser.parseURL —— 用 `@/lib/feed-fetch` 的 `fetchFeed`。
// 原因见那个文件的头部：直接 parseURL 时，「站点按 UA 返回网页」会被 xml2js 报成
// `Unexpected close tag`，看起来像「XML 畸形」，实际是 UA 身份问题。
// fetchFeed 会把 Content-Type 一起报出来，并且自带超时与 gzip。

/**
 * 闸 2（库内身份去重）回溯的天数。
 *
 * ⚠️ 时间窗筛的是 **`published_at`（文章发布日期）**，不是「我们什么时候入库的」。
 * 两者在**老新闻被重抓**时不等价：一篇 09-18 发布的稿子若 09-22 才被抓到，
 * 它今天入库，但 `published_at` 落在 3 天窗口外 —— 窗口里查不到它，
 * 同一链接**每被重抓一次就多一条重复行**。这是**真实存在但尚未发生**的缺口：
 * 触发条件是「发布日期与重抓时间相隔 > 3 天」。
 *
 * 2026-09-22 已用线上数据核过，**它并不是当时那批重复行的成因**：
 * 那批行的 `publishedAt` 距入库只有 2.68–2.99 天，**在窗口之内**，
 * 且它们的 `createdAt`（1.05 / 0.62 天前）全都早于
 * `37cf20b`（链接归一化修复，09-21 23:15）的上线时间 ——
 * 是**修复前的存量**，不是仍在产生的。别把这条注释当成已确诊的根因。
 *
 * 所以这里先不动判据，只把窗口规模报进接口（见 `dedup.window`），
 * 等真的观测到「相隔 > 3 天的重抓」再改。改列要动 `getRecentCanonicalUrls`。
 */
const DB_DEDUP_WINDOW_DAYS = 3;

// RSS 源清单已移到 `@/lib/data/rss-sources`（脚本要读它，Route Handler 导出不了）。
// 加源/换源的纪律与已死源黑名单都记在那个文件里。

/** 一条待入库的候选新闻。RSS / 网页爬虫 / Telegram 三条采集路径共用这个结构。 */
interface Candidate {
  item: FeedItem;
  source: RSSSource;
  relevanceScore: number;
}

/** 一次抓取跑完后的汇总，既用于日志，也通过 GET /api/fetch-news 暴露给调度器。 */
interface FetchSummary {
  date: string;
  /** 各信息源取到的原始条数合计 */
  totalFetched: number;
  /** 通过投资相关性初筛的条数 */
  candidates: number;
  /** URL 去重后剩余 */
  afterUrlDedup: number;
  /** 内容级去重后剩余 */
  afterContentDedup: number;
  /**
   * 去重分三段记账。**别再合成一个数字**：三段失败的排查方向完全不同
   * （批内重复 = 抓取重复拉取；跨轮重复 = 库内判重失效；同事件 = 理解机制漏判），
   * 合成之后就再也回答不了「今天为什么少了几篇」。
   */
  dedup: {
    /** 批内链接/原文重复（同一轮里同一条被抓到两次） */
    intraBatch: number;
    /** 与库内近 3 天重复（跨轮重复，线上重复行的主要来源） */
    againstDb: number;
    /** 「同一件事」判组剔除（表述不同、事件相同） */
    sameEvent: number;
    /** 库内去重查询失败 → 本轮放弃入库时的原因；正常为 null */
    dbCheckError: string | null;
    /**
     * 闸 2 那次窗口查询**实际拿到多少行**（`rows` = 归一化后的链接数）。
     *
     * 报出来是为了让「窗口被静默截断」在线上可判断 —— 单次查询没有分页，
     * 而 PostgREST 的条数上限超限时不报错、只是悄悄少给。
     * 拿 `rows` 与 `GET /api/dedupe-check?days=3` 的 `totals.articles` 对照即可。
     */
    window: { days: number; rows: number };
    /** 判组用的模型是否真的跑过。没跑说明本次只有链接/原文去重生效 */
    llmJudge: { ran: boolean; ok: boolean; groups: number[][]; error?: string };
    /** 逐条原因：丢了哪条、留下了哪条 */
    drops: Array<{ country: string; kept: string; dropped: string; reason: string }>;
  };
  /** 实际写入数据库的条数 */
  saved: number;
  /** 入库失败的原因。saved=0 时先看这个 —— 空数组才是「确实没有可入库内容」。 */
  insertErrors: string[];
  sourceCounts: Array<{
    source: string;
    country: string;
    fetched: number;
    afterDate: number;
    droppedJunk: number;
    droppedCountry: number;
    droppedTopic: number;
    candidates: number;
    /**
     * 归属国被改判的条数（`intl` 源的稿子被分给 5 国）。见 `resolveArticleCountry`。
     *
     * 口径：**判得出归属国**就 +1，因此它计入的是 `afterDate`，不是 `candidates` ——
     * 改判后仍可能在 `droppedTopic` 被丢掉。判不出归属国的那些进了 `droppedCountry`。
     * 目的：让「intl 那笔翻译钱花出去之后，稿子到底有没有流进 5 国」在 summary 里直接可见。
     */
    reassigned: number;
  }>;
  /**
   * 按国别汇总的采集漏斗 —— 回答「某国今天为什么只有 N 篇」看这里。
   * 逐字段含义见实现处的注释；要点是**四个环节分开计数**，因为修法互不相同。
   */
  funnelByCountry: Array<{
    country: string;
    sources: number;
    failedSources: number;
    fetched: number;
    afterDate: number;
    droppedJunk: number;
    droppedCountry: number;
    droppedTopic: number;
    candidates: number;
    /**
     * 同上；**只在本行（`intl`）有非零意义**。
     *
     * ⚠️ 这里按 `r.country`（= **源**的国别）分组，所以 intl 稿子改判到 uz 之后，
     * 那几条仍算在 `intl` 这一行里，**不会**出现在 `uz` 行。看「uz 今天为什么多/少了几条」
     * 时别忘了 intl 这行的贡献 —— 要拆到 5 国只能查库
     * （`country_code='uz'` 且 `source_name` 是 Times of Central Asia）。
     */
    reassigned: number;
  }>;
  sourceErrors: Array<{ source: string; errors: string[] }>;
  /** 翻译通道用量：哪个通道翻了几篇、失败通道的具体报错。
   *  「智谱免费档为什么没生效、全在走 DeepSeek 花钱」这个问题靠它一个 GET 就能回答。 */
  translation: {
    providerCounts: Record<string, number>;
    errors: Array<{ provider: string; model: string; error: string }>;
  };
}

/** 抓取任务的执行状态。见 GET /api/fetch-news 的说明。 */
interface FetchRunState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  summary: FetchSummary | null;
  error: string | null;
  /** 触发这次抓取时请求里带的 targetDate */
  targetDate: string | null;
}


// 投资相关性关键词与评分统一在 `@/lib/investment-score`。
//
// 这里原有**另一份**英文关键词表 + `isInvestmentRelevant` / `scoreInvestmentRelevance`，
// 与 `wechat/push` 里那份是同名同实现。当时两边都对，因为本文件跑在翻译**之前**
// （文本是英文/俄文原文），英文表在这里是有效的。
// 但 2026-09-21 发现 push 端那份在**中文**文本上完全失效 —— 同一个函数名落在
// 语言不同的两个阶段，是个结构隐患。所以合并到一份**跨语言**实现里，
// 两端共用，不再是「各写一套、碰巧一边对」。
//
// 迁移时行为不变：本阶段文本是英文，共用表里保留了全部原有拉丁词，
// 中文词在这里基本不会命中（源稿不是中文），属于纯增量。

// Telegram 频道的默认值与解析规则见 @/lib/telegram-channels：
// 格式 `国家:频道[@频道...]`，可用环境变量 TELEGRAM_CHANNELS 整体覆盖。
// 这些频道 id 均经 t.me/s/<id> 公开预览验证可读（微信云托管无法直连 Telegram，
// 必须经 Cloudflare Worker 代理读取，见 scraper.ts fetchTelegramRSS 的 Worker 优先路径）。

// 分类关键词
// （2026-09-19 移除 classifyCategory / CATEGORY_KEYWORDS：分类已改由 LLM 在翻译时判定，
//  见 translate.ts。旧实现拿英文关键词去匹配俄文/哈萨克文原文，永远匹配不上，
//  所有文章都落到默认的 economy —— 即「推送里分类全是经济」的根因。）

const COUNTRY_KEYWORDS: Record<string, string[]> = {
  kz: ['kazakhstan', 'kazakh', 'astana', 'almaty', 'kazakhstani', 'казахстан', 'астана', 'алматы', 'қазақстан', '哈萨克斯坦', '阿斯塔纳', '阿拉木图'],
  uz: ['uzbekistan', 'uzbek', 'tashkent', 'samarkand', 'uzbekistani', 'узбекистан', 'ташкент', '乌兹别克斯坦', '塔什干', '撒马尔罕'],
  kg: ['kyrgyzstan', 'kyrgyz', 'bishkek', 'kyrgyzstani', 'киргиз', 'бишкек', 'кыргызстан', '吉尔吉斯斯坦', '比什凯克'],
  tm: ['turkmenistan', 'turkmen', 'ashgabat', 'туркменистан', '土库曼斯坦', '阿什哈巴德'],
  tj: ['tajikistan', 'tajik', 'dushanbe', 'таджикистан', 'душанбе', '塔吉克斯坦', '杜尚别'],
  az: ['azerbaijan', 'azeri', 'baku', 'азербайджан', 'баку', '阿塞拜疆', '巴库'],
  intl: ['central asia', '中亚', 'silk road', 'belt and road', ' BRI', 'shanghai cooperation', 'каспий', 'caspian', 'south caucasus'],
};

// 「世界其它主要国家」的识别词（含中/英/俄常见形态，俄语用词干匹配屈折变化）。
// 用途：一条新闻如果**只**提到其它国家、完全没提目标国 → 与目标国无关，直接丢弃，
// 连翻译都不做（省钱）。这正是「哈萨克媒体转载尼日利亚矿难」混进推送的根因：
// 旧版的「其它国家」清单里只有中亚五国，尼日利亚根本不在里面，于是走了
// 「来源是该国媒体 → 默认相关」的兜底放行。
//
// 注意：提到第三国不等于无关（如「哈萨克斯坦与中国签署协议」标题里两国都有）——
// 判定顺序永远是「先看目标国是否出现」，出现了就放行。
const FOREIGN_COUNTRY_KEYWORDS: string[] = [
  // 英语
  'russia', 'russian', 'moscow', 'kremlin', 'putin',
  'china', 'chinese', 'beijing',
  'usa', 'united states', 'america', 'american', 'washington',
  'ukraine', 'ukrainian', 'kyiv',
  'nigeria', 'india', 'iran', 'iraq', 'israel', 'gaza', 'palestin',
  'turkey', 'turkish', 'ankara', 'pakistan', 'afghanistan',
  'germany', 'france', 'britain', 'british', 'london',
  'japan', 'tokyo', 'korea', 'seoul', 'vietnam', 'thailand',
  'saudi', 'emirates', 'qatar', 'egypt', 'brazil', 'mexico', 'argentina',
  'european union', 'eu ', ' nato',
  // 俄语（词干）。
  // ⚠️ 选词干时避开会撞车的：'газа' 同时是「天然气的二格」（能源新闻会误伤）、
  // 'анкер' 是「建筑锚栓」（基建新闻会误伤）、'инди' 会撞上「индикатор」。
  // 这些宁可漏放（后面还有 LLM 的 investorRelevant 把关），也不能误杀本国新闻。
  'росси', 'москв', 'кремл', 'путин',
  'кита', 'пекин',
  'сша', 'америк', 'вашингтон',
  'украин', 'киев',
  'нигери', 'индия', 'индии', 'индию', 'иран', 'ирак', 'израил', 'палестин',
  'турци', 'пакистан', 'афганистан',
  'германи', 'франци', 'британ', 'лондон',
  'япони', 'токио', 'коре', 'сеул', 'вьетнам', 'таиланд',
  'саудов', 'эмират', 'катар', 'египет', 'бразил', 'мексик', 'аргентин',
  'евросоюз', 'европейск',
  // 哈萨克语/吉尔吉斯语常用国名
  'қытай', 'ресей',
  // 中文
  '俄罗斯', '莫斯科', '中国', '北京', '美国', '华盛顿', '乌克兰',
  '尼日利亚', '印度', '伊朗', '伊拉克', '以色列', '土耳其', '巴基斯坦',
  '阿富汗', '德国', '法国', '英国', '日本', '韩国', '越南', '沙特', '阿联酋', '埃及',
];

// 明显与投资者无关的「垃圾标题」关键词（命中即跳过，翻译都不做，纯省钱）。
// 注意只匹配标题，且只要标题里同时出现强投资词（如 pipeline / gdp）就不拦。
const JUNK_TITLE_KEYWORDS = [
  'horoscope', 'weather forecast', 'crossword', 'recipe', 'celebrit', 'tv series',
  'football', 'soccer', 'hockey', 'boxing', 'match result', 'champion', 'tournament',
  'concert', 'festival of', 'beauty contest', 'fashion show', 'wedding',
  'гороскоп', 'погода', 'кроссворд', 'рецепт', 'футбол', 'хокке', 'бокс',
  'чемпионат', 'турнир', 'концерт', 'фестивал', 'свадьба', 'мода',
  'футбол', 'спорт', 'матч',
];

/**
 * 每个 Telegram 频道只取**最新**的多少条。
 *
 * Worker 返回的是 t.me 预览页上的最近 ~20 条（旧 → 新排序），不去限量的话
 * 12 个频道就是 ~240 条原文进候选池 —— 而抓取端**不做截断**（每篇候选都要
 * 单独跑一次 LLM 翻译，见下方 `const selected = selectedCandidates;` 处的说明），
 * 翻译费和一整轮耗时都会跟着翻几倍。取最新 8 条足够覆盖一天的增量。
 */
const TELEGRAM_MAX_PER_CHANNEL = 8;

/**
 * 把可能脏的日期字符串转成 Postgres **一定**接受的 ISO 串；解析不出来就用当前时间。
 *
 * 为什么必须有这层：published_at 直接来自各站的 pubDate 原文，格式五花八门。
 * 只要有一行的值 Postgres 不认，PostgREST 那条多行 INSERT **整条语句**失败，
 * 一批 100+ 篇全丢（2026-09-20 早报空推就是这个链路）。与其在入库失败后回退定位，
 * 不如在构造阶段就保证值一定合法 —— 日期不那么准，也比整批丢光强。
 */
function toSafeIso(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

// 判断新闻是否属于目标国家：
// 1. 标题/正文提到目标国（任何语言形态）→ 相关（含「本国+第三国」的复合新闻）；
// 2. 没提目标国，但明确提到**其它任何一个主要国家**（不限于中亚）→ 无关，丢弃；
// 3. 谁都没提（纯粹的国内新闻标题，如「政府批准了……」）→ 来源是该国媒体则放行，
//    intl 综合源则不放行（它没有「本国」可兜底）。
function isCountryRelevant(title: string, description: string, countryCode: string, sourceCountry: string): boolean {
  const text = `${title} ${description}`.toLowerCase();

  // 1. 目标国出现 → 相关
  const keywords = COUNTRY_KEYWORDS[countryCode] || [];
  if (keywords.some((kw) => text.includes(kw.toLowerCase()))) return true;

  // 2. 目标国没出现，但出现了其它主要国家 → 无关
  if (FOREIGN_COUNTRY_KEYWORDS.some((kw) => text.includes(kw))) return false;
  // 中亚邻国之间的归属判断（互斥国）
  for (const [otherCountry, ows] of Object.entries(COUNTRY_KEYWORDS)) {
    if (otherCountry === countryCode || otherCountry === 'intl') continue;
    if (ows.some((kw) => text.includes(kw.toLowerCase()))) return false;
  }

  // 3. 谁都没提：来源即该国媒体则默认相关；intl 综合源不放行
  //    （它没有「本国」可兜底 —— 区域综合源里不提任何本地区国家的全球新闻，对本项目无意义）
  if (sourceCountry === countryCode && countryCode !== 'intl') return true;
  return false;
}

/**
 * 可推送的国家清单 —— **「哪些国家会被推送」的唯一口径**，派生自 `countryList`，不要手写。
 *
 * ⚠️ 手写过一次，代价是**静默丢数据**：把 tm 换成 az 时漏改一份写死的清单，
 * 于是候选进了一个永远不被遍历的桶（见 `candidatesByCountry` 附近那段注释）。
 * 凡是「哪些国家会被推送」的判断，都必须派生自这里。
 */
const PUSHABLE_COUNTRY_CODES = countryList.map((c) => c.code);

/**
 * 判定一篇文章的**归属国**。
 *
 * - **非 `intl` 源**：归属国就是源自己的国家 —— 原样返回，行为逐字不变。
 * - **`intl` 源**（区域综合源，目前只有 The Times of Central Asia）：源本身没有「本国」，
 *   所以拿 `COUNTRY_KEYWORDS` 里**可推送国家**的词表扫正文，命中词数最多的那个就是归属。
 *   返回 `null` 表示判不出来（纯区域级泛新闻，如「中亚水资源危机」）。
 *
 * ## 为什么必须判，而不是沿用 `'intl'`
 *
 * `push` 是按 `countryList` 遍历、并按 `country_code` 列筛库的，
 * 所以 `country_code = 'intl'` 的稿子**永远推不出去** —— 翻译的钱照花，
 * 中文稿进库躺着没人看。2026-09-22 实测库里已积了 15 篇这种稿子，且仍在每天新增
 * （约 2–3 篇/轮 × 2 轮）。
 *
 * ## 为什么返回 `null` 时应当丢弃（而不是留成 intl）
 *
 * 本项目的产物是**5 份按国的报告**，没有「区域报告」这个出口。留成 `'intl'`
 * 等于把「白花钱」继续做下去。丢弃是诚实的：它会以 `droppedCountry` 的形式
 * 出现在 `funnelByCountry` 里，看得见、可归因。
 *
 * ⚠️ **只能在 `PUSHABLE_COUNTRY_CODES` 里选，不能拿 `COUNTRY_KEYWORDS` 的键当候选**——
 * 那张表里有 `tm`，而 tm 不在 `countryList` 里；判成 tm 会进一个不被遍历的桶、静默消失。
 * （这正是上面那段注释记的那次事故的同一形态。）
 */
function resolveArticleCountry(
  title: string,
  description: string,
  sourceCountry: string,
): string | null {
  if (sourceCountry !== 'intl') return sourceCountry;

  const text = `${title} ${description}`.toLowerCase();
  let best: string | null = null;
  let bestHits = 0;
  for (const code of PUSHABLE_COUNTRY_CODES) {
    const keywords = COUNTRY_KEYWORDS[code];
    if (!keywords) continue;
    // 命中词数最多的国家胜出；并列时按 PUSHABLE_COUNTRY_CODES 的顺序取先者
    // （顺序来自 countryList，是稳定顺序，所以同一篇稿子的判定可复现）。
    const hits = keywords.filter((kw) => text.includes(kw.toLowerCase())).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = code;
    }
  }
  return bestHits > 0 ? best : null;
}

// 标题是否明显是文体/生活类垃圾（不值得花翻译钱）
function isJunkTitle(title: string): boolean {
  const t = title.toLowerCase();
  return JUNK_TITLE_KEYWORDS.some((kw) => t.includes(kw));
}

// 检查新闻是否与投资主题相关（**入库闸门**，宽松兜底）。
//
// ⚠️ 用的是 `isInvestmentTopic` 而不是 `scoreInvestmentRelevance(...) > 0`：
// 后者用的是为**排序**精简过的加权词表（刻意去掉了 president/government/development
// 这类无区分力的词）。拿它当闸门 = 悄悄收紧入库条件，
// 而本项目历史上因判据过严出现过「每国不足 15 篇」。
// 闸门词表把 2026-09-21 之前的旧表**逐字保留**、只增不减，语义与改动前完全一致。
function isInvestmentRelevant(title: string, description: string): boolean {
  return isInvestmentTopic(`${title} ${description}`);
}

function extractTags(title: string, description: string): string[] {
  const text = `${title} ${description}`.toLowerCase();
  const tags: string[] = [];
  const tagKeywords: Record<string, string[]> = {
    '投资': ['invest', 'investor'],
    '能源': ['oil', 'gas', 'energy'],
    '矿产': ['mining', 'mineral', 'copper', 'gold'],
    '基建': ['railway', 'road', 'infrastructure', 'construction'],
    '政策': ['policy', 'reform', 'law', 'regulation'],
    '贸易': ['trade', 'export', 'import'],
    '外交': ['diplomat', 'summit', 'bilateral', 'agreement'],
  };
  for (const [tag, keywords] of Object.entries(tagKeywords)) {
    if (keywords.some((kw) => text.includes(kw))) {
      tags.push(tag);
    }
  }
  return tags.length > 0 ? tags : ['综合'];
}

// 从 HTML 内容中提取图片 URL
function extractImagesFromHtml(html: string): string[] {
  const imgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
  const images: string[] = [];
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    const url = match[1];
    if (url && !url.startsWith('data:') && !url.includes('pixel') && !url.includes('tracking')) {
      images.push(url);
    }
  }
  return images;
}

// 从文章原始 URL 获取 og:image 作为封面图（RSS 内容无图时的兜底）
async function fetchOgImage(url: string): Promise<string> {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return '';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!res.ok) return '';
      const html = await res.text();
      const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      if (ogMatch && ogMatch[1] && ogMatch[1].startsWith('http')) {
        return ogMatch[1];
      }
      return '';
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return '';
  }
}


// 上一轮抓取的状态。放在模块作用域：Next 的服务端路由与自定义服务器
// （src/server.ts）同进程，POST 和 GET 拿到的是同一份状态。
//
// 为什么需要它（2026-09-18 实测）：
// processFetchNews 是「立即返回、后台跑完」的，POST 在抓取真正开始前就回了 200。
// 调度器原本写的是 `await runFetchNews(); await runWechatPush()`，看着像串行，
// 实际上推送在抓取刚起步时就执行了 —— 读到的永远是上一轮的旧数据，
// 早报会把前一晚已经推过的新闻再推一遍。
// 现在调度器改成「触发 → 轮询 GET 到 running=false 且 finishedAt 变新 → 再推送」。
// 顺带解决第二个问题：抓取失败以前只写进容器日志（要进控制台才看得到），
// 现在一个 GET 就能拿到 summary / error，排查不用再猜。
// 实测抓取一轮要十几分钟（2026-09-18 手动触发后 9 分钟内库里一篇没多，
// 之后才陆续入库），所以调度器的等待上限不能设得太短。
let fetchRunState: FetchRunState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  summary: null,
  error: null,
  targetDate: null,
};

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as Record<string, string | number | boolean>;
  // 不传 date 时按北京时间取当天。别写 new Date().toISOString().split('T')[0]：
  // 那是 UTC 日期，北京 00:00–08:00 手动触发会抓到前一天，和推送的日期口径对不上。
  const targetDate = (body.date as string) || beijingDate();
  const minPerCountry = typeof body.minPerCountry === 'number' ? body.minPerCountry : 10;
  const skipTranslation = body.skipTranslation === true;

  // 同一时间只允许跑一轮：并发抓取会重复下载、重复调用翻译（又贵又慢），
  // 还可能在入库前去重的时间窗里塞进重复条目。
  if (fetchRunState.running) {
    return NextResponse.json({
      success: true,
      message: '上一轮抓取仍在进行，本次跳过（不重复触发）',
      running: true,
      startedAt: fetchRunState.startedAt,
      targetDate: fetchRunState.targetDate,
    });
  }

  const startedAt = new Date().toISOString();
  fetchRunState = {
    running: true,
    startedAt,
    finishedAt: null,
    durationMs: null,
    summary: null,
    error: null,
    targetDate,
  };

  // 立即返回，后台异步处理
  processFetchNews(targetDate, minPerCountry, skipTranslation)
    .then((summary) => {
      fetchRunState = {
        running: false,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(startedAt).getTime(),
        summary,
        error: null,
        targetDate,
      };
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('后台新闻抓取失败:', err);
      fetchRunState = {
        running: false,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(startedAt).getTime(),
        summary: null,
        error: message,
        targetDate,
      };
    });

  return NextResponse.json({
    success: true,
    message: '新闻抓取任务已启动，后台处理中',
    date: targetDate,
    minPerCountry,
    skipTranslation,
    startedAt,
  });
}

async function processFetchNews(
  targetDate: string,
  minPerCountry: number,
  skipTranslation: boolean,
): Promise<FetchSummary> {
  // 翻译通道用量统计归零（每轮独立），结束时读走写进 summary
  resetTranslationStats();

  // 每个源的采集情况。注意：这里只记录「取到多少 / 报了什么错」，
  // 真正的入库篇数在最后统一统计（旧版给每个源挂了 saved 字段但从不赋值，
  // 导致汇总日志永远打印「共保存0篇」，排查时严重误导）。
  //
  // ⚠️ 2026-09-22 补上**漏斗中间层**：`fetched`（feed 有多少条）与
  // `candidates`（真正进候选池几条）之间原来完全不可见，于是
  // 「某国今天怎么只有一篇」只能靠猜。实测代价：哈萨克的 5 个源抓到 200 条原始条目，
  // 但最后能进候选的极少，而接口只报 `fetched=200`，看不出是日期窗、文体垃圾、
  // 还是「提到了别的国家」把它们挡掉的 —— 这三条的修法完全不同，
  // 分不清就只能乱改判据（而本项目历史上「判据过严」已经导致过「每国不足 15 篇」）。
  const results: {
    source: string;
    /** 源所属国别（聚合口径用；一个源只属于一个国家） */
    country: string;
    fetched: number;
    /** 过了日期窗（目标日 ±1 天，UTC 日期）的条目数 */
    afterDate: number;
    /** 被 isJunkTitle 丢掉的（文体/生活类，不值得花翻译钱） */
    droppedJunk: number;
    /** 被 isCountryRelevant 丢掉的（在讲别的国家） */
    droppedCountry: number;
    /** 被 isInvestmentRelevant 丢掉的（与投资主题无关） */
    droppedTopic: number;
    /**
     * 归属国被**改判**的条数 —— 目前只可能来自 `intl` 源（见 `resolveArticleCountry`）。
     *
     * 不放进 `dropped*`：改判后的稿子是合格候选，只是换了国家。
     * 单列出来是为了回答「intl 源（The Times of Central Asia）的稿子最后流去了哪」——
     * 没有这个计数时，该源的 funnel 会显示 `candidates > 0`，
     * 而库里搜不到任何 `country_code='intl'` 的行，只能靠翻日志。
     */
    reassigned: number;
    errors: string[];
  }[] = [];

  /**
   * 建一条空的源采集记录。
   *
   * 用工厂函数而不是在每个 push 点手写对象字面量：RSS / Telegram 两条路径各写一份时，
   * 加字段必然漏一处 —— 而漏掉的那处会静默给出 0，看起来像「这个源没问题」。
   */
  function emptySourceResult(source: string, country: string) {
    return {
      source,
      country,
      fetched: 0,
      afterDate: 0,
      droppedJunk: 0,
      droppedCountry: 0,
      droppedTopic: 0,
      /** 归属国被改判的条数（仅 intl 源可能非零）—— 口径见 `results` 上的类型注释。 */
      reassigned: 0,
      errors: [] as string[],
    };
  }
  
  // 目标日期的前一天（用于放宽到最多 2 天时间窗）
  const targetDateMinusOne = new Date(new Date(`${targetDate}T00:00:00Z`).getTime() - 86400000)
    .toISOString().split('T')[0];
  console.log(`采集时间窗：${targetDateMinusOne} ~ ${targetDate}（最多回溯 2 天）`);
  
  // 按国家分组存储候选新闻。
  //
  // ⚠️ 这里刻意**不写死国家清单**，改成按需建键。
  // 写死清单的代价已经踩过一次：把 tm 换成 az 时漏了同步这个对象，于是
  // candidatesByCountry['az'] 是 undefined，`?.push()` 静默不执行 ——
  // 阿塞拜疆 6 个源采集到的候选被**全部无声丢弃**，日志里只表现为
  // 「投资相关 0 篇」，一点都不像出错。
  // 'intl' 同样从来没被列进去过，两个区域综合源的候选也一直在被丢；
  // 而且下面第 564 行是按 Object.entries 遍历的，没建过键的国别连后续流程都进不去。
  // 现在统一走 addCandidate / getCandidates —— RSS、爬虫、Telegram 三条路径行为一致
  // （Telegram 那条本来就自己做了懒创建，属于偶然写对，现已并入同一套写法）。
  const candidatesByCountry: Record<string, Candidate[]> = {};

  function addCandidate(country: string, candidate: Candidate) {
    (candidatesByCountry[country] ??= []).push(candidate);
  }

  function getCandidates(country: string): Candidate[] {
    return candidatesByCountry[country] ?? [];
  }

  console.log(`开始采集新闻，目标日期：${targetDate}，每个国家至少 ${minPerCountry} 篇`);

  // 第一步：从所有 RSS 源采集候选新闻
  for (const source of RSS_SOURCES) {
    const result = emptySourceResult(source.name, source.country);
    try {
      const { feed } = await fetchFeed(source.url);
      result.fetched = feed.items.length;
      // 注意：「HTML 被当成 feed」这类问题现在由 fetchFeed 抛错（错误信息带 Content-Type），
      // 所以走到这里 `fetched === 0` 只剩「feed 本身是空频道」这一种可能。
      // 不把它记成 error —— `failedSources` 的语义是「不通」，混进「通了但没稿」会让这个信号失真。

      // 筛选目标日期（放宽：目标日期及前 1 天，即最多回溯 2 天）的新闻
      const targetItems = feed.items.filter((item) => {
        if (!item.pubDate) return true;
        const parsed = new Date(item.pubDate);
        // 日期脏（俄语/中亚站点格式不规范很常见）不能让整个源挂掉。
        // 旧版这里直接 .toISOString()：遇到 Invalid Date 抛 "Invalid time value"，
        // 被外层 catch 记成「RSS 解析失败」，**整个源的新闻全丢**，而实际只是个别条目日期脏。
        if (Number.isNaN(parsed.getTime())) {
          // 顺手把脏日期清掉再放行：不清的话它会一路带到下面的 published_at，
          // Postgres 拒收非法时间戳会让**整批**入库失败 —— 比丢一篇严重得多。
          item.pubDate = undefined;
          return true;
        }
        const itemDate = parsed.toISOString().split('T')[0];
        return itemDate === targetDate || itemDate === targetDateMinusOne;
      });
      result.afterDate = targetItems.length;

      if (targetItems.length === 0) {
        results.push(result);
        continue;
      }

      // 对每篇新闻进行投资相关性评分和国家相关性检查
      let sourceCandidateCount = 0;
      for (const item of targetItems) {
        const title = item.title || '';
        const description = item.contentSnippet || item.content || '';

        // 文体/生活类标题直接丢弃 —— 翻译是要花钱的，垃圾不值得进 LLM
        if (isJunkTitle(title)) {
          result.droppedJunk++;
          continue;
        }

        // 归属国：**非 intl 源恒等于 `source.country`，行为逐字不变**；
        // intl 源按正文判（见 resolveArticleCountry）。
        // 判不出来 ⇒ 与任何一份报告都无关，丢弃 —— 计进 droppedCountry，让它在漏斗里看得见。
        const resolvedCountry = resolveArticleCountry(title, description, source.country);
        if (!resolvedCountry) {
          result.droppedCountry++;
          continue;
        }
        if (resolvedCountry !== source.country) result.reassigned++;

        // 检查是否与目标国家相关（含「其它主要国家」的排除逻辑）
        // ⚠️ 用**改判后的**国家来判，而不是 source.country —— 否则「一篇讲乌兹别克斯坦的
        //    intl 稿子」会拿 intl 的规则去评（intl 没有本国、规则 3 直接拒），等于白拿。
        if (!isCountryRelevant(title, description, resolvedCountry, source.country)) {
          result.droppedCountry++;
          continue; // 跳过与该国无关的新闻
        }

        // 检查是否与投资主题相关
        if (isInvestmentRelevant(title, description)) {
          const relevanceScore = scoreInvestmentRelevance(`${title} ${description}`);
          addCandidate(resolvedCountry, { item, source, relevanceScore });
          sourceCandidateCount++;
        } else {
          result.droppedTopic++;
        }
      }

      // 分母是「这个源贡献了多少候选」，所以不能再用 getCandidates(source.country) ——
      // intl 源的候选全部改判到 5 国去了，用源国别查恒为 0，会把日志误导成「一篇都没进」。
      console.log(`从 ${source.name} 采集 ${targetItems.length} 篇，其中投资相关 ${sourceCandidateCount} 篇`);
    } catch (err) {
      // `FeedFetchError` 的消息里已经带着 Content-Type / 状态码 / 逐 UA 尝试记录，
      // 直接透传即可 —— **不要再包一层只说「解析失败」的话**，那会把
      // 「拿到网页」误报成「XML 畸形」（2026-09-22 就是这么误诊的）。
      result.errors.push(
        err instanceof FeedFetchError
          ? `RSS 取回失败：${err.message}`
          : `RSS 取回失败：${err instanceof Error ? err.message : '未知错误'}`,
      );
    }
    results.push(result);
  }

  // （2026-09-19 移除「第一步半：网页爬虫补充」。那批 HTML 爬虫用的是通用猜测选择器，
  //  从来没有真正工作过 —— 2026-09-19 实测 19 个爬虫全部返回 0 条，每轮白跑 19 次
  //  网络请求还刷错误日志。失效的 RSS 源直接换成活的 RSS（见 RSS_SOURCES 注释），
  //  不再靠爬虫兜底。scraper.ts 保留：fetchTelegramRSS 还在用。）

  // 补充：通过 Cloudflare Worker 代理抓取 Telegram 频道（可选）
  // 配置 TELEGRAM_WORKER_URL（Worker 地址）与 TELEGRAM_CHANNELS（如 "kz:@channel1,kz:@channel2"）
  // 后才启用；未配置或请求失败时如实跳过，不伪造。
  const telegramWorkerUrl = process.env.TELEGRAM_WORKER_URL;
  const telegramChannelsRaw = process.env.TELEGRAM_CHANNELS || DEFAULT_TELEGRAM_CHANNELS;
  if (telegramWorkerUrl && telegramChannelsRaw) {
    console.log('开始通过 Cloudflare Worker 代理抓取 Telegram 频道...');
    // 解析规则（含 `@a@b` 展开成多个频道）见 lib/telegram-channels.ts。
    const channelEntries = parseTelegramChannels(telegramChannelsRaw);

    if (channelEntries.length === 0) {
      console.warn(`TELEGRAM_CHANNELS 解析后没有任何有效频道，原始值：${telegramChannelsRaw}`);
    } else {
      console.log(
        `Telegram 待抓取频道（共 ${channelEntries.length} 个）：${channelEntries.map((e) => `${e.country}:${e.channel}`).join('、')}`
      );
    }
    for (const { country, channel } of channelEntries) {
      // Telegram 的采集结果也记进 results，这样 sourceCounts / sourceErrors 里能看到它 ——
      // 否则「Telegram 到底通没通」只能去控制台翻日志，配完了从外面根本验证不了。
      const result = emptySourceResult(`Telegram/${channel}(${country})`, country);
      try {
        const outcome = await fetchTelegramRSS(channel);
        const fetchedPosts = outcome.articles;
        result.fetched = fetchedPosts.length;
        if (fetchedPosts.length === 0) {
          // 原样带出**真实原因**（HTTP 状态码 / 网络异常 / 频道不存在）。
          // 旧版这里写的是固定文案「Worker 返回 0 条」，把三种完全不同的故障
          // 说成同一件事，排查时只能靠猜 —— 2026-09-20 就因此多绕了一轮。
          result.errors.push(outcome.error || 'Telegram 未返回内容（原因未知）');
          results.push(result);
          continue;
        }
        // Worker 返回「旧 → 新」，取尾部 = 最新几条。见 TELEGRAM_MAX_PER_CHANNEL 的说明。
        const articles = fetchedPosts.slice(-TELEGRAM_MAX_PER_CHANNEL);
        const before = getCandidates(country).length;
        for (const article of articles) {
          const title = article.title || '';
          const description = article.summary || '';
          if (isJunkTitle(title)) continue;
          if (!isInvestmentRelevant(title, description)) continue;
          addCandidate(country, {
            item: {
              title,
              link: article.url,
              pubDate: article.publishedAt?.toISOString(),
              content: article.content || article.summary || '',
              contentSnippet: article.summary || '',
            },
            source: { name: `Telegram/${channel}`, url: article.url, country, language: 'en' },
            relevanceScore: scoreInvestmentRelevance(`${title} ${description}`),
          });
        }
        console.log(
          `[Telegram Worker] ${channel}(${country}) 拉到 ${fetchedPosts.length} 篇、取最新 ${articles.length} 篇，其中投资相关 ${getCandidates(country).length - before} 篇`
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Telegram 抓取失败：${msg}`);
        console.error(`[Telegram Worker] ${channel} 处理失败:`, msg);
      }
      results.push(result);
    }
  } else if (telegramChannelsRaw) {
    // 未配置 TELEGRAM_WORKER_URL：Telegram 通道不启用。
    // 也写进 sourceErrors —— 这样「Telegram 到底跑没跑」从 GET 就能看出来，
    // 不用去控制台翻日志（频道清单已在代码里有默认值，所以这条会一直出现直到配好 Worker）。
    console.log('检测到 TELEGRAM_CHANNELS 但未配置 TELEGRAM_WORKER_URL，跳过 Telegram 抓取');
    results.push({
      ...emptySourceResult('Telegram（未启用）', ''),
      errors: ['未配置 TELEGRAM_WORKER_URL，Telegram 频道未抓取。部署见 DEPLOY_WECHAT_CLOUD.md 的「Telegram 接入」'],
    });
  }

  // 第二步：每个国家精选至少 minPerCountry 篇新闻（见下方 for 的说明）
  const articlesToInsert: Array<{
    title: string;
    summary: string;
    content: string;
    country_code: string;
    category: string;
    source_name: string;
    source_url: string;
    original_title: string;
    original_content: string;
    original_language: string;
    published_at: string;
    tags: string[];
    is_featured: boolean;
    cover_image: string;
    image_urls: string[];
  }> = [];

  // 第二步：每个国家精选至少 minPerCountry 篇新闻
  //
  // 遍历的目标是**固定的国家清单**，不是 candidatesByCountry 的现有键。
  // 因为候选是按需建键的，某个国家一篇候选都没有时它压根不会有键 ——
  // 若按 Object.entries 遍历，这些国家会被整段跳过，连「用最新新闻兜底补充」
  // 都轮不到（kg / tj 常年就是靠兜底才有的文章，实测踩到过）。
  //
  // ⚠️ 2026-09-22 起这里**不再补 `'intl'`**。原因：intl 源的稿子已经在采集段按正文
  // 改判到 5 国之一（见 resolveArticleCountry），`'intl'` 不再是合法归属。
  // 留着它有两个坏处：① 这一轮会为空的 intl 桶再抓一遍 intl 源（白跑一次外网请求）；
  // ② 更糟的是兜底把结果推回 intl 桶、最后以 `country_code='intl'` 插进库 ——
  // 等于把刚修掉的「翻译了却永远推不出去」原样做回来。
  // 清单口径统一走 PUSHABLE_COUNTRY_CODES（派生自 countryList，见那个常量的注释）。
  for (const country of PUSHABLE_COUNTRY_CODES) {
    const candidates = getCandidates(country);
    // 如果投资相关新闻不足 minPerCountry 篇，用最新新闻补充
    const selectedCandidates = candidates;
    
    if (candidates.length < minPerCountry) {
      console.log(`${country} 投资相关新闻不足（${candidates.length}篇 < ${minPerCountry}篇），将用最新新闻补充`);
      // 重新从所有源获取最新新闻作为补充。
      // ⚠️ 补充也必须过同一套过滤（垃圾标题 + 国家相关性）——
      // 旧版这里什么都不检查，问候仪式、尼日利亚矿难这类「来源国媒体的无关内容」
      // 正是从这个口子混进库里的（它们没进第一轮候选，却被兜底捞了回来）。
      for (const source of RSS_SOURCES.filter(s => s.country === country)) {
        try {
          const { feed } = await fetchFeed(source.url);
          const latestItems = feed.items.slice(0, minPerCountry * 2); // 多取一些作为候选

          for (const item of latestItems) {
            // 避免重复
            const alreadyExists = candidates.some(c => c.item.link === item.link);
            if (alreadyExists) continue;

            const t = item.title || '';
            const d = item.contentSnippet || item.content || '';
            if (isJunkTitle(t)) continue;
            // ⚠️ 上面的 filter 保证 `source.country === country`（两者都在可推送清单里），
            // 所以这一行目前恒成立、属于防御性写法。留着是为了万一以后有人把 intl 源
            // 也放进兜底来源：那条路会让 intl 稿子以 `'intl'` 入库，
            // 而 `'intl'` 永远推不出去 —— 正是这次要修掉的问题（见 resolveArticleCountry）。
            if (resolveArticleCountry(t, d, source.country) !== country) continue;
            if (!isCountryRelevant(t, d, country, source.country)) continue;

            selectedCandidates.push({
              item,
              source,
              relevanceScore: 0, // 补充新闻评分为 0
            });
          }
        } catch (err) {
          // ⚠️ 这里**故意不写进 sourceErrors**：同一批源在第一轮已经报过一次，
          // 这里再记一次会把「同一批源报两遍」和「兜底这一轮才坏了」混在一起。
          // 但也**不能不吭声** —— 旧版是空的 `catch {}`，
          // 于是「兜底整段都失败」在 summary 里完全看不出来，只能靠人去数候选数。
          console.warn(
            `[兜底] ${country} 从 ${source.name} 补充抓取失败：`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    // 按相关性评分排序，有图片的新闻额外加权（公众号排版需要配图）
    selectedCandidates.sort((a, b) => {
      const aHasImage = (a.item.contentSnippet || a.item.content || '').includes('<img') ? 5 : 0;
      const bHasImage = (b.item.contentSnippet || b.item.content || '').includes('<img') ? 5 : 0;
      return (b.relevanceScore + bHasImage) - (a.relevanceScore + aHasImage);
    });

    // 抓取端不做截断：该国候选全部保留，最终推送多少篇由推送端「今日精选」（宽松上限 30 篇）决定。
    // （旧版写的是 slice(0, Math.max(minPerCountry, len))，恒等于不截断，但看起来像有限制，容易误判。）
    const selected = selectedCandidates;

    console.log(`${country} 候选 ${selected.length} 篇（其中投资相关 ${candidates.length} 篇，兜底补充 ${selected.length - candidates.length} 篇）`);

    for (const { item, source } of selected) {
      try {
        const originalTitle = item.title || '';
        const originalContent = item.contentSnippet || item.content || '';
        const tags = extractTags(originalTitle, originalContent);

        let titleZh = originalTitle;
        let summaryZh = originalContent.substring(0, 200);
        let contentZh = originalContent;
        // 分类优先用 LLM 的理解结果；LLM 没给出合法枚举值时才退回关键词粗分。
        // （旧版完全靠英文关键词匹配俄文/哈萨克文原文，永远匹配不上 →
        //  所有文章分类都落到默认的 economy，这就是「推送里全是经济」的根因。）
        let category = fallbackCategory(originalTitle, originalContent);

        // 提取图片：优先从内容中提取，其次从文章原始 URL 获取 og:image
        let imageUrls = extractImagesFromHtml(originalContent);
        // 干跑模式不取 og:image —— 那是一次外网请求/篇，而干跑只看采集量，
        // 图片既不入库也不用推送。跳过它能让「信息源体检」从十几分钟压到一两分钟。
        if (imageUrls.length === 0 && item.link && !skipTranslation) {
          const ogImage = await fetchOgImage(item.link);
          if (ogImage) imageUrls = [ogImage];
        }
        const coverImage = imageUrls[0] || '';

        if (!skipTranslation) {
          const translated = await translateNews(
            originalTitle,
            originalContent,
            source.language
          );

          // 翻译失败（结果非中文）则跳过该篇，绝不以原文入库，避免推送英文
          if (!translated.translated && !isChineseText(originalTitle)) {
            console.log(`跳过未翻译文章（保留原文不入库）：${originalTitle.substring(0, 40)}`);
            continue;
          }

          // LLM 判定「与国际投资者无关」（文体娱乐、生活方式、风俗礼节等）→ 不入库。
          // 这道闸 2026-09-19 才补上：LLM 一直在返回这个判断，旧代码却从未使用。
          if (translated.translated && !translated.investorRelevant) {
            console.log(`跳过与投资者无关的文章：${translated.titleZh.substring(0, 40)}`);
            continue;
          }

          titleZh = translated.titleZh || originalTitle;
          summaryZh = translated.summaryZh || originalContent.substring(0, 200);
          contentZh = translated.contentZh || originalContent;
          if (translated.category) category = translated.category;

          // 将封面图嵌入正文开头（绕开 cover_image 字段限制，网页端/公众号都能显示）
          if (coverImage) {
            contentZh = `<img src="${coverImage}" referrerpolicy="no-referrer" />\n\n${contentZh}`;
          }
        }

        articlesToInsert.push({
          title: titleZh || '无标题',
          summary: summaryZh,
          content: contentZh,
          // ⚠️ 用**桶的** `country`，不是 `source.country`。
          // 两者对 25 个普通源恒等（桶就是源国别），但 intl 源的稿子是被改判到 5 国的，
          // 写 `source.country` 会把它们全部落成 `'intl'` —— 而 `'intl'` 永远推不出去。
          // 这里写错是**静默**的：采集、翻译、入库、推送全都成功，只是那几篇没人看。
          country_code: country,
          category,
          source_name: source.name,
          source_url: item.link || '',
          original_title: originalTitle,
          original_content: originalContent,
          original_language: source.language,
          published_at: toSafeIso(item.pubDate),
          tags,
          is_featured: true, // 精选新闻都标记为 featured
          cover_image: coverImage,
          image_urls: imageUrls,
        });
      } catch (err) {
        console.error(`处理失败：${item.title?.substring(0, 30)}`, err);
      }
    }
  }

  // 第三步：去重并入库
  //
  // 三道闸，顺序不能换（都由 `lib/same-event.ts` 提供同一套判据，
  // 保证「入库时判重」与「选稿时判重」不会各自为政）：
  //   闸 1 批内身份去重    —— 纯内存，不可能失败
  //   闸 2 库内身份去重    —— 查询失败则**终止本轮入库**（见下方 fail-closed 说明）
  //   闸 3 「同一件事」理解 —— 模型判组，失败自动降级为只做闸 1、2
  //
  // 为什么要拆这么细：用户 2026-09-21 在草稿预览里截到一对「阿斯塔纳跨阿雷斯河新桥」
  // 的重复新闻，排查发现线上 200 篇里 4%（更早快照 22%）是 source_url 逐字相同的重复行。
  // 根因有两个：旧版把整个去重查询失败**静默吞成空集合**（于是全部当新文章入库），
  // 以及链接比较是逐字比较（`?from=rss`、末尾斜杠这类变形直接漏）。

  // —— 闸 1：批内身份去重（链接归一化 + 原文标题指纹）——
  const withinBatch: typeof articlesToInsert = [];
  let intraBatchDropped = 0;
  {
    const seenUrl = new Set<string>();
    const seenOrig = new Set<string>();
    for (const a of articlesToInsert) {
      const cu = canonicalUrl(a.source_url);
      const ok = originalTitleKey(a.original_title);
      if ((cu && seenUrl.has(cu)) || (ok && seenOrig.has(ok))) {
        intraBatchDropped++;
        continue;
      }
      if (cu) seenUrl.add(cu);
      if (ok) seenOrig.add(ok);
      withinBatch.push(a);
    }
  }
  if (intraBatchDropped > 0) {
    console.log(`批内去重剔除 ${intraBatchDropped} 篇（同一链接或同一篇原文）`);
  }

  // —— 闸 2：库内身份去重 ——
  //
  // 时间窗取 `DB_DEDUP_WINDOW_DAYS`（3 天），覆盖「同一条新闻今天和明天各被抓到一次」。
  // ⚠️ 这个窗口筛的是 `published_at`，**不是入库时间** ——
  // 所以「发布日期早于窗口」的稿子被重抓时，窗口里查不到它，会重复入库。
  // 这一点先不做改动，只用 `dedup.window.rows` 把窗口规模报出去，拿线上数据确认（见常量注释）。
  // 用**窗口查询**（两个时间界）而不是「拿本批几百条链接去反查」：
  // 后者的 `.in()` 会拼出一条几十 KB 的请求行，越过网关上限后整个查询失败 ——
  // 这正是线上重复入库的机制。
  //
  // **fail-closed**：库内去重查不出来时，本轮**不入库**。
  // 这条规则是有意的取舍：漏入库一条新闻，下一轮抓取还能补回来（可恢复）；
  // 而重复入库会直接进草稿推给读者，**不可撤销**。
  let existingUrls = new Set<string>();
  let existingOriginals = new Map<string, number>();
  let dbCheckError: string | null = null;
  /** 闸 2 窗口查询实际拿到的**行数**（= 窗口内去重前的规模，报给接口用于发现静默截断） */
  let dbWindowRows = 0;
  try {
    const since = new Date(Date.now() - DB_DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    existingUrls = await getRecentCanonicalUrls(since);
    existingOriginals = await getRecentOriginalTitleKeys(since);
    dbWindowRows = existingUrls.size;
    console.log(
      `库内近 ${DB_DEDUP_WINDOW_DAYS} 天已有 ${existingUrls.size} 个链接、${existingOriginals.size} 个原文指纹`,
    );
  } catch (dbErr) {
    dbCheckError = dbErr instanceof Error ? dbErr.message : String(dbErr);
    console.error(`库内去重查询失败，本轮放弃入库（宁可漏采也不重复）：${dbCheckError}`);
  }

  let urlDropped = 0;
  const newArticles = dbCheckError
    ? []
    : withinBatch.filter((a) => {
        const cu = canonicalUrl(a.source_url);
        const ok = originalTitleKey(a.original_title);
        const dup = (cu && existingUrls.has(cu)) || (ok && existingOriginals.has(ok));
        if (dup) urlDropped++;
        return !dup;
      });
  console.log(`链接/原文去重后剩余 ${newArticles.length} 篇新文章（剔除 ${urlDropped} 篇）`);

  // —— 闸 3：「同一件事」理解 ——
  // 按国家分组，逐国判组。**不能跨国家合并**：推送是按国别生成草稿的，
  // 同一件事出现在两个国家频道里是预期行为，不是重复。
  const contentDeduped: typeof newArticles = [];
  const eventDrops: Array<{ country: string; kept: string; dropped: string; reason: string }> = [];
  const llmJudge: { ran: boolean; ok: boolean; groups: number[][]; error?: string } = {
    ran: false, ok: false, groups: [],
  };
  {
    const byCountry = new Map<string, typeof newArticles>();
    for (const a of newArticles) {
      const key = a.country_code || 'intl';
      const list = byCountry.get(key);
      if (list) list.push(a);
      else byCountry.set(key, [a]);
    }

    for (const [cc, list] of byCountry) {
      const { kept, drops, llm } = await dedupeStories(list);
      contentDeduped.push(...kept);
      if (llm.ran) {
        llmJudge.ran = true;
        llmJudge.ok = llm.ok;
        llmJudge.error = llmJudge.error || llm.error;
        llmJudge.groups.push(...llm.groups);
      }
      for (const d of drops) {
        eventDrops.push({ country: cc, kept: d.kept.title, dropped: d.dropped.title, reason: d.reason });
      }
    }
  }
  if (eventDrops.length > 0) {
    console.log(
      `内容级去重剔除 ${eventDrops.length} 篇重复，剩余 ${contentDeduped.length} 篇｜逐条原因：\n` +
        eventDrops.map((d) => `  [${d.country}][${d.reason}] 丢「${d.dropped}」← 保留「${d.kept}」`).join('\n'),
    );
  }
  if (llmJudge.error) {
    console.warn(`「同一件事」模型判组未生效，本轮只做了链接/原文去重：${llmJudge.error}`);
  }

  // skipTranslation（干跑模式）**只统计、不入库**。
  //
  // 为什么必须在这里拦住：这个模式跳过了翻译，走到这一步的 title / content 还是原文
  // （俄语、哈萨克语、阿塞拜疆语…），直接 insertArticles 会把整批非中文内容写进生产库，
  // 而推送端会照单全收、把它们推给读者。
  // 旧版这里没有判断 —— 也就是 `skipTranslation: true` 实际是「把未翻译内容灌进生产库」，
  // 完全不是它名字暗示的「安全试跑」。现在它是一次**信息源体检**：
  // 跑完看 summary.sourceCounts / sourceErrors 就能知道每个源通不通、抓到几条。
  let savedCount = 0;
  let insertErrors: string[] = [];
  if (skipTranslation) {
    console.log(`skipTranslation=true：干跑模式，跳过入库（本可入库 ${contentDeduped.length} 篇）`);
  } else if (dbCheckError) {
    // fail-closed 的落点：库内去重没查成，就不入库。
    // 必须写进 insertErrors —— 否则接口返回的 saved=0 与「本轮确实没有可入库内容」
    // 长得一模一样，排查只能靠猜（2026-09-20 已经踩过一次这个坑）。
    insertErrors = [`库内去重查询失败，本轮放弃入库（宁可漏采也不重复入库）：${dbCheckError}`];
  } else if (contentDeduped.length > 0) {
    try {
      const insertResult = await insertArticles(contentDeduped);
      savedCount = insertResult.inserted;
      insertErrors = insertResult.errors;
      console.log(`成功保存 ${savedCount}/${contentDeduped.length} 篇到数据库`);
      if (insertErrors.length > 0) {
        console.warn(`入库未全部成功，前几条原因：${insertErrors.slice(0, 3).join(' | ')}`);
      }
    } catch (insertErr) {
      // 不再只打日志：把原因写进 summary，否则接口返回的 saved=0 与
      // 「本轮确实没有可入库内容」长得一模一样，排查只能靠猜（2026-09-20 踩过）。
      const message = insertErr instanceof Error ? insertErr.message : String(insertErr);
      insertErrors = [message];
      console.error('插入数据库失败:', message);
    }
  }

  const totalFetched = results.reduce((sum, r) => sum + r.fetched, 0);
  const failedSources = results.filter((r) => r.errors.length > 0);

  console.log(
    `新闻抓取完成：日期=${targetDate}｜原始采集 ${totalFetched} 篇 → 投资相关候选 ${articlesToInsert.length} 篇 ` +
      `→ 批内去重剔除 ${intraBatchDropped} 篇 ` +
      `→ 链接/原文去重剔除 ${urlDropped} 篇 ` +
      `→ 同事件去重剔除 ${eventDrops.length} 篇 ` +
      `→ 实际入库 ${savedCount} 篇`
  );
  console.log(`各源采集量：${results.map((r) => `${r.source}=${r.fetched}`).join(' | ')}`);
  // 按国别打一行漏斗 —— 排查「某国今天为什么只有 N 篇」时，先看这一行再看逐源明细。
  console.log(
    '各国采集漏斗（feed 条目 → 过日期窗 → 丢文体/丢别国/丢非投资 → 候选）：\n' +
      [...new Set(results.map((r) => r.country).filter(Boolean))].sort().map((cc) => {
        const rs = results.filter((r) => r.country === cc);
        const s = (f: (r: (typeof rs)[number]) => number) => rs.reduce((a, r) => a + f(r), 0);
        const fetched = s((r) => r.fetched);
        const afterDate = s((r) => r.afterDate);
        const j = s((r) => r.droppedJunk);
        const c = s((r) => r.droppedCountry);
        const t = s((r) => r.droppedTopic);
        return `  [${cc}] ${fetched} → ${afterDate} → 丢文体 ${j} / 丢别国 ${c} / 丢非投资 ${t} → 候选 ${afterDate - j - c - t}`;
      }).join('\n')
  );
  if (failedSources.length > 0) {
    console.warn(`${failedSources.length} 个信息源采集失败：${failedSources.map((r) => r.source).join('、')}`);
  }

  const translation = getTranslationStats();
  const translationProviders = Object.entries(translation.providerCounts)
    .map(([name, count]) => `${name}=${count}`).join(' | ') || '无成功翻译';
  console.log(`翻译通道用量：${translationProviders}`);
  if (translation.errors.length > 0) {
    console.warn(
      `翻译通道报错：${translation.errors.map((e) => `${e.provider}(${e.model}): ${e.error}`).join('；')}`
    );
  }

  return {
    date: targetDate,
    totalFetched,
    candidates: articlesToInsert.length,
    // 去重分三段记账，别再合成一个数字：三段失败原因完全不同，
    // 合成后「今天为什么少了几篇」就查不出来了。
    dedup: {
      /** 批内链接/原文重复（同一轮里同一条被抓到两次） */
      intraBatch: intraBatchDropped,
      /** 与库内近 3 天重复（跨轮重复，线上重复行的主要来源） */
      againstDb: urlDropped,
      /** 「同一件事」判组剔除（表述不同、事件相同） */
      sameEvent: eventDrops.length,
      /** 库内去重查询失败 → 本轮放弃入库时的原因，正常为 null */
      dbCheckError,
      /**
       * 闸 2 那次窗口查询**实际拿到多少行**。
       *
       * 必须报出来，否则「窗口是不是被静默截断」在线上无法判断：
       * `getRecentCanonicalUrls` 是单次 `.limit(5000)`、**没有分页**，
       * 而 PostgREST 的返回条数上限通常是 1000（服务端配置），
       * **超限时不报错、只是悄悄少给**（同一个坑 `getArticleIdentities` 的注释里已经写过）。
       * 判读：拿 `window.rows` 和 `GET /api/dedupe-check?days=3` 的 `totals.articles` 对照 ——
       * 两者应当接近；若 `window.rows` 恰好卡在某个整数上限（1000/5000）且明显偏小，
       * 就是被截断了，此时闸 2 形同虚设。
       */
      window: { days: DB_DEDUP_WINDOW_DAYS, rows: dbWindowRows },
      /** 判组用的模型是否真的跑过；没跑说明只是链接/原文去重生效 */
      llmJudge,
      /** 逐条原因，便于直接看出「丢了哪条、留下了哪条」 */
      drops: eventDrops.slice(0, 50),
    },
    afterUrlDedup: newArticles.length,
    afterContentDedup: contentDeduped.length,
    saved: savedCount,
    insertErrors,
    sourceCounts: results.map((r) => ({
      source: r.source,
      country: r.country,
      fetched: r.fetched,
      afterDate: r.afterDate,
      droppedJunk: r.droppedJunk,
      droppedCountry: r.droppedCountry,
      droppedTopic: r.droppedTopic,
      /** 进入候选池的条数（= afterDate − 三个丢弃原因） */
      candidates: r.afterDate - r.droppedJunk - r.droppedCountry - r.droppedTopic,
      /** 归属国被改判的条数（仅 intl 源可能非零，见 `resolveArticleCountry`） */
      reassigned: r.reassigned,
    })),
    /**
     * 按国别汇总的漏斗 —— **回答「某国今天为什么只有 N 篇」看这里，不要看 sourceCounts**。
     *
     * 口径：feed 条目 → 过日期窗 → 文体垃圾 / 讲别国 / 非投资 → 候选池。
     * 四个环节的失败修法完全不同，所以必须分开计数（与 `dedup` 分三段记账同一个理由）：
     *   · `afterDate` 偏小   → 源在这个时段本来就没发稿，或 feed 只保留很少条目
     *     （Astana Times 的 feed 只有 10 条，等于只覆盖最近一两天；别的源有 100 条）
     *   · `droppedCountry` 偏大 → `isCountryRelevant` 里「提到了任何一个其它目标国就丢」
     *     这条互斥规则在该国身上过敏（中亚当地区新闻极易同时提到邻国）
     *   · `droppedTopic` 偏大  → 入库闸门词表对该国**语言**覆盖不足（如哈萨克语源）
     *   · `fetched=0` 且 `sourceErrors` 有值 → 源本身不通（网络超时 / XML 畸形）
     *
     * ⚠️ `candidates` 是**入库前**的候选数：不减去批内去重与库内重复，
     * 也不等于最终入库数（那要看 `candidates` / `afterUrlDedup` / `saved` 三段）。
     */
    funnelByCountry: [...new Set(results.map((r) => r.country).filter(Boolean))]
      .sort()
      .map((cc) => {
        const rs = results.filter((r) => r.country === cc);
        const fetched = rs.reduce((a, r) => a + r.fetched, 0);
        const afterDate = rs.reduce((a, r) => a + r.afterDate, 0);
        const droppedJunk = rs.reduce((a, r) => a + r.droppedJunk, 0);
        const droppedCountry = rs.reduce((a, r) => a + r.droppedCountry, 0);
        const droppedTopic = rs.reduce((a, r) => a + r.droppedTopic, 0);
        const reassigned = rs.reduce((a, r) => a + r.reassigned, 0);
        return {
          country: cc,
          sources: rs.length,
          /** 采集失败的源数（带错误的那些）—— `fetched=0` 但不带错误的不算失败 */
          failedSources: rs.filter((r) => r.errors.length > 0).length,
          fetched,
          afterDate,
          droppedJunk,
          droppedCountry,
          droppedTopic,
          candidates: afterDate - droppedJunk - droppedCountry - droppedTopic,
          reassigned,
        };
      }),
    sourceErrors: failedSources.map((r) => ({ source: r.source, errors: r.errors })),
    translation: {
      providerCounts: translation.providerCounts,
      errors: translation.errors,
    },
  };
}

export async function GET() {
  return NextResponse.json({
    message: '新闻采集接口',
    usage: 'POST /api/fetch-news with optional { date: "YYYY-MM-DD", minPerCountry: 10, skipTranslation: true }',
    // skipTranslation=true 是**信息源体检的干跑模式**：只采集、不入库、不调用翻译，
    // 跑完读下面的 lastRun.summary.sourceCounts / sourceErrors 就知道每个源通不通。
    // 想确认 Telegram 通没通、某个 RSS 源是不是死了，用这个模式，几分钟出结果且零成本。
    dryRunHint: 'POST {"skipTranslation": true} 可做零成本的信息源体检（只采集不入库）',
    sources: RSS_SOURCES.map((s) => ({ name: s.name, country: s.country })),
    // 上一轮抓取的状态。调度器靠 running / finishedAt 判断「抓完了没」；
    // 人工排查时 summary 里有各源采集量与最终入库数，error 是失败原因。
    lastRun: fetchRunState,
  }, {
    // 必须禁掉缓存：调度器轮询这个接口等状态变化，被缓存住就会一直看到旧状态，
    // 表现为「干等到超时」。
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
