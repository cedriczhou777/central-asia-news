import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {getSupabaseClient} from '../storage/database/supabase-client';
import {canonicalJson,sha256,isCountry,type PlanBCountry} from './plan-b-handoff';
import type {SnapshotReceipt} from './plan-b-store';
import {applyPlanBCommand} from './plan-b-command';

export const EXCHANGE_VERSION='plan-b-database-exchange-1';
const TABLE='plan_b_exchange';
type RecordRow={issue_date:string;country:PlanBCountry;kind:'checkpoint'|'submission';record_key:string;
  content_hash:string;payload:Record<string,unknown>;state:string;attempts:number};

async function publish(issue:string,country:string,kind:string,key:string,payload:object,immutable=false){
  const row={issue_date:issue,country,kind,record_key:key,payload,content_hash:sha256(canonicalJson(payload)),
    state:'available',updated_at:new Date().toISOString()};
  const {error}=await getSupabaseClient().from(TABLE).upsert(row,{onConflict:'issue_date,country,kind,record_key',ignoreDuplicates:immutable});
  if(error)throw new Error('plan_b_exchange_publish_failed');
}

export function originalRecord(candidate:{id:string;sourceHash:string;revision:string},original:Record<string,unknown>){
  if(original.id!==candidate.id||original.sourceHash!==candidate.sourceHash||typeof original.text!=='string'
      ||sha256(original.text)!==candidate.sourceHash)throw new Error('exchange_original_hash_mismatch');
  return {candidate,original};
}

/** Stream one archived original at a time. Never load a 33 MB compressed bundle in Work. */
export async function publishScan(scope:SnapshotReceipt,jsonl:string){
  const {snapshot}=scope;const candidates=new Map(snapshot.candidates.map(c=>[c.id,c]));
  const lines=createInterface({input:createReadStream(jsonl),crlfDelay:Infinity});
  let count=0;
  for await(const line of lines){
    if(!line)continue;
    const original=JSON.parse(line)as Record<string,unknown>;
    const candidate=candidates.get(String(original.id));if(!candidate)throw new Error('exchange_candidate_mismatch');
    const payload=originalRecord(candidate,original);
    await publish(snapshot.issue,snapshot.country,'original',`${candidate.id}/${candidate.sourceHash}/${candidate.revision}`,payload,true);count++;
  }
  if(count!==snapshot.candidates.length)throw new Error('exchange_originals_incomplete');
  await publish(snapshot.issue,snapshot.country,'manifest',snapshot.phase,{snapshot,originalCount:count,
    formalStateAuthority:'plan_b_daily',exchangeVersion:EXCHANGE_VERSION});
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
