import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {getSupabaseClient} from '../storage/database/supabase-client';
import {canonicalJson,sha256,isCountry,EDITORIAL_POLICY_FIRST_ISSUE,type PlanBCountry} from './plan-b-handoff';
import type {SnapshotReceipt} from './plan-b-store';
import {applyPlanBCommand} from './plan-b-command';

export const EXCHANGE_VERSION='plan-b-database-exchange-1';
const SOURCE_EVIDENCE_VERSION='source-evidence-2';
const TABLE='plan_b_exchange';
const RECORD_KEY='issue_date,country,kind,record_key';
type RecordRow={issue_date:string;country:PlanBCountry;kind:'checkpoint'|'submission';record_key:string;
  content_hash:string;payload:Record<string,unknown>;state:string;attempts:number};

function exchangeRow(issue:string,country:string,kind:string,key:string,payload:object){
  return {issue_date:issue,country,kind,record_key:key,payload,content_hash:sha256(canonicalJson(payload)),
    state:'available',updated_at:new Date().toISOString()};
}

async function publish(issue:string,country:string,kind:string,key:string,payload:object,immutable=false){
  const row=exchangeRow(issue,country,kind,key,payload);
  const {error}=await getSupabaseClient().from(TABLE).upsert(row,{onConflict:RECORD_KEY,ignoreDuplicates:immutable});
  if(error)throw new Error('plan_b_exchange_publish_failed');
}

export function originalRecord(candidate:{id:string;sourceHash:string;revision:string;sourceUrl?:string},
    original:Record<string,unknown>,requireRevision=false){
  if(original.id!==candidate.id||original.sourceHash!==candidate.sourceHash||typeof original.text!=='string'
      ||sha256(original.text)!==candidate.sourceHash)throw new Error('exchange_original_hash_mismatch');
  const packet=original.evidencePacket as {version?:unknown}|undefined;
  if(requireRevision && (!candidate.revision || original.revision!==candidate.revision || !candidate.sourceUrl
    || original.source_url!==candidate.sourceUrl || packet?.version!==SOURCE_EVIDENCE_VERSION)){
    throw new Error('exchange_original_revision_or_source_mismatch');
  }
  return {candidate,original};
}

/** Publish original evidence in small immutable batches before publishing the manifest. */
export async function publishScan(scope:SnapshotReceipt,jsonl:string,namespace?:string){
  const {snapshot}=scope;const candidates=new Map(snapshot.candidates.map(c=>[c.id,c]));
  const versioned=snapshot.issue>=EDITORIAL_POLICY_FIRST_ISSUE;
  const keyFor=(key:string)=>namespace ? `${namespace}/${key}` : key;
  const lines=createInterface({input:createReadStream(jsonl),crlfDelay:Infinity});
  let batch:ReturnType<typeof exchangeRow>[]=[];
  let bytes=0;
  const publishBatch=async()=>{
    if(!batch.length)return;
    const {error}=await getSupabaseClient().from(TABLE).upsert(batch,{onConflict:RECORD_KEY,ignoreDuplicates:true});
    if(error)throw new Error('plan_b_exchange_publish_failed');
    batch=[];
    bytes=0;
  };
  for await(const line of lines){
    if(!line)continue;
    const original=JSON.parse(line)as Record<string,unknown>;
    const candidate=candidates.get(String(original.id));if(!candidate)throw new Error('exchange_candidate_mismatch');
    const payload=originalRecord(candidate,original,versioned);
    const id=`${candidate.id}/${candidate.sourceHash}/${candidate.revision}`;
    const row=exchangeRow(snapshot.issue,snapshot.country,'original',
      keyFor(versioned ? `${SOURCE_EVIDENCE_VERSION}/${id}` : id),payload);
    const size=Buffer.byteLength(JSON.stringify(row));
    if(batch.length>=5||bytes+size>512*1024)await publishBatch();
    batch.push(row);
    bytes+=size;
    candidates.delete(candidate.id);
  }
  if(candidates.size)throw new Error('exchange_originals_incomplete');
  await publishBatch();
  await publish(snapshot.issue,snapshot.country,'manifest',keyFor(snapshot.phase),{snapshot,originalCount:snapshot.candidates.length,
    formalStateAuthority:namespace ?? 'plan_b_daily',exchangeVersion:EXCHANGE_VERSION,
    ...(versioned ? {sourceEvidenceVersion:SOURCE_EVIDENCE_VERSION} : {})},!!namespace);
}

