import { NextRequest, NextResponse } from 'next/server';
import { setTimeout as delay } from 'node:timers/promises';
import { getSupabaseClient } from '../storage/database/supabase-client';
import { beijingDate } from './utils';
import { issueDate, issueCutoffElapsed, latestVersion, PACKAGE_COUNTRIES, packageCountries, reviewedCountry, imageUrls, type ReviewedPackage } from './reviewed-package';
import { canResumePreparation, deliverReviewedPackage, readPackage } from './reviewed-delivery';
import { loadPersistedPushRun, persistPushRun } from './push-run-store';
import { probeReviewedImage, readReviewedDraft, REVIEWED_IMAGE_UPLOAD_CONCURRENCY } from './reviewed-wechat';
import { summarizeDraftReadback, REVIEWED_DIAGNOSTICS_VERSION, coverReadbackSelfTest } from './reviewed-diagnostics';
import { reviewedRecoveryStatus } from './reviewed-recovery';
import { privateImageHealth } from './reviewed-private-images';

function authorized(request: NextRequest) {
  return !!process.env.INGEST_SECRET && request.headers.get('x-ingest-secret') === process.env.INGEST_SECRET;
}

type DeliveryReceipt = Parameters<typeof canResumePreparation>[0] & { country:string };
type PackageCountry = (typeof PACKAGE_COUNTRIES)[number];

async function waitForExistingPreparation(
  version: string,
  countries: readonly PackageCountry[],
  readyCountries: readonly PackageCountry[],
  rows: DeliveryReceipt[],
  readReceipts: (signal: AbortSignal) => PromiseLike<{data: DeliveryReceipt[] | null; error: unknown}>,
) {
  const signal = AbortSignal.timeout(45_000);
  let readFailed = false;
  while (rows.some(row => ['preparing','sending','updating'].includes(row.state)) && !signal.aborted) {
    try {
      await delay(1_500, undefined, { signal });
      const result = await readReceipts(signal);
      if (signal.aborted) break;
      if (result.error || !result.data) {
        readFailed = true;
        break;
      }
      rows = result.data;
    } catch {
      readFailed = !signal.aborted;
      break;
    }
  }

  const drafts: object[] = [], failures: object[] = [], pendingCountries: PackageCountry[] = [];
  for (const country of countries) {
    const row = rows.find(receipt => receipt.country === country);
    if (row?.state === 'succeeded' && row.media_id) {
      drafts.push({...row.detail,country_code:country,media_id:row.media_id});
    } else if (row && ['preparing','sending','updating'].includes(row.state)) {
      pendingCountries.push(country);
    } else {
      const error = row?.detail?.error;
      failures.push({country,state:row?.state ?? 'not_started',media_id:row?.media_id ?? null,
        error:typeof error === 'string' ? error : '未查到已核验草稿回执'});
    }
  }
  const pending = pendingCountries.length > 0;
  const ok = drafts.length === countries.length;
  const summary = {ok,version,drafts,failures,countries,readyCountries,partialDelivery:countries.length<5,
    missingCountries:PACKAGE_COUNTRIES.filter(country=>!countries.includes(country))};
  return NextResponse.json({ok,success:ok,running:pending,pending,pendingCountries,version,countries,summary,
    ...(readFailed ? {error:'读取现有投递状态失败'} : {})}, {status:readFailed ? 503 : pending ? 202 : 200});
}

