import { getSupabaseClient } from '../storage/database/supabase-client';
import { canonicalJson, DAILY_MIN_ARTICLES, freezeBlockReason, PLAN_B_COUNTRIES, reviewableWindowCount, sha256, type PlanBCountry } from './plan-b-handoff';
import { collectCountry } from './plan-b-worker';
import { planBRecoveryPackageVersion, prepareIsolatedRelease } from './plan-b-release';
import { getState, type SnapshotReceipt } from './plan-b-store';
import { recoverySources } from './plan-b-runtime';

const TABLE='plan_b_exchange';
const issue='2026-11-27';
const run='recover-20261127-r4';
const opensAt=Date.parse('2026-11-27T09:30:00+08:00');
const deadline=Date.parse('2026-11-27T20:00:00+08:00');
const key=(step:string)=>`${run}/${step}`;
const request={issue,run,version:`${issue}-r4`,countries:PLAN_B_COUNTRIES,mode:'resume-same-issue-verified-archive'};
const authorizationRecord=key('verified-archive-requested');
const hash=(value:unknown)=>sha256(canonicalJson(value));
const scanSteps=['scan','extend','extend-2','extend-3','extend-4','extend-5','extend-6','extend-7',
  'extend-8','extend-9','extend-10','extend-11','extend-12','extend-13','extend-14','extend-15','extend-16',
  'extend-17','extend-18','extend-19','extend-20','extend-21','extend-22','extend-23','extend-24'];
const azerbaijanRecoverySources=[
  'az-ministry-energy-azerbaijan', 'az-european-commission-transport', 'az-cabinet-recovery',
  'az-operativ-media-recovery', 'az-fed-az-recovery', 'az-apa', 'az-report-az', 'az-trend',
];
const captureHashes:Partial<Record<PlanBCountry,string>>={
  kz:'d3863b59bb136f777f39e3098e333efa23e2c52f32c5736234c81386e8bd9903',
  uz:'16e39c0e3bd5eab9f25bc03e0a148768ddb345b0165e2ead5bf980cf2de61821',
  az:'1fe3d30ff5dd649d57440f4b5afcb964e7d5930ae0c54681ee69b33a9449765e',
};
const uzPresidencyCapture = '7e6d7bed7e7c7db349fe24fd32a0233239763ff895591d7977af0236a6e8643e';
const retryableScanReasons=new Set(['isolated_worker_failed','isolated_scan_timeout','isolated_scan_output_limit','plan_b_object_size']);
const blockReason=(scope:SnapshotReceipt)=>freezeBlockReason(scope.snapshot) ||
  (reviewableWindowCount(scope.snapshot)<DAILY_MIN_ARTICLES?'insufficient_reviewable_candidates':null);
type Client=ReturnType<typeof getSupabaseClient>;
type Job={country:PlanBCountry;record_key:string;state:string;content_hash:string;payload:Record<string,unknown>;
  attempts:number;lease_until:string|null;result?:{scope?:SnapshotReceipt;ready?:boolean;reason?:string;
    coverageReassessed?:boolean;publisherArchiveReassessed?:boolean;currentOfficialArchiveReassessed?:boolean;
    navigationEvidenceReassessed?:boolean;archiveDatesReassessed?:boolean;energyArchiveScanned?:boolean;
    publicCaptureImported?:boolean}|null};
type JobHead=Pick<Job,'country'|'record_key'|'state'|'attempts'>;
const scanFlags=['coverageReassessed','publisherArchiveReassessed','currentOfficialArchiveReassessed',
  'navigationEvidenceReassessed','archiveDatesReassessed','energyArchiveScanned'] as const;

function fields(country:PlanBCountry|'global',record_key:string){
  return {issue_date:issue,country,kind:'manual_use',record_key};
}

async function readJob(sb:Client,country:PlanBCountry,head:JobHead|undefined):Promise<Job|undefined>{
  if(!head)return undefined;
  const {data,error}=await sb.from(TABLE).select('country,record_key,state,content_hash,payload,attempts,lease_until,result')
    .match(fields(country,head.record_key)).maybeSingle();
  if(error||!data)throw new Error('isolated_recovery_job_read_failed');
  return data as Job;
}

async function readScanFlags(sb:Client,country:PlanBCountry,completed:JobHead[]){
  const flags=new Set<typeof scanFlags[number]>();
  const columns=scanFlags.map(flag=>`${flag}:result->>${flag}`).join(',');
  for(let offset=0;offset<completed.length;offset+=4){
    const {data,error}=await sb.from(TABLE).select(columns).match({issue_date:issue,country,kind:'manual_use'})
      .in('record_key',completed.slice(offset,offset+4).map(head=>head.record_key));
    if(error)throw new Error('isolated_recovery_flags_read_failed');
    for(const row of (data??[]) as unknown as Record<string,string|null>[]){
      for(const flag of scanFlags)if(row[flag]==='true')flags.add(flag);
    }
  }
  return flags;
}

