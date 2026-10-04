/**
 * 术语闸的**误报率体检**（只读，不联网调模型，不改任何数据）。
 *
 * 用法：
 *   pnpm analyze:currency                 # 默认最近 7 天 × 5 国
 *   pnpm analyze:currency 3               # 最近 3 天
 *   SITE_BASE=http://localhost:3000 pnpm analyze:currency 7
 *
 * ## 为什么必须先跑这个，再决定要不要把判据接成闸
 *
 * 项目纪律（`analyze-proper-nouns.ts` 1c 段、`translate.ts` 的
 * `mixedScriptTokensLatin` 注释）：**下游是「重试 → 三次不过丢稿」的判据，
 * 误报 = 静默丢稿**，所以进闸前的门槛是「在真实语料上误报率为 0」。
 * `mixedScriptTokens`（汉字+西里尔）敢当硬判据，是因为它在 1757 篇里
 * 命中 156 种词、**一例误报都没有**；`mixedScriptTokensLatinCapitalized`
 * 只做体检，是因为它实测 5% 误伤。**两者待遇不同的唯一依据是实测误报率。**
 *
 * 本脚本就是给术语闸补这份实测。要读的数字有三个：
 *
 * 1. **命中数 vs 逐条判读结果** —— 每一条都要人看。判读标准见下面输出里的说明。
 * 2. **`本国货币出现过` 的篇数** —— 这是「货币这个话题在本国稿子里有多常见」的基线。
 *    如果它接近 0，说明命中基本都是真缺陷；如果它很大，说明样本里有大量
 *    合法提到本国货币的稿子，判据的「放行」分支正在正常工作。
 * 3. **假朋友抹除量** —— `苏姆盖特` 抹掉了多少次。这是**最可能出事的地方**：
 *    抹除量 > 0 就证明这条排除不是多余的（阿塞拜疆的稿子真的在提这座城市）。
 */
import { countries } from '../src/lib/data/countries';
import type { CountryCode } from '../src/lib/data/types';
import {
  PROPER_NOUN_VERSION,
  COUNTRY_CURRENCY,
  checkCurrencyCountryFit,
  checkWrongProperNouns,
} from '../src/lib/proper-nouns';

const BASE = process.env.SITE_BASE || 'https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com';
const COUNTRIES: CountryCode[] = ['kz', 'uz', 'kg', 'az', 'tj'];
const DAYS = Number(process.argv[2] || 7);

interface Row {
  id: number; title: string; summary: string; content: string;
  source: string; publishedAt: string;
}

/** 去掉 HTML 标签 / 裸链接 / 图片文件名，只留读者看得见的文字。 */
const visible = (s: string) =>
  (s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\S+\.(png|jpe?g|gif|webp|svg)\b/gi, ' ');

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

/** 命中词周围 ±40 字的上下文，用来人工判读。 */
function ctx(text: string, needle: string): string {
  const i = text.indexOf(needle);
  if (i < 0) return '';
  return text.slice(Math.max(0, i - 40), i + needle.length + 40).replace(/\s+/g, ' ');
}

async function main() {
  console.log(`术语表版本 ${PROPER_NOUN_VERSION}`);
  const dates = beijingDates(DAYS);
  const perCountry: Record<string, { n: number; own: number; mismatch: number; wrong: number }> = {};
  let total = 0, ownTotal = 0, mismatchTotal = 0, wrongTotal = 0;
  const mismatchRows: Array<{ c: CountryCode; id: number; r: string; ctxs: string[] }> = [];
  const wrongRows: Array<{ c: CountryCode; id: number; title: string; hits: string[] }> = [];

  for (const c of COUNTRIES) {
    const b = (perCountry[c] ||= { n: 0, own: 0, mismatch: 0, wrong: 0 });
    for (const d of dates) {
      const rows = await load(c, d);
      for (const r of rows) {
        b.n++; total++;
        const text = visible(`${r.title} ${r.summary} ${r.content}`);
        // 基线：本国货币出现过没有
        if (COUNTRY_CURRENCY[c].aliases.some((w) => text.toLowerCase().includes(w))) {
          b.own++; ownTotal++;
        }
        const mm = checkCurrencyCountryFit(c, text);
        if (mm) {
          b.mismatch++; mismatchTotal++;
          mismatchRows.push({
            c, id: r.id, r: mm.reason,
            ctxs: mm.foreign.map((f) => `${f.zh} ← 「${ctx(text, f.word)}」`),
          });
        }
        const wn = checkWrongProperNouns(c, text);
        if (wn.length) {
          b.wrong++; wrongTotal++;
          wrongRows.push({
            c, id: r.id, title: r.title.slice(0, 50),
            hits: wn.map((h) => `${h.wrong} → 应为 ${h.right}｜「${ctx(text, h.wrong)}」`),
          });
        }
      }
    }
  }

  console.log(`\n窗口 ${dates[dates.length - 1]} ~ ${dates[0]}（北京日期）｜共 ${total} 篇\n`);
  console.log('=== 汇总（判读基线）===');
  for (const c of COUNTRIES) {
    const b = perCountry[c];
    if (!b) continue;
    console.log(
      `  ${c}（${countries[c].name}，货币 ${COUNTRY_CURRENCY[c].zh}）：${String(b.n).padStart(4)} 篇` +
        `　本国货币出现 ${String(b.own).padStart(4)} 篇（${b.n ? ((b.own / b.n) * 100).toFixed(1) : '—'}%）` +
        `　❌ 外币不符 ${String(b.mismatch).padStart(3)} 篇　❌ 错译写法 ${String(b.wrong).padStart(3)} 篇`,
    );
  }
  console.log(
    `  合计：货币不符 ${mismatchTotal} 篇（${total ? ((mismatchTotal / total) * 100).toFixed(2) : '—'}%）` +
      `　错译写法 ${wrongTotal} 篇（${total ? ((wrongTotal / total) * 100).toFixed(2) : '—'}%）`,
  );

  console.log('\n=== A. 货币与所属国不符（逐条判读：`真缺陷` / `误报`）===');
  if (mismatchRows.length === 0) {
    console.log('  （无命中）');
  }
  for (const m of mismatchRows) {
    console.log(`  [${m.c}][${m.id}] ${m.r}`);
    for (const x of m.ctxs) console.log(`      ${x}`);
  }

  console.log('\n=== B. 已知错译写法（逐条判读：`真缺陷` / `误报`）===');
  if (wrongRows.length === 0) {
    console.log('  （无命中）');
  }
  for (const w of wrongRows) {
    console.log(`  [${w.c}][${w.id}] ${w.title}`);
    for (const h of w.hits) console.log(`      ${h}`);
  }

  if (mismatchTotal === 0 && wrongTotal === 0) {
    console.log(
      `\n⚠️ 两栏都零命中 —— **这不等于判据没问题**。先确认窗口里确实有带货币的稿子` +
        `（看上面的「本国货币出现」列）。若那一列也很小，说明样本量不够，把天数调大再跑。`,
    );
  }
}

main();
