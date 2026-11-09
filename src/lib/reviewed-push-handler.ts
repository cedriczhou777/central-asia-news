import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '../storage/database/supabase-client';
import { beijingDate } from './utils';
import { issueDate, latestVersion, PACKAGE_COUNTRIES, imageUrls } from './reviewed-package';
import { deliverReviewedPackage, readPackage } from './reviewed-delivery';
import { persistPushRun } from './push-run-store';
import { probeReviewedImage, readReviewedDraft } from './reviewed-wechat';
import { summarizeDraftReadback } from './reviewed-diagnostics';

function authorized(request: NextRequest) {
  return !!process.env.INGEST_SECRET && request.headers.get('x-ingest-secret') === process.env.INGEST_SECRET;
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
    const countries = (requestedCountries ?? PACKAGE_COUNTRIES) as readonly (typeof PACKAGE_COUNTRIES)[number][];
    const rawVersion = body.version ?? request.nextUrl.searchParams.get('version');
    const date = body.date ?? request.nextUrl.searchParams.get('date') ?? beijingDate();
    if (typeof date !== 'string' || issueDate(date) !== date) throw new Error('date 必须为 YYYY-MM-DD');
    let version: string | undefined;
    if (rawVersion != null) {
      if (typeof rawVersion !== 'string') throw new Error('version 无效');
      issueDate(rawVersion); version = rawVersion;
      if ((body.date || request.nextUrl.searchParams.has('date')) && issueDate(version) !== date) throw new Error('date 与 version 刊期不一致');
    } else {
      const result = await getSupabaseClient().from('reviewed_packages').select('version').eq('issue_date',date);
      if (result.error) throw new Error('稿包数据库未就绪');
      version = latestVersion((result.data || []).map(r=>r.version), date);
    }
    if (!version) return NextResponse.json({ ok:false, success:false, running:false, error:'本刊期没有完整审定稿包；停止，不回退旧稿', date }, { status:409 });
    const payload = await readPackage(version);
    if (!payload) return NextResponse.json({ ok:false, error:'指定版本不存在' }, { status:409 });
    const probe = await getSupabaseClient().from('reviewed_deliveries').select('country').eq('version',version);
    if (probe.error) return NextResponse.json({ok:false,error:'投递状态表未就绪'}, {status:503});
    const startedAt = new Date().toISOString();
    // Record a start for scheduler polling. Per-country records remain the authoritative receipt.
    const start = await getSupabaseClient().from('push_runs').upsert({id:'latest', running:true,
      started_at:startedAt, finished_at:null, duration_ms:null, error:null, summary:{version,countries}, updated_at:startedAt}, {onConflict:'id'});
    if (start.error) return NextResponse.json({ok:false,error:'任务状态无法持久化，未启动投递'}, {status:503});
    void deliverReviewedPackage(payload, undefined, undefined, countries).then(async summary => {
      await persistPushRun({ running:false, startedAt, finishedAt:new Date().toISOString(),
        durationMs:Date.now()-Date.parse(startedAt), error:summary.ok ? null : '部分国家待处理', summary });
    }).catch(async () => {
      await persistPushRun({ running:false, startedAt, finishedAt:new Date().toISOString(),
        durationMs:Date.now()-Date.parse(startedAt), error:'投递失败，请读取分国状态', summary:{version,countries} });
    });
    return NextResponse.json({ ok:true, accepted:true, success:true, running:true, version, countries, startedAt, message:'已启动；不代表图片或草稿已完成' }, { status:202 });
  } catch (e) {
    return NextResponse.json({ ok:false, running:false, error:e instanceof Error ? e.message : '投递启动失败' }, { status:400 });
  }
}
export async function reviewedStatus(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ ok:false, error:'鉴权失败' }, { status:401 });
  try {
    const sb = getSupabaseClient();
    const version = request.nextUrl.searchParams.get('version');
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
        const index = Number(rawIndex), country = payload.countries[probeCountry as (typeof PACKAGE_COUNTRIES)[number]];
        const images = imageUrls(country.bodyHtml);
        if (!Number.isSafeInteger(index) || index >= images.length) return NextResponse.json({ ok:false, error:'图片不存在' }, { status:404 });
        const probe = await probeReviewedImage(images[index], country.sourceUrl);
        return NextResponse.json({ ok:true, version, country:probeCountry, imageIndex:index, ...probe });
      }
      const diagnosticCountry = request.nextUrl.searchParams.get('diagnose');
      if (diagnosticCountry) {
        if (!PACKAGE_COUNTRIES.includes(diagnosticCountry as (typeof PACKAGE_COUNTRIES)[number])) return NextResponse.json({ ok:false, error:'国家代码无效' }, { status:400 });
        const row = rows.find(r => r.country === diagnosticCountry);
        if (!payload || !row?.media_id) return NextResponse.json({ ok:false, error:'未找到已有草稿' }, { status:404 });
        const draft = await readReviewedDraft(row.media_id);
        return NextResponse.json({ ok:true, version, country:diagnosticCountry, state:row.state,
          checks:summarizeDraftReadback(payload.countries[diagnosticCountry as (typeof PACKAGE_COUNTRIES)[number]], draft, row.detail?.imageUrls || []) });
      }
      return NextResponse.json({ ok:true, version, packageReceived:!!payload,
        draftsVerified:rows.length === 5 && rows.every(r=>r.state === 'succeeded'), byCountry:rows });
    }
    const result = await sb.from('push_runs').select('*').eq('id','latest').maybeSingle();
    if (result.error) throw new Error('读取任务状态失败');
    const r = result.data;
    return NextResponse.json({ ok:true, transportVersion:'reviewed-package-v1', lastRun:r ? {
      running:r.running, startedAt:r.started_at, finishedAt:r.finished_at,
      durationMs:r.duration_ms, error:r.error, summary:r.summary,
    } : null });
  } catch (e) { return NextResponse.json({ ok:false, error:e instanceof Error ? e.message : '查询失败' }, { status:503 }); }
}
