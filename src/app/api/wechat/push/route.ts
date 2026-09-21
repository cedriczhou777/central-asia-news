import { NextRequest, NextResponse } from 'next/server';
import { countryList } from '@/lib/data/countries';
import { getArticlesByDateRange } from '@/lib/db-articles';
import { beijingDate, extractFirstImage, isChineseText } from '@/lib/utils';
import { dedupeStories } from '@/lib/same-event';
import {
  EXCLUDED_CATEGORIES,
  isCountryRelevant,
  hasMissingSource,
  sanitizeArticleContent,
} from '@/lib/article-format';
import { generateWechatHtml } from '@/lib/wechat-template';
import { FALLBACK_THUMB_JPEG_BASE64 } from '@/lib/wechat-thumb-fallback';

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
  'central asia', 'kazakhstan', 'uzbekistan', 'kyrgyzstan', 'azerbaijan', 'tajikistan',
  'south caucasus', 'caspian',
  'silk road', 'belt and road', ' BRI',
];

// `cleanSummary` / `normalizeImages` / `generateWechatHtml` 已挪到
// `@/lib/wechat-template`（2026-09-21）：排版模板改得最频繁，独立成文件后
// 没有 Next 依赖，可以用 tsc 单独编译、拿真实文章渲染出 HTML 直接看，不用起服务。

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

// `isCountryRelevant` 已挪到 `@/lib/article-format`（2026-09-21）。
// 旧实现在这里只列了 5 个目标国，导致「蒙古国…」「格鲁吉亚…」「也门胡塞…」
// 这类明确讲别国的新闻全部走到「均未提及具体国家 → 放行」的兜底而混进推送。
// 现在那份名单覆盖主要国家和城市，并且**本国城市名也进了名单**
// （否则 `中国投资者在卡拉卡尔帕克斯坦发现4吨黄金` 这种本国地方新闻会被误杀）。
//
// 提醒：别在 `generateWechatHtml` 里用 `referrerpolicy` 之外的属性做判断 ——
// 正文图片的规范化统一在 `normalizeImages` 里做，只有一处。

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

// ----- 图片上传到微信素材库 -----
//
// 背景（2026-09-18 那次「早上没推送」的根因）：
// 公众号 draft/add 的 thumb_media_id 必须指向微信素材库里的图，所以推送前要先
// material/add_material?type=image 传一张图换 media_id。旧实现直接把外链图的字节
// 透传给微信，于是踩了三个坑：
//   1) 微信只认 jpeg/png/gif/bmp，拒收 webp，报 "unsupported file type hint"。
//      中亚媒体站（如 newtimes.kz）大量用 webp 出图 → 直接失败。
//   2) 失败后的「兜底」重取的还是同一张失败的图，必然再失败一次。
//   3) 兜底失败会 throw，把整轮推送打成 500，连一篇草稿都建不出来。
// 现在：真实格式按魔数嗅探 → 微信不收的用 sharp 转 JPEG → 仍有问题就退到内置品牌图；
// 全程不抛异常。封面拿不到只是「草稿没图」，不该让整轮推送失败。

// 微信永久素材接口接受的图片格式
const WECHAT_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/bmp', 'image/gif']);

interface ImagePayload {
  buf: ArrayBuffer;
  mime: string;
  ext: string;
}

interface MaterialResult {
  mediaId: string;
  url: string;
}

