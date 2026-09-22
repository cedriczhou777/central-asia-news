import Parser from 'rss-parser';

/** rss-parser 解析出来的 feed 结构（各源的私有字段会挂在 item 上）。 */
export type ParsedFeed = Parser.Output<Record<string, unknown>>;

/**
 * 单条条目。
 *
 * 导出是为了让调用方**不必自己 `import Parser` 只为拿一个类型** ——
 * 之前 `fetch-news/route.ts` 的 `Candidate.item` 写的就是 `Parser.Item`，
 * 于是取回逻辑虽然搬走了，route 仍得留着 rss-parser 的 import，
 * 「别再在别处 new Parser」这条纪律就守不住（import 在，手就容易滑）。
 */
export type FeedItem = Parser.Item;

/**
 * RSS/Atom 取回层 —— **唯一目的是把「拿到的是网页而不是 feed」变成一眼可见的错误。**
 *
 * ## 为什么单独抽这一层（一次被误诊了整整一轮的线上失效）
 *
 * 2026-09-22 查「26 个源里 16 个失败」时，`kg.akipress.org/rss` 与 `tazabek.kg/rss`
 * 在容器里报的是：
 *
 * ```
 * RSS 解析失败：Unexpected close tag
 * Line: 38
 * Column: 7
 * Char: >
 * ```
 *
 * 于是 AGENTS.md 把它记成「**XML 畸形**，rss-parser 直接放弃整个源」。
 * **那个归因是错的。**
 *
 * 真实原因：这两个站点**按 User-Agent 决定返回什么** ——
 * 认得的 feed 阅读器 UA 给真 XML，其它一律给 **SPA 首页 HTML**。
 * 而首页 HTML 恰好能通过 xml2js 的前几十行，然后在第 38 行撞上一个不闭合的标签，
 * 抛出那句**和「XML 畸形」长得一模一样**的错误。两个不同站点的报错位置还完全相同
 * （`Line: 38 Column: 7`）—— 这个「巧合」本身就是「它们给的是同一套模板」的线索，
 * 当时没往这个方向看。
 *
 * 实测（同一 URL、同一时刻，**只改 UA**）：
 *
 * | User-Agent | tazabek.kg/rss | kg.akipress.org/rss |
 * |---|---|---|
 * | `CentralAsiaNewsBot/1.0`（**改之前线上用的**） | HTML 8350B，**0 条** | HTML 8517B，**0 条** |
 * | `CentralAsiaNews/1.0 (+https://…)`（现在的首选） | **XML 21222B，30 条** | **XML 18903B，30 条** |
 * | `rss-parser`（库默认，现在的兜底） | XML，30 条 | XML，30 条 |
 * | `Mozilla/5.0` | HTML，0 条 | HTML，0 条 |
 *
 * 5 轮重复、每轮三个 UA 交错，结果 **5/5 完全一致** ⇒ 不是 CDN 缓存噪声，规则是稳定的。
 * ⇒ **我们那个「礼貌的」自定义 UA，正是把这两个源搞死的原因。**
 * 顺带否掉一个反方向的错误修法：伪装成浏览器（`Mozilla/5.0`）**同样拿不到 feed**。
 *
 * ## 这一层做的三件事
 *
 * 1. **按序试多个 UA**（见 `FEED_USER_AGENTS`），第一个「不是网页」的就用。
 * 2. **拿到 `text/html` 就明确报出来**（`FeedFetchError`，消息里带 Content-Type 与正文开头），
 *    绝不再让 xml2js 抛那句话把人带偏。
 *    ⚠️ **这条才是本次真正要修的东西**：站点怎么变我们控制不了，
 *    「我们能看出来」才是可控的部分 —— 上次的代价是 AGENTS.md 里写错了一条根因。
 * 3. **自己设超时、并让 gzip 生效。** `fetch`（undici）默认接受 gzip 并自动解压，
 *    而 rss-parser 的 `parseURL` 走 Node http、**不带 `Accept-Encoding`**。
 *    实测 `inbusiness.kz/rss` 明文 **641939B** → gzip **154014B**（小 4.2 倍），
 *    这正是它之前 `Request timed out after 30000ms` 的原因 —— 而且这一条不需要改代码逻辑，
 *    换个取回方式就白拿了。
 *
 * ## 用法
 *
 * ```ts
 * const { feed, meta } = await fetchFeed(source.url);
 * console.log(meta.contentType, meta.bytes, meta.usedUa); // 排查时看这三个
 * ```
 */