async function publicCapture(sb:Client,country:PlanBCountry,base:SnapshotReceipt,followup=false) {
  const {data,error}=await sb.from(TABLE).select('payload,content_hash').match({
    ...fields(country,key(followup?'public-publisher-followup-capture':'public-publisher-capture')),state:'available',
  }).maybeSingle();
  if(error)throw new Error('public_capture_read_failed');
  if(!data)return undefined;
  const value=data.payload as Record<string,unknown>;
  const expectedHash=followup?uzPresidencyCapture:captureHashes[country];
  if(typeof value!=='object'||!value||data.content_hash!==expectedHash||hash(value)!==data.content_hash||value.issue!==issue||value.country!==country
    ||!Array.isArray(value.pages)||!value.pages.length||value.pages.length>18)throw new Error('public_capture_hash_mismatch');
  const pending=new Set(base.snapshot.coverage.pendingWork.map(item=>item.sourceId+'\n'+String(item.url)));
  const seen=new Set<string>();
  const allowed=value.pages.map((page:Record<string,unknown>)=>{
    if(!page||typeof page.url!=='string'||typeof page.sourceId!=='string'||!/^https:\/\//.test(page.url)
      ||typeof page.gzipBase64!=='string'||page.gzipBase64.length>400_000
      ||typeof page.rawSha256!=='string'||!/^[0-9a-f]{64}$/.test(page.rawSha256))throw new Error('public_capture_shape_invalid');
    const identity=page.sourceId+'\n'+page.url;
    if(seen.has(identity)||(!pending.has(identity)&&!(followup&&country==='uz'&&page.sourceId==='uz-president-uzbekistan')
      &&!(country==='az'&&azerbaijanRecoverySources.includes(page.sourceId))
      &&!(country==='kz'&&page.sourceId==='kz-prime-minister-kazakhstan'&&page.url.endsWith('-32163'))))
      throw new Error('public_capture_source_not_in_recovery_scope');
    seen.add(identity);
    return {url:page.url,sourceId:page.sourceId};
  });
  return {capture:{issue,country,pages:value.pages,allowed},sources:[...new Set(allowed.map(page=>page.sourceId))],
    contentHash:data.content_hash};
}

async function advance(sb:Client, country:PlanBCountry, step:string, prior:Job|undefined,
    payload:Record<string,unknown>, work:(attempt:number)=>Promise<object>){
  const match=fields(country,key(step));
  const content_hash=hash(payload);
  const now=new Date().toISOString();
  const lease_until=new Date(Date.now()+18*60_000).toISOString();
  const attempts=(prior?.attempts??0)+1;
  if(prior){
    const retryRejected=step!=='prepare'&&prior.state==='rejected'&&retryableScanReasons.has(prior.result?.reason??'');
    if(prior.content_hash!==content_hash||attempts>2||
        (!retryRejected&&prior.state!=='queued'&&(prior.state!=='working'||!prior.lease_until||prior.lease_until>=now)))return;
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
    const retained=(error as {snapshotReceipt?:SnapshotReceipt})?.snapshotReceipt;
    state=retained?'accepted':'rejected';
    result={ok:false,ready:false,reason:/^[a-z][a-z0-9_]{0,90}$/.test(reason)?reason:'isolated_worker_failed',
      ...(retained ? {scope:retained} : {})};
  }
  const previousFailure=prior?.state==='rejected'?prior.result?.reason:undefined;
  const saved=await sb.from(TABLE).update({state,result:{...result,...(previousFailure?{previousFailure}:{})},
    lease_until:null,updated_at:new Date().toISOString()})
    .match(match).eq('state','working').eq('attempts',attempts).eq('content_hash',content_hash);
  if(saved.error) throw new Error('isolated_recovery_receipt_save_failed');
}

