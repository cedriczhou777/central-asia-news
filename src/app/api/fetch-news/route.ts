import { NextRequest, NextResponse } from 'next/server';
import Parser from 'rss-parser';
import { insertArticles, getExistingSourceUrls } from '@/lib/db-articles';
import { scrapeWebsite, CENTRAL_ASIA_SCRAPERS } from '@/lib/scraper';
import { isChineseText, isDuplicateContent } from '@/lib/utils';
import { translateNews } from '@/lib/translate';

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

// RSS 源配置（可用源）
// 说明：优先收录大陆网络可达的源。Telegram(api.telegram.org / t.me) 与 Instagram
// 在国内网络不可达（本项目部署于微信云托管/大陆服务器），无法作为自动信息源接入；
// 如需读取 Telegram 频道，请自建境外 RSSHub 桥并在 RSS_SOURCES 中声明其 telegram 镜像。
const RSS_SOURCES: RSSSource[] = [
  // 哈萨克斯坦
  { name: 'The Astana Times', url: 'https://astanatimes.com/feed/', country: 'kz', language: 'en' },
  { name: 'Egemen Qazaqstan', url: 'https://egemen.kz/rss/', country: 'kz', language: 'kk' },
  { name: 'Newtimes.kz', url: 'https://newtimes.kz/rss/', country: 'kz', language: 'ru' },
  { name: '24.kz', url: 'https://24.kz/rss/', country: 'kz', language: 'kk' },
  { name: 'Tengrinews', url: 'https://tengrinews.kz/rss_news/all.xml', country: 'kz', language: 'ru' },
  { name: 'Kazinform', url: 'https://www.inform.kz/ros/rss/news/english', country: 'kz', language: 'en' },

  // 乌兹别克斯坦
  { name: 'UzA', url: 'https://uza.uz/rss/', country: 'uz', language: 'ru' },
  { name: 'Gazeta.uz', url: 'https://gazeta.uz/rss/', country: 'uz', language: 'ru' },
  { name: 'Spot.uz', url: 'https://spot.uz/rss/', country: 'uz', language: 'ru' },
  { name: 'Uznews.uz', url: 'https://uznews.uz/rss/', country: 'uz', language: 'ru' },
  { name: 'Kun.uz', url: 'https://kun.uz/en/news/list', country: 'uz', language: 'en' },
  { name: 'Daryo.uz', url: 'https://daryo.uz/ru/feed', country: 'uz', language: 'ru' },

  // 吉尔吉斯斯坦
  { name: 'Kabar', url: 'https://kabar.kg/rus/rss', country: 'kg', language: 'ru' },
  { name: '24.kg', url: 'https://24.kg/rss/all', country: 'kg', language: 'ru' },

  // 塔吉克斯坦
  { name: 'Khovar', url: 'https://khovar.tj/rss/', country: 'tj', language: 'ru' },
  { name: 'Asia-Plus', url: 'https://asiaplustj.info/rss/', country: 'tj', language: 'ru' },
  { name: 'Avesta', url: 'https://avesta.tj/rss/', country: 'tj', language: 'ru' },

  // 土库曼斯坦
  { name: 'Turkmenistan Gov', url: 'https://www.turkmenistan.gov.tm/ru', country: 'tm', language: 'ru' },
  { name: 'Orient.tm', url: 'https://orient.tm/ru', country: 'tm', language: 'ru' },
  { name: 'Trend Kazakistan', url: 'https://www.trend.az/rss/', country: 'tm', language: 'en' },

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
  // 中亚特定
  'central asia', 'kazakhstan', 'uzbekistan', 'kyrgyzstan', 'turkmenistan', 'tajikistan',
  'silk road', 'belt and road', ' BRI',
];

// 分类关键词
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  politics: ['politic', 'president', 'parliament', 'election', 'government', 'minister', 'diplomat'],
  economy: ['economy', 'gdp', 'trade', 'export', 'import', 'investment', 'business', 'finance', 'bank'],
  policy: ['policy', 'reform', 'regulation', 'law', 'legislation', 'decree', 'strategy'],
  business_law: ['tax', 'legal', 'compliance', 'company law', 'commercial', 'corporate'],
  energy: ['oil', 'gas', 'energy', 'petroleum', 'fuel', 'pipeline', 'renewable', 'power'],
  chemicals: ['chemical', 'petrochemical', 'fertilizer', 'plastic', 'polymer'],
  minerals: ['mining', 'mineral', 'copper', 'gold', 'uranium', 'ore', 'metal', 'resource'],
  infrastructure: ['infrastructure', 'railway', 'road', 'bridge', 'construction', 'transport', 'logistics'],
  real_estate: ['real estate', 'property', 'housing', 'construction', 'building'],
  manufacturing: ['manufacturing', 'factory', 'industrial', 'production', 'textile'],
};

