import { NextRequest, NextResponse } from 'next/server';
import { countryList } from '@/lib/data/countries';
import { getArticlesByDateRange } from '@/lib/db-articles';
import { beijingDate, extractFirstImage, latinCyrillicTokens, stripCyrillicParentheticals } from '@/lib/utils';
import { PUBLISH_SCHEDULES, scheduledWindow, scheduleHoursCrossCheck } from '@/lib/publish-schedule';
import { dedupeStories, isLlmJudgeEnabled, PAIR_CANDIDATE_MIN_SIM } from '@/lib/same-event';
import { investmentRelevanceOf, compareByInvestmentRelevance } from '@/lib/investment-score';
import {
  pushExclusionReason,
  isPushableText,
  sanitizeArticleContent,
} from '@/lib/article-format';
import { generateWechatHtml } from '@/lib/wechat-template';
import { FALLBACK_THUMB_JPEG_BASE64 } from '@/lib/wechat-thumb-fallback';
import {
  crossCountryOverlaps,
  isEditorReviewEnabled,
  reviewDraft,
  planCoverBorrows,
  EDITOR_PROMPT_VERSION,
  MAX_DROPS,
  MAX_FIXES,
  type ReviewAudit,
  type ReviewItem,
} from '@/lib/editor-review';

// 使用微信云托管开放接口服务（免 IP 白名单、免 access_token）
const WECHAT_API_BASE = 'http://api.weixin.qq.com/cgi-bin';

// 投资相关性评分（含中英文关键词、标题加权、分档权重）统一在
// `@/lib/investment-score`。**不要再在本文件里重建关键词表** ——
// 这里原先那张纯英文表在中文文本上永不命中，是 2026-09-21 那次
// 「排序里看不出投资相关性」的直接原因。
//
// `cleanSummary` / `normalizeImages` / `generateWechatHtml` 已挪到
// `@/lib/wechat-template`（2026-09-21）：排版模板改得最频繁，独立成文件后
// 没有 Next 依赖，可以用 tsc 单独编译、拿真实文章渲染出 HTML 直接看，不用起服务。

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

// 分类优先级（`CATEGORY_PRIORITY`）与排序规则（`compareByInvestmentRelevance`）
// 都在 `@/lib/investment-score`。挪过去的原因见那边的注释：
// 排序规则必须能被回归脚本断言，不能只存在于路由文件里。
//
// 这里保留一条**历史依据**（原注释，别丢）：
// 用户 2026-09-19 明确要求「与投资者最相关的（经济形势、行业动态、外汇储备、
// 国家政策、政治变动）放最前面」—— 当时是用**分类优先级**近似表达的；
// 2026-09-21 又提出「与投资越相关的新闻越放在靠前」，
// 于是把它细化到**文章级**（`investmentRelevanceOf`），分类降为第二键。
// 两次要求方向一致，后者是前者的细化，不是替换。

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

/**
 * 「这一国本轮没出草稿」及其原因。
 *
 * ## 为什么要新加这一段
 *
 * 2026-09-27 早报：`drafts` 只有 kg，`failures` 是**空的**，
 * 而 kz/uz/az/tj 四国窗口内各有 29/25/33/3 篇、本该各自出草稿。
 * 用户看到的现象是「今天早上好像只有吉尔吉斯的新闻推送了」，
 * 而**从接口上完全读不出为什么** —— 因为「跳过」是静默的：
 *
 *   - `articles.length === 0`         → `continue`（只写容器日志）
 *   - 全部被 `pushExclusionReason` 挡掉 → `continue`（逐条日志，但响应里没有）
 *   - 去重后一条不剩                   → `continue`
 *
 * `failures` 只记「读取失败」和「建草稿失败」——这两类是**异常**；
 * 而上面三类是**正常的跳过**，于是「五国只推一国」这种最需要解释的情况
 * 反而什么字段都不留。本结构就是补这个洞：把漏斗的中间计数直接写进响应。
 *
 * 判据本身仍然是 `pushExclusionReason` 那四条，这里只做**计数**，不改变任何取舍。
 */
interface PushSkip {
  country_code: string;
  country_name: string;
  reason: 'no_articles' | 'all_excluded' | 'all_deduped';
  /** 漏斗各段计数，回答「到底卡在哪一段」 */
  detail: {
    /** 窗口内读到几篇（`reason: 'no_articles'` 时这里就是 0） */
    inWindow: number;
    /** `isPushableText` 挡掉几篇（未翻译 / 翻译退化） */
    untranslated: number;
    /** 其余三条判据各挡掉几篇，键是 `PushExclusion` 的值 */
    excludedByReason: Record<string, number>;
    /** 过完四条判据还剩几篇 */
    eligible: number;
    /** 确定性去重 + 模型判组一共剔除几篇 */
    dedupDrops: number;
  };
}

