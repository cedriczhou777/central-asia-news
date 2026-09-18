import { NextRequest, NextResponse } from 'next/server';
import { resolveSelfBaseUrl } from '@/lib/runtime';
import { beijingDate } from '@/lib/utils';

export async function POST(request: NextRequest) {
  try {
    // 使用 localhost 进行内部调用，避免 SSL 错误。
    // 端口口径统一由 lib/runtime 决定（旧版写死 5000，与部署声明的端口对不上就静默失败）。
    const baseUrl = resolveSelfBaseUrl();
    const body = await request.json().catch(() => ({}));
    const date = (body as Record<string, string>).date || beijingDate();
    const pushToWechat = (body as Record<string, boolean>).push || false;
    // 与定时任务保持一致的合理默认：每国≥15篇、推送过去24h
    const minPerCountry = typeof (body as Record<string, number>).minPerCountry === 'number' ? (body as Record<string, number>).minPerCountry : 15;
    const hours = typeof (body as Record<string, number>).hours === 'number' ? (body as Record<string, number>).hours : 24;
    const skipTranslation = (body as Record<string, boolean>).skipTranslation === true;

    const log: string[] = [];

    // Step 1: Fetch news
    log.push(`[${new Date().toISOString()}] 开始采集新闻...`);
    try {
      const fetchRes = await fetch(`${baseUrl}/api/fetch-news`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, minPerCountry, skipTranslation }),
      });
      const fetchResult = await fetchRes.json();
      log.push(`[${new Date().toISOString()}] 采集完成：共入库 ${(fetchResult as Record<string, number>).total_saved} 篇文章`);
    } catch (err) {
      log.push(`[${new Date().toISOString()}] 采集失败：${err instanceof Error ? err.message : '未知错误'}`);
    }

    // Step 2: Generate daily digest
    log.push(`[${new Date().toISOString()}] 开始生成各国日报...`);
    let digests: Array<{ country_name: string; article_count: number }> = [];
    try {
      const digestRes = await fetch(`${baseUrl}/api/daily-digest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, minPerCountry }),
      });
      const digestResult = await digestRes.json();
      digests = (digestResult as Record<string, unknown>).digests as Array<{ country_name: string; article_count: number }>;
      log.push(`[${new Date().toISOString()}] 日报生成完成：${digests?.length || 0} 个国家`);
    } catch (err) {
      log.push(`[${new Date().toISOString()}] 日报生成失败：${err instanceof Error ? err.message : '未知错误'}`);
    }

    // Step 3: Push to WeChat (optional) - 按国别分组推送
    if (pushToWechat) {
      log.push(`[${new Date().toISOString()}] 开始推送微信公众号草稿（按国别分组）...`);
      try {
        const wechatRes = await fetch(`${baseUrl}/api/wechat/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date, hours, minPerCountry }),
        });
        // 把推送接口的结果落到日志里：以前这里存进 wechatResult 就再没人用，
        // 推送到底成了几个草稿只能靠翻公众号后台，排查一次要来回切。
        const wechatResult = (await wechatRes.json()) as {
          message?: string;
          drafts?: Array<{ country_name: string; article_count: number }>;
        };
        const draftCount = wechatResult.drafts?.length ?? 0;
        const articleCount = wechatResult.drafts?.reduce((sum, d) => sum + (d.article_count || 0), 0) ?? 0;
        log.push(
          `[${new Date().toISOString()}] 公众号推送完成：${wechatResult.message || `创建 ${draftCount} 个草稿`}` +
            (articleCount > 0 ? `（共 ${articleCount} 篇）` : ''),
        );
      } catch (err) {
        log.push(`[${new Date().toISOString()}] 公众号推送失败：${err instanceof Error ? err.message : '未知错误'}`);
      }
    }

    return NextResponse.json({
      success: true,
      date,
      log,
    });
  } catch (error) {
    console.error('Pipeline 执行失败:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '未知错误',
    }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    message: '每日新闻处理流水线',
    usage: 'POST /api/pipeline with { date?: "YYYY-MM-DD", push?: false }',
    steps: [
      '1. 从 RSS 源采集中亚五国新闻',
      '2. LLM 翻译为中文并分类',
      '3. 按国别生成投资资讯日报',
      '4. (可选) 推送到微信公众号草稿箱',
    ],
  });
}
