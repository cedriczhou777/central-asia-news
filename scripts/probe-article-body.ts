/**
 * `src/lib/article-body.ts` 的**联网**探针 —— 拿真实页面看抽出来的到底是不是正文。
 *
 * 为什么必须有它：离线回归只能证明「给定 HTML 时抽取逻辑是对的」，
 * 证明不了「真实页面上的 HTML 长什么样」。而本模块的价值全在这里 ——
 * 抽出来的是正文，还是导航/相关阅读/订阅提示，**只能看真页面**。
 * 抽错的失效方式很隐蔽：抓回一坨垃圾当「原文」存进库，
 * 翻译照它编、总审照它核对，比没有原文更糟。
 *
 * 用法（不写库、不调模型）：
 *   pnpm tsx scripts/probe-article-body.ts
 */
import Parser from 'rss-parser';
import { fetchArticleBody, extractBodyFromHtml, MIN_SOURCE_BODY_CHARS } from '../src/lib/article-body';
import { FEED_USER_AGENTS } from '../src/lib/feed-fetch';

const parser = new Parser({ timeout: 30000, headers: { 'User-Agent': FEED_USER_AGENTS[0] } });

/** 2026-10-02 实测 RSS 里**完全没有正文**的那批源 —— 补抓就是为它们做的。 */
const BLIND_FEEDS = [
  'https://apa.az/rss',
  'https://www.trend.az/rss/',
  'https://azertag.az/en/rss',
  'https://azertag.az/ru/rss',
  'https://qafqazinfo.az/rss',
  'https://uznews.uz/rss',
  'https://podrobno.uz/rss',
];

/** 对照组：RSS 本来就有正文，补抓不该轮到它们（走这条路的页面抽取质量也要看一眼）。 */
const CONTROL_FEEDS = [
  'https://kz.kursiv.media/feed/',
  'https://www.gazeta.uz/rss',
  'https://economist.kg/rss',
  'https://haqqin.az/rss',
];

interface Row {
  label: string;
  link: string;
}

async function firstLink(feedUrl: string): Promise<string | null> {
  try {
    const feed = await parser.parseURL(feedUrl);
    return feed.items?.[0]?.link ?? null;
  } catch (err) {
    console.log(`  feed 取回失败 ${feedUrl}：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function collect(feeds: string[], tag: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (const url of feeds) {
    const link = await firstLink(url);
    if (link) rows.push({ label: `${tag} ${new URL(url).host}`, link });
  }
  return rows;
}

async function main() {
  console.log(`正文长度下限 MIN_SOURCE_BODY_CHARS = ${MIN_SOURCE_BODY_CHARS}\n`);

  const rows = [
    ...(await collect(BLIND_FEEDS, '盲源')),
    ...(await collect(CONTROL_FEEDS, '对照')),
  ];

  let okCount = 0;
  for (const { label, link } of rows) {
    const r = await fetchArticleBody(link);
    console.log('='.repeat(78));
    console.log(`${label}\n  ${link}`);
    if (!r.ok) {
      console.log(`  ✗ 失败：${r.reason}`);
      continue;
    }
    okCount += 1;
    console.log(`  ✓ via=${r.via} 段落=${r.paragraphs} 字数=${r.chars}`);
    console.log('  ' + r.text.slice(0, 400).replace(/\n/g, '\n  '));
  }

  console.log('\n' + '='.repeat(78));
  console.log(`成功 ${okCount} / ${rows.length}`);

  // 边界：畸形输入不该抛异常，也不该吐出垃圾
  console.log('\n--- 边界输入 ---');
  const edges: Array<[string, string]> = [
    ['空串', ''],
    ['空 html', '<html><body></body></html>'],
    ['只有一句短话', `<html><body><p>${'短'.repeat(10)}</p></body></html>`],
    ['只有脚本', `<html><body>${'<script>var a=1;</script>'.repeat(30)}</body></html>`],
    ['实体与嵌套', `<html><body><article><p>${'&amp;lt; 与 &nbsp; 与 &#1053;&#1086;&#1074;&#1086;&#1089;&#1090;&#1080; '.repeat(6)}</p></article></body></html>`],
  ];
  for (const [name, html] of edges) {
    const out = extractBodyFromHtml(html);
    // ⚠️ 这里打印的是 `out.text.length`，**不是 `out.chars`** ——
    // `chars` 是 `fetchArticleBody` 的 `BodyFetchOk` 才有的字段，
    // `ExtractedBody` 没有它。写错了 `tsx` 不报错（它不做类型检查），
    // 只会安静地印出 `undefined 字`，看起来像抽取失败。
    console.log(
      `  ${name} → ${out ? `via=${out.via} 段落=${out.paragraphs} ${out.text.length} 字` : 'null（判定为抽不出正文）'}`,
    );
  }
}

main().catch((err) => {
  console.error('探针自身报错：', err);
  process.exit(1);
});
