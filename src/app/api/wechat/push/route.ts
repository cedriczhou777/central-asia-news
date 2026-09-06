import { NextRequest, NextResponse } from 'next/server';
import { countryList } from '@/lib/data/countries';
import { getArticlesByDateRange } from '@/lib/db-articles';

// 使用微信云托管开放接口服务（免 IP 白名单、免 access_token）
const WECHAT_API_BASE = 'http://api.weixin.qq.com/cgi-bin';

// 投资相关关键词（用于精选评分）
const INVESTMENT_KEYWORDS = [
  'invest', 'investment', 'investor', 'foreign investment', 'direct investment',
  'oil', 'gas', 'energy', 'petroleum', 'fuel', 'pipeline', 'renewable', 'power', 'electricity',
  'chemical', 'petrochemical', 'fertilizer', 'plastic', 'polymer',
  'mining', 'mineral', 'copper', 'gold', 'uranium', 'ore', 'metal', 'resource', 'lithium',
  'infrastructure', 'railway', 'road', 'bridge', 'construction', 'transport', 'logistics', 'highway',
  'real estate', 'property', 'housing', 'building', 'development',
  'manufacturing', 'factory', 'industrial', 'production', 'textile', 'automotive',
  'policy', 'reform', 'regulation', 'law', 'legislation', 'decree', 'strategy',
  'tax', 'legal', 'compliance', 'company law', 'commercial', 'corporate',
  'economy', 'gdp', 'trade', 'export', 'import', 'business', 'finance', 'bank',
  'president', 'parliament', 'government', 'minister', 'diplomat', 'bilateral', 'agreement',
  'central asia', 'kazakhstan', 'uzbekistan', 'kyrgyzstan', 'turkmenistan', 'tajikistan',
  'silk road', 'belt and road', ' BRI',
];

// 对新闻进行投资相关性评分
function scoreInvestmentRelevance(title: string, summary: string): number {
  const text = `${title} ${summary}`.toLowerCase();
  let score = 0;
  for (const kw of INVESTMENT_KEYWORDS) {
    if (text.includes(kw)) {
      score += kw.length; // 长关键词权重更高
    }
  }
  return score;
}

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

