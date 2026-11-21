import assert from 'node:assert/strict';
import { PLAN_B_COUNTRIES, sha256, snapshot } from '../src/lib/plan-b-handoff';
import { planBBusinessStatus } from '../src/lib/plan-b-status';
import { planBPackageVersion } from '../src/lib/plan-b-release';
import type { StateRow } from '../src/lib/plan-b-store';
import { coverageFixture } from './plan-b-fixtures';

const issue = '2026-11-22';
const now = Date.parse(`${issue}T08:01:00+08:00`);
const hash = sha256('offline fixture');
const rows: StateRow[] = [];
for (const country of PLAN_B_COUNTRIES) {
  const version = planBPackageVersion(issue, country);
  const source = snapshot({ issue,country,phase:'final',observedAt:`${issue}T06:01:00+08:00`,
    coverage:coverageFixture(country, `${issue}T06:01:00+08:00`), pendingSources:[],
    candidates:Array.from({length:15},(_,i)=>({id:`fixture-${i}`,title:`Fixture ${i}`,revision:hash,sourceHash:hash,
      sourceUrl:`https://unit-test.example/${i}`,publishedAt:`${issue}T05:59:00+08:00`,needsTimeReview:false})) });
  const values = { final:{ snapshot:source }, editorial:{ editorialHash:hash,writerRun:'author',reviewerRun:'reviewer',articleCount:15 },
    release:{ version,editorialHash:hash,prepared:{sha256:hash} },
    word:{ version,document:{path:`${issue}/${country}/${hash}.docx`,sha256:hash,bytes:123} },
    wechat:{ version,media_id:`fixture-${country}`,verified:true } };
  for (const [step,receipt] of Object.entries(values)) rows.push({ issue_date:issue,country,
    step:step as StateRow['step'],state:'ready',attempt:1,receipt,updated_at:new Date(now).toISOString(),
    lease_until:null,retry_after:null });
}
assert.equal(planBBusinessStatus(issue, [], now).businessSucceeded, false, 'platform completed cannot create business evidence');
assert.equal(planBBusinessStatus(issue, [], now).alert?.code, 'delivery_target_missed', 'late boot catches the missed exact minute');
assert.equal(planBBusinessStatus(issue, rows, now).businessSucceeded, true);
const missingWord = rows.filter(r => !(r.country === 'kg' && r.step === 'word'));
const partial = planBBusinessStatus(issue, missingWord, now);
assert.deepEqual(partial.remainingCountries, ['kg']);
assert.equal(partial.countries.filter(c => c.wechatReady).length, 5, 'finished countries remain delivered');
assert.equal(partial.alert?.countries[0].missing.includes('word'), true);
assert.equal(planBBusinessStatus(issue, missingWord, now + 60 * 60_000).alert?.code, 'delivery_deadline_missed');
const falselyReady = structuredClone(rows);
falselyReady.find(r => r.country === 'kg' && r.step === 'wechat')!.receipt!.verified = false;
assert.equal(planBBusinessStatus(issue, falselyReady, now).businessSucceeded, false);
const duplicateMedia = structuredClone(rows);
for (const row of duplicateMedia.filter(r => r.step === 'wechat')) row.receipt!.media_id = 'same-media';
assert.equal(planBBusinessStatus(issue, duplicateMedia, now).businessSucceeded, false);
const scarcity = structuredClone(rows);
scarcity.find(r => r.country === 'kg' && r.step === 'editorial')!.receipt!.articleCount = 13;
assert.equal(planBBusinessStatus(issue, scarcity, now).normalQuantityReady, false);
assert.equal(planBBusinessStatus(issue, scarcity, now).businessSucceeded, true, 'prior enforced scarcity/release gates remain distinct from the normal count');
console.log('Plan B business status: false completion, late/missed deadline, isolated delivery, readback proof and duplicate media passed.');
