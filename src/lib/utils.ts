import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// 从含图片的 content 中提取第一张图片 URL（支持 <img src> 标签）
export function extractFirstImage(content: string): string | null {
  const m = content.match(/<img[^>]*?\ssrc=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

// 提取首图 URL，并从剩余正文中剥离图片标签
export function splitContentImage(content: string): { coverImage: string | null; textContent: string } {
  const coverImage = extractFirstImage(content);
  const textContent = coverImage
    ? content.replace(/<img[^>]*?>/gi, '').trim()
    : content.trim();
  return { coverImage, textContent };
}

// ---------------------------------------------------------------------------
// 语言与书写系统判定
// ---------------------------------------------------------------------------

/**
 * 「这段文本已经是中文产物」所需的**最少汉字个数**。
 *
 * ⚠️ **两个值都是在真实语料上定标出来的，别凭感觉改**（2026-09-23，7 天 × 5 国 1757 篇）：
 *
 * | 阈值 | 语料上被判「未翻译」的篇数 |
 * |---|---|
 * | `MIN_HAN_CONTENT = 60` | **106 篇（6.03%）** ← 危险，会静默丢稿 |
 * | `MIN_HAN_CONTENT = 30` | 11 篇（0.63%） |
 * | **`MIN_HAN_CONTENT = 20`（现值）** | **2 篇（0.11%）** |
 * | `MIN_HAN_CONTENT = 10` | 1 篇（0.06%） |
 *
 * 语料实测：正文汉字个数 min=4 / p1=34 / 中位=143；标题 min=6 / p1=12 / 中位=24。
 * 标题取 4（比语料下界 6 还低两个，留余量），正文取 20。
 *
 * 那 2 篇的正文汉字只有 11 个和 4 个 —— 是**正文残缺**的稿子（正文只有一两句），
 * 从「可推送」变成「未翻译」是**正确行为**，不是误杀。抽查过。
 *
 * 为什么刻意取低：本判据要区分的是「**0 个汉字**（模型把原文回显了）」和
 * 「译成了中文」，源语言 ru/kk/ky/az 的原文汉字个数恒为 0，
 * 所以 4 / 20 这个量级完全够用。阈值取高只会换来一种后果：**合格译文被静默丢弃**。
 */
export const MIN_HAN_TITLE = 4;
export const MIN_HAN_CONTENT = 20;

/** 去 HTML 标签、空白与常见标点，只留真正参与语言判定的字符。 */
function stripForLangCheck(text: string): string {
  return (text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\s，。、；：,.!?…\-"'“”‘’()·%$《》「」【】—–]+/g, '');
}

/** 汉字个数（先剥掉标签与标点）。 */
export function hanCount(text: string): number {
  return (stripForLangCheck(text).match(/[\u4e00-\u9fa5]/g) || []).length;
}

/** 汉字占比（保留给需要「比例」语义的调用方；语言判定不要用它，见 isChineseText）。 */
export function hanRatio(text: string): number {
  const cleaned = stripForLangCheck(text);
  if (!cleaned) return 0;
  return hanCount(cleaned) / cleaned.length;
}

/**
 * 找出「一个词里同时含汉字和西里尔字母」的片段。返回空数组 = 干净。
 *
 * 为什么这条值得单独成函数：这种写法**结构上不可能正确** ——
 * 一段中文里不可能合法地出现 `米尔зиёё夫`／`肯еш`／`议员Владимир`。
 * 2026-09-23 实测 7 天 × 5 国 1757 篇里 **3.2% 的篇目**含这种词（156 种），
 * 全部是坏的，**没有一例误报**。所以它可以当**硬判据**用（判不合格 → 重试）。
 *
 * ⚠️ **故意不把「汉字 + 拉丁字母」也算进来**。看着对称，实际会误伤：
 * `60kg`／`100kg`／`center私立诊所` 这类是完全正常的写法，
 * 而这条判据的下游是「重试 → 三次都不过就丢弃该篇」，误报的代价是**静默丢稿**，
 * 不是排版难看。宁可少抓一种（`霍贾and` 那类交给提示词去要求）。
 */
export function mixedScriptTokens(text: string): string[] {
  const out: string[] = [];
  for (const tok of (text || '').split(/[\s，。、；：（）()「」“”"'·—\-–/《》【】!?！？]+/)) {
    if (!tok) continue;
    if (/[\u4e00-\u9fff]/.test(tok) && /[\u0400-\u04ff]/.test(tok)) out.push(tok);
  }
  return out;
}

/**
 * 检测文本是否为中文：**汉字个数 ≥ minHan** 即视为已翻译为中文。
 *
 * ## ⚠️ 2026-09-23 改过判据（占比 → 绝对个数），改之前先读完
 *
 * 旧实现是「汉字**占比** ≥ 0.4，拉丁字母计入分母」。在「人名保留拉丁」的旧口径下
 * 实测余量只有 0.005（min 0.405），注释里就写着「改动上线后要复查这个分布」。
 * 2026-09-23 口径扩成**人名/地名/国名/公司名/机构名一律保留拉丁**之后，
 * 占比会掉到 **0.27–0.36**，**低于 0.4** ——
 * 于是「翻译完全正确」的稿件会被判成「未翻译」，重试三次后**静默丢弃**。
 * 更隐蔽的是 `article-format.ts` 的 `isPushableText()` 也用这个判据，
 * 那意味着**稿子入库了却永远推不出去**。
 *
 * 换判据的理由：要回答的问题是「**有没有真的翻译**」，而不是「汉字占多大比例」。
 * 源语言只有 ru / kk / ky / az，**原文里的汉字个数恒为 0**，
 * 而只要译了，标题就有十来个汉字。区分度是「0 vs 十几个」，绝对个数完全够。
 * 占比这个仪器在这里**从根上选错了**：它惩罚的恰好是产品上正确的行为。
 *
 * ⚠️ 调用方请用 `article-format.ts` 的 `isPushableText()` / `pushExclusionReason()`，
 * 或 `translate.ts` 的 `normalizeResult`，**不要**再在这里写裸调用：
 * 这个表达式曾在两处各写一份，就是历史上三次「体检与生产不一致」的起点。
 */
export function isChineseText(text: string, minHan = MIN_HAN_TITLE): boolean {
  const cleaned = stripForLangCheck(text);
  if (!cleaned) return false;
  return hanCount(cleaned) >= minHan;
}

// ----- 内容级去重工具（基于语义化归一化 + n-gram 相似度）-----

// 归一化文本：统一小写、去标点/空白、去停用词，保留主体信息
export function normalizeText(text: string, maxLen = 120): string {
  const t = (text || '')
    .replace(/<[^>]+>/g, ' ')                       // 去 HTML 标签
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')              // 仅保留字母/数字/空白（Unicode 属性支持）
    .replace(/\s+/g, ' ')
    .trim();
  return t.split(' ').slice(0, maxLen).join(' ');
}

// 字符级 bigram 集合（Jaccard 用）
function charBigrams(text: string): Set<string> {
  const set = new Set<string>();
  const cleaned = text.replace(/\s+/g, '');
  if (cleaned.length <= 1) {
    set.add(cleaned);
    return set;
  }
  for (let i = 0; i < cleaned.length - 1; i++) {
    set.add(cleaned.substring(i, i + 2));
  }
  return set;
}

// Jaccard 相似度（0-1）
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  const sa = charBigrams(na);
  const sb = charBigrams(nb);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// 两条新闻是否为重复内容（标题+正文综合相似度超过阈值即视为重复）
export function isDuplicateContent(
  titleA: string, contentA: string,
  titleB: string, contentB: string,
  threshold = 0.6
): boolean {
  const tSim = similarity(titleA, titleB);
  // 标题高度相似（大概率同一事件不同表述）
  if (tSim >= 0.8) return true;
  // 标题相近且正文也相近
  const cSim = similarity(contentA, contentB);
  return (tSim + cSim) / 2 >= threshold;
}

// ----- 链接归一化（「同一原文」的唯一指纹）-----

/** 已知的追踪类查询参数：只影响统计，不影响指向哪篇文章。 */
const TRACKING_PARAM = /^(?:utm_[a-z0-9_]*|from|ref|referrer|referer|fbclid|gclid|yclid|_ga|_gl|spm|share_[a-z0-9_]*|source|src|sharer|s|si)$/i;

/**
 * 把指向同一篇原文的不同链接形式归一到同一个字符串。
 *
 * 为什么必须有这个函数：原项目的去重是对 `source_url` 做**精确字符串比较**，
 * 而同一个源站的同一条新闻在不同抓取路径下链接会变形 ——
 * RSS 里带 `?from=rss`、带末尾斜杠、带 `#anchor`、带 `utm_*` 追踪参数、
 * 带或不带 `www.`。这些形式字符串不相等，去重就漏过去了，
 * 结果是**同一条新闻被翻译两次、入库两次、在公众号草稿里连着出现两遍**
 * （2026-09-21 用户在预览里截到的那对阿斯塔纳桥梁新闻就是这么来的：
 * 两篇的 source_url 逐字相同，却都在库里）。
 *
 * 归一化规则（只做「显然指向同一篇」的等价变换，不做任何猜测）：
 *   - 去掉协议与 `www.`（http/https、有无 www 不改变指向）
 *   - 去掉 fragment（`#...`）
 *   - 去掉已知追踪参数，保留其余查询参数并排序
 *     （**不能**粗暴删掉整个 query：Tazabek 这类站的 query 里可能带文章号）
 *   - 去掉末尾斜杠，host/path 小写
 *
 * 非法 URL（相对路径、脏数据）退化为「去 fragment、去末尾斜杠的小写串」，
 * 至少还能做到大小写/末尾斜杠的等价合并。
 */
export function canonicalUrl(url: string): string {
  const raw = (url || '').trim();
  if (!raw) return '';

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.toLowerCase().replace(/[#?].*$/, '').replace(/\/+$/, '');
  }

  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAM.test(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const host = u.host.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  const query = params.map(([k, v]) => `${k}=${v}`).join('&');
  return `${host}${path}${query ? '?' + query : ''}`;
}

// ----- 「同一篇原文」的指纹 -----

/**
 * 原文标题归一化后作为「同一篇原文」的指纹（`''` 表示没有可用指纹）。
 *
 * 用途：同一条 feed 项在同一站点可能有多个链接（聚合页 / 带参链接 / 转载），
 * 链接归一化挡不住「不同链接指向同一篇原文」，但**原文标题是逐字相同的**，
 * 所以它比中文译名可靠得多 —— 译名会因翻译波动而不同，原文标题不会。
 *
 * 只保留字母/数字/汉字（丢掉标点与空白：不同轮次抓取可能套上不同空白或零宽字符），
 * 长度不足 10 的直接返回空 —— 短标题极易撞车（「新闻」「摘要」之类），
 * 宁可放过不要错并（把两条不同新闻合成一条是**丢信息**，比留重复更糟）。
 *
 * 注意：`db-articles.ts` 与 `same-event.ts` 必须用**同一个**指纹函数，
 * 否则「入库时判重」与「选稿时判重」会各自为政。
 */
export function originalTitleKey(title: string): string {
  const cleaned = (title || '')
    .replace(/<[^>]*>/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return cleaned.length >= 10 ? cleaned : '';
}

// ----- 日期口径（唯一出口）-----

/**
 * 当天日期，按北京时间算，返回 `YYYY-MM-DD`。
 *
 * **不要再写 `new Date().toISOString().split('T')[0]`** —— 那是 UTC 日期，
 * 北京 00:00–08:00 会算成前一天。本项目所有「今天」的语义都是北京时间的今天：
 * 草稿标题（曾因 UTC 日期导致同一天两次推送生成同名草稿）、
 * 日报的日期区间（本来就用 `+08:00` 圈范围）、抓取的 targetDate。
 */
export function beijingDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}
