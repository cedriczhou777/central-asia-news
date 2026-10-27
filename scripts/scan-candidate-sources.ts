/**
 * 候选新闻源**实测扫描**（2026-10-27）。
 *
 * ## 目的
 *
 * 用户问「还有什么办法能够扩大新闻源」⇒ ⇒ 与其列清单，不如**逐个抓一遍**，
 * 给出「**现在就能用**」的名单（而不是「听说有」的名单）。
 *
 * ## 扫两类
 *
 * ① **RSS**：用项目自己的 `fetchFeed`（与生产同一套解析）⇒ 报「抓到几条 + 条数分布」。
 * ② **Telegram**：用 `fetchTelegramPreviewDirect`（境外出口）⇒ 报「抓到几条 + 最新日期」。
 *
 * ## 判据（**与项目里加源时用的是同一套**）
 *
 * · RSS：**能解析出条目**（>0）⇒ 可用；`items.length` 太少（<3）⇒ 内容稀薄，标注。
 * · Telegram：**能解析出帖子**（>0）⇒ 可用；抓不到时**重试一次**
 *   （t.me 预览页会偶发返回空 —— 2026-10-27 实测 `@tengrinews` 同分钟内 20 条 / 0 条交替）。
 */
import { fetchFeed } from '../src/lib/feed-fetch';
import { fetchTelegramPreviewDirect } from '../src/lib/telegram-preview';

const RSS_CANDIDATES: Array<{ name: string; country: string; url: string }> = [
  // 哈萨克斯坦
  { name: 'Kazinform (国家通讯社)', country: 'kz', url: 'https://inform.kz/rss' },
  { name: 'Kazinform www', country: 'kz', url: 'https://www.inform.kz/rss' },
  { name: 'Orda.kz', country: 'kz', url: 'https://orda.kz/rss' },
  { name: 'Forbes.kz', country: 'kz', url: 'https://forbes.kz/rss/' },
  { name: 'Capital.kz', country: 'kz', url: 'https://capital.kz/rss' },
  { name: 'LSM.kz', country: 'kz', url: 'https://lsm.kz/rss' },
  { name: 'Kazakhstan Today', country: 'kz', url: 'https://astanatimes.com/feed/' },
  // 乌兹别克斯坦
  { name: 'Kun.uz', country: 'uz', url: 'https://kun.uz/feed/rss' },
  { name: 'Zamin.uz', country: 'uz', url: 'https://zamin.uz/rss' },
  { name: 'Qalampir.uz', country: 'uz', url: 'https://qalampir.uz/feed' },
  { name: 'Xabar.uz', country: 'uz', url: 'https://xabar.uz/rss' },
  { name: 'Report.uz', country: 'uz', url: 'https://report.uz/rss' },
  { name: 'News.uz', country: 'uz', url: 'https://news.uz/uz/rss' },
  // 吉尔吉斯斯坦
  { name: '24.kg', country: 'kg', url: 'https://24.kg/rss/' },
  { name: '24.kg (feed)', country: 'kg', url: 'https://24.kg/feed' },
  { name: 'Kaktus.kg', country: 'kg', url: 'https://kaktus.kg/feed/' },
  { name: 'Elkart.kg', country: 'kg', url: 'https://elkart.kg/rss' },
  { name: 'KG-news.net', country: 'kg', url: 'https://kg-news.net/rss' },
  // 阿塞拜疆
  { name: 'Report.az', country: 'az', url: 'https://report.az/feed/' },
  { name: 'Merkezi.az', country: 'az', url: 'https://merkezi.az/feed/' },
  { name: 'Business-int.az', country: 'az', url: 'https://business-int.az/feed/' },
  { name: 'Rulers.az', country: 'az', url: 'https://rulers.az/feed' },
  { name: 'SalamToday.az', country: 'az', url: 'https://salamtoday.az/rss' },
  { name: 'Interfax.az', country: 'az', url: 'https://interfax.az/feed' },
  // 塔吉克斯坦
  { name: 'TajikToday', country: 'tj', url: 'https://tajiktoday.com/rss' },
  { name: 'TajikToday (feed)', country: 'tj', url: 'https://tajiktoday.com/feed' },
  { name: 'Sputnik TJ (archive)', country: 'tj', url: 'https://tj.sputniknews.ru/export/rss2/archive/index.xml' },
];

