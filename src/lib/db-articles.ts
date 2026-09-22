import { getSupabaseClient } from '@/storage/database/supabase-client';
import { canonicalUrl, originalTitleKey } from './utils';

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

/**
 * 一次 `.in()` 查询里最多放多少个链接。
 *
 * 40 不是随手写的：PostgREST 的 `.in()` 是把值拼进 URL query 的，一条新闻链接
 * 长度普遍 60~120 字符，几百条拼起来能到几十 KB，直接越过网关对请求行的上限
 * （典型 8KB），结果是**整个去重查询失败**而不是「查到一部分」。
 */
const URL_QUERY_CHUNK = 40;

/**
 * 返回「这批链接里哪些已经在库里」，用**归一化后的链接**比对。
 *
 * 为什么要归一化：原实现直接 `.in('source_url', urls)` 做逐字比较，
 * 而同一篇原文的链接在不同抓取路径下会带 `?from=rss`、末尾斜杠、`utm_*` 等变形，
 * 逐字比对必然漏。线上实测（2026-09-21）：最新 200 篇里 4% 是
 * source_url 逐字相同的重复行，更早的快照是 22%。
 *
 * 为什么要分批：见 {@link URL_QUERY_CHUNK}。旧版一次塞进全部链接，
 * 查询失败后被调用方 `catch` 成空集合 → **全部文章都被当成新文章** →
 * 同一批内容整体重复入库。这个「失败即放行」是重复入库的主要机制之一。
 * 现在失败一律抛出，由调用方决定降级策略。
 *
 * 返回的是**归一化后的链接集合**；调用方要用 `canonicalUrl()` 处理自己那侧再比对。
 */
export async function findExistingCanonicalUrls(urls: string[]): Promise<Set<string>> {
  const uniq = [...new Set(urls.map(canonicalUrl).filter(Boolean))];
  if (uniq.length === 0) return new Set();

  const client = getSupabaseClient();
  const found = new Set<string>();

  for (let i = 0; i < uniq.length; i += URL_QUERY_CHUNK) {
    const chunk = uniq.slice(i, i + URL_QUERY_CHUNK);
    const { data, error } = await client
      .from('articles')
      .select('source_url')
      .in('source_url', chunk);
    if (error) {
      throw new Error(
        `查询来源 URL 失败（第 ${Math.floor(i / URL_QUERY_CHUNK) + 1} 批，共 ${chunk.length} 条）：${error.message}`,
      );
    }
    for (const row of (data || []) as Array<{ source_url: string | null }>) {
      const c = canonicalUrl(row.source_url || '');
      if (c) found.add(c);
    }
  }

  return found;
}

/**
 * 取某时间窗内已入库的全部链接（归一化后），作为入库去重的**主判据**。
 *
 * 相比「拿本批链接去库里反查」（{@link findExistingCanonicalUrls}），这条路径更稳：
 *   - URL 很短（只有两个时间界），不存在请求行超限的风险；
 *   - 结果条数由时间窗决定，与本次抓取多少篇无关，可预期。
 *
 * 两天的窗口足以覆盖「同一条新闻被两天分别抓到」的情形 —— 这也是重复入库的典型场景。
 */
export async function getRecentCanonicalUrls(sinceIso: string): Promise<Set<string>> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('articles')
    .select('source_url')
    .gte('published_at', sinceIso)
    .limit(5000);
  if (error) throw new Error(`查询近窗口来源 URL 失败：${error.message}`);

  const out = new Set<string>();
  for (const row of (data || []) as Array<{ source_url: string | null }>) {
    const c = canonicalUrl(row.source_url || '');
    if (c) out.add(c);
  }
  return out;
}

/**
 * 取某时间窗内的「身份字段」全量（分页），供去重体检 / 存量清理使用。
 *
 * 为什么要分页：PostgREST 单次返回有条数上限（常见 1000），
 * 一次取「近 30 天」很容易超限，**超限时不会报错，只是悄悄少给** ——
 * 拿这样的结果去判重会漏掉重复行，拿去删更是不可接受。
 *
 * ⚠️ 窗口过滤的是 **`published_at`（文章发布日期）**，不是入库时间。
 * 排查「重复行为什么还在产生」时这是关键区别：一篇 09-18 发布、09-22 才被抓到的稿子，
 * 它的 `published_at` 落在窗口外，但它是**今天才入库**的。
 * 所以体检结果同时返回 `created_at`，用来区分「存量」与「仍在产生」——
 * 只看 `published_at` 是分不出来的。见 `dedupe-check` 的 `identicalGroups.dropInfo`。
 */
export async function getArticleIdentities(
  sinceIso: string,
  untilIso?: string,
): Promise<Array<Pick<ArticleRow, 'id' | 'title' | 'summary' | 'content' | 'category' | 'country_code' | 'source_url' | 'original_title' | 'published_at' | 'created_at'>>> {
  const client = getSupabaseClient();
  const PAGE = 1000;
  const out: Array<Pick<ArticleRow, 'id' | 'title' | 'summary' | 'content' | 'category' | 'country_code' | 'source_url' | 'original_title' | 'published_at' | 'created_at'>> = [];

  for (let from = 0; ; from += PAGE) {
    let q = client
      .from('articles')
      .select('id, title, summary, content, category, country_code, source_url, original_title, published_at, created_at')
      .gte('published_at', sinceIso)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (untilIso) q = q.lte('published_at', untilIso);

    const { data, error } = await q;
    if (error) throw new Error(`查询文章身份字段失败（offset ${from}）：${error.message}`);
    const rows = (data || []) as typeof out;
    out.push(...rows);
    if (rows.length < PAGE) break;
  }

  return out;
}

/**
 * 按 id 删除文章（存量重复行清理用）。
 *
 * 只接受显式 id 列表 —— 不提供「按条件批量删」的口子，
 * 避免哪天有人顺手写出一个「删掉所有满足某条件的行」的调用。
 */
export async function deleteArticlesByIds(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const client = getSupabaseClient();
  let deleted = 0;
  // 分批：`.in()` 的值同样拼在 URL 上，一次几百个 id 会撞上请求行长度上限。
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { error } = await client.from('articles').delete().in('id', chunk);
    if (error) throw new Error(`删除文章失败（第 ${i} 起共 ${chunk.length} 条）：${error.message}`);
    deleted += chunk.length;
  }
  return deleted;
}

/**
 * 取某时间窗内已入库的「原文标题」指纹，用于识别**同一篇原文挂在两个不同链接下**
 * （同稿多链 / 聚合站转载）。键与 `same-event.ts` 的 `original_title` 归一化必须一致。
 */
export async function getRecentOriginalTitleKeys(
  sinceIso: string,
): Promise<Map<string, number>> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('articles')
    .select('id, original_title')
    .gte('published_at', sinceIso)
    .limit(5000);
  if (error) throw new Error(`查询近窗口原文标题失败：${error.message}`);

  const out = new Map<string, number>();
  for (const row of (data || []) as Array<{ id: number; original_title: string | null }>) {
    const key = originalTitleKey(row.original_title || '');
    if (key && !out.has(key)) out.set(key, row.id);
  }
  return out;
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
    // `source_url` / `original_title` 是选稿端「同一件事」去重的身份字段，
    // 必须一起取出来 —— 少了它们，推送端只能用中文标题猜，链接和原文两条
    // 确定性判据全部失效（2026-09-21 之前就是这个状态）。
    .select('id, title, summary, content, country_code, category, source_name, source_url, original_title, published_at, tags')
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
