import { NextRequest, NextResponse } from 'next/server';
import { countryList } from '@/lib/data/countries';

// 使用微信云托管开放接口服务（免 IP 白名单、免 access_token）
const WECHAT_API_BASE = 'http://api.weixin.qq.com/cgi-bin';



// 开放接口服务：免 access_token，直接调用
async function callWechatApi(apiPath: string, data: any): Promise<any> {
  const url = `${WECHAT_API_BASE}${apiPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

async function uploadThumb(): Promise<string> {
  // 使用默认缩略图 URL
  const defaultThumbUrl = 'https://lf-coze-web-cdn.coze.cn/obj/eden-cn/lm-lgvj/ljhwZthlaukjlkulzlp/coze-coding/icon/coze-coding.gif';

  // 先下载图片
  const imageRes = await fetch(defaultThumbUrl);
  const imageBuffer = await imageRes.arrayBuffer();

  // 上传到微信永久素材（开放接口服务免 access_token）
  const url = `${WECHAT_API_BASE}/material/add_material?type=image`;
  
  // 使用 FormData 上传
  const formData = new FormData();
  formData.append('media', new Blob([imageBuffer], { type: 'image/gif' }), 'thumb.gif');

  const res = await fetch(url, {
    method: 'POST',
    body: formData,
  });
  const data = await res.json() as { media_id?: string; errcode?: number; errmsg?: string };
  
  console.log('上传缩略图返回:', JSON.stringify(data));
  
  if (data.errcode) {
    throw new Error(`上传缩略图失败：${data.errmsg}`);
  }
  return data.media_id || '';
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

async function addDraft(articles: DraftArticle[]): Promise<string> {
  const url = `${WECHAT_API_BASE}/draft/add`;
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

      // 使用开放接口服务（免 access_token）
      const thumbUrl = await uploadThumb();
      const mediaId = await addDraft([{
        title: `${country.flag} ${digest.country_name} - ${date || '今日'} 投资资讯`,
        author: '中亚投资资讯',
        content: htmlContent,
        digest: digest.digest.substring(0, 120),
        thumbMediaId: thumbUrl,
        needOpenComment: 0,
        onlyFansCanComment: 0,
      }]);

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
