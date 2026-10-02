/**
 * 原文正文补抓 —— RSS 只给标题时，去文章页把正文取回来。
 *
 * ## 为什么必须有这一层（2026-10-02 实测的根因）
 *
 * 实测 35 个信息源，用应用**同一个解析器**（`rss-parser`）量 `contentSnippet`：
 *
 * | 国家 | 完全没有正文的源 | 条目有正文比例 |
 * |---|---|---|
 * | 阿塞拜疆 | **5 / 8**：AZERTAC(en)、AZERTAC(ru)、Trend.az、APA、Qafqazinfo | **60 / 335 = 18%** |
 * | 乌兹别克斯坦 | 2 / 8：Uznews.uz、Podrobno.uz | 160 / 209 = 77% |
 * | 哈萨克斯坦 / 吉尔吉斯斯坦 / 塔吉克斯坦 | 0 | 100% |
 *
 * `fetch-news` 里 `originalContent = item.contentSnippet || item.content || ''`
 * 取到的就是那个空值，但翻译**照跑**。后果有两条，都很严重：
 *
 * 1. **正文是模型照标题编的。** 库里实存 `id 8766`（APA）写着
 *    「…阿塞拜疆政府尚未对贝森特的指责做出正式回应」—— 原文里根本没有这句；
 *    `id 8765` 同一句重复两遍；`id 8740` 结尾直接是标题的回声。
 * 2. **总审对这些稿子结构性失明。** `ReviewItem.originalExcerpt` 是空的 ⇒
 *    第七件事（与原文核对）没有可对照的原文。阿塞拜疆 `originalsSeen 4/15`
 *    就是这么来的 —— 与模型能力**无关**，换再强的模型也抓不到「这句是编的」，
 *    因为输入本来就是空的。
 *
 * ## 分工（本模块只做「取回 + 抽取」）
 *
 * 取回结果怎么用，由调用方决定：`fetch-news` 用真原文去翻译；
 * 取不到就**不入库**（宁可不推，也不推一段模型编出来的东西）。
 * 本模块**不写库、不调模型、不改全局状态**，所以可以离线用固定 HTML 回归。
 */

/**
 * 正文长度下限。低于它就认为「RSS 没给正文」。
 *
 * 两侧都用它，**必须同一个常量**：
 *   - 采集侧：`needsBodyFetch()` 决定要不要去抓页面；
 *   - 推送侧：`hasSourceBody()` 决定这条历史行还能不能推。
 *
 * 取 60 的依据：实测几个「正文短但真实」的源，`Inbusiness.kz` 中位 86、
 * `Total.kz` 91、`AKIpress` 97 —— 都在这条线之上。低于 60 字的「原文」
 * 既核对不出地名/数字，也撑不起一篇报道，那种稿子的中文正文必然是模型补的。
 */
export const MIN_SOURCE_BODY_CHARS = 60;

/** 存进 `original_content` 的正文上限。超过就截断 —— 提示词侧另有 `ORIGINAL_EXCERPT_MAX`。 */
export const BODY_MAX_CHARS = 6000;

export const BODY_FETCH_TIMEOUT_MS = 12_000;

/**
 * 单篇最多尝试几次。
 *
 * 为什么必须重试：2026-10-02 实测 `azertag.az` 由 **Cloudflare** 挡着，
 * 被挡时返回一个 5843 字节的 `Attention Required! | Cloudflare` 页面（HTTP 403），
 * 正文一个字都拿不到。做了对照实验：
 *
 *   - 换成浏览器 UA / 补 `Referer` / 补 `Accept-Language` → **完全没用**
 *     （同一轮里「裸头」拿 200、「浏览器头」拿 403）；
 *   - 间隔 2 秒连打 → 全 403；间隔 8 秒 → 时通时不通。
 *
 * 结论：这是**概率性的**，不是「请求头不对」。所以只能靠重试 + 拉长间隔。
 */
export const BODY_FETCH_ATTEMPTS = 3;