const TG_CANDIDATES: Array<{ country: string; channel: string }> = [
  { country: 'kz', channel: '@inform_kz' },
  { country: 'kz', channel: '@kazinform_official' },
  { country: 'kz', channel: '@orda_kz' },
  { country: 'kz', channel: '@gov_kz' },
  { country: 'kz', channel: '@forbes_kz' },
  { country: 'uz', channel: '@uzdaily_uz' },
  { country: 'uz', channel: '@khabaronline' },
  { country: 'uz', channel: '@sputnik_uz' },
  { country: 'uz', channel: '@kun_uz' },
  { country: 'kg', channel: '@kgnews24' },
  { country: 'kg', channel: '@kaktus_kg' },
  { country: 'kg', channel: '@24kg' },
  { country: 'kg', channel: '@kg24news' },
  { country: 'az', channel: '@bank_az' },
  { country: 'az', channel: '@azerbaijanaz' },
  { country: 'az', channel: '@interfaxAZ' },
  { country: 'az', channel: '@merkezi_az' },
  { country: 'az', channel: '@salamtoday' },
  { country: 'tj', channel: '@tajiknews' },
  { country: 'tj', channel: '@tajikistan_news' },
];

async function main(): Promise<void> {
  console.log('=== ① RSS 候选（用生产同一套 fetchFeed）===');
  const rssOk: string[] = [];
  for (const c of RSS_CANDIDATES) {
    try {
      const { feed } = await fetchFeed(c.url);
      const n = feed.items.length;
      if (n > 0) {
        rssOk.push(`${c.name}（${c.country}）${n} 条`);
        console.log(`  ✓ ${c.country} ${c.name.padEnd(26)} ${String(n).padStart(3)} 条  ${c.url}`);
        const t = feed.items[0]?.title || feed.items[0]?.contentSnippet || '';
        console.log(`      ${String(t).slice(0, 70)}`);
      } else {
        console.log(`  ✗ ${c.country} ${c.name.padEnd(26)}   0 条  ${c.url}`);
      }
    } catch (e) {
      console.log(`  ✗ ${c.country} ${c.name.padEnd(26)}  失败：${String(e).slice(0, 60)}`);
    }
  }

  console.log('\n=== ② Telegram 候选（0 条时重试一次）===');
  const tgOk: string[] = [];
  for (const c of TG_CANDIDATES) {
    let r = await fetchTelegramPreviewDirect(c.channel, 12000);
    if (r.posts.length === 0) {
      await new Promise((s) => setTimeout(s, 2500));
      r = await fetchTelegramPreviewDirect(c.channel, 12000);
    }
    if (r.posts.length > 0) {
      tgOk.push(`${c.channel}（${c.country}）${r.posts.length} 条`);
      console.log(
        `  ✓ ${c.country} ${c.channel.padEnd(22)} ${String(r.posts.length).padStart(3)} 条  最新=${r.posts[0]?.date?.slice(0, 10) ?? '-'}`,
      );
    } else {
      console.log(`  ✗ ${c.country} ${c.channel.padEnd(22)}   0 条  ${r.error ?? ''}`);
    }
  }

  console.log(`\n★ RSS 可用 ${rssOk.length}/${RSS_CANDIDATES.length}：`);
  for (const x of rssOk) console.log(`   · ${x}`);
  console.log(`\n★ Telegram 可用 ${tgOk.length}/${TG_CANDIDATES.length}：`);
  for (const x of tgOk) console.log(`   · ${x}`);
}
main();
