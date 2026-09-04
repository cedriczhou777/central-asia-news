import { NextRequest, NextResponse } from 'next/server';
import { getArticlesByDateRange } from '@/lib/db-articles';
import { countries, countryList } from '@/lib/data/countries';
import { categories } from '@/lib/data/categories';
import type { CountryCode } from '@/lib/data/types';

interface CountryDigest {
  country_code: string;
  country_name: string;
  digest: string;
  article_count: number;
}

async function generateCountryDigest(
  countryCode: string,
  countryName: string,
  articles: Array<{ title: string; summary: string; category: string; source_name: string }>
): Promise<string> {
  if (articles.length === 0) {
    return `今日${countryName}暂无重要资讯。`;
  }

  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    console.error('ZHIPU_API_KEY 未配置');
    return `今日${countryName}暂无重要资讯。`;
  }

  const articlesText = articles
    .map(
      (a, i) =>
        `${i + 1}. [${categories[a.category as keyof typeof categories]?.label || a.category}] ${a.title}\n   摘要：${a.summary}\n   来源：${a.source_name}`
    )
    .join('\n\n');

  const prompt = `你是一位资深的中亚投资资讯编辑，负责为面向中国投资者的微信公众号撰写每日国家资讯汇总。

请根据以下${countryName}今日新闻，撰写一篇结构清晰、重点突出的资讯汇总文章。

要求：
1. 开头用 2-3 句话概括${countryName}今日整体态势
2. 按重要性排列，每条新闻用 1-2 句话精炼概括
3. 对投资者关心的政策变化、商业机会要特别标注
4. 语言风格：专业、简洁、有洞察力，适合商务人士快速阅读
5. 结尾可附一句简短的投资提示或关注点
6. 总字数控制在 500-800 字
7. 使用适当的 emoji 分隔段落（如📌、📊、⚡等），但不要过多

今日${countryName}新闻列表：
${articlesText}

请直接输出汇总文章内容，不要输出其他说明。`;

  try {
    console.log(`开始生成${countryName}日报...`);
    
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
        temperature: 0.5,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`智谱 AI 请求失败 (${countryName}):`, response.status, errorText);
      return `今日${countryName}暂无重要资讯。`;
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const digest = data.choices?.[0]?.message?.content || `今日${countryName}暂无重要资讯。`;
    
    console.log(`${countryName}日报生成完成，长度：${digest.length}字`);
    return digest;
  } catch (err) {
    console.error(`生成${countryName}日报失败:`, err instanceof Error ? err.message : err);
    return `今日${countryName}暂无重要资讯。`;
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const targetDate = (body as Record<string, string>).date || new Date().toISOString().split('T')[0];

    // 使用 +08:00 时区（北京时间）
    const startDate = `${targetDate}T00:00:00+08:00`;
    const endDate = `${targetDate}T23:59:59+08:00`;

    const digests: CountryDigest[] = [];

    for (const country of countryList) {
      const articles = await getArticlesByDateRange(startDate, endDate, country.code);

      const digest = await generateCountryDigest(
        country.code,
        country.name,
        articles.map((a) => ({
          title: a.title,
          summary: a.summary,
          category: a.category,
          source_name: a.source_name,
        }))
      );

      digests.push({
        country_code: country.code,
        country_name: country.name,
        digest,
        article_count: articles.length,
      });
    }

    return NextResponse.json({
      success: true,
      date: targetDate,
      digests,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    message: '每日摘要生成接口',
    usage: 'POST /api/daily-digest with optional { date: "YYYY-MM-DD" }',
  });
}