/**
 * 重试前等待的毫秒数（第 n 次重试等 `RETRY_DELAYS_MS[n-1]`）。
 *
 * ⚠️ 别把间隔调小。实测 600ms / 1200ms 这种「立刻再试」是**无效**的 ——
 * 3 次全撞在同一个封禁窗口里。8 秒左右才看得到复位的迹象。
 */
const BODY_RETRY_DELAYS_MS = [2_500, 7_000];

/**
 * 同一台站两次「抓正文」之间至少间隔多久（由调用方 sleep，模块本身不持有状态）。
 *
 * 存在的理由是上面那个 Cloudflare 窗口：一轮里连打同一台站的 26 个页面，
 * 中间不喘气的话后 20 个全是 403。1.2 秒 × 79 条约 95 秒，相对整轮可忽略。
 */
export const BODY_FETCH_GAP_MS = 1_200;

/** 单个页面最多读多少字节。防止撞上一个巨大的页面把内存和时间都吃掉。 */
export const BODY_FETCH_MAX_HTML = 800_000;

/**
 * 抓正文页用的 UA。
 *
 * 与 `feed-fetch.ts` 的首选 UA 一致：**如实说明自己是谁**（带仓库地址，便于站长联系），
 * 而不是伪装成浏览器。理由是 `feed-fetch.ts` 里那条实测教训 ——
 * 伪装浏览器反而两边都拿不到东西；如实说明则通常放行。
 */
export const BODY_FETCH_UA =
  'CentralAsiaNews/1.0 (+https://github.com/cedriczhou777/central-asia-news)';

// ---------------------------------------------------------------------------
// 一、HTML → 纯文本（纯函数，可离线测）
// ---------------------------------------------------------------------------

/** 具名实体表。只收常见的那批 —— 收不全时保留原样，比猜错好。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  hellip: '…', mdash: '—', ndash: '–', minus: '−', times: '×',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', frac12: '½',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
  bull: '•', middot: '·', dagger: '†', prime: '′', Prime: '″',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  auml: 'ä', ouml: 'ö', uuml: 'ü', ccedil: 'ç', ntilde: 'ñ', szlig: 'ß',
};

/** 解开 HTML 实体（具名 + 十进制 + 十六进制）。解不出来的原样保留。 */
export function decodeEntities(text: string): string {
  // `#[xX]?` 里的**大写 X 也要认**：HTML 标准的「数字字符引用」明确接受 `&#X42;`。
  // 写成 `#x?` 只匹配小写，`&#X42;` 就整条不匹配、原样留在正文里
  // （表现为正文里冒出 `&#X42;` 这种字面量，而下面的 hex 分支其实是写好的）。
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.charAt(0) === '#') {
      const isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const num = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isFinite(num) || num <= 0 || num > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(num);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body];
    if (named !== undefined) return named;
    // `&NBSP;` / `&Nbsp;` 这类大小写不规范的写法实测存在
    const lower = NAMED_ENTITIES[body.toLowerCase()];
    return lower === undefined ? whole : lower;
  });
}

/**
 * HTML 片段 → 纯文本。
 *
 * ⚠️ 顺序是**先剥标签、再解实体**，不能反。反过来的话，
 * 正文里本来写成 `&lt;div&gt;` 的字面示例会被当成真标签一起剥掉。
 *
 * ⚠️ 还要**先剥掉 script/style/iframe 这类「没有正文价值」的整块**（`stripNeverUseful`）。
 * 只剥标签是不够的：`<script>var a=1;</script>` 剥完标签会剩下 `var a=1;`，
 * 而这段 JS **会被算进长度**。后果是这条链自己最怕的那种：
 *   某个源把带 `<script>` 的 HTML 塞进 RSS 的 `content` ⇒ 长度虚高过 60
 *   ⇒ `needsBodyFetch` 认为「RSS 给了正文」不去补抓
 *   ⇒ `hasSourceBody` 也认它 ⇒ 于是**一段垃圾冒充原文进了库，还挡掉了本该补抓的路径**。
 * （本模块实测的失效方式全是这一类：不报错、只是答案错了。）
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    stripNeverUseful(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)\s*>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 一段文本「洗成纯文本之后」有多长。判空一律走这里，不要直接看原始长度。 */
export function sourceBodyLength(raw: string | null | undefined): number {
  return htmlToText(raw || '').length;
}

