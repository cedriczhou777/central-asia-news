import cron from 'node-cron';
import { getSupabaseClient } from '../storage/database/supabase-client';
import { beijingDate } from './utils';
import { imageUrls, issueDate, latestVersion, PACKAGE_COUNTRIES, type ReviewedPackage } from './reviewed-package';
import { deliverReviewedPackage, readPackage } from './reviewed-delivery';
import { probeReviewedImage } from './reviewed-wechat';
import { persistPushRun } from './push-run-store';

export const REVIEWED_RECOVERY_VERSION = '2026-11-12-v2';
type Row = { version:string; country:string; state:string; media_id?:string | null };
type Dependencies = {
  packages:(date:string)=>Promise<string[]>;
  deliveries:(versions:string[])=>Promise<Row[]>;
  read:(version:string)=>Promise<ReviewedPackage | null>;
  probe:typeof probeReviewedImage;
  deliver:(payload:ReviewedPackage,countries:readonly (typeof PACKAGE_COUNTRIES)[number][])=>Promise<unknown>;
  onPending?:()=>void;
};
/** Resume only absent / definitely failed-before-create countries. Never switch
 * versions after any country started; sending/uncertain requires read-only review. */
export async function recoverReviewedIssue(date:string,deps:Dependencies) {
  const versions = await deps.packages(date);
  if (!versions.length) return {stage:'awaiting_package',date};
  const rows = await deps.deliveries(versions);
  const startedVersions = [...new Set(rows.map(r=>r.version))];
  if (startedVersions.length > 1) return {stage:'blocked_multiple_versions',date};
  const version = startedVersions[0] || latestVersion(versions,date)!;
  const current = rows.filter(r=>r.version===version);
  const pending = PACKAGE_COUNTRIES.filter(c=> {
    const row=current.find(r=>r.country===c);
    return !row || (row.state==='failed' && !row.media_id);
  });
  if (!pending.length) return {stage:current.length===5 && current.every(r=>r.state==='succeeded') ? 'complete' : 'waiting_existing_delivery',version};
  deps.onPending?.();
  const payload = await deps.read(version);
  if (!payload) throw new Error('已接收稿包无法读取');
  const failures:object[] = [];
  // Use exactly the origin path used by draft preparation; successful probes
  // populate its bounded cache. Do not silently discard any failed image.
  for (const country of pending) {
    const d=payload.countries[country];
    for (const [index,url] of imageUrls(d.bodyHtml).entries()) {
      let result=await deps.probe(url,d.sourceUrl);
      if (!result.accessible && !/HTTP 40[134]/.test(result.reason || '')) result=await deps.probe(url,d.sourceUrl);
      if (!result.accessible) failures.push({country,index,reason:result.reason});
    }
  }
  if (failures.length) return {stage:'needs_image_revision',version,failures};
  const result=await deps.deliver(payload,pending);
  return {stage:'delivery_attempted',version,countries:pending,result};
}

let running=false, registered=false;
let lastRecovery:Record<string,unknown> | null = null;
export function reviewedRecoveryStatus(){return {version:REVIEWED_RECOVERY_VERSION,running,lastRun:lastRecovery};}
export function queueReviewedRecovery(version:string, today=beijingDate()) {
  if(issueDate(version)!==today)return false;
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
    const target=process.env.KEEPALIVE_TARGET_URL || 'https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com/';
    if(!target.startsWith('https://'))return;
    const ping=async()=>{try{const r=await fetch(target,{signal:AbortSignal.timeout(30000)});await r.body?.cancel();}catch{/* next bounded heartbeat retries */}};
    void ping(); heartbeat=setInterval(()=>{void ping();},5*60_000);heartbeat.unref();
  };
  lastRecovery={startedAt,stage:'checking'};
  try {
    const sb=getSupabaseClient();
    const result=await recoverReviewedIssue(beijingDate(),{
      packages:async date=>{const r=await sb.from('reviewed_packages').select('version').eq('issue_date',date);if(r.error)throw new Error('稿包恢复查询失败');return (r.data||[]).map(r=>r.version);},
      deliveries:async versions=>{const r=await sb.from('reviewed_deliveries').select('version,country,state,media_id').in('version',versions);if(r.error)throw new Error('投递恢复查询失败');return r.data||[];},
      read:readPackage,probe:probeReviewedImage,onPending:keepAwake,
      deliver:(payload,countries)=>deliverReviewedPackage(payload,sb,undefined,countries),
    });
    lastRecovery={startedAt,finishedAt:new Date().toISOString(),...result};
    // Do not replace live push progress merely because no package exists.
    if(result.stage==='delivery_attempted'||result.stage==='needs_image_revision')await persistPushRun({running:false,startedAt,finishedAt:new Date().toISOString(),durationMs:Date.now()-Date.parse(startedAt),error:result.stage==='needs_image_revision'?'图片需修订':null,summary:{recovery:lastRecovery}});
    return result;
  } catch(error) {
    lastRecovery={startedAt,finishedAt:new Date().toISOString(),stage:'failed',error:error instanceof Error?error.message:'恢复失败'};
    return lastRecovery;
  } finally {if(heartbeat)clearInterval(heartbeat);running=false;}
}
export function startReviewedRecovery(){
  if(registered)return;
  registered=true;
  cron.schedule('*/10 6-14 * * *',()=>{void runReviewedRecovery();},{timezone:'Asia/Shanghai'});
  console.log(`已注册审定稿包接续：${REVIEWED_RECOVERY_VERSION}，北京时间06:00–14:50每10分钟检查；不采集、不发表。`);
}