// 按魔数嗅探真实图片格式。
// 不能信响应头的 content-type：源站经常标错（把 webp 标成 image/jpeg），
// 而微信是按真实字节校验的，信了响应头就会在微信侧炸掉。
function sniffImage(input: ArrayBuffer): { mime: string; ext: string } | null {
  const b = new Uint8Array(input);
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { mime: 'image/gif', ext: 'gif' };
  if (b[0] === 0x42 && b[1] === 0x4d) return { mime: 'image/bmp', ext: 'bmp' };
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

// 把 Buffer 切出独立的 ArrayBuffer（Buffer 是共享池的视图，不能直接拿 .buffer）
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

// 整理成「微信能收」的格式：本来就是 jpeg/png/gif/bmp 就原样返回，
// 其它（webp/avif/heif/认不出来的）用 sharp 转 JPEG。
//
// ⚠️ sharp 必须留在 package.json 的 dependencies 里 —— 别当成「next 自带的」删掉。
// 它原本只是 next 的 optionalDependency，而 pnpm 对传递依赖只做「私有提升」
// （提升到 node_modules/.pnpm/node_modules），**根 node_modules 里没有它**。
// 这种状态下 `await import('sharp')` 会让 next build 的类型检查直接报
// TS2307: Cannot find module 'sharp'，把整个构建打挂 ——
// 2026-09-18 线上连续 5 个提交没上去就是这个原因。
// 本地能过是因为本机 node_modules 被 npm 拍平过，把差异掩盖了。
// 声明成直接依赖后，pnpm 才会像 rss-parser 那样在根 node_modules 建软链。
// 运行时仍保留 try/catch 兜底：真取不到就退回内置品牌图，绝不打断推送。
async function toWechatReadyImage(raw: ArrayBuffer): Promise<ImagePayload | null> {
  const sniffed = sniffImage(raw);
  if (sniffed && WECHAT_IMAGE_MIMES.has(sniffed.mime)) {
    return { buf: raw, mime: sniffed.mime, ext: sniffed.ext };
  }

  const from = sniffed?.mime || '未知格式';
  try {
    const { default: sharp } = await import('sharp');
    const jpeg = await sharp(Buffer.from(raw))
      // webp 常带透明通道，JPEG 不支持，先压一层白底
      .flatten({ background: '#FFFFFF' })
      .jpeg({ quality: 88 })
      .toBuffer();
    console.log(`图片格式 ${from} 已转为 JPEG（${raw.byteLength} → ${jpeg.byteLength} 字节）`);
    return { buf: toArrayBuffer(jpeg), mime: 'image/jpeg', ext: 'jpg' };
  } catch (err) {
    console.log(`图片格式 ${from} 转 JPEG 失败，放弃这张图：`, err);
    return null;
  }
}

// 上传一张图到微信永久素材库。失败返回空结果（不抛）。
async function uploadMaterial(img: ImagePayload): Promise<MaterialResult> {
  try {
    const formData = new FormData();
    // 文件名后缀和 Content-Type 都按嗅探出的真实格式给：微信两边都校验
    formData.append(
      'media',
      new Blob([img.buf], { type: img.mime }),
      `img_${Date.now()}.${img.ext}`
    );
    const res = await fetch(`${WECHAT_API_BASE}/material/add_material?type=image`, {
      method: 'POST',
      body: formData,
    });
    const data = await res.json() as {
      media_id?: string;
      url?: string;
      errcode?: number;
      errmsg?: string;
    };
    if (data.errcode) {
      console.log(`上传图片到微信失败：${data.errcode} ${data.errmsg}`);
      return { mediaId: '', url: '' };
    }
    return { mediaId: data.media_id || '', url: data.url || '' };
  } catch (err) {
    console.log('上传图片到微信异常:', err);
    return { mediaId: '', url: '' };
  }
}

// 下载外链图 → 转码 → 上传。正文插图取 url，草稿封面取 mediaId。
async function uploadRemoteImage(imageUrl: string): Promise<MaterialResult> {
  try {
    const res = await fetch(imageUrl, imageFetchInit());
    if (!res.ok) {
      console.log(`下载图片失败 ${imageUrl}: HTTP ${res.status}`);
      return { mediaId: '', url: '' };
    }
    const ready = await toWechatReadyImage(await res.arrayBuffer());
    if (!ready) return { mediaId: '', url: '' };
    return await uploadMaterial(ready);
  } catch (err) {
    console.log(`下载/上传图片异常 ${imageUrl}:`, err);
    return { mediaId: '', url: '' };
  }
}

// 内置品牌图（不依赖网络和 sharp，必定可上传）
function fallbackThumbPayload(): ImagePayload {
  return {
    buf: toArrayBuffer(Buffer.from(FALLBACK_THUMB_JPEG_BASE64, 'base64')),
    mime: 'image/jpeg',
    ext: 'jpg',
  };
}

// 上传草稿封面，返回 thumb_media_id。
// 顺序：文章封面（外链）→ 内置品牌图。全程不抛异常。
async function uploadThumb(imageUrl?: string): Promise<string> {
  if (imageUrl) {
    const fromArticle = await uploadRemoteImage(imageUrl);
    if (fromArticle.mediaId) return fromArticle.mediaId;
    console.log(`文章封面不可用，退回内置品牌图：${imageUrl}`);
  }

  const fallback = await uploadMaterial(fallbackThumbPayload());
  if (!fallback.mediaId) {
    console.log(
      '内置品牌图也上传失败 —— 检查微信云调用的接口白名单是否包含 /cgi-bin/material/add_material'
    );
  }
  return fallback.mediaId;
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

// 时段标记：由调度器传入，只用来区分同一天的早报/晚报。
//
// 'manual' 专给「人工补跑」用（对应文档里的
//   POST /api/wechat/push {"hours": 24, "period": "manual"}）。
// 补跑必须带这个标记，否则标题退回「X - 日期 投资资讯」这种不带时段的形式，
// 和当天任何一次人工补跑都完全同名 —— 草稿箱里就会出现两份标题一模一样的草稿，
// 正是 2026-09-19 用户投诉过的那个观感。
// 不带 period（历史写法）仍返回空串，保持向后兼容。
function periodSuffix(period: unknown): string {
  if (period === 'morning') return '早报';
  if (period === 'evening') return '晚报';
  if (period === 'manual') return '补报';
  return '';
}

// 投资者优先级：数字越大越靠前。
// 用户（2026-09-19）明确要求：与投资者最相关的（经济形势、行业动态、外汇储备、
// 国家政策、政治变动）放最前面。
//
// 表里**刻意没有 culture / sports** —— 那两类现在在入库后就被
// `EXCLUDED_CATEGORIES` 整类剔除（用户 2026-09-21：「演艺娱乐，体育类新闻全部取消」），
// 根本走不到这里的排序。留着它们只会让人误以为还有「文体类排最后」这回事。
const CATEGORY_PRIORITY: Record<string, number> = {
  economy: 100, policy: 95, oil_gas: 90, renewable_energy: 90, energy: 88,
  minerals: 88, politics: 85, transport: 80, infrastructure: 80, manufacturing: 78,
  chemicals: 75, housing: 70, law: 65, security: 60, livelihood: 55,
  healthcare: 50, society: 40,
};

// `normalizeImages` / `generateWechatHtml` / `cleanSummary` 见 `@/lib/wechat-template`。

interface PushFailure {
  country_code: string;
  country_name: string;
  error: string;
}

interface PushDraft {
  country_code: string;
  country_name: string;
  media_id: string;
  article_count: number;
}

// 一轮推送的结果。除 success/message 外，字段与原同步响应的结构保持一致，
// 老调用方改成读 lastRun.summary 时不用改字段名。
interface PushSummary {
  hours: number;
  period: string | null;
  today: string;
  drafts: PushDraft[];
  failures: PushFailure[];
}

interface PushRunState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  summary: PushSummary | null;
  error: string | null;
}

// 上一轮推送的状态，放模块作用域（Next 的服务端路由与自定义服务器同进程，
// 所以 POST 和 GET 拿到的是同一份状态）。
//
// 为什么推送也必须改成「立即返回、后台跑完」（2026-09-18 实测）：
// 推送是重活 —— 要把每篇正文里的外链图片逐张下载、按魔数嗅探格式、必要时用 sharp 转码，
// 再上传进微信素材库，5 个国家加起来远超网关的上限。手动 curl 公网域名会直接拿到
// HTTP 504 Gateway Time-out（65 秒，nginx 切掉连接；此时请求在服务端很可能仍在继续，
// 但调用方完全看不到结果，也就无法判断到底推成功没有）。
// 改成异步后 POST 立刻返回 200，真正的结果用 GET 查 lastRun。
// 顺带解决第二个问题：推送失败以前只写进容器日志（要进控制台才看得到）。
//
// 注意：应用内调度器走的是 http://localhost:PORT（见 lib/runtime.ts 的
// resolveSelfBaseUrl），不经过网关，所以**定时推送本来就不受这个 65 秒限制**。
// 本次改动主要惠及「人工补跑」和外部可观测性。
let pushRunState: PushRunState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  summary: null,
  error: null,
};

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const hours = typeof body.hours === 'number' ? body.hours : 24;
  const period = body.period;

  // 同一时间只允许跑一轮：并发推送会对同一批文章重复建草稿，
  // 草稿箱里就会出现成对的同名草稿（正是「一天两次窗口重叠」那类问题的观感）。
  if (pushRunState.running) {
    return NextResponse.json({
      success: true,
      message: '上一轮推送仍在进行，本次跳过（不重复触发）',
      running: true,
      startedAt: pushRunState.startedAt,
    });
  }

  const startedAt = new Date().toISOString();
  pushRunState = {
    running: true,
    startedAt,
    finishedAt: null,
    durationMs: null,
    summary: null,
    error: null,
  };

  // 立即返回，后台异步处理
  processPush(hours, period)
    .then((summary) => {
      pushRunState = {
        running: false,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(startedAt).getTime(),
        summary,
        error: null,
      };
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('后台微信公众号推送失败:', err);
      pushRunState = {
        running: false,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(startedAt).getTime(),
        summary: null,
        error: message,
      };
    });

  return NextResponse.json({
    success: true,
    message: '微信公众号推送任务已启动，后台处理中（用 GET 查 lastRun 看结果）',
    hours,
    period: typeof period === 'string' ? period : null,
    startedAt,
  });
}

