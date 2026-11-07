/**
 * ★★ **五国稿包接收**（2026-11-07）。
 *
 * ## 为什么有它（与 ChatGPT 商定的分工）
 *
 * ChatGPT 那边负责：取源、筛选、去重、事实核实的正文、独立审稿与复核、
 * 逐条核验过的**真实配图**（附图注与来源）、国别标题/摘要/封面/排版/来源链接
 * ⇒ ⇒ 它产出的是「**待你终检发布**」的成品包。
 *
 * 云托管负责：**接收 + 投递**（存稿、存图、写入公众号草稿箱）⇒ **不再调模型改写或审核**。
 *
 * ## 为什么需要这个接口（而不是只用 Word 上传）
 *
 * ⚠️ **图片塞不进 Word** ⇒ Word 稿收不到配图 ⇒ 草稿会没有图。
 * ⇒ ⇒ 这里收**结构化稿包**：正文 HTML 里**直接带 `<img src="https://…">`**
 * ⇒ ⇒ **旧推送链路零改动就能处理**（`extractFirstImage` 那套「外链图 → 上传微信素材库
 * → 换成 CDN 地址」已经现成）⇒ ⇒ 这是最省的一条路。
 *
 * ## 契约
 *
 * ```json
 * POST /api/word-package
 * {
 *   "version": "2026-11-07",              // ★ 版本号 ⇒ 幂等键
 *   "countries": {                          // ★ 五国必须齐 ⇒ 缺一不提交
 *     "kz": { "title": "…", "summary": "…", "bodyHtml": "<p>…<img src=\"…\"></p>",
 *               "sourceName": "…", "sourceUrl": "…", "coverUrl": "…" },
 *     "uz": { … }, "kg": { … }, "tj": { … }, "az": { … }
 *   }
 * }
 * ```
 *
 * 响应：
 * ```json
 * { "ok": true, "version": "2026-11-07", "inserted": 17, "skipped": 0,
 *   "byCountry": { "kz": 4, "uz": 3, "kg": 4, "tj": 3, "az": 3 } }
 * ```
 *
 * ## 幂等：靠 `（版本号 + 国别 + 判别键）`
 *
 * · **版本号**已在 `articles` 的 `tags` 里（`['word', 'v:2026-11-07']`）
 *   ⇒ 同版本重复提交 ⇒ **不重复插入**（返回 `skipped`）⇒ 不会产生重复稿；
 * · **判别键**用标题（`canonicalTitleKey`）⇒ 同一天同一国同标题 ⇒ 只留一条。
 */
import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COUNTRIES = ['kz', 'uz', 'kg', 'tj', 'az'] as const;
type CountryCode = (typeof COUNTRIES)[number];

interface CountryDraft {
  title?: string;
  summary?: string;
  /** ★ 正文 HTML（**含 `<img src>`** ⇒ 旧链路会照旧把图传到微信素材库） */
  bodyHtml?: string;
  sourceName?: string;
  sourceUrl?: string;
  coverUrl?: string;
}

