import { canonicalJson, requireFrozenVersion, sha256, type Snapshot } from './plan-b-handoff';
import { issueWindow } from './plan-b-window';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');

type SignedRecord = Record<string, unknown> & { articles: Record<string, unknown>[] };
const isSignedRecord = (value: unknown): value is SignedRecord =>
  isRecord(value) && Array.isArray(value.articles) && value.articles.length <= 20 && value.articles.every(isRecord);
const hash = (value: unknown) => sha256(canonicalJson(value));

export function verifyEditorial(input: unknown, final: Snapshot) {
  if (!isRecord(input) || typeof input.finalHash !== 'string' || !strings(input.inspected)
      || !isSignedRecord(input.draft) || !isSignedRecord(input.review)) throw new Error('invalid_editorial_shape');
  const { draft, review } = input;
  const ids = review.articles.map(row => String(row.id));
  requireFrozenVersion(final, input.finalHash, input.inspected, ids);
  if ([draft, review].some(row => row.issueDate !== final.issue || row.country !== final.country)) {
    throw new Error('editorial_scope_mismatch');
  }
  const window = issueWindow(final.issue);
  if (!['windowEnd', 'coverageEnd'].every(key => Date.parse(String(draft[key])) === window.end)
      || Date.parse(String(draft.windowStart)) !== window.start) throw new Error('editorial_window_mismatch');
  if (typeof draft.writerRun !== 'string' || !draft.writerRun || typeof review.reviewer !== 'string'
      || !review.reviewer || draft.writerRun === review.reviewer || review.stage !== 'verified'
      || ['fullSourceReviewCompleted', 'titleFactReviewCompleted', 'bodyFactReviewCompleted'].some(key => review[key] !== true)
      || !Array.isArray(review.issues) || review.issues.some(i => !isRecord(i) || i.closed !== true)) {
    throw new Error('independent_review_incomplete');
  }
  if (review.originalHash !== hash(draft.articles) || review.finalBodyHash !== hash(review.articles)) {
    throw new Error('editorial_hash_mismatch');
  }
  const sources = new Map(final.candidates.map(row => [row.id, row]));
  for (const row of [...draft.articles, ...review.articles]) {
    const source = sources.get(String(row.id));
    if (!source || row.sourceHash !== source.sourceHash || row.revision !== source.revision || row.source_url !== source.sourceUrl) {
      throw new Error('frozen_source_binding_mismatch');
    }
    if (row.original_full_text !== undefined
      && (typeof row.original_full_text !== 'string' || sha256(row.original_full_text) !== source.sourceHash)) {
      throw new Error('frozen_source_text_mismatch');
    }
    if (['title','body','category','source','timeEvidence','firstPublicationCheck'].some(
      key => typeof row[key] !== 'string' || !String(row[key]).trim())) throw new Error('missing_editorial_evidence');
    const published = Date.parse(String(row.published_at));
    if (!/(?:Z|[+-]\d\d:\d\d)$/.test(String(row.published_at)) || published < window.start
      || published >= window.end || !Number.isFinite(published)
      || (source.publishedAt && published !== Date.parse(source.publishedAt))) throw new Error('story_publication_mismatch');
  }
  const value = { finalHash: final.hash, draft, review };
  return { value, editorialHash: hash(value), articleCount: ids.length,
    writerRun: draft.writerRun, reviewerRun: review.reviewer };
}