/** RSS 给的正文够不够；不够就该去抓页面。 */
export function needsBodyFetch(raw: string | null | undefined): boolean {
  return sourceBodyLength(raw) < MIN_SOURCE_BODY_CHARS;
}

/** 库里存的原文正文够不够；不够就不许推送（见 `article-format.hasSourceBody`）。 */
export function hasSourceBody(raw: string | null | undefined): boolean {
  return sourceBodyLength(raw) >= MIN_SOURCE_BODY_CHARS;
}

// ---------------------------------------------------------------------------
// 二、从页面里抽正文
// ---------------------------------------------------------------------------

export type BodyVia = 'jsonld' | 'container' | 'paragraphs';

export interface ExtractedBody {
  text: string;
  via: BodyVia;
  /** 抽取到的段落数。用来判断「是不是只抓到一段导航」 */
  paragraphs: number;
}

/**
 * 永远没有正文价值的块：脚本、样式、表单、图标。
 * 这一类**任何路径**都要先剥掉。
 *
 * 两处调用，作用不同、都要留：
 *   - `htmlToText()` 里 —— 保证**长度与段落**不含 JS/CSS 文本（见该函数的 ⚠️）；
 *   - `extractBodyFromHtml()` 里 —— 保证**容器扫描**不会把 `<script>` 里的
 *     字符串当成页面结构。
 * （声明在使用点之后是刻意的：函数声明会提升，而且这样读起来是先讲文本、再讲块。）
 */
function stripNeverUseful(html: string): string {
  return html.replace(
    /<(script|style|noscript|iframe|svg|form|template|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    ' ',
  );
}

/**
 * 页面外框：导航、页眉、页脚、侧栏。
 *
 * ⚠️ **只在「整页段落」这条兜底路径上剥**，容器路径上不剥 ——
 * 很多站点把标题和导语放在 `<article>` 内部的 `<header>` 里，全局剥掉会把导语一起吃掉。
 */
function stripChrome(html: string): string {
  return html.replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
}

/**
 * 从 `openTagEnd` 开始，切出 `<tag>` 的**完整配对区间**（含嵌套）。
 *
 * 为什么不能用 `/<article[^>]*>([\s\S]*?)<\/article>/`：非贪婪遇上嵌套的同名标签
 * 会在**第一个**内层闭合标签处停下，正文被腰斩。而正文的**后半段**恰恰是
 * 关键信息所在 —— 2026-10-01 用户报的那条「电站位于贾拉拉巴德州纳伦河上」
 * 就是全文最后一段。腰斩的正文等于没有正文。
 */
function sliceBalanced(html: string, openTagEnd: number, tag: string): string | null {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = openTagEnd;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1] === '/') {
      depth -= 1;
      if (depth === 0) return html.slice(openTagEnd, m.index);
    } else if (!/\/>\s*$/.test(m[0])) {
      depth += 1;
    }
    // 防御：一个未闭合的容器会让 lastIndex 一路扫到文末，代价只是慢一次
    if (re.lastIndex > html.length) break;
  }
  return null;
}

/** 属性里出现了这些词，就认为这个容器装的是正文。 */
const BODY_ATTR_HINT =
  /(?:itemprop\s*=\s*["']articleBody["']|(?:class|id)\s*=\s*["'][^"']*(?:article[-_]?body|article[-_]?content|article[-_]?text|post[-_]?content|entry[-_]?content|news[-_]?(?:text|body|content)|story[-_]?body|content[-_]?body|main[-_]?content|single[-_]?content|detail[-_]?content|text[-_]?content)[^"']*["'])/i;

