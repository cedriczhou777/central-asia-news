/**
 * Telegram 频道桥 —— Cloudflare Worker
 *
 * 作用：微信云托管在大陆网络里连不上 t.me / api.telegram.org，
 * 但 Cloudflare Workers（境外边缘节点）可以。这个 Worker 站在中间当转发桥：
 *
 *   微信云托管  ──GET /?channel=@tengrinews──▶  本 Worker  ──▶  t.me/s/<频道>
 *                                                        ◀──  公开预览 HTML
 *   微信云托管  ◀──── { posts: [{title, url, date, summary}] } ────┘
 *
 * 为什么用 t.me/s/<频道> 公开预览而不是 Bot API：**不需要 Bot Token、不需要把频道
 * 拉进群**，任何公开频道都能读。限制：只能拿到预览页上的最近 ~20 条消息。
 *
 * 部署（约 5 分钟，免费额度足够）：
 *   1. 注册/登录 https://dash.cloudflare.com → Workers & Pages → Create Worker
 *   2. 把本文件内容整个贴进在线编辑器 → Deploy
 *   3. 记下分配的地址，形如 https://xxx.yyy.workers.dev
 *   4. 在微信云托管控制台给服务加环境变量：
 *        TELEGRAM_WORKER_URL = https://xxx.yyy.workers.dev
 *   5. （可选）TELEGRAM_CHANNELS 覆盖默认频道表，格式见 src/lib/telegram-channels.ts
 *
 * 本地验证（部署后）：
 *   curl "https://xxx.yyy.workers.dev/?channel=@tengrinews"
 *   → 应返回 {"posts":[{"title":"...","url":"https://t.me/tengrinews/12345","date":...}]}
 *
 * 返回结构刻意对齐 src/lib/scraper.ts 的 fetchTelegramByWorker 期望的形状。
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // 简单的防滥用：只允许 GET，只认 channel 参数
    if (request.method !== 'GET') {
      return json({ error: 'method not allowed' }, 405);
    }

    const channel = (url.searchParams.get('channel') || '').trim();
    if (!channel || !/^@?[A-Za-z0-9_]{4,64}$/.test(channel)) {
      return json({ error: 'missing or invalid ?channel=@name' }, 400);
    }
    const id = channel.startsWith('@') ? channel.slice(1) : channel;

    try {
      // 带 UA 才能拿到 t.me 的完整预览页；_preference 控制返回条数档位
      const res = await fetch(`https://t.me/s/${encodeURIComponent(id)}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en,ru;q=0.8',
        },
        redirect: 'follow',
      });

      if (!res.ok) {
        return json({ error: `t.me returned ${res.status}`, posts: [] }, 200);
      }

      const html = await res.text();
      return json({ posts: parsePreview(html) }, 200);
    } catch (err) {
      return json({ error: String(err), posts: [] }, 200);
    }
  },
};

/** 解析 t.me/s/<channel> 预览页，抽出每条消息的文本/链接/时间 */
function parsePreview(html) {
  const posts = [];
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
      /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/
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
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // 抓取端自己控制频率，禁缓存避免读到旧消息
      'Cache-Control': 'no-store',
    },
  });
}