// 一轮推送的结果。除 success/message 外，字段与原同步响应的结构保持一致，
// 老调用方改成读 lastRun.summary 时不用改字段名。
/**
 * 一条「被判为同一件事」而被合并掉的稿子。
 *
 * 为什么要报出来：L2（模型判组）默认状态在 2026-09-28 从「关」翻成「开」，
 * 翻的理由与护栏见 `same-event.ts` 的 `DedupOptions.useLlm`。
 * **误合并是静默丢信息**，所以每一次合并都必须能在接口上看见 ——
 * 「哪条稿子因为被判成重复而没出现在草稿里」以前只能进容器翻日志。
 */
interface PushMerge {
  country_code: string;
  /** `same_url` / `same_original` / `same_text` / `same_title` = 确定性；`llm_same_event` = 模型判的 */
  reason: string;
  kept: string;
  dropped: string;
}

/**
 * L2（模型判组）本轮的实际执行情况。
 *
 * **必须报出来**：L2 失败时 `drops` 里只剩确定性去重的结果，看起来和「本来就没重复」一模一样。
 * `ran=false`（没跑，例如候选不足 2 条）与 `ok=false`（跑了但没答成）要能区分 ——
 * 否则「今天怎么这么多重复」会又一次变成只能靠猜的问题。
 */
interface PushJudge {
  ran: boolean;
  ok: boolean;
  error?: string;
  /** 模型被问了几对 */
  candidateCount?: number;
  /** 模型答了「是同一件事」的对数 */
  mergedPairs?: number;
}

/**
 * 一国草稿的**总审结果**（2026-09-29 新增，见 `lib/editor-review.ts`）。
 *
 * 为什么要报出来：总审是全链路里**唯一能改写文字、也是唯一能删稿的模型环节**，
 * 而它的输出全部落在成品里、不看这里就完全不可见。
 * 「今天这条标题怎么和库里不一样」的答案只可能在这里。
 *
 * ⚠️ `rejections` 尤其要看：它记的是**模型提了但被护栏拒掉的处置**。
 * 非空不代表出错（护栏正常工作），但**突然变多**通常意味着模型开始跑偏
 * （例如 order 不再是完整排列、before 对不上原文）—— 那是该调提示词的信号。
 */
interface PushReview extends ReviewAudit {
  country_code: string;
  country_name: string;
  /** 审前 / 审后篇数 */
  before: number;
  after: number;
  /** 被总审合并或删掉的稿件（与 `merges` 分开放：那是判组删的，这是总审删的） */
  drops: Array<{ title: string; kind: string; reason: string }>;
  /** 被总审改过文字的字段 */
  fixes: Array<{ field: string; before: string; after: string; why: string }>;
  /**
   * 总审指出「值得读者点开看、但一张图都没有」的标题。
   *
   * ⚠️ **这是给人工看的提示，不是「已经补好图了」的凭证**（2026-09-29 复核）。
   * 原注释写的是「阶段 ③ 会优先给它找图」，那是**没实现**的。
   * 补充图的唯一机制是 `planCoverBorrows`（借图），而它**只能**在
   * 「同一件事的重复稿被删掉了、且那份有图」时生效 —— 线上实测只覆盖约 20% 的缺图稿件。
   * ⇒ 判断「这几条补到图了没有」要看 `imagesBorrowed`，**不要**看这个字段。
   */
  needsImage: string[];
  /**
   * 本轮**借到封面**的稿件（2026-09-29 新增，见 `planCoverBorrows`）。
   *
   * 只记「哪条借到了、从哪条借的、相似度多少」。借图**不写入数据库**，
   * 只改本轮要发出去的那份 `content`（在开头插一张 `<img>`），所以这里是唯一的留痕。
   */
  imagesBorrowed: Array<{ title: string; fromTitle: string; sim: number }>;
  /** 总评（模型给的，20 字内） */
  verdict: string;
}

/**
 * 阶段 ① 的产出：一国「已选题、待总审、待发布」的稿件。
 *
 * ⚠️ 这个结构存在的理由值得写下来：它把「选题」和「建草稿」**在时间上分开**，
 * 于是总审才有东西可审（建草稿是不可逆的 —— 草稿箱里一旦有了，改就得重建）。
 */
interface PreparedCountry {
  country: (typeof countryList)[number];
  articles: Awaited<ReturnType<typeof getArticlesByDateRange>>;
}

/**
 * 把一条库里的稿件转成总审能看的形态。
 *
 * `contentPeek` 只取正文**开头 200 字**（去掉 HTML 标签）：总审要判的五件事里，
 * 重复看标题+摘要就够，逻辑与数字错误在开头就暴露（线上那两条 `500 座教学楼`、
 * `下调1.5倍` 都是标题级）。全文会把这层调用放大十倍，而收益要到正文中后段才出现。
 * ⚠️ 代价是**正文中后段的错误抓不到** —— 已知缺口，别当成没 bug。
 * ⚠️ 第五件事（内部一致性）受同一个缺口影响最大：**摘要之间互相矛盾看得见，
 * 正文深处的矛盾看不见**。所以它是「最保守」的那一件事，判据写得比前几件严得多。
 */
