/**
 * Telegram **直连**抓取的回归（2026-10-25）。
 *
 * ## 为什么要有这个脚本
 *
 * 直连路径（`src/lib/telegram-preview.ts`）是 **Worker（`telegram-worker/worker.js`）的移植版**
 * —— 同一套解析规则，**跑在两个地方**。
 * ⇒ ⚠️ **两边一旦漂移，就会出现「Worker 抓得到、直连抓不到」这种极难查的现象**
 * （因为两条路都在兜底链上，失败会被下一级悄悄接住 ⇒ 看起来只是「少了几条」）。
 * ⇒ 所以这里用**两条断言**把它钉住：
 * ① 解析规则本身正确（喂一段真实结构的 HTML）；
 * ② **两个文件里的关键解析片段逐字一致**（防漂移）。
 *
 * ## ② 为什么用「逐条片段」而不是「抽正则字面量」
 *
 * 通用抽取器要处理「正则里含斜杠」这件事 ⇒ 转义层数一多就会把自己写坏
 * （今晚为此折腾了两轮）⇒ 而**真正要防漂移的只有那几条关键规则** ⇒
 * 直接逐条列出、逐条断言「两边都有」⇒ 既简单、意图也更清楚。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseTelegramPreview } from '../src/lib/telegram-preview';

let passed = 0;
const failures: string[] = [];
function section(name: string): void {
  console.log(`\n${'-'.repeat(60)}\n${name}\n${'-'.repeat(60)}`);
}
function ok(desc: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${desc}`);
  } else {
    failures.push(`${desc}${detail ? `　→ ${detail}` : ''}`);
    console.log(`  ✗ ${desc}${detail ? `　→ ${detail}` : ''}`);
  }
}

const R = (f: string) => readFileSync(resolve(process.cwd(), f), 'utf8');
const workerJs = R('telegram-worker/worker.js');
const previewTs = R('src/lib/telegram-preview.ts');
const sc = R('src/lib/scraper.ts');

// ============================================================
// 一、解析规则正确（喂真实结构的 HTML）
// ============================================================
section('直连解析：标题 / url / 时间 / 摘要');

const HTML = [
  '<div class="tgme_widget_message_wrap"><div class="tgme_widget_message js-widget_message">',
  '<a class="tgme_widget_message_owner_name" href="https://t.me/tengrinews"><span>Tengrinews</span></a>',
  '<div class="tgme_widget_message_text js-message_text">Нацбанк снизил базовую ставку до 16,25 процента (было 16,75 процента).<br>Снижение базовой ставки делает кредиты дешевле.</div>',
  '<time datetime="2026-10-23T07:01:17+00:00">07:01</time>',
  '<div class="tgme_widget_message_data" data-post="tengrinews/27690"></div>',
  '</div></div>',
  '<div class="tgme_widget_message js-widget_message">',
  '<div class="tgme_widget_message_text js-message_text">Второй пост &amp; ещё один</div>',
  '<time datetime="2026-10-23T08:00:00+00:00">08:00</time>',
  '<div class="tgme_widget_message_data" data-post="tengrinews/27691"></div>',
  '</div></div>',
].join('\n');

const posts = parseTelegramPreview(HTML);
ok('解析出 2 条', posts.length === 2, `实际 ${posts.length}`);
ok('标题取正文第一行', (posts[0]?.title ?? '').startsWith('Нацбанк снизил базовую ставку'), `实际「${posts[0]?.title}」`);
ok('标题截到 120 字符', posts.every((p) => p.title.length <= 120));
ok('url 是 permalink 形式', posts[0]?.url === 'https://t.me/tengrinews/27690', `实际「${posts[0]?.url}」`);
ok('时间取自 <time datetime>', posts[0]?.date === '2026-10-23T07:01:17+00:00', `实际「${posts[0]?.date}」`);
ok('摘要是正文前 400 字符', (posts[0]?.summary.length ?? 0) > 0 && (posts[0]?.summary.length ?? 0) <= 400);
ok('HTML 实体被解码（&amp; → &）', (posts[1]?.summary ?? '').includes('&'), `实际「${posts[1]?.summary}」`);
ok('纯图片消息（无正文）被跳过',
  parseTelegramPreview('<div class="tgme_widget_message "><div data-post="a/1"></div></div>').length === 0);
ok('空 HTML 不炸', parseTelegramPreview('').length === 0);

// ============================================================
// 二、★ 与 Worker 那份**逐条一致**（防漂移）
// ============================================================
section('★ 与 Worker 版解析规则一致（防漂移）');

/** ★ 真正要防漂移的关键规则 —— 改一处就要改另一处。 */
const KEY_RULES: Array<{ what: string; snippet: string }> = [
  { what: '按 tgme_widget_message 切块', snippet: `split('<div class="tgme_widget_message ')` },
  { what: '取 data-post 里的消息号', snippet: 'data-post="[^/]+' },
  { what: '取 data-post 里的频道名', snippet: 'data-post="([^/]+)' },
  { what: '取 <time datetime>', snippet: '<time[^>]+datetime="([^"]+)"' },
  { what: '取正文块', snippet: 'tgme_widget_message_text' },
  { what: '<br> 换行', snippet: '<br\\s*\\/?>' },
  { what: '去多余空行', snippet: '\\n{2,}' },
  { what: 'permalink 拼法', snippet: 'https://t.me/${channelName}/${postMatch[1]}' },
  { what: '标题截断长度', snippet: '.slice(0, 120)' },
  { what: '摘要截断长度', snippet: '.slice(0, 400)' },
  { what: 'UA 里的 Chrome 版本', snippet: 'Chrome/120.0.0.0' },
  { what: '实体 &amp;', snippet: '/&amp;/g' },
  { what: '实体 &quot;', snippet: '&quot;' },
  { what: '实体 &#39;', snippet: '&#39;' },
  { what: '实体 &lt;', snippet: '&lt;' },
  { what: '实体 &gt;', snippet: '&gt;' },
  { what: '实体 &nbsp;', snippet: '&nbsp;' },
];

