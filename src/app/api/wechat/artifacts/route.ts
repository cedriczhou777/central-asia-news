/** Read existing artifacts only: no model call, WeChat operation, or publication is triggered. */
import { NextRequest, NextResponse } from 'next/server';
import { artifactReadAuthorized, isEditionDate, loadDraftArtifacts } from '@/lib/draft-artifacts';
import { beijingDate } from '@/lib/utils';
import { countryList } from '@/lib/data/countries';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store, no-cache, must-revalidate', 'Vary': 'Authorization' };
export async function GET(request: NextRequest) {
  const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
  if (!process.env.NEWS_ARTIFACT_READ_TOKEN) return reply({ error: '成稿只读入口未配置 NEWS_ARTIFACT_READ_TOKEN' }, 503);
  if (!artifactReadAuthorized(request.headers.get('authorization'))) return reply({ error: '需要成稿只读凭据' }, 401);
  const qp = request.nextUrl.searchParams;
  const date = qp.get('date') ?? beijingDate();
  const country = qp.get('country') ?? undefined;
  const offset = Number(qp.get('offset') ?? 0); const limit = Number(qp.get('limit') ?? 5);
  if (!isEditionDate(date) || (country !== undefined && !countryList.some((c) => c.code === country))
    || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) return reply({ error: '日期、国家或分页参数无效' }, 400);
  try {
    const result = await loadDraftArtifacts(date, country, offset, limit);
    if (!result.artifacts.length && offset === 0) return reply({ date, artifacts: [], nextOffset: null,
      error: '该日期没有已归档成稿；可能尚未推送或产生于归档功能上线之前，不能用库中原始译稿冒充最终成稿' }, 404);
    return reply({ date, ...result });
  } catch {
    return reply({ error: '成稿归档读取或完整性校验失败，请检查数据库权限及归档记录' }, 503);
  }
}
