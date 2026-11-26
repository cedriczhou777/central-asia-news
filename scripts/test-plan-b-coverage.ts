import assert from 'node:assert/strict';
import { canonicalJson, freezeBlockReason, PLAN_B_COUNTRIES, requireFrozenVersion, sha256, snapshot,
  type Candidate, type Snapshot } from '../src/lib/plan-b-handoff';
import { verifyEditorial } from '../src/lib/plan-b-editorial';
import { summarizeUsage } from '../src/lib/plan-b-editorial-decisions';
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
const newIssue = '2026-11-27';
const newObserved = newIssue + 'T06:03:00+08:00';
Date.now = () => Date.parse(newIssue + 'T07:00:00+08:00');
const newer = Array.from({ length:20 }, (_, i) => ({...candidates[i % candidates.length],
  id:'run-news-'+i, title:'Fixed sample '+i, sourceHash:sha256('new-body-'+i), revision:sha256('new-revision-'+i),
  sourceUrl:'https://healthy-'+i%3+'.example/new-'+i, publishedAt:'2026-11-26T19:00:00+08:00' }));
const outside = {...candidates[0], id:'outside-window', publishedAt:'2026-11-26T05:59:59+08:00', previousDay:true as const};
const unresolved = {...candidates[1], id:'unverified-time', publishedAt:null, needsTimeReview:true};
const snapshotNew = snapshot({ issue:newIssue, country:'kg', phase:'final', observedAt:newObserved, pendingSources:[],
  coverage:coverageFixture('kg',newObserved), candidates:[...newer,outside,unresolved] });
assert.equal(snapshotNew.candidates.length,21,'unverified candidates remain visible; previous-day stories cannot enter');
function newEditorial(selected: typeof snapshotNew.candidates, exception = false) {
  const stories = selected.map(candidate => ({
    ...rows[0], id:candidate.id, source_url:candidate.sourceUrl, revision:candidate.revision,
    sourceHash:candidate.sourceHash, title:candidate.id, published_at:candidate.publishedAt,
  }));
  const ids = new Set(selected.map(c=>c.id));
  const decisions:Record<string,Record<string,unknown>> = Object.fromEntries(snapshotNew.candidates.map(c=>[c.id, ids.has(c.id)
    ? {decision:'selected',editorialState:'selected',reason:'Reviewed original evidence for this fixed sample.',
       firstDisclosureVerified:true,firstDisclosureEvidence:[{url:c.sourceUrl,description:'The publisher provides original time and facts.'}]}
    : {decision:'pending',editorialState:'pending_time_check',reason:'This fixture still lacks a complete timestamp.'}]));
  return { finalHash:snapshotNew.hash, inspected:snapshotNew.candidates.map(row=>row.id),
    draft:{...draft, issueDate:newIssue, windowStart:'2026-11-26T06:00:00+08:00',
      windowEnd:newIssue+'T06:00:00+08:00', coverageEnd:newIssue+'T06:00:00+08:00', articles:stories,
      ...(exception ? { quantityExceptionReview:{ status:'approved', reviewer:review.reviewer, finalHash:snapshotNew.hash,
        candidateInventoryReviewed:snapshotNew.candidates.length, reason:'Independent sources and candidate shortages individually verified.',
        reviewedAt:newObserved, evidence:[{url:newer[0].sourceUrl,observedAt:newObserved,description:'Real observations in this isolated fixed fixture.'}] } } : {})},
    review:{...review, issueDate:newIssue, articles:stories, originalHash:digest(stories), finalBodyHash:digest(stories),
      candidateDecisions:decisions } };
}
assert.throws(()=>verifyEditorial(newEditorial(newer.slice(0,5),true),snapshotNew),/daily_edition_below_minimum/);
for (const count of [6,7,8,14]) {
  assert.throws(()=>verifyEditorial(newEditorial(newer.slice(0,count)),snapshotNew),/quantity_exception_review_required/);
  const signed = newEditorial(newer.slice(0,count),true);
  assert.equal(verifyEditorial(signed,snapshotNew).articleCount,count);
  assert.throws(()=>verifyEditorial({...signed,draft:{...signed.draft,
    quantityExceptionReview:{...signed.draft.quantityExceptionReview,finalHash:'x'} }},snapshotNew),/quantity_exception_not_bound/);
}
for (const count of [15,16,20]) {
  const checked=verifyEditorial(newEditorial(newer.slice(0,count)),snapshotNew);
  assert.equal(checked.articleCount,count);
  assert.equal(checked.funnel?.pending,21-count);
}
const duplicated = newEditorial(newer.slice(0,15));
const copiedTitles = duplicated.review.articles.map((article,i)=>i===1 ? {...article,title:duplicated.review.articles[0].title+'！'} : article);
assert.throws(()=>verifyEditorial({...duplicated,review:{...duplicated.review,articles:copiedTitles,finalBodyHash:digest(copiedTitles)}},
  snapshotNew),/same_issue_story_duplicate/);
