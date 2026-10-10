import { NextRequest, NextResponse } from 'next/server';
import { insertArticles, getRecentCanonicalUrls, getRecentOriginalTitleKeys, getRecentTitlesByCountry } from '@/lib/db-articles';
import { fetchTelegramRSS } from '@/lib/scraper';
import { isChineseText, beijingDate, canonicalUrl, originalTitleKey, similarity } from '@/lib/utils';
import { dedupeStories, isSameTitleText } from '@/lib/same-event';
import {
  isDedupBeforeTranslateEnabled,
  dedupPreWindowDays,
} from '@/lib/dedup-before-translate';
import { scoreInvestmentRelevance, isInvestmentTopic } from '@/lib/investment-score';
import { countryList } from '@/lib/data/countries';
import { RSS_SOURCES, type RSSSource } from '@/lib/data/rss-sources';
import { fetchFeed, FeedFetchError, type FeedItem } from '@/lib/feed-fetch';
import {
  fetchArticleBody,
  needsBodyFetch,
  BODY_FETCH_GAP_MS,
  MIN_SOURCE_BODY_CHARS,
} from '@/lib/article-body';
import { translateNews, resetTranslationStats, getTranslationStats, fallbackCategory } from '@/lib/translate';
import {
  PROPER_NOUN_VERSION,
  termGateProbe,
  TERM_GATE_PROBE_EXPECT,
} from '@/lib/proper-nouns';
import { isCountryRelevant, selfKeywordsFor } from '@/lib/country-relevance';
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
  /**
   * 通过投资相关性初筛的条数（走到翻译循环、并已过兜底/正文补全的那些）。
   *
   * ⚠️ `DEDUP_BEFORE_TRANSLATE=1` 时**不含**被翻译前跳过的那批 ⇒
   * 开关打开后这个数会**恰好比关闭时少 `dedup.skippedBeforeTranslate` 篇**。
   * 这是「开关确实起了作用」的读数，不是缺陷（想还原可比口径就加上那个数）。
   */
  candidates: number;
  /** URL 去重后剩余 */
  afterUrlDedup: number;
  /** 库内中译标题去重后剩余（2026-09-24 加的闸 2 之二） */
  afterTitleDedup: number;
  /** 内容级去重后剩余 */
  afterContentDedup: number;
  /**
   * 去重分四段记账。**别再合成一个数字**：四段失败的排查方向完全不同
   * （批内重复 = 抓取重复拉取；跨轮链接/原文 = 库内判重失效；跨轮标题 = 同一件事隔轮到达；
   * 同事件 = 理解机制漏判），合成之后就再也回答不了「今天为什么少了几篇」。
   *
   * `skippedBeforeTranslate`（2026-10-10 加）**不是第五个阶段**，而是闸 2 的
   * 「链接/原文」那一半被**提前执行**了（提前到翻译之前）—— 所以它归在本组记账，
   * 但它与 `againstDb` 的互斥关系必须按那个字段自己的说明读。
   */
  dedup: {
    /** 批内链接/原文重复（同一轮里同一条被抓到两次） */
    intraBatch: number;
    /** 与库内近 3 天重复（跨轮重复，线上重复行的主要来源） */
    againstDb: number;
    /**
     * ⏱ **翻译前**就按库内身份丢掉、因而**没花翻译费**的条数（2026-10-10 加）。
     *
     * 只在 `DEDUP_BEFORE_TRANSLATE=1` 时非零。动机（实测 `againstDb = 85` ⇒ 约
     * 52 分钟/轮白翻）与「为什么不改变输出集合」的证明都在 `@/lib/dedup-before-translate`。
     *
     * ⚠️ 它是 `againstDb` 的**上游**：被提前丢掉的条子压根没被翻译、没进
     * `articlesToInsert` ⇒ **不会**再出现在 `againstDb` 或 `intraBatch` 里。
     * 所以「本轮有多少条是库内重复」= `skippedBeforeTranslate + againstDb`
     * （两者互斥，可以相加）；而单独盯任一个的**趋势**会在开关前后跳变 ——
     * 那不是重复变多变少，只是记账位置变了。
     */
    skippedBeforeTranslate: number;
    /**
     * 本轮「翻译前去重」这条路**走没走**、以及为什么（2026-10-10 加）。
     *
     * 加它的理由：只有 `skippedBeforeTranslate` 一个数时，「开关开着而它是 0」
     * 与「本轮确实没有库内重复」**完全同形** —— 而事后复盘时这恰恰最容易被读反。
     * 三个字段合起来才是完整的因果：`switch` 是意图、`windowDays` 是约束、`active` 是事实。
     *
     * （`GET /api/fetch-news` 的 `knobs.dedupBeforeTranslate` 是它在**开跑之前**的对应物。）
     */
    beforeTranslate: {
      /** 环境变量 `DEDUP_BEFORE_TRANSLATE` 的解析值（**默认关**）。 */
      switch: boolean;
      /** 本轮是否真的执行了前置跳过。干跑恒为 `false`（干跑不翻译 ⇒ 没有「白翻」可省）。 */
      active: boolean;
      /** 前置窗口（天）；`null` ⇒ 这份配置下不存在安全更窄窗口，按设计关掉。 */
      windowDays: number | null;
    };
    /**
     * 与库内近 3 天**中译标题**近逐字相同（跨轮「同一件事」，2026-09-24 加）。
     * 判据与闸 3 `same_title` 同一条（`isSameTitleText`），但作用于入库前，
     * 所以它拦下的行**库里没有** —— 想知道拦了什么看 `titleDrops` 或日志。
     */
    againstDbTitles: number;
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
     * `titleRows` 是闸 2 之二（中译标题窗口，筛 `created_at`）的行数，同一个判读法。
     */
    window: { days: number; rows: number; titleRows: number };
    /** 判组用的模型是否真的跑过。没跑说明本次只有链接/原文去重生效 */
    llmJudge: { ran: boolean; ok: boolean; groups: number[][]; error?: string };
    /** 标题去重逐条明细（保留行 id + 相似度）—— 上线首日复核就看这个 */
    titleDrops: Array<{ country: string; keptId: number; kept: string; dropped: string; sim: number }>;
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
    /**
     * 术语闸（2026-10-05 加）。**这不是性能指标，是丢稿预警** ——
     * 它是一道硬闸，命中 ⇒ 重试 ⇒ 三次不过丢稿（见 `translate.ts` 的 `TranslationStats.termGate`）。
     */
    termGate: {
      tableVersion: string;
      currency: number;
      wrongNoun: number;
      dropped: number;
      samples: Array<{ kind: 'currency' | 'wrong-noun'; detail: string }>;
      dropSamples: string[];
      probe: string;
      expected: string;
    };
  };
  /**
   * 阶段计时（2026-10-10 加）。**这是决策数据，不是性能装饰。**
   *
   * 只报一项：`translateNews` 的墙钟时间之和。选它是因为两个悬而未决的问题都取决于它 ——
   *   ① **该不该给翻译加并发**（第 2 步）：并发只省「等在网络上」的那部分，
   *      省不到「真在算」的那部分。不先量出这个比例，加并发就是拍脑袋。
   *   ② **降规格会不会把轮次推过 400 分钟硬上限**：CPU 砍半只有在「轮次是 CPU 受限」
   *      时才会让耗时翻倍。若时间其实花在等 API，那降规格的代价就小得多。
   *
   * ⚠️ 它顺带能解掉一个**看起来矛盾**的现象：容器长时间贴 ~100% CPU，
   * 但单篇翻译若只花十几秒，CPU 就不该是瓶颈。到底是「等 API」还是「真在算」，
   * 这个数一出来就分得清（判读见下面那行日志的注释）。
   */
  timing: {
    /** 所有 `translateNews` 调用的墙钟时间之和（含重试与降级链的全部等待） */
    translationMs: number;
    /** 实际发起过翻译的文章篇数 —— 用来算「秒/篇」，与 `MEASURED_WORST_PER_ARTICLE_MS` 对照 */
    translatedArticles: number;
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

// 本国词 / 区域词 / 外国词 —— **都已挪到 `@/lib/country-relevance`**（2026-10-05）。
//
// 这里原先有两份私有清单：`COUNTRY_KEYWORDS`（119 条）与 `FOREIGN_COUNTRY_KEYWORDS`。
// 它们与推送侧 `article-format.ts` 的清单**内容不同**、靠人肉同步 ——
// 于是 2026-10-04 用户又报了一次「阿塞拜疆频道出现和土耳其完全没关系的土耳其新闻」：
// 采集侧有 `土耳其`、推送侧没有，中文标题里明写「土耳其」也照样推出去。
//
// 这是同一个判据「两处各写一份」造成的第五次事故，所以这次是**合一**而不是补齐。
// 词表、判定顺序、兜底全在 `@/lib/country-relevance` 一处定义。
//
// ⚠️ **别在这里重新建清单。** 要加词就改那个文件，它带着
// `FOREIGN_CONCEPT_CHECKLIST` 与 `scripts/test-country-relevance.ts` 的断言。

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
    // ⚠️ 2026-10-05 起从 `@/lib/country-relevance` 取词（`countryCode='ingest'` 侧），
    // 不再读本文件里那份私有清单 —— 那份清单缺一堆拉丁城市名
    // （`balkhash`/`atyrau`/`karaganda`…），而 intl 源恰恰是**英文**的，
    // 缺的正是最该用的那批词。
    const keywords = selfKeywordsFor(code, 'ingest');
    if (keywords.length === 0) continue;
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

/**
 * 正文补抓 —— RSS 只给了标题时，去文章页把正文取回来。
 *
 * 返回**可以拿去翻译的正文**；返回 `null` 表示「这条拿不到正文」，
 * 调用方必须**丢弃它**，不许继续走翻译。
 *
 * ## 为什么返回 null 就一定要丢（2026-10-02 实测的根因）
 *
 * 实测 az 的 AZERTAC(en/ru)、Trend.az、APA、Qafqazinfo 这 5 个源的 RSS
 * **一个字的正文都没有**（uz 的 Uznews.uz、Podrobno.uz 同样）。
 * 旧代码对这种情况的处理是：`originalContent = ''` 然后**照样翻译** ——
 * 于是模型照着标题编了一整篇。库里实存 `id 8766`（APA）写着
 * 「…阿塞拜疆政府尚未对贝森特的指责做出正式回应」，原文里根本没有这句；
 * `id 8765` 同一句重复两遍；`id 8740` 结尾直接是标题的回声。
 *
 * 而且这**不是提示词能救的**：总审的第七件事（与原文核对）拿到的是空原文，
 * 结构性失明 —— 阿塞拜疆线上 `originalsSeen 4/15` 就是这么来的。
 *
 * ## 为什么要把计数交给调用方
 *
 * `bodyBackfilled` / `droppedNoBody` 是**漏斗字段**，归调用方的 `result` 管。
 * 这里只做「取回」这一件事，保持无状态 —— 这样 RSS 与 Telegram 两条路径
 * 共用同一份实现，不会各写一份然后分叉（这个项目已经栽过三次同样的跟头）。
 */
async function backfillBody(
  description: string,
  link: string | undefined,
): Promise<{ text: string; backfilled: boolean } | null> {
  if (!needsBodyFetch(description)) return { text: description, backfilled: false };
  const body = await fetchArticleBody(link || '');
  // 同一台站之间喘一口气：azertag 那类被 Cloudflare 罩着的站点，
  // 连打会在几秒内把后面全部打成 403（见 article-body.ts 的对照实验）。
  await new Promise((r) => setTimeout(r, BODY_FETCH_GAP_MS));
  if (!body.ok) return null;
  return { text: body.text, backfilled: true };
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
     * 因为「RSS 没给正文、去抓原文页也没抓到」而丢弃的条数（2026-10-02 新增）。
     *
     * 为什么要丢而不是硬推：正文为空时翻译**照跑**，模型只能照着标题编一整篇。
     * 库里实存 `id 8766`（APA）写着「阿塞拜疆政府尚未对贝森特的指责做出正式回应」
     * —— 原文里根本没有这句。宁可不推，也不推一段编出来的东西。
     *
     * ⚠️ 这个数**偏大不是坏事**：它说明补正文没成功，要先去看源站是不是挡了我们
     * （对照 `bodyBackfilled`：为 0 而它很大 ⇒ 源站在挡，例如 azertag 的 Cloudflare）。
     */
    droppedNoBody: number;
    /** 靠抓原文页把正文补回来的条数。与 `droppedNoBody` 成对看：补回多少、丢了多少。 */
    bodyBackfilled: number;
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
   *
   * ⚠️ 字段口径（含 `droppedNoBody` / `bodyBackfilled` 的完整说明）写在 `results`
   * 的类型声明上，这里**不重复** —— 两处各写一份必然漂移，而漂移的表现是
   * 「同一个数在两处含义不同」，看日志的人不会发现。
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
      /** 口径见 `results` 的类型声明（含「偏大不是坏事」那段）。 */
      droppedNoBody: 0,
      bodyBackfilled: 0,
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

  // ⏱ 翻译阶段计时累加器（2026-10-10 加，见 `FetchSummary.timing` 的说明）。
  //
  // ⚠️ **刻意只做「累加」，不碰任何控制流。** 明早 04:00 那一轮是「合并成一轮日报」
  // 的第一次真实试跑（而且实例保活也刚从常驻改成窗口钉住），**不能再往上加变量**。
  // 纯 `+=` 不可能改变一轮的成败，但它能把两个悬着的问题变成可算的。
  //
  // 为什么非要加代码而不能直接读日志：翻译是**逐国交错在采集之间**的
  // （每国：采集 → `候选 N 篇` → 翻译该国 → 下一国），所以任意两行日志之间的
  // 间隔都是「某国翻译 + 下一国采集」的混合，读不出翻译单独占多少。
  let translationMs = 0;
  let translatedArticles = 0;
  /** 本函数的墙钟起点，只用来算「翻译占多少百分比」。见下面那行日志。 */
  const runStartedMs = Date.now();

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
        if (!isCountryRelevant({ title, summary: description, countryCode: resolvedCountry, sourceCountry: source.country })) {
          result.droppedCountry++;
          continue; // 跳过与该国无关的新闻
        }

        // 检查是否与投资主题相关
        if (!isInvestmentRelevant(title, description)) {
          result.droppedTopic++;
          continue;
        }

        // 正文补抓 —— 放在最后一道筛之后：前面被丢掉的稿子不值得为它打一次外网请求。
        //
        // 顺序也是有讲究的：`resolveArticleCountry` / `isCountryRelevant` 在正文为空时
        // 只能拿标题判，判得比有正文时粗。但那两道筛的误判方向是**偏严**（宁可丢），
        // 所以先筛后补正文 → 最坏是少收一条；反过来则为几百条注定要丢的稿子白打请求。
        const body = await backfillBody(description, item.link);
        if (!body) {
          // 拿不到正文就**不入库** —— 宁可不推，也不推一段模型照标题编出来的东西。
          result.droppedNoBody++;
          continue;
        }
        if (body.backfilled) {
          // 覆盖回 `item`：下面的翻译循环读的就是这两个字段，
          // 不改它们等于白抓（原文进了库，中文却还是照标题编的）。
          item.contentSnippet = body.text;
          item.content = body.text;
          result.bodyBackfilled++;
        }

        const relevanceScore = scoreInvestmentRelevance(`${title} ${body.text}`);
        addCandidate(resolvedCountry, { item, source, relevanceScore });
        sourceCandidateCount++;
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

          // 与 RSS 路径同一套补抓逻辑（共用 `backfillBody`，不另写一份）。
          // Worker 给的 `summary` 有时只有一句话，那种长度同样撑不起一篇报道。
          const body = await backfillBody(description, article.url);
          if (!body) {
            result.droppedNoBody++;
            continue;
          }
          if (body.backfilled) result.bodyBackfilled++;

          addCandidate(country, {
            item: {
              title,
              link: article.url,
              pubDate: article.publishedAt?.toISOString(),
              content: body.backfilled ? body.text : (article.content || article.summary || ''),
              contentSnippet: body.text,
            },
            source: { name: `Telegram/${channel}`, url: article.url, country, language: 'en' },
            relevanceScore: scoreInvestmentRelevance(`${title} ${body.text}`),
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

  // ⏱ **翻译前**的库内身份探测（2026-10-10 加；`DEDUP_BEFORE_TRANSLATE=1` 才生效）
  //
  // 【为什么】线上实测 `dedup.againstDb = 85`（2026-09-24 19:00 那轮，见 AGENTS.md）——
  //   这 85 篇是**先翻译、再被闸 2 丢掉**的，按 37 秒/篇算 ≈ 52 分钟/轮，外加翻译费。
  //   而「是不是库内重复」在翻译**之前**就完全可知：判据只用 `item.link`
  //   与 `original_title` 两个翻译前字段。所以这部分判断没有理由排在翻译后面。
  //   完整动机与「为什么不改变输出集合」的证明写在 `@/lib/dedup-before-translate` 头部。
  //
  // 【每个变量为什么是这个写法】
  //   · `preWindowDays` 比闸 2 的窗口**窄一天**，这是硬要求不是保守：
  //     这里跑在循环**之前**、闸 2 跑在**之后**，两边 `since` 的基准时刻不同，
  //     等宽会让前置窗口反而更宽 ⇒ 有概率丢一篇闸 2 本来会放行的稿子。
  //     算术与反例见 `dedupPreWindowDays` 的注释（返回 null = 这份配置下不安全 ⇒ 关掉）。
  //   · 结果放在 `preKnown*` 三个变量里、**绝不与 `existing*` 共用**：
  //     闸 2 那次查询跑在循环**之后**，能看见循环期间别的进程（比如人工补报）新插的行。
  //     拿这里更早的快照去替它，就会放进重复行 —— 前置探测只许**省时间**，
  //     不许替闸 2 做判断。
  //   · 干跑模式（`skipTranslation`）跳过整段：干跑不翻译、也就不存在「白翻」，
  //     而它现在报出来的去重账（`saved` / `againstDb` 等）是既有的体检口径，
  //     不该因为一个省时间的开关而变。
  const preWindowDays = dedupPreWindowDays(DB_DEDUP_WINDOW_DAYS);
  // 开关的**原始解析值**单独留一份。`dedupBeforeTranslate` 把「开关」「窗口安全」
  // 「非干跑」三个条件与在了一起，光看它分不清「没开开关」和「开了但本轮是干跑」——
  // 而这两种情形在排查时的下一步动作完全不同（改控制台 vs 换一条命令）。
  // 这一份随 `summary.dedup.beforeTranslate.switch` 和 `GET /api/fetch-news` 的回显报出去。
  const dedupBeforeTranslateSwitch = isDedupBeforeTranslateEnabled();
  const dedupBeforeTranslate =
    dedupBeforeTranslateSwitch && preWindowDays !== null && !skipTranslation;
  let preKnownUrls = new Set<string>();
  let preKnownOriginals = new Map<string, number>();
  let preKnownOk = false;
  let skippedBeforeTranslate = 0;
  if (dedupBeforeTranslate && preWindowDays !== null) {
    try {
      const since = new Date(Date.now() - preWindowDays * 24 * 60 * 60 * 1000).toISOString();
      const [urlWindow, originalWindow] = await Promise.all([
        getRecentCanonicalUrls(since),
        getRecentOriginalTitleKeys(since),
      ]);
      preKnownUrls = urlWindow.urls;
      preKnownOriginals = originalWindow.keys;
      preKnownOk = true;
      console.log(
        `⏱ 翻译前去重已启用：库内近 ${preWindowDays} 天 ${urlWindow.rows} 行 → ` +
          `${preKnownUrls.size} 个链接指纹、${preKnownOriginals.size} 个原文指纹（命中即跳过翻译）`,
      );
    } catch (err) {
      // 只降级、不中止：本轮照旧翻译全部候选，正确性仍由下面那个原封不动的闸 2 兜住。
      // ⚠️ 这里**不要**去设置 `dbCheckError` —— 那个变量语义是「闸 2 查不出来 ⇒ 本轮不入库」，
      //    而这里失败只意味着「没省下时间」。
      console.warn(
        `翻译前去重探测失败，本轮照旧翻译全部候选（只影响省不省时间，不影响正确性）：${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  } else if (dedupBeforeTranslateSwitch && preWindowDays === null) {
    // 开关打开了但窗口算不出来（`DB_DEDUP_WINDOW_DAYS < 2`）⇒ 明确报出来，
    // 免得「明明设了环境变量却没生效」变成悬案。
    console.warn(
      `DEDUP_BEFORE_TRANSLATE 已设置，但 DB_DEDUP_WINDOW_DAYS=${DB_DEDUP_WINDOW_DAYS} ` +
        `收不出安全的更窄窗口，已跳过（见 dedupPreWindowDays 的说明）。`,
    );
  }

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
            if (!isCountryRelevant({ title: t, summary: d, countryCode: country, sourceCountry: source.country })) continue;

            // ★ 兜底路径**必须和第一轮走同一套补正文**（2026-10-02 补）。
            //
            // 为什么这条不能省：漏了它的后果与本项目反复踩的
            // 「同一条判据在两处各写一份、其中一处漏了」**完全一样**，而且更隐蔽 ——
            //   兜底抓回来的条目正文仍然是空的 ⇒ 翻译照跑、模型照编 ⇒
            //   推送侧的第 0 条闸再把它挡掉 ⇒
            //   **「兜底保证每国至少 N 篇」这个机制被静默架空**：
            //   日志上只会看到「本国候选不足，已兜底补充 N 篇」，而最后一条也没推出去。
            // 兜底**刻意不过** `isInvestmentRelevant`（它的存在就是为了在投资相关不足时
            // 用最新新闻把配额填满），所以这里只补正文、不加别的过滤。
            const fbBody = await backfillBody(d, item.link);
            // 计数挂在**这个源那一行**上（兜底循环里没有 `result` 变量，
            // 而它抓的正是同一个源的 feed ⇒ 按 source+country 找回那一行）。
            const fbOwner = results.find(
              (r) => r.source === source.name && r.country === source.country,
            );
            if (!fbBody) {
              if (fbOwner) fbOwner.droppedNoBody++;
              continue;
            }
            if (fbBody.backfilled) {
              item.contentSnippet = fbBody.text;
              item.content = fbBody.text;
              if (fbOwner) fbOwner.bodyBackfilled++;
            }

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

        // ⏱ 翻译前跳过「库里已经有」的稿子（见本函数上方 `preKnown*` 那段说明）。
        // ⚠️ 位置只能在这里：必须在 og:image 抓取与 `translateNews` **之前** ——
        //    那两者才是花钱花时间的部分，放到它们后面就等于什么都没省
        //    （而闸 2 照样会在最后把这些稿子丢掉）。
        // ⚠️ 判据必须与闸 2 **逐字同源**（`canonicalUrl(source_url)` /
        //    `originalTitleKey(original_title)`），否则「提前丢掉的」与「闸 2 会丢的」
        //    就不是同一个集合，`dedup-before-translate.ts` 头部那段等价性证明随即失效。
        // ⚠️ 这条 `continue` 不写日志：它命中的可能是几十篇，
        //    要的是汇总数（`skippedBeforeTranslate` 与结束时的漏斗行），不是逐条刷屏。
        if (preKnownOk) {
          const cu = canonicalUrl(item.link || '');
          const ok = originalTitleKey(originalTitle);
          if ((cu && preKnownUrls.has(cu)) || (ok && preKnownOriginals.has(ok))) {
            skippedBeforeTranslate++;
            continue;
          }
        }

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
          // ⏱ 只包住这一次调用（见文件上方 `translationMs` 的说明）。
          // ⚠️ `translateNews` 抛错时这两行不会执行 ⇒ 失败的篇数不计入分母，
          //    所以「秒/篇」是**成功调用的**均值。这是刻意的：分母混进失败会让均值失真。
          const translateStartedMs = Date.now();
          const translated = await translateNews(
            originalTitle,
            originalContent,
            source.language,
            // ⚠️ 用**桶的**国家名（这一轮 `country`），不是 `source.country` ——
            // 与下面入库时 `country_code` 的口径一致（见那行注释）。
            // 传错国家名的后果不是「标签错」，而是提示词里那句硬事实错，
            // 于是第 6 条的两条判据（国名只许写原文有的 / 本国元首写中文）会跟着错。
            countryList.find((c) => c.code === country)?.name || country,
          );
          translationMs += Date.now() - translateStartedMs;
          translatedArticles += 1;

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
  /** 闸 2 之二用：近窗口各国已入库的**中译标题**（筛 `created_at`，见函数注释） */
  let existingTitles = new Map<string, Array<{ id: number; title: string }>>();
  let dbCheckError: string | null = null;
  /** 闸 2 窗口查询实际拿到的**行数**（分页累加的真实行数，报给接口用于发现静默截断） */
  let dbWindowRows = 0;
  /** 闸 2 之二的标题窗口查询实际拿到的行数（截断可判断，理由同上） */
  let dbTitleWindowRows = 0;
  try {
    const since = new Date(Date.now() - DB_DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const urlWindow = await getRecentCanonicalUrls(since);
    const originalWindow = await getRecentOriginalTitleKeys(since);
    existingUrls = urlWindow.urls;
    existingOriginals = originalWindow.keys;
    dbWindowRows = urlWindow.rows;
    // 两个指纹查询同表、同窗口口径（都是 `published_at >= since`），行数**应当相等**。
    // 不等说明两个查询的过滤条件被改歪了 —— 一个多看一个少看，闸 2 会时灵时不灵。
    if (urlWindow.rows !== originalWindow.rows) {
      console.warn(
        `⚠️ 闸 2 两个窗口查询行数不一致：链接 ${urlWindow.rows} 行 vs 原文指纹 ${originalWindow.rows} 行（窗口口径可能被改歪）`,
      );
    }
    // 标题窗口筛 `created_at`（与上面两个指纹的 `published_at` **故意不同**）：
    // 要回答的是「我最近是不是已经收过这条」，这在入库时间轴上，不在源站发布轴上。
    const titleWindow = await getRecentTitlesByCountry(since);
    existingTitles = titleWindow.byCountry;
    dbTitleWindowRows = titleWindow.rows;
    console.log(
      `库内近 ${DB_DEDUP_WINDOW_DAYS} 天窗口共 ${dbWindowRows} 行：` +
        `${existingUrls.size} 个链接指纹、${existingOriginals.size} 个原文指纹、` +
        `${dbTitleWindowRows} 行中译标题（${[...existingTitles.entries()].map(([cc, l]) => `${cc}:${l.length}`).join(' ') || '无'}）`,
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

  // —— 闸 2 之二：库内**中译标题**去重（跨轮「同一件事」的确定性兜底）——
  //
  // 封的洞：`same_title` 在闸 3 只看得到**本批**，而「同一条新闻换源/换语种、
  // 隔一轮或隔一天才到」的两行永远进不了同一个批 —— 标题逐字相同也合不了。
  // 库内实测三对就是这么漏的（kz 3741|3915、kz 3925|3909、az 4164|4134，
  // 中译标题相似度全部 = 1.000，卡在不同轮）。把同一条判据搬到入库前的闸 2，
  // 跨轮/跨日就可见了。
  //
  // ⚠️ 三条安全边界 —— 这里比闸 3 更严，因为**丢在这一步的行库里没有、事后不可追**：
  //   1. 判据用 `isSameTitleText`（≥0.95 + 反向极性否决 + 占位标题否决），与闸 3
  //      `same_title` **同一条代码**。0.95 是在 1674 篇库内行上定标的：0.85–0.99
  //      一对都没有，≥0.85 的 3 对全部恰好 = 1.000（其中就含跨轮对），
  //      所以这条定标覆盖跨轮场景。上线前还用 `pnpm analyze:title-gate` 在
  //      7 天 1605 篇上回放过：拦的恰好是已知三对真重复，零误杀。
  //   2. 只跟**同国**的库内行比 —— 跨国出现同一件事是预期行为，不是重复。
  //   3. 占位标题（'无标题'）的否决在谓词本体里，不在这里重复
  //      （防线本体在 `isSameTitleText`，见它的注释）。
  //
  // 这条判据**买不到**什么，先写清楚免得误判疗效：标题相似度只有 0.3–0.5 的
  // 换词重写（如 AIIB 那组）依然拦不住 —— 那类要靠 L2 语义判定（G 节第 3 步）。
  let titleDropped = 0;
  const titleDrops: Array<{ country: string; keptId: number; kept: string; dropped: string; sim: number }> = [];
  const newAfterTitle = dbCheckError
    ? newArticles
    : newArticles.filter((a) => {
        const existing = existingTitles.get(a.country_code || 'intl');
        if (!existing) return true;
        for (const row of existing) {
          if (isSameTitleText(a.title || '', row.title)) {
            titleDropped++;
            const sim = similarity(a.title || '', row.title);
            titleDrops.push({ country: a.country_code || 'intl', keptId: row.id, kept: row.title, dropped: a.title || '', sim });
            return false;
          }
        }
        return true;
      });
  if (titleDropped > 0) {
    console.log(
      `库内标题去重剔除 ${titleDropped} 篇（跨轮同一件事）｜逐条：\n` +
        titleDrops
          .map((d) => `  [${d.country}] 丢「${d.dropped}」← 库内 id=${d.keptId}（sim=${d.sim.toFixed(3)}）「${d.kept}」`)
          .join('\n'),
    );
  }

  // —— 闸 3：「同一件事」理解 ——
  // 按国家分组，逐国判组。**不能跨国家合并**：推送是按国别生成草稿的，
  // 同一件事出现在两个国家频道里是预期行为，不是重复。
  const contentDeduped: typeof newAfterTitle = [];
  const eventDrops: Array<{ country: string; kept: string; dropped: string; reason: string }> = [];
  const llmJudge: { ran: boolean; ok: boolean; groups: number[][]; error?: string } = {
    ran: false, ok: false, groups: [],
  };
  {
    const byCountry = new Map<string, typeof newAfterTitle>();
    for (const a of newAfterTitle) {
      const key = a.country_code || 'intl';
      const list = byCountry.get(key);
      if (list) list.push(a);
      else byCountry.set(key, [a]);
    }

    for (const [cc, list] of byCountry) {
      // **显式关掉 L2，不跟着 `isLlmJudgeEnabled()` 的默认值走。**
      //
      // 2026-09-28 L2 的默认值从「关」翻成「开」（理由见 `same-event.ts` 的
      // `DedupOptions.useLlm`）—— 那是为**推送端**翻的。入库端必须显式写 false，
      // 否则会跟着一起开，而这里开 L2 有三条账都是负的：
      //
      //   1. **省不到翻译**。这一步跑在翻译**之后**（下面 `isSameTitleText` 比的是
      //      库内中译标题，且 `skipTranslation` 的注释写明走到这里 title/content
      //      已是中文）⇒ 重复稿的翻译钱已经花完，L2 只是额外再花 5 次调用。
      //   2. **花在最不能花的地方**。这 5 次调用落在抓取窗口里，而那正是 2026-09-27
      //      事故现场：抓取实测 154 分 51 秒 > 当时 150 分钟的软上限，超时后照样推送，
      //      读到半空的库（见 AGENTS.md K 节）。给抓取再加模型调用是在拿刚修好的
      //      那条链路冒险，而**收益是零**（推送端 L2 已经能看到同一批重复）。
      //   3. **丢在这里的行事后不可追**。推送端的合并只是本轮不推，库里还在；
      //      入库端合掉的是根本不会 insert，`lastRun.summary.dedup.drops` 之外没有第二份记录。
      //
      // 用户报的「哈萨克重复」是**草稿里**的重复，推送端 L2 已能消掉（同一件事在窗口内
      // 的重复稿对推送端是可见的，包括跨轮累积的那 38 篇）。所以入库端维持确定性三层。
      const { kept, drops, llm } = await dedupeStories(list, { useLlm: false });
      contentDeduped.push(...kept);
      if (llm.ran) {
        llmJudge.ran = true;
        llmJudge.ok = llm.ok;
        llmJudge.error = llmJudge.error || llm.error;
        // ⚠️ 这里把各国的下标组**拼进同一个数组**，而 `llm.groups` 的下标是
        // **按国各自编号**的（见 `DedupResult.llm.indexTitles`）—— 拼完就没有意义了。
        // 当前恒不触发（上面 `useLlm: false`），所以只是潜在陷阱：**哪天要在入库端开 L2，
        // 必须先把它改成 per-country 结构**（`[{country, groups}]`），否则读到的组是错的。
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
      // ⏱ 只在开关打开时插这一段：关着的时候这行与旧版**逐字相同**，
      // 于是开关前后的日志可以直接逐字对比（少一段就是它没生效）。
      (dedupBeforeTranslate ? `→ 翻译前跳过 ${skippedBeforeTranslate} 篇（库内已有，未花翻译费） ` : '') +
      `→ 批内去重剔除 ${intraBatchDropped} 篇 ` +
      `→ 链接/原文去重剔除 ${urlDropped} 篇 ` +
      `→ 库内标题去重剔除 ${titleDropped} 篇 ` +
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

  // ⏱ 阶段耗时（2026-10-10 加）—— 用途是分清「时间花在**等 API** 还是**本地算**」。
  //
  // ⚠️⚠️ 同日就改过一次判读：**别再把它读成「该不该加翻译并发」**。
  //   加并发已被实测排除 —— `scripts/fixtures/judge-repro-2026-10-07_10-08.json` 记着
  //   「并发发起请求会稳定触发 code 1302 **账号级**限流（实测 3 个并发里 2 个中招）」，
  //   而判组与翻译**共用同一个智谱账号** ⇒ 提并发只会把请求推进付费的 DeepSeek 降级链，
  //   **更贵、也不一定更快**。压缩轮次的正确顺序是
  //   「先去重前置（`DEDUP_BEFORE_TRANSLATE`）→ 再看要不要动规格」。
  //
  // 判读规则（写在这里，免得下次又要重新推一遍）：
  //   · `翻译占总 X%` 大（比如 >60%）⇒ 时间花在**等翻译 API** ⇒
  //       这部分没法并行省，只能**少发请求** ⇒ 去看 `dedup.skippedBeforeTranslate` 扣掉
  //       多少篇（能扣多少就打掉多少 × 秒/篇）。此时降规格的代价小。
  //   · `X%` 小、而整轮却很久 ⇒ 时间花在**本地算**（去重相似度、判组、排版）⇒
  //       该查的是那几段；降规格会**真的**把轮次拉长。
  //   · `秒/篇` 与 `scheduler.ts` 的 `MEASURED_WORST_PER_ARTICLE_MS`（37 秒）对照：
  //       明显低于它 ⇒ 那个最坏值偏保守，`mergedRoundWorstMs()` 算出的 370 分钟是上界；
  //       接近或超过它 ⇒ 400 分钟硬上限的余量是真的薄，**先别动规格**。
  const runElapsedMs = Date.now() - runStartedMs;
  const secPerArticle = translatedArticles > 0 ? translationMs / translatedArticles / 1000 : 0;
  console.log(
    `翻译耗时：${(translationMs / 60000).toFixed(1)} 分钟／${translatedArticles} 篇 = ` +
      `${secPerArticle.toFixed(1)} 秒/篇（本函数总耗时 ${(runElapsedMs / 60000).toFixed(1)} 分钟，` +
      `翻译占 ${runElapsedMs > 0 ? Math.round((translationMs / runElapsedMs) * 100) : 0}%）` +
      `${skipTranslation ? '｜干跑模式，翻译跳过' : ''}`
  );
  if (dedupBeforeTranslate) {
    // ⏱ 翻译前去重的**收成**（只在开关打开时打）。这行是「省了多少」的唯一直接读数。
    //
    // 判读（这两句就是这条优化的验收标准）：
    //   · `跳过 N 篇` × 本轮实测秒/篇 = 省下的时间；把它与 `durationMs` 的变化对照。
    //   · **`跳过 + 闸 2 又拦下` 应当 ≈ 关闭开关时的 `againstDb` 基线（线上 85）**。
    //     明显偏小 ⇒ 前置集合比闸 2 集合小得可疑：先查 `preWindowDays`，
    //       再查 `getRecentCanonicalUrls` / `getRecentOriginalTitleKeys` 的分页有没有被静默截断。
    //     明显偏大 ⇒ 两处口径不一致：去看两处 `canonicalUrl` / `originalTitleKey` 是不是同源。
    //   ⚠️ **不要期待「闸 2 又拦下 = 0」**：前置窗口刻意比闸 2 **窄一天**（这是正确性要求，
    //      见 `dedupPreWindowDays`），所以「库里那条对应行已经 2–3 天老」的那部分
    //      本来就轮不到前置拦，归闸 2 拦 —— 这部分非零是**设计如此**。
    console.log(
      `⏱ 翻译前去重收成：跳过 ${skippedBeforeTranslate} 篇` +
        (translatedArticles > 0
          ? `（约 ${((skippedBeforeTranslate * secPerArticle) / 60).toFixed(1)} 分钟，按本轮实测 ${secPerArticle.toFixed(1)} 秒/篇）`
          : '') +
        `｜之后闸 2 又拦下 ${urlDropped} 篇（前者 + 后者应当 ≈ 关闭开关时的 againstDb 基线）`,
    );
  }
  if (translation.errors.length > 0) {
    // ⚠️ 必须把 `kind` / `count` 打出来（2026-10-05 加）。这一行是本轮修那个
    // 「两个通道报错变成悬案」的直接产物：只打 `provider(model): error` 时，
    //   · 看不出**这一轮失败了几次**（偶发 vs 常发是一个数，不是一句话）；
    //   · 也看不出**该不该重试**（`content-filter` 重试无用，`rate-limit` 才有用）。
    // 判读：`×N` 大 + `kind=rate-limit` ⇒ 首选通道被限流，属预期（免费档），
    // 只要 `providerCounts` 里 `zhipu-flash` 有量就说明降级链在干活；
    // `kind=content-filter` ⇒ **不重试**，是内容被审核，去查那几篇稿子的原文。
    console.warn(
      `翻译通道报错：${translation.errors
        .map((e) => `${e.provider}(${e.model})×${e.count ?? 1} [${e.kind ?? '未分类'}] ${e.error}`)
        .join('；')}`
    );
  }

  return {
    date: targetDate,
    totalFetched,
    candidates: articlesToInsert.length,
    // 去重分四段记账，别再合成一个数字：四段失败原因完全不同，
    // 合成后「今天为什么少了几篇」就查不出来了。
    dedup: {
      /** 批内链接/原文重复（同一轮里同一条被抓到两次） */
      intraBatch: intraBatchDropped,
      /** 与库内近 3 天重复（跨轮重复，线上重复行的主要来源） */
      againstDb: urlDropped,
      /**
       * ⏱ 翻译前跳过、因而没花翻译费的条数（见 `FetchSummary.dedup` 的字段说明）。
       * 与 `againstDb` 互斥、可相加；开关关着时恒为 0。
       */
      skippedBeforeTranslate,
      /**
       * 「翻译前去重」这条路本轮**到底走没走**，以及为什么（2026-10-10 加）。
       *
       * 必须与 `skippedBeforeTranslate` 配套读：只有那个计数时，
       * 「开关开着但它是 0」既是「开关没生效」也是「本轮确实没有库内重复」，
       * 两种情形同形 —— 而这正是事后复盘最容易读反的地方。
       * 三个字段合起来才是完整的因果：`switch` 是意图，`windowDays` 是约束，`active` 是事实。
       */
      beforeTranslate: {
        /** 环境变量 `DEDUP_BEFORE_TRANSLATE` 的解析值（默认关）。 */
        switch: dedupBeforeTranslateSwitch,
        /** 本轮是否真的执行了前置跳过。干跑恒为 false（干跑不翻译 ⇒ 没有「白翻」可省）。 */
        active: dedupBeforeTranslate,
        /** 前置窗口（天）；null ⇒ 这份配置下不存在安全更窄窗口，按设计关掉。 */
        windowDays: preWindowDays,
      },
      /**
       * 与库内近 3 天**中译标题**近逐字相同（跨轮「同一件事」，2026-09-24 加）。
       * 判据与闸 3 `same_title` 同一条（`isSameTitleText`），但作用于入库前，
       * 所以它拦下的行**库里没有** —— 想知道拦了什么看 `titleDrops` 或日志。
       */
      againstDbTitles: titleDropped,
      /** 「同一件事」判组剔除（表述不同、事件相同） */
      sameEvent: eventDrops.length,
      /** 库内去重查询失败 → 本轮放弃入库时的原因，正常为 null */
      dbCheckError,
      /**
       * 闸 2 那次窗口查询**实际拿到多少行**（分页累加后的真实行数）。
       *
       * 必须报出来，否则「窗口是不是被静默截断」在线上无法判断：
       * PostgREST 的返回条数上限通常是 1000（服务端配置），
       * **超限时不报错、只是悄悄少给**（同一个坑 `getArticleIdentities` 的注释里已经写过）。
       * 判读：拿 `window.rows` 和 `GET /api/dedupe-check?days=3` 的 `totals.articles` 对照 ——
       * 两者应当接近；若 `window.rows` 恰好卡在某个整数上限（1000/5000）且明显偏小，
       * 就是被截断了，此时闸 2 形同虚设。
       *
       * 2026-09-24 实测：窗口内 1228 行，而三个查询都只给回 1000 行 —— 闸 2 对约 19% 的稿子瞎。
       * 现在三个查询（`getRecentCanonicalUrls` / `getRecentOriginalTitleKeys` /
       * `getRecentTitlesByCountry`）都改成了 `PAGE = 1000` + `.range()` 分页，
       * 这行数字从 1000 涨到真实值就是修好的证据；**再次卡在 1000 就是分页坏了**。
       */
      window: { days: DB_DEDUP_WINDOW_DAYS, rows: dbWindowRows, titleRows: dbTitleWindowRows },
      /** 判组用的模型是否真的跑过；没跑说明只是链接/原文去重生效 */
      llmJudge,
      /** 标题去重逐条明细（保留行 id + 相似度），上线首日复核就看这个 */
      titleDrops: titleDrops.slice(0, 50),
      /** 逐条原因，便于直接看出「丢了哪条、留下了哪条」 */
      drops: eventDrops.slice(0, 50),
    },
    afterUrlDedup: newArticles.length,
    /** 闸 2 之二（库内中译标题）之后的规模 —— 与 afterUrlDedup 的差就是标题去重剔除数 */
    afterTitleDedup: newAfterTitle.length,
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
      /** 抓原文页补回正文的条数（2026-10-02 新增）。为 0 而 `droppedNoBody` 很大 ⇒ 源站在挡我们。 */
      bodyBackfilled: r.bodyBackfilled,
      /** RSS 没给正文、抓页面也没抓到，因此**没入库**的条数。 */
      droppedNoBody: r.droppedNoBody,
      /** 进入候选池的条数（= afterDate − 四个丢弃原因，`droppedNoBody` 也算丢弃） */
      candidates: r.afterDate - r.droppedJunk - r.droppedCountry - r.droppedTopic - r.droppedNoBody,
      /** 归属国被改判的条数（仅 intl 源可能非零，见 `resolveArticleCountry`） */
      reassigned: r.reassigned,
    })),
    /**
     * 按国别汇总的漏斗 —— **回答「某国今天为什么只有 N 篇」看这里，不要看 sourceCounts**。
     *
     * 口径：feed 条目 → 过日期窗 → 文体垃圾 / 讲别国 / 非投资 → 候选池。
     * 四个环节的失败修法完全不同，所以必须分开计数（与 `dedup` 分四段记账同一个理由）：
     *   · `afterDate` 偏小   → 源在这个时段本来就没发稿，或 feed 只保留很少条目
     *     （Astana Times 的 feed 只有 10 条，等于只覆盖最近一两天；别的源有 100 条）
     *   · `droppedCountry` 偏大 → `isCountryRelevant` 里「提到了任何一个其它目标国就丢」
     *     这条互斥规则在该国身上过敏（中亚当地区新闻极易同时提到邻国）
     *   · `droppedTopic` 偏大  → 入库闸门词表对该国**语言**覆盖不足（如哈萨克语源）
     *   · `droppedNoBody` 偏大 → **源站的 RSS 没给正文，而且去抓页面也没抓到**。
     *     2026-10-02 起这种稿子**直接不入库**（正文为空时模型会照标题编一整天新闻，
     *     且总审没有原文可核对）。要看的是 `bodyBackfilled` 有没有把量补回来；
     *     若 `bodyBackfilled=0` 而 `droppedNoBody` 很大 ⇒ 源站在挡我们（例如
     *     `azertag.az` 由 Cloudflare 罩着，见 `article-body.ts` 的对照实验）。
     *   · `fetched=0` 且 `sourceErrors` 有值 → 源本身不通（网络超时 / XML 畸形）
     *
     * ⚠️ `candidates` 是**入库前**的候选数：不减去批内去重与库内重复，
     * 也不等于最终入库数（那要看 `candidates` / `afterUrlDedup` / `afterTitleDedup` / `saved` 四段）。
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
        const droppedNoBody = rs.reduce((a, r) => a + r.droppedNoBody, 0);
        const bodyBackfilled = rs.reduce((a, r) => a + r.bodyBackfilled, 0);
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
          droppedNoBody,
          bodyBackfilled,
          candidates: afterDate - droppedJunk - droppedCountry - droppedTopic - droppedNoBody,
          reassigned,
        };
      }),
    sourceErrors: failedSources.map((r) => ({ source: r.source, errors: r.errors })),
    /** ⏱ 阶段计时 —— 说明与判读规则见 `FetchSummary.timing` 和那行「翻译耗时」日志。 */
    timing: { translationMs, translatedArticles },
    translation: {
      providerCounts: translation.providerCounts,
      errors: translation.errors,
      /**
       * 术语闸（2026-10-05 加）—— 货币与所属国不符 / 已知错译写法。
       *
       * ⚠️ **这是一道硬闸**：命中 ⇒ 重试 ⇒ 三次不过**丢稿**。所以这一块不是
       * 「性能指标」，是「丢稿预警」：`currency` / `wrongNoun` 只要不是 0，
       * 就要去读 `samples` 那 20 条，确认拦的是真缺陷而不是误杀。
       * 零值**不代表闸没生效** —— 看 `probe`。
       */
      termGate: {
        /** 术语表版本号。改表必须改它；它一变就说明口径变了，两轮数据不可直接比。 */
        tableVersion: PROPER_NOUN_VERSION,
        currency: translation.termGate.currency,
        wrongNoun: translation.termGate.wrongNoun,
        /**
         * ⚠️ **唯一需要盯着不为 0 的数**：因为术语闸而最终不入库的篇数。
         * `currency`/`wrongNoun` 变大是好事（闸在干活、稿子被重试救回来）；
         * `dropped` 变大的意思是**稿子在丢** —— 去读 `dropSamples`。
         */
        dropped: translation.termGate.dropped,
        samples: translation.termGate.samples,
        dropSamples: translation.termGate.dropSamples,
        /**
         * 活体探针：**真判据**跑固定样例，左侧三条必须命中、右侧三条必须放行。
         * 与 `expected` 一致 ⇒ 这一版的判据确实在线上跑；不一致 ⇒ 部署没到位或判据被改坏。
         */
        probe: termGateProbe(),
        expected: TERM_GATE_PROBE_EXPECT,
      },
    },
  };
}

export async function GET() {
  // 这几个值**现算**（不缓存、不从 `lastRun` 里取）：环境变量是容器级配置，
  // 冷启动出来的容器身上也是同一份 ⇒ 任何时刻读都准。这一点是它和 `lastRun` 的根本区别。
  const dedupBeforeTranslateSwitch = isDedupBeforeTranslateEnabled();
  const dedupBeforeTranslateWindowDays = dedupPreWindowDays(DB_DEDUP_WINDOW_DAYS);

  return NextResponse.json({
    message: '新闻采集接口',
    usage: 'POST /api/fetch-news with optional { date: "YYYY-MM-DD", minPerCountry: 10, skipTranslation: true }',
    // skipTranslation=true 是**信息源体检的干跑模式**：只采集、不入库、不调用翻译，
    // 跑完读下面的 lastRun.summary.sourceCounts / sourceErrors 就知道每个源通不通。
    // 想确认 Telegram 通没通、某个 RSS 源是不是死了，用这个模式，几分钟出结果且零成本。
    dryRunHint: 'POST {"skipTranslation": true} 可做零成本的信息源体检（只采集不入库）',
    sources: RSS_SOURCES.map((s) => ({ name: s.name, country: s.country })),
    /**
     * 行为开关的**活体回显**（2026-10-10 加，对齐 `GET /api/wechat/push` 的 `codeVersion`）。
     *
     * ## 为什么需要它
     *
     * `DEDUP_BEFORE_TRANSLATE` 是**控制台设的环境变量**，而一轮真跑要 2.5 小时、
     * 还要花翻译费。没有这个回显时，「环境变量到底设上没有」就只能靠**跑完一轮**
     * 去看 `summary.dedup.skippedBeforeTranslate` —— 若那时开关其实没生效，
     * 这一轮量到的其实是「关闭态」，排好的两天工作量白费。
     * 一条 `curl` 就能把这件事**在花钱之前**问清楚。
     *
     * ## 为什么它**不会**像 `lastRun` 那样骗人
     *
     * `lastRun` 是**内存态**：窗口外实例缩容到 0，任何一次 GET 都会冷启动一个新容器
     * ⇒ 读到计时全空、`summary` 空对象，与「那一轮根本没跑」**完全同形**（见 `AGENTS.md`）。
     * 而环境变量是**容器级配置**，新冷启动的容器身上也是同一份
     * ⇒ 下面这几个值**什么时刻读都准**。这正是它值得存在、而 `lastRun` 不行的理由。
     *
     * 用法：`curl -s "$URL/api/fetch-news" | grep -A6 '"knobs"'`
     * 判读：`dedupBeforeTranslate.effective` 就是「下一轮真跑会不会走这条路」；
     *       为 false 时再看 `switch`（环境变量没设/写错了）与 `windowDays`（窗口收不出来）
     *       是哪一个 —— 两种失败修法不同。
     * ⚠️ 这个接口**没有任何副作用**（下面只做纯函数计算与读内存态），
     *    所以它同时是保活 ping 的正确靶子；**千万别把保活 ping 打到 POST**，那是一打就跑一轮。
     */
    knobs: {
      /**
       * 「翻译前先按库内身份去重」（`@/lib/dedup-before-translate`）。
       * 打开后每轮省下的是「先翻译、再被闸 2 丢掉」的那批（线上实测 `againstDb = 85`
       * ⇒ 约 52 分钟/轮）。
       */
      dedupBeforeTranslate: {
        /** 环境变量 `DEDUP_BEFORE_TRANSLATE` 的解析值（**默认关**；只有 1/on/true 才开）。 */
        switch: dedupBeforeTranslateSwitch,
        /** 前置探测窗口（天）= `DB_DEDUP_WINDOW_DAYS − 1`；null ⇒ 收不出更窄窗口 ⇒ 关掉。 */
        windowDays: dedupBeforeTranslateWindowDays,
        /** 正常轮（非干跑）的预期效果 = `switch && windowDays !== null`。 */
        effective: dedupBeforeTranslateSwitch && dedupBeforeTranslateWindowDays !== null,
      },
      /** 闸 2 的库内窗口（天），与 `summary.dedup.window.days` 同源。 */
      dbDedupWindowDays: DB_DEDUP_WINDOW_DAYS,
    },
    // 上一轮抓取的状态。调度器靠 running / finishedAt 判断「抓完了没」；
    // 人工排查时 summary 里有各源采集量与最终入库数，error 是失败原因。
    // ⚠️ 内存态：窗口外读到的空态**不等于**「那一轮没跑」，见上面 `knobs` 的说明。
    lastRun: fetchRunState,
  }, {
    // 必须禁掉缓存：调度器轮询这个接口等状态变化，被缓存住就会一直看到旧状态，
    // 表现为「干等到超时」。
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
