import cron from 'node-cron';
import { getSupabaseClient } from '../storage/database/supabase-client';
import { beijingDate } from './utils';
import { imageUrls, issueDate, issueCutoffElapsed, latestVersion, PACKAGE_COUNTRIES, type ReviewedPackage } from './reviewed-package';
import { deliverReviewedPackage, readPackage, canResumePreparation } from './reviewed-delivery';
import { probeReviewedImage } from './reviewed-wechat';
import { persistPushRun } from './push-run-store';

export const REVIEWED_RECOVERY_VERSION = '2026-11-14-v5';
type Row = { version:string; country:string; state:string; media_id?:string | null;updated_at?:string;detail?:Record<string,unknown> };
type Dependencies = {
  packages:(date:string)=>Promise<string[]>;
  deliveries:(versions:string[])=>Promise<Row[]>;
  read:(version:string)=>Promise<ReviewedPackage | null>;
  probe:typeof probeReviewedImage;
  deliver:(payload:ReviewedPackage,countries:readonly (typeof PACKAGE_COUNTRIES)[number][])=>Promise<unknown>;
  onPending?:()=>void;
  onProgress?:(progress:Record<string,unknown>)=>void;
};
/** Plan per country across revisions. An active receipt pins that country's
 * version; failed-before-create rows do not block other countries or corrections.
 * The database's unique active (issue,country) index remains the final lock. */
export async function recoverReviewedIssue(date:string,deps:Dependencies) {
  const versions = await deps.packages(date);
  if (!versions.length) return {stage:'awaiting_package',date};
  const rows = await deps.deliveries(versions);
  const version = latestVersion(versions,date)!;
  const versionsByCountry:Record<string,string>={};
  const failures:Array<{country:string;index?:number;reason?:string}>=[];
  const pending: Array<{country:typeof PACKAGE_COUNTRIES[number];version:string;reconcileOnly?:boolean}>=[];
  let completed=0;
  for(const country of PACKAGE_COUNTRIES){
    const active=rows.filter(r=>r.country===country&&(r.state!=='failed'||!!r.media_id));
    if(active.length>1){failures.push({country,reason:'同国存在多条活动回执，禁止自动建稿'});continue;}
    if(active.length===1){
      const row=active[0];versionsByCountry[country]=row.version;
      if(row.state==='succeeded'&&row.media_id)completed++;
      else if(['uncertain','sending'].includes(row.state)&&row.media_id)pending.push({country,version:row.version,reconcileOnly:true});
      else if(canResumePreparation(row))pending.push({country,version:row.version});
      continue; // Includes failed+media_id, preparing and uncertain; never steal locks.
    }
    versionsByCountry[country]=version;pending.push({country,version});
  }
  if (!pending.length) return {stage:completed===5?'complete':'waiting_existing_delivery',version,versionsByCountry,failures};
  deps.onPending?.();
  const results:unknown[]=[];const attempted:typeof PACKAGE_COUNTRIES[number][]=[];
  const packages=new Map<string,ReviewedPackage>();
  for (const item of pending) {
    const {country}=item;
    try{
      let payload=packages.get(item.version);
      if(!payload){payload=await deps.read(item.version)||undefined;if(!payload)throw new Error('已接收稿包无法读取');packages.set(item.version,payload);}
      if(item.reconcileOnly){results.push(await deps.deliver(payload,[country]));attempted.push(country);continue;}
      const d=payload.countries[country],images=imageUrls(d.bodyHtml),before=failures.length;
      deps.onProgress?.({country,version:item.version,stage:'checking_images',totalImages:images.length});
      // Small bounded concurrency; delivery starts as soon as THIS country is
      // ready, rather than waiting behind every other country's slow origin.
      for(let offset=0;offset<images.length;offset+=3){
        await Promise.all(images.slice(offset,offset+3).map(async(url,j)=>{
          const index=offset+j;let result=await deps.probe(url,d.sourceUrl,d.imageAssets?.[url]);
          if(!result.accessible&&!/HTTP 40[134]|HTTP 429|存档缺失|哈希/.test(result.reason||''))result=await deps.probe(url,d.sourceUrl,d.imageAssets?.[url]);
          if(!result.accessible)failures.push({country,index,reason:result.reason});
        }));
      }
      if(failures.length!==before)continue;
      deps.onProgress?.({country,version:item.version,stage:'delivering'});
      const result=await deps.deliver(payload,[country]);results.push(result);attempted.push(country);
    }catch(e){failures.push({country,reason:e instanceof Error?e.message:'国别接续失败'});}
  }
  if(!attempted.length)return {stage:'needs_image_revision',version,versionsByCountry,failures};
  return {stage:'delivery_attempted',version,versionsByCountry,countries:attempted,failures,result:{ok:!failures.length&&results.every(r=>(r as {ok?:boolean})?.ok===true),results}};
}