export async function reviewedPush(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ ok:false, error:'鉴权失败' }, { status:401 });
  try {
    const body = await request.json().catch(()=>({}));
    const requestedCountries = body.countries;
    if (requestedCountries !== undefined && (!Array.isArray(requestedCountries) || requestedCountries.length === 0 ||
      requestedCountries.some((country: unknown) => !PACKAGE_COUNTRIES.includes(country as (typeof PACKAGE_COUNTRIES)[number])) ||
      new Set(requestedCountries).size !== requestedCountries.length)) {
      throw new Error('countries 必须是无重复的五国代码子集');
    }
    const requestedScope = requestedCountries as readonly (typeof PACKAGE_COUNTRIES)[number][] | undefined;
    const rawVersion = body.version ?? request.nextUrl.searchParams.get('version');
    const date = body.date ?? request.nextUrl.searchParams.get('date') ?? beijingDate();
    if (typeof date !== 'string' || issueDate(date) !== date) throw new Error('date 必须为 YYYY-MM-DD');
    let version: string | undefined;
    let payload:ReviewedPackage|null|undefined;
    if (rawVersion != null) {
      if (typeof rawVersion !== 'string') throw new Error('version 无效');
      issueDate(rawVersion); version = rawVersion;
      if ((body.date || request.nextUrl.searchParams.has('date')) && issueDate(version) !== date) throw new Error('date 与 version 刊期不一致');
    } else {
      const result = await getSupabaseClient().from('reviewed_packages').select('version').eq('issue_date',date);
      if (result.error) throw new Error('稿包数据库未就绪');
      let remaining=(result.data || []).map(r=>r.version);
      version=latestVersion(remaining,date);
      if(requestedScope){
        version=undefined;
        while(remaining.length){
          const candidate=latestVersion(remaining,date);if(!candidate)break;
          const found=await readPackage(candidate);
          if(found&&requestedScope.every(c=>packageCountries(found).includes(c))){version=candidate;payload=found;break;}
          remaining=remaining.filter(v=>v!==candidate);
        }
      }
    }
    if (!version) return NextResponse.json({ ok:false, success:false, running:false, error:requestedScope?'本刊期没有单个已审稿包包含所有请求国家；请按已接收版本逐国投递':'本刊期尚无可投递的已审稿包；停止，不回退旧稿', date }, { status:409 });
    if(!issueCutoffElapsed(version))return NextResponse.json({ok:false,error:'本刊期尚未到北京时间06:00截稿，不创建未来草稿'}, {status:409});
    payload ??= await readPackage(version);
    if (!payload) return NextResponse.json({ ok:false, error:'指定版本不存在' }, { status:409 });
    const ready=packageCountries(payload);
    const countries = requestedScope ?? ready;
    if(countries.some(country=>!ready.includes(country)))return NextResponse.json({ok:false,error:'请求国家未列入该版本 readyCountries，未启动任何投递',version,readyCountries:ready},{status:409});
    if (body.waitForCompletion === true) {
      const selectedVersion = version;
      const readReceipts = () => getSupabaseClient().from('reviewed_deliveries')
        .select('country,state,media_id,updated_at,detail').eq('version',selectedVersion).in('country',countries);
      const probe = await readReceipts();
      if (probe.error) return NextResponse.json({ok:false,error:'投递状态表未就绪'}, {status:503});
      const rows: DeliveryReceipt[] = probe.data ?? [];
      if (rows.some(row => row.state === 'preparing' && !row.media_id && !canResumePreparation(row))) {
        return await waitForExistingPreparation(version,countries,ready,rows,signal=>readReceipts().abortSignal(signal));
      }
    } else {
      const probe = await getSupabaseClient().from('reviewed_deliveries').select('country').eq('version',version);
      if (probe.error) return NextResponse.json({ok:false,error:'投递状态表未就绪'}, {status:503});
    }
    const startedAt = new Date().toISOString();
    // Record a start for scheduler polling. Per-country records remain the authoritative receipt.
    const start = await getSupabaseClient().from('push_runs').upsert({id:'latest', running:true,
      started_at:startedAt, finished_at:null, duration_ms:null, error:null, summary:{version,countries}, updated_at:startedAt}, {onConflict:'id'});
    if (start.error) return NextResponse.json({ok:false,error:'任务状态无法持久化，未启动投递'}, {status:503});
    if (body.waitForCompletion === true) {
      let summary: Awaited<ReturnType<typeof deliverReviewedPackage>> | { version:string; countries:typeof countries } = { version, countries };
      let error: string | null;
      let status = 200;
      try {
        const delivered = await deliverReviewedPackage(payload, undefined, undefined, countries);
        summary = delivered;
        error = delivered.ok ? null : '部分国家待处理';
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        status = 500;
      }
      const finishedAt = new Date().toISOString();
      await persistPushRun({ running:false, startedAt, finishedAt,
        durationMs:Date.parse(finishedAt)-Date.parse(startedAt), error, summary });
      const result = { running:false, version, countries, startedAt, finishedAt, summary };
      // The shared store suppresses write errors; confirm this run before reporting completion.
      const persisted = await loadPersistedPushRun();
      if (!persisted?.started_at || !persisted.finished_at || persisted.running || persisted.error !== error ||
        Date.parse(persisted.started_at) !== Date.parse(startedAt) || Date.parse(persisted.finished_at) !== Date.parse(finishedAt)) {
        return NextResponse.json({ ...result, ok:false, success:false, error:'无法确认投递结果已持久化，请查询分国回执', deliveryError:error }, { status:503 });
      }
      return NextResponse.json({ ...result, ok:error === null, success:error === null, error }, { status });
    }
    void deliverReviewedPackage(payload, undefined, undefined, countries).then(async summary => {
      await persistPushRun({ running:false, startedAt, finishedAt:new Date().toISOString(),
        durationMs:Date.now()-Date.parse(startedAt), error:summary.ok ? null : '部分国家待处理', summary });
    }).catch(async () => {
      await persistPushRun({ running:false, startedAt, finishedAt:new Date().toISOString(),
        durationMs:Date.now()-Date.parse(startedAt), error:'投递失败，请读取分国状态', summary:{version,countries} });
    });
    return NextResponse.json({ ok:true, accepted:true, success:true, running:true, version, countries, startedAt,
      readyCountries:ready,partialDelivery:countries.length<5,missingCountries:PACKAGE_COUNTRIES.filter(c=>!countries.includes(c)),
      message:'已启动；不代表图片或草稿已完成' }, { status:202 });
  } catch (e) {
    return NextResponse.json({ ok:false, running:false, error:e instanceof Error ? e.message : '投递启动失败' }, { status:400 });
  }
}
export async function reviewedStatus(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ ok:false, error:'鉴权失败' }, { status:401 });
  try {
    if (request.nextUrl.searchParams.get('health') === '1') return NextResponse.json({ok:true,transportVersion:'reviewed-package-v3',capabilities:{partialCountries:true,synchronousDelivery:true,activePreparationWait:true,imagePreparationConcurrency:REVIEWED_IMAGE_UPLOAD_CONCURRENCY,nativeMemoryAllocatorConfigured:process.env.MALLOC_ARENA_MAX==='2'&&process.env.MALLOC_TRIM_THRESHOLD_==='65536'},diagnosticsVersion:REVIEWED_DIAGNOSTICS_VERSION,recovery:reviewedRecoveryStatus(),images:await privateImageHealth(),
      ...(request.nextUrl.searchParams.get('selftest')==='cover' ? {coverSelfTest:coverReadbackSelfTest()} : {})});
    const sb = getSupabaseClient();
    const version = request.nextUrl.searchParams.get('version');
    const date=request.nextUrl.searchParams.get('date');
    if(!version&&date){
      if(issueDate(date)!==date)throw new Error('date必须为刊期日期');
      const found=await sb.from('reviewed_packages').select('version').eq('issue_date',date);
      if(found.error)throw new Error('无法读取刊期稿包');
      const versions=(found.data||[]).map(r=>r.version);
      const records=versions.length?await sb.from('reviewed_deliveries').select('*').in('version',versions):{data:[],error:null};
      if(records.error)throw new Error('无法读取刊期回执');
      const byCountry=PACKAGE_COUNTRIES.map(country=>{
        const active=(records.data||[]).filter(r=>r.country===country&&(r.state!=='failed'||r.media_id));
        return {country,conflict:active.length>1,receipt:active.length===1?active[0]:null};
      });
      const draftsVerified=byCountry.every(r=>!r.conflict&&r.receipt?.state==='succeeded'&&r.receipt.media_id);
      return NextResponse.json({ok:true,date,versions,packageReceived:versions.length>0,draftsVerified,byCountry,
        deadlineMissed:!draftsVerified&&Date.now()>=Date.parse(date+'T08:00:00+08:00'),recovery:reviewedRecoveryStatus()});
    }
    if (version) {
      issueDate(version);
      const payload = await readPackage(version);
      const result = await sb.from('reviewed_deliveries').select('*').eq('version',version);
      if (result.error) throw new Error('读取投递回执失败');
      const rows = result.data || [];
      const probeCountry = request.nextUrl.searchParams.get('probeCountry');
      if (probeCountry) {
        if (!PACKAGE_COUNTRIES.includes(probeCountry as (typeof PACKAGE_COUNTRIES)[number])) return NextResponse.json({ ok:false, error:'国家代码无效' }, { status:400 });
        if (!payload) return NextResponse.json({ ok:false, error:'稿包不存在' }, { status:404 });
        const rawIndex = request.nextUrl.searchParams.get('imageIndex');
        if (rawIndex === null || !/^\d+$/.test(rawIndex)) return NextResponse.json({ ok:false, error:'图片序号无效' }, { status:400 });
        if(!packageCountries(payload).includes(probeCountry as (typeof PACKAGE_COUNTRIES)[number]))return NextResponse.json({ok:false,error:'该版本未包含此已审国家'},{status:404});
        const index = Number(rawIndex), country = reviewedCountry(payload,probeCountry as (typeof PACKAGE_COUNTRIES)[number]);
        const images = imageUrls(country.bodyHtml);
        if (!Number.isSafeInteger(index) || index >= images.length) return NextResponse.json({ ok:false, error:'图片不存在' }, { status:404 });
        const probe = await probeReviewedImage(images[index], country.sourceUrl, country.imageAssets?.[images[index]]);
        return NextResponse.json({ ok:true, version, country:probeCountry, imageIndex:index, ...probe });
      }
      const diagnosticCountry = request.nextUrl.searchParams.get('diagnose');
      if (diagnosticCountry) {
        if (!PACKAGE_COUNTRIES.includes(diagnosticCountry as (typeof PACKAGE_COUNTRIES)[number])) return NextResponse.json({ ok:false, error:'国家代码无效' }, { status:400 });
        const row = rows.find(r => r.country === diagnosticCountry);
        if (!payload || !row?.media_id) return NextResponse.json({ ok:false, error:'未找到已有草稿' }, { status:404 });
        if(!packageCountries(payload).includes(diagnosticCountry as (typeof PACKAGE_COUNTRIES)[number]))return NextResponse.json({ok:false,error:'该版本未包含此已审国家'},{status:404});
        const draft = await readReviewedDraft(row.media_id);
        return NextResponse.json({ ok:true, version, country:diagnosticCountry, state:row.state,
          checks:summarizeDraftReadback(reviewedCountry(payload,diagnosticCountry as (typeof PACKAGE_COUNTRIES)[number]), draft, row.detail?.imageUrls || [], row.detail?.expectedThumbMediaId) });
      }
      const ready=payload?packageCountries(payload):[],missingCountries=PACKAGE_COUNTRIES.filter(c=>!ready.includes(c));
      const readyDraftsVerified=ready.length>0&&ready.every(country=>rows.some(row=>row.country===country&&row.state==='succeeded'&&row.media_id));
      return NextResponse.json({ ok:true, version, packageReceived:!!payload, contentHash:payload ? (await import('./reviewed-package')).contentHash(payload) : null, recovery:reviewedRecoveryStatus(),
        readyCountries:ready,partialDelivery:missingCountries.length>0,missingCountries,readyDraftsVerified,
        draftsVerified:ready.length===5&&readyDraftsVerified, byCountry:rows });
    }
    const result = await sb.from('push_runs').select('*').eq('id','latest').maybeSingle();
    if (result.error) throw new Error('读取任务状态失败');
    const r = result.data;
    return NextResponse.json({ ok:true, transportVersion:'reviewed-package-v3',capabilities:{partialCountries:true}, lastRun:r ? {
      running:r.running, startedAt:r.started_at, finishedAt:r.finished_at,
      durationMs:r.duration_ms, error:r.error, summary:r.summary,
    } : null });
  } catch (e) { return NextResponse.json({ ok:false, error:e instanceof Error ? e.message : '查询失败' }, { status:503 }); }
}
