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
  // 土库曼斯坦
  {
    name: 'TDH',
    url: 'https://tdh.gov.tm/ru/news/',
    baseUrl: 'https://tdh.gov.tm',
    selectors: {
      articles: '.news-item, .news-list-item',
      title: '.news-title, h3',
      link: 'a[href*="/news/"]',
      date: '.news-date, time',
    },
  },
  {
    name: 'Turkmenportal',
    url: 'https://turkmenportal.com/ru/news',
    baseUrl: 'https://turkmenportal.com',
    selectors: {
      articles: '.news-item, .news-list-item',
      title: '.news-title, h3',
      link: 'a[href*="/news/"]',
      date: '.news-date, time',
    },
  },
];

/**
 * 通过 Cloudflare Worker 代理获取 Telegram 频道消息。
 *
 * Telegram（t.me / api.telegram.org）在大陆网络不可达（本项目部署于微信云托管）。
 * 因此优先请求用户自建的境外 Cloudflare Worker（一个"转发桥"），由 Worker 就近
 * 访问 Telegram API 并把最近消息以 JSON 返回到本项目。Worker 地址来自环境变量
 * `TELEGRAM_WORKER_URL`（例如 https://your-worker.workers.dev）。
 *
 * 只有在配置了 `TELEGRAM_WORKER_URL` 时才启用；未配置或调用失败时如实记录并跳过，
 * 不会伪造返回假文章。
 */
async function fetchTelegramByWorker(channelId: string): Promise<ScrapedArticle[]> {
  const workerUrl = process.env.TELEGRAM_WORKER_URL;
  if (!workerUrl) {
    console.log(`[Telegram ${channelId}] 未配置 TELEGRAM_WORKER_URL，跳过 Worker 代理抓取`);
    return [];
  }

  try {
    const url = `${workerUrl.replace(/\/+$/, '')}/?channel=${encodeURIComponent(channelId)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });

    if (!response.ok) {
      console.error(`[Telegram ${channelId}] Worker 返回 ${response.status}`);
      return [];
    }

    const data = (await response.json()) as {
      posts?: Array<{ title?: string; url?: string; date?: string | number; summary?: string }>;
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

    if (articles.length > 0) {
      console.log(`[Telegram ${channelId}] 经 Worker 获取 ${articles.length} 篇文章`);
    }
    return articles;
  } catch (error) {
    console.error(`[Telegram ${channelId}] Worker 代理抓取失败:`, error instanceof Error ? error.message : String(error));
    return [];
  }
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
 */
export async function fetchTelegramRSS(channelId: string): Promise<ScrapedArticle[]> {
  const viaWorker = await fetchTelegramByWorker(channelId);
  if (viaWorker.length > 0) return viaWorker;

  const viaRSSHub = await fetchTelegramByRSSHub(channelId);
  return viaRSSHub;
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
  // 土库曼斯坦
  'tdh': 'tdh_gov_tm',
  'turkmenportal': 'turkmenportal',
};
