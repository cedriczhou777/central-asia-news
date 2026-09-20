import * as cheerio from 'cheerio';

export interface ScrapedArticle {
  title: string;
  url: string;
  publishedAt: Date | null;
  summary?: string;
  content?: string;
  coverImage?: string;
}

export interface ScraperConfig {
  name: string;
  url: string;
  selectors: {
    articles: string;
    title: string;
    link: string;
    date?: string;
    summary?: string;
    coverImage?: string;
  };
  baseUrl: string;
  dateParser?: (dateStr: string) => Date | null;
}

/**
 * 通用网页爬虫
 */
export async function scrapeWebsite(config: ScraperConfig): Promise<ScrapedArticle[]> {
  try {
    const response = await fetch(config.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      console.error(`[${config.name}] 抓取失败：Status code ${response.status}`);
      return [];
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const articles: ScrapedArticle[] = [];

    $(config.selectors.articles).each((_, element) => {
      const $el = $(element);
      
      const title = $el.find(config.selectors.title).text().trim();
      const link = $el.find(config.selectors.link).attr('href') || '';
      const fullUrl = link.startsWith('http') ? link : `${config.baseUrl}${link}`;
      
      let publishedAt: Date | null = null;
      if (config.selectors.date) {
        const dateStr = $el.find(config.selectors.date).text().trim();
        if (dateStr && config.dateParser) {
          publishedAt = config.dateParser(dateStr);
        } else if (dateStr) {
          publishedAt = new Date(dateStr);
          if (isNaN(publishedAt.getTime())) publishedAt = null;
        }
      }

      const summary = config.selectors.summary 
        ? $el.find(config.selectors.summary).text().trim() 
        : undefined;

      const coverImage = config.selectors.coverImage
        ? $el.find(config.selectors.coverImage).attr('src') || undefined
        : undefined;

      if (title && fullUrl) {
        articles.push({
          title,
          url: fullUrl,
          publishedAt,
          summary,
          coverImage,
        });
      }
    });

    console.log(`[${config.name}] 抓取 ${articles.length} 篇文章`);
    return articles;
  } catch (error) {
    console.error(`[${config.name}] 抓取失败:`, error instanceof Error ? error.message : String(error));
    return [];
  }
}

/**
 * 中亚新闻网站爬虫配置
 */
export const CENTRAL_ASIA_SCRAPERS: ScraperConfig[] = [
  // 哈萨克斯坦
  {
    name: 'Kazinform',
    url: 'https://www.kazinform.kz/kz/news',
    baseUrl: 'https://www.kazinform.kz',
    selectors: {
      articles: '.news-list-item, .news-item',
      title: '.news-title, h3, h2',
      link: 'a[href*="/news/"]',
      date: '.news-date, time',
      coverImage: 'img',
    },
  },
  {
    name: 'Tengrinews',
    url: 'https://tengrinews.kz/news/',
    baseUrl: 'https://tengrinews.kz',
    selectors: {
      articles: '.tn-news-list-item, .news-item',
      title: '.tn-news-list-title, h3',
      link: 'a[href*="/news/"]',
      date: '.tn-news-list-date, time',
      coverImage: 'img',
    },
  },
  {
    name: 'Zakon.kz',
    url: 'https://www.zakon.kz/news/',
    baseUrl: 'https://www.zakon.kz',
    selectors: {
      articles: '.news-item, .news-list-item',
      title: '.news-title, h3',
      link: 'a[href*="/news/"]',
      date: '.news-date, time',
    },
  },
  {
    name: 'Nur.kz',
    url: 'https://www.nur.kz/latest/',
    baseUrl: 'https://www.nur.kz',
    selectors: {
      articles: '.article-list-item, .news-item',
      title: '.article-title, h3',
      link: 'a[href*="/article/"]',
      date: '.article-date, time',
    },
  },
  {
    name: 'Inbusiness.kz',
    url: 'https://inbusiness.kz/ru/news',
    baseUrl: 'https://inbusiness.kz',
    selectors: {
      articles: '.news-item, .news-list-item',
      title: '.news-title, h3',
      link: 'a[href*="/news/"]',
      date: '.news-date, time',
    },
  },
  {
    name: 'Forbes.kz',
    url: 'https://forbes.kz/news/',
    baseUrl: 'https://forbes.kz',
    selectors: {
      articles: '.news-item, .article-item',
      title: '.news-title, h3',
      link: 'a[href*="/news/"]',
      date: '.news-date, time',
    },
  },
  {
    name: 'Kazakhstanskaya Pravda',
    url: 'https://kz.pravda.kz/news/',
    baseUrl: 'https://kz.pravda.kz',
    selectors: {
      articles: '.news-item, .article-item',
      title: '.news-title, h3',
      link: 'a[href*="/news/"]',
      date: '.news-date, time',
    },
  },
  {
    name: 'DKNews.kz',
    url: 'https://dknews.kz/ru/news',
    baseUrl: 'https://dknews.kz',
    selectors: {
      articles: '.news-item, .news-list-item',
      title: '.news-title, h3',
      link: 'a[href*="/news/"]',
      date: '.news-date, time',
    },
  },
  {
    name: 'Khabar',
    url: 'https://www.khabar.kz/kz/news',
    baseUrl: 'https://www.khabar.kz',
    selectors: {
      articles: '.news-item, .news-list-item',
      title: '.news-title, h3',
      link: 'a[href*="/news/"]',
      date: '.news-date, time',
    },
  },
  // 乌兹别克斯坦
  {
    name: 'Kun.uz',
    url: 'https://kun.uz/ru/news',
    baseUrl: 'https://kun.uz',
    selectors: {
      articles: '.news-item, .news-list-item',
      title: '.news-title, h3',
      link: 'a[href*="/news/"]',
      date: '.news-date, time',
    },
  },
  {
    name: 'Daryo.uz',
    url: 'https://daryo.uz/ru/news',
    baseUrl: 'https://daryo.uz',
    selectors: {
      articles: '.news-item, .news-list-item',
      title: '.news-title, h3',
      link: 'a[href*="/news/"]',
      date: '.news-date, time',
    },
  },
  {
    name: 'Repost.uz',
    url: 'https://repost.uz/ru/news',
    baseUrl: 'https://repost.uz',
    selectors: {
      articles: '.news-item, .news-list-item',
      title: '.news-title, h3',
      link: 'a[href*="/news/"]',
      date: '.news-date, time',
    },
  },
  {
    name: 'Anhor.uz',
    url: 'https://anhor.uz/ru/news',
    baseUrl: 'https://anhor.uz',
    selectors: {
      articles: '.news-item, .news-list-item',
      title: '.news-title, h3',
      link: 'a[href*="/news/"]',
      date: '.news-date, time',
    },
  },
  // 吉尔吉斯斯坦
  {
    name: 'AKIpress',
    url: 'https://kg.akipress.org/news:',
    baseUrl: 'https://kg.akipress.org',
    selectors: {
      articles: '.news-item, .news-list-item',
      title: '.news-title, h3',
      link: 'a[href*="/news:"]',
      date: '.news-date, time',
    },
  },
  {
    name: 'Kaktus.media',
    url: 'https://kaktus.media/doc/news.html',
    baseUrl: 'https://kaktus.media',
    selectors: {
      articles: '.news-item, .card',
      title: '.news-title, h3',
      link: 'a[href*="/doc/"]',
      date: '.news-date, time',
    },
  },
  {
    name: 'Super.kg',
    url: 'https://super.kg/ru/news/',
    baseUrl: 'https://super.kg',
    selectors: {
      articles: '.news-item, .news-list-item',
      title: '.news-title, h3',
      link: 'a[href*="/news/"]',
      date: '.news-date, time',
    },
  },
  // 塔吉克斯坦
  {
    name: 'Avesta',
    url: 'https://avesta.tj/ru/news/',
    baseUrl: 'https://avesta.tj',
    selectors: {
      articles: '.news-item, .news-list-item',
      title: '.news-title, h3',
      link: 'a[href*="/news/"]',
      date: '.news-date, time',
    },
  },
  // 阿塞拜疆：这里**故意不配 HTML 抓取器**。
  // fetch-news 里已有 6 个实测可用的阿塞拜疆 RSS 源（AZERTAC 英/俄、Trend.az、
  // Qafqazinfo、Modern.az、Banker.az），日均可采集 200+ 条，够用。
  // 上面的抓取器选择器都是通用猜测值（.news-item / h3 / a[href*="/news/"]），
  // 对没验证过 DOM 的站点只会稳定返回 0 条并刷错误日志 —— 不如不加。
];

/**
 * Telegram 抓取结果：既有文章，也有「为什么没抓到」的**原始原因**。
 *
 * 为什么要把 error 单独带出来：旧版三种完全不同的失败 ——
 * HTTP 非 2xx / 网络层就没通（DNS、被墙、超时）/ Worker 正常但返回空 ——
 * 全都 `return []`，调用方只能看到「0 条」。于是
 * 「频道名写错」「TELEGRAM_WORKER_URL 配错」「容器根本连不上 workers.dev」
 * 在日志和接口里长得一模一样。2026-09-20 排查这个盲区花了一整轮。
 */
export interface TelegramFetchOutcome {
  articles: ScrapedArticle[];
  /** 失败原因（含 HTTP 状态码 / 网络异常原文）；成功时为 null。 */
  error: string | null;
}

/** 单次 Worker 请求的底层结果，诊断接口直接用它。 */
export interface TelegramWorkerProbe {
  channel: string;
  /** Worker 地址（未配置时为 null） */
  workerUrl: string | null;
  /** 实际请求的完整 URL —— 一眼核对 TELEGRAM_WORKER_URL 有没有多写/少写路径 */
  requestUrl: string | null;
  /** HTTP 状态码；网络层就没通时为 null */
  status: number | null;
  /** 解析出的消息条数 */
  postCount: number;
  /** 成功为 null；否则是原始错误说明 */
  error: string | null;
  latencyMs: number;
}

/**
 * 向 Cloudflare Worker 要一个频道的消息（底层实现，不做 RSSHub 兜底）。
 */
async function requestTelegramByWorker(
  channelId: string,
): Promise<{ probe: TelegramWorkerProbe; articles: ScrapedArticle[] }> {
  const workerUrl = process.env.TELEGRAM_WORKER_URL || null;
  const startedAt = Date.now();
  const base: TelegramWorkerProbe = {
    channel: channelId,
    workerUrl,
    requestUrl: null,
    status: null,
    postCount: 0,
    error: null,
    latencyMs: 0,
  };

  if (!workerUrl) {
    return {
      probe: { ...base, error: '未配置环境变量 TELEGRAM_WORKER_URL' },
      articles: [],
    };
  }

  const requestUrl = `${workerUrl.replace(/\/+$/, '')}/?channel=${encodeURIComponent(channelId)}`;
  base.requestUrl = requestUrl;

  try {
    const response = await fetch(requestUrl, { signal: AbortSignal.timeout(20000) });
    base.status = response.status;

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const error = `Worker 返回 HTTP ${response.status}${body ? `：${body.slice(0, 150)}` : ''}`;
      return { probe: { ...base, error, latencyMs: Date.now() - startedAt }, articles: [] };
    }

    const data = (await response.json()) as {
      posts?: Array<{ title?: string; url?: string; date?: string | number; summary?: string }>;
      error?: string;
    };

    const posts = Array.isArray(data?.posts) ? data.posts : [];
    const articles: ScrapedArticle[] = posts
      .filter((p) => p?.title && p?.url)
      .map((p) => ({
        title: String(p.title).trim(),
        url: String(p.url),
        publishedAt: p.date ? new Date(p.date) : null,
        summary: p.summary ? String(p.summary).trim() : undefined,
      }));

    // Worker 自己也会回 `{ posts: [], error: "..." }`（t.me 非 2xx / 频道不存在），
    // 把这个原因透传上来，别吞掉。
    const error =
      articles.length === 0 ? data?.error || 'Worker 返回 0 条（频道不存在或该频道当日无内容）' : null;

    if (articles.length > 0) {
      console.log(`[Telegram ${channelId}] 经 Worker 获取 ${articles.length} 篇文章`);
    }
    return {
      probe: { ...base, postCount: articles.length, error, latencyMs: Date.now() - startedAt },
      articles,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Telegram ${channelId}] Worker 代理抓取失败:`, message);
    // 这里最常见的两种：TimeoutError（20s 没连上）和 fetch failed（DNS / 网络不可达）。
    // 都指向「容器出不去这个域名」，而不是频道名写错。
    return {
      probe: {
        ...base,
        error: `请求 Worker 失败：${message}（常见于容器访问不了 ${workerUrl} 这个域名）`,
        latencyMs: Date.now() - startedAt,
      },
      articles: [],
    };
  }
}

async function fetchTelegramByWorker(channelId: string): Promise<TelegramFetchOutcome> {
  const { probe, articles } = await requestTelegramByWorker(channelId);
  return { articles, error: probe.error };
}

/**
 * 诊断用：只探测，返回原始结果（不做任何兜底、不改状态）。
 * 给 GET /api/telegram-check 用。
 */
export async function probeTelegramChannel(channelId: string): Promise<TelegramWorkerProbe> {
  const { probe } = await requestTelegramByWorker(channelId);
  return probe;
}

/**
 * 使用 RSSHub 获取 Telegram 频道 RSS（兜底，公共实例在大陆常不可达）
 */
async function fetchTelegramByRSSHub(channelId: string): Promise<ScrapedArticle[]> {
  const rsshubUrls = [
    `https://rsshub.app/telegram/channel/${channelId}`,
    `https://rss.shab.fun/telegram/channel/${channelId}`,
  ];

  for (const url of rsshubUrls) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) continue;

      const xml = await response.text();
      const articles: ScrapedArticle[] = [];

      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      
      while ((match = itemRegex.exec(xml)) !== null) {
        const item = match[1];
        
        const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || 
                          item.match(/<title>(.*?)<\/title>/);
        const linkMatch = item.match(/<link>(.*?)<\/link>/);
        const dateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);

        if (titleMatch && linkMatch) {
          articles.push({
            title: titleMatch[1].trim(),
            url: linkMatch[1].trim(),
            publishedAt: dateMatch ? new Date(dateMatch[1]) : null,
          });
        }
      }

      if (articles.length > 0) {
        console.log(`[Telegram ${channelId}] 获取 ${articles.length} 篇文章`);
        return articles;
      }
    } catch (error) {
      console.error(`[Telegram ${channelId}] 获取失败:`, error instanceof Error ? error.message : String(error));
    }
  }

  return [];
}

