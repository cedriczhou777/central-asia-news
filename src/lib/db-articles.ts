import { getSupabaseClient } from '@/storage/database/supabase-client';

export interface ArticleRow {
  id: number;
  title: string;
  summary: string;
  content: string;
  country_code: string;
  category: string;
  source_name: string;
  source_url: string | null;
  original_title: string | null;
  original_content: string | null;
  original_language: string | null;
  published_at: string;
  tags: string[] | null;
  is_featured: boolean;
  cover_image: string | null;
  image_urls: string[] | null;
  created_at: string;
  updated_at: string | null;
}

export async function getArticles(filters?: {
  country_code?: string;
  category?: string;
  date?: string;
  limit?: number;
}): Promise<ArticleRow[]> {
  const client = getSupabaseClient();
  let query = client
    .from('articles')
    .select('id, title, summary, content, country_code, category, source_name, source_url, published_at, tags, is_featured')
    .order('published_at', { ascending: false });

  if (filters?.country_code) {
    query = query.eq('country_code', filters.country_code);
  }
  if (filters?.category) {
    query = query.eq('category', filters.category);
  }
  if (filters?.date) {
    const start = `${filters.date}T00:00:00Z`;
    const end = `${filters.date}T23:59:59Z`;
    query = query.gte('published_at', start).lte('published_at', end);
  }
  if (filters?.limit) {
    query = query.limit(filters.limit);
  } else {
    query = query.limit(100);
  }

  const { data, error } = await query;
  if (error) throw new Error(`查询文章失败: ${error.message}`);
  return (data as ArticleRow[]) || [];
}

export async function getArticleById(id: number): Promise<ArticleRow | null> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('articles')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`查询文章失败: ${error.message}`);
  return data as ArticleRow | null;
}

export async function getExistingSourceUrls(urls: string[]): Promise<Set<string>> {
  if (urls.length === 0) return new Set();
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('articles')
    .select('source_url')
    .in('source_url', urls);
  if (error) throw new Error(`查询来源URL失败: ${error.message}`);
  return new Set((data || []).map((d: { source_url: string }) => d.source_url).filter(Boolean));
}

export async function insertArticle(article: {
  title: string;
  summary: string;
  content: string;
  country_code: string;
  category: string;
  source_name: string;
  source_url?: string;
  original_title?: string;
  original_content?: string;
  original_language?: string;
  published_at: string;
  tags?: string[];
  is_featured?: boolean;
  cover_image?: string;
  image_urls?: string[];
}): Promise<ArticleRow> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('articles')
    .insert(article)
    .select()
    .single();
  if (error) throw new Error(`插入文章失败: ${error.message}`);
  return data as ArticleRow;
}

export async function insertArticles(
  articles: Array<{
    title: string;
    summary: string;
    content: string;
    country_code: string;
    category: string;
    source_name: string;
    source_url?: string;
    original_title?: string;
    original_content?: string;
    original_language?: string;
    published_at: string;
    tags?: string[];
    is_featured?: boolean;
    cover_image?: string;
    image_urls?: string[];
  }>
): Promise<void> {
  if (articles.length === 0) return;
  const client = getSupabaseClient();
  const { error } = await client.from('articles').insert(articles);
  if (error) throw new Error(`批量插入文章失败: ${error.message}`);
}

export async function getArticlesByDateRange(
  startDate: string,
  endDate: string,
  countryCode?: string
): Promise<ArticleRow[]> {
  const client = getSupabaseClient();
  let query = client
    .from('articles')
    .select('id, title, summary, content, country_code, category, source_name, published_at, tags, cover_image, image_urls')
    .gte('published_at', startDate)
    .lte('published_at', endDate)
    .order('published_at', { ascending: false });

  if (countryCode) {
    query = query.eq('country_code', countryCode);
  }

  const { data, error } = await query;
  if (error) throw new Error(`查询文章失败: ${error.message}`);
  return (data as ArticleRow[]) || [];
}
