import cron from 'node-cron';
import { getSupabaseClient } from '../storage/database/supabase-client';
import { beijingDate } from './utils';
import { imageUrls, issueDate, issueCutoffElapsed, latestVersion, PACKAGE_COUNTRIES, type ReviewedPackage } from './reviewed-package';
import { deliverReviewedPackage, readPackage, canResumePreparation, deliveryAdapters } from './reviewed-delivery';
import { probeReviewedImage } from './reviewed-wechat';
import { persistPushRun } from './push-run-store';
import { getReviewedRecoveryState } from './reviewed-recovery-state';

export const REVIEWED_RECOVERY_VERSION = '2026-11-15-v11';
/** The existing CloudBase reservation is the only keep-alive. New expensive
 * batches stop at 09:20, leaving its last ten minutes for admitted work to settle. */
export function reviewedRecoveryWindow(now=Date.now()) {
  const bjt=new Date(now+8*60*60_000);
  const minute=bjt.getUTCHours()*60+bjt.getUTCMinutes();
  return {timezone:'Asia/Shanghai',start:'05:50',newWorkBefore:'09:20',end:'09:30',
    open:minute>=350&&minute<570,newWorkAllowed:minute>=350&&minute<560};
}
const WINDOW_CLOSED='automatic_recovery_window_closed';
/** Only automatic recovery receives these adapters. Never interrupt create,
 * update or readback after they started: their receipt must settle safely. */
export function automaticRecoveryAdapters(canStart=()=>reviewedRecoveryWindow().newWorkAllowed,base=deliveryAdapters):typeof deliveryAdapters {
  const check=()=>{if(!canStart())throw new Error(WINDOW_CLOSED);};
  return {...base,prepare:async(d,onProgress)=>{
    check();
    return base.prepare(d,async()=>{check();await onProgress?.();check();});
  }};
}
type Row = { version:string; country:string; state:string; media_id?:string | null;updated_at?:string;detail?:Record<string,unknown> };
type Dependencies = {
  packages:(date:string)=>Promise<string[]>;
  deliveries:(versions:string[])=>Promise<Row[]>;
  read:(version:string)=>Promise<ReviewedPackage | null>;
  probe:typeof probeReviewedImage;
  deliver:(payload:ReviewedPackage,countries:readonly (typeof PACKAGE_COUNTRIES)[number][])=>Promise<unknown>;
  onPending?:()=>void;
  onProgress?:(progress:Record<string,unknown>)=>void;
  canContinue?:()=>boolean;
  canStartWork?:()=>boolean;
};
/** Plan per country across revisions. An active receipt pins that country's
 * version; failed-before-create rows do not block other countries or corrections.
 * The database's unique active (issue,country) index remains the final lock. */