const unproved=newEditorial(newer.slice(0,15));
unproved.review.candidateDecisions[newer[0].id]={decision:'selected',editorialState:'selected',reason:'An original source must be supplied.'};
assert.throws(()=>verifyEditorial(unproved,snapshotNew),/selected_candidate_missing_first_disclosure_evidence/);
const sameEvent=newEditorial(newer.slice(0,15));
for (const id of [newer[0].id,newer[1].id]) Object.assign(sameEvent.review.candidateDecisions[id],
  {eventGroup:'project-a',eventPhase:'financing',newFact:'The same loan was announced.'});
assert.throws(()=>verifyEditorial(sameEvent,snapshotNew),/same_issue_event_stage_duplicate/);
Object.assign(sameEvent.review.candidateDecisions[newer[1].id],{eventPhase:'construction',newFact:'Construction started after the approval.'});
assert.equal(verifyEditorial(sameEvent,snapshotNew).articleCount,15);
sameEvent.review.candidateDecisions[unresolved.id] = {decision:'rejected',editorialState:'rejected_old',
  reason:'Earlier item carries the same facts as this one.'};
assert.throws(()=>verifyEditorial(sameEvent,snapshotNew),/prior_publication_evidence_required/);
sameEvent.review.candidateDecisions[unresolved.id].priorPublicationEvidence={url:outside.sourceUrl,publishedAt:outside.publishedAt,
  description:'Original disclosed before the issue window.',noNewFacts:true};
assert.equal(verifyEditorial(sameEvent,snapshotNew).funnel?.states.rejected_old,1);
delete sameEvent.review.candidateDecisions[unresolved.id];
assert.throws(()=>verifyEditorial(sameEvent,snapshotNew),/editorial_decision_ledger_incomplete/);
const shortSupply = snapshot({...snapshotNew,candidates:[...newer.slice(0,6),unresolved]});
const supplyReceipt = {snapshot:shortSupply,cache:{path:'fixture',sha256:sha256('fixture'),bytes:1},metrics:{}};
assert.equal(finalCoverageOutcome(supplyReceipt,0).state,'retry','try bounded supplementation before signing a short pool');
assert.equal(finalCoverageOutcome(supplyReceipt,1).state,'ready','editorial work may proceed while a real shortage is reported');
const usage = summarizeUsage({observations:[
  {callId:'first',stage:'triage',inputHash:sha256('fixture'),inputTokens:100,outputTokens:25},
  {callId:'second',stage:'triage',inputHash:sha256('fixture'),inputTokens:100,outputTokens:15,retry:true},
  {callId:'second',stage:'triage',inputHash:sha256('fixture')},
  {callId:'independent',stage:'independent_review',inputHash:sha256('fixture')},
]},15);
assert.equal(usage?.reportedCalls,3);
assert.equal(usage?.inputTokens,null);
assert.deepEqual(usage?.stages.triage,{calls:2,duplicateInputs:1,retries:1,inputTokens:200,outputTokens:40,measuredCalls:2});
assert.equal(usage?.stages.independent_review.inputTokens,null);
assert.equal(usage?.tokensPerAdopted,null);
Date.now = originalNow;
console.log('Plan B coverage: independent gaps, verified time, 15–20 normal target, strict window, reviewed shortfall, event eligibility and same-edition deduplication passed.');
