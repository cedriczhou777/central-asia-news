/**
 * 专有名词写法体检（只读，不改任何数据）。
 *
 * 用法：
 *   pnpm analyze:nouns                 # 默认最近 7 天 × 5 国
 *   pnpm analyze:nouns 2               # 最近 2 天
 *   SITE_BASE=http://localhost:3000 pnpm analyze:nouns 7
 *
 * ## 存在的理由
 *
 * 2026-09-23 改了口径（人名/公司名 → 拉丁；国名/州名/城市 → 中文），
 * 但**本地配不了翻译 Key**，真调模型的行为只能等下一轮抓取的真实产出。
 * 那次是靠临时探针量的，量完就删了 —— 下周再想复核就得重写一遍。
 * 所以这套指标固化成脚本，**每次改口径后跑同一条命令对比前后**。
 *
 * ## 怎么读
 *
 * 1. `T1 汉字+西里尔同词` —— 结构上不可能正确，**目标 0**。改口径前实测 3.2%。
 * 2. `人名写法` —— 同一人名的中文/拉丁条数。**目标：收敛到一种**（定稿＝拉丁）。
 *    `同篇混用` 那一列必须为 0（改前 Aliyev 4 篇 / Japarov 3 篇 / Tokayev 2 篇）。
 * 3. `国名/州名是否仍是中文` —— 定稿口径要求中文；**出现 `Kazakhstan`/`Astana` 这类就是回归**。
 * 4. `汉字个数分布` —— 判据是 `MIN_HAN_*`。**低于阈值的条数就是「会被静默丢稿」的条数**，
 *    这个数不该比改动前明显变大。改口径前的分布记在下面「基线」注释里。
 *
 * 基线（2026-09-23 实测，7 天 × 5 国 = 1757 篇）：
 *   标题汉字 min=6 / p1=12 / 中位=24　正文汉字 min=4 / p1=34 / 中位=143
 *   T1 = 3.2%（57 篇）／含任意西里尔 = 9.4%（165 篇）／kg 的西里尔率最高（24%）
 */
import { hanCount, hanRatio, mixedScriptTokens, MIN_HAN_TITLE, MIN_HAN_CONTENT } from '../src/lib/utils';

const BASE = process.env.SITE_BASE || 'https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com';
const COUNTRIES = ['kz', 'uz', 'kg', 'az', 'tj'];
const DAYS = Number(process.argv[2] || 7);

interface Row {
  id: number; title: string; summary: string; content: string;
  source: string; country: string; publishedAt: string;
}

/** 人名两种写法的候选形式。加人名就加一行 —— 这是**口径的检查清单**，不是语言学的完整性。 */
const PERSONS: Array<{ label: string; zh: string[]; lat: string[] }> = [
  { label: 'Tokayev 托卡耶夫', zh: ['托卡耶夫'], lat: ['Tokayev', 'Токаев'] },
  { label: 'Japarov 扎帕罗夫', zh: ['贾帕罗夫', '扎帕罗夫'], lat: ['Japarov', 'Zhaparov', 'Жапаров'] },
  { label: 'Mirziyoyev 米尔济约耶夫', zh: ['米尔济约耶夫'], lat: ['Mirziyoyev', 'Мирзиёев'] },
  { label: 'Aliyev 阿利耶夫', zh: ['阿利耶夫', '阿里耶夫', '伊利哈姆'], lat: ['Aliyev', 'Алиев', 'İlham', 'Ilham'] },
  { label: 'Rahmon 拉赫蒙', zh: ['拉赫蒙'], lat: ['Rahmon', 'Раҳмон'] },
  { label: 'Erdoğan 埃尔多安', zh: ['埃尔多安'], lat: ['Erdoğan', 'Erdogan', 'Эрдоған'] },
  { label: 'Putin 普京', zh: ['普京'], lat: ['Putin', 'Путин'] },
];

/** 国名/州名/城市 —— 定稿口径要求中文，这里只查「有没有变英文」 */
const SHOULD_BE_CHINESE: Array<{ cn: string; en: string }> = [
  { cn: '哈萨克斯坦', en: 'Kazakhstan' },
  { cn: '乌兹别克斯坦', en: 'Uzbekistan' },
  { cn: '吉尔吉斯斯坦', en: 'Kyrgyzstan' },
  { cn: '塔吉克斯坦', en: 'Tajikistan' },
  { cn: '阿塞拜疆', en: 'Azerbaijan' },
  { cn: '土库曼斯坦', en: 'Turkmenistan' },
  { cn: '阿斯塔纳', en: 'Astana' },
  { cn: '塔什干', en: 'Tashkent' },
  { cn: '比什凯克', en: 'Bishkek' },
  { cn: '杜尚别', en: 'Dushanbe' },
  { cn: '巴库', en: 'Baku' },
];

const CYR = /[\u0400-\u04ff]/;

function beijingDates(days: number): string[] {
  const out: string[] = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    out.push(new Date(now - i * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }));
  }
  return out;
}

async function load(country: string, date: string): Promise<Row[]> {
  const res = await fetch(`${BASE}/api/articles?country=${country}&date=${date}&limit=300`);
  if (!res.ok) return [];
  const j = (await res.json()) as { articles: Row[] };
  return j.articles.map((a) => ({ ...a, country }));
}

