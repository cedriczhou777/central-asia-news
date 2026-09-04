import { NextRequest, NextResponse } from 'next/server';
import Parser from 'rss-parser';
import { LLMClient, Config } from 'coze-coding-dev-sdk';
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

const RSS_SOURCES: RSSSource[] = [
  { name: 'Kazinform', url: 'https://www.kazinform.kz/en/rss', country: 'kz', language: 'en' },
  { name: 'UzDaily', url: 'https://uzdaily.com/en/rss', country: 'uz', language: 'en' },
  { name: 'AKIpress', url: 'https://akipress.org/rss/', country: 'kg', language: 'en' },
  { name: 'Times Central Asia', url: 'https://timesca.com/feed', country: 'kz', language: 'en' },
  { name: 'Astana Times', url: 'https://astanatimes.com/feed/', country: 'kz', language: 'en' },
];

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

async function translateAndSummarize(
  title: string,
  content: string,
  sourceLanguage: string
): Promise<{ titleZh: string; summaryZh: string; contentZh: string }> {
  try {
    const config = new Config();
    const client = new LLMClient(config);

    const prompt = `你是一位专业的中亚地区新闻翻译编辑，服务于面向中国投资者的中亚资讯平台。

请将以下${sourceLanguage === 'en' ? '英文' : '俄文'}新闻翻译为中文，并按要求输出。

原始标题：${title}

原始内容：
${content.substring(0, 3000)}

请严格按以下 JSON 格式输出（不要输出其他内容）：
{
  "title": "翻译后的中文标题，简洁有力，适合投资资讯平台",
  "summary": "100 字以内的中文摘要，突出对投资者的关键信息",
  "content": "完整的中文翻译内容，保持原文段落结构，语言专业流畅"
}`;

    console.log('开始调用 LLM 翻译...');
    const response = await client.invoke(
      [{ role: 'user', content: prompt }],
      { model: 'doubao-seed-2-0-mini-260215', temperature: 0.3 }
    );

    console.log('LLM 响应:', response.content.substring(0, 200));

    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
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
  const limit = typeof body.limit === 'number' ? body.limit : 5;
  const skipTranslation = body.skipTranslation === true;

  // 立即返回，后台异步处理
  processFetchNews(targetDate, limit, skipTranslation).catch(err => {
    console.error('后台新闻抓取失败:', err);
  });

  return NextResponse.json({
    success: true,
    message: '新闻抓取任务已启动，后台处理中',
    date: targetDate,
    limit,
    skipTranslation,
  });
}

async function processFetchNews(targetDate: string, limit: number, skipTranslation: boolean) {
  const results: { source: string; fetched: number; saved: number; errors: string[] }[] = [];

  for (const source of RSS_SOURCES) {
    const result = { source: source.name, fetched: 0, saved: 0, errors: [] as string[] };
    try {
      const feed = await parser.parseURL(source.url);
      result.fetched = feed.items.length;

      const targetItems = limit
        ? feed.items.slice(0, limit)
        : feed.items.filter((item) => {
            if (!item.pubDate) return true;
            const itemDate = new Date(item.pubDate).toISOString().split('T')[0];
            return itemDate === targetDate;
          });

      if (targetItems.length === 0) {
        results.push(result);
        continue;
      }

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
      }> = [];

      for (const item of targetItems.slice(0, limit)) {
        try {
          const originalTitle = item.title || '';
          const originalContent = item.contentSnippet || item.content || '';
          const category = classifyCategory(originalTitle, originalContent);
          const tags = extractTags(originalTitle, originalContent);

          let titleZh = originalTitle;
          let summaryZh = originalContent.substring(0, 200);
          let contentZh = originalContent;

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
              result.errors.push(`翻译失败：${originalTitle.substring(0, 30)}`);
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
            is_featured: category === 'energy' || category === 'policy' || category === 'minerals',
          });
        } catch (err) {
          result.errors.push(`处理失败：${item.title?.substring(0, 30)}`);
        }
      }

      // Deduplicate: check existing source_urls
      let existingUrls = new Set<string>();
      if (articlesToInsert.length > 0) {
        const urls = articlesToInsert.map(a => a.source_url).filter(Boolean) as string[];
        if (urls.length > 0) {
          try {
            existingUrls = await getExistingSourceUrls(urls);
          } catch {
            // Database not available, skip deduplication
          }
        }
      }

      const newArticles = articlesToInsert.filter(a => !existingUrls.has(a.source_url));

      if (newArticles.length > 0) {
        await insertArticles(newArticles);
        result.saved = newArticles.length;
      }
    } catch (err) {
      result.errors.push(`RSS 解析失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
    results.push(result);
  }

  const totalSaved = results.reduce((sum, r) => sum + r.saved, 0);
  console.log(`新闻抓取完成：日期=${targetDate}, 共保存${totalSaved}篇`, results);
}

export async function GET() {
  return NextResponse.json({
    message: '新闻采集接口',
    usage: 'POST /api/fetch-news with optional { date: "YYYY-MM-DD", limit: 5, skipTranslation: true }',
    sources: RSS_SOURCES.map((s) => ({ name: s.name, country: s.country })),
  });
}
