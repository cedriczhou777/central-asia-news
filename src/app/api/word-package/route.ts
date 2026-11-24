import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { PACKAGE_COUNTRIES, packageCountries, contentHash, issueDate, issueCutoffElapsed, validatePackage, requirePrivateImages } from '@/lib/reviewed-package';
import { queueReviewedRecovery } from '@/lib/reviewed-recovery';
import { planBAdmitted, planBHandlesIssue } from '@/lib/plan-b-window';
import { manualAuthorizationAllows } from '@/lib/reviewed-manual-authorization';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: Request): Promise<Response> {
  if (!process.env.INGEST_SECRET || req.headers.get('x-ingest-secret') !== process.env.INGEST_SECRET) {
    return NextResponse.json({ ok:false, error:'缺少或错误的 X-Ingest-Secret' }, { status:401 });
  }
  let payload;
  try { payload = validatePackage(await req.json()); requirePrivateImages(payload); }
  catch (e) {
    const error = e instanceof Error ? e.message : '稿包无效';
    return NextResponse.json({ ok:false, error }, { status:error.includes('五国未齐') ? 409 : 400 });
  }
  if (planBAdmitted() && planBHandlesIssue(issueDate(payload.version)) &&
      !await manualAuthorizationAllows(req,issueDate(payload.version),payload.version,contentHash(payload),packageCountries(payload),'package')) {
    return NextResponse.json({ ok:false, error:'此刊期使用分国签审交接' }, { status:409 });
  }
  if(!issueCutoffElapsed(payload.version))return NextResponse.json({ok:false,error:'本刊期尚未到北京时间06:00截稿，不接收未来完整稿包'}, {status:409});
  try {
    const sb = getSupabaseClient();
    const hash = contentHash(payload);
    const { error } = await sb.from('reviewed_packages').insert({
      version:payload.version, issue_date:issueDate(payload.version), content_hash:hash, payload,
    });
    if (error && error.code !== '23505') throw new Error('稿包数据库未就绪或写入失败');
    if (error) {
      const existing = await sb.from('reviewed_packages').select('content_hash').eq('version',payload.version).single();
      if (existing.error) throw new Error('无法核实已有版本');
      if (existing.data.content_hash !== hash) return NextResponse.json({ ok:false, version:payload.version, error:'同版本内容不同；修订稿须使用新的修订版本' }, { status:409 });
    }
    const recoveryQueued=queueReviewedRecovery(payload.version,undefined,req.url);
    const ready=packageCountries(payload),missingCountries=PACKAGE_COUNTRIES.filter(c=>!ready.includes(c));
    return NextResponse.json({ ok:true, version:payload.version, contentHash:hash, duplicate:!!error,recoveryQueued,
      inserted:error ? 0 : ready.length, skipped:error ? ready.length : 0,
      readyCountries:ready,partialDelivery:missingCountries.length>0,missingCountries,
      byCountry:Object.fromEntries(ready.map(c=>[c,1])), failed:[],
      stage:'package_received', imagesTransferred:false, draftsCreated:false });
  } catch {
    return NextResponse.json({ ok:false, version:payload.version, error:'存稿失败，请检查数据库迁移及服务角色权限；可按同版本同内容重试' }, { status:503 });
  }
}