function pct(n: number, d: number) {
  return d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`;
}
function quantile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

async function main() {
  const dates = beijingDates(DAYS);
  const all: Row[] = [];
  for (const d of dates) for (const c of COUNTRIES) all.push(...(await load(c, d)));
  if (all.length === 0) {
    console.error('没取到任何行 —— 检查 SITE_BASE 与日期窗口');
    process.exit(1);
  }
  console.log(`窗口 ${dates[dates.length - 1]} ~ ${dates[0]}（北京日期）｜${all.length} 篇\n`);

  // ---------- 1. 书写系统混用 ----------
  let t1 = 0, cyr = 0;
  const t1Words = new Map<string, number>();
  const perCountry: Record<string, { n: number; t1: number; cyr: number }> = {};
  for (const r of all) {
    const fields = [r.title, r.summary, r.content];
    const hits = fields.flatMap((f) => mixedScriptTokens(f || ''));
    const hasCyr = fields.some((f) => CYR.test(f || ''));
    if (hits.length) t1++;
    if (hasCyr) cyr++;
    for (const h of hits) t1Words.set(h, (t1Words.get(h) || 0) + 1);
    const b = (perCountry[r.country] ||= { n: 0, t1: 0, cyr: 0 });
    b.n++; if (hits.length) b.t1++; if (hasCyr) b.cyr++;
  }
  console.log('=== 1. 书写系统混用（目标：T1 = 0）===');
  console.log(`  T1 汉字+西里尔同词：${t1} 篇（${pct(t1, all.length)}）｜改口径前基线 3.2%`);
  console.log(`  含任意西里尔字母：  ${cyr} 篇（${pct(cyr, all.length)}）｜改口径前基线 9.4%`);
  console.log('  按国家：');
  for (const c of COUNTRIES) {
    const b = perCountry[c]; if (!b) continue;
    console.log(`    ${c}: ${String(b.n).padStart(4)} 篇  T1=${pct(b.t1, b.n)}  含西里尔=${pct(b.cyr, b.n)}`);
  }
  if (t1Words.size) {
    console.log('  T1 高频词（前 15，应逐版减少至 0）：');
    for (const [w, n] of [...t1Words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`    ${String(n).padStart(3)}×  ${w}`);
    }
  }

  // ---------- 2. 人名写法 ----------
  console.log('\n=== 2. 人名写法（目标：收敛到一种＋同篇混用为 0）===');
  for (const p of PERSONS) {
    let zhOnly = 0, latOnly = 0, both = 0;
    for (const r of all) {
      const t = `${r.title} ${r.summary} ${r.content}`;
      const hz = p.zh.some((s) => t.includes(s));
      const hl = p.lat.some((s) => t.includes(s));
      if (hz && hl) both++; else if (hz) zhOnly++; else if (hl) latOnly++;
    }
    if (zhOnly + latOnly + both === 0) continue;
    const verdict = both > 0 ? '❌ 同篇混用' : zhOnly > 0 && latOnly > 0 ? '⚠️ 两种写法并存' : '✅ 单一写法';
    console.log(`  ${verdict}  ${p.label}：中文 ${zhOnly} ｜ 拉丁/西里尔 ${latOnly} ｜ **同篇混用 ${both}**`);
  }

  // ---------- 3. 国名/州名/城市是否仍是中文 ----------
  console.log('\n=== 3. 国名/州名/城市应为中文（出现英文即第二版口径回归）===');
  let anyRegression = false;
  for (const { cn, en } of SHOULD_BE_CHINESE) {
    const cnN = all.filter((r) => `${r.title} ${r.summary}`.includes(cn)).length;
    const enN = all.filter((r) => new RegExp(`\\b${en}\\b`).test(`${r.title} ${r.summary}`)).length;
    if (enN > 0) anyRegression = true;
    console.log(`  ${enN > 0 ? '❌' : '✓'} ${cn}：中文标题 ${String(cnN).padStart(3)} 篇 ／ 英文 ${en}：${enN} 篇`);
  }
  if (anyRegression) {
    console.log('  ⚠️ 有英文地名 → 第 6 条的「国名/州名/城市 → 中文」没被遵守');
  }

  // ---------- 4. 汉字个数分布（判据余量）----------
  const tSorted = all.map((r) => hanCount(r.title)).sort((a, b) => a - b);
  const cSorted = all.map((r) => hanCount(r.content)).sort((a, b) => a - b);
  console.log('\n=== 4. 汉字个数分布（判据：MIN_HAN_TITLE/MIN_HAN_CONTENT）===');
  console.log(`  标题：min=${tSorted[0]} p1=${quantile(tSorted, 0.01)} 中位=${quantile(tSorted, 0.5)} ｜ 阈值 ${MIN_HAN_TITLE}`);
  console.log(`  正文：min=${cSorted[0]} p1=${quantile(cSorted, 0.01)} 中位=${quantile(cSorted, 0.5)} ｜ 阈值 ${MIN_HAN_CONTENT}`);
  const tLow = all.filter((r) => hanCount(r.title) < MIN_HAN_TITLE);
  const cLow = all.filter((r) => hanCount(r.content) < MIN_HAN_CONTENT);
  console.log(`  ⚠️ 会被判「未翻译」而丢弃：标题 ${tLow.length} 篇 ／ 正文 ${cLow.length} 篇`);
  for (const r of [...tLow, ...cLow].slice(0, 8)) {
    console.log(`     id=${r.id} 标题汉字=${hanCount(r.title)} 正文汉字=${hanCount(r.content)} 「${r.title.slice(0, 40)}」`);
  }
  console.log(`  （参考：改口径前最贴线的一条标题占比 ${hanRatio('乌兹别克斯坦总统 Mirziyoyev 会见 Google 副总裁 Kent Walker 讨论 YouTube 变现').toFixed(3)}）`);
}

main();
