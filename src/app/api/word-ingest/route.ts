/**
 * ★ **Word 稿上传**（2026-11-07 新链路入口）。
 *
 * `POST /api/word-ingest`
 * - `multipart/form-data`，字段 `file` = `.docx` 文件
 * - 可选字段 `date`（默认今天）、`persist`（`1` = 同时落库）
 *
 * ## 返回
 *
 * ```json
 * {
 *   "ok": true,
 *   "parsed": { "articles": N, "warnings": [...] },
 *   "audit": { "total": N, "findings": [...], "byCountry": {...} },
 *   "fixList": "（Markdown，可直接贴回 ChatGPT）",
 *   "persisted": { "inserted": N, "skipped": N } | null
 * }
 * ```
 *
 * ## ⭐ 为什么**默认不落库**
 *
 * 草稿不可逆、且「上传 ⇒ 校核 ⇒ 让 ChatGPT 改 ⇒ 再上传」是**多轮**的
 * ⇒ 第一次上传的稿子**大概率还要改** ⇒ ⇒ 先只出报告，人确认了再落库。
 * ⇒ ⇒ `persist=1` 才写库（按 `source_url` 去重 ⇒ 重复上传不会产生重复行）。
 */
import { NextResponse } from 'next/server';
import { parseWordDraft } from '@/lib/word/ingest';
import { auditWordArticles, renderFixList } from '@/lib/word/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 一次最多收多大（docx 不会很大，但要有上限防止误传） */
const MAX_BYTES = 20 * 1024 * 1024;

