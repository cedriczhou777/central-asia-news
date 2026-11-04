/** Bounded, read-only client. Never starts a new push to recover a missing edition. */
import { readBoundedResponse } from './bounded-download';
import { isEditionDate, loadDraftArtifacts, parseDraftArtifact, type DraftArtifact } from './draft-artifacts';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getArticlesByDateRange } from './db-articles';

export const DEFAULT_NEWS_SERVICE = 'https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com';
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function serviceUrl(base: string, path: string): URL {
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('服务地址必须是HTTPS根地址，本机调试可使用loopback HTTP');
  return new URL(path, url);
}
export async function readServiceJson(url: URL, token: string | undefined, fetcher: typeof fetch): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetcher(url, { headers: token ? { Authorization: 'Bearer ' + token } : {},
    redirect: 'error', signal: AbortSignal.timeout(30_000), cache: 'no-store' });
  const raw = new TextDecoder().decode(await readBoundedResponse(response, 20 * 1024 * 1024));
  return { status: response.status, data: object(JSON.parse(raw)) };
}
export async function pullDraftArtifactsDirect(date: string, country?: string): Promise<DraftArtifact[]> {
  const artifacts: DraftArtifact[] = [];
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    const result = await loadDraftArtifacts(date, country, offset, 5);
    artifacts.push(...result.artifacts);
    if (result.nextOffset === null) {
      if (!artifacts.length) throw new Error('该日没有归档成稿；旧版本可用 --database --direct 单独恢复库中译稿');
      return artifacts;
    }
    offset = result.nextOffset;
  }
  throw new Error('成稿数量超过本轮读取预算，未输出不完整批次');
}
export async function pullDraftArtifacts(base: string, date: string, token: string, country?: string, fetcher: typeof fetch = fetch): Promise<DraftArtifact[]> {
  if (!isEditionDate(date) || !token || (country && !/^[a-z]{2}$/.test(country))) throw new Error('需要有效日期和成稿只读凭据');
  const artifacts: DraftArtifact[] = []; const seen = new Set<string>();
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    const url = serviceUrl(base, '/api/wechat/artifacts');
    url.searchParams.set('date', date); url.searchParams.set('offset', String(offset)); url.searchParams.set('limit', '5');
    if (country) url.searchParams.set('country', country);
    const result = await readServiceJson(url, token, fetcher);
    if (result.status === 404) throw new Error('该日没有归档成稿；历史原稿可用 --database 单独取回，但不能称作最终成稿');
    if (result.status !== 200) throw new Error('取稿接口失败，HTTP ' + result.status + '；检查网络规则、只读凭据与线上版本');
    if (result.data.date !== date || !Array.isArray(result.data.artifacts)) throw new Error('取稿响应日期或结构不符');
    for (const value of result.data.artifacts) {
      const artifact = parseDraftArtifact(value);
      if (artifact.editionDate !== date || (country && artifact.countryCode !== country) || seen.has(artifact.id)) throw new Error('取稿响应包含错日期、错国家或重复归档');
      seen.add(artifact.id); artifacts.push(artifact);
    }
    const next = result.data.nextOffset;
    if (next === null) return artifacts;
    if (typeof next !== 'number' || !Number.isInteger(next) || next <= offset || !result.data.artifacts.length) throw new Error('取稿分页无进展，不能输出部分结果冒充完整批次');
    offset = next;
  }
  throw new Error('取稿分页超过预算，未输出不完整批次');
}
export interface DatabaseReviewSnapshot {
  representation: 'database_translation_before_final_push_edits';
  date: string;
  window: unknown;
  pushSummary: Record<string, unknown>;
  countries: Array<{ code: string; draftTitles: string[]; articles: Record<string, unknown>[]; unmatchedTitles: string[] }>;
}
/** Recovery for editions made before archiving existed. Exact-title-only matches; no reconstructed final draft. */
export async function pullDatabaseReviewSnapshot(base: string, date: string, country?: string, fetcher: typeof fetch = fetch): Promise<DatabaseReviewSnapshot> {
  if (!isEditionDate(date) || (country && !/^[a-z]{2}$/.test(country))) throw new Error('日期或国家无效');
  const status = await readServiceJson(serviceUrl(base, '/api/wechat/push'), undefined, fetcher);
  if (status.status !== 200) throw new Error('读取推送记录失败，HTTP ' + status.status);
  const summaries = [object(object(status.data.lastRunPersisted).summary), object(object(status.data.lastRun).summary)];
  return databaseReviewSnapshot(date, country, summaries, async (code) => {
    const url = serviceUrl(base, '/api/articles'); url.searchParams.set('country', code); url.searchParams.set('limit', '500');
    const response = await readServiceJson(url, undefined, fetcher);
    if (response.status !== 200 || !Array.isArray(response.data.articles)) throw new Error('数据库文章读取失败');
    return response.data.articles.map(object);
  });
}
export async function pullDatabaseReviewSnapshotDirect(date: string, country?: string): Promise<DatabaseReviewSnapshot> {
  if (!isEditionDate(date) || (country && !/^[a-z]{2}$/.test(country))) throw new Error('日期或国家无效');
  const { data, error } = await getSupabaseClient().from('push_runs').select('summary').eq('id', 'latest').maybeSingle();
  if (error) throw new Error('推送记录只读查询失败：' + error.code);
  return databaseReviewSnapshot(date, country, [object(object(data).summary)], async (code, start, end) => {
    const rows = await getArticlesByDateRange(start, end, code);
    return rows.map((row) => ({ id: row.id, title: row.title, summary: row.summary, content: row.content,
      country: row.country_code, category: row.category, source: row.source_name, sourceUrl: row.source_url,
      originalTitle: row.original_title, originalContent: row.original_content, publishedAt: row.published_at }));
  });
}
async function databaseReviewSnapshot(date: string, country: string | undefined, summaries: Record<string, unknown>[],
  readArticles: (country: string, start: string, end: string) => Promise<Record<string, unknown>[]>): Promise<DatabaseReviewSnapshot> {
  const summary = summaries.find((s) => s.today === date && s.dryRun !== true && Array.isArray(s.draftTitles));
  if (!summary) throw new Error('没有该日期的已交付推送清单，不能把最新记录当成今天的稿件');
  const result: DatabaseReviewSnapshot = { representation: 'database_translation_before_final_push_edits', date, window: summary.window, pushSummary: summary, countries: [] };
  for (const item of summary.draftTitles as unknown[]) {
    const row = object(item);
    if (typeof row.country_code !== 'string' || !/^[a-z]{2}$/.test(row.country_code) || !Array.isArray(row.titles) || row.titles.some((t) => typeof t !== 'string')) throw new Error('推送清单格式不完整');
    if (country && row.country_code !== country) continue;
    const window = object(summary.window);
    const start = typeof window.start === 'string' ? Date.parse(window.start) : NaN;
    const end = typeof window.end === 'string' ? Date.parse(window.end) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('推送记录缺少可核实的选稿窗口');
    const sourceArticles = await readArticles(row.country_code, new Date(start).toISOString(), new Date(end).toISOString());
    const articles: Record<string, unknown>[] = []; const unmatchedTitles: string[] = [];
    for (const title of row.titles as string[]) {
      const hits = sourceArticles.filter((a) => a.country === row.country_code && a.title === title && typeof a.publishedAt === 'string'
        && Date.parse(a.publishedAt) >= start && Date.parse(a.publishedAt) <= end);
      if (hits.length !== 1) { unmatchedTitles.push(title); continue; }
      articles.push(hits[0]);
    }
    result.countries.push({ code: row.country_code, draftTitles: row.titles as string[], articles, unmatchedTitles });
  }
  if (!result.countries.length) throw new Error('该日期的已交付清单没有指定国家');
  return result;
}