function toReviewItem(a: {
  title?: string | null;
  summary?: string | null;
  content?: string | null;
  category?: string | null;
  source_name?: string | null;
  cover_image?: string | null;
  relevanceScore?: number;
  published_at?: unknown;
}): ReviewItem {
  const content = sanitizeArticleContent(a.content || '');
  return {
    title: a.title || '',
    summary: a.summary || '',
    category: a.category || '',
    source: a.source_name || '',
    time: a.published_at ? String(a.published_at).slice(0, 16) : '',
    hasImage: Boolean(a.cover_image) || /<img/i.test(content),
    relevance: typeof a.relevanceScore === 'number' ? a.relevanceScore : 0,
    contentPeek: content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
  };
}

interface PushSummary {
  hours: number;
  period: string | null;
  today: string;
  /**
   * 本次实际使用的回看窗口。
   *
   * **必须报出来**：窗口是「漏稿」与「重复推送」的唯一来源，而它的两种算法
   * （定时时段按时刻表固定 / 人工补跑按 hours 浮动）在响应里本来完全看不出区别 ——
   * 于是「这次到底覆盖了哪一段」只能靠读日志猜。2026-09-24 早晚报各空跑一轮，
   * 事后判读时最缺的就是这一行。
   */
  window?: {
    start: string;
    end: string;
    /** `schedule` = 按时刻表固定（定时时段）；`hours` = 执行时刻 − hours（人工补跑） */
    source: 'schedule' | 'hours';
    hours: number;
  };
  drafts: PushDraft[];
  failures: PushFailure[];
  /**
   * 本轮**被跳过**的国家及原因。与 `failures` 的区别：
   * `failures` 是出了异常（读库失败 / 建草稿失败），这里是**正常跳过**。
   *
   * 排查「今天怎么只推了某国」时先看这一段 —— 它直接给出漏斗各段的计数，
   * 不用进容器翻日志、也不用猜。为空数组表示窗口内有文章的每个国家都出了草稿。
   */
  skipped: PushSkip[];
  /**
   * 本轮被判为「同一件事」而合并掉的篇目（每国一组）。
   *
   * 这是**唯一能审计「模型判组有没有乱合并」的出口** —— 合并掉的稿子不会出现在
   * `drafts` 里，也不会出现在 `skipped` 里（那一国照样出草稿）。
   * 空数组 = 本轮没有任何重复。
   */
  merges: PushMerge[];
  /** 各国 L2 的执行情况，用来区分「没有重复」和「判组没跑成」 */
  judge: Array<PushJudge & { country_code: string }>;
  /**
   * 各国草稿的**总审**结果（2026-09-29 新增）。
   *
   * 与 `merges` / `judge` 的分工：那两项是**判组（L2）**干的（只判「是不是同一件事」），
   * 这里是**终审编辑**干的（合并 + 改文字 + 重排序 + 指出缺图）。
   * 两者都删稿，但删的依据不同、留痕也必须分开 —— 混在一个数组里就分不清
   * 「这条是被判组当重复删的」还是「被总审编辑删的」。
   */
  review: PushReview[];
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
    /**
     * 已注册的早晚报时刻表（来自 `lib/publish-schedule.ts`）。
     *
     * 为什么要把一个「配置值」报出来：改时间这件事**在响应里原本完全看不见** ——
     * 部署之后想确认「新时刻真的注册上了」，过去只能等第二天那一轮跑起来、
     * 再去控制台翻启动日志（`已注册公众号推送任务：0 7 * * * ...`），
     * 而启动日志外面拿不到。现在 `cron: "0 7 * * *"` 直接出现在响应里，
     * **一条 curl 同时证明两件事：新版本接管了流量、且时刻表就是改后的值**。
     * 这比 build ID 强 —— build ID 只能说明「有部署发生」，说不清是哪个提交。
     *
     * ⚠️ 注意它反映的是**代码里的时刻表**，不是「容器里 node-cron 真的注册成功」。
     * 注册失败会在启动日志里报错（`cron.schedule` 遇到非法表达式会抛），
     * 所以两者不一致时去翻启动日志。
     */
    schedules: PUBLISH_SCHEDULES,
    /**
     * 时刻表的 `hours` 声明值与**从 cron 推导出的窗口长度**是否一致。
     *
     * 为什么要报：2026-09-24 起定时时段不再用 `hours` 算窗口（改由 {@link scheduledWindow}
     * 从钟点推导，见缺陷 19），`hours` 因此退化为一个**交叉校验值**。
     * 但它还在 `scheduler.ts` 的日志和本响应里露脸，一旦两者不一致，
     * 「响应里写着 12h、实际窗口是别的」就会重新变成需要靠读代码才能发现的差异。
     * 任何一项 `ok: false` 都说明有人只改了 cron 或只改了 hours。
     */
    scheduleHoursCrossCheck: scheduleHoursCrossCheck(),
    /**
     * 版本指纹 —— **把「行为开关本身」报出来**（2026-09-29 新增）。
     *
     * ## 为什么需要它
     *
     * 「推了代码但线上没变化」的一整套排查（`DEPLOY_WECHAT_CLOUD.md`）
     * 在过去只能靠**字段存在性**推断：`summary` 里有没有 `merges` / `judge`。
     * 那个办法只在「这次改动恰好加了字段」时成立，改个常量就没得看了 ——
     * 2026-09-29 为此绕了一大圈（先怀疑召回、再怀疑代码、最后才发现是部署没上线）。
     *
     * ## 为什么这几个值**不会腐烂**
     *
     * 它们都**从代码里现算**，不是手写的版本号：
     * 谁把默认值 / 提示词版本 / 护栏上限改掉，这里的值**自动跟着变**，
     * 不需要记得同步任何东西。这正是手写 `BUILD_ID` 做不到的
     * （手写的东西迟早会和代码分叉，然后反过来误导排查）。
     *
     * 用法：`curl -s "$URL/api/wechat/push" | grep -A5 codeVersion`
     * —— 一条 curl 同时回答了「新版本接管了吗」和「接管的是哪一版」。
     * ⚠️ 它**不覆盖**没被这几个开关覆盖的改动；判断「是不是最新」仍应结合
     * `lastRun` 的进程年龄（重启即清零）一起看。
     */
    codeVersion: {
      /** L2 模型判组的默认值（2026-09-28 `fe0f84a` 起为 true；显式 off/0/false 才关） */
      dedupeLlmDefault: isLlmJudgeEnabled(),
      /** 整体总审（推送阶段 ②）的默认值（2026-09-29 `312644b` 起为 true） */
      editorReviewDefault: isEditorReviewEnabled(),
      /** 终审提示词版本 —— 改 `EDITOR_PROMPT` 时必须一起改它 */
      editorPromptVersion: EDITOR_PROMPT_VERSION,
      /** 终审护栏上限（调参后可以从这里确认线上拿到的是新值） */
      editorGuards: { maxDrops: MAX_DROPS, maxFixes: MAX_FIXES },
      /**
       * 「借图」（`planCoverBorrows`）的配对下限 —— 从常量现算，所以它**存在**本身就说明
       * 这一版代码带上了借图。2026-09-29 新增。
       * ⚠️ 它没有独立开关：借图跑在总审内部，所以 `EDITOR_REVIEW=off` 会一并关掉。
       */
      coverBorrowMinSim: PAIR_CANDIDATE_MIN_SIM,
      /**
       * 「拉丁+西里尔同词」硬闸（2026-09-29）的**活体探针** —— 不是手写的 `true`。
       *
       * 它**当场跑一次判据**，入参 `Aйдос` 是线上真实命中词（id=6787 标题）。
       * 所以 `1` 同时说明两件事：这一版带上了这个闸、**且它真的还能命中**。
       *
       * 为什么不写 `cyrillicGate: true`：上面那段注释已经讲过「手写的东西迟早会和
       * 代码分叉，然后反过来误导排查」。一个手写的 `true` 在闸被删掉之后依然是
       * `true` —— 那正是 2026-09-29 上午绕远路的原因（「没上线」和「上线了但没效果」
       * 分不开）。跑一次真判据则不可能撒谎：判据被删会编译不过，被判据改坏值会变。
       */
      cyrillicLatinGateProbe: latinCyrillicTokens('Aйдос').length,
      /**
       * 「删冗余西里尔括注」确定性后处理（2026-09-29）的**活体探针** —— 同款理由。
       *
       * 返回的是**清理后的字符串**而不是布尔：`'吉尔吉斯斯坦国家税务局'`。
       * 用字符串是因为它能一眼看出「删的是哪一种括注、留下了什么」——
       * 一个 `true` 只能说明「函数存在」，说明不了「它删对了」。
       * 入参是线上真实命中（id=6658 正文）。
       */
      cyrillicNoteStripProbe: stripCyrillicParentheticals('吉尔吉斯斯坦国家税务局（ГНС）'),
    },
    // 上一轮推送的状态。调度器靠 running / finishedAt 判断「推完了没」；
    // 人工排查时 summary.drafts 是成功建的草稿、summary.failures 是哪些国家失败、
    // **summary.skipped 是哪些国家被正常跳过及卡在哪一段**。
    //
    // ⚠️ 只看 `failures` 会得到错误结论：它只记异常（读库失败 / 建草稿失败），
    // 「窗口内没文章」「全部被判据挡掉」「去重后一条不剩」三类**正常跳过**
    // 在 2026-09-27 之前一个字都不写，于是「五国只推了一国」在响应里表现为成功。
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
    // 每国每份报告的篇数上限。
    //
    // 2026-09-22 由 30 收到 15：现在是**早晚报两段**（各 12h，见 `scheduler.ts`），
    // 每份报告每国 15 篇已经足够，30 篇只会把相关性靠后的稿子也塞进来、拉低整份报告的质量。
    // 这是个**上限**不是配额 —— 候选不足 15 篇时按实际可用量推，不硬凑
    // （硬凑就得放宽判据，而本项目历史上「判据过严/过松」都出过事）。
    //
    // ⚠️ 收这个数字会**改变「每国不足 15 篇」这个症状的出现面**：
    // 以前要 30 篇才触发，现在 15 篇就可能不够。候选不足时先用
    // `GET /api/fetch-news` 的 `funnelByCountry` 看漏斗里掉在哪一段，
    // 不要去动 `pushExclusionReason` 或 `maxPerCountry`。
    const maxPerCountry = 15;