export async function processFreshRun(sb=getSupabaseClient()){
  const now=Date.now();
  if(now<opensAt||now>=deadline)return;
  const authorized=await sb.from(TABLE).select('payload,state,content_hash').match(fields('global',authorizationRecord)).maybeSingle();
  if(authorized.error||authorized.data?.state!=='available'||authorized.data.content_hash!==hash(request)||
      hash(authorized.data.payload)!==hash(request))return;
  const records=await sb.from(TABLE).select('country,record_key,state,attempts')
    .eq('issue_date',issue).eq('kind','manual_use').in('record_key',[...scanSteps,'prepare'].map(key));
  if(records.error)throw new Error('isolated_recovery_jobs_read_failed');
  const rows=(records.data??[]) as JobHead[];
  const row=(country:PlanBCountry,step:string)=>rows.find(r=>r.country===country&&r.record_key===key(step));
  for(let offset=0;offset<PLAN_B_COUNTRIES.length;offset+=2){
    const outcomes=await Promise.allSettled(PLAN_B_COUNTRIES.slice(offset,offset+2).map(async country=>{
      const completed:JobHead[]=[];
      let nextStep:string|undefined;
      for(const step of scanSteps){
        const head=row(country,step);
        if(head?.state==='accepted'){
          completed.push(head);
          continue;
        }
        if(completed.length&&head?.state==='rejected'&&head.attempts>=2){
          const rejected=await readJob(sb,country,head);
          if(retryableScanReasons.has(rejected?.result?.reason??''))continue;
        }
        nextStep=step;
        break;
      }
      const previous=await readJob(sb,country,completed.at(-1));
      const base=previous?.result?.scope;
      if(previous&&!base)throw new Error('isolated_recovery_snapshot_missing');
      if(previous?.result?.ready&&base&&!blockReason(base)){
        const head=row(country,'prepare');
        if(head?.state!=='queued'&&head?.state!=='working')return;
        const prepare=await readJob(sb,country,head);
        if(prepare?.payload.run===run){
          await advance(sb,country,'prepare',prepare,prepare.payload,async ()=>{
            const result=await prepareIsolatedRelease(base,prepare.payload.handoff,planBRecoveryPackageVersion(issue,country),deadline);
            return {ok:true,...result};
          });
        }
        return;
      }
      if(nextStep){
        const step=nextStep;
        const current=await readJob(sb,country,row(country,step));
        const followup=step==='extend-22'&&country==='uz';
        const captureStep=step==='extend-18'||(step==='extend-21'&&country==='az')||followup;
        const sourceCapture=base&&captureStep&&captureHashes[country]
          ? await publicCapture(sb,country,base,followup):undefined;
        if (captureStep&&captureHashes[country]&&!sourceCapture) return;
        await advance(sb,country,step,current,base?{run,country,baseHash:base.snapshot.hash,
          ...(sourceCapture?{captureHash:sourceCapture.contentHash}:{})}:{run,country},async attempt=>{
          const originalNamespace=key(`${step}-${attempt}`);
          const saved=base??(await getState(issue,country)).find(record=>record.step==='final')?.receipt as SnapshotReceipt|undefined;
          if(!saved?.cache||saved.snapshot?.issue!==issue||saved.snapshot.country!==country||saved.snapshot.phase!=='final')
            throw new Error('same_issue_final_cache_unavailable');
          const flags=await readScanFlags(sb,country,completed);
          const count=reviewableWindowCount(saved.snapshot);
          const officialReassess=Boolean(previous&&country!=='kg'&&
            !flags.has('currentOfficialArchiveReassessed'));
          const publisherReassess=Boolean(previous&&country==='kg'&&
            !flags.has('publisherArchiveReassessed'));
          const navigationReassess=Boolean(previous&&
            !flags.has('navigationEvidenceReassessed'));
          const archiveDatesReassess=Boolean(previous&&(country==='az'||country==='kz')&&
            !flags.has('archiveDatesReassessed'));
          const reassess=archiveDatesReassess||navigationReassess||officialReassess||publisherReassess||Boolean(previous&&count>=DAILY_MIN_ARTICLES&&
            !flags.has('coverageReassessed'));
          const targets=recoverySources(saved.snapshot.coverage);
          const energyArchiveScan=country==='az'&&count<DAILY_MIN_ARTICLES&&!reassess&&
            previous?.result?.reason!=='exchange_publish_failed'&&
            !flags.has('energyArchiveScanned');
          const finalUzbekReferenceReview=country==='uz'&&(step==='extend-23'||step==='extend-24');
          const focus=sourceCapture?.sources??(reassess||finalUzbekReferenceReview||previous?.result?.reason==='exchange_publish_failed'?[]:
            energyArchiveScan?['az-ministry-energy-azerbaijan']:
              country==='az'&&count<DAILY_MIN_ARTICLES
              ? [...new Set([...azerbaijanRecoverySources, ...targets])]
              : targets.length?targets:undefined);
          const scope=await collectCountry(issue,country,'final',saved.cache,focus,
            {namespace:originalNamespace,deadline,scanSeconds:120,nov27Recovery:true,recoveryCapture:sourceCapture?.capture});
          const reason=blockReason(scope);
          return {scope,originalNamespace,ready:!reason,reason,usedPriorIssueCache:false,resumedSnapshotHash:saved.snapshot.hash,
            ...(reassess?{coverageReassessed:true}:{}),...(publisherReassess?{publisherArchiveReassessed:true}:{}),
            ...(officialReassess?{currentOfficialArchiveReassessed:true}:{}),
            ...(navigationReassess?{navigationEvidenceReassessed:true}:{}),
            ...(archiveDatesReassess?{archiveDatesReassessed:true}:{}),
            ...(energyArchiveScan?{energyArchiveScanned:true}:{}),
            ...(sourceCapture?{publicCaptureImported:true}:{})};
        });
      }
    }));
    for(const outcome of outcomes)if(outcome.status==='rejected')console.warn('isolated_recovery_country_update_failed');
  }
}
