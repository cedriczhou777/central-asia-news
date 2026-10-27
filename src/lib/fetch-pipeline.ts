/**
 * 采集流水线的**共用零件**（2026-10-27 抽出）。
 *
 * ## 为什么抽出来
 *
 * 新增的 `POST /api/telegram-ingest`（GitHub Actions 抓到的 Telegram 原文从这里进来）
 * 必须与 RSS 路径**走同一套判据** ⇒ ⇒ 这些零件必须**只有一份出处**。
 * ⇒ ⚠️ 而且 Next.js 的 **route 文件只能导出 HTTP 方法与少数配置**
 * ⇒ ⇒ 从 `fetch-news/route.ts` 里 `export` 是**不行的**（Next 会报错）
 * ⇒ ⇒ 只能搬到 `src/lib/`，两边 import 同一个。
 *
 * ## ⚠️ 「搬移」不是「改写」
 *
 * 下面每个函数都是**逐字搬过来**的（用脚本从 route.ts 里切出来的，不是手抄）
 * ⇒ ⇒ 行为不变 ⇒ ⇒ 门禁（`verify:offline`）能验。
 *
 * ## 判据一致性的守卫
 *
 * `scripts/test-fetch-pipeline.ts` 里有两条断言把「**组装字段集**」钉死：
 * 本模块的 `buildArticleRow` 与 route.ts 里那个内联 `articlesToInsert.push({...})`
 * **必须字段名完全一致** ⇒ ⇒ 两边一旦漂移，门禁立刻红。
 */

import { isInvestmentTopic } from './investment-score';
import { fetchArticleBody, needsBodyFetch, BODY_FETCH_GAP_MS } from './article-body';
import type { ArticleInsert } from './db-articles';

// 明显与投资者无关的「垃圾标题」关键词（命中即跳过，翻译都不做，纯省钱）。
// 注意只匹配标题，且只要标题里同时出现强投资词（如 pipeline / gdp）就不拦。
export const JUNK_TITLE_KEYWORDS = [
  'horoscope', 'weather forecast', 'crossword', 'recipe', 'celebrit', 'tv series',
  'football', 'soccer', 'hockey', 'boxing', 'match result', 'champion', 'tournament',
  'concert', 'festival of', 'beauty contest', 'fashion show', 'wedding',
  'гороскоп', 'погода', 'кроссворд', 'рецепт', 'футбол', 'хокке', 'бокс',
  'чемпионат', 'турнир', 'концерт', 'фестивал', 'свадьба', 'мода',
  'футбол', 'спорт', 'матч',
];

export function toSafeIso(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

// 标题是否明显是文体/生活类垃圾（不值得花翻译钱）
export function isJunkTitle(title: string): boolean {
  const t = title.toLowerCase();
  return JUNK_TITLE_KEYWORDS.some((kw) => t.includes(kw));
}

// 检查新闻是否与投资主题相关（**入库闸门**，宽松兜底）。
//
// ⚠️ 用的是 `isInvestmentTopic` 而不是 `scoreInvestmentRelevance(...) > 0`：
// 后者用的是为**排序**精简过的加权词表（刻意去掉了 president/government/development
// 这类无区分力的词）。拿它当闸门 = 悄悄收紧入库条件，
// 而本项目历史上因判据过严出现过「每国不足 15 篇」。
// 闸门词表把 2026-09-21 之前的旧表**逐字保留**、只增不减，语义与改动前完全一致。
export function isInvestmentRelevant(title: string, description: string): boolean {
  return isInvestmentTopic(`${title} ${description}`);
}

export function extractTags(title: string, description: string): string[] {
  const text = `${title} ${description}`.toLowerCase();
  const tags: string[] = [];
  const tagKeywords: Record<string, string[]> = {
    '投资': ['invest', 'investor'],
    '能源': ['oil', 'gas', 'energy'],
    '矿产': ['mining', 'mineral', 'copper', 'gold'],
    '基建': ['railway', 'road', 'infrastructure', 'construction'],
    '政策': ['policy', 'reform', 'law', 'regulation'],
    '贸易': ['trade', 'export', 'import'],
    '外交': ['diplomat', 'summit', 'bilateral', 'agreement'],
  };
  for (const [tag, keywords] of Object.entries(tagKeywords)) {
    if (keywords.some((kw) => text.includes(kw))) {
      tags.push(tag);
    }
  }
  return tags.length > 0 ? tags : ['综合'];
}

// 从 HTML 内容中提取图片 URL
export function extractImagesFromHtml(html: string): string[] {
  const imgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
  const images: string[] = [];
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    const url = match[1];
    if (url && !url.startsWith('data:') && !url.includes('pixel') && !url.includes('tracking')) {
      images.push(url);
    }
  }
  return images;
}

