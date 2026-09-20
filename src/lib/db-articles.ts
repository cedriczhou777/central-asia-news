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
  if (error) throw new Error(`查询文章失败：${error.message}`);
  return (data as ArticleRow[]) || [];
}

export async function getArticleById(id: number): Promise<ArticleRow | null> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('articles')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`查询文章失败：${error.message}`);
  return data as ArticleRow | null;
}

export async function getExistingSourceUrls(urls: string[]): Promise<Set<string>> {
  if (urls.length === 0) return new Set();
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('articles')
    .select('source_url')
    .in('source_url', urls);
  if (error) throw new Error(`查询来源 URL 失败：${error.message}`);
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
  if (error) throw new Error(`插入文章失败：${error.message}`);
  return data as ArticleRow;
}

/** 待插入的一篇文章（cover_image / image_urls 会在插入前剔除，见下方说明）。 */
export interface ArticleInsert {
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
}

/** 插入结果。必须把失败明细带出去 —— 详见 insertArticles 里的说明。 */
export interface InsertResult {
  /** 真正写进库的篇数 */
  inserted: number;
  /** 失败原因（首条是整批失败的原因，其余是逐行回退时定位到的坏行） */
  errors: string[];
}

export async function insertArticles(articles: ArticleInsert[]): Promise<InsertResult> {
  if (articles.length === 0) return { inserted: 0, errors: [] };

  // 直接使用 Supabase REST API 插入数据
  const supabaseUrl = process.env.SUPABASE_URL || process.env.COZE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase 环境变量未配置');
  }

  // 暂时移除 cover_image 和 image_urls 字段，避免 schema cache 问题
  const rows = articles.map(({ cover_image, image_urls, ...rest }) => rest);

  const post = async (batch: unknown[]): Promise<{ ok: true } | { ok: false; message: string }> => {
    const response = await fetch(`${supabaseUrl}/rest/v1/articles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(batch),
    });
    if (response.ok) return { ok: true };
    const errorText = await response.text();
    return { ok: false, message: `${response.status} - ${errorText.slice(0, 400)}` };
  };

  const whole = await post(rows);
  if (whole.ok) return { inserted: rows.length, errors: [] };

  // 整批失败 → 逐行回退，不让一行坏数据毁掉整批。
  //
  // 为什么必须这样：PostgREST 的多行插入是**一条 SQL 语句**，只要有一行不合法
  // （典型是脏的 published_at 让 Postgres 拒收时间戳），整批 100+ 篇**全部**失败。
  // 而调用方旧版把这个异常吞掉、把 saved 记成 0 ——
  // 表现就是「采集 910 篇、翻译成功 295 篇、入库 0 篇，且整轮 error 为 null」，
  // 2026-09-20 早报空推的根因就是这个。
  // 逐行回退保证「坏一行不倒一片」，同时把坏行的标题和原因报出来，下次能直接定位。
  console.error(
    `[insertArticles] 整批插入失败（${rows.length} 行），回退为逐行插入。首条错误：${whole.message}`,
  );

  let inserted = 0;
  const errors: string[] = [`整批插入失败（${rows.length} 行）：${whole.message}`];
  for (const row of rows) {
    const one = await post([row]);
    if (one.ok) {
      inserted++;
    } else if (errors.length < 6) {
      const title = String((row as { title?: string }).title || '').slice(0, 40);
      errors.push(`单篇插入失败（${title}）：${one.message.slice(0, 220)}`);
    }
  }
  console.error(`[insertArticles] 逐行回退完成：成功 ${inserted}/${rows.length}，失败 ${rows.length - inserted}`);
  return { inserted, errors };
}

export async function getArticlesByDateRange(
  startDate: string,
  endDate: string,
  countryCode?: string
): Promise<ArticleRow[]> {
  const client = getSupabaseClient();
  let query = client
    .from('articles')
    .select('id, title, summary, content, country_code, category, source_name, published_at, tags')
    .gte('published_at', startDate)
    .lte('published_at', endDate)
    .order('published_at', { ascending: false });

  if (countryCode) {
    query = query.eq('country_code', countryCode);
  }

  const { data, error } = await query;
  if (error) throw new Error(`查询文章失败：${error.message}`);
  return (data as ArticleRow[]) || [];
}