export async function recoverReviewedIssue(date:string,deps:Dependencies) {
  const failures:Array<{country:string;index?:number;reason?:string}>=[];
  const canContinue=()=>deps.canContinue?.()??true;
  const canStart=()=>canContinue()&&(deps.canStartWork?.()??true);
  const paused=(extra:{version?:string;versionsByCountry?:Record<string,string>;countries?:typeof PACKAGE_COUNTRIES[number][];result?:{ok:boolean;results:unknown[]}}={})=>({stage:'window_closed',date,failures,...extra});
  if(!canContinue())return paused();
  const versions = await deps.packages(date);
  if(!canContinue())return paused();
  if (!versions.length) return {stage:'awaiting_package',date};
  const rows = await deps.deliveries(versions);
  const version = latestVersion(versions,date)!;
  if(!canContinue())return paused({version});
  const versionsByCountry:Record<string,string>={};
  const pending: Array<{country:typeof PACKAGE_COUNTRIES[number];version:string;reconcileOnly?:boolean}>=[];
  let completed=0;
  for(const country of PACKAGE_COUNTRIES){
    const active=rows.filter(r=>r.country===country&&(r.state!=='failed'||!!r.media_id));
    if(active.length>1){failures.push({country,reason:'同国存在多条活动回执，禁止自动建稿'});continue;}
    if(active.length===1){
      const row=active[0];versionsByCountry[country]=row.version;
      if(row.state==='succeeded'&&row.media_id)completed++;
      // A worker may stop after WeChat accepted an update but before readback.
      // Reconcile that known draft; the delivery layer never steals its update lock.
      else if(['uncertain','sending','updating'].includes(row.state)&&row.media_id)pending.push({country,version:row.version,reconcileOnly:true});
      else if(canResumePreparation(row))pending.push({country,version:row.version});
      continue; // Includes failed+media_id, preparing and uncertain; never steal locks.
    }
    versionsByCountry[country]=version;pending.push({country,version});
  }
  if (!pending.length) return {stage:completed===5?'complete':'waiting_existing_delivery',version,versionsByCountry,failures};
  if(!canStart()&&!pending.some(item=>item.reconcileOnly))return paused({version,versionsByCountry});
  deps.onPending?.();
  const results:unknown[]=[];const attempted:typeof PACKAGE_COUNTRIES[number][]=[];
  const packages=new Map<string,ReviewedPackage>();
  for (const item of pending) {
    if(!canContinue()||(!item.reconcileOnly&&!canStart()))return paused({version,versionsByCountry,countries:attempted,result:{ok:false,results}});
    const {country}=item;
    try{
      let payload=packages.get(item.version);
      if(!payload){payload=await deps.read(item.version)||undefined;if(!payload)throw new Error('已接收稿包无法读取');packages.set(item.version,payload);}
      if(!canContinue()||(!item.reconcileOnly&&!canStart()))return paused({version,versionsByCountry,countries:attempted,result:{ok:false,results}});
      if(item.reconcileOnly){
        const result=await deps.deliver(payload,[country]);results.push(result);attempted.push(country);
        if(!canStart()&&(result as {ok?:boolean})?.ok!==true)return paused({version,versionsByCountry,countries:attempted,result:{ok:false,results}});
        continue;
      }
      const d=payload.countries[country],images=imageUrls(d.bodyHtml),before=failures.length;
      deps.onProgress?.({country,version:item.version,stage:'checking_images',totalImages:images.length});
      // Small bounded concurrency; delivery starts as soon as THIS country is
      // ready, rather than waiting behind every other country's slow origin.
      for(let offset=0;offset<images.length;offset+=3){
        if(!canStart())return paused({version,versionsByCountry,countries:attempted,result:{ok:false,results}});
        await Promise.all(images.slice(offset,offset+3).map(async(url,j)=>{
          const index=offset+j;let result=await deps.probe(url,d.sourceUrl,d.imageAssets?.[url]);
          if(!result.accessible&&!/HTTP 40[134]|HTTP 429|存档缺失|哈希/.test(result.reason||'')&&canStart())result=await deps.probe(url,d.sourceUrl,d.imageAssets?.[url]);
          if(!result.accessible)failures.push({country,index,reason:result.reason});
        }));
        if(!canStart())return paused({version,versionsByCountry,countries:attempted,result:{ok:false,results}});
      }
      if(failures.length!==before)continue;
      if(!canStart())return paused({version,versionsByCountry,countries:attempted,result:{ok:false,results}});
      deps.onProgress?.({country,version:item.version,stage:'delivering'});
      const result=await deps.deliver(payload,[country]);results.push(result);attempted.push(country);
      if(!canStart()&&(result as {ok?:boolean})?.ok!==true)return paused({version,versionsByCountry,countries:attempted,result:{ok:false,results}});
    }catch(e){failures.push({country,reason:e instanceof Error?e.message:'国别接续失败'});}
  }
  if(!attempted.length)return {stage:'needs_image_revision',version,versionsByCountry,failures};
  return {stage:'delivery_attempted',version,versionsByCountry,countries:attempted,failures,result:{ok:!failures.length&&results.every(r=>(r as {ok?:boolean})?.ok===true),results}};
}