/**
 * 获取 Telegram 频道内容：优先 Cloudflare Worker 代理，其次 RSSHub 兜底。
 *
 * 两条都拿不到时，**把 Worker 那条路的原始报错带出去** —— 它才是真正配置的链路，
 * RSSHub 只是理论上存在、大陆基本连不上的兜底。旧版这里恒返回 []，
 * 于是「Worker 地址配错」和「频道名写错」在调用方看来完全一样。
 */
export async function fetchTelegramRSS(channelId: string): Promise<TelegramFetchOutcome> {
  const viaWorker = await fetchTelegramByWorker(channelId);
  if (viaWorker.articles.length > 0) return viaWorker;

  const viaRSSHub = await fetchTelegramByRSSHub(channelId);
  if (viaRSSHub.length > 0) return { articles: viaRSSHub, error: null };

  return {
    articles: [],
    error: viaWorker.error || 'Worker 与 RSSHub 兜底均未返回内容',
  };
}

/**
 * Telegram 频道映射
 */
export const TELEGRAM_CHANNELS: Record<string, string> = {
  // 哈萨克斯坦
  'kazinform': 'kazinform_official',
  'tengrinews': 'tengrinews',
  'zakon_kz': 'zakonkz',
  'nur_kz': 'newsnurkz',
  'inbusiness': 'inbusiness_kz',
  'forbes_kz': 'forbes_kz',
  'kazpravda': 'kazpravda',
  'dknews': 'dknews_kz',
  'khabar': 'khabar_tv',
  // 乌兹别克斯坦
  'kun_uz': 'kunuzofficial',
  'daryo_uz': 'daryo_live',
  'repost_uz': 'RepostUz',
  'anhor_uz': 'anhoruz',
  // 吉尔吉斯斯坦
  'akipress': 'akipress_kg',
  'kaktus': 'kaktus_media',
  'super_kg': 'super_kg',
  // 塔吉克斯坦
  'avesta': 'avesta_tj',
  // 阿塞拜疆：暂无已验证的 Telegram 频道。宁可留空，也不要凭猜写一个频道名 ——
  // 频道名写错时抓取只会静默返回空，看起来像「那天没新闻」。
};
