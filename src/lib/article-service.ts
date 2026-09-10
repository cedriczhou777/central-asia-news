import { getArticles as getDbArticles, type ArticleRow } from '@/lib/db-articles';
import { getArticles as getMockArticles, type NewsArticle } from '@/lib/data/articles';
import { splitContentImage } from '@/lib/utils';
import type { CountryCode, Category } from '@/lib/data/types';

export type DisplayArticle = {
  id: string;
  title: string;
  summary: string;
  content: string;
  coverImage?: string | null;
  country: CountryCode;
  category: Category;
  source: string;
  sourceUrl: string;
  publishedAt: string;
  tags: string[];
  isFeatured?: boolean;
};

function dbRowToDisplay(row: ArticleRow): DisplayArticle {
  const { coverImage, textContent } = splitContentImage(row.content);
  return {
    id: String(row.id),
    title: row.title,
    summary: row.summary,
    content: textContent,
    coverImage,
    country: row.country_code as CountryCode,
    category: row.category as Category,
    source: row.source_name,
    sourceUrl: row.source_url || '',
    publishedAt: row.published_at,
    tags: row.tags || [],
    isFeatured: row.is_featured,
  };
}

function mockToDisplay(article: NewsArticle): DisplayArticle {
  return {
    id: article.id,
    title: article.title,
    summary: article.summary,
    content: article.content,
    country: article.country,
    category: article.category,
    source: article.source,
    sourceUrl: article.sourceUrl,
    publishedAt: article.publishedAt,
    tags: article.tags,
    isFeatured: article.isFeatured,
  };
}

export async function fetchDisplayArticles(filters?: {
  country?: string;
  category?: string;
  limit?: number;
}): Promise<DisplayArticle[]> {
  try {
    const dbArticles = await getDbArticles({
      country_code: filters?.country,
      category: filters?.category,
      limit: filters?.limit || 50,
    });
    if (dbArticles.length > 0) {
      return dbArticles.map(dbRowToDisplay);
    }
  } catch {
    // Database not available, fallback to mock
  }

  const mockArticles = getMockArticles({
    country: filters?.country,
    category: filters?.category,
  });
  return mockArticles.slice(0, filters?.limit || 50).map(mockToDisplay);
}

export async function fetchDisplayArticleById(id: string): Promise<DisplayArticle | null> {
  if (!isNaN(parseInt(id))) {
    try {
      const { getArticleById } = await import('@/lib/db-articles');
      const row = await getArticleById(parseInt(id));
      if (row) return dbRowToDisplay(row);
    } catch {
      // fallback
    }
  }

  const { getArticleById: getMockById } = await import('@/lib/data/articles');
  const mock = getMockById(id);
  return mock ? mockToDisplay(mock) : null;
}

export async function fetchFeaturedArticles(): Promise<DisplayArticle[]> {
  try {
    const dbArticles = await getDbArticles({ limit: 5 });
    if (dbArticles.length > 0) {
      return dbArticles
        .filter((a) => a.is_featured)
        .slice(0, 5)
        .map(dbRowToDisplay);
    }
  } catch {
    // fallback
  }

  const { getFeaturedArticles } = await import('@/lib/data/articles');
  return getFeaturedArticles().map(mockToDisplay);
}
