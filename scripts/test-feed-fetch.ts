/**
 * `src/lib/feed-fetch.ts` 的离线回归 —— **不联网**。
 *
 * ## 为什么必须钉这一个
 *
 * 这套诊断的全部价值就是「**拿到网页时要能看出来**」。它一旦失效，
 * 失效方式是**静默**的：xml2js 抛一句 `Unexpected close tag`，
 * 看起来像「XML 畸形」，于是人就会去查对方的 feed —— 而对方没坏。
 * 2026-09-22 就是这样把一个**我们自己的 UA 问题**写成了「源站 XML 畸形」，
 * 而且写进了 AGENTS.md。所以这里用**当时真实抓下来的两份首页 HTML**当语料，
 * 把「必须判定为网页」钉死。
 *
 * 语料来源：2026-09-22 用 `curl -A "CentralAsiaNewsBot/1.0"` 抓 `kg.akipress.org/rss`
 * 与 `tazabek.kg/rss` 得到的响应（即当时容器里收到的东西），各取开头一段。
 */
import { looksLikeHtml, notFeedReason, describeFetchError } from '../src/lib/feed-fetch';
import { RSS_SOURCES } from '../src/lib/data/rss-sources';

let pass = 0;
const failures: string[] = [];

function ok(label: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}${extra ? `\n      ${extra}` : ''}`);
  }
}

console.log('\n=== looksLikeHtml · 必须判成「网页」（真实语料）===\n');

// 真实响应：AKIpress 首页（8517B，text/html）。取开头，含当时的报错位置附近。
const AKIPRESS_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Лента новостей – АКИpress</title>
</head>
<body><div id="app"></div></body>
</html>`;

// 真实响应：Tazabek 首页（8350B，text/html）。同一套模板 —— 这正是
// 「两个不同站点报出同一个 Line: 38 Column: 7」的原因。
const TAZABEK_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Тазабек — деловые новости</title>
</head>
<body><div id="app"></div></body>
</html>`;

ok('AKIpress 首页 HTML（text/html）判成网页', looksLikeHtml('text/html; charset=utf-8', AKIPRESS_HTML));
ok('Tazabek 首页 HTML（text/html）判成网页', looksLikeHtml('text/html; charset=utf-8', TAZABEK_HTML));
ok(
  'Content-Type 谎报成 application/xml，但正文是网页 —— 仍要判成网页',
  looksLikeHtml('application/xml', AKIPRESS_HTML),
  '只信 Content-Type 会漏判这一类；本函数必须同时看正文开头',
);
ok(
  'Content-Type 为空，正文是网页 —— 仍要判成网页',
  looksLikeHtml('', AKIPRESS_HTML),
);
ok(
  '正文前有空白/BOM 也要判出来',
  looksLikeHtml('', `\n\n   ${AKIPRESS_HTML}`),
);
ok(
  '大写 <!DOCTYPE HTML> 也要判出来',
  looksLikeHtml('', '<!DOCTYPE HTML><html><body>x</body></html>'),
);

console.log('\n=== looksLikeHtml · 不能误判真 feed ===\n');
const REAL_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Азия-Плюс</title>
<item><title>Что-то важное</title></item></channel></rss>`;
const REAL_RSS_NO_DECL = `<rss version="2.0"><channel><title>t</title><item><title>i</title></item></channel></rss>`;
ok('标准 RSS 判成 feed', !looksLikeHtml('application/rss+xml; charset=UTF-8', REAL_RSS));
ok('无 XML 声明的 RSS 判成 feed', !looksLikeHtml('application/xml', REAL_RSS_NO_DECL));
ok('带 BOM 的 RSS 判成 feed', !looksLikeHtml('application/xml', `\uFEFF${REAL_RSS}`));
ok(
  '正文里出现 "<html" 但不在开头（feed 里讲 HTML 新闻）不算网页',
  !looksLikeHtml('application/rss+xml', REAL_RSS.replace('Что-то важное', 'Как работает <html> тег')),
);

console.log('\n=== notFeedReason · 结论必须是「人话」===\n');
const rHtml = notFeedReason(200, 'text/html; charset=utf-8', AKIPRESS_HTML);
ok('HTML → 有原因', rHtml !== null);
ok('HTML 原因里点名「网页」而不是「XML」', !!rHtml && rHtml.includes('网页'));
ok('HTML 原因里带 Content-Type', !!rHtml && rHtml.includes('text/html'));
ok('HTML 原因里带正文开头（便于人工确认是不是拦页）', !!rHtml && rHtml.includes('<!DOCTYPE'));

const r404 = notFeedReason(404, 'text/html', '<html>not found</html>');
ok('HTTP 404 → 先说状态码', r404 === 'HTTP 404', `实际：${r404}`);

const r500 = notFeedReason(500, 'text/html', '');
ok('HTTP 500 优先报状态码（不是「网页」）', r500 === 'HTTP 500', `实际：${r500}`);

