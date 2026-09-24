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
import {
  hanCount,
  hanRatio,
  mixedScriptTokens,
  mixedScriptTokensLatin,
  MIN_HAN_TITLE,
  MIN_HAN_CONTENT,
} from '../src/lib/utils';

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

/**
 * 去掉 HTML 标签、裸链接、图片文件名 —— 剩下的才是**读者能看见的文字**。
 *
 * 提到模块作用域是为了让 1c 段也能用（1c 在 section 3 之前执行，原来那个
 * 函数体内部的 `const` 会撞上 TDZ）。判据的完整理由写在 section 3 那里。
 */
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

  // ---------- 1b. 判据盲区：拉丁 + 西里尔同词（**仅报告，不进生产闸**）----------
  //
  // 为什么单列一段：`mixedScriptTokens` 只抓「汉字+西里尔」，
  // 所以 T1 = 0 会被读成「全清」，但它对下面这一类**完全无感**：
  //   - `BUТБ`（白俄罗斯统一商品交易所 БУТБ，B/U 拉丁 + Т/Б 西里尔）
  //   - `Guly Kожокулова`（K 拉丁 + ожокулова 西里尔）
  //   - `Mirlan Жеенчороев`（人名整个漏成西里尔，夹在中文里）
  // 前两类是「同一个词里混两种字母」，结构与 T1 同类，只是字母对换了。
  //
  // ⚠️ **为什么不直接加进 `mixedScriptTokens`**：那个函数在生产链路上
  // （`translate.ts:421`），下游是「重试 → 三次不过就丢稿」，
  // 按项目既有纪律（下游是丢弃的判据宁漏不误杀）必须先拿语料量误报率再决定。
  // 这里先把它**变成看得见的数字**，攒够证据再谈要不要进闸。
  // 第三类（整词漏译）连「同词混排」都不是，本段也抓不到，属已知盲区。
  const LC = /[A-Za-z]/;
  const CYR2 = /[\u0400-\u04ff]/;
  let t2 = 0;
  const t2Words = new Map<string, number>();
  for (const r of all) {
    const hits = [r.title, r.summary, r.content].flatMap((f) =>
      (f || '')
        .split(/[\s，。、；：（）()「」“”"'·—\-–/《》【】!?！？]+/)
        .filter((tok) => LC.test(tok) && CYR2.test(tok)),
    );
    if (hits.length) t2++;
    for (const h of hits) t2Words.set(h, (t2Words.get(h) || 0) + 1);
  }
  console.log(`\n=== 1b. 判据盲区：拉丁+西里尔同词（仅报告）===`);
  console.log(`  T2 命中：${t2} 篇（${pct(t2, all.length)}）｜目标 0，但**不进生产闸**，见源码注释`);
  if (t2Words.size) {
    console.log('  T2 样本（前 15）：');
    for (const [w, n] of [...t2Words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`    ${String(n).padStart(3)}×  ${w}`);
    }
  }

  // ---------- 1c. 汉字 + 拉丁粘连（用户 09-24 第二次报的那一类）----------
  //
  // 判据本体在 `utils.mixedScriptTokensLatin`（注释里写了它为什么收窄到「拉丁片段全小写且 ≥2」）。
  // 这里量的是**误报率**：逐条把命中处的上下文打出来，人工判每一条是
  // 「译文真缺陷」还是「正常的中英混排」（`开启wifi` 这类同形）。
  //
  // ⚠️ 为什么必须先量再进闸：这条判据的下游是「重试 → 三次不过就丢弃该篇」
  // （`translate.ts` 的 normalizeResult），**误报 = 静默丢稿**。
  // 参照 `mixedScriptTokens`（汉字+西里尔）进闸的理由：那条在 1757 篇里
  // 命中 156 种词、**一例误报都没有**，所以它敢当硬判据。这一条要先证明同样干净。
  console.log('\n=== 1c. 汉字+拉丁粘连（仅报告，量误报率后再决定是否进闸）===');
  const t3Ctx: Array<{ id: number; country: string; where: string; ctx: string }> = [];
  const t3Words = new Map<string, number>();
  const t3ByCountry: Record<string, number> = {};
  let t3 = 0;
  for (const r of all) {
    let hit = false;
    for (const [where, raw] of [
      ['标题', r.title],
      ['摘要', r.summary],
      ['正文', r.content],
    ] as Array<[string, string]>) {
      for (const tok of mixedScriptTokensLatin(visible(raw))) {
        hit = true;
        // token 可能是一整个短语（切分只按标点/空白），所以只截取拉丁片段周围 ±14 字
        const m = tok.match(/[a-z]{2,}/);
        const at = m && m.index !== undefined ? m.index : 0;
        const snippet = tok.slice(Math.max(0, at - 14), at + 16);
        t3Words.set(snippet, (t3Words.get(snippet) || 0) + 1);
        if (t3Ctx.length < 40) t3Ctx.push({ id: r.id, country: r.country, where, ctx: snippet });
      }
    }
    if (hit) {
      t3++;
      t3ByCountry[r.country] = (t3ByCountry[r.country] || 0) + 1;
    }
  }
  console.log(
    `  T3 命中：${t3} 篇（${pct(t3, all.length)}）` +
      `　按国家：${Object.entries(t3ByCountry).map(([c, n]) => `${c}=${n}`).join(' ') || '无'}`,
  );
  if (t3Ctx.length) {
    console.log('  ↓ 命中上下文（最多 40 条）—— 判读标准：');
    console.log('     `译文真缺陷` = 专名被译了一半（`斯皮塔梅en`／`霍贾and`／`纳赫ichevan`）');
    console.log('     `正常混排`   = 小写外文词整词附着（`开启wifi`／`微信wx`／`50公里km`）—— 这类就是误报');
    for (const h of t3Ctx) {
      console.log(`    [${h.id}][${h.country}] ${h.where}：…${h.ctx}…`);
    }
  }
  if (t3Words.size) {
    console.log('  命中片段频次（前 15）—— **同一个片段重复出现是好消息**（说明是少数几种坏词）：');
    for (const [w, n] of [...t3Words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`    ${String(n).padStart(3)}×  …${w}…`);
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
  //
  // ⚠️ 这里扫的是**可见正文**，必须先剥掉 `<img src="...">` 与裸链接。
  // 2026-09-24 实测：第一次跑出来「Uzbekistan 1 篇 / Azerbaijan 2 篇」，逐条看全是误报 ——
  //   - `National-Olympic-Committee-of-Uzbekistan.png`（图片文件名）
  //   - 「阿塞拜疆国家铁路公司（Azerbaijan State Railways Company）」（机构名括注，口径本来就要求拉丁）
  //   - `DanceAbility Azerbaijan`（机构名）
  // 即 **3/3 命中都是误报**。判据本身要问的是「译文里有没有把国名写成英文」，
  // 图片 URL 和机构名括注都不是「译文写成英文」。不剥就每次都被这几条干扰，
  // 久了就会像「狼来了」一样把这条护栏忽略掉 —— 这正是护栏失效的典型死法。
  console.log('\n=== 3. 国名/州名/城市应为中文（出现英文即第二版口径回归）===');
  console.log('  （已剥掉 HTML 标签 / 链接 / 图片文件名；机构名的英文括注不算违规）');
  let anyRegression = false;
  /**
   * 扫描范围 = 标题 + 摘要 + **剥掉标签/链接后的正文**。
   * 原来只扫标题+摘要，说明它**看不见正文里的英文地名** ——
   * 而「国名写成英文」恰恰可能只出现在正文里。漏扫比误报更危险（误报看得见，漏扫看不见）。
   */
  /**
   * 命中词左右（跨空格）是否还连着别的拉丁词。
   *
   * 连着 ⇒ 这是**西文专名/机构名**的一部分（`inDrive Kazakhstan`、
   * `Kazakhstan Travel Forum 2026`、`State Oil Fund of Azerbaijan`、
   * 「阿塞拜疆国家航空公司（Azerbaijan Airlines）」），按口径**本来就该是拉丁**，不是违规。
   * 单独蹦出来 ⇒ 才是「把国名写成英文」。
   *
   * 为什么非要加这条：实测 8 天 12 个国名、28 处命中，**逐条看完 28/28 全是专名括注**。
   * 一个每次都报 11 个假警报的护栏，下场就是被无视 —— 那还不如不报。
   * （保守起见：连着的仍会打印出来，只是不算违规，人工想复核还能复核。）
   */
  const gluedToLatin = (f: string, idx: number, len: number) => {
    const left = f.slice(0, idx).match(/[A-Za-z][A-Za-z'&.-]*\s*$/);
    const right = f.slice(idx + len).match(/^\s*[A-Za-z][A-Za-z'&.-]*/);
    return Boolean((left && left[0].trim()) || (right && right[0].trim()));
  };
  const enHits: Array<{ id: number; country: string; cn: string; en: string; where: string; ctx: string; name: boolean }> = [];
  for (const { cn, en } of SHOULD_BE_CHINESE) {
    const re = new RegExp(`\\b${en}\\b`);
    const cnN = all.filter((r) => visible(`${r.title} ${r.summary}`).includes(cn)).length;
    let enN = 0;
    let bareN = 0;
    for (const r of all) {
      for (const [where, raw] of [
        ['标题', r.title],
        ['摘要', r.summary],
        ['正文', r.content],
      ] as Array<[string, string]>) {
        const f = visible(raw);
        const m = re.exec(f);
        if (!m || m.index === undefined) continue;
        enN++;
        const name = gluedToLatin(f, m.index, m[0].length);
        if (!name) bareN++;
        // 「疑似违规」**全部**打印（数量少、每条都要人看）；
        // 「专名括注」只打前 25 条（数量多、且按口径合法，打全了会淹掉前者）。
        if (!name || enHits.length < 25) {
          enHits.push({
            id: r.id,
            country: r.country,
            cn,
            en,
            where,
            ctx: f.slice(Math.max(0, m.index - 45), m.index + 55).replace(/\s+/g, ' '),
            name,
          });
        }
      }
    }
    if (bareN > 0) anyRegression = true;
    const tag = bareN > 0 ? '❌ 疑似违规' : enN > 0 ? '△ 仅专名括注' : '✓';
    console.log(
      `  ${tag} ${cn}：中文标题 ${String(cnN).padStart(3)} 篇 ／ 英文 ${en}：${enN} 处` +
        `${enN > 0 ? `（其中疑似单独违规 ${bareN} 处）` : ''}`,
    );
  }
  if (enHits.length) {
    console.log('  ↓ 逐条（`专名括注` = 左右连着别的拉丁词，按口径合法；`★ 疑似违规` = 单独出现）');
    for (const h of enHits) {
      console.log(`    ${h.name ? '专名括注' : '★ 疑似违规'} [${h.id}][${h.country}] ${h.where} 命中 ${h.en}：…${h.ctx}…`);
    }
  }
  if (anyRegression) {
    console.log('  ⚠️ 有单独出现的英文地名 → 第 6 条的「国名/州名/城市 → 中文」可能没被遵守');
  } else {
    console.log('  ✅ 没有单独出现的英文地名（命中的都嵌在西文专名里，符合口径）');
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
