import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { GET, POST } from '../src/app/api/plan-b/route';
import { canonicalJson, sha256, snapshot } from '../src/lib/plan-b-handoff';
import { coverageFixture } from './plan-b-fixtures';
import type { StateRow } from '../src/lib/plan-b-store';

const issue = '2026-11-22';
const at = (time: string) => `${issue}T${time}+08:00`;
const source = snapshot({ issue,country:'kg',phase:'preview',observedAt:at('05:20:00'),
  coverage:coverageFixture('kg',at('05:20:00')),pendingSources:[],candidates:[] });
const row: StateRow = { issue_date:issue,country:'kg',step:'preview',state:'ready',attempt:1,
  receipt:{ snapshot:source,cache:{path:'unchanged-source-cache',sha256:sha256('source'),bytes:12} },
  updated_at:at('05:21:00'),lease_until:null,retry_after:null };
const originalReceipt = canonicalJson(row.receipt);
const document = { writerRun:'fixture-author',articles:[{id:'partial',body:'未签审检查点，不能用于交付'}] };
const packed = gzipSync(canonicalJson(document));
const query = `https://unit-test.example/api/plan-b?issue=${issue}&country=kg&view=checkpoint`;
const headers = {'X-Ingest-Secret':'fixture-key','Content-Type':'application/json'};
const body = { snapshotHash:source.hash,stage:'draft',baseCheckpointHash:'',checkpointHash:sha256(canonicalJson(document)),document };
const originalFetch=globalThis.fetch, originalNow=Date.now, before=process.env;
let now=Date.parse(at('05:30:00')), uploads=0, writes=0, conflict=false, editorialAccepted=false;
process.env = {...before,REVIEWED_PLAN_B:'1',REVIEWED_PLAN_B_FIRST_ISSUE:issue,PLAN_B_INGEST_SECRET:'',INGEST_SECRET:'fixture-key',
  SUPABASE_URL:'https://db.unit-test.example',SUPABASE_ANON_KEY:'fixture-anon',SUPABASE_SERVICE_ROLE_KEY:'fixture-role'};
Date.now=()=>now;
globalThis.fetch=async (input,init) => {
  const url=new URL(input instanceof Request?input.url:input.toString());
  assert.equal(url.host,'db.unit-test.example','no production or source request is allowed');
  const method=init?.method || (input instanceof Request?input.method:'GET');
  if (url.pathname.startsWith('/storage/v1/object/')) {
    if (method==='POST') {uploads++;return Response.json({Key:'fixture-object'});}
    return new Response(packed, {headers:{'Content-Type':'application/gzip'}});
  }
  assert.equal(url.pathname,'/rest/v1/plan_b_daily');
  if (method==='PATCH') {
    writes++;
    assert.equal(url.searchParams.get('updated_at'),`eq.${row.updated_at}`,'CAS must use the observed row version');
    if (conflict) return Response.json([]);
    const data=JSON.parse(String(init?.body));
    Object.assign(row,data);
    return Response.json([{step:'preview'}]);
  }
  return Response.json(editorialAccepted ? [row,{...row,step:'editorial',receipt:{editorialHash:sha256('accepted')}}] : [row]);
};
async function main() {
  try {
    const post=()=>POST(new Request(query,{method:'POST',headers,body:JSON.stringify(body)}));
    const first=await post();assert.equal(first.status,200);
    assert.equal((await first.json()).editorialApproved,false);
    assert.equal(row.step,'preview');assert.equal(row.state,'ready');
    const {workCheckpoint,...kept}=row.receipt!;
    assert.equal(canonicalJson(kept),originalReceipt,'source cache and snapshot stay immutable');
    assert.equal(uploads,1);assert.equal(writes,1);
    assert.equal((await (await post()).json()).state,'duplicate');
    assert.equal(uploads,1,'same saved checkpoint must not be uploaded again');
    // A new request restores from the persistent pointer/object, not local role memory.
    const restored=await GET(new Request(query,{headers}));assert.equal(restored.status,200);
    assert.deepEqual((await restored.json()).document,document);
    conflict=true;body.stage='review';body.baseCheckpointHash=(workCheckpoint as {checkpointHash:string}).checkpointHash;
    const stale=await post();assert.equal(stale.status,409);
    assert.equal((await stale.json()).reason,'checkpoint_conflict');
    assert.equal(row.receipt!.workCheckpoint,workCheckpoint,'a stale writer cannot replace the saved checkpoint');
    const changed=await POST(new Request(query,{method:'POST',headers,body:JSON.stringify({...body,snapshotHash:sha256('unknown')})}));
    assert.equal(changed.status,409);
    editorialAccepted=true;
    const beforeLock=uploads;
    const locked=await post();assert.equal(locked.status,409);
    assert.equal((await locked.json()).reason,'editorial_already_accepted');
    assert.equal(uploads,beforeLock,'signed country cannot be rewritten by a partial checkpoint');
    editorialAccepted=false;conflict=false;now=Date.parse(at('06:30:00'));
    const blockedCoverage=coverageFixture('kg',at('06:25:00'));
    blockedCoverage.state='blocked';blockedCoverage.pendingWork=[{sourceId:'important',kind:'article',
      url:'https://unit-test.example/energy-policy',reason:'article_body_pending'}];
    row.step='final';row.state='blocked';row.receipt={...row.receipt,
      snapshot:snapshot({...source,phase:'final',observedAt:at('06:25:00'),coverage:blockedCoverage,pendingSources:['important']})};
    const manifest=`https://unit-test.example/api/plan-b?issue=${issue}&country=kg&phase=final&view=manifest`;
    assert.equal((await GET(new Request(manifest,{headers}))).status,409);
    const cached=await (await GET(new Request(manifest+'&allowBlocked=1',{headers}))).json();
    assert.equal(cached.state,'blocked');assert.equal(cached.formalSubmissionAllowed,false);
    assert.equal(cached.authorCheckpointAllowed,true);
    const retained=await (await GET(new Request(query,{headers}))).json();
    assert.deepEqual(retained.document,document);
    assert.equal(retained.sourceSnapshotChanged,true,'new source revision does not erase saved author and review work');
    now=Date.parse(at('09:00:00'));
    assert.equal((await post()).status,409,'no new handoff at the deadline');
    console.log('Plan B checkpoint: private persistence/recovery, exact hashes, idempotence, CAS conflict and no editorial approval passed.');
  } finally {globalThis.fetch=originalFetch;Date.now=originalNow;process.env=before;}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
