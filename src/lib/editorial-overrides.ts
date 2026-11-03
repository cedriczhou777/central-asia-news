/** Dated, identity-bound full-body edits. Never apply an old ordinal to a new batch. */
import { EDITORIAL_OVERRIDES } from '@/data/editorial-overrides';
import type { EditorialReviewSet, EditorialIdentity } from './editorial-review-parser';
import { reviewedBodyHtml } from './review-text';

export interface EditorialOverrideOutcome {
  applied: number;
  dropped: number;
  unmatched: string[];
  skipped?: 'scope_missing' | 'different_batch';
}
export interface EditorialOverrideArticle {
  id?: number | string;
  source_url?: string | null;
  title?: string;
  summary?: string;
  content?: string;
  source_name?: string;
  review_source_urls?: string[];
}
export function normTitle(s: string): string {
  return (s || '').replace(/[\s·、，。,.:：;；"'“”‘’「」『』（）()【】\[\]—–\-]/g, '');
}
export function sameTitle(a: string, b: string): boolean { return !!normTitle(a) && normTitle(a) === normTitle(b); }

export function applyEditorialOverrides<T extends EditorialOverrideArticle>(
  countryCode: string,
  articles: T[],
  context?: { reviewDate: string; review?: EditorialReviewSet },
): { kept: T[]; outcome: EditorialOverrideOutcome } {
  const review = context?.review ?? EDITORIAL_OVERRIDES;
  const outcome: EditorialOverrideOutcome = { applied: 0, dropped: 0, unmatched: [] };
  if (!context || !review.reviewDate) return { kept: articles, outcome: { ...outcome, skipped: 'scope_missing' } };
  if (context.reviewDate !== review.reviewDate) return { kept: articles, outcome: { ...outcome, skipped: 'different_batch' } };
  const bucket = review.countries[countryCode];
  if (!bucket) return { kept: articles, outcome };
  const used = new Set<number>();
  const find = (entry: EditorialIdentity & { matchTitle: string }): number => {
    const hits: number[] = [];
    articles.forEach((article, index) => {
      if (used.has(index)) return;
      if (entry.articleId !== undefined && String(article.id) !== String(entry.articleId)) return;
      if (entry.sourceUrl && article.source_url !== entry.sourceUrl) return;
      // Legacy entries require a unique exact title within the same dated batch.
      if (entry.articleId === undefined && !entry.sourceUrl && !sameTitle(article.title || '', entry.matchTitle)) return;
      hits.push(index);
    });
    return hits.length === 1 ? hits[0] : -1;
  };
  const removed = new Set<number>();
  for (const entry of bucket.drop) {
    const index = find(entry);
    if (index < 0) { outcome.unmatched.push('[删除] ' + entry.matchTitle); continue; }
    used.add(index); removed.add(index); outcome.dropped++;
  }
  const replacements = new Map<number, T>();
  for (const entry of bucket.replace) {
    const index = find(entry);
    if (index < 0 || !entry.content?.trim() || !entry.source?.trim()) { outcome.unmatched.push('[覆盖] ' + entry.matchTitle); continue; }
    used.add(index);
    replacements.set(index, { ...articles[index], title: entry.title, summary: entry.summary,
      content: reviewedBodyHtml(articles[index].content || '', entry.content), source_name: entry.source, review_source_urls: entry.evidenceUrls });
    outcome.applied++;
  }
  return { kept: articles.flatMap((article, index) => removed.has(index) ? [] : [replacements.get(index) ?? article]), outcome };
}
export function editorialOverridesMeta(): { generatedAt: string; source: string; reviewDate: string } {
  return { generatedAt: EDITORIAL_OVERRIDES.generatedAt, source: EDITORIAL_OVERRIDES.source, reviewDate: EDITORIAL_OVERRIDES.reviewDate };
}
