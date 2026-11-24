import { NextResponse } from 'next/server';
import { PACKAGE_COUNTRIES, packageCountries, contentHash, issueDate, issueCutoffElapsed, validatePackage, requirePrivateImages } from '@/lib/reviewed-package';
import { queueReviewedRecovery } from '@/lib/reviewed-recovery';
import { planBAdmitted, planBHandlesIssue } from '@/lib/plan-b-window';
import { manualAuthorizationAllows } from '@/lib/reviewed-manual-authorization';
import { REVIEWED_VERSION_CONFLICT, storeReviewedPackage } from '@/lib/reviewed-package-store';
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
    const { hash, duplicate } = await storeReviewedPackage(payload);
    const recoveryQueued=queueReviewedRecovery(payload.version,undefined,req.url);
    const ready=packageCountries(payload),missingCountries=PACKAGE_COUNTRIES.filter(c=>!ready.includes(c));
    return NextResponse.json({ ok:true, version:payload.version, contentHash:hash, duplicate,recoveryQueued,
      inserted:duplicate ? 0 : ready.length, skipped:duplicate ? ready.length : 0,
      readyCountries:ready,partialDelivery:missingCountries.length>0,missingCountries,
      byCountry:Object.fromEntries(ready.map(c=>[c,1])), failed:[],
      stage:'package_received', imagesTransferred:false, draftsCreated:false });
  } catch (error) {
    if (error instanceof Error && error.message === REVIEWED_VERSION_CONFLICT) {
      return NextResponse.json({ ok:false, version:payload.version, error:REVIEWED_VERSION_CONFLICT }, { status:409 });
    }
    return NextResponse.json({ ok:false, version:payload.version, error:'存稿失败，请检查数据库迁移及服务角色权限；可按同版本同内容重试' }, { status:503 });
  }
}
