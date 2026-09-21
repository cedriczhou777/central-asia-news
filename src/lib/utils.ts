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

// 检测文本是否为中文：中文字符占比达到阈值（默认 40%）即视为已翻译为中文
export function isChineseText(text: string, threshold = 0.4): boolean {
  const cleaned = (text || '').replace(/<[^>]+>/g, ' ').replace(/[\s，。、；：,.!?…\-"'“”‘’()·%$]+/g, '');
  if (!cleaned) return false;
  const han = cleaned.match(/[\u4e00-\u9fa5]/g)?.length || 0;
  return han / cleaned.length >= threshold;
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
