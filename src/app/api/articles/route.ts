import { NextRequest, NextResponse } from 'next/server';
import { getArticles, getArticleById } from '@/lib/db-articles';

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
      return NextResponse.json({ article });
    }

    const articles = await getArticles({
      country_code: country,
      category,
      date,
      limit,
    });
    return NextResponse.json({ articles, count: articles.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
