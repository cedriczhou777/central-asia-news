import { NextRequest, NextResponse } from 'next/server';
import Parser from 'rss-parser';
import { insertArticles, getExistingSourceUrls } from '@/lib/db-articles';

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'CentralAsiaNewsBot/1.0' },
});

interface RSSSource {
  name: string;
  url: string;
  country: string;
  language: string;
}

// 更新后的 RSS 源配置
const RSS_SOURCES: RSSSource[] = [
  // 哈萨克斯坦
  { name: 'Kazinform', url: 'https://www.kazinform.kz/rss/', country: 'kz', language: 'ru' },
  { name: 'Tengrinews', url: 'https://tengrinews.kz/rss/', country: 'kz', language: 'ru' },
  { name: 'Zakon.kz', url: 'https://www.zakon.kz/rss/', country: 'kz', language: 'ru' },
  { name: 'Nur.kz', url: 'https://www.nur.kz/rss/', country: 'kz', language: 'ru' },
  { name: 'Inbusiness.kz', url: 'https://inbusiness.kz/rss/', country: 'kz', language: 'ru' },
  { name: 'The Astana Times', url: 'https://astanatimes.com/feed/', country: 'kz', language: 'en' },
  { name: 'Forbes.kz', url: 'https://forbes.kz/rss/', country: 'kz', language: 'ru' },
  { name: 'Egemen Qazaqstan', url: 'https://egemen.kz/rss/', country: 'kz', language: 'kk' },
  { name: 'Kazakhstanskaya Pravda', url: 'https://kazpravda.kz/rss/', country: 'kz', language: 'ru' },
  { name: 'DKNews.kz', url: 'https://dknews.kz/rss/', country: 'kz', language: 'ru' },
  { name: 'Newtimes.kz', url: 'https://newtimes.kz/rss/', country: 'kz', language: 'ru' },
  { name: '24.kz', url: 'https://24.kz/rss/', country: 'kz', language: 'kk' },
  { name: 'Khabar', url: 'https://khabar.kz/rss/', country: 'kz', language: 'kk' },

  // 乌兹别克斯坦
  { name: 'UzA', url: 'https://uza.uz/rss/', country: 'uz', language: 'ru' },
  { name: 'Kun.uz', url: 'https://kun.uz/rss/', country: 'uz', language: 'uz' },
  { name: 'Daryo.uz', url: 'https://daryo.uz/rss/', country: 'uz', language: 'uz' },
  { name: 'Gazeta.uz', url: 'https://gazeta.uz/rss/', country: 'uz', language: 'ru' },
  { name: 'Spot.uz', url: 'https://spot.uz/rss/', country: 'uz', language: 'ru' },
  { name: 'Repost.uz', url: 'https://repost.uz/rss/', country: 'uz', language: 'ru' },
  { name: 'Anhor.uz', url: 'https://anhor.uz/rss/', country: 'uz', language: 'ru' },
  { name: 'Uznews.uz', url: 'https://uznews.uz/rss/', country: 'uz', language: 'ru' },

  // 吉尔吉斯斯坦
  { name: 'Kabar', url: 'https://kabar.kg/rss/', country: 'kg', language: 'ru' },
  { name: 'AKIpress', url: 'https://kg.akipress.org/rss/', country: 'kg', language: 'en' },
  { name: '24.kg', url: 'https://24.kg/rss/', country: 'kg', language: 'ru' },
  { name: 'Kaktus.media', url: 'https://kaktus.media/rss/', country: 'kg', language: 'ru' },
  { name: 'Super.kg', url: 'https://super.kg/rss/', country: 'kg', language: 'ru' },
  { name: 'Azattyk', url: 'https://www.azattyk.org/rss/', country: 'kg', language: 'ky' },

  // 塔吉克斯坦
  { name: 'Khovar', url: 'https://khovar.tj/rss/', country: 'tj', language: 'ru' },
  { name: 'Asia-Plus', url: 'https://asiaplustj.info/rss/', country: 'tj', language: 'ru' },
  { name: 'Avesta', url: 'https://avesta.tj/rss/', country: 'tj', language: 'ru' },

  // 土库曼斯坦
  { name: 'TDH', url: 'https://tdh.gov.tm/rss/', country: 'tm', language: 'ru' },
  { name: 'Turkmenportal', url: 'https://turkmenportal.com/rss/', country: 'tm', language: 'ru' },

  // 区域综合媒体
  { name: 'The Times of Central Asia', url: 'https://timesca.com/feed/', country: 'intl', language: 'en' },
  { name: 'Eurasianet', url: 'https://eurasianet.org/rss', country: 'intl', language: 'en' },
  { name: 'RFE/RL Central Asia', url: 'https://www.rferl.org/rss/', country: 'intl', language: 'en' },

  // 国际媒体
  { name: 'Reuters', url: 'https://feeds.reuters.com/reuters/worldNews', country: 'intl', language: 'en' },
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

async function translateAndSummarize(
  title: string,
  content: string,
  sourceLanguage: string
): Promise<{ titleZh: string; summaryZh: string; contentZh: string }> {
  try {
    const apiKey = process.env.ZHIPU_API_KEY;
    if (!apiKey) {
      console.error('ZHIPU_API_KEY 未配置');
      return {
        titleZh: title,
        summaryZh: content.substring(0, 100),
        contentZh: content,
      };
    }

    const prompt = `你是一位专业的中亚地区新闻翻译编辑，服务于面向中国投资者的中亚资讯平台。

请将以下${sourceLanguage === 'en' ? '英文' : sourceLanguage === 'ru' ? '俄文' : '其他语言'}新闻翻译为中文，并按要求输出。

原始标题：${title}

原始内容：
${content}

请严格按以下 JSON 格式输出（不要输出其他内容）：
{
  "title": "翻译后的中文标题，简洁有力，适合投资资讯平台",
  "summary": "100 字以内的中文摘要，突出对投资者的关键信息",
  "content": "完整的中文翻译内容，保持原文段落结构，语言专业流畅。如果原文中有图片 URL，直接保留为 HTML img 标签格式：<img src='图片 URL' style='width:100%; border-radius:8px; margin:15px 0;' />"
}`;

    console.log('开始调用智谱 AI 翻译...');
    
    const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'glm-4',
        messages: [
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('智谱 AI 请求失败:', response.status, errorText);
      return {
        titleZh: title,
        summaryZh: content.substring(0, 100),
        contentZh: content,
      };
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const llmContent = data.choices?.[0]?.message?.content || '';
    
    console.log('智谱 AI 响应:', llmContent.substring(0, 200));

    try {
      const jsonMatch = llmContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          titleZh: parsed.title || title,
          summaryZh: parsed.summary || content.substring(0, 100),
          contentZh: parsed.content || content,
        };
      }
    } catch (parseErr) {
      console.error('JSON 解析失败:', parseErr);
    }

    return {
      titleZh: title,
      summaryZh: content.substring(0, 100),
      contentZh: content,
    };
  } catch (err) {
    console.error('LLM 调用失败:', err instanceof Error ? err.message : err);
    return {
      titleZh: title,
      summaryZh: content.substring(0, 100),
      contentZh: content,
    };
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
  
  // 按国家分组存储候选新闻
  const candidatesByCountry: Record<string, Array<{
    item: any;
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

      // 筛选目标日期的新闻
      const targetItems = feed.items.filter((item) => {
        if (!item.pubDate) return true;
        const itemDate = new Date(item.pubDate).toISOString().split('T')[0];
        return itemDate === targetDate;
      });

      if (targetItems.length === 0) {
        results.push(result);
        continue;
      }

      // 对每篇新闻进行投资相关性评分
      for (const item of targetItems) {
        const title = item.title || '';
        const description = item.contentSnippet || item.content || '';
        
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
    if (candidates.length === 0) {
      console.log(`${country} 没有投资相关新闻，将抓取最新新闻`);
      continue;
    }

    // 按相关性评分排序，取前 minPerCountry 篇
    candidates.sort((a, b) => b.relevanceScore - a.relevanceScore);
    const selected = candidates.slice(0, Math.max(minPerCountry, candidates.length));

    console.log(`${country} 精选 ${selected.length} 篇投资相关新闻`);

    for (const { item, source } of selected) {
      try {
        const originalTitle = item.title || '';
        const originalContent = item.contentSnippet || item.content || '';
        const category = classifyCategory(originalTitle, originalContent);
        const tags = extractTags(originalTitle, originalContent);

        let titleZh = originalTitle;
        let summaryZh = originalContent.substring(0, 200);
        let contentZh = originalContent;

        // 提取图片
        const imageUrls = extractImagesFromHtml(originalContent);
        const coverImage = imageUrls[0] || '';

        if (!skipTranslation) {
          try {
            const translated = await translateAndSummarize(
              originalTitle,
              originalContent,
              source.language
            );
            titleZh = translated.titleZh || originalTitle;
            summaryZh = translated.summaryZh || originalContent.substring(0, 200);
            contentZh = translated.contentZh || originalContent;
          } catch (err) {
            console.error(`翻译失败：${originalTitle.substring(0, 30)}`, err);
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
  console.log(`去重后剩余 ${newArticles.length} 篇新文章`);

  if (newArticles.length > 0) {
    try {
      await insertArticles(newArticles);
      console.log(`成功保存 ${newArticles.length} 篇到数据库`);
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
