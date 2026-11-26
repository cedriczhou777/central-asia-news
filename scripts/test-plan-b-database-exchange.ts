import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {originalRecord,processExchange,publishScan,wordChunks} from '../src/lib/plan-b-exchange';
import {applyPlanBCommand} from '../src/lib/plan-b-command';
import {validManualGrant} from '../src/lib/reviewed-manual-authorization';
import {sha256} from '../src/lib/plan-b-handoff';
import {checkpointInput} from '../src/lib/plan-b-checkpoint';
import {canonicalJson} from '../src/lib/plan-b-handoff';
import type {SnapshotReceipt,StateRow} from '../src/lib/plan-b-store';
import {coverageFixture} from './plan-b-fixtures';
import {snapshot} from '../src/lib/plan-b-handoff';

const body='Fixed existing source text — no news request or model call.';
const c={id:'one',revision:sha256('revision'),sourceHash:sha256(body)};
const wordBytes=Buffer.alloc(1_500_000,7);const parts=[...wordChunks({sha256:sha256(wordBytes),bytes:wordBytes.length},wordBytes)];
assert.equal(parts.length,6);assert.equal(sha256(Buffer.concat(parts.map(p=>Buffer.from(p.base64,'base64')))),sha256(wordBytes));
assert(parts.every(p=>p.base64.length<400_000));
assert.equal(originalRecord(c,{id:c.id,sourceHash:c.sourceHash,text:body}).original.text,body);
assert.throws(()=>originalRecord(c,{id:c.id,sourceHash:c.sourceHash,text:body+'changed'}),/hash_mismatch/);
const at=Date.parse('2026-11-24T10:00:00+08:00');
const grant={issue:'2026-11-24',version:'2026-11-24',contentHash:sha256('content'),countries:['kz'],
  issuedBy:'owner-explicit-approval',reason:'Specific overdue issue approved by owner',expiresAt:new Date(at+3600000).toISOString()};
const created=new Date(at-1000).toISOString();
assert(validManualGrant(grant,created,grant.issue,grant.version,grant.contentHash,['kz'],at));
for(const [issue,version,hash,countries,now]of [
 ['2026-11-25',grant.version,grant.contentHash,['kz'],at],
 [grant.issue,'2026-11-24-r2',grant.contentHash,['kz'],at],
 [grant.issue,grant.version,sha256('changed'),['kz'],at],
 [grant.issue,grant.version,grant.contentHash,['uz'],at],
 [grant.issue,grant.version,grant.contentHash,['kz'],at+7200000],
]as const)assert(!validManualGrant(grant,created,issue,version,hash,countries,now));
// Same coordinator merges both roles; stale second writer cannot replace either.
const document={authorDraft:[{id:'author-a'}],reviewed:[{id:'review-b'}]};
const snapshotHash=sha256('real snapshot binding');const hash=sha256(canonicalJson(document));
const row={issue_date:'2026-11-24',country:'kz',step:'final',state:'blocked',attempt:3,
  updated_at:new Date(at).toISOString(),receipt:{snapshot:{hash:snapshotHash},
    workCheckpoint:{checkpointHash:sha256('previous'),stage:'draft'}}}as unknown as StateRow;
const input={snapshotHash,checkpointHash:hash,stage:'review',document,baseCheckpointHash:sha256('previous')};
assert.deepEqual(checkpointInput(input,[row]).document,document);
assert.throws(()=>checkpointInput({...input,baseCheckpointHash:sha256('stale')},[row]),/checkpoint_conflict/);
assert.equal(checkpointInput(input,[row]).checkpointHash,hash,'resume reuses identical merged document');
console.log('Database exchange: exact originals, immutable hash, owner-scoped manual expiry/version/content/country and merged checkpoint CAS passed; production/model/WeChat calls=0.');