for (const r of KEY_RULES) {
  const inWorker = workerJs.includes(r.snippet);
  const inDirect = previewTs.includes(r.snippet);
  ok(
    `★ 「${r.what}」两个文件里都有（Worker ${inWorker ? '✓' : '✗'} / 直连 ${inDirect ? '✓' : '✗'}）`,
    inWorker && inDirect,
    `snippet=${r.snippet}`,
  );
}

// ============================================================
// 三之二、★ 体检接口必须与生产一致（`okCount` 的含义）
// ============================================================
section('★ 体检：okCount 必须反映「Worker + 直连」的真实能力');

ok('★ probeTelegramChannel 走的不只是 Worker（**只测 Worker ⇒ okCount 与生产对不上**）',
  /probeTelegramChannel[\s\S]{0,900}fetchTelegramPreviewDirect/.test(sc),
  '体检只测 Worker ⇒ 会出现「体检说通、生产抓不到」（2026-10-25 的实际情况）');
ok('★ probe 会标明走的哪条路（via）',
  /via\?: 'worker' \| 'direct' \| 'none'/.test(sc));
ok('★ 兜底链顺序仍是 Worker → 直连 → RSSHub',
  sc.indexOf('fetchTelegramByWorker(channelId)') < sc.indexOf('fetchTelegramPreviewDirect(channelId)') &&
    sc.indexOf('fetchTelegramPreviewDirect(channelId)') < sc.indexOf('fetchTelegramByRSSHub(channelId)'));

// ============================================================
// 三、兜底链顺序（Worker → 直连 → RSSHub）
// ============================================================
section('兜底链：Worker → 直连 → RSSHub');

const iWorker = sc.indexOf('fetchTelegramByWorker(channelId)');
const iDirect = sc.indexOf('fetchTelegramPreviewDirect(channelId)');
const iRSS = sc.indexOf('fetchTelegramByRSSHub(channelId)');
ok('三条路都在', iWorker > 0 && iDirect > 0 && iRSS > 0, `${iWorker}/${iDirect}/${iRSS}`);
ok('★ 顺序是 Worker → 直连 → RSSHub', iWorker < iDirect && iDirect < iRSS, `实际 ${iWorker}/${iDirect}/${iRSS}`);
ok('★ 兜底失败时报错里提到「直连」（否则查起来不知道试过没有）', sc.includes('直连 t.me 失败'));
ok('★ 直连这一级插在 RSSHub **之前**（直连只 1 个请求，RSSHub 要试两个公共实例）',
  iDirect < iRSS);

// ============================================================
console.log(`\n${'='.repeat(64)}`);
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