// 国家相关关键词（用于筛选与该国相关的新闻）
const COUNTRY_KEYWORDS: Record<string, string[]> = {
  kz: ['kazakhstan', 'kazakh', 'astana', 'almaty', 'kazakhstani', '哈萨克斯坦', '阿斯塔纳', '阿拉木图'],
  uz: ['uzbekistan', 'uzbek', 'tashkent', 'samarkand', 'uzbekistani', '乌兹别克斯坦', '塔什干', '撒马尔罕'],
  kg: ['kyrgyzstan', 'kyrgyz', 'bishkek', 'kyrgyzstani', '吉尔吉斯斯坦', '比什凯克'],
  tm: ['turkmenistan', 'turkmen', 'ashgabat', '土库曼斯坦', '阿什哈巴德'],
  tj: ['tajikistan', 'tajik', 'dushanbe', '塔吉克斯坦', '杜尚别'],
  intl: ['central asia', '中亚', 'silk road', 'belt and road', ' BRI', 'shanghai cooperation'],
};

// 判断新闻是否属于目标国家（智能判定，非仅关键词）：
// 1. 若该条内容/来源明确指向其他某个国家，则可能不归属目标国；
// 2. 目标国家关键词命中即判定相关；
// 3. 来源本身就是该国媒体（source.country === countryCode）时默认相关（该源只报道本国新闻）。
function isCountryRelevant(title: string, description: string, countryCode: string, sourceCountry: string): boolean {
  const text = `${title} ${description}`.toLowerCase();
  const keywords = COUNTRY_KEYWORDS[countryCode] || [];
  // 明确提到目标国 → 相关
  if (keywords.some(kw => text.includes(kw.toLowerCase()))) return true;
  // 来源媒体显著指向其他国家，则非目标国
  for (const [otherCountry, ows] of Object.entries(COUNTRY_KEYWORDS)) {
    if (otherCountry === countryCode || otherCountry === 'intl') continue;
    if (ows.some(kw => text.includes(kw.toLowerCase()))) {
      // 出现其它国名 = 该新闻核心是他国，排除
      return false;
    }
  }
  // 未明确指向他国：来源即该国媒体则默认相关；intl 综合源按关键词结果
  if (sourceCountry === countryCode) return true;
  return false;
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

function classifyCategory(title: string, description: string): string {
  const text = `${title} ${description}`.toLowerCase();
  let bestMatch = 'economy';
  let bestScore = 0;

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const score = keywords.filter((kw) => text.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = category;
    }
  }
  return bestMatch;
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


export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as Record<string, string | number | boolean>;
  const targetDate = (body.date as string) || new Date().toISOString().split('T')[0];
  const minPerCountry = typeof body.minPerCountry === 'number' ? body.minPerCountry : 3;
  const skipTranslation = body.skipTranslation === true;

  // 立即返回，后台异步处理
  processFetchNews(targetDate, minPerCountry, skipTranslation).catch(err => {
    console.error('后台新闻抓取失败:', err);
  });

  return NextResponse.json({
    success: true,
    message: '新闻抓取任务已启动，后台处理中',
    date: targetDate,
    minPerCountry,
    skipTranslation,
  });
}