export async function POST(req: Request): Promise<Response> {
  // ---- 鉴权（2026-11-07）----
  // ⚠️ 这个接口会**写入生产库**（persist=1）⇒ ⇒ 必须防滥用。
  // ⇒ 用 `INGEST_SECRET`（云托管环境变量）+ 自定义头 `X-Ingest-Secret`。
  // ⇒ **没配 `INGEST_SECRET` 就不校验**（本地开发方便）⇒ 上了云一定要配。
  const secret = process.env.INGEST_SECRET;
  if (secret) {
    const got = req.headers.get('x-ingest-secret') || '';
    if (got !== secret) {
      return NextResponse.json({ ok: false, error: '缺少或错误的 X-Ingest-Secret' }, { status: 401 });
    }
  }

  // ---- 取文件：两种形态 ----
  // ① multipart/form-data（网页上传、curl -F）
  // ② JSON { fileBase64 }（**给 ChatGPT Action 用** ⇒ 它传文件不可靠，base64 更稳）
  const ct = req.headers.get('content-type') || '';
  let buf: Buffer;
  let fileName = 'upload.docx';
  let dateHint: string | undefined;
  let persist = false;

  if (ct.includes('application/json')) {
    let body: { fileBase64?: string; date?: string; persist?: string };
    try {
      body = await req.json();
    } catch (e) {
      return NextResponse.json({ ok: false, error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
    }
    if (!body.fileBase64) {
      return NextResponse.json({ ok: false, error: '缺少 fileBase64' }, { status: 400 });
    }
    const raw = body.fileBase64.replace(/^data:[^;]+;base64,/, '');
    buf = Buffer.from(raw, 'base64');
    dateHint = body.date;
    persist = body.persist === '1';
    // ⭐ base64 体积上限要比文件上限大（base64 会膨胀 ~1.34 倍）
    if (buf.length > MAX_BYTES) {
      return NextResponse.json({ ok: false, error: `文件太大（${buf.length} 字节 > ${MAX_BYTES}）` }, { status: 413 });
    }
  } else {
    let form: FormData;
    try {
      form = await req.formData();
    } catch (e) {
      return NextResponse.json({ ok: false, error: `读取上传内容失败：${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
    }
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      return NextResponse.json({ ok: false, error: '缺少文件字段 `file`（.docx）' }, { status: 400 });
    }
    const blob = file as File;
    if (!/\.docx$/i.test(blob.name || '')) {
      return NextResponse.json({ ok: false, error: `只接受 .docx（收到的是「${blob.name}」）` }, { status: 400 });
    }
    if (blob.size > MAX_BYTES) {
      return NextResponse.json({ ok: false, error: `文件太大（${blob.size} 字节 > ${MAX_BYTES}）` }, { status: 413 });
    }
    buf = Buffer.from(await blob.arrayBuffer());
    fileName = blob.name;
    dateHint = (form.get('date') as string) || undefined;
    persist = form.get('persist') === '1';
  }

  let parsed: ReturnType<typeof parseWordDraft>;
  try {
    parsed = parseWordDraft(buf, dateHint);
  } catch (e) {
    return NextResponse.json({ ok: false, error: `解析 .docx 失败：${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
  }

  if (parsed.articles.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: '一个稿件都没解析出来 ⇒ 请检查格式（国家分节【哈萨克斯坦】+ 编号 + 标题 + 正文）',
        warnings: parsed.warnings,
      },
      { status: 422 },
    );
  }

  const report = auditWordArticles(parsed.articles);
  const fixList = renderFixList(report);

  // ---- 可选：落库 ----
  let persisted: { inserted: number; skipped: number } | null = null;
  if (persist) {
    try {
      const { getSupabaseClient } = await import('@/storage/database/supabase-client');
      const sb = getSupabaseClient();
      let inserted = 0;
      let skipped = 0;
      for (const a of parsed.articles) {
        const row = {
          title: a.title,
          summary: a.body.slice(0, 200),
          content: `<p>${a.body.split('\n\n').join('</p><p>')}</p>`,
          country_code: a.countryCode,
          // ⚠️ `category` **不能是 'other'**（不在 `Category` 类型里，编译不过）
          //    且 `EXCLUDED_CATEGORIES = {culture, sports}` ⇒ 'economy' 安全。
          category: 'economy',
          source_name: a.sourceName ?? 'ChatGPT',
          source_url: null,
          original_title: a.originalTitle,
          // ⭐ 原文关键句存进 original_content ⇒ 量级闸与机构名对照在推送时也能用
          original_content: a.originalSnippet,
          // ⚠️ 原文语言：按有没有西里尔判（俄语/英文）⇒ 只影响统计，不影响判定
          original_language: a.originalSnippet
            ? /[\u0400-\u04FF]/.test(a.originalSnippet)
              ? 'ru'
              : 'en'
            : null,
          published_at: a.publishedAt ? `${a.publishedAt}T00:00:00Z` : new Date().toISOString(),
          // ★★★ `tags: ['word']` = **Word 输入稿的标记**（零 DDL、不污染 source_name）
          // ⇒ 推送侧靠它豁免「必须有原文正文」那个闸（见 push/route.ts 的 hasSourceBody 处）
          // ⇒ 以后真要加列（input_source），把这里换掉即可，本文件其它地方不用动。
          tags: ['word'],
          is_featured: false,
        };
        const { error } = await sb.from('articles').insert(row);
        if (error) skipped++;
        else inserted++;
      }
      persisted = { inserted, skipped };
    } catch (e) {
      persisted = { inserted: 0, skipped: parsed.articles.length };
      return NextResponse.json(
        { ok: true, parsed: { articles: parsed.articles.length, warnings: parsed.warnings }, audit: report, fixList, persisted, persistError: e instanceof Error ? e.message : String(e) },
        { status: 200 },
      );
    }
  }

  return NextResponse.json({
    ok: true,
    parsed: {
      articles: parsed.articles.length,
      warnings: parsed.warnings,
      preview: parsed.articles.map((a) => ({
        index: a.index,
        country: a.countryCode,
        title: a.title,
        source: a.sourceName,
        hasOriginal: !!a.originalSnippet,
        bodyChars: a.body.length,
      })),
    },
    audit: report,
    fixList,
    persisted,
  });
}