/**
 * 单源超时。
 *
 * 默认 **60s**（2026-09-22 由 rss-parser 的 30s 提到这里）：
 * 中亚源里存在 600KB 级的 feed，大陆→中亚的链路上 30s 不够用，
 * 表现为「源超时」而不是「源坏了」—— 两者修法完全不同，别混。
 * 可用 `RSS_TIMEOUT_MS` 覆盖（改这里同时给文档留了痕）。
 */
export const FEED_TIMEOUT_MS = (() => {
  const raw = Number(process.env.RSS_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60000;
})();

/**
 * 依次尝试的 UA。
 *
 * ⚠️ **别改成 `...Bot/...` 或者 `Mozilla/5.0`**：前者实测被 tazabek.kg / kg.akipress.org
 * 判定为非 feed 客户端而返回网页，后者**两边都**拿不到 feed（见文件头对照表）。
 * 要改就先跑 `pnpm analyze:feed-check`，它会把每个源的 Content-Type 和条数打出来。
 *
 * 首选是**如实说明自己是谁**的 UA（带仓库地址，便于对方站长联系/放行），
 * 兜底用 rss-parser 的库默认 UA —— 两条都实测可用，且互为「另一类写法」。
 */
export const FEED_USER_AGENTS = [
  'CentralAsiaNews/1.0 (+https://github.com/cedriczhou777/central-asia-news)',
  'rss-parser',
];

const parser = new Parser({ timeout: FEED_TIMEOUT_MS });

/** 一次尝试的记录。失败排查时按 `attempts` 逐条看。 */
export interface FeedAttempt {
  ua: string;
  status: number;
  contentType: string;
  bytes: number;
  ms: number;
  /** 只在「请求根本没发出去/没回来」时有值（超时、DNS、TLS）。 */
  error?: string;
}

export interface FeedMeta {
  url: string;
  status: number;
  contentType: string;
  bytes: number;
  ms: number;
  /** 最终采用的 UA（失败时为最后一次尝试的）。 */
  usedUa: string;
  attempts: FeedAttempt[];
}

export class FeedFetchError extends Error {
  readonly meta: FeedMeta;

  constructor(message: string, meta: FeedMeta) {
    super(message);
    this.name = 'FeedFetchError';
    this.meta = meta;
  }
}

/**
 * 正文/Content-Type 是不是「网页」。
 *
 * 刻意**同时看头和正文**：有站点把 Content-Type 谎报成 `application/xml`、
 * 或者干脆不给，只靠 Content-Type 会漏判；也有站点返回的是 XHTML 片段，
 * 光看 `<!doctype` 会漏。导出是为了能被离线回归钉住
 * （`scripts/test-feed-fetch.ts`，用真实抓下来的两份首页 HTML 当语料）。
 */
export function looksLikeHtml(contentType: string, body: string): boolean {
  if (/text\/html/i.test(contentType)) return true;
  const head = body.slice(0, 300).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

/**
 * 「这不是一个 feed」的人话原因；正常 feed 返回 `null`。
 *
 * 导出是为了可离线测试 —— 这个函数是整套诊断的核心，它错了就等于没有诊断。
 */
export function notFeedReason(status: number, contentType: string, body: string): string | null {
  if (status < 200 || status >= 300) return `HTTP ${status}`;
  if (looksLikeHtml(contentType, body)) {
    const head = body.slice(0, 60).replace(/\s+/g, ' ').trim();
    return `返回的是网页而不是 feed（Content-Type: ${contentType || '空'}；开头：${head}…）`;
  }
  if (body.trim().length === 0) return '响应正文为空';
  return null;
}

/**
 * 把 fetch 抛出的东西翻译成人话。
 *
 * ⚠️ 必须有兜底：`AbortSignal.timeout` 抛的是 `TimeoutError`（**`message` 常常是空的**），
 * 网络层抛的又常常只有 `cause`/`code`。直接 `err.message` 会得到空字符串 ——
 * 线上 `Asia-Plus` 当时报的就是 `RSS 解析失败：` 后面什么都没有，等于没报。
 */
export function describeFetchError(err: unknown, timeoutMs: number): string {
  const e = err as { name?: string; message?: string; code?: string; cause?: unknown };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `超时（>${timeoutMs}ms）`;
  const cause = e?.cause as { code?: string; message?: string } | undefined;
  const code = cause?.code || e?.code;
  const parts = [e?.name, e?.message || cause?.message, code].filter(Boolean);
  return parts.length ? parts.join(' / ') : String(err);
}

/** 把多次尝试压成一行可读的结论（写进 `sourceErrors` 让人一眼定性）。 */
function summarize(meta: FeedMeta, timeoutMs: number): string {
  const lines = meta.attempts.map((a) => {
    const where = a.error ? a.error : `${a.status} ${a.contentType || '(无 CT)'} ${a.bytes}B`;
    return `UA「${a.ua}」→ ${where}`;
  });
  const reason = meta.attempts.find((a) => !a.error);
  const verdict = reason
    ? notFeedReason(meta.status, meta.contentType, '') ?? `拿到了 ${meta.contentType || '未知类型'}`
    : `请求未成功（超时 ${timeoutMs}ms）`;
  return `${verdict}\n    尝试记录：${lines.join('；')}`;
}

/**
 * 取回并解析一个 feed。
 *
 * 拿到「网页」时会**换 UA 重试一次**（只有这一种情况重试 ——
 * HTTP 4xx/5xx、超时、空正文都直接定论，不重复打对方站点）。
 */
export async function fetchFeed(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ feed: ParsedFeed; meta: FeedMeta }> {
  const timeoutMs = opts.timeoutMs ?? FEED_TIMEOUT_MS;
  const attempts: FeedAttempt[] = [];

  for (let i = 0; i < FEED_USER_AGENTS.length; i++) {
    const ua = FEED_USER_AGENTS[i];
    const started = Date.now();

    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': ua,
          Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const ms = Date.now() - started;
      attempts.push({ ua, status: 0, contentType: '', bytes: 0, ms, error: describeFetchError(err, timeoutMs) });
      const meta: FeedMeta = { url, status: 0, contentType: '', bytes: 0, ms, usedUa: ua, attempts };
      // 请求层面就没通 —— 换 UA 没有意义（对方都没答话）。
      throw new FeedFetchError(summarize(meta, timeoutMs), meta);
    }

    const body = await res.text().catch(() => '');
    const contentType = res.headers.get('content-type') || '';
    const ms = Date.now() - started;
    attempts.push({ ua, status: res.status, contentType, bytes: body.length, ms });
    const meta: FeedMeta = { url, status: res.status, contentType, bytes: body.length, ms, usedUa: ua, attempts };

    const reason = notFeedReason(res.status, contentType, body);

    if (reason && looksLikeHtml(contentType, body) && i < FEED_USER_AGENTS.length - 1) {
      // 只有「拿到网页」这一种情况值得换 UA 再试一次：它是**客户端身份**问题，换身份可能就对了。
      continue;
    }

    if (reason) throw new FeedFetchError(summarize(meta, timeoutMs), meta);

    try {
      const feed = (await parser.parseString(body)) as ParsedFeed;
      return { feed, meta };
    } catch (err) {
      // 走到这里说明 Content-Type 和开头都不像网页，但 XML 确实解析不了 —— 这才是真·畸形 XML。
      const detail = err instanceof Error ? err.message : String(err);
      throw new FeedFetchError(`XML 畸形：${detail.replace(/\s+/g, ' ').slice(0, 160)}`, meta);
    }
  }

  // 理论到不了：上一个循环最后一次迭代一定会 throw。
  const meta: FeedMeta = { url, status: 0, contentType: '', bytes: 0, ms: 0, usedUa: '', attempts };
  throw new FeedFetchError('所有 UA 尝试均未拿到 feed', meta);
}
