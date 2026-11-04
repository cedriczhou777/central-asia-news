/** Per-attempt copies of the exact edition sent to WeChat, using the existing push_runs table. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { textHash } from './review-text';
import type { NewsReviewArticle, NewsReviewAudit } from './news-review';
import type { WechatDraftArticle } from './wechat-drafts';
import type { buildIdentity } from './build-identity';

export const DRAFT_ARTIFACT_VERSION = 1;
export interface DraftArtifact {
  version: 1;
  id: string;
  editionDate: string;
  runStartedAt: string;
  countryCode: string;
  countryName: string;
  window: { start: string; end: string };
  capturedAt: string;
  contentHash: string;
  draft: WechatDraftArticle;
  articles: Array<NewsReviewArticle & { id: number; category: string }>;
  review: NewsReviewAudit;
  build: ReturnType<typeof buildIdentity>;
  delivery: { status: 'prepared' | 'submitted' | 'delivery_unconfirmed'; mediaId?: string; error?: string; updatedAt: string };
}
export type DraftArtifactRef = Pick<DraftArtifact, 'id' | 'countryCode' | 'contentHash'> & {
  status: DraftArtifact['delivery']['status'];
  statusPersisted: boolean;
};
export function isEditionDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function artifactReadAuthorized(header: string | null): boolean {
  const token = process.env.NEWS_ARTIFACT_READ_TOKEN;
  if (!token || !header?.startsWith('Bearer ')) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(token));
}
export function createDraftArtifact(input: Omit<DraftArtifact, 'version' | 'id' | 'contentHash' | 'capturedAt' | 'delivery'>): DraftArtifact {
  if (!isEditionDate(input.editionDate) || !/^[a-z]{2}$/.test(input.countryCode) || !input.draft.content || !input.articles.length) throw new Error('成稿归档身份或正文无效');
  const capturedAt = new Date().toISOString();
  return { ...input, version: DRAFT_ARTIFACT_VERSION,
    id: `artifact:v1:${input.editionDate}:${input.countryCode}:${randomBytes(12).toString('hex')}`,
    contentHash: textHash(input.draft.content), capturedAt,
    delivery: { status: 'prepared', updatedAt: capturedAt } };
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** A corrupt record must not silently become a complete, trustworthy export. */
export function parseDraftArtifact(value: unknown, expectedId?: string): DraftArtifact {
  const data = object(value); const draft = object(data.draft); const delivery = object(data.delivery);
  if (data.version !== 1 || typeof data.id !== 'string' || (expectedId !== undefined && data.id !== expectedId)
    || typeof data.editionDate !== 'string' || !isEditionDate(data.editionDate) || typeof data.countryCode !== 'string' || !/^[a-z]{2}$/.test(data.countryCode)
    || !/^artifact:v1:\d{4}-\d{2}-\d{2}:[a-z]{2}:[a-f0-9]{24}$/.test(data.id)
    || typeof data.runStartedAt !== 'string' || !Number.isFinite(Date.parse(data.runStartedAt))
    || typeof data.countryName !== 'string' || typeof data.capturedAt !== 'string'
    || !data.id.startsWith(`artifact:v1:${data.editionDate}:${data.countryCode}:`)
    || typeof draft.content !== 'string' || !draft.content || typeof draft.title !== 'string'
    || data.contentHash !== textHash(draft.content) || !Array.isArray(data.articles) || !data.articles.length
    || !['prepared', 'submitted', 'delivery_unconfirmed'].includes(String(delivery.status))
    || (delivery.status === 'submitted' && (typeof delivery.mediaId !== 'string' || !delivery.mediaId))) throw new Error('成稿归档结构或正文摘要校验失败');
  for (const article of data.articles as unknown[]) {
    const row = object(article);
    if (typeof row.id !== 'number' || typeof row.title !== 'string' || typeof row.content !== 'string' || typeof row.source_name !== 'string'
      || typeof row.original_content !== 'string' || typeof row.source_url !== 'string') throw new Error('成稿归档缺少逐篇正文或原文');
  }
  return data as unknown as DraftArtifact;
}
/** Archive failure is explicit; callers must not submit an edition that cannot be retrieved later. */
export async function saveDraftArtifact(artifact: DraftArtifact): Promise<void> {
  parseDraftArtifact(artifact);
  const { error } = await getSupabaseClient().from('push_runs').upsert({
    id: artifact.id, started_at: artifact.runStartedAt, finished_at: artifact.delivery.status === 'prepared' ? null : artifact.delivery.updatedAt,
    running: artifact.delivery.status === 'prepared', duration_ms: null,
    error: artifact.delivery.error ?? null, summary: artifact, updated_at: artifact.delivery.updatedAt,
  }, { onConflict: 'id' });
  if (error) throw new Error('成稿归档写入失败，不能报告已留存：' + error.code);
}
export async function loadDraftArtifacts(date: string, country: string | undefined, offset = 0, limit = 5): Promise<{ artifacts: DraftArtifact[]; nextOffset: number | null }> {
  if (!isEditionDate(date) || (country && !/^[a-z]{2}$/.test(country)) || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('成稿查询参数无效');
  const prefix = `artifact:v1:${date}:${country ? country + ':' : ''}`;
  const { data, error } = await getSupabaseClient().from('push_runs').select('id, summary')
    .like('id', prefix + '%').order('started_at', { ascending: false }).order('id', { ascending: true }).range(offset, offset + limit);
  if (error) throw new Error('成稿归档读取失败：' + error.code);
  const rows = data || [];
  const artifacts = rows.slice(0, limit).map((row) => {
    const artifact = parseDraftArtifact(row.summary, String(row.id));
    if (artifact.editionDate !== date || (country && artifact.countryCode !== country)) throw new Error('成稿归档日期或国家与查询不符');
    return artifact;
  });
  return { artifacts, nextOffset: rows.length > limit ? offset + limit : null };
}
