import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  // 使用 localhost 进行内部调用，避免 SSL 错误
  const baseUrl = 'http://localhost:5000';
  const body = await request.json().catch(() => ({}));
  const date = (body as Record<string, string>).date || new Date().toISOString().split('T')[0];
  const pushToWechat = (body as Record<string, boolean>).push || false;

  const log: string[] = [];

  // Step 1: Fetch news
  log.push(`[${new Date().toISOString()}] 开始采集新闻...`);
  const fetchRes = await fetch(`${baseUrl}/api/fetch-news`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date }),
  });
  const fetchResult = await fetchRes.json();
  log.push(`[${new Date().toISOString()}] 采集完成: 共入库 ${(fetchResult as Record<string, number>).total_saved} 篇文章`);

  // Step 2: Generate daily digest
  log.push(`[${new Date().toISOString()}] 开始生成各国日报...`);
  const digestRes = await fetch(`${baseUrl}/api/daily-digest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date }),
  });
  const digestResult = await digestRes.json();
  const digests = (digestResult as Record<string, unknown>).digests as Array<{ country_name: string; article_count: number }>;
  log.push(`[${new Date().toISOString()}] 日报生成完成: ${digests?.length || 0} 个国家`);

  // Step 3: Push to WeChat (optional)
  let wechatResult: Record<string, unknown> | null = null;
  if (pushToWechat && digests) {
    log.push(`[${new Date().toISOString()}] 开始推送微信公众号草稿...`);
    try {
      const wechatRes = await fetch(`${baseUrl}/api/wechat/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ digests, date }),
      });
      wechatResult = await wechatRes.json() as Record<string, unknown>;
      log.push(`[${new Date().toISOString()}] 公众号推送完成`);
    } catch (err) {
      log.push(`[${new Date().toISOString()}] 公众号推送失败: ${err instanceof Error ? err.message : '未知错误'}`);
    }
  }

  return NextResponse.json({
    success: true,
    date,
    log,
    fetch: fetchResult,
    digest: { date, digests: digests?.map((d) => ({ country: d.country_name, articles: d.article_count })) },
    wechat: wechatResult,
  });
}

export async function GET() {
  return NextResponse.json({
    message: '每日新闻处理流水线',
    usage: 'POST /api/pipeline with { date?: "YYYY-MM-DD", push?: false }',
    steps: [
      '1. 从RSS源采集中亚五国新闻',
      '2. LLM翻译为中文并分类',
      '3. 按国别生成投资资讯日报',
      '4. (可选) 推送到微信公众号草稿箱',
    ],
  });
}