export async function GET() {
  return NextResponse.json({
    message: '微信公众号推送接口',
    usage: 'POST /api/wechat/push with optional { hours: 24, period: "morning" | "evening" | "manual" }',
    // 上一轮推送的状态。调度器靠 running / finishedAt 判断「推完了没」；
    // 人工排查时 summary.drafts 是成功建的草稿，summary.failures 是哪些国家失败、为什么。
    lastRun: pushRunState,
  }, {
    // 必须禁掉缓存：调度器轮询这个接口等状态变化，被缓存住就会一直看到旧状态，
    // 表现为「干等到超时」。
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}

async function processPush(hours: number, period: unknown): Promise<PushSummary> {
  try {
    const suffix = periodSuffix(period);
    const today = beijingDate();
    const maxPerCountry = 30;

    // 计算时间范围（过去 N 小时）
    const now = new Date();
    const startDate = new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
    const endDate = now.toISOString();

    console.log(
      `微信公众号推送：${today}${suffix ? ' ' + suffix : ''}，汇总 ${startDate} 至 ${endDate}（过去 ${hours} 小时），每国精选（上限 ${maxPerCountry} 篇）`
    );

    const results: PushDraft[] = [];
    // 失败的国家单独记账，最后一起返回 —— 排查「今天怎么没推」时能一眼看出卡在哪一国
    const failures: PushFailure[] = [];

    // 按国别分组推送
    for (const country of countryList) {
      // 获取该国家过去 N 小时的文章。
      // 单国读取失败（DB 抖动）不该拖垮整轮：跳过这一国，其余国家照常出草稿。
      let articles: Awaited<ReturnType<typeof getArticlesByDateRange>>;
      try {
        articles = await getArticlesByDateRange(startDate, endDate, country.code);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${country.name}] 读取新闻失败，跳过该国：`, err);
        failures.push({ country_code: country.code, country_name: country.name, error: `读取新闻失败：${msg}` });
        continue;
      }
      
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

      // 按投资相关性评分排序，今日精选（上限 maxPerCountry 篇）
      const scoredArticles = chineseArticles.map(a => ({
        ...a,
        relevanceScore: scoreInvestmentRelevance(a.title, a.summary),
      }));

      // 排序 = 分类优先级 + 关键词评分。
      // 2026-09-19 起分类由 LLM 判定（不再是清一色的 economy），优先级才有意义：
      // 经济/政策/能源/矿产/政治在前，文体在后；同类内按评分排。
      scoredArticles.sort((a, b) => {
        const pa = CATEGORY_PRIORITY[a.category] ?? 30;
        const pb = CATEGORY_PRIORITY[b.category] ?? 30;
        if (pa !== pb) return pb - pa;
        return b.relevanceScore - a.relevanceScore;
      });

      // 选稿分两步：**先按内容无关性筛掉，再做「同一件事」去重，最后截取上限**。
      //
      // 旧版是一趟循环边筛边去重（只跟「已选中的」比），有两个毛病：
      //   1. 顺序敏感 —— 谁排在前面谁被保留，而排序键里含分类优先级，
      //      于是「哪一条被留下」取决于分类而不是内容质量；
      //   2. 判组看不到全量候选 —— 模型/判据一次只能看到前面已选的那几条，
      //      同一件事的第二条刚好排在后面时更容易漏。
      // 拆成两步后，去重看的是「本国全部合格候选」，截取上限放在最后。
      const eligible = scoredArticles.filter((article) => {
        // 演艺娱乐 / 体育整类剔除。
        // 用户 2026-09-19 的要求是「少一些」（当时每国限量 3 篇），
        // 2026-09-21 改成「全部取消」—— 是**全删**。原来那套 `MAX_SOFT_ARTICLES`
        // 计数逻辑已随之删掉，别再按「限量」去理解这段。
        if (EXCLUDED_CATEGORIES.has(article.category)) {
          console.log(`跳过文体类新闻（${article.category}）：${article.title}`);
          return false;
        }
        // 源正文缺失的空壳文（「原文正文缺失，数据无法提取」）—— 通篇没有信息，
        // 清洗救不回来，只能在这里丢。判据只看标题（详见 article-format.ts）。
        if (hasMissingSource(article.title)) {
          console.log(`跳过源正文缺失的新闻：${article.title}`);
          return false;
        }
        // 国家相关性
        if (!isCountryRelevant(article.title, article.summary, country.code)) {
          console.log(`跳过与${country.name}无关的新闻：${article.title}`);
          return false;
        }
        return true;
      });

      // 「同一件事」去重：链接 / 原文指纹（确定性）+ 模型判组（每国 1 次调用）。
      // 判据与入库端**完全同源**（同一个 `dedupeStories`），不另起一套。
      const { kept: dedupedArticles, drops: eventDrops, llm: llmJudge } =
        await dedupeStories(eligible);
      for (const d of eventDrops) {
        console.log(`[${country.code}][${d.reason}] 跳过重复：${d.dropped.title} ← 保留：${d.kept.title}`);
      }
      if (llmJudge.error) {
        console.warn(`[${country.name}] 「同一件事」模型判组未生效，本轮只做了链接/原文去重：${llmJudge.error}`);
      }

      // 今日精选：取完去重后的前 N 篇（宽松上限，只防文章过长，不写死篇数）
      const selectedArticles = dedupedArticles.slice(0, maxPerCountry);

      console.log(
        `为${country.name}精选${selectedArticles.length}篇投资相关新闻` +
          `（合格候选 ${eligible.length} 篇，去重剔除 ${eventDrops.length} 篇）`,
      );

      // 一国新闻被全部过滤掉（典型情况：该国当天只有「讲别国」的新闻，
      // 被上面的 isCountryRelevant 判为无关）→ 这一国本轮没有可推送内容。
      // 必须在下面取 selectedArticles[0] 之前拦掉：旧代码直接写
      // `selectedArticles[0].cover_image`，数组为空时抛
      // TypeError: Cannot read properties of undefined → 整轮请求 500。
      if (selectedArticles.length === 0) {
        console.log(`${country.name}无相关新闻，跳过本轮推送`);
        continue;
      }

      // 关键：把每篇文章正文里的外链图片上传到微信素材库，换成微信 CDN 地址
      // （否则微信保存草稿时抓不到外链图，正文图片会全部消失）
      const wechatArticles = [];
      for (const a of selectedArticles) {
        // 先清洗再上传图片：清洗会删掉模型自己编的图（占位图 / example.com / picsum 之类），
        // 放在上传之前能省掉一批注定失败的网络请求，也避免把破图放进草稿。
        const imgRegex = /<img[^>]*?\ssrc=["']([^"']+)["'][^>]*>/gi;
        let content = sanitizeArticleContent(a.content);
        const urls = [...content.matchAll(imgRegex)].map(m => m[1]);
        if (urls.length > 0) {
          // 每个 URL 并行上传，替换成微信 CDN url
          const replacements = await Promise.all(
            urls.map(async (u) => {
              const uploaded = await uploadRemoteImage(u);
              // 正文插图优先用微信 CDN url，退回 media_id，都拿不到就保留原图
              return { from: u, to: uploaded.url || uploaded.mediaId || u };
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
          // 封面优先取已替换成微信 CDN 的正文首图，保证微信可访问。
          // 兜底也从**清洗后**的正文里取 —— 用原始 a.content 会取到刚被删掉的编造图。
          cover_image: content.match(/<img[^>]*?\ssrc=["']([^"']+)["']/i)?.[1] || extractFirstImage(content) || undefined,
        });
      }

      // 生成微信公众号排版 HTML
      const htmlContent = generateWechatHtml(
        country.name,
        country.flag,
        suffix ? `${today} · ${suffix}` : today,
        wechatArticles
      );

      // 上传缩略图（优先用第一篇文章已上传微信的封面图，再从原图取）
      // 上面已保证 selectedArticles 非空；这里统一用可选链，避免将来改动再踩空数组。
      const thumbUrl =
        wechatArticles[0]?.cover_image ||
        selectedArticles[0]?.cover_image ||
        // 同样从清洗后的正文取，避免把模型编造的图片地址当成草稿封面去下载
        extractFirstImage(sanitizeArticleContent(selectedArticles[0]?.content || '')) ||
        undefined;
      const thumbMediaId = await uploadThumb(thumbUrl);

      // 创建草稿（每个国家一个草稿，标题不含 emoji/特殊字符）
      // 标题带「早报 / 晚报」：同一天两次推送的草稿标题必须不同，
      // 否则草稿箱里会出现两份一模一样的标题，分不清哪份是哪份。
      // 关键：建草稿失败只跳过这一国。旧实现在这里 throw，首个国家一失败就把
      // 整轮打成 500，后面四个国家一篇草稿都建不出来（2026-09-18 早报的实际情况）。
      let mediaId: string;
      try {
        mediaId = await addDraft([{
          title: `${country.name} - ${today}${suffix ? ' ' + suffix : ''} 投资资讯`,
          author: '中亚投资资讯',
          content: htmlContent,
          // 摘要不带篇数统计（2026-09-19 用户要求：标题/摘要里不要出现"30条"这类数字）
          digest: `${country.name}${suffix || '今日'}投资资讯精选`,
          thumbMediaId: thumbMediaId,
          needOpenComment: 0,
          onlyFansCanComment: 0,
        }]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${country.name}] 创建草稿失败，跳过该国：`, err);
        failures.push({ country_code: country.code, country_name: country.name, error: msg });
        continue;
      }

      results.push({
        country_code: country.code,
        country_name: country.name,
        media_id: mediaId,
        article_count: selectedArticles.length,
      });
    }

    return {
      hours,
      period: typeof period === 'string' ? period : null,
      today,
      drafts: results,
      failures,
    };
  } catch (error) {
    console.error('微信推送失败（本轮整体失败）:', error);
    // 抛给后台任务的 .catch，记进 pushRunState.error —— 调用方一个 GET 就能看到原因
    throw error;
  }
}
