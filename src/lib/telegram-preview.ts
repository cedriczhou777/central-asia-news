/**
 * Telegram 频道**直连**抓取（2026-10-25 加）。
 *
 * ## 为什么要有它
 *
 * 原来的兜底链是「Worker → RSSHub 公共实例」，而：
 * · Worker 在 `*.workers.dev` 上 ⇒ **微信云托管在大陆连不到**（实测 12 个频道全挂）；
 * · `rsshub.app` / `rss.shab.fun` 公共实例**在大陆同样不可达** ⇒ 兜底也不成立。
 * ⇒ 于是 12 个频道（占配置源的 34%）**一条都进不来**。
 *
 * ⭐ 而 Worker 做的事其实很简单：**抓 `t.me/s/<频道>` 的公开预览页**、解析出消息列表。
 * ⇒ **容器自己也能做同一件事** —— 前提是**容器能直连 t.me**。
 * ⇒ 这条路不需要域名、不需要 Cloudflare、不需要任何新凭据。
 *
 * ## 为什么要与 Worker 的实现保持一致
 *
 * 解析逻辑（`parsePreview`）**与 `telegram-worker/worker.js` 里那份逐字相同**
 * ⇒ 两边的产出形状一致 ⇒ 后面「翻译 / 去重 / 入库」那条链完全不用改。
 * ⚠️ **两边必须一起改** —— 见 `scripts/test-telegram-direct.ts` 里那条
 * 「Worker 与直连的解析规则一致」的断言。
 */

/** 预览页要带浏览器 UA 才给完整内容（与 Worker 一致）。 */
const PREVIEW_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface TelegramPreviewPost {
  title: string;
  url: string;
  date: string | null;
  summary: string;
}

/**
 * 解析 `t.me/s/<频道>` 预览页。
 *
 * ⚠️ 与 `telegram-worker/worker.js` 的 `parsePreview` **逐字一致**（改一处就要改另一处）。
 */
export function parseTelegramPreview(html: string): TelegramPreviewPost[] {
  const posts: TelegramPreviewPost[] = [];
  // 每条消息是一个 <div class="tgme_widget_message ..."> 块，按块切分再逐个解析
  const blocks = html.split('<div class="tgme_widget_message ').slice(1);

  for (const block of blocks) {
    // 消息 permalink：data-post="channel/12345"
    const postMatch = block.match(/data-post="[^/]+\/(\d+)"/);
    if (!postMatch) continue;

    // 时间：<time datetime="2026-09-19T18:00:00+00:00">
    const timeMatch = block.match(/<time[^>]+datetime="([^"]+)"/);

    // 正文：<div class="tgme_widget_message_text ...">...</div>
    const textMatch = block.match(
      /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    );
    if (!textMatch) continue; // 纯图片/贴纸消息没有文本，跳过

    const text = decodeEntities(textMatch[1])
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{2,}/g, '\n')
      .trim();
    if (!text) continue;

    const channelName = (block.match(/data-post="([^/]+)\//) || [])[1] || '';
    const permalink = `https://t.me/${channelName}/${postMatch[1]}`;

    posts.push({
      // 标题取正文第一行（Telegram 消息没有标题），截到 120 字符
      title: (text.split('\n')[0] || '').slice(0, 120),
      url: permalink,
      date: timeMatch ? timeMatch[1] : null,
      // 摘要给前 400 字符，够 LLM 判断相关性用
      summary: text.slice(0, 400),
    });
  }

  return posts;
}

/** 极简 HTML 实体解码（预览页常见 &amp; &quot; &#39; &lt; &gt; &nbsp;） */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

/**
 * 直连抓一个频道的预览页。
 *
 * @param channelId 频道名（可带 `@`）
 * @param timeoutMs 超时（默认 12 秒）
 */
export async function fetchTelegramPreviewDirect(
  channelId: string,
  timeoutMs = 12_000,
): Promise<{ posts: TelegramPreviewPost[]; error: string | null; status: number | null; latencyMs: number }> {
  const id = channelId.startsWith('@') ? channelId.slice(1) : channelId;
  const url = `https://t.me/s/${encodeURIComponent(id)}`;
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': PREVIEW_UA, 'Accept-Language': 'en,ru;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return {
        posts: [],
        error: `t.me 返回 ${res.status}`,
        status: res.status,
        latencyMs: Date.now() - startedAt,
      };
    }
    const html = await res.text();
    const posts = parseTelegramPreview(html);
    return { posts, error: null, status: res.status, latencyMs: Date.now() - startedAt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { posts: [], error: message, status: null, latencyMs: Date.now() - startedAt };
  }
}