const recoveryState=getReviewedRecoveryState();
function noteClosed(trigger:string) {
  // No DB/HTTP wake-up outside the reservation. Accepted packages and country
  // checkpoints already persist independently; explicit old-version push remains
  // available, and automatic recovery continues to select only today's issue.
  const at=new Date().toISOString();
  return recoveryState.lastRecovery={startedAt:at,finishedAt:at,stage:'window_closed',date:beijingDate(),trigger};
}
export function reviewedRecoveryStatus(){return {version:REVIEWED_RECOVERY_VERSION,registered:recoveryState.registered,running:recoveryState.running,lastRun:recoveryState.lastRecovery,automaticWindow:reviewedRecoveryWindow()};}
export function queueReviewedRecovery(version:string, today=beijingDate(), requestUrl?:string) {
  if(issueDate(version)!==today)return false;
  if(!reviewedRecoveryWindow().open){noteClosed('accepted_package');return false;}
  if(!issueCutoffElapsed(version))return false;
  // Diagnostic origin only; automatic recovery never requests this URL.
  if(requestUrl){try{const origin=new URL(requestUrl);if(origin.protocol==='https:'&&!origin.username&&!origin.password)recoveryState.acceptedOrigin=origin.origin+'/';}catch{/* Optional diagnostic metadata only. */}}
  // Accepted work continues within the existing reservation only.
  setTimeout(()=>{void runReviewedRecovery();},0);
  return true;
}
export async function runReviewedRecovery() {
  if(recoveryState.running)return {stage:'already_running'};
  if(!reviewedRecoveryWindow().open)return noteClosed('automatic_entry');
  recoveryState.running=true;
  const startedAt=new Date().toISOString();
  let performedWork=false;
  recoveryState.lastRecovery={startedAt,stage:'checking'};
  try {
    const sb=getSupabaseClient();
    const result=await recoverReviewedIssue(beijingDate(),{
      packages:async date=>{const r=await sb.from('reviewed_packages').select('version').eq('issue_date',date);if(r.error)throw new Error('稿包恢复查询失败');return (r.data||[]).map(r=>r.version);},
      deliveries:async versions=>{const r=await sb.from('reviewed_deliveries').select('version,country,state,media_id,updated_at,detail').in('version',versions);if(r.error)throw new Error('投递恢复查询失败');return r.data||[];},
      read:readPackage,probe:async(...args)=>{performedWork=true;return probeReviewedImage(...args);},
      canContinue:()=>reviewedRecoveryWindow().open,
      canStartWork:()=>reviewedRecoveryWindow().newWorkAllowed,
      onProgress:progress=>{recoveryState.lastRecovery={startedAt,...progress};},
      deliver:(payload,countries)=>{performedWork=true;return deliverReviewedPackage(payload,sb,automaticRecoveryAdapters(),countries);},
    });
    recoveryState.lastRecovery={startedAt,finishedAt:new Date().toISOString(),...result};
    // Do not replace live push progress merely because no package exists.
    if(result.stage==='delivery_attempted'||result.stage==='needs_image_revision'||(result.stage==='window_closed'&&performedWork)){
      const error=result.stage==='window_closed'?'自动恢复窗口已关闭，已保留检查点':result.failures?.length?'部分国家图片待处理':
        result.stage==='delivery_attempted' && (result.result as {ok?:boolean} | null)?.ok !== true ? '部分国家投递待处理' : null;
      await persistPushRun({running:false,startedAt,finishedAt:new Date().toISOString(),durationMs:Date.now()-Date.parse(startedAt),error,summary:{recovery:recoveryState.lastRecovery}});
    }
    return result;
  } catch(error) {
    recoveryState.lastRecovery={startedAt,finishedAt:new Date().toISOString(),stage:'failed',error:error instanceof Error?error.message:'恢复失败'};
    return recoveryState.lastRecovery;
  } finally {recoveryState.running=false;}
}
export function startReviewedRecovery(){
  if(recoveryState.registered)return;
  recoveryState.registered=true;
  // Catch up after a cold start instead of waiting for the next exact cron tick.
  if(!reviewedRecoveryWindow().open)noteClosed('startup');
  else if(issueCutoffElapsed(beijingDate()))void runReviewedRecovery();
  // One existing scheduler; its callback rejects 09:30/40/50 before any DB or
  // network work. Thus admitted cron ticks are exactly 06:00 through 09:20.
  cron.schedule('*/10 6-9 * * *',()=>{if(reviewedRecoveryWindow().open)void runReviewedRecovery();},{timezone:'Asia/Shanghai'});
  console.log(`已注册审定稿包接续：${REVIEWED_RECOVERY_VERSION}，北京时间06:00–09:20每10分钟检查；09:20仅检查或核对已知草稿，不新开耗时批次，09:30关闭自动入口；无自HTTP保活，不采集、不发表。`);
}