async function orchestration(){
  const fetchBefore=globalThis.fetch,env=process.env,now=Date.now;
  process.env={...env,SUPABASE_URL:'https://db.unit-test.example',SUPABASE_ANON_KEY:'fixture-anon',SUPABASE_SERVICE_ROLE_KEY:'fixture-role',REVIEWED_PLAN_B:'1',REVIEWED_PLAN_B_FIRST_ISSUE:'2026-11-24'};
  const records=['kz','uz','kg'].map(country=>({issue_date:'2026-11-24',country,kind:'checkpoint',record_key:hash,content_hash:sha256(canonicalJson(input)),payload:input,state:'working',attempts:1}));
  const results:{state:string;result:{reason?:string}}[]=[];const visited:string[]=[];
  const posted:Record<string,unknown>[][]=[];
  let failOriginalBatch=false;
  globalThis.fetch=async (request,init)=>{
    const url=new URL(request instanceof Request?request.url:String(request));assert.equal(url.host,'db.unit-test.example');
    if(url.pathname==='/rest/v1/rpc/claim_plan_b_exchange')return Response.json(records);
    assert.equal(url.pathname,'/rest/v1/plan_b_exchange');
    if(init?.method==='POST'){
      const payload=JSON.parse(String(init.body));
      const rows=Array.isArray(payload)?payload:[payload];
      posted.push(rows);
      if(failOriginalBatch&&rows[0]?.kind==='original')return Response.json({message:'isolated write failure'},{status:503});
      return Response.json([], {status:201});
    }
    assert.equal(init?.method,'PATCH');
    if(url.searchParams.has('record_key'))results.push(JSON.parse(String(init?.body)));
    return Response.json([]);
  };
  const directory=await mkdtemp(join(tmpdir(),'plan-b-exchange-test-'));
  try{
    const stamp='2026-11-24T06:30:00+08:00';
    const candidates=Array.from({length:6},(_,i)=>({id:`fixture-${i}`,revision:c.revision,sourceHash:c.sourceHash,
      sourceId:'fixture',family:'Fixture',title:`Fixture ${i}`,sourceUrl:`https://fixture.example/${i}`,
      publishedAt:'2026-11-24T05:55:00+08:00',needsTimeReview:false}));
    const scope:SnapshotReceipt={snapshot:snapshot({issue:'2026-11-24',country:'kz',phase:'final',observedAt:stamp,
      coverage:coverageFixture('kz',stamp),pendingSources:[],candidates}),cache:{path:'fixture',sha256:hash,bytes:1},metrics:{}};
    const lines=candidates.map(candidate=>JSON.stringify({id:candidate.id,sourceHash:candidate.sourceHash,text:body}));
    const file=join(directory,'originals.jsonl');
    await writeFile(file,lines.join('\n'));
    await publishScan(scope,file);
    assert.deepEqual(posted.map(batch=>batch.length),[5,1,1]);
    assert.deepEqual(posted.map(batch=>batch[0].kind),['original','original','manifest']);
    assert.equal((posted.at(-1)![0].payload as {originalCount:number}).originalCount,6);
    posted.length=0;
    failOriginalBatch=true;
    await assert.rejects(publishScan(scope,file),/exchange_publish_failed/);
    assert.deepEqual(posted.map(batch=>batch[0].kind),['original'],'a failed batch never publishes the manifest');
    failOriginalBatch=false;
    posted.length=0;
    await writeFile(file,[...lines.slice(0,-1),lines[0]].join('\n'));
    await assert.rejects(publishScan(scope,file),/exchange_candidate_mismatch/,'a duplicate cannot substitute for a missing original');
    assert.equal(posted.some(batch=>batch[0].kind==='manifest'),false);
    assert.equal(await processExchange('2026-11-24',async(_issue,country)=>{
      visited.push(country);if(country==='kz')throw new Error('checkpoint_conflict');
      return {state:'checkpoint_saved',checkpoint:row.receipt!.workCheckpoint as never,editorialApproved:false};
    }),3);
    assert.deepEqual(visited,['kz','uz','kg']);assert.deepEqual(results.map(r=>r.state),['rejected','accepted','accepted']);
    assert.equal(results[0].result.reason,'checkpoint_conflict');
    assert.deepEqual(records[0].payload.document,document,'failed country retains both roles in its command');
    Date.now=()=>Date.parse('2026-11-24T09:00:00+08:00');
    await assert.rejects(applyPlanBCommand('2026-11-24','kz',false,{}),/handoff_outside_production_window/);
  }finally{globalThis.fetch=fetchBefore;process.env=env;Date.now=now;await rm(directory,{recursive:true,force:true});}
  console.log('Actual inbox orchestrator: one stale checkpoint rejected, two countries continue, failed payload preserved, 09:00 new submission refused; no real services called.');
}
void orchestration().catch(error=>{console.error(error);process.exitCode=1;});