export async function publishExchangeHealth(issue:string,payload:object,key:'latest'|'runtime_checks'|`runtime_checks/${string}`='latest'){
  let identity:{files?:Record<string,string>}|null=null;
  try{identity=JSON.parse(await readFile(join(process.cwd(),'ops/plan-b/build-identity.json'),'utf8'));}catch{/* local source tests have no image identity */}
  const ingest=process.env.INGEST_SECRET||'',planB=process.env.PLAN_B_INGEST_SECRET||ingest;
  await publish(issue,'global','health',key,{...payload,exchangeVersion:EXCHANGE_VERSION,identity,
    releaseImplementationSha256:identity?.files?.['ops/plan-b/cloud_release.py']??null,
    credentialConfiguration:{ingestConfigured:!!ingest,planBConfigured:!!planB,planBMatchesIngest:planB===ingest},
    credentialProof:planB?createHmac('sha256',planB).update(`${EXCHANGE_VERSION}/${issue}`).digest('hex'):null,
    notification:{channel:'cloud_log_and_database',userNotified:false},costs:{workCredits:'unknown'},
    checkedAt:new Date().toISOString()},key.startsWith('runtime_checks/'));
}

export function* wordChunks(document:{sha256:string;bytes:number},bytes:Buffer){
  if(bytes.length!==document.bytes||sha256(bytes)!==document.sha256||!bytes.length||bytes.length>40*1024*1024)throw new Error('exchange_word_hash_or_size');
  const size=256*1024,count=Math.ceil(bytes.length/size);
  for(let i=0;i<count;i++)yield {document,chunkIndex:i,chunkCount:count,
    base64:bytes.subarray(i*size,(i+1)*size).toString('base64')};
}
export async function publishWord(issue:string,country:PlanBCountry,document:{sha256:string;bytes:number},bytes:Buffer){
  for(const part of wordChunks(document,bytes))await publish(issue,country,'word',
    `${document.sha256}/${String(part.chunkIndex).padStart(5,'0')}`,part,true);
}

export async function processExchange(issue:string,apply=applyPlanBCommand,beforeSubmission?:()=>void){
  const sb=getSupabaseClient();
  const expired=await sb.from(TABLE).update({state:'rejected',lease_until:null,updated_at:new Date().toISOString(),
    result:{ok:false,reason:'command_attempts_exhausted',checkpointPreserved:true,
      nextAction:'read_confirmed_editorial_and_checkpoint_before_recovery',userNotified:false}})
    .eq('issue_date',issue).in('kind',['checkpoint','submission']).eq('state','working').eq('attempts',3)
    .lt('lease_until',new Date().toISOString());
  if(expired.error)throw new Error('plan_b_exchange_recovery_read_failed');
  const {data,error}=await sb.rpc('claim_plan_b_exchange',{target_issue:issue});
  if(error)throw new Error('plan_b_exchange_claim_failed');
  let completed=0;
  for(const row of (data??[])as RecordRow[]){
    let result:Record<string,unknown>;let state:'accepted'|'rejected'|'queued';
    try{
      if(!isCountry(row.country)||row.content_hash!==sha256(canonicalJson(row.payload)))throw new Error('exchange_command_hash_mismatch');
      if(row.kind==='submission')beforeSubmission?.();
      result={ok:true,...await apply(issue,row.country,row.kind==='checkpoint',row.payload)};state='accepted';
    }catch(error){
      const message=error instanceof Error?error.message:'';
      const transient=/storage_unavailable|save_failed|state_read_failed|claim_lost|archive|exchange_publish_failed/.test(message);
      state=transient&&row.attempts<3?'queued':'rejected';
      result={ok:false,reason:/^[a-z][a-z0-9_]{0,90}$/.test(message)?message:'command_failed',
        retryable:state==='queued',checkpointPreserved:true,userNotified:false};
    }
    const saved=await sb.from(TABLE).update({state,result,lease_until:null,updated_at:new Date().toISOString()})
      .eq('issue_date',issue).eq('country',row.country).eq('kind',row.kind).eq('record_key',row.record_key)
      .eq('state','working').eq('attempts',row.attempts);
    if(saved.error)console.warn(JSON.stringify({event:'plan_b_exchange_result_save_failed',issue,country:row.country}));
    completed++;
  }
  return completed;
}
