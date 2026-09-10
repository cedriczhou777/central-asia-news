import { NextRequest, NextResponse } from 'next/server';
import { countryList } from '@/lib/data/countries';
import { getArticlesByDateRange } from '@/lib/db-articles';
import { extractFirstImage, isChineseText } from '@/lib/utils';

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

// 清理正文末尾的省略号：以省略号/多个省略符收尾时替换为句号，确保以完整语句收尾
function cleanSummary(text: string): string {
  let t = (text || '').trim();
  // 剥离末尾的省略号（全角/半角），若其后无其它文字则补一个句号
  if (/(?:…|\.\.\.|\.\.)+[\s，,、；;：:]?$/.test(t)) {
    t = t.replace(/(?:…|\.\.\.|\.\.)+[\s，,、；;：:]*$/g, '。');
  }
  // 去除结尾的多余标点，保留句号/感叹号/问号收尾
  t = t.replace(/([，,、；;：:（\s])+$/g, '');
  return t.trim();
}

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

// 提取主题关键词（用于去重）
function extractTopicKeywords(title: string, summary: string): string {
  const text = `${title} ${summary}`;
  
  // 提取人名（常见人名模式）
  const personPatterns = [
    /[\u4e00-\u9fa5]{2,4}(?:·[\u4e00-\u9fa5]{2,4}){1,3}/g, // 中文人名（如：米尔济约耶夫）
    /[A-Z][a-z]+ [A-Z][a-z]+/g, // 英文名（如：Shavkat Mirziyoyev）
  ];
  
  // 提取地名/机构名
  const locationPatterns = [
    /[\u4e00-\u9fa5]{2,6}(?:斯坦|尼亚|利亚|克|国)/g, // 国家名
    /[A-Z][a-z]+(?:stan|nia|lia|land)/gi, // 英文国家名
  ];
  
  const keywords: string[] = [];
  
  for (const pattern of personPatterns) {
    const matches = text.match(pattern);
    if (matches) keywords.push(...matches.slice(0, 3));
  }
  
  for (const pattern of locationPatterns) {
    const matches = text.match(pattern);
    if (matches) keywords.push(...matches.slice(0, 3));
  }
  
  // 如果没有提取到关键词，使用标题前 20 个字符
  if (keywords.length === 0) {
    return title.substring(0, 20);
  }
  
  return keywords.slice(0, 3).join(',');
}

// 检查新闻是否与目标国家相关
function isCountryRelevant(title: string, summary: string, countryCode: string): boolean {
  const text = `${title} ${summary}`.toLowerCase();
  
  // 国家相关关键词
  const countryKeywords: Record<string, string[]> = {
    kz: ['kazakhstan', 'kazakh', '哈萨克斯坦', '哈萨克', 'astana', '阿斯塔纳', 'almaty', '阿拉木图'],
    uz: ['uzbekistan', 'uzbek', '乌兹别克斯坦', '乌兹别克', 'tashkent', '塔什干', 'samarkand', '撒马尔罕'],
    kg: ['kyrgyzstan', 'kyrgyz', '吉尔吉斯斯坦', '吉尔吉斯', 'bishkek', '比什凯克'],
    tm: ['turkmenistan', 'turkmen', '土库曼斯坦', '土库曼', 'ashgabat', '阿什哈巴德'],
    tj: ['tajikistan', 'tajik', '塔吉克斯坦', '塔吉克', 'dushanbe', '杜尚别'],
  };
  
  const keywords = countryKeywords[countryCode] || [];
  return keywords.some(kw => text.includes(kw.toLowerCase()));
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

// 下载外链图片的请求头：加浏览器 UA + 无 referrer，规避目标站防盗链/默认 UA 拦截
function imageFetchInit(): RequestInit {
  return {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: '',
      'Accept': 'image/*,*/*;q=0.8',
    },
    redirect: 'follow',
  };
}