/** 判别键：标题归一化（同标题 ⇒ 视为同一篇） */
function titleKey(t: string): string {
  return t.replace(/[\s·、，。,.:：;；"'“”‘’（）()【】\[\]—–\-]/g, '').toLowerCase();
}

export async function POST(req: Request): Promise<Response> {
  // ---- 鉴权（与 word-ingest 同一套）----
  const secret = process.env.INGEST_SECRET;
  if (secret && req.headers.get('x-ingest-secret') !== secret) {
    return NextResponse.json({ ok: false, error: '缺少或错误的 X-Ingest-Secret' }, { status: 401 });
  }

  let body: { version?: string; countries?: Record<string, CountryDraft> };
  try {
    body = await req.json();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    );
  }

  const version = (body.version || '').trim();
  if (!version) {
    return NextResponse.json({ ok: false, error: '缺少 version（版本号 = 幂等键）' }, { status: 400 });
  }

  const countries = body.countries || {};
  const missing = COUNTRIES.filter((c) => !countries[c] || !countries[c].title);
  if (missing.length > 0) {
    // ⚠️ **五国不齐 ⇒ 不提交**（ChatGPT 定的规矩：只有五国均完成审校才提交）
    return NextResponse.json(
      { ok: false, error: `五国未齐，缺：${missing.join('、')} ⇒ 按约定不提交`, missing },
      { status: 409 },
    );
  }

  const sb = getSupabaseClient();
  let inserted = 0;
  let skipped = 0;
  const byCountry: Record<string, number> = {};
  const failed: Array<{ country: string; error: string }> = [];

  // ★★ 2026-11-07：**版本号幂等（整批级）** —— ChatGPT 指出的缺口，已补。
  //
  // 原来只按「同国 + 同标题」判重 ⇒ 「改过标题的同一批」会被当成新稿插进去
  // ⇒ 同一版本出现两批稿。
  // ⇒ 现在先问一次「这个版本已经在库里了吗」⇒ 有 ⇒ **整批跳过**（返回 duplicate=true）。
  const versionTag = `v:${version}`;
  const { data: already } = await sb
    .from('articles')
    .select('id, country_code')
    .contains('tags', [versionTag]);
  const doneCountries = new Set((already || []).map((r) => r.country_code as string));

  // ⚠️⚠️ **不能「整批跳过」** —— 那样「部分失败后重发」时**缺的国家也会被跳过 ⇒ 永远补不上**。
  // ⇒ 正确语义：
  //   · **五国都齐了** ⇒ 整批跳过（真幂等，返回 duplicate=true）
  //   · **只到了一部分** ⇒ **只补缺的国家**（已入库的按「同国+同标题」再挡一次）
  if (doneCountries.size >= COUNTRIES.length) {
    return NextResponse.json({
      ok: true,
      version,
      duplicate: true,
      inserted: 0,
      skipped: COUNTRIES.length,
      byCountry: {},
      note: `版本 ${version} 的五国都已入库（tags 含 ${versionTag}）⇒ 整批跳过（幂等）`,
    });
  }
  if (doneCountries.size > 0) {
    console.warn(
      `[word-package] 版本 ${version} 已有 ${[...doneCountries].join('、')} 入库 ⇒ 只补其余国家`,
    );
  }

  for (const code of COUNTRIES) {
    // ★ 这一国在同版本里已经入库 ⇒ 跳过（补批时的幂等）
    if (doneCountries.has(code)) {
      skipped++;
      continue;
    }
    const d = countries[code];
    const title = (d.title || '').trim();
    const bodyHtml = (d.bodyHtml || '').trim();
    if (!title || !bodyHtml) {
      skipped++;
      continue;
    }
    const key = titleKey(title);

    // ---- 幂等：**同版本 + 同国 + 同标题** ⇒ 跳过 ----
    //
    // ⚠️⚠️ 2026-11-07：ChatGPT 指出的残留边界 —— 原来这里只按「同国 + 同标题」查
    // ⇒ ⇒ **跨版本也会跳** ⇒ 同国两篇**内容不同、标题恰好相同**的新稿会被误判成重复
    // ⇒ ⇒ **真丢稿**。
    // ⇒ 现在加上版本约束：只有**同一个版本**里的同国同标题才跳
    // ⇒ ⇒ 跨版本的同标题稿能正常进来。
    const { data: dup } = await sb
      .from('articles')
      .select('id')
      .eq('country_code', code)
      .eq('original_title', key)
      .contains('tags', [versionTag])
      .limit(1);
    if (dup && dup.length > 0) {
      skipped++;
      continue;
    }

    const now = new Date().toISOString();
    const { error } = await sb.from('articles').insert({
      title,
      summary: (d.summary || '').slice(0, 200),
      content: bodyHtml,
      country_code: code,
      category: 'economy',
      source_name: d.sourceName || 'ChatGPT',
      source_url: d.sourceUrl || null,
      original_title: key,
      original_content: null,
      original_language: null,
      published_at: now,
      // ★ `tags` 同时装**输入源标记**与**版本号** ⇒ 幂等与追溯都靠它
      tags: ['word', `v:${version}`],
      is_featured: false,
    });
    if (error) {
      skipped++;
      // ⚠️⚠️ 2026-11-07：**失败必须让调用方看见**（ChatGPT 指出的第二个问题）。
      // 原来这里只 `skipped++` ⇒ 最后照样返回 `ok: true` ⇒ 调用方会以为五国都收到了
      // ⇒ 而实际只收到部分稿件 ⇒ ⇒ **部分失败时 `ok` 必须是 false**。
      failed.push({ country: code, error: error.message });
      console.warn(`[word-package] ${code} 落库失败：${error.message}`);
    } else {
      inserted++;
      byCountry[code] = (byCountry[code] || 0) + 1;
    }
  }

  // ⚠️ **部分失败 ⇒ 明确报错**（宁可让调用方重试，也不要「看起来成功」）
  if (failed.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: `有 ${failed.length} 个国家落库失败 ⇒ **本批不完整**（已入库 ${inserted} 篇）⇒ 请修好后重发`,
        version,
        inserted,
        skipped,
        byCountry,
        failed,
        hint: '重发同一 version 是安全的：已入库的国家会按「同国+同标题」跳过',
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    version,
    duplicate: false,
    inserted,
    skipped,
    byCountry,
    note: '图片请直接写进 bodyHtml 的 <img src="https://…"> ⇒ 旧推送链路会照旧上传到微信素材库',
  });
}
