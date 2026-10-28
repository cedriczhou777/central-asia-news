/**
 * 「同一站点的其它 feed」扫描（2026-10-27）。
 *
 * ## 为什么扫这个
 *
 * 扩源有三条路：① 新增站点 ② 同一站点的**其它 feed** ③ 同一频道的**更多条目**。
 * ② 是**最便宜**的：站点已经在了、可信度已经验证过、内容不重复
 * （不同语言/不同栏目的稿子本来就是不同的稿）。
 *
 * 例：`azertag.az` 已有 `/en/rss` 与 `/ru/rss` ⇒ 还有没有别的语言版？
 * ⇒ 这类「一个站多份 feed」在中亚媒体里很常见。
 *
 * ## 判据
 *
 * 只报**不在现有 `RSS_SOURCES` 里**、且**能解析出条目**的 feed。
 */
import { fetchFeed } from '../src/lib/feed-fetch';
import { RSS_SOURCES } from '../src/lib/data/rss-sources';

const existing = new Set(RSS_SOURCES.map((s) => s.url.replace(/\/$/, '')));

/** 站点 + 候选路径。路径是「常见约定」的枚举，不是猜的单一路径。 */
const SITES: Array<{ name: string; country: string; base: string; paths: string[] }> = [
  { name: 'AZERTAC', country: 'az', base: 'https://azertag.az', paths: ['/az/rss', '/tr/rss', '/rss.xml', '/feed'] },
  { name: 'Trend.az', country: 'az', base: 'https://www.trend.az', paths: ['/az/rss', '/rss.xml', '/feed', '/news/rss'] },
  { name: 'Qafqazinfo', country: 'az', base: 'https://qafqazinfo.az', paths: ['/rss.xml', '/feed', '/az/rss', '/en/rss'] },
  { name: 'Modern.az', country: 'az', base: 'https://modern.az', paths: ['/rss.xml', '/feed', '/az/rss', '/en/rss'] },
  { name: 'Banker.az', country: 'az', base: 'https://banker.az', paths: ['/rss.xml', '/feed', '/az/rss', '/en/rss'] },
  { name: 'Inform.kz (Kazinform)', country: 'kz', base: 'https://inform.kz', paths: ['/rss.xml', '/feed', '/ru/rss', '/en/rss'] },
  { name: 'Kazinform (alt)', country: 'kz', base: 'https://www.kazinform.kz', paths: ['/rss', '/rss.xml', '/feed'] },
  { name: 'orda.kz', country: 'kz', base: 'https://orda.kz', paths: ['/rss', '/rss.xml', '/feed', '/ru/rss'] },
  { name: 'forbes.kz', country: 'kz', base: 'https://forbes.kz', paths: ['/rss', '/rss.xml', '/feed', '/kz/rss'] },
  { name: 'capital.kz', country: 'kz', base: 'https://capital.kz', paths: ['/rss', '/rss.xml', '/feed'] },
  { name: 'lsm.kz', country: 'kz', base: 'https://lsm.kz', paths: ['/rss.xml', '/feed', '/kk/rss', '/ru/rss'] },
  { name: 'Tengrinews (栏目)', country: 'kz', base: 'https://tengrinews.kz', paths: ['/rss_news/politics.xml', '/rss_news/economics.xml', '/rss_news/all.xml', '/rss_news/finance.xml'] },
  { name: 'kun.uz', country: 'uz', base: 'https://kun.uz', paths: ['/rss', '/rss.xml', '/feed', '/uz/rss'] },
  { name: 'zamin.uz (栏目)', country: 'uz', base: 'https://zamin.uz', paths: ['/rss.xml', '/feed', '/rss/ekonomika', '/rss/politika'] },
  { name: 'qalampir.uz', country: 'uz', base: 'https://qalampir.uz', paths: ['/rss.xml', '/feed', '/uz/rss'] },
  { name: 'xabar.uz', country: 'uz', base: 'https://xabar.uz', paths: ['/rss.xml', '/feed', '/uz/rss'] },
  { name: 'report.uz', country: 'uz', base: 'https://report.uz', paths: ['/rss.xml', '/feed', '/uz/rss', '/ru/rss'] },
  { name: '24.kg (栏目)', country: 'kg', base: 'https://24.kg', paths: ['/rss/politics.xml', '/rss/economics.xml', '/rss/all.xml', '/rss/business.xml'] },
  { name: 'kaktus.kg', country: 'kg', base: 'https://kaktus.kg', paths: ['/rss.xml', '/feed', '/kg/rss', '/ru/rss'] },
  { name: 'elkart.kg', country: 'kg', base: 'https://elkart.kg', paths: ['/rss.xml', '/feed'] },
  { name: 'kg-news.net', country: 'kg', base: 'https://kg-news.net', paths: ['/rss', '/rss.xml', '/feed'] },
  { name: 'TajikToday', country: 'tj', base: 'https://tajiktoday.com', paths: ['/rss', '/rss.xml', '/feed', '/tj/rss'] },
  { name: 'sugrov.uz (tj)', country: 'tj', base: 'https://sugrov.uz', paths: ['/rss', '/rss.xml', '/feed'] },
  { name: 'asiaplustj (栏目)', country: 'tj', base: 'https://asiaplustj.info', paths: ['/rss/tajikistan.xml', '/rss/economy.xml', '/rss.xml', '/feed'] },
];

async function main(): Promise<void> {
  const found: Array<{ name: string; country: string; url: string; n: number; sample: string }> = [];
  for (const site of SITES) {
    for (const p of site.paths) {
      const url = site.base + p;
      if (existing.has(url.replace(/\/$/, ''))) continue;
      try {
        const { feed } = await fetchFeed(url);
        if (feed.items.length > 0) {
          found.push({
            name: site.name,
            country: site.country,
            url,
            n: feed.items.length,
            sample: (feed.items[0]?.title || '').slice(0, 60),
          });
          console.log(
            `  ✓ ${site.country} ${site.name.padEnd(22)} ${String(feed.items.length).padStart(3)} 条  ${url}\n      ${(feed.items[0]?.title || '').slice(0, 66)}`,
          );
        }
      } catch {
        // 试下一个路径；失败是常态（大部分组合不存在）
      }
    }
  }
  console.log(`\n★ 可用的「新 feed」${found.length} 个：`);
  for (const f of found) console.log(`   · ${f.country} ${f.name.padEnd(22)} ${String(f.n).padStart(3)} 条  ${f.url}`);
  if (found.length === 0) console.log('   （没有）');
}
void main();
