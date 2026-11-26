import { getSupabaseClient } from '../storage/database/supabase-client';
import { canonicalJson, freezeBlockReason, PLAN_B_COUNTRIES, sha256, type PlanBCountry } from './plan-b-handoff';
import { collectCountry } from './plan-b-worker';
import { recoverySources } from './plan-b-runtime';
import { prepareIsolatedRelease } from './plan-b-release';
import type { SnapshotReceipt } from './plan-b-store';

const TABLE='plan_b_exchange';
const issue='2026-11-26';
const run='recollect-20261126-r4';
const deadline=Date.parse('2026-11-26T20:00:00+08:00');
const key=(step:string)=>`${run}/${step}`;
const request={issue,run,version:`${issue}-r4`,countries:PLAN_B_COUNTRIES,mode:'fresh-public-source-collection'};
const hash=(value:unknown)=>sha256(canonicalJson(value));
type Client=ReturnType<typeof getSupabaseClient>;
type Job={country:PlanBCountry;record_key:string;state:string;content_hash:string;payload:Record<string,unknown>;
  attempts:number;lease_until:string|null;result?:{scope?:SnapshotReceipt;ready?:boolean}|null};

function fields(country:PlanBCountry|'global',record_key:string){
  return {issue_date:issue,country,kind:'manual_use',record_key};
}

async function advance(sb:Client, country:PlanBCountry, step:string, prior:Job|undefined,
    payload:Record<string,unknown>, work:(attempt:number)=>Promise<object>){
  const match=fields(country,key(step));
  const content_hash=hash(payload);
  const now=new Date().toISOString();
  const lease_until=new Date(Date.now()+18*60_000).toISOString();
  const attempts=(prior?.attempts??0)+1;
  if(prior){
    if(prior.content_hash!==content_hash||attempts>2||
        (prior.state!=='queued'&&(prior.state!=='working'||!prior.lease_until||prior.lease_until>=now)))return;
    const claim=await sb.from(TABLE).update({state:'working',attempts,lease_until,updated_at:now}).match(match)
      .eq('state',prior.state).eq('attempts',prior.attempts).eq('content_hash',content_hash).select('country');
    if(claim.error||claim.data?.length!==1)return;
  }else{
    const claim=await sb.from(TABLE).insert({...match,payload,content_hash,state:'working',attempts,lease_until,updated_at:now});
    if(claim.error)return;
  }
  let state='accepted', result:object;
  try{result=await work(attempts);}
  catch(error){
    const reason=error instanceof Error?error.message:'';
    state='rejected';
    result={ok:false,reason:/^[a-z][a-z0-9_]{0,90}$/.test(reason)?reason:'isolated_worker_failed'};
  }
  await sb.from(TABLE).update({state,result,lease_until:null,updated_at:new Date().toISOString()})
    .match(match).eq('state','working').eq('attempts',attempts).eq('content_hash',content_hash);
}

export async function processFreshRun(sb=getSupabaseClient()){
  if(Date.now()>=deadline)return;
  const authorized=await sb.from(TABLE).select('payload,state,content_hash').match(fields('global',key('requested'))).maybeSingle();
  if(authorized.error||authorized.data?.state!=='available'||authorized.data.content_hash!==hash(request)||
      hash(authorized.data.payload)!==hash(request))return;
  const records=await sb.from(TABLE).select('country,record_key,state,content_hash,payload,attempts,lease_until,result')
    .eq('issue_date',issue).eq('kind','manual_use').in('record_key',[key('scan'),key('prepare')]);
  if(records.error)return;
  const rows=(records.data??[]) as Job[];
  const row=(country:PlanBCountry,step:string)=>rows.find(r=>r.country===country&&r.record_key===key(step));
  for(let offset=0;offset<PLAN_B_COUNTRIES.length;offset+=2){
    await Promise.all(PLAN_B_COUNTRIES.slice(offset,offset+2).map(async country=>{
      const current=row(country,'scan');
      await advance(sb,country,'scan',current,{run,country},async attempt=>{
        const namespace=key(`scan-${attempt}`);
        let originalNamespace=namespace;
        let scope=await collectCountry(issue,country,'final',undefined,undefined,{namespace,deadline});
        const reason=(value:SnapshotReceipt)=>freezeBlockReason(value.snapshot) ||
          (value.snapshot.candidates.length<10?'insufficient_reviewable_candidates':null);
        const focus=recoverySources(scope.snapshot.coverage);
        if(reason(scope)&&focus.length){
          originalNamespace=namespace+'/supplement';
          scope=await collectCountry(issue,country,'final',scope.cache,focus,{namespace:originalNamespace,deadline});
        }
        return {scope,originalNamespace,ready:!reason(scope),reason:reason(scope),usedPriorIssueCache:false};
      });
      const prepare=row(country,'prepare');
      if(current?.state==='accepted'&&current.result?.ready&&current.result.scope&&prepare?.payload.run===run){
        const source=current.result.scope;
        await advance(sb,country,'prepare',prepare,prepare.payload,async ()=>{
          const result=await prepareIsolatedRelease(source,prepare.payload.handoff,request.version,deadline);
          return {ok:true,...result};
        });
      }
    }));
  }
}
