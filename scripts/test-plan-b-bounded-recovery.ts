import assert from 'node:assert/strict';
import { eligible, finalCoverageOutcome, recoverySources } from '../src/lib/plan-b-runtime';
import { checkpointInput, latestWorkCheckpoint } from '../src/lib/plan-b-checkpoint';
import { canonicalJson, freezeBlockReason, sha256, snapshot } from '../src/lib/plan-b-handoff';
import { saveClaim, type StateRow } from '../src/lib/plan-b-store';
import { planBProgressRows } from '../src/lib/plan-b-status';
import { coverageFixture } from './plan-b-fixtures';

const issue='2026-11-23',stamp=issue+'T06:30:00+08:00',hash=sha256('unchanged source');
const coverage=coverageFixture('kg',stamp);
coverage.state='blocked';coverage.pendingWork=[{sourceId:'important',kind:'article',
  url:'https://news.unit-test.example/energy-policy',reason:'article_body_pending'}];
const source=snapshot({issue,country:'kg',phase:'final',observedAt:stamp,coverage,pendingSources:['important'],candidates:[]});
const receipt={snapshot:source,cache:{path:'fixture-source',sha256:hash,bytes:12},metrics:{}};
const row:StateRow={issue_date:issue,country:'kg',step:'final',state:'blocked',attempt:2,
  receipt:{...receipt,reason:'freeze_incomplete'},updated_at:stamp,retry_after:null,lease_until:null};
const checkpoint={snapshotHash:source.hash,checkpointHash:sha256('checkpoint'),stage:'draft' as const,
  archived:{path:'fixture-checkpoint',sha256:hash,bytes:12},savedAt:stamp};
const doc={writer:{run:'writer',articles:[{id:'saved',body:'saved author text'}]},
  review:{run:'independent',completedIds:['saved']}};

assert.equal(eligible(row,Date.parse(stamp),'final'),true,'one future focused recovery after two passes');
assert.equal(eligible({...row,attempt:3},Date.parse(stamp),'final'),false,'hard attempt ceiling');
assert.equal(eligible({...row,issue_date:'2026-11-22'},Date.parse(stamp),'final'),false,'historical issue stays immutable');
assert.equal(eligible(row,Date.parse(stamp),'word'),false,'no extra Word or WeChat writes');
assert.equal(finalCoverageOutcome(receipt,1).state,'retry');
assert.equal(finalCoverageOutcome(receipt,2).state,'blocked','important body still cannot be signed');
assert.deepEqual(recoverySources({...coverage,pendingWork:[
  {sourceId:'archive',kind:'lead',url:'https://news.unit-test.example/older',reason:'unprocessed_original_lead'},
  ...coverage.pendingWork,
  {sourceId:'discovery',kind:'article',url:null,reason:'unaccounted_queue_identity'},
  ...coverage.pendingWork,
]}),['important','archive'],'prioritize concrete bodies, retain a bounded distinct source order');
assert.deepEqual(recoverySources({...coverage,pendingWork:[
  {sourceId:'first-alphabetically',kind:'article',url:'https://news.unit-test.example/one',reason:'discovered_article_needs_body_or_review'},
  {sourceId:'second-alphabetically',kind:'article',url:'https://news.unit-test.example/two',reason:'discovered_article_needs_body_or_review'},
  ...['a','b','c'].map(slug=>({sourceId:'busy-publisher',kind:'article',url:'https://news.unit-test.example/'+slug,
    reason:'discovered_article_needs_body_or_review'})),
]}),['busy-publisher','first-alphabetically'],'the second source slot follows the actual body queue instead of lexical order');
const accepted=checkpointInput({snapshotHash:source.hash,stage:'draft',
  checkpointHash:sha256(canonicalJson(doc)),document:doc},[row]);
assert.deepEqual(accepted.document,doc,'blocked snapshot can preserve merged author and reviewer work');
assert.throws(()=>checkpointInput({snapshotHash:source.hash,stage:'draft',
  checkpointHash:sha256(canonicalJson(doc)),document:doc},[{...row,receipt:{...row.receipt,workCheckpoint:checkpoint}}]),
  /checkpoint_conflict/,'stale author cannot silently overwrite a newer independent review');
assert.deepEqual(checkpointInput({snapshotHash:source.hash,stage:'review',baseCheckpointHash:checkpoint.checkpointHash,
  checkpointHash:sha256(canonicalJson(doc)),document:doc},[{...row,receipt:{...row.receipt,workCheckpoint:checkpoint}}]).document,doc);
assert.throws(()=>checkpointInput({snapshotHash:source.hash,stage:'draft',
  checkpointHash:sha256(canonicalJson(doc)),document:doc},[{...row,state:'working'}]),/checkpoint_source_changed/);
assert.equal(latestWorkCheckpoint([{...row,receipt:{...row.receipt,workCheckpoint:checkpoint,
  snapshot:{...source,hash:sha256('new source revision')}}}])?.checkpoint.snapshotHash,source.hash,
  'source changes keep old checkpoint for incremental revalidation');
assert.equal(planBProgressRows([row])[0].state,'blocked');

const reviewable=coverageFixture('kg',stamp);
reviewable.state='review_required';reviewable.gaps=[{sourceId:'ordinary',reason:'bounded_discovery',evidence:[]}];
reviewable.queues.lead=2;
reviewable.queueAccounting!.lead={total:2,pending:0,review:2,closed:0,identityHash:hash};
reviewable.reviewWork=[{sourceId:'ordinary',kind:'lead',url:null,reason:'bounded discovery',count:2,queueHash:hash}];
const closed=snapshot({...source,pendingSources:[],coverage:reviewable});
assert.equal(freezeBlockReason(closed),null,'coverage review can replace ordinary discovery blocking');
assert.equal(freezeBlockReason({...closed,coverage:{...reviewable,reviewWork:[]}}),'coverage_evidence_invalid');
assert.equal(freezeBlockReason({...closed,coverage:{...reviewable,queueAccounting:undefined}}),'coverage_evidence_invalid');

async function main(){
  const before=process.env,originalFetch=globalThis.fetch;
  process.env={...before,SUPABASE_URL:'https://db.unit-test.example',SUPABASE_ANON_KEY:'fixture-anon',SUPABASE_SERVICE_ROLE_KEY:'fixture-role'};
  let written:Record<string,unknown>|undefined,reads=0;
  globalThis.fetch=async(input,init)=>{
    const url=new URL(input instanceof Request?input.url:input.toString());
    assert.equal(url.host,'db.unit-test.example','no production connection');
    if(init?.method==='PATCH'){
      written=JSON.parse(String(init.body)) as Record<string,unknown>;
      assert.equal(url.searchParams.get('lease_id'),'eq.fixture-lease');
      return Response.json([{step:'final'}]);
    }
    reads++;return Response.json({workCheckpoint:checkpoint});
  };
  try{
    await saveClaim(issue,'kg','final','fixture-lease','blocked',receipt);
    assert.equal(reads,1);
    assert.deepEqual((written?.receipt as Record<string,unknown>).workCheckpoint,checkpoint,
      'scheduler result preserves the latest checkpoint saved before its lease');
  }finally{process.env=before;globalThis.fetch=originalFetch;}
  console.log('Bounded recovery: future-only third pass, important-body block, preserved checkpoints, queue tamper rejection and mocked lease save passed.');
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