// 将外链图片上传到微信素材库，返回微信可访问的 URL（解决防盗链导致草稿无图的问题）
async function uploadImageToWechat(imageUrl: string): Promise<string> {
  try {
    const res = await fetch(imageUrl, imageFetchInit());
    if (!res.ok) {
      console.log(`下载图片失败 ${imageUrl}: HTTP ${res.status}`);
      return '';
    }
    const buf = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') || 'image/jpeg';

    // 上传到微信永久图片素材
    const url = `${WECHAT_API_BASE}/material/add_material?type=image`;
    const formData = new FormData();
    formData.append(
      'media',
      new Blob([buf], { type: contentType }),
      `img_${Date.now()}.jpg`
    );

    const uploadRes = await fetch(url, { method: 'POST', body: formData });
    const data = await uploadRes.json() as {
      url?: string;
      media_id?: string;
      errcode?: number;
      errmsg?: string;
    };

    if (data.errcode) {
      console.log(`上传图片到微信失败 ${imageUrl}: ${data.errmsg}`);
      return '';
    }
    // add_material 上传图片返回的 url 是微信 CDN 地址，可直接用于正文
    return data.url || data.media_id || '';
  } catch (err) {
    console.log(`上传图片到微信异常 ${imageUrl}:`, err);
    return '';
  }
}

