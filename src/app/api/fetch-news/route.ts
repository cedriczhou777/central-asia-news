import { NextRequest, NextResponse } from 'next/server';
import Parser from 'rss-parser';
import { LLMClient, Config } from 'coze-coding-dev-sdk';
import { insertArticles } from '@/lib/db-articles';

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
  { name: 'AKIpress', url: 'https://.akipress.org/rss/', country: 'kg', language: 'en' },
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
  const config = new Config();
  const client = new LLMClient(config);

  const prompt = `你是一位专业的中亚地区新闻翻译编辑，服务于面向中国投资者的中亚资讯平台。

请将以下${sourceLanguage === 'en' ? '英文' : '俄文'}新闻翻译为中文，并按要求输出。

原始标题：${title}

原始内容：
${content.substring(0, 3000)}

请严格按以下JSON格式输出（不要输出其他内容）：
{
  "title": "翻译后的中文标题，简洁有力，适合投资资讯平台",
  "summary": "100字以内的中文摘要，突出对投资者的关键信息",
  "content": "完整的中文翻译内容，保持原文段落结构，语言专业流畅"
}`;

  const response = await client.invoke(
    [{ role: 'user', content: prompt }],
    { model: 'doubao-seed-2-0-mini-260215', temperature: 0.3 }
  );

  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
    // fallback
  }

  return {
    titleZh: title,
    summaryZh: content.substring(0, 100),
    contentZh: content,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const targetDate = (body as Record<string, string>).date || new Date().toISOString().split('T')[0];
    const results: { source: string; fetched: number; saved: number; errors: string[] }[] = [];

    for (const source of RSS_SOURCES) {
      const result = { source: source.name, fetched: 0, saved: 0, errors: [] as string[] };
      try {
        const feed = await parser.parseURL(source.url);
        result.fetched = feed.items.length;

        const targetItems = feed.items.filter((item) => {
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

        for (const item of targetItems.slice(0, 10)) {
          try {
            const originalTitle = item.title || '';
            const originalContent = item.contentSnippet || item.content || '';
            const category = classifyCategory(originalTitle, originalContent);
            const tags = extractTags(originalTitle, originalContent);

            const translated = await translateAndSummarize(
              originalTitle,
              originalContent,
              source.language
            );

            articlesToInsert.push({
              title: translated.titleZh,
              summary: translated.summaryZh,
              content: translated.contentZh,
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
            result.errors.push(`翻译失败: ${item.title?.substring(0, 30)}`);
          }
        }

        if (articlesToInsert.length > 0) {
          await insertArticles(articlesToInsert);
          result.saved = articlesToInsert.length;
        }
      } catch (err) {
        result.errors.push(`RSS解析失败: ${err instanceof Error ? err.message : '未知错误'}`);
      }
      results.push(result);
    }

    const totalSaved = results.reduce((sum, r) => sum + r.saved, 0);
    return NextResponse.json({
      success: true,
      date: targetDate,
      total_saved: totalSaved,
      sources: results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    message: '新闻采集接口',
    usage: 'POST /api/fetch-news with optional { date: "YYYY-MM-DD" }',
    sources: RSS_SOURCES.map((s) => ({ name: s.name, country: s.country })),
  });
}