/** 页面里所有「像正文容器」的块。`<article>` 无条件收。 */
function findBodyContainers(html: string): string[] {
  const found: string[] = [];
  for (const tag of ['article', 'div', 'section', 'main']) {
    const openRe = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = openRe.exec(html)) !== null) {
      const attrs = m[1] || '';
      if (tag !== 'article' && !BODY_ATTR_HINT.test(attrs)) continue;
      const inner = sliceBalanced(html, m.index + m[0].length, tag);
      if (inner) found.push(inner);
      // 同一个容器不会被两条规则重复收；`openRe` 只前进一步，嵌套的会各自被扫到
    }
  }
  return found;
}

/**
 * 抽段落。
 *
 * 先看 `<p>`；一段 `<p>` 都没有的站点（有，但不常见）就按换行切 ——
 * 那种站点的正文通常是一长串 `<div>` 或裸文本。
 */
function paragraphsOf(scope: string): string[] {
  const out: string[] = [];
  const pRe = /<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(scope)) !== null) {
    const text = htmlToText(m[1]);
    if (text) out.push(text);
  }
  if (out.length > 0) return out;

  return htmlToText(scope)
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 太短的段落多半是导航/按钮/日期条，不是正文句子。
 * 8 是刻意取小的：`2026 年 10 月 1 日` 这种短段里带着日期，丢了可惜。
 */
const MIN_PARAGRAPH_CHARS = 8;

function cleanParagraphs(list: string[]): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const raw of list) {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text.length < MIN_PARAGRAPH_CHARS) continue;
    // 逐字重复的段落 → 是模板（相关阅读、订阅提示），**只留第一次出现**
    // （判定是「出现过就丢」，不是「出现三次以上才丢」—— 正文被复制两遍的
    //  情况实测有：`id 8765` 同一句连着出现两次）
    const n = (seen.get(text) || 0) + 1;
    seen.set(text, n);
    if (n > 1) continue;
    out.push(text);
  }
  return out;
}

/**
 * 从 `<script type="application/ld+json">` 里挖 `articleBody`。
 *
 * ⚠️ 入参必须是**没剥过 `<script>` 的原始 HTML** —— 见 `extractBodyFromHtml` 里的说明。
 */
function extractJsonLd(html: string): string | null {
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = (m[1] || '').trim();
    if (!raw) continue;
    // 结构化数据经常带尾逗号/注释，`JSON.parse` 会挂 —— 所以先用正则兜一层
    const direct = /"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/i.exec(raw);
    if (direct) {
      try {
        const text = JSON.parse(`"${direct[1]}"`) as string;
        if (text && text.trim()) return text.trim();
      } catch {
        if (direct[1].trim()) return direct[1].trim();
      }
    }
  }
  return null;
}

/**
 * 从一个 HTML 页面里抽出正文。
 *
 * 三级降级，**顺序不能换**：
 *   1. `jsonld` —— 站点自己声明的 `articleBody`，最准；
 *   2. `container` —— 挑「像正文容器」里 `<p>` 文本最多的那个块；
 *   3. `paragraphs` —— 整页 `<p>` 兜底（此时会先剥掉导航/页眉/页脚/侧栏）。
 *
 * 抽不到（或只有导航）就返回 `null` —— **不要返回半截垃圾**。
 * 调用方按「拿不到就不入库」处理；返回垃圾会让它当成真原文存进库，
 * 那比没有更糟：总审会拿它去「核对」，然后得出一个错的结论。
 */
