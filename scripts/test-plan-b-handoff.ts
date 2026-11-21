import assert from 'node:assert/strict';
import { changes, requireFrozenVersion, retryableStatus, sha256, snapshot, canonicalJson, type Candidate } from '../src/lib/plan-b-handoff';
import { planBClock, issueWindow } from '../src/lib/plan-b-window';
import { verifyEditorial } from '../src/lib/plan-b-editorial';
import { coverageFixture } from './plan-b-fixtures';

const issue = '2026-11-22';
const at = (stamp: string) => `${issue}T${stamp}+08:00`;
const clock = (stamp: string) => planBClock(Date.parse(at(stamp)));
const window = issueWindow(issue);
assert.equal(window.end - window.start, 86_400_000);
assert.equal(clock('04:44:59').previewAllowed, false);
assert.equal(clock('04:45:00').previewAllowed, true);
assert.equal(clock('05:30:00').previewAllowed, true);
assert.equal(clock('05:59:59').finalizationAllowed, false);
assert.equal(clock('06:00:00').finalizationAllowed, true);
assert.equal(clock('08:59:59').finalizationAllowed, true);
assert.equal(clock('09:00:00').finalizationAllowed, false);
assert.equal(clock('09:00:00').reconcileAllowed, true);
assert.equal(clock('09:29:59').reconcileAllowed, true);
assert.equal(clock('09:30:00').reconcileAllowed, false);
assert.equal(planBClock(Date.parse('2026-11-21T06:30:00+08:00')).finalizationAllowed, false);

function entry(id: string, published: string, update = 'one'): Candidate {
  return { id, title: id, sourceHash: sha256(id), revision: sha256(id + update), sourceUrl: `https://example.org/${id}`,
    publishedAt: published, needsTimeReview: false };
}
const current = entry('still', at('05:22:00'));
const modified = entry('updated', at('05:01:00'));
const added = entry('late', at('05:59:59'));
const removed = entry('withdrawn', at('05:25:00'));
const envelope = { issue, country: 'kz' as const, pendingSources: [] };
const early = snapshot({ ...envelope, coverage:coverageFixture('kz', at('05:30:03')),
  phase:'preview', observedAt: at('05:30:03'), candidates: [current, modified, removed, added] });
assert.equal(early.provisional, true);
assert.deepEqual(early.candidates.map(row => row.id), ['still','updated','withdrawn']);
const final = snapshot({ ...envelope, coverage:coverageFixture('kz', at('06:03:30')), phase:'final', observedAt: at('06:03:30'),
  candidates: [current, added, { ...modified, revision: sha256('amended') }, entry('tomorrow', at('06:00:00')),
    entry('tooOld', '2026-11-21T05:59:59+08:00'), entry('border', '2026-11-21T06:00:00+08:00')] });
const delta = changes(early, final);
assert.deepEqual(delta.retained, ['still']);
assert.deepEqual(delta.added.map(row => row.id), ['border', 'late']);
assert.deepEqual(delta.changed.map(row => row.id), ['updated']);
assert.deepEqual(delta.removed, ['withdrawn']);
assert.throws(() => requireFrozenVersion(early, early.hash, ['still'], ['still']), /freeze_incomplete/);
assert.throws(() => requireFrozenVersion({ ...final, pendingSources: ['publisher-timeout'] }, final.hash, ['still'], ['still']), /freeze_incomplete/);
assert.throws(() => requireFrozenVersion(final, early.hash, ['still'], ['still']), /frozen_revision_mismatch/);
assert.throws(() => requireFrozenVersion(final, final.hash, ['still'], ['still']), /frozen_candidate_ack_incomplete/);
assert.throws(() => requireFrozenVersion(final, final.hash, final.candidates.map(row => row.id), ['withdrawn']), /selection_outside_frozen_snapshot/);
assert.deepEqual([403,404,429,503,null].map(retryableStatus), ['stop','stop','rate_limited','transient','transient']);

const article = { id: current.id, source_url: current.sourceUrl, sourceHash: current.sourceHash, revision: current.revision,
  published_at: current.publishedAt, title: '离线样例', category: '示例', body: '这是合成测试。', source: '示例出版社',
  timeEvidence: '原文日期字段', firstPublicationCheck: '首次披露字段' };
const articles = [article];
const digest = sha256(canonicalJson(articles));
const draft = { issueDate: issue, country:'kz', windowStart: '2026-11-21T06:00:00+08:00', windowEnd: at('06:00:00'),
  coverageEnd: at('06:00:00'), writerRun: 'author-fixture', articles };
const review = { issueDate: issue, country:'kz', reviewer: 'reviewer-fixture', stage: 'verified',
  fullSourceReviewCompleted: true, titleFactReviewCompleted: true, bodyFactReviewCompleted: true,
  originalHash: digest, finalBodyHash: digest, issues: [], articles };
const body = { finalHash: final.hash, inspected: final.candidates.map(row => row.id), draft, review };
assert.equal(verifyEditorial(body, final).articleCount, 1);
assert.equal(verifyEditorial(body, final).editorialHash, verifyEditorial(structuredClone(body), final).editorialHash);
assert.throws(() => verifyEditorial({ ...body, review: { ...review, reviewer: draft.writerRun } }, final), /independent_review/);
assert.throws(() => verifyEditorial({ ...body, review: { ...review, finalBodyHash: early.hash } }, final), /editorial_hash/);
assert.throws(() => verifyEditorial({ ...body, inspected: ['still'] }, final), /frozen_candidate_ack/);
console.log('Plan B: Beijing time, preview/freeze/delta, independent signature and retry classification passed.');
