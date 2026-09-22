/**
 * Cloudflare Worker：Telegram 公开频道 → 本项目 API 接口契约的"转发桥"
 *
 * 方案背景
 * ----------
 * 本项目部署在微信云托管（大陆服务器），`t.me` / `api.telegram.org` 不可达。
 * 因此由本 Worker（运行在 Cloudflare 境外边缘节点）就近访问 Telegram 的
 * 公开网页预览 t.me/s/<channel>，解析出最近消息并以 JSON 返回给本项目。
 *
 * 优点
 * ----
 * 1. 读取的是【公开频道】的网页预览，无需 Telegram Bot Token，也无需把 Bot
 *    加进频道当管理员。
 * 2. 完全免费（Cloudflare Workers 免费版每日 10 万次请求），本项目每天抓几个
 *    频道远不会触及上限。
 * 3. Worker 在境外，可自由访问 t.me；本项目（大陆）只需访问本 Worker 域名。
 *
 * 部署
 * ----
 * 1. 登录 Cloudflare Dashboard → Workers & Pages → Create application → Worker。
 * 2. 把本文件内容整体粘贴到 worker.js，Save and Deploy。
 * 3. ⚠️ **必须再给这个 Worker 绑一个自有域名**（Settings > Domains & Routes > Add > Custom Domain），
 *    然后把该域名填入微信云托管环境变量 TELEGRAM_WORKER_URL。
 *
 *    为什么不能直接用 `.workers.dev`（2026-09-22 实测）：微信云托管跑在大陆网络，
 *    **访问不了 `*.workers.dev`**，12 个频道全部 `fetch failed`（连接层就没通，252–274ms 快速失败）。
 *    而同一个容器**能正常抓通其它 Cloudflare 后面的站点**（astanatimes.com / apa.az / total.kz …），
 *    所以换域名即可，**不是 Cloudflare 网络不可达，改频道名也没用**。
 *    绑域名需要该域名已把 NS 交给 Cloudflare（active zone），且该 hostname 上没有已存在的 CNAME。
 *    详见项目 AGENTS.md「信息源与社交网络」一节。
 * 4. 验证要走**容器视角**，别看浏览器：
 *    `curl -s "$BASE/api/telegram-check"` → `okCount` 应为 12、`egressControl.ok` 为 true。
 *
 * 接口契约（与本项目 src/lib/scraper.ts 的 fetchTelegramByWorker 严格一致）
 * ----------
 * 请求:  GET  https://<你绑的自有域名>/?channel=<频道名，带 @>
 * 返回:  { "posts": [ { "title": "...", "url": "...", "date": "ISO或时间戳", "summary": "..." } ] }
 *
 * 测试:  curl -sS -m 25 'https://<你绑的自有域名>/?channel=%40tengrinews'
 *        → 应返回真实帖子；裸打根路径会返回 {"error":"missing or invalid ?channel=@name"}
 *        应看到 {"posts": [...]}，而不是 Telegram 网页文档。
 */

// t.me/s/<channel> 的单条消息正则。每条消息块形如：
//   <div class="tgme_widget_message" data-post="channel/123">
//     <div class="tgme_widget_message_text js-message_text" dir="auto">正文...</div>
//     <time class="time" datetime="2024-01-01T10:00:00+00:00">...</time>
//     <a class="tgme_widget_message_date" href="https://t.me/channel/123">...</a>
//   </div>
const MESSAGE_BLOCK =
  /<div class="tgme_widget_message"[^>]*data-post="[^"]+"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g;

function extractText(raw) {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTelegramChannelHtml(html, channel) {
  const posts = [];
  const blocks = html.match(MESSAGE_BLOCK) || [];

  for (const block of blocks) {
    const postMatch = block.match(/data-post="([^"]+)"/);
    // 正文节点优先取 js-message_text，兜底取整个文本
    const textNode = block.match(
      /<div class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/
    );
    const title = extractText(textNode ? textNode[1] : block);
    if (!title) continue;

    const dateMatch = block.match(/datetime="([^"]+)"/);
    const date = dateMatch ? dateMatch[1] : null;

    const id = postMatch ? postMatch[1] : null; // 形如 channel/123
    const m = id ? id.split('/') : null;
    const msgId = m && m.length >= 2 ? m[1] : '';

    posts.push({
      title,
      url: `https://t.me/${channel}/${msgId}`,
      date,
      summary: title,
    });
  }

  return posts;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const channel = (url.searchParams.get('channel') || '').replace(/^@/, '').trim();

    if (!channel) {
      return json({ error: 'missing `channel` query param' }, 400);
    }

    try {
      const target = `https://t.me/s/${channel}`;
      const res = await fetch(target, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TelegramProxy/1.0)' },
      });
      if (!res.ok) {
        return json({ error: `t.me/s/${channel} -> HTTP ${res.status}` }, res.status);
      }
      const html = await res.text();
      const posts = parseTelegramChannelHtml(html, channel);
      return json({ posts });
    } catch (err) {
      return json({ error: err && err.message ? err.message : String(err) }, 500);
    }
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}