/**
 * `POST /api/telegram-ingest` —— **收 GitHub Actions 抓来的 Telegram 原文**（2026-10-27）。
 *
 * ## 为什么需要它
 *
 * 微信云托管在大陆 ⇒ 连不上 `t.me` ⇒ **12 个 Telegram 频道（占配置源的 34%）一条都进不来**。
 * 而 **GitHub 的 runner 在境外** ⇒ ⇒ 抓取放到 Actions 上，**原文送回这里**，
 * 由云托管**自己翻译 + 入库** ⇒ ⇒ 零 schema 改动、零新数据库对象。
 *
 * ## 为什么「只送原文、翻译留在云托管」
 *
 * 实测确认：**push 的选稿没有「必须中文标题」的闸**（`MIN_HAN_TITLE` 不在 push 里）
 * ⇒ ⇒ 未翻译的俄文标题稿子会被**原样选进日报** ⇒ ⛔ 绝对不行。
 * ⇒ ⇒ 所以**必须**让云托管来翻译 ⇒ ⇒ 这里走的是与 RSS **完全同一套**零件
 * （`@/lib/fetch-pipeline` 的那 8 个 + `translateNews`）⇒ ⇒ **判据只有一份**。
 *
 * ## 鉴权
 *
 * header `x-ingest-secret` 必须等于环境变量 `TELEGRAM_INGEST_SECRET`。
 * ⚠️ **未配置 ⇒ 一律 401**（绝不「没配置就放开」—— 那等于任何人都能往生产库里灌稿子）。
 *
 * ## 幂等
 *
 * `insertArticles` **不带 ON CONFLICT** ⇒ 重复提交会产生重复行
 * ⇒ ⇒ 这里**自己查重**，判据与「闸 2 库内身份去重」**逐字同源**
 * （`canonicalUrl(source_url)` / `originalTitleKey(original_title)`）
 * ⇒ ⇒ Actions 重跑不会灌进重复稿。
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  insertArticles,
  getRecentCanonicalUrls,
  getRecentOriginalTitleKeys,
} from '@/lib/db-articles';
import { translateNews } from '@/lib/translate';
import { canonicalUrl, originalTitleKey, isChineseText } from '@/lib/utils';
import {
  toSafeIso,
  isJunkTitle,
  isInvestmentRelevant,
  extractTags,
  extractImagesFromHtml,
  fetchOgImage,
  backfillBody,
  buildArticleRow,
} from '@/lib/fetch-pipeline';
import { DEFAULT_TELEGRAM_CHANNELS, parseTelegramChannels } from '@/lib/telegram-channels';
import { countryList } from '@/lib/data/countries';

/** 查重的窗口（天）—— 与采集侧的 `DB_DEDUP_WINDOW_DAYS` 同量级。 */
const DEDUP_WINDOW_DAYS = 3;

export const dynamic = 'force-dynamic';

interface IngestPost {
  title?: string;
  url?: string;
  date?: string | null;
  summary?: string;
}

interface IngestBody {
  channel?: string;
  posts?: IngestPost[];
}

/** 从频道表里查出这个频道属于哪个国家。 */
function countryOfChannel(channel: string): string | null {
  const id = channel.startsWith('@') ? channel : `@${channel}`;
  for (const e of parseTelegramChannels(DEFAULT_TELEGRAM_CHANNELS)) {
    if (e.channel === id || e.channel === channel) return e.country;
  }
  return null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ---- 鉴权（**第一件事**，未配置也拒绝）----
  const expected = process.env.TELEGRAM_INGEST_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: '未配置 TELEGRAM_INGEST_SECRET ⇒ 拒绝一切请求' },
      { status: 401 },
    );
  }
  const provided = request.headers.get('x-ingest-secret') || '';
  if (provided !== expected) {
    return NextResponse.json({ ok: false, error: 'x-ingest-secret 不匹配' }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as IngestBody;
  const channel = (body.channel || '').trim();
  const posts = Array.isArray(body.posts) ? body.posts : [];
  if (!channel) {
    return NextResponse.json({ ok: false, error: '缺 channel' }, { status: 400 });
  }
  if (posts.length === 0) {
    return NextResponse.json({ ok: true, accepted: 0, translated: 0, inserted: 0, failed: 0, skipped: 0, samples: [] });
  }

  const country = countryOfChannel(channel);
  if (!country) {
    return NextResponse.json(
      { ok: false, error: `频道 ${channel} 不在频道表里 ⇒ 不知道属于哪个国家` },
      { status: 400 },
    );
  }
  const countryName = countryList.find((c) => c.code === country)?.name || country;

  // ---- 查重（幂等）：判据与「闸 2」逐字同源 ----
  const since = new Date(Date.now() - DEDUP_WINDOW_DAYS * 86_400_000).toISOString();
  let knownUrls = new Set<string>();
  let knownOriginals = new Map<string, number>();
  try {
    const [u, o] = await Promise.all([
      getRecentCanonicalUrls(since),
      getRecentOriginalTitleKeys(since),
    ]);
    knownUrls = u.urls;
    knownOriginals = o.keys;
  } catch (err) {
    // ⚠️ **查不出来 ⇒ 不入库**（fail-closed，与采集侧闸 2 同一取舍：
    // 重复入库会直接进草稿推给读者、不可撤销；漏入库下一轮还能补）。
    return NextResponse.json(
      {
        ok: false,
        error: `查重失败 ⇒ 本批不入库：${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 503 },
    );
  }

  const rows = [];
  let skippedJunk = 0;
  let skippedIrrelevant = 0;
  let skippedDup = 0;
  let failed = 0;
  const samples: string[] = [];

  for (const post of posts) {
    const originalTitle = (post.title || '').trim();
    const url = (post.url || '').trim();
    if (!originalTitle || !url) {
      failed++;
      continue;
    }
    // 幂等：同一链接 / 同一篇原文，已在库里就跳过
    const cu = canonicalUrl(url);
    const ok2 = originalTitleKey(originalTitle);
    if ((cu && knownUrls.has(cu)) || (ok2 && knownOriginals.has(ok2))) {
      skippedDup++;
      continue;
    }
    // 与 RSS 路径同一批闸
    if (isJunkTitle(originalTitle)) {
      skippedJunk++;
      continue;
    }
    const rawSummary = (post.summary || '').trim();
    if (!isInvestmentRelevant(originalTitle, rawSummary)) {
      skippedIrrelevant++;
      continue;
    }
    // 补抓正文（Telegram 的 summary 常常只有一句话，撑不起一篇报道）
    const body = await backfillBody(rawSummary, url);
    if (!body) {
      failed++;
      continue;
    }
    const originalContent = body.text;

    // 图片
    let imageUrls = extractImagesFromHtml(originalContent);
    if (imageUrls.length === 0) {
      const og = await fetchOgImage(url);
      if (og) imageUrls = [og];
    }
    const coverImage = imageUrls[0] || '';

    // 翻译（**与 RSS 路径同一个函数**）
    let titleZh = originalTitle;
    let summaryZh = originalContent.substring(0, 200);
    let contentZh = originalContent;
    let category = 'economy';
    try {
      const translated = await translateNews(
        originalTitle,
        originalContent,
        'ru',
        countryName,
      );
      if (!translated.translated && !isChineseText(originalTitle)) {
        // 翻译失败且原文不是中文 ⇒ **不入库**（绝不让俄文进生产库）
        skippedIrrelevant++;
        continue;
      }
      if (translated.translated && !translated.investorRelevant) {
        skippedIrrelevant++;
        continue;
      }
      titleZh = translated.titleZh || originalTitle;
      summaryZh = translated.summaryZh || originalContent.substring(0, 200);
      contentZh = translated.contentZh || originalContent;
      if (translated.category) category = translated.category;
      if (coverImage) {
        contentZh = `<img src="${coverImage}" referrerpolicy="no-referrer" />\n\n${contentZh}`;
      }
    } catch (err) {
      failed++;
      samples.push(`翻译失败：${originalTitle.slice(0, 30)}｜${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    rows.push(
      buildArticleRow({
        titleZh,
        summaryZh,
        contentZh,
        countryCode: country,
        category,
        sourceName: `Telegram/${channel}`,
        sourceUrl: url,
        originalTitle,
        originalContent,
        originalLanguage: 'ru',
        publishedAt: toSafeIso(post.date || undefined),
        tags: extractTags(originalTitle, originalContent),
        coverImage,
        imageUrls,
      }),
    );
  }

  // ---- 入库 ----
  let inserted = 0;
  const errors: string[] = [];
  if (rows.length > 0) {
    try {
      const res = await insertArticles(rows);
      inserted = res.inserted;
      errors.push(...res.errors);
    } catch (err) {
      errors.push(`入库抛异常：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    channel,
    country,
    accepted: posts.length,
    translated: rows.length,
    inserted,
    failed,
    skipped: skippedJunk + skippedIrrelevant + skippedDup,
    skippedDetail: { junk: skippedJunk, notInvestorRelevant: skippedIrrelevant, alreadyInDb: skippedDup },
    errors: errors.slice(0, 5),
    samples: samples.slice(0, 5),
  });
}
