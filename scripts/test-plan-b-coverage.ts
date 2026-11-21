import assert from 'node:assert/strict';
import { canonicalJson, freezeBlockReason, PLAN_B_COUNTRIES, requireFrozenVersion, sha256, snapshot,
  type Candidate, type Snapshot } from '../src/lib/plan-b-handoff';
import { verifyEditorial } from '../src/lib/plan-b-editorial';
import { finalCoverageOutcome } from '../src/lib/plan-b-runtime';
import { coverageFixture } from './plan-b-fixtures';

const issue = '2026-11-21';
const at = (time: string) => `${issue}T${time}+08:00`;
const candidates: Candidate[] = Array.from({ length:15 }, (_, i) => ({ id:`news-${i}`, title:`Synthetic news ${i}`,
  sourceHash:sha256(`body-${i}`), revision:sha256(`revision-${i}`), sourceUrl:`https://healthy-${i % 3}.example/news-${i}`,
  sourceId:`healthy-${i % 3}`, family:`family-${i % 3}`, publishedAt:at('05:59:59'), needsTimeReview:false }));
const coverage = coverageFixture('kg', at('06:03:00'));
coverage.readableSources = ['healthy-0','healthy-1','healthy-2'];
coverage.state = 'review_required';
coverage.gaps = [{ sourceId:'denied', reason:'source_unavailable', evidence:[{
  url:'https://denied.example/', status:403, observedAt:at('06:01:00'), retryBudgetExhausted:false,
}] }];
const final = snapshot({ issue, country:'kg', phase:'final', observedAt:at('06:03:00'),
  pendingSources:[], coverage, candidates });
assert.equal(freezeBlockReason(final), null, 'a documented failure is a gap, not unfinished work');
const rows = candidates.map(row => ({ id:row.id, sourceHash:row.sourceHash, revision:row.revision,
  source_url:row.sourceUrl, published_at:row.publishedAt, title:'离线合成新闻', body:'固定的离线测试正文。',
  category:'产业', source:row.family, timeEvidence:'合成数据的带时区发布日期', firstPublicationCheck:'合成首次披露证据' }));
const digest = (value: unknown) => sha256(canonicalJson(value));
const draft = { issueDate:issue, country:'kg', writerRun:'fixture-author',
  windowStart:'2026-11-20T06:00:00+08:00', windowEnd:at('06:00:00'), coverageEnd:at('06:00:00'), articles:rows };
const review = { issueDate:issue, country:'kg', reviewer:'fixture-reviewer', stage:'verified', articles:rows,
  fullSourceReviewCompleted:true, titleFactReviewCompleted:true, bodyFactReviewCompleted:true,
  originalHash:digest(rows), finalBodyHash:digest(rows), issues:[] };
const body = { finalHash:final.hash, inspected:candidates.map(row => row.id), draft, review };
const check = { status:'verified', reviewer:review.reviewer, finalHash:final.hash, reviewedAt:at('06:04:00'),
  sourceIdsReviewed:[...coverage.readableSources,'denied'], criticalTopicsReviewed:['policy','energy','investment','business'],
  gapResolutions:[{ sourceId:'denied', reason:'Synthetic independent review confirms alternative coverage of critical topics.',
    alternativeCandidateIds:['news-0','news-1','news-2'] }] };

const originalNow = Date.now;
Date.now = () => Date.parse(at('07:00:00'));
try {
  assert.throws(() => verifyEditorial(body, final), /independent_coverage_review_required/);
  const approved = { ...body, review:{ ...review, coverageReview:check } };
  assert.equal(verifyEditorial(approved, final).articleCount, 15);
  assert.equal(verifyEditorial(approved, final).value.coverage, final.coverage);
  assert.throws(() => verifyEditorial({ ...approved, review:{ ...approved.review,
    coverageReview:{ ...check, criticalTopicsReviewed:['policy'] } } }, final), /independent_coverage/);
  assert.throws(() => verifyEditorial({ ...approved, review:{ ...approved.review,
    coverageReview:{ ...check, gapResolutions:[] } } }, final), /coverage_gap_resolution/);
  assert.throws(() => verifyEditorial({ ...approved, review:{ ...approved.review,
    coverageReview:{ ...check, gapResolutions:[{ ...check.gapResolutions[0], alternativeCandidateIds:['not-in-snapshot'] }] } } }, final),
    /coverage_gap_alternative_evidence/);

  const thirteen = rows.slice(0, 13);
  const scarce = { ...approved, draft:{ ...draft, articles:thirteen }, review:{ ...approved.review,
    articles:thirteen, originalHash:digest(thirteen), finalBodyHash:digest(thirteen) } };
  assert.throws(() => verifyEditorial(scarce, final), /quantity_exception_review_required/);
  assert.equal(verifyEditorial({ ...scarce, draft:{ ...scarce.draft,
    quantityExceptionReview:{ status:'approved', reviewer:review.reviewer,
      evidence:[{ url:candidates[0].sourceUrl, observedAt:at('06:03:00'), description:'Synthetic actual scarcity review evidence' }] } } }, final).articleCount, 13);

  const pending: Snapshot = { ...final, pendingSources:['denied'], coverage:{ ...coverage, state:'blocked',
    pendingWork:[{ sourceId:'denied', kind:'article', url:'https://denied.example/major-energy-policy', reason:'article_body_pending' }],
    queues:{ ...coverage.queues, article:1 } } };
  assert.throws(() => requireFrozenVersion(pending, pending.hash, body.inspected, body.inspected), /freeze_incomplete/);
  assert.equal(freezeBlockReason({ ...pending, pendingSources:[] }), 'freeze_incomplete', 'clearing source IDs cannot erase the work');

  const outcomes = PLAN_B_COUNTRIES.map((country, index) => {
    const source = index === 0 ? pending : final;
    const scoped = { ...source, country, coverage:{ ...source.coverage, country } };
    return finalCoverageOutcome({ snapshot:scoped, cache:{ path:'fixture', sha256:sha256('fixture'), bytes:1 }, metrics:{} }, 1).state;
  });
  assert.deepEqual(outcomes, ['blocked','ready','ready','ready','ready'], 'one country cannot veto the others');

  const changed = snapshot({ ...final, coverage:{ ...coverage, gaps:[{ ...coverage.gaps[0], reason:'amended-gap-evidence' }] } });
  assert.notEqual(changed.hash, final.hash);
  assert.throws(() => verifyEditorial(approved, changed), /frozen_revision_mismatch/);
} finally {
  Date.now = originalNow;
}
console.log('Plan B coverage: gap signature, critical topics, scarcity, unfinished article, per-country isolation and hashes passed.');
