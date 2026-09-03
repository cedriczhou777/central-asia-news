import { NextRequest, NextResponse } from 'next/server';
import { countryList } from '@/lib/data/countries';

const WECHAT_API_BASE = 'https://api.weixin.qq.com/cgi-bin';
const USE_CLOUD_CALL = process.env.USE_WECHAT_CLOUD_CALL === 'true';

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

// 云调用模式：使用云托管的免 access_token 调用
async function cloudCallApi(apiPath: string, data: any): Promise<any> {
  const url = `${WECHAT_API_BASE}${apiPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Wechat-Key': process.env.WECHAT_CLOUD_KEY || '',
    },
    body: JSON.stringify(data),
  });
  return res.json();
}

// 传统模式：需要 access_token
async function getAccessToken(appId: string, appSecret: string): Promise<string> {
  const url = `${WECHAT_API_BASE}/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.errcode) {
    throw new Error(`获取 access_token 失败：${data.errmsg}`);
  }
  return data.access_token;
}

async function callWechatApi(apiPath: string, accessToken: string, data: any): Promise<any> {
  const url = `${WECHAT_API_BASE}${apiPath}?access_token=${accessToken}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
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
    throw new Error(`上传缩略图失败：${data.errmsg}`);
  }
  return data.url;
}

interface DraftArticle {
  title: string;
  author: string;
  content: string;
  digest: string;
  thumbMediaId: string;
  needOpenComment: number;
  onlyFansCanComment: number;
}

async function addDraft(accessToken: string, articles: DraftArticle[]): Promise<string> {
  const url = `${WECHAT_API_BASE}/draft/add?access_token=${accessToken}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      articles: articles.map(a => ({
        title: a.title,
        author: a.author,
        content: a.content,
        digest: a.digest,
        thumb_media_id: a.thumbMediaId,
        need_open_comment: a.needOpenComment,
        only_fans_can_comment: a.onlyFansCanComment,
      })),
    }),
  });
  const data = await res.json();
  if (data.errcode) {
    throw new Error(`创建草稿失败：${data.errmsg}`);
  }
  return data.media_id;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { digests, date } = body;

    if (!digests || !Array.isArray(digests) || digests.length === 0) {
      return NextResponse.json({ error: '请提供 digests 数组' }, { status: 400 });
    }

    const config = getWechatConfig();
    let accessToken = '';

    if (!USE_CLOUD_CALL) {
      accessToken = await getAccessToken(config.appId, config.appSecret);
    }

    const results = [];

    for (const digest of digests) {
      if (!digest.digest || !digest.article_count) continue;

      const country = countryList.find(c => c.code === digest.country_code);
      if (!country) continue;

      const htmlContent = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px;">
          <h1 style="color: #0F1B2D; border-bottom: 2px solid #C8A45C; padding-bottom: 10px;">
            ${country.flag} ${digest.country_name} - 每日投资资讯
          </h1>
          <p style="color: #666; font-size: 14px;">${date || new Date().toLocaleDateString('zh-CN')}</p>
          <div style="margin-top: 20px; line-height: 1.8;">
            ${digest.digest.split('\n').map((line: string) => `<p>${line}</p>`).join('')}
          </div>
          <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; color: #999; font-size: 12px;">
            <p>中亚投资资讯 | Central Asia Investment Daily</p>
            <p>数据来源：各国主流媒体 | 由 AI 自动翻译整理</p>
          </div>
        </div>
      `;

      let mediaId: string;

      if (USE_CLOUD_CALL) {
        const thumbResult = await cloudCallApi('/media/uploadimg', { url: 'https://lf-coze-web-cdn.coze.cn/obj/eden-cn/lm-lgvj/ljhwZthlaukjlkulzlp/coze-coding/icon/coze-coding.gif' });
        if (thumbResult.errcode) throw new Error(`上传缩略图失败：${thumbResult.errmsg}`);

        const draftResult = await cloudCallApi('/draft/add', {
          articles: [{
            title: `${country.flag} ${digest.country_name} - ${date || '今日'} 投资资讯`,
            author: '中亚投资资讯',
            content: htmlContent,
            digest: digest.digest.substring(0, 120),
            thumb_media_id: thumbResult.url,
            need_open_comment: 0,
            only_fans_can_comment: 0,
          }],
        });

        if (draftResult.errcode) throw new Error(`创建草稿失败：${draftResult.errmsg}`);
        mediaId = draftResult.media_id;
      } else {
        const thumbUrl = await uploadThumb(accessToken);
        mediaId = await addDraft(accessToken, [{
          title: `${country.flag} ${digest.country_name} - ${date || '今日'} 投资资讯`,
          author: '中亚投资资讯',
          content: htmlContent,
          digest: digest.digest.substring(0, 120),
          thumbMediaId: thumbUrl,
          needOpenComment: 0,
          onlyFansCanComment: 0,
        }]);
      }

      results.push({
        country_code: digest.country_code,
        country_name: digest.country_name,
        media_id: mediaId,
        article_count: digest.article_count,
      });
    }

    return NextResponse.json({
      success: true,
      message: `成功创建 ${results.length} 个草稿`,
      drafts: results,
    });
  } catch (error) {
    console.error('微信推送失败:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : '推送失败',
    }, { status: 500 });
  }
}
