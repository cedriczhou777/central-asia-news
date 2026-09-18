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