const rEmpty = notFeedReason(200, 'application/xml', '   \n  ');
ok('空正文 → 有原因', !!rEmpty && rEmpty.includes('空'));
ok('正常 RSS → 无原因（null）', notFeedReason(200, 'application/rss+xml', REAL_RSS) === null);
ok('无 CT 的正常 RSS → 无原因', notFeedReason(200, '', REAL_RSS) === null);

console.log('\n=== describeFetchError · 不能返回空字符串 ===\n');
ok(
  'TimeoutError（message 为空）→ 报「超时」',
  describeFetchError({ name: 'TimeoutError', message: '' }, 30000).includes('超时'),
  '线上 Asia-Plus 当时报的就是 `RSS 解析失败：` 后面什么都没有 —— 这个兜底就是为了不再出现空原因',
);
ok(
  '只有 code 的网络错误 → 也能给出内容',
  describeFetchError({ code: 'ECONNRESET' }, 30000).includes('ECONNRESET'),
);
ok(
  '只有 cause.code 也要挖出来',
  describeFetchError({ name: 'TypeError', message: 'fetch failed', cause: { code: 'ENOTFOUND' } }, 30000).includes('ENOTFOUND'),
);
ok(
  '纯字符串错误 → 兜底成字符串本身',
  describeFetchError('boom', 30000) === 'boom',
);
ok(
  '什么都不给 → 也**不能**是空串',
  describeFetchError(undefined, 30000).length > 0,
);

// ── 源清单卫生（离线，不联网）──────────────────────────────────────
//
// 为什么这几条值得上闸门：源清单写错的失效是**静默又昂贵**的。
//   · 同一个 URL 写两遍 → 每轮多打一次请求，日志里出现两条同名记录；如果是
//     按 UA 返回的源（akipress / tazabek），还可能一条通一条不通，看起来像「源不稳」。
//   · 某国整段被删/写错国别代号 → 那个国家**一条新闻都没有**，而流水线不报错。
//   · 探针脚本第一版就是因为没归一化 `www.`，把 `www.vesti.kg/rss` 报成了新源
//     （它和已有的 `vesti.kg/rss` 是同一个源）—— 这个错很容易再犯一次。
console.log('\n=== RSS 源清单卫生 ===\n');

/** 归一化：协议、`www.`、末尾斜杠都不该影响「是不是同一个源」的判断 */
const normUrl = (u: string) =>
  u.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();

const dupUrls = (() => {
  const seen = new Map<string, string>();
  const dups: string[] = [];
  for (const s of RSS_SOURCES) {
    const k = normUrl(s.url);
    if (seen.has(k)) dups.push(`${k}（${seen.get(k)} ↔ ${s.name}）`);
    seen.set(k, s.name);
  }
  return dups;
})();
ok('没有重复的源 URL（按归一化比较）', dupUrls.length === 0, dupUrls.join('；'));

/** 每国至少几个源。门槛定在 3 是**下限告警**，不是目标值 ——
 *  真实目标是「按候选数补薄的国家」（见 rss-sources.ts 文件头）。 */
const byCountry = new Map<string, number>();
for (const s of RSS_SOURCES) byCountry.set(s.country, (byCountry.get(s.country) ?? 0) + 1);
const THIN = ['kz', 'uz', 'kg', 'tj', 'az'];
const tooThin = THIN.filter((c) => (byCountry.get(c) ?? 0) < 3);
ok(
  '五个国家每个都至少有 3 个源（防「某国源被整段删掉」）',
  tooThin.length === 0,
  tooThin.map((c) => `${c} 只有 ${byCountry.get(c) ?? 0} 个`).join('；'),
);
ok('存在区域综合源（intl）', (byCountry.get('intl') ?? 0) >= 1);
ok(
  '国别代号都在预期集合内（写错代号会让该源永远进不了任何一国的选题）',
  RSS_SOURCES.every((s) => [...THIN, 'intl'].includes(s.country)),
  RSS_SOURCES.filter((s) => ![...THIN, 'intl'].includes(s.country)).map((s) => `${s.name}:${s.country}`).join('；'),
);

// 全 https：云托管出来的请求走明文会被中间设备改写，而且 `fetchFeed` 只设了 UA/Accept，
// 没有处理跳转协议降级的逻辑。
const notHttps = RSS_SOURCES.filter((s) => !s.url.startsWith('https://'));
ok('所有源都是 https', notHttps.length === 0, notHttps.map((s) => s.url).join('；'));
ok('每个源都声明了 language', RSS_SOURCES.every((s) => Boolean(s.language)));
ok('每个源都有 non-empty name 与 url', RSS_SOURCES.every((s) => Boolean(s.name && s.url)));

console.log('\n' + '='.repeat(60));
if (failures.length) {
  console.log(`❌ ${failures.length} 项失败：\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`✅ 全部通过：${pass} 项断言`);
