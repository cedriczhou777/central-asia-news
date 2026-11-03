import { createHash } from 'node:crypto';
import { htmlToText, decodeEntities } from './article-body';

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function normalizedText(text: string): string {
  return htmlToText(text).replace(/\s+/g, ' ').trim();
}

export function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Model/editor output is plain text. Only existing image URLs can survive a rewrite. */
export function reviewedBodyHtml(previousHtml: string, body: string): string {
  const images = [...previousHtml.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)]
    .map((m) => decodeEntities(m[1])).filter((url) => /^https?:\/\//i.test(url));
  const imageHtml = [...new Set(images)].map((url) => `<img src="${escapeHtml(url)}" referrerpolicy="no-referrer" />`).join('\n');
  const paragraphs = body.trim().split(/\n+/).filter(Boolean).map((p) => `<p>${escapeHtml(p.trim())}</p>`).join('\n');
  return [imageHtml, paragraphs].filter(Boolean).join('\n');
}

/** Check the artifact that will be submitted to WeChat, after all formatting. */
export function assertReviewedRendering(html: string, articles: Array<{ title: string; content: string; source_name: string }>): void {
  const rendered = normalizedText(html);
  for (const article of articles) {
    for (const [field, value] of Object.entries({ title: article.title, content: article.content, source: article.source_name })) {
      const expected = normalizedText(value);
      if (!expected || !rendered.includes(expected)) throw new Error(`成稿对账失败：${field} 未完整出现在最终 HTML（${article.title}）`);
    }
  }
}