// 从文章原始 URL 获取 og:image 作为封面图（RSS 内容无图时的兜底）
export async function fetchOgImage(url: string): Promise<string> {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return '';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!res.ok) return '';
      const html = await res.text();
      const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      if (ogMatch && ogMatch[1] && ogMatch[1].startsWith('http')) {
        return ogMatch[1];
      }
      return '';
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return '';
  }
}

/**
 * 把「翻译好的一条稿子」组装成**入库行**（与 route.ts 里那个内联 push 字段集一致）。
 *
 * ⚠️ **字段集必须与 `fetch-news/route.ts` 里那个 push 逐字一致** ⇒
 * ⇒ `scripts/test-fetch-pipeline.ts` 有一条断言专门比对两边。
 * ⇒ 本函数是**新增**的（不是搬移）⇒ 因为 route.ts 那处是内联的、没法直接搬。
 */
export interface BuildArticleRowParams {
  titleZh: string;
  summaryZh: string;
  contentZh: string;
  /** 桶的国家码（**不是** `source.country` —— intl 稿会被改判，写错就永远推不出去） */
  countryCode: string;
  category: string;
  sourceName: string;
  sourceUrl: string;
  originalTitle: string;
  originalContent: string;
  originalLanguage: string;
  publishedAt: string;
  tags: string[];
  coverImage: string;
  imageUrls: string[];
}

export function buildArticleRow(p: BuildArticleRowParams): ArticleInsert {
  return {
    title: p.titleZh || '无标题',
    summary: p.summaryZh,
    content: p.contentZh,
    country_code: p.countryCode,
    category: p.category,
    source_name: p.sourceName,
    source_url: p.sourceUrl,
    original_title: p.originalTitle,
    original_content: p.originalContent,
    original_language: p.originalLanguage,
    published_at: p.publishedAt,
    tags: p.tags,
    is_featured: true,
    cover_image: p.coverImage,
    image_urls: p.imageUrls,
  };
}

/**
 * 正文补抓 —— RSS 只给了标题时，去文章页把正文取回来。
 *
 * 返回**可以拿去翻译的正文**；返回 `null` 表示「这条拿不到正文」，
 * 调用方必须**丢弃它**，不许继续走翻译。
 *
 * ## 为什么返回 null 就一定要丢（2026-10-02 实测的根因）
 *
 * 实测 az 的 AZERTAC(en/ru)、Trend.az、APA、Qafqazinfo 这 5 个源的 RSS
 * **一个字的正文都没有**（uz 的 Uznews.uz、Podrobno.uz 同样）。
 * 旧代码对这种情况的处理是：`originalContent = ''` 然后**照样翻译** ——
 * 于是模型照着标题编了一整篇。库里实存 `id 8766`（APA）写着
 * 「…阿塞拜疆政府尚未对贝森特的指责做出正式回应」，原文里根本没有这句；
 * `id 8765` 同一句重复两遍；`id 8740` 结尾直接是标题的回声。
 *
 * 而且这**不是提示词能救的**：总审的第七件事（与原文核对）拿到的是空原文，
 * 结构性失明 —— 阿塞拜疆线上 `originalsSeen 4/15` 就是这么来的。
 *
 * ## 为什么要把计数交给调用方
 *
 * `bodyBackfilled` / `droppedNoBody` 是**漏斗字段**，归调用方的 `result` 管。
 * 这里只做「取回」这一件事，保持无状态 —— 这样 RSS 与 Telegram 两条路径
 * 共用同一份实现，不会各写一份然后分叉（这个项目已经栽过三次同样的跟头）。
 */
export async function backfillBody(
  description: string,
  link: string | undefined,
): Promise<{ text: string; backfilled: boolean } | null> {
  if (!needsBodyFetch(description)) return { text: description, backfilled: false };
  const body = await fetchArticleBody(link || '');
  // 同一台站之间喘一口气：azertag 那类被 Cloudflare 罩着的站点，
  // 连打会在几秒内把后面全部打成 403（见 article-body.ts 的对照实验）。
  await new Promise((r) => setTimeout(r, BODY_FETCH_GAP_MS));
  if (!body.ok) return null;
  return { text: body.text, backfilled: true };
}
