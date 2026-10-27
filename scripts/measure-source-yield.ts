/**
 * 候选源的**净增测算**（2026-10-27）。
 *
 * ## 为什么需要这一步
 *
 * 2026-10-27 扫描候选源时发现两个陷阱：
 *
 * ① **「能抓到」≠「有内容」**：@interfaxAZ 能抓 20 条，但**最新的是 2022-03-01**
 *    ⇒ ⇒ 「最新日期」必须一起看。
 * ② ⭐⭐ **「抓到 50 条」≠「净增 50 条」**：`Zamin.uz` 的首条是「囚犯获释」
 *    ⇒ ⇒ **投资相关性闸会把它挡掉** ⇒ ⇒ 真正能进日报的是**过闸之后**的条数。
 *    ⇒ 而且源的语言也有影响：词表以英文/俄文为主 ⇒ **哈萨克语/乌兹别克语的稿子
 *    过闸率可能很低** ⇒ ⇒ **不实测就不知道**。
 *
 * ⇒ 这个脚本对每个候选源：抓一批 ⇒ 逐条算「过投资相关性闸」⇒ **报净增条数**。
 * ⇒ 它是纯本地 + 纯函数判定（`isInvestmentRelevant`），**零成本、零模型调用**。
 */
import { fetchFeed } from '../src/lib/feed-fetch';
import { fetchTelegramPreviewDirect } from '../src/lib/telegram-preview';
import { isInvestmentRelevant } from '../src/lib/fetch-pipeline';

const RSS_CANDIDATES: Array<{ name: string; country: string; url: string }> = [
  { name: 'LSM.kz', country: 'kz', url: 'https://lsm.kz/rss' },
  { name: 'Zamin.uz', country: 'uz', url: 'https://zamin.uz/rss' },
  { name: '24.kg', country: 'kg', url: 'https://24.kg/rss/' },
];

const TG_CANDIDATES: Array<{ country: string; channel: string }> = [
  { country: 'uz', channel: '@kun_uz' },
  { country: 'kg', channel: '@kg24news' },
];

async function main(): Promise<void> {
  console.log('=== RSS 候选：抓到多少 → 过投资相关性闸多少（= 净增）===');
  for (const c of RSS_CANDIDATES) {
    try {
      const { feed } = await fetchFeed(c.url);
      const items = feed.items.slice(0, 40);
      let pass = 0;
      const samples: string[] = [];
      for (const it of items) {
        const t = it.title || '';
        const d = it.contentSnippet || it.content || '';
        if (isInvestmentRelevant(t, d)) {
          pass++;
          if (samples.length < 3) samples.push(t);
        }
      }
      const rate = items.length ? Math.round((pass / items.length) * 100) : 0;
      console.log(
        `  ${c.country} ${c.name.padEnd(14)} 抓到 ${String(items.length).padStart(3)} → 过闸 ${String(pass).padStart(3)}（${rate}%）`,
      );
      for (const s of samples) console.log(`      ✓ ${s.slice(0, 66)}`);
    } catch (e) {
      console.log(`  ✗ ${c.name}: ${String(e).slice(0, 70)}`);
    }
  }

  console.log('\n=== Telegram 候选：同上 ===');
  for (const c of TG_CANDIDATES) {
    let r = await fetchTelegramPreviewDirect(c.channel, 12000);
    if (r.posts.length === 0) {
      await new Promise((s) => setTimeout(s, 2500));
      r = await fetchTelegramPreviewDirect(c.channel, 12000);
    }
    const posts = r.posts.slice(0, 40);
    let pass = 0;
    const samples: string[] = [];
    for (const p of posts) {
      if (isInvestmentRelevant(p.title, p.summary || '')) {
        pass++;
        if (samples.length < 3) samples.push(p.title);
      }
    }
    const rate = posts.length ? Math.round((pass / posts.length) * 100) : 0;
    console.log(
      `  ${c.country} ${c.channel.padEnd(14)} 抓到 ${String(posts.length).padStart(3)} → 过闸 ${String(pass).padStart(3)}（${rate}%）  最新=${posts[0]?.date?.slice(0, 10) ?? '-'}`,
    );
    for (const s of samples) console.log(`      ✓ ${s.slice(0, 66)}`);
  }
}
main();
