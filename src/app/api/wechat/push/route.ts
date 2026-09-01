import { NextRequest, NextResponse } from 'next/server';
import { countryList } from '@/lib/data/countries';

const WECHAT_API_BASE = 'https://api.weixin.qq.com/cgi-bin';

interface WeChatConfig {
  appId: string;
  appSecret: string;
}

function getWechatConfig(): WeChatConfig {
  const appId = process.env.WECHAT_APP_ID;
  const appSecret = process.env.WECHAT_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('未配置微信公众号信息，请设置环境变量 WECHAT_APP_ID 和 WECHAT_APP_SECRET');
  }
  return { appId, appSecret };
}

async function getAccessToken(appId: string, appSecret: string): Promise<string> {
  const url = `${WECHAT_API_BASE}/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.errcode) {
    throw new Error(`获取access_token失败: ${data.errmsg}`);
  }
  return data.access_token;
}

async function uploadThumb(accessToken: string): Promise<string> {
  const defaultThumbUrl = 'https://lf-coze-web-cdn.coze.cn/obj/eden-cn/lm-lgvj/ljhwZthlaukjlkulzlp/coze-coding/icon/coze-coding.gif';

  const url = `${WECHAT_API_BASE}/media/uploadimg?access_token=${accessToken}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: defaultThumbUrl }),
  });
  const data = await res.json();
  if (data.errcode) {
    throw new Error(`上传缩略图失败: ${data.errmsg}`);
  }
  return data.url;
}

interface DraftArticle {
  title: string;
  author: string;
  content: string;
  digest: string;
  thumb_media_id?: string;
  need_open_comment?: number;
}

async function addDraft(accessToken: string, articles: DraftArticle[]): Promise<string> {
  const url = `${WECHAT_API_BASE}/draft/add?access_token=${accessToken}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ articles }),
  });
  const data = await res.json();
  if (data.errcode) {
    throw new Error(`创建草稿失败: ${data.errmsg}`);
  }
  return data.media_id;
}

function formatDigestAsHtml(countryName: string, digest: string, articleCount: number): string {
  const paragraphs = digest.split('\n').filter((p) => p.trim());
  const htmlContent = paragraphs
    .map((p) => {
      const trimmed = p.trim();
      if (trimmed.startsWith('# ')) {
        return `<h2 style="font-size:18px;font-weight:bold;color:#0F1B2D;margin:20px 0 10px;">${trimmed.substring(2)}</h2>`;
      }
      if (trimmed.startsWith('## ')) {
        return `<h3 style="font-size:16px;font-weight:bold;color:#0F1B2D;margin:16px 0 8px;">${trimmed.substring(3)}</h3>`;
      }
      if (trimmed.startsWith('📌') || trimmed.startsWith('📊') || trimmed.startsWith('⚡') || trimmed.startsWith('💡')) {
        return `<p style="font-size:15px;line-height:1.8;color:#333;margin:12px 0;padding:8px 12px;background:#F8F6F1;border-radius:4px;">${trimmed}</p>`;
      }
      if (/^\d+[.、]/.test(trimmed)) {
        return `<p style="font-size:15px;line-height:1.8;color:#333;margin:8px 0 8px 16px;">${trimmed}</p>`;
      }
      return `<p style="font-size:15px;line-height:1.8;color:#333;margin:8px 0;">${trimmed}</p>`;
    })
    .join('\n');

  return `
<section style="max-width:100%;box-sizing:border-box;padding:16px;">
  <div style="text-align:center;margin-bottom:20px;padding-bottom:16px;border-bottom:2px solid #C8A45C;">
    <h1 style="font-size:20px;font-weight:bold;color:#0F1B2D;margin:0;">🌏 ${countryName} · 每日投资资讯</h1>
    <p style="font-size:13px;color:#6B7280;margin:8px 0 0;">${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })} | 共 ${articleCount} 条资讯</p>
  </div>
  ${htmlContent}
  <div style="text-align:center;margin-top:24px;padding-top:16px;border-top:1px solid #E5E2DB;">
    <p style="font-size:12px;color:#6B7280;">中亚投资资讯 | 面向中国投资者的中亚五国商业新闻平台</p>
  </div>
</section>`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { digests, date } = body as { digests?: Array<{ country_code: string; country_name: string; digest: string; article_count: number }>; date?: string };

    if (!digests || !Array.isArray(digests)) {
      return NextResponse.json(
        { error: '请提供 digests 数组，可通过 POST /api/daily-digest 获取' },
        { status: 400 }
      );
    }

    const config = getWechatConfig();
    const accessToken = await getAccessToken(config.appId, config.appSecret);

    const results: Array<{ country: string; media_id: string; status: string }> = [];

    for (const digestItem of digests) {
      const country = countryList.find((c) => c.code === digestItem.country_code);
      if (!country) continue;

      const htmlContent = formatDigestAsHtml(
        country.name,
        digestItem.digest,
        digestItem.article_count
      );

      const mediaId = await addDraft(accessToken, [
        {
          title: `${country.name} · 每日投资资讯 (${date || new Date().toISOString().split('T')[0]})`,
          author: '中亚投资资讯',
          content: htmlContent,
          digest: digestItem.digest.substring(0, 120),
        },
      ]);

      results.push({
        country: country.name,
        media_id: mediaId,
        status: 'success',
      });
    }

    return NextResponse.json({
      success: true,
      date: date || new Date().toISOString().split('T')[0],
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    message: '微信公众号草稿推送接口',
    usage: 'POST /api/wechat/push with { digests: [...], date: "YYYY-MM-DD" }',
    required_env: ['WECHAT_APP_ID', 'WECHAT_APP_SECRET'],
    flow: '1. POST /api/fetch-news → 采集新闻入库\n2. POST /api/daily-digest → 生成各国日报\n3. POST /api/wechat/push → 推送草稿到公众号',
  });
}