let running=false, registered=false;
let lastRecovery:Record<string,unknown> | null = null;
let acceptedOrigin:string|undefined;
export function reviewedRecoveryStatus(){return {version:REVIEWED_RECOVERY_VERSION,running,lastRun:lastRecovery};}
export function queueReviewedRecovery(version:string, today=beijingDate(), requestUrl?:string) {
  if(issueDate(version)!==today || !issueCutoffElapsed(version))return false;
  if(requestUrl){try{const origin=new URL(requestUrl);if(origin.protocol==='https:'&&!origin.username&&!origin.password)acceptedOrigin=origin.origin+'/';}catch{/* Optional heartbeat only. */}}
  // Ingest is an explicit authorized write. Continue its accepted work even if
  // the client turn ends or the instance woke after the last cron tick.
  setTimeout(()=>{void runReviewedRecovery();},0);
  return true;
}
export async function runReviewedRecovery() {
  if(running)return {stage:'already_running'};
  running=true;
  const startedAt=new Date().toISOString();
  let heartbeat:ReturnType<typeof setInterval> | undefined;
  const keepAwake=()=>{
    const target=process.env.KEEPALIVE_TARGET_URL || acceptedOrigin;
    if(!target?.startsWith('https://'))return;
    const ping=async()=>{try{const r=await fetch(target,{signal:AbortSignal.timeout(30000)});await r.body?.cancel();}catch{/* next bounded heartbeat retries */}};
    void ping(); heartbeat=setInterval(()=>{void ping();},5*60_000);heartbeat.unref();
  };
  lastRecovery={startedAt,stage:'checking'};
  try {
    const sb=getSupabaseClient();
    const result=await recoverReviewedIssue(beijingDate(),{
      packages:async date=>{const r=await sb.from('reviewed_packages').select('version').eq('issue_date',date);if(r.error)throw new Error('稿包恢复查询失败');return (r.data||[]).map(r=>r.version);},
      deliveries:async versions=>{const r=await sb.from('reviewed_deliveries').select('version,country,state,media_id,updated_at,detail').in('version',versions);if(r.error)throw new Error('投递恢复查询失败');return r.data||[];},
      read:readPackage,probe:probeReviewedImage,onPending:keepAwake,
      onProgress:progress=>{lastRecovery={startedAt,...progress};},
      deliver:(payload,countries)=>deliverReviewedPackage(payload,sb,undefined,countries),
    });
    lastRecovery={startedAt,finishedAt:new Date().toISOString(),...result};
    // Do not replace live push progress merely because no package exists.
    if(result.stage==='delivery_attempted'||result.stage==='needs_image_revision'){
      const error=result.failures?.length?'部分国家图片待处理':
        result.stage==='delivery_attempted' && (result.result as {ok?:boolean} | null)?.ok !== true ? '部分国家投递待处理' : null;
      await persistPushRun({running:false,startedAt,finishedAt:new Date().toISOString(),durationMs:Date.now()-Date.parse(startedAt),error,summary:{recovery:lastRecovery}});
    }
    return result;
  } catch(error) {
    lastRecovery={startedAt,finishedAt:new Date().toISOString(),stage:'failed',error:error instanceof Error?error.message:'恢复失败'};
    return lastRecovery;
  } finally {if(heartbeat)clearInterval(heartbeat);running=false;}
}
export function startReviewedRecovery(){
  if(registered)return;
  registered=true;
  // Catch up after a cold start instead of waiting for the next exact cron tick.
  if(issueCutoffElapsed(beijingDate()))void runReviewedRecovery();
  cron.schedule('*/10 6-14 * * *',()=>{void runReviewedRecovery();},{timezone:'Asia/Shanghai'});
  console.log(`已注册审定稿包接续：${REVIEWED_RECOVERY_VERSION}，北京时间06:00–14:50每10分钟检查；不采集、不发表。`);
}
