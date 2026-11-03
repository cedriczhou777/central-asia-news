/** WeChat cloud-call adapter. Known IDs from the same edition are updated, not recreated. */
export interface WechatDraftArticle {
  title: string; author: string; content: string; digest: string;
  thumbMediaId: string; needOpenComment: number; onlyFansCanComment: number;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function existingDraftsForWindow(summary: unknown, start: string, end: string): Map<string, string> {
  const data = object(summary); const window = object(data.window);
  const result = new Map<string, string>();
  if (data.dryRun === true || window.start !== start || window.end !== end) return result;
  for (const entry of [...(Array.isArray(data.allWindowDrafts) ? data.allWindowDrafts : []), ...(Array.isArray(data.drafts) ? data.drafts : [])]) {
    const row = object(entry);
    if (typeof row.country_code === 'string' && typeof row.media_id === 'string' && row.media_id) result.set(row.country_code, row.media_id);
  }
  return result;
}
export async function submitWechatDraft(base: string, articles: WechatDraftArticle[], existingId?: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (articles.length !== 1) throw new Error('每个国别草稿必须恰好包含一篇汇总稿');
  const data = articles.map((a) => ({ title: a.title, author: a.author, content: a.content, digest: a.digest,
    thumb_media_id: a.thumbMediaId, need_open_comment: a.needOpenComment, only_fans_can_comment: a.onlyFansCanComment }));
  const response = await fetcher(base + (existingId ? '/draft/update' : '/draft/add'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(existingId ? { media_id: existingId, index: 0, articles: data[0] } : { articles: data }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error('微信草稿接口 HTTP ' + response.status);
  const payload = object(await response.json());
  if (payload.errcode) throw new Error('微信草稿接口失败：' + String(payload.errcode) + ' ' + String(payload.errmsg || ''));
  const mediaId = existingId || (typeof payload.media_id === 'string' ? payload.media_id : '');
  if (!mediaId) throw new Error('微信没有返回草稿ID，不能报告创建成功');
  return mediaId;
}
