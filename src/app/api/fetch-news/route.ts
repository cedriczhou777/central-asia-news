import { NextRequest, NextResponse } from 'next/server';
import Parser from 'rss-parser';
import { insertArticles, getExistingSourceUrls } from '@/lib/db-articles';
import { fetchTelegramRSS } from '@/lib/scraper';
import { isChineseText, isDuplicateContent, beijingDate } from '@/lib/utils';
import { countryList } from '@/lib/data/countries';
import { translateNews, resetTranslationStats, getTranslationStats, fallbackCategory } from '@/lib/translate';
import { DEFAULT_TELEGRAM_CHANNELS, parseTelegramChannels } from '@/lib/telegram-channels';

const parser = new Parser({
  timeout: 30000,
  headers: { 'User-Agent': 'CentralAsiaNewsBot/1.0' },
});

interface RSSSource {
  name: string;
  url: string;
  country: string;
  language: string;
}

/** 一条待入库的候选新闻。RSS / 网页爬虫 / Telegram 三条采集路径共用这个结构。 */
interface Candidate {
  item: Parser.Item;
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
  /** 实际写入数据库的条数 */
  saved: number;
  sourceCounts: Array<{ source: string; fetched: number }>;
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

// RSS 源配置（可用源）
// 说明：优先收录大陆网络可达的源。Telegram(api.telegram.org / t.me) 与 Instagram
// 在国内网络不可达（本项目部署于微信云托管/大陆服务器），无法作为自动信息源接入；
// 如需读取 Telegram 频道，请自建境外 RSSHub 桥并在 RSS_SOURCES 中声明其 telegram 镜像。
//
// ⚠️ 源的健康状况要定期用 GET /api/fetch-news 的 lastRun.sourceCounts 复查：
// 2026-09-19 实测死源（404/410，已从清单移除，别加回来）：
//   kabar.kg/rus/rss（410）、24.kg/rss/all（404）、24.kz/rss（404）、
//   tengrinews.kz/rss_news/all.xml（404）、inform.kz 的 english rss（404）、
//   kun.uz（无 RSS 接口）、daryo.uz（feed 空壳）
// KG 已换成 kabar.kg/rss（吉语主源）、AKIpress、Vesti.kg、Tazabek（商业财经）、
// Economist.kg（商业财经）；KZ 补了 Inbusiness.kz、Total.kz。
const RSS_SOURCES: RSSSource[] = [
  // 哈萨克斯坦
  { name: 'The Astana Times', url: 'https://astanatimes.com/feed/', country: 'kz', language: 'en' },
  { name: 'Egemen Qazaqstan', url: 'https://egemen.kz/rss/', country: 'kz', language: 'kk' },
  { name: 'Newtimes.kz', url: 'https://newtimes.kz/rss/', country: 'kz', language: 'ru' },
  { name: 'Inbusiness.kz', url: 'https://inbusiness.kz/rss', country: 'kz', language: 'ru' },
  { name: 'Total.kz', url: 'https://total.kz/rss', country: 'kz', language: 'ru' },

  // 乌兹别克斯坦
  { name: 'UzA', url: 'https://uza.uz/rss/', country: 'uz', language: 'ru' },
  { name: 'Gazeta.uz', url: 'https://www.gazeta.uz/rss', country: 'uz', language: 'ru' },
  { name: 'Spot.uz', url: 'https://spot.uz/rss/', country: 'uz', language: 'ru' },
  { name: 'Uznews.uz', url: 'https://uznews.uz/rss/', country: 'uz', language: 'ru' },

  // 吉尔吉斯斯坦（2026-09-19 换血：旧的两个源 410/404 已死）
  { name: 'Kabar', url: 'https://kabar.kg/rss', country: 'kg', language: 'ky' },
  { name: 'AKIpress', url: 'https://kg.akipress.org/rss', country: 'kg', language: 'ru' },
  { name: 'Vesti.kg', url: 'https://vesti.kg/rss', country: 'kg', language: 'ru' },
  { name: 'Tazabek', url: 'https://tazabek.kg/rss', country: 'kg', language: 'ru' },
  { name: 'Economist.kg', url: 'https://economist.kg/rss', country: 'kg', language: 'ru' },

  // 塔吉克斯坦
  { name: 'Khovar', url: 'https://khovar.tj/rss/', country: 'tj', language: 'ru' },
  { name: 'Asia-Plus', url: 'https://asiaplustj.info/rss/', country: 'tj', language: 'ru' },
  { name: 'Avesta', url: 'https://avesta.tj/rss/', country: 'tj', language: 'ru' },

  // 阿塞拜疆
  // 下面每个 URL 都逐个实测过（HTTP 200 且能解析出 item）。
  // 注意一批常见的阿塞拜疆媒体被 Cloudflare 拦在外面，从本机返回 403，别往里加：
  //   azernews.az / oxu.az / 1news.az / minval.az / news.day.az / musavat.com / report.az
  // （2026-09-19 补测：abc.az / turan.az / news.az / sfera.az 均 404；interfax.az / aze.media 不可达）
  { name: 'AZERTAC', url: 'https://azertag.az/en/rss', country: 'az', language: 'en' },
  { name: 'AZERTAC (ru)', url: 'https://azertag.az/ru/rss', country: 'az', language: 'ru' },
  { name: 'Trend.az', url: 'https://www.trend.az/rss/', country: 'az', language: 'en' },
  { name: 'APA', url: 'https://apa.az/rss', country: 'az', language: 'az' },
  { name: 'Haqqin.az', url: 'https://haqqin.az/rss', country: 'az', language: 'ru' },
  { name: 'Qafqazinfo', url: 'https://qafqazinfo.az/rss', country: 'az', language: 'az' },
  { name: 'Modern.az', url: 'https://modern.az/rss', country: 'az', language: 'az' },
  { name: 'Banker.az', url: 'https://banker.az/feed/', country: 'az', language: 'az' },

  // 区域综合媒体
  { name: 'The Times of Central Asia', url: 'https://timesca.com/feed/', country: 'intl', language: 'en' },
  { name: 'Central Asia News', url: 'https://centralasia.news/feed/', country: 'intl', language: 'en' },
];

// 投资相关关键词（用于精选新闻）
const INVESTMENT_KEYWORDS = [
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
  // 中亚／里海特定
  // 阿塞拜疆在地理上属南高加索，但在里海能源与「中间走廊」上和中亚是一条线，
  // 所以关键词里同时带上 south caucasus / caspian。
  'central asia', 'kazakhstan', 'uzbekistan', 'kyrgyzstan', 'azerbaijan', 'tajikistan',
  'south caucasus', 'caspian',
  'silk road', 'belt and road', ' BRI',
];

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

// 标题是否明显是文体/生活类垃圾（不值得花翻译钱）
function isJunkTitle(title: string): boolean {
  const t = title.toLowerCase();
  return JUNK_TITLE_KEYWORDS.some((kw) => t.includes(kw));
}

// 检查新闻是否与投资主题相关
function isInvestmentRelevant(title: string, description: string): boolean {
  const text = `${title} ${description}`.toLowerCase();
  return INVESTMENT_KEYWORDS.some(kw => text.includes(kw));
}

// 对新闻进行投资相关性评分
function scoreInvestmentRelevance(title: string, description: string): number {
  const text = `${title} ${description}`.toLowerCase();
  let score = 0;
  for (const kw of INVESTMENT_KEYWORDS) {
    if (text.includes(kw)) {
      score += kw.length; // 长关键词权重更高
    }
  }
  return score;
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
  const results: { source: string; fetched: number; errors: string[] }[] = [];
  
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
    const result = { source: source.name, fetched: 0, errors: [] as string[] };
    try {
      const feed = await parser.parseURL(source.url);
      result.fetched = feed.items.length;

      // 筛选目标日期（放宽：目标日期及前 1 天，即最多回溯 2 天）的新闻
      const targetItems = feed.items.filter((item) => {
        if (!item.pubDate) return true;
        const itemDate = new Date(item.pubDate).toISOString().split('T')[0];
        return itemDate === targetDate || itemDate === targetDateMinusOne;
      });

      if (targetItems.length === 0) {
        results.push(result);
        continue;
      }

      // 对每篇新闻进行投资相关性评分和国家相关性检查
      for (const item of targetItems) {
        const title = item.title || '';
        const description = item.contentSnippet || item.content || '';

        // 文体/生活类标题直接丢弃 —— 翻译是要花钱的，垃圾不值得进 LLM
        if (isJunkTitle(title)) continue;

        // 检查是否与目标国家相关（含「其它主要国家」的排除逻辑）
        if (!isCountryRelevant(title, description, source.country, source.country)) {
          continue; // 跳过与该国无关的新闻
        }
        
        // 检查是否与投资主题相关
        if (isInvestmentRelevant(title, description)) {
          const relevanceScore = scoreInvestmentRelevance(title, description);
          addCandidate(source.country, { item, source, relevanceScore });
        }
      }

      console.log(`从 ${source.name} 采集 ${targetItems.length} 篇，其中投资相关 ${getCandidates(source.country).length} 篇`);
    } catch (err) {
      result.errors.push(`RSS 解析失败：${err instanceof Error ? err.message : '未知错误'}`);
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
      const result = { source: `Telegram/${channel}(${country})`, fetched: 0, errors: [] as string[] };
      try {
        const fetchedPosts = await fetchTelegramRSS(channel);
        result.fetched = fetchedPosts.length;
        if (fetchedPosts.length === 0) {
          // 频道名写错、Worker 没配好、或该频道当天没内容，都会落到这里，如实记录
          result.errors.push('Worker 返回 0 条（检查频道名是否存在 / Worker 是否可访问）');
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
            relevanceScore: scoreInvestmentRelevance(title, description),
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
      source: 'Telegram（未启用）',
      fetched: 0,
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
  // 'intl' 是区域综合源的归属，不属于 countries 表，单独补上。
  for (const country of [...countryList.map((c) => c.code), 'intl']) {
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
          const feed = await parser.parseURL(source.url);
          const latestItems = feed.items.slice(0, minPerCountry * 2); // 多取一些作为候选

          for (const item of latestItems) {
            // 避免重复
            const alreadyExists = candidates.some(c => c.item.link === item.link);
            if (alreadyExists) continue;

            const t = item.title || '';
            const d = item.contentSnippet || item.content || '';
            if (isJunkTitle(t)) continue;
            if (!isCountryRelevant(t, d, country, source.country)) continue;

            selectedCandidates.push({
              item,
              source,
              relevanceScore: 0, // 补充新闻评分为 0
            });
          }
        } catch {
          // 忽略错误
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
        if (imageUrls.length === 0 && item.link) {
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
          country_code: source.country,
          category,
          source_name: source.name,
          source_url: item.link || '',
          original_title: originalTitle,
          original_content: originalContent,
          original_language: source.language,
          published_at: item.pubDate || new Date().toISOString(),
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
  let existingUrls = new Set<string>();
  if (articlesToInsert.length > 0) {
    const urls = articlesToInsert.map(a => a.source_url).filter(Boolean) as string[];
    console.log(`准备插入 ${articlesToInsert.length} 篇，去重检查 ${urls.length} 个 URL`);
    if (urls.length > 0) {
      try {
        existingUrls = await getExistingSourceUrls(urls);
        console.log(`数据库中已存在 ${existingUrls.size} 个 URL`);
      } catch (dbErr) {
        console.error('去重查询失败:', dbErr instanceof Error ? dbErr.message : dbErr);
        existingUrls = new Set();
      }
    }
  }

  const newArticles = articlesToInsert.filter(a => !existingUrls.has(a.source_url));
  console.log(`URL 去重后剩余 ${newArticles.length} 篇新文章`);

  // 内容级去重：本批内同国家文章，若标题+正文语义相似则只保留最先出现的一篇
  // （放宽时间窗至 2 天后，不同源可能报道同一事件，杜绝重复内容入库/推送）
  const contentDeduped: typeof newArticles = [];
  for (const article of newArticles) {
    const isDup = contentDeduped.some(
      pre => pre.country_code === article.country_code &&
        isDuplicateContent(pre.title, pre.content, article.title, article.content)
    );
    if (!isDup) {
      contentDeduped.push(article);
    }
  }
  if (contentDeduped.length < newArticles.length) {
    console.log(`内容级去重剔除 ${newArticles.length - contentDeduped.length} 篇重复内容，剩余 ${contentDeduped.length} 篇`);
  }

  let savedCount = 0;
  if (contentDeduped.length > 0) {
    try {
      await insertArticles(contentDeduped);
      savedCount = contentDeduped.length;
      console.log(`成功保存 ${savedCount} 篇到数据库`);
    } catch (insertErr) {
      console.error('插入数据库失败:', insertErr instanceof Error ? insertErr.message : insertErr);
    }
  }

  const totalFetched = results.reduce((sum, r) => sum + r.fetched, 0);
  const failedSources = results.filter((r) => r.errors.length > 0);

  console.log(
    `新闻抓取完成：日期=${targetDate}｜原始采集 ${totalFetched} 篇 → 投资相关候选 ${articlesToInsert.length} 篇 ` +
      `→ URL 去重剔除 ${articlesToInsert.length - newArticles.length} 篇 ` +
      `→ 内容去重剔除 ${newArticles.length - contentDeduped.length} 篇 ` +
      `→ 实际入库 ${savedCount} 篇`
  );
  console.log(`各源采集量：${results.map((r) => `${r.source}=${r.fetched}`).join(' | ')}`);
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
    afterUrlDedup: newArticles.length,
    afterContentDedup: contentDeduped.length,
    saved: savedCount,
    sourceCounts: results.map((r) => ({ source: r.source, fetched: r.fetched })),
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