    // 计算时间范围
    //
    // 定时时段（早报 / 晚报）用**固定钟点窗口**：起点/终点由 `publish-schedule.ts`
    // 的时刻表推导（早报 `[昨日19:00, 今日07:00]`、晚报 `[今日07:00, 今日19:00]`），
    // **与执行时刻无关**。原因见 `scheduledWindow` 的注释 —— 起点锚在执行时刻的话，
    // 推送一迟到窗口就整体后移：既漏掉一段，又与上一轮重叠（2026-09-24 早晚报各栽一次）。
    //
    // 非定时（`manual` / 没传 period）仍按「执行时刻 − hours」——人工补跑就是
    // 要「从现在往回数 N 小时」，那是它本来的语义，不能套固定钟点。
    const now = new Date();
    const scheduled = scheduledWindow(period);
    const startDate = scheduled
      ? scheduled.start.toISOString()
      : new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
    const endDate = scheduled ? scheduled.end.toISOString() : now.toISOString();
    /** 这次窗口是「按时刻表固定」还是「按 hours 浮动」—— 响应里要报，否则无法核实 */
    const windowSource: 'schedule' | 'hours' = scheduled ? 'schedule' : 'hours';
    const windowHours =
      scheduled ? scheduled.hours : Math.round((now.getTime() - new Date(startDate).getTime()) / 3_600_000);

