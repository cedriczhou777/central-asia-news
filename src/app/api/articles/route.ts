import { NextRequest, NextResponse } from 'next/server';
import { getArticles, getArticleById, type ArticleRow } from '@/lib/db-articles';

function rowToApi(row: ArticleRow) {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    content: row.content,
    country: row.country_code,
    category: row.category,
    source: row.source_name,
    sourceUrl: row.source_url,
    /**
     * 原文正文（2026-10-02 加）。
     *
     * 为什么这个字段必须出现在这里：`scripts/diagnose-push-window.ts` 靠这个接口
     * 复现「推送那一刻的漏斗」，而推送侧新增的第 0 条闸（`hasSourceBody`）判的正是
     * 这个字段。不返回它，诊断脚本就只能把这个计数**恒定显示成 0** ——
     * 那正是本项目栽过的那类坑（诊断与生产不一致 ⇒ 得出相反结论，见
     * `article-format.pushExclusionReason` 注释里的事故三）。
     *
     * 安全性：它就是源站公开发布的正文文本，本来也随 `sourceUrl` 可查；
     * 体积上实测多为 RSS 导语（中位数约 200 字），对列表接口可忽略。
     */
    originalContent: row.original_content,
    publishedAt: row.published_at,
    tags: row.tags || [],
    isFeatured: row.is_featured,
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const country = searchParams.get('country') || undefined;
  const category = searchParams.get('category') || undefined;
  const date = searchParams.get('date') || undefined;
  const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : undefined;
  const id = searchParams.get('id');

  try {
    if (id) {
      const article = await getArticleById(parseInt(id));
      if (!article) {
        return NextResponse.json({ error: '文章不存在' }, { status: 404 });
      }
      return NextResponse.json(
        { article: rowToApi(article) },
        {
          headers: {
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
          },
        },
      );
    }

    const articles = await getArticles({
      country_code: country,
      category,
      date,
      limit,
    });
    return NextResponse.json(
      { articles: articles.map(rowToApi), count: articles.length },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