async function uploadThumb(imageUrl?: string): Promise<string> {
  // 使用默认缩略图或指定图片
  const defaultThumbUrl = imageUrl || 'https://lf-coze-web-cdn.coze.cn/obj/eden-cn/lm-lgvj/ljhwZthlaukjlkulzlp/coze-coding/icon/coze-coding.gif';

  // 先下载图片
  const imageRes = await fetch(defaultThumbUrl);
  const imageBuffer = await imageRes.arrayBuffer();

  // 上传到微信永久素材（开放接口服务免 access_token）
  const url = `${WECHAT_API_BASE}/material/add_material?type=image`;
  
  // 使用 FormData 上传
  const formData = new FormData();
  formData.append('media', new Blob([imageBuffer], { type: 'image/jpeg' }), 'thumb.jpg');

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

// 生成微信公众号排版 HTML
function generateWechatHtml(
  countryName: string,
  countryFlag: string,
  date: string,
  articles: Array<{
    title: string;
    summary: string;
    content: string;
    category: string;
    source_name: string;
    cover_image?: string;
  }>
): string {
  const categoryLabels: Record<string, string> = {
    politics: '政治',
    economy: '经济',
    policy: '政策',
    business_law: '工商法律',
    energy: '能源',
    chemicals: '化工',
    minerals: '矿产',
    infrastructure: '基建',
    real_estate: '房地产',
    manufacturing: '制造业',
  };

  const articlesHtml = articles.map((article, index) => {
    const categoryLabel = categoryLabels[article.category] || article.category;
    const coverImageHtml = article.cover_image 
      ? `<div style="margin: 15px 0;"><img src="${article.cover_image}" style="width: 100%; border-radius: 8px;" /></div>`
      : '';
    
    return `
      <div style="margin-bottom: 40px; padding-bottom: 30px; border-bottom: 1px solid #E8E8E8;">
        <div style="display: flex; align-items: center; margin-bottom: 15px;">
          <div style="background: #C8A45C; color: white; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; margin-right: 12px;">${index + 1}</div>
          <div style="flex: 1;">
            <div style="font-size: 12px; color: #C8A45C; margin-bottom: 4px;">${categoryLabel}</div>
            <h3 style="font-size: 18px; color: #0F1B2D; margin: 0; line-height: 1.4;">${article.title}</h3>
          </div>
        </div>
        
        <div style="font-size: 14px; color: #666; line-height: 1.8; margin-bottom: 10px;">
          <strong>摘要：</strong>${article.summary}
        </div>
        
        ${coverImageHtml}
        
        <div style="font-size: 15px; color: #333; line-height: 1.8;">
          ${article.content.replace(/\[IMAGE:([^\]]+)\]/g, '<div style="margin: 15px 0;"><img src="$1" style="width: 100%; border-radius: 8px;" /></div>')}
        </div>
        
        <div style="margin-top: 15px; padding-top: 10px; border-top: 1px dashed #E8E8E8; font-size: 12px; color: #999;">
          来源：${article.source_name}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; padding: 20px; background: #F8F6F1;">
      <!-- 头部 -->
      <div style="text-align: center; padding: 30px 20px; background: linear-gradient(135deg, #0F1B2D 0%, #1a2d4a 100%); border-radius: 12px; margin-bottom: 30px;">
        <div style="font-size: 48px; margin-bottom: 10px;">${countryFlag}</div>
        <h1 style="color: #C8A45C; font-size: 28px; margin: 0 0 10px 0; font-weight: bold;">${countryName}</h1>
        <h2 style="color: white; font-size: 20px; margin: 0 0 15px 0; font-weight: normal;">每日投资资讯</h2>
        <div style="color: rgba(255,255,255,0.7); font-size: 14px;">${date}</div>
      </div>
      
      <!-- 新闻列表 -->
      <div style="background: white; border-radius: 12px; padding: 25px; box-shadow: 0 2px 12px rgba(0,0,0,0.08);">
        ${articlesHtml}
      </div>
      
      <!-- 底部 -->
      <div style="text-align: center; margin-top: 30px; padding: 20px; color: #999; font-size: 12px;">
        <div style="margin-bottom: 8px;">中亚投资资讯 | Central Asia Investment Daily</div>
        <div>数据来源：各国主流媒体 | 由 AI 自动翻译整理</div>
      </div>
    </div>
  `;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { hours = 24, minPerCountry = 5 } = body;

    // 计算时间范围（过去 N 小时）
    const now = new Date();
    const startDate = new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
    const endDate = now.toISOString();

    console.log(`微信公众号推送：汇总过去${hours}小时新闻，每个国家精选${minPerCountry}篇`);

    const results = [];

    // 按国别分组推送
    for (const country of countryList) {
      // 获取该国家过去 N 小时的文章
      const articles = await getArticlesByDateRange(startDate, endDate, country.code);
      
      if (articles.length === 0) {
        console.log(`${country.name}过去${hours}小时无文章，跳过`);
        continue;
      }

      console.log(`${country.name}过去${hours}小时共${articles.length}篇文章`);

      // 按投资相关性评分排序，精选前 minPerCountry 篇
      const scoredArticles = articles.map(a => ({
        ...a,
        relevanceScore: scoreInvestmentRelevance(a.title, a.summary),
      }));
      
      scoredArticles.sort((a, b) => b.relevanceScore - a.relevanceScore);
      const selectedArticles = scoredArticles.slice(0, minPerCountry);

      console.log(`为${country.name}精选${selectedArticles.length}篇投资相关新闻`);

      // 生成微信公众号排版 HTML
      const htmlContent = generateWechatHtml(
        country.name,
        country.flag,
        new Date().toISOString().split('T')[0],
        selectedArticles.map(a => ({
          title: a.title,
          summary: a.summary,
          content: a.content,
          category: a.category,
          source_name: a.source_name,
          cover_image: a.cover_image || undefined,
        }))
      );

      // 上传缩略图（使用第一篇文章的封面图或默认图）
      const thumbUrl = selectedArticles[0].cover_image || undefined;
      const thumbMediaId = await uploadThumb(thumbUrl);

      // 创建草稿（每个国家一个草稿）
      const mediaId = await addDraft([{
        title: `${country.flag} ${country.name} - ${new Date().toISOString().split('T')[0]} 投资资讯`,
        author: '中亚投资资讯',
        content: htmlContent,
        digest: `${country.name}今日精选${selectedArticles.length}条投资资讯`,
        thumbMediaId: thumbMediaId,
        needOpenComment: 0,
        onlyFansCanComment: 0,
      }]);

      results.push({
        country_code: country.code,
        country_name: country.name,
        media_id: mediaId,
        article_count: selectedArticles.length,
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
