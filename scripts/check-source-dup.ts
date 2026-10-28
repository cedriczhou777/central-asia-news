/**
 * 候选源的**重复判定**（2026-10-27）。
 *
 * ## 为什么必须有它
 *
 * 同一个站常有多份 feed（多语言、分栏目、`/rss` 与 `/feed` 指向同一份）。
 * ⇒ 直接加进 `RSS_SOURCES` 的话，**内容会重复**：
 * ⇒ ① 候选量虚增（⇒ 判组阶段的 O(n²) 配对更贵 —— 这正是 10-28 崩掉的原因）；
 * ⇒ ② 同一件事在同一国里出现多份 ⇒ 判组/总审要额外去重 ⇒ ⇒ 白花 token；
 * ⇒ ③ **去重后可能一篇都不剩** ⇒ ⇒ 那个源等于没加。
 *
 * ⇒ 所以加源前必须先判重。
 *
 * ## 判据
 *
 * 拿候选源与**现有全部源**的标题做 Jaccard 比对：
 * · 重叠率 ≥ `DUP_RATIO`（默认 0.6）⇒ 判「与已有源重复」⇒ **不建议加**；
 * · 重叠率 < 0.6 ⇒ 判「内容独立」⇒ 可以加。
 *
 * ⚠️ 这是**内容重叠**判据，不是 URL 判据 —— 不同 URL 指向同一份内容才是要挡的。
 */
import { fetchFeed } from '../src/lib/feed-fetch';
import { RSS_SOURCES } from '../src/lib/data/rss-sources';

const DUP_RATIO = 0.6;
const SAMPLE = 25;

/** 标题 → 字符 bigram 集合（Jaccard 用）。 */
function grams(t: string): Set<string> {
  const s = t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const set = new Set<string>();
  const c = s.replace(/\s/g, '');
  for (let i = 0; i < c.length - 1; i++) set.add(c.substring(i, i + 2));
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

async function main(): Promise<void> {
  // 1) 现有源的标题样本
  const existing: Array<{ name: string; titles: Set<string>[] }> = [];
  for (const s of RSS_SOURCES) {
    try {
      const { feed } = await fetchFeed(s.url);
      const ts = feed.items.slice(0, SAMPLE).map((i) => i.title || '').filter(Boolean);
      if (ts.length) existing.push({ name: s.name, titles: ts.map(grams) });
    } catch {
      // 抓不到就跳过（不影响判重）
    }
  }
  console.log(`已取到 ${existing.length} 个现有源的标题样本`);

  // 2) 候选源（命令行传 URL）
  const candidates = process.argv.slice(2);
  if (candidates.length === 0) {
    console.log('用法：npx tsx scripts/check-source-dup.ts <url> [url…]');
    return;
  }
  for (const url of candidates) {
    let titles: string[] = [];
    try {
      const { feed } = await fetchFeed(url);
      titles = feed.items.slice(0, SAMPLE).map((i) => i.title || '').filter(Boolean);
    } catch (e) {
      console.log(`  ✗ ${url} 抓不到：${String(e).slice(0, 70)}`);
      continue;
    }
    if (titles.length === 0) {
      console.log(`  ✗ ${url} 抓到 0 条`);
      continue;
    }
    const gs = titles.map(grams);
    // 候选源内部也有自重复（多语言 feed 的同一篇会译成不同标题 ⇒ 仍会重叠）⇒ 单独看
    let best = { name: '', ratio: 0 };
    for (const ex of existing) {
      for (const g of gs) {
        for (const t of ex.titles) {
          const r = jaccard(g, t);
          if (r > best.ratio) best = { name: ex.name, ratio: r };
        }
      }
    }
    const verdict = best.ratio >= DUP_RATIO ? '★ 与已有源重复' : '✓ 内容独立';
    console.log(
      `  ${verdict}  最高重叠 ${(best.ratio * 100).toFixed(0)}%（${best.name}）  ${url}  ${titles.length} 条`,
    );
  }
}
void main();