    console.log(
      `微信公众号推送：${today}${suffix ? ' ' + suffix : ''}，汇总 ${startDate} 至 ${endDate}` +
        `（${windowSource === 'schedule' ? `按时刻表固定窗口 ${windowHours}h` : `过去 ${hours} 小时`}），` +
        `每国精选（上限 ${maxPerCountry} 篇）`
    );

    const results: PushDraft[] = [];
    // 失败的国家单独记账，最后一起返回 —— 排查「今天怎么没推」时能一眼看出卡在哪一国
    const failures: PushFailure[] = [];
    // 正常被跳过的国家（不是异常）。见 `PushSkip` 的注释：2026-09-27 那次
    // 「五国只推一国、failures 却是空的」就是因为这里什么都不记。
    const skipped: PushSkip[] = [];
    // 判组合并的审计轨迹：谁被合进了谁（见 `PushMerge`）。L2 打开后这是唯一的可审计出口。
    const merges: PushMerge[] = [];
    const judgeRuns: Array<PushJudge & { country_code: string }> = [];
    const reviews: PushReview[] = [];
    /** 阶段 ① 的产出：已选题、待总审、待发布的稿件（见 `PreparedCountry`） */
    const prepared: PreparedCountry[] = [];

    // ============================================================
    // 这一轮推送分三个阶段，顺序即阶段名（2026-09-29 起）
    // ============================================================
    //
    // 旧版是**一趟循环**：逐国「选题 → 立刻上传图片 → 立刻建草稿」。
    // 用户 2026-09-29 要求「5 个国家的草稿准备好之后，交由 AI 再统一审稿」——
    // 那在旧结构里**做不到**，不只是麻烦：第 3 国开始选稿时，第 1 国的草稿
    // 已经进了草稿箱，改也改不回来（建草稿不可逆，改就得重建，而重建会
    // 在草稿箱里留下两份，正是本项目反复踩过的观感问题）。
    //
    //   ① 逐国选题 —— 只读库：筛判据、判组去重、截取上限。失败/跳过照旧记账
    //   ② 整体总审 —— 5 国放在一起审（`lib/editor-review.ts`）：合并、改文字、重排序
    //   ③ 逐国发布 —— 上传外链图 → 排版 → 建草稿
    //
    // 顺带买到一件事：③ 之前整轮崩掉，草稿箱里**一条都不会留下半个**。
    //
    // 阶段 ①
    // 按国别分组选题
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
        skipped.push({
          country_code: country.code,
          country_name: country.name,
          reason: 'no_articles',
          detail: { inWindow: 0, untranslated: 0, excludedByReason: {}, eligible: 0, dedupDrops: 0 },
        });
        continue;
      }

      console.log(`${country.name}过去${hours}小时共${articles.length}篇文章`);

      // 过滤未翻译为中文的原文：只推送中文内容，英文/俄文原文直接跳过。
      //
      // 判据本体在 `@/lib/article-format` 的 `isPushableText` —— **不要在这里内联重写**。
      // 这个表达式曾经和 `pushExclusionReason` 分家，导致体检接口漏掉它、
      // 把永远进不了生产的非中文文章喂给模型（见 `pushExclusionReason` 的注释）。
      const chineseArticles = articles.filter(
        a => isPushableText(a.title, a.content)
      );
      if (chineseArticles.length < articles.length) {
        console.log(`[${country.name}] 过滤掉 ${articles.length - chineseArticles.length} 篇非中文文章，保留 ${chineseArticles.length} 篇`);
      }

      // 按投资相关性评分排序，今日精选（上限 maxPerCountry 篇）
      //
      // ⚠️ 这里的文本已经是**中文**（上游已翻译，且上面刚用 `isChineseText` 过滤过），
      // 所以必须用跨语言评分器（`@/lib/investment-score`）。
      // 2026-09-21 之前这里用的是一张**纯英文**关键词表，在中文标题上永不命中 ——
      // 实测线上 1000 篇里只有 2.8% 能得分，且命中的是拉丁字母残留，
      // 于是排序实际只剩「分类优先级」，用户要的「越与投资相关越靠前」根本没发生。
      const scoredArticles = chineseArticles.map(a => ({
        ...a,
        relevanceScore: investmentRelevanceOf(a.title, a.summary),
      }));

      // 排序 = **投资相关性为主** + 分类优先级为辅 + 时间兜底。
      //
      // 2026-09-21 用户要求「与投资越相关的新闻越放在靠前」，所以把两个键的
      // 主次**对调**了（原来是「分类优先级 → 相关性」）。
      // 规则本体在 `@/lib/investment-score` 的 `compareByInvestmentRelevance`，
      // 挪过去是为了让**排序规则本身**能被回归脚本断言，而不是只能在路由里读代码。
      scoredArticles.sort(compareByInvestmentRelevance);

      // 选稿分两步：**先按内容无关性筛掉，再做「同一件事」去重，最后截取上限**。
      //
      // 旧版是一趟循环边筛边去重（只跟「已选中的」比），有两个毛病：
      //   1. 顺序敏感 —— 谁排在前面谁被保留，而排序键里含分类优先级，
      //      于是「哪一条被留下」取决于分类而不是内容质量；
      //   2. 判组看不到全量候选 —— 模型/判据一次只能看到前面已选的那几条，
      //      同一件事的第二条刚好排在后面时更容易漏。
      // 拆成两步后，去重看的是「本国全部合格候选」，截取上限放在最后。
      // 逐条判据的剔除量在这里记账，最后进 `summary.skipped`（见 `PushSkip`）。
      const excludedByReason: Record<string, number> = {};
      const eligible = scoredArticles.filter((article) => {
        // 四条判据本体在 `@/lib/article-format` 的 `pushExclusionReason` ——
        // **不要在这里内联重写**。原因见那个函数的注释：诊断接口一度因为
        // 自己抄了一份（还抄漏了 `EXCLUDED_CATEGORIES`）而得出相反结论。
        const reason = pushExclusionReason(article, country.code);
        if (!reason) return true;
        // 逐条计数 + 逐条打日志：计数进 `summary.skipped`（接口可见），
        // 日志留单条明细（内容可见）。两者都要，缺一个就会回到「只能进容器翻日志」。
        excludedByReason[reason] = (excludedByReason[reason] || 0) + 1;
        if (reason === 'untranslated') {
          // 正常不该走到这里（上面 `isPushableText` 已经滤过一轮）。
          // 真出现说明两处判据又不一致了 —— 所以这条不是死代码，是哨兵。
          console.warn(`[${country.name}] 未翻译的文章漏到选稿阶段（判据可能已分叉）：${article.title}`);
        } else if (reason === 'category') {
          console.log(`跳过文体类新闻（${article.category}）：${article.title}`);
        } else if (reason === 'missing_source') {
          console.log(`跳过源正文缺失的新闻：${article.title}`);
        } else {
          console.log(`跳过与${country.name}无关的新闻：${article.title}`);
        }
        return false;
      });

      // 「同一件事」去重：链接 / 原文指纹（确定性）+ 模型判组（L2，每国 1 次调用）。
      // 判据与入库端**完全同源**（同一个 `dedupeStories`），不另起一套。
      const { kept: dedupedArticles, drops: eventDrops, llm: llmJudge } =
        await dedupeStories(eligible);
      for (const d of eventDrops) {
        console.log(`[${country.code}][${d.reason}] 跳过重复：${d.dropped.title} ← 保留：${d.kept.title}`);
        merges.push({
          country_code: country.code,
          reason: d.reason,
          kept: d.kept.title,
          dropped: d.dropped.title,
        });
      }
      judgeRuns.push({
        country_code: country.code,
        ran: llmJudge.ran,
        ok: llmJudge.ok,
        ...(llmJudge.error ? { error: llmJudge.error } : {}),
        ...(llmJudge.candidateCount !== undefined ? { candidateCount: llmJudge.candidateCount } : {}),
        ...(llmJudge.pairs ? { mergedPairs: llmJudge.pairs.length } : {}),
      });
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
        // 记进 `summary.skipped`：`eligible` 为 0 说明是四条判据吃掉了全部候选，
        // 否则说明是去重吃掉的。这一行就是「为什么这一国没有草稿」的答案。
        skipped.push({
          country_code: country.code,
          country_name: country.name,
          reason: eligible.length === 0 ? 'all_excluded' : 'all_deduped',
          detail: {
            inWindow: articles.length,
            untranslated: articles.length - chineseArticles.length,
            excludedByReason,
            eligible: eligible.length,
            dedupDrops: eventDrops.length,
          },
        });
        continue;
      }

      // 阶段 ① 到此结束：这一国的选题定了，**不碰微信**。
      // 交给阶段 ②（整体总审）之后，才在阶段 ③ 统一上传图片、排版、建草稿。
      // 存的是**副本**：阶段 ② 会用总审的结论原地改写它（重排 / 删 / 改文字），
      // 不能让它改到 `dedupedArticles`（那是判组的产物，审计时要对得上）。
      prepared.push({ country, articles: [...selectedArticles] });
    }

    // ============================================================
    // 阶段 ②：整体总审（5 国统一一道）—— 2026-09-29 新增
    // ============================================================
    //
    // 为什么是「统一一道」而不是逐国各审各的：跨国重复**只有看全局才看得见**，
    // 而排序也只有在同一把尺子下比过才谈得上「最重要」。所以这一阶段先把
    // 五国的选题摆在一起，再逐国调模型（每国一次调用，因为一次塞 75 篇会
    // 稀释注意力、而且一国的结论失败会连累其他国）。
    //
    // 判据、护栏、审计的结构都在 `lib/editor-review.ts`；这里只负责
    // 「组上下文 → 调用 → 应用 → 记账」四件事。
    //
    // ⚠️ **失败必须无损**：模型超时/返回不合法/解析失败 ⇒ 一条都不改（见 `reviewDraft`）。
    // 一段审稿没跑成，不该让五国少稿子 —— 那是「静默丢稿」，本项目最忌讳的形态。
    // `EDITOR_REVIEW=off` 是**不用发版的紧急刹车**（与 `SAME_EVENT_JUDGE` 同款）。
    if (prepared.length === 0) {
      console.log('本轮没有任何国家产出选题，跳过整体总审');
    } else if (!isEditorReviewEnabled()) {
      console.log('EDITOR_REVIEW=off：跳过整体总审（紧急刹车生效，本轮沿用旧行为）');
    } else {
      // 五国摆在一起才算「统一审稿」：既让每国知道自己和别人有没有撞题，
      // 又能在响应里给出跨国重复的观测（只报不改，理由见 `crossCountryOverlaps`）。
      const perCountryItems = prepared.map((p) => ({
        country: p.country.name,
        items: p.articles.map((a) => toReviewItem(a)),
      }));

      for (let i = 0; i < prepared.length; i++) {
        const pc = prepared[i];
        const others = perCountryItems.filter((_, j) => j !== i);
        // 跨国重复：**只作为知情上下文**喂给模型，并要求它不要据此删任何一条。
        // 同一件事出现在两个国家的日报里是**预期行为**（见 AGENTS.md 的判组一节），
        // 所以这里绝不能让模型替我们做「跨国去重」。
        const overlaps = crossCountryOverlaps(perCountryItems[i].items, others);

        let decision: Awaited<ReturnType<typeof reviewDraft>>['decision'] | null = null;
        let audit: ReviewAudit;
        try {
          const res = await reviewDraft({
            countryName: pc.country.name,
            items: perCountryItems[i].items,
            overlaps,
          });
          decision = res.decision;
          audit = res.audit;
        } catch (err) {
          // `reviewDraft` 自己已经兜了模型层异常，这里是**兜底中的兜底** ——
          // 总审出任何意外都不许影响发布（旧行为照跑）。
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[${pc.country.name}] 总审异常，本轮不改动该国任何内容：`, err);
          audit = {
            promptVersion: 'unknown',
            ran: false,
            ok: false,
            error: msg,
            itemCount: pc.articles.length,
            rejections: ['总审抛异常 ⇒ 一条都没改'],
          };
        }

        const before = pc.articles.length;
        const drops: PushReview['drops'] = [];
        const fixes: PushReview['fixes'] = [];
        const needsImageTitles: string[] = [];
        const borrows: PushReview['imagesBorrowed'] = [];

        if (decision) {
          // 文字修正：`index` 是**原索引**，而 `pc.articles` 里是同一批对象的引用，
          // 所以先改对象、再按顺序取，两件事互不干扰（顺序不影响引用）。
          for (const f of decision.fixes) {
            const target = pc.articles[f.index];
            if (!target) continue;
            if (f.field === 'title') target.title = f.after;
            else target.summary = f.after;
            fixes.push({ field: f.field, before: f.before, after: f.after, why: f.why });
            console.log(`[${pc.country.name}][总审改字] ${f.field}：「${f.before}」→「${f.after}」（${f.why}）`);
          }
          // 「借图」的捐赠者必须在这里抓 —— 下面重排/剔除之后，这些对象就不在数组里了。
          const donors: Array<{ title: string; imageUrl: string }> = [];
          for (const d of decision.drops) {
            const a = pc.articles[d.index];
            drops.push({
              title: a?.title || '',
              kind: d.kind,
              reason: d.reason,
            });
            // 只有**被判为重复**的稿子才配当捐赠者：总审明确说过它与某条是同一件事。
            // `not_news` / `unreliable` 的稿子跟谁都不同一件事，不能拿它的图。
            if (d.kind === 'duplicate' && a) {
              const url = extractFirstImage(a.content || '');
              if (url) donors.push({ title: a.title || '', imageUrl: url });
            }
            console.log(`[${pc.country.name}][总审合并][${d.kind}] 删除：${a?.title || ''}｜理由：${d.reason}`);
          }
          for (const ni of decision.needsImage) {
            const a = pc.articles[ni];
            if (a?.title) needsImageTitles.push(a.title);
          }
          pc.articles = decision.finalIndices.map((idx) => pc.articles[idx]).filter(Boolean);

          // 借图：把刚被删掉的重复稿的封面，挪给「本来一张图都没有」的幸存稿。
          // 判据、边界、以及**为什么不做跨国**都在 `planCoverBorrows` 的注释里（含线上实测数据）。
          if (donors.length > 0) {
            const plan = planCoverBorrows({
              // ⚠️ 必须用**重排之后**的数组：`targetIndex` 就是这个数组的下标。
              survivors: pc.articles.map((a) => ({
                title: a.title || '',
                hasImage: Boolean(a.cover_image) || /<img/i.test(a.content || ''),
              })),
              donors,
            });
            for (const b of plan) {
              const target = pc.articles[b.targetIndex];
              if (!target) continue;
              // 与 fetch-news 存封面**同一套办法**：`cover_image` 字段不入库（见 db-articles.ts），
              // 只能把图插进正文开头。这样阶段 ③ 的草稿封面与正文首图都会取到它。
              target.content = `<img src="${b.imageUrl}" referrerpolicy="no-referrer" />\n\n${target.content || ''}`;
              borrows.push({ title: target.title || '', fromTitle: b.fromTitle, sim: Number(b.sim.toFixed(3)) });
              console.log(
                `[${pc.country.name}][总审借图] 「${target.title}」借到封面 ← 被删掉的重复稿「${b.fromTitle}」（相似度 ${b.sim.toFixed(3)}）`,
              );
            }
          }
        }

        console.log(
          `[${pc.country.name}] 总审：${before} → ${pc.articles.length} 篇` +
            `（删 ${drops.length} / 改字 ${fixes.length} / 借图 ${borrows.length} / 重排 ${audit.orderAccepted ? '是' : '否'}）` +
            (audit.ok ? '' : `｜未生效：${audit.error || '未知原因'}`),
        );

        reviews.push({
          ...audit,
          country_code: pc.country.code,
          country_name: pc.country.name,
          before,
          after: pc.articles.length,
          drops,
          fixes,
          needsImage: needsImageTitles,
          imagesBorrowed: borrows,
          verdict: decision?.verdict ?? '',
        });
      }
    }

    // ============================================================
    // 阶段 ③：逐国发布（上传外链图 → 排版 → 建草稿）
    // ============================================================
    //
    // 这里用**总审之后**的 `prepared[i].articles`。建草稿是不可逆的，
    // 所以整段排版/上传都放在总审结论定下来之后 —— 顺序本身就是护栏。
    for (const { country, articles: selectedArticles } of prepared) {
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
      window: { start: startDate, end: endDate, source: windowSource, hours: windowHours },
      drafts: results,
      failures,
      skipped,
      merges,
      judge: judgeRuns,
      review: reviews,
    };
  } catch (error) {
    console.error('微信推送失败（本轮整体失败）:', error);
    // 抛给后台任务的 .catch，记进 pushRunState.error —— 调用方一个 GET 就能看到原因
    throw error;
  }
}
