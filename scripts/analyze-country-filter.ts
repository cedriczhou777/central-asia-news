/**
 * 国家相关性判据改动的**影响面体检**（只读，不联网调模型，不改任何数据）。
 *
 * 用法：
 *   pnpm analyze:country-filter          # 默认最近 7 天 × 5 国
 *   pnpm analyze:country-filter 3
 *
 * ## 为什么要跑这个
 *
 * 2026-10-05 把两侧的国家相关性清单**合一**了（见 `@/lib/country-relevance`）。
 * 合一过程中往推送侧补了一批词（土耳其、土库曼斯坦、北约、普京…）。
 *
 * ⚠️ 这里有个**方向性**的风险，和采集侧不一样：
 *
 *   · 采集侧多留一条稿子 = 多花一点翻译钱（看得见）；
 *   · **推送侧多排除一条稿子 = 稿子进了库却永远推不出去** ——
 *     用户看不到它，日志里也只是一行计数。这是本项目最忌讳的「看不见的丢失」。
 *
 * 所以推送侧的每一次「收紧」都必须先把**被新排除的每一条**打出来人眼过一遍。
 * 本脚本干这件事：拿**改动前的推送侧判据**（用「把新增词过滤掉」的方式忠实复现）
 * 跑一遍，再拿新判据跑一遍，把差集逐条打出来。
 *
 * 判读标准：
 *   · `新排除` 里如果出现「其实是本国新闻」→ **判据过严，要回退那条词**；
 *   · 全是明确的别国新闻 → 说明这批词补对了。
 */
import { countries } from '../src/lib/data/countries';
import type { CountryCode } from '../src/lib/data/types';
import {
  SELF_KEYWORDS,
  REGION_KEYWORDS,
  FOREIGN_KEYWORDS,
  otherCountryKeywords,
  isCountryRelevant,
} from '../src/lib/country-relevance';

const BASE = process.env.SITE_BASE || 'https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com';
const COUNTRIES: CountryCode[] = ['kz', 'uz', 'kg', 'az', 'tj'];
const DAYS = Number(process.argv[2] || 7);

/**
 * 2026-10-05 往**推送侧**新加的词。
 *
 * ⚠️ 这份清单必须与 `country-relevance.ts` 里那段「补齐」注释逐字对应。
 * 多写一个词 ⇒ 这里算出的「新排除」会偏少，体检就白做了。
 */
const ADDED_FOREIGN = [
  '土耳其', 'türkiye', 'turkey', 'turkish', '安卡拉', 'ankara',
  '北约', ' nato',
  '土库曼斯坦', 'turkmenistan', 'turkmen', '阿什哈巴德', 'ashgabat',
  '克里姆林宫', 'kremlin', '普京', 'putin',
];
const ADDED_REGION = ['central asia'];

interface Row {
  id: number; title: string; summary: string; content: string; source: string;
}

/** **改动前**的推送侧判据，逐字复现（顺序、兜底都与老代码一致）。 */
function legacyPushRelevant(title: string, summary: string, countryCode: string): boolean {
  const text = `${title} ${summary}`.toLowerCase();
  if ((SELF_KEYWORDS[countryCode as CountryCode] || []).some((kw) => text.includes(kw.toLowerCase()))) {
    return true;
  }
  if (
    REGION_KEYWORDS.filter((kw) => !ADDED_REGION.includes(kw)).some((kw) =>
      text.includes(kw.toLowerCase()),
    )
  ) {
    return true;
  }
  if (otherCountryKeywords(countryCode, 'push').some((kw) => text.includes(kw.toLowerCase()))) {
    return false;
  }
  if (
    FOREIGN_KEYWORDS.filter((kw) => !ADDED_FOREIGN.includes(kw)).some((kw) =>
      text.includes(kw.toLowerCase()),
    )
  ) {
    return false;
  }
  return true;
}

function beijingDates(days: number): string[] {
  const out: string[] = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    out.push(new Date(now - i * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }));
  }
  return out;
}

async function load(country: CountryCode, date: string): Promise<Row[]> {
  const res = await fetch(`${BASE}/api/articles?country=${country}&date=${date}&limit=300`);
  if (!res.ok) return [];
  const j = (await res.json()) as { articles: Row[] };
  return j.articles || [];
}

const visible = (s: string) => (s || '').replace(/<[^>]*>/g, ' ').replace(/https?:\/\/\S+/g, ' ');

async function main() {
  const dates = beijingDates(DAYS);
  let total = 0;
  let excludedNow = 0;
  let excludedBefore = 0;
  const newlyExcluded: Array<{ c: CountryCode; id: number; title: string; hit: string }> = [];
  const newlyIncluded: Array<{ c: CountryCode; id: number; title: string }> = [];

  for (const c of COUNTRIES) {
    for (const d of dates) {
      for (const r of await load(c, d)) {
        total++;
        const title = visible(r.title);
        const summary = visible(r.summary);
        const before = legacyPushRelevant(title, summary, c);
        const now = isCountryRelevant({ title, summary, countryCode: c });
        if (!before) excludedBefore++;
        if (!now) excludedNow++;
        if (before && !now) {
          const text = `${title} ${summary}`.toLowerCase();
          const hit = ADDED_FOREIGN.find((kw) => text.includes(kw.toLowerCase())) || '(区域词)';
          newlyExcluded.push({ c, id: r.id, title: r.title.slice(0, 60), hit });
        }
        if (!before && now) newlyIncluded.push({ c, id: r.id, title: r.title.slice(0, 60) });
      }
    }
  }

  console.log(`窗口 ${dates[dates.length - 1]} ~ ${dates[0]}（北京日期）｜共 ${total} 篇\n`);
  console.log('=== 汇总 ===');
  console.log(`  改前被排除：${excludedBefore} 篇（${((excludedBefore / (total || 1)) * 100).toFixed(2)}%）`);
  console.log(`  改后被排除：${excludedNow} 篇（${((excludedNow / (total || 1)) * 100).toFixed(2)}%）`);
  console.log(`  ⚠️ 新增排除（= 会少推的稿子）：${newlyExcluded.length} 篇`);
  console.log(`  ℹ️ 新增放行（区域词 central asia 带来的）：${newlyIncluded.length} 篇`);

  console.log('\n=== ★ 新增排除逐条（判读：`确实是别国新闻` / `其实是本国新闻 ⇒ 要回退那条词`）===');
  if (newlyExcluded.length === 0) console.log('  （无）—— 说明这批词在近 %d 天里没有影响任何一条稿子', DAYS);
  for (const x of newlyExcluded) {
    console.log(`  [${x.c}] ${x.title}　命中「${x.hit}」`);
  }

  console.log('\n=== 新增放行逐条（区域词带来的，确认不是放进了外国新闻）===');
  if (newlyIncluded.length === 0) console.log('  （无）');
  for (const x of newlyIncluded) {
    console.log(`  [${x.c}] ${x.title}`);
  }

  console.log(`\n（国家清单：${COUNTRIES.map((c) => `${c}=${countries[c].name}`).join(' ')}）`);
}

main();