async function uploadThumb(imageUrl?: string): Promise<string> {
  // 使用文章封面图或默认缩略图
  const defaultThumbUrl = imageUrl || 'https://lf-coze-web-cdn.coze.cn/obj/eden-cn/lm-lgvj/ljhwZthlaukjlkulzlp/coze-coding/icon/coze-coding.gif';

  // 封面必须是微信素材库里的图片（add_material 上传后返回 media_id）。
  // 直接下载图片字节并上传为永久素材，返回 media_id。
  try {
    const imageRes = await fetch(defaultThumbUrl, imageFetchInit());
    if (!imageRes.ok) throw new Error(`下载封面失败 HTTP ${imageRes.status}`);
    const imageBuffer = await imageRes.arrayBuffer();
    const contentType = imageRes.headers.get('content-type') || 'image/jpeg';
    const url = `${WECHAT_API_BASE}/material/add_material?type=image`;
    const formData = new FormData();
    formData.append('media', new Blob([imageBuffer], { type: contentType }), `thumb_${Date.now()}.jpg`);
    const res = await fetch(url, { method: 'POST', body: formData });
    const data = await res.json() as { media_id?: string; errcode?: number; errmsg?: string };
    if (data.errcode) {
      throw new Error(`上传封面失败：${data.errmsg}`);
    }
    return data.media_id || '';
  } catch (err) {
    console.log('上传封面缩略图失败，使用默认图:', err);
  }

  // 兜底：默认图
  const imageRes = await fetch(defaultThumbUrl);
  const imageBuffer = await imageRes.arrayBuffer();
  const url = `${WECHAT_API_BASE}/material/add_material?type=image`;
  const formData = new FormData();
  formData.append('media', new Blob([imageBuffer], { type: 'image/jpeg' }), 'thumb.jpg');
  const res = await fetch(url, { method: 'POST', body: formData });
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
    const imgSrc = article.cover_image
      ? article.cover_image
      : (article.content.match(/<img[^>]*?\ssrc=["']([^"']+)["']/i)?.[1]) || '';

    // 正文里的 `<img>` 标签直接保留（promise 过程中已替换为微信 CDN 图），仅去掉 referrerpolicy
    const contentHtml = article.content
      .replace(/referrerpolicy="[^"]*"/gi, '')
      .replace(/\[IMAGE:([^\]]+)\]/g, `<div style="margin: 15px 0;"><img src="$1" style="width: 100%; border-radius: 8px;" /></div>`);
    // 去掉正文末尾的省略号，确保以完整语句收尾
    const bodyHtml = cleanSummary(contentHtml);

    // 若正文 content 已经自带 `<img>` 首图，就不再重复输出独立封面，避免同一张图出现两次
    const bodyHasImg = /<img[^>]*\ssrc=/i.test(contentHtml);
    const coverBlock = (!bodyHasImg && imgSrc)
      ? `<div style="margin: 15px 0;"><img src="${imgSrc}" style="width: 100%; border-radius: 8px;" referrerpolicy="no-referrer" /></div>`
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
        
        ${coverBlock}

        <div style="font-size: 15px; color: #333; line-height: 1.8;">
          ${bodyHtml}
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
        <div>数据来源：各国主流媒体</div>
      </div>
    </div>
  `;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { hours = 24, minPerCountry = 15 } = body;

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

      // 过滤未翻译为中文的原文：只推送中文内容，英文/俄文原文直接跳过
      const chineseArticles = articles.filter(
        a => isChineseText(a.title) && isChineseText(a.content)
      );
      if (chineseArticles.length < articles.length) {
        console.log(`[${country.name}] 过滤掉 ${articles.length - chineseArticles.length} 篇非中文文章，保留 ${chineseArticles.length} 篇`);
      }

      // 按投资相关性评分排序，精选前 minPerCountry 篇
      // 确保不重复：按标题关键词去重，避免相同主题的新闻
      const scoredArticles = chineseArticles.map(a => ({
        ...a,
        relevanceScore: scoreInvestmentRelevance(a.title, a.summary),
      }));
      
      scoredArticles.sort((a, b) => b.relevanceScore - a.relevanceScore);
      
      // 去重：确保每篇新闻讲不同的事情
      // 使用更智能的去重：提取人名、地名、事件关键词
      const selectedArticles: typeof scoredArticles = [];
      const usedTopics = new Set<string>();
      
      for (const article of scoredArticles) {
        // 每国精选 15 篇：不足量时不轻易打断，尽量凑满
        if (selectedArticles.length >= 15) break;
        if (selectedArticles.length >= 15 && article.relevanceScore < 5) break;
        
        // 检查是否与目标国家相关
        if (!isCountryRelevant(article.title, article.summary, country.code)) {
          console.log(`跳过与${country.name}无关的新闻：${article.title}`);
          continue;
        }
        
        // 提取主题关键词（人名、地名、事件）
        const topicKey = extractTopicKeywords(article.title, article.summary);
        
        // 如果这个主题已经出现过，跳过
        if (usedTopics.has(topicKey)) {
          console.log(`跳过重复主题：${article.title}（主题：${topicKey}）`);
          continue;
        }
        
        usedTopics.add(topicKey);
        selectedArticles.push(article);
      }
      
      // 如果去重后不足 minPerCountry 篇，用剩余文章补充（但仍然要检查国家相关性）
      if (selectedArticles.length < minPerCountry) {
        for (const article of scoredArticles) {
          if (selectedArticles.length >= minPerCountry) break;
          if (!selectedArticles.find(a => a.id === article.id)) {
            // 补充的新闻也要检查国家相关性
            if (isCountryRelevant(article.title, article.summary, country.code)) {
              selectedArticles.push(article);
            }
          }
        }
      }

      console.log(`为${country.name}精选${selectedArticles.length}篇投资相关新闻`);

      // 关键：把每篇文章正文里的外链图片上传到微信素材库，换成微信 CDN 地址
      // （否则微信保存草稿时抓不到外链图，正文图片会全部消失）
      const wechatArticles = [];
      for (const a of selectedArticles) {
        const imgRegex = /<img[^>]*?\ssrc=["']([^"']+)["'][^>]*>/gi;
        let content = a.content;
        const urls = [...content.matchAll(imgRegex)].map(m => m[1]);
        if (urls.length > 0) {
          // 每个 URL 并行上传，替换成微信 CDN url
          const replacements = await Promise.all(
            urls.map(async (u) => {
              const wxUrl = await uploadImageToWechat(u);
              return { from: u, to: wxUrl || u };
            })
          );
          for (const r of replacements) {
            content = content.split(r.from).join(r.to);
          }
        }
        wechatArticles.push({
          title: a.title,
          summary: a.summary,
          content,
          category: a.category,
          source_name: a.source_name,
          // 封面优先取已替换成微信 CDN 的正文首图，保证微信可访问
          cover_image: content.match(/<img[^>]*?\ssrc=["']([^"']+)["']/i)?.[1] || extractFirstImage(a.content) || undefined,
        });
      }

      // 生成微信公众号排版 HTML
      const htmlContent = generateWechatHtml(
        country.name,
        country.flag,
        new Date().toISOString().split('T')[0],
        wechatArticles
      );

      // 上传缩略图（优先用第一篇文章已上传微信的封面图，再从原图取）
      const thumbUrl =
        wechatArticles[0]?.cover_image ||
        selectedArticles[0].cover_image ||
        extractFirstImage(selectedArticles[0].content) ||
        undefined;
      const thumbMediaId = await uploadThumb(thumbUrl);

      // 创建草稿（每个国家一个草稿，标题不含 emoji/特殊字符）
      const dateStr = new Date().toISOString().split('T')[0];
      const mediaId = await addDraft([{
        title: `${country.name} - ${dateStr} 投资资讯`,
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