async function processFetchNews(targetDate: string, minPerCountry: number, skipTranslation: boolean) {
  const results: { source: string; fetched: number; saved: number; errors: string[] }[] = [];
  
  // 目标日期的前一天（用于放宽到最多 2 天时间窗）
  const targetDateMinusOne = new Date(new Date(`${targetDate}T00:00:00Z`).getTime() - 86400000)
    .toISOString().split('T')[0];
  console.log(`采集时间窗：${targetDateMinusOne} ~ ${targetDate}（最多回溯 2 天）`);
  
  // 按国家分组存储候选新闻
  const candidatesByCountry: Record<string, Array<{
    item: Parser.Item;
    source: RSSSource;
    relevanceScore: number;
  }>> = {
    kz: [],
    uz: [],
    kg: [],
    tm: [],
    tj: [],
  };

  console.log(`开始采集新闻，目标日期：${targetDate}，每个国家至少 ${minPerCountry} 篇`);

  // 第一步：从所有 RSS 源采集候选新闻
  for (const source of RSS_SOURCES) {
    const result = { source: source.name, fetched: 0, saved: 0, errors: [] as string[] };
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
        
        // 检查是否与目标国家相关（智能判定：源归国兜底 / 其它国家信号排除）
        if (!isCountryRelevant(title, description, source.country, source.country)) {
          continue; // 跳过与该国无关的新闻
        }
        
        // 检查是否与投资主题相关
        if (isInvestmentRelevant(title, description)) {
          const relevanceScore = scoreInvestmentRelevance(title, description);
          candidatesByCountry[source.country]?.push({
            item,
            source,
            relevanceScore,
          });
        }
      }

      console.log(`从 ${source.name} 采集 ${targetItems.length} 篇，其中投资相关 ${candidatesByCountry[source.country]?.length || 0} 篇`);
    } catch (err) {
      result.errors.push(`RSS 解析失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
    results.push(result);
  }

  // 第一步半：使用网页爬虫补充失效的 RSS 源
  console.log('开始使用网页爬虫补充新闻...');
  for (const scraperConfig of CENTRAL_ASIA_SCRAPERS) {
    const result = { source: scraperConfig.name, fetched: 0, saved: 0, errors: [] as string[] };
    try {
      const scrapedArticles = await scrapeWebsite(scraperConfig);
      result.fetched = scrapedArticles.length;

      if (scrapedArticles.length === 0) {
        results.push(result);
        continue;
      }

      // 确定国家代码
      const countryMap: Record<string, string> = {
        'Kazinform': 'kz', 'Tengrinews': 'kz', 'Zakon.kz': 'kz', 'Nur.kz': 'kz',
        'Inbusiness.kz': 'kz', 'Forbes.kz': 'kz', 'Kazakhstanskaya Pravda': 'kz',
        'DKNews.kz': 'kz', 'Khabar': 'kz',
        'Kun.uz': 'uz', 'Daryo.uz': 'uz', 'Repost.uz': 'uz', 'Anhor.uz': 'uz',
        'AKIpress': 'kg', 'Kaktus.media': 'kg', 'Super.kg': 'kg',
        'Avesta': 'tj',
        'TDH': 'tm', 'Turkmenportal': 'tm',
      };
      const country = countryMap[scraperConfig.name] || 'intl';

      // 对每篇新闻进行投资相关性评分
      for (const article of scrapedArticles) {
        const title = article.title || '';
        const description = article.summary || '';
        
        if (isInvestmentRelevant(title, description)) {
          const relevanceScore = scoreInvestmentRelevance(title, description);
          candidatesByCountry[country]?.push({
            item: {
              title: article.title,
              link: article.url,
              pubDate: article.publishedAt?.toISOString(),
              content: article.content || article.summary || '',
              contentSnippet: article.summary || '',
            },
            source: { name: scraperConfig.name, url: scraperConfig.url, country, language: 'ru' },
            relevanceScore,
          });
        }
      }

      console.log(`[爬虫] ${scraperConfig.name} 抓取 ${scrapedArticles.length} 篇，其中投资相关 ${candidatesByCountry[country]?.length || 0} 篇`);
    } catch (err) {
      result.errors.push(`爬虫失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
    results.push(result);
  }

  // 第二步：每个国家精选至少 minPerCountry 篇新闻
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

  for (const [country, candidates] of Object.entries(candidatesByCountry)) {
    // 如果投资相关新闻不足 minPerCountry 篇，用最新新闻补充
    const selectedCandidates = candidates;
    
    if (candidates.length < minPerCountry) {
      console.log(`${country} 投资相关新闻不足（${candidates.length}篇 < ${minPerCountry}篇），将用最新新闻补充`);
      // 重新从所有源获取最新新闻作为补充
      for (const source of RSS_SOURCES.filter(s => s.country === country)) {
        try {
          const feed = await parser.parseURL(source.url);
          const latestItems = feed.items.slice(0, minPerCountry * 2); // 多取一些作为候选
          
          for (const item of latestItems) {
            // 避免重复
            const alreadyExists = candidates.some(c => c.item.link === item.link);
            if (!alreadyExists) {
              selectedCandidates.push({
                item,
                source,
                relevanceScore: 0, // 补充新闻评分为 0
              });
            }
          }
        } catch {
          // 忽略错误
        }
      }
    }

    // 按相关性评分排序，取前 minPerCountry 篇
    // 有图片的新闻优先（图片权重 +5）
    selectedCandidates.sort((a, b) => {
      const aHasImage = (a.item.contentSnippet || a.item.content || '').includes('<img') ? 5 : 0;
      const bHasImage = (b.item.contentSnippet || b.item.content || '').includes('<img') ? 5 : 0;
      return (b.relevanceScore + bHasImage) - (a.relevanceScore + aHasImage);
    });
    const selected = selectedCandidates.slice(0, Math.max(minPerCountry, selectedCandidates.length));

    console.log(`${country} 精选 ${selected.length} 篇新闻（投资相关${candidates.length}篇，补充${selected.length - candidates.length}篇）`);

    for (const { item, source } of selected) {
      try {
        const originalTitle = item.title || '';
        const originalContent = item.contentSnippet || item.content || '';
        const category = classifyCategory(originalTitle, originalContent);
        const tags = extractTags(originalTitle, originalContent);

        let titleZh = originalTitle;
        let summaryZh = originalContent.substring(0, 200);
        let contentZh = originalContent;

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

          titleZh = translated.titleZh || originalTitle;
          summaryZh = translated.summaryZh || originalContent.substring(0, 200);
          contentZh = translated.contentZh || originalContent;

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

  if (contentDeduped.length > 0) {
    try {
      await insertArticles(contentDeduped);
      console.log(`成功保存 ${contentDeduped.length} 篇到数据库`);
    } catch (insertErr) {
      console.error('插入数据库失败:', insertErr instanceof Error ? insertErr.message : insertErr);
    }
  }

  const totalSaved = results.reduce((sum, r) => sum + r.saved, 0);
  console.log(`新闻抓取完成：日期=${targetDate}, 共保存${totalSaved}篇`, results);
}

export async function GET() {
  return NextResponse.json({
    message: '新闻采集接口',
    usage: 'POST /api/fetch-news with optional { date: "YYYY-MM-DD", minPerCountry: 3, skipTranslation: true }',
    sources: RSS_SOURCES.map((s) => ({ name: s.name, country: s.country })),
  });
}