export function extractBodyFromHtml(html: string): ExtractedBody | null {
  if (!html || html.length < 200) return null;

  // ⚠️ JSON-LD 必须在 `stripNeverUseful()` **之前**读 —— **它就是一段 `<script>`**，
  // 剥完就没了。2026-10-02 的离线回归就是在这一步抓到这条的：
  // `extractJsonLd(cleaned)` 恒为 null，于是第一级降级从来没生效过
  // （`via` 只会是 container / paragraphs），而且**完全不报错** ——
  // 只看线上日志是「容器路径工作正常」，看不出最准的那条路是死的。
  const jsonld = extractJsonLd(html);

  const cleaned = stripNeverUseful(html);

  if (jsonld) {
    const paras = cleanParagraphs(
      jsonld.split(/\n{2,}/).flatMap((s) => s.split(/(?<=[.!?。！？])\s+(?=\S)/)),
    );
    const text = (paras.length > 0 ? paras : [jsonld]).join('\n\n').slice(0, BODY_MAX_CHARS);
    if (text.length >= MIN_SOURCE_BODY_CHARS) {
      return { text, via: 'jsonld', paragraphs: paras.length || 1 };
    }
  }

  let best: { text: string; n: number } | null = null;
  for (const container of findBodyContainers(cleaned)) {
    const paras = cleanParagraphs(paragraphsOf(container));
    if (paras.length === 0) continue;
    const text = paras.join('\n\n');
    if (!best || text.length > best.text.length) best = { text, n: paras.length };
  }
  if (best && best.text.length >= MIN_SOURCE_BODY_CHARS) {
    return { text: best.text.slice(0, BODY_MAX_CHARS), via: 'container', paragraphs: best.n };
  }

  const paras = cleanParagraphs(paragraphsOf(stripChrome(cleaned)));
  const text = paras.join('\n\n');
  if (text.length >= MIN_SOURCE_BODY_CHARS) {
    return { text: text.slice(0, BODY_MAX_CHARS), via: 'paragraphs', paragraphs: paras.length };
  }

  return null;
}

// ---------------------------------------------------------------------------
// 三、取回
// ---------------------------------------------------------------------------

export interface BodyFetchOk {
  ok: true;
  text: string;
  chars: number;
  via: BodyVia;
  paragraphs: number;
}

export interface BodyFetchFail {
  ok: false;
  /** 人类可读的失败原因，直接进日志/漏斗。 */
  reason: string;
}

export type BodyFetchOutcome = BodyFetchOk | BodyFetchFail;

/**
 * 抓一个文章页并抽出正文。
 *
 * **永不抛异常**：所有失败都折成 `{ ok: false, reason }`。
 * 调用方在采集主循环里，那边已经有 `try/catch` 兜底，但一次页面抓取失败
 * 不该被记成「这个源坏了」—— 两件事的可归因性完全不同。
 *
 * 「拿到页面但抽不出正文」**不重试**：同一个页面换个时间抓，DOM 不会变。
 * 只有「没拿到页面」（非 2xx / 超时 / 网络错）才重试。
 */
export async function fetchArticleBody(url: string): Promise<BodyFetchOutcome> {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return { ok: false, reason: '链接不是 http(s)' };
  }

  let lastReason = '未尝试';
  for (let attempt = 1; attempt <= BODY_FETCH_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const wait = BODY_RETRY_DELAYS_MS[Math.min(attempt - 2, BODY_RETRY_DELAYS_MS.length - 1)];
      await new Promise((r) => setTimeout(r, wait));
    }

    let html = '';
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': BODY_FETCH_UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'ru,en;q=0.8,az;q=0.7,kk;q=0.6,ky;q=0.5',
        },
        signal: AbortSignal.timeout(BODY_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        lastReason = `HTTP ${res.status}`;
        continue; // 403 / 429 / 5xx 都值得再试
      }
      const contentType = res.headers.get('content-type') || '';
      if (contentType && !/html|xml|text\/plain/i.test(contentType)) {
        return { ok: false, reason: `不是网页（${contentType}）` };
      }
      html = (await res.text()).slice(0, BODY_FETCH_MAX_HTML);
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      const msg = err instanceof Error ? err.message : String(err);
      lastReason = name === 'TimeoutError' ? `超时 ${BODY_FETCH_TIMEOUT_MS}ms` : `取回失败：${msg}`;
      continue;
    }

    const extracted = extractBodyFromHtml(html);
    if (!extracted) {
      // 页面拿到了、只是抽不出正文 —— 重试没有意义，直接定论
      return { ok: false, reason: `页面里抽不出正文（${html.length} 字节）` };
    }
    return {
      ok: true,
      text: extracted.text,
      chars: extracted.text.length,
      via: extracted.via,
      paragraphs: extracted.paragraphs,
    };
  }

  return { ok: false, reason: `${BODY_FETCH_ATTEMPTS} 次都没拿到：${lastReason}` };
}
