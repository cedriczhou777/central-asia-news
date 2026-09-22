/**
 * 源健康体检：**逐个源**跑 `fetchFeed`，报出状态 / Content-Type / 字节数 / 耗时 / 条数 / 用了哪个 UA。
 *
 * ## 它和被它取代的 curl 手测有什么不同
 *
 * 2026-09-22 查「26 个源里 16 个失败」时，我是用一串 curl 手工试出来的 ——
 * 那一步恰好是**唯一能定性**的一步（看到 `text/html` 才知道「不是 feed」，
 * 而 `sourceErrors` 里只有一句 `Unexpected close tag`）。
 * 手工试出来的结论没法回归、下一个人还得再试一遍，所以固化成这个脚本。
 *
 * ⚠️ **它测的是「本机视角」，不是容器视角。** 两者实测会不一致：
 * `Inbusiness.kz` 本机可达、容器里超时。所以本脚本用来回答
 * 「这个 URL 到底是不是一个 feed / 本地能不能解析」，
 * 「线上这个源通不通」要看 `GET /api/fetch-news` 的 `funnelByCountry` 与 `sourceErrors`。
 *
 * 只读：拉 feed、跑纯函数、打印。不入库、不翻译、不调用任何模型。
 *
 * 用法：
 *   pnpm analyze:feeds              # 全部源
 *   pnpm analyze:feeds kz           # 只测某国
 *   pnpm analyze:feeds --only=tazabek.kg   # 只测 URL 含该子串的源
 */
import { RSS_SOURCES } from '../src/lib/data/rss-sources';
import { fetchFeed, FeedFetchError, FEED_TIMEOUT_MS } from '../src/lib/feed-fetch';

function pad(s: string, n: number) {
  // 中文按 2 列宽算，否则表格会歪。
  const w = [...s].reduce((a, c) => a + (/[\u4e00-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.find((a) => !a.startsWith('--'));
  const urlFilter = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);

  const sources = RSS_SOURCES.filter(
    (s) => (!only || s.country === only) && (!urlFilter || s.url.includes(urlFilter)),
  );

  console.log(`源健康体检：${sources.length} 个源，单源超时 ${FEED_TIMEOUT_MS}ms`);
  console.log(`（本机视角 —— 容器可达性另看 GET /api/fetch-news 的 sourceErrors）\n`);
  console.log(`${pad('源', 24)}${pad('国别', 6)}${pad('状态', 8)}${pad('Content-Type', 30)}${pad('字节', 10)}${pad('耗时', 8)}${pad('条数', 6)}UA`);

  let bad = 0;
  for (const s of sources) {
    const started = Date.now();
    try {
      const { feed, meta } = await fetchFeed(s.url);
      const items = feed.items ?? [];
      console.log(
        `${pad(s.name, 24)}${pad(s.country, 6)}${pad('✓', 8)}${pad(meta.contentType || '(无)', 30)}` +
          `${pad(String(meta.bytes), 10)}${pad(`${meta.ms}ms`, 8)}${pad(String(items.length), 6)}${meta.usedUa.slice(0, 22)}`,
      );
      if (items.length === 0) {
        bad++;
        console.log(`${' '.repeat(8)}└─ ⚠️ 通了但 0 条目（feed 本身空，或日期格式全都不认）`);
      }
    } catch (err) {
      bad++;
      const detail = err instanceof FeedFetchError
        ? err.message
        : `非 FeedFetchError：${err instanceof Error ? err.message : String(err)}`;
      console.log(
        `${pad(s.name, 24)}${pad(s.country, 6)}${pad('✗', 8)}${pad('-', 30)}${pad('-', 10)}${pad(`${Date.now() - started}ms`, 8)}${pad('0', 6)}-`,
      );
      for (const line of detail.split('\n')) console.log(`        ${line.trim()}`);
    }
  }

  console.log(`\n共 ${sources.length} 个源，其中 ${bad} 个有问题。`);
  console.log(
    '⚠️ 只看到 `Unexpected close tag` 这类 XML 报错时，**先怀疑拿到的是网页**：\n' +
      '   本脚本会把 Content-Type 打出来 —— 若是 text/html，就是站点按 UA 给了 SPA 首页，\n' +
      '   修 UA（见 FEED_USER_AGENTS），不要去查对方的 XML。',
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
