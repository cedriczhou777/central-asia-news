/**
 * 「最近一轮抓取」的验收体检（只读，不改任何数据）。
 *
 * 用法：
 *   pnpm analyze:last-round              # 默认取 id 最大的 300 篇当作「最近一轮」
 *   pnpm analyze:last-round 220          # 用上一轮 `summary.saved` 的篇数更准
 *   SITE_BASE=http://localhost:3000 pnpm analyze:last-round
 *
 * ## 存在的理由
 *
 * `analyze:nouns` 是**按发布日期**分桶的，而一轮抓取的稿子发布日期大多落在**前一天**
 * —— 于是「改口径前的老产出」和「改口径后的新产出」被混进同一个桶，
 * 跑出来是个平均数，看不出改动到底生效没有（2026-09-24 就踩了这个坑：
 * 按日期看 09-23 那天 T1 还有 3.2%，差点得出「提示词没用」的错误结论）。
 *
 * 正确的切法是**按 id**：id 自增，最后一轮入库的就是 id 最大的那批。
 * 这个脚本把「切出最近一轮」+「把 AGENTS.md 里那四条验收一次跑完」固化成一条命令。
 *
 * ## 怎么读
 *
 * 1. `T1 汉字+西里尔同词` —— **目标 0**。结构性错误（`米尔зиёё夫`），生产闸也会拦。
 * 2. `T2 拉丁+西里尔同词` —— 目标 0，但**判据盲区**：`mixedScriptTokens` 只管汉字+西里尔，
 *    看不见 `Kaрабалиева`／`KTЖ`／`BUТБ`。这里只是把它报出来，见 `analyze-proper-nouns` 的注释。
 * 3. 人名 —— **看「同篇混用」是否为 0**。这一条**不是**看「中文多还是拉丁多」：
 *    口径要求人名用拉丁，但实际产出里标题走中文、正文走拉丁的情况一直存在。
 * 4. 国名/城市 —— 看是不是**单独出现**的英文。嵌在 `Azerbaijan Airlines` 这种专名里的
 *    按口径是合法的，不算违规（判据见 `analyze-proper-nouns` 的 section 3）。
 *
 * ⚠️ `TAKE` 是要人给的：脚本无法从接口知道「上一轮存了多少篇」
 * （`GET /api/fetch-news` 的 `summary` 是**内存态**，一重新部署就没了）。
 * 所以它会先把切分点（id 区间）打出来 —— **先看这个区间对不对，再看结论**。
 */
import { mixedScriptTokens, mixedScriptTokensLatin } from '../src/lib/utils';

const BASE = process.env.SITE_BASE || 'https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com';
const COUNTRIES = ['kz', 'uz', 'kg', 'az', 'tj'];
const DAYS = Number(process.env.DAYS || 8);
const TAKE = Number(process.argv[2] || 300);

interface Row {
  id: number;
  title: string;
  summary: string;
  content: string;
  country: string;
}

/** 人名两种写法的候选形式。这是**口径的检查清单**，与 `analyze-proper-nouns` 保持一致。 */
const PERSONS: Array<{ label: string; zh: string[]; lat: string[] }> = [
  { label: 'Tokayev 托卡耶夫', zh: ['托卡耶夫'], lat: ['Tokayev', 'Токаев'] },
  { label: 'Japarov 扎帕罗夫', zh: ['贾帕罗夫', '扎帕罗夫'], lat: ['Japarov', 'Zhaparov', 'Жапаров'] },
  { label: 'Mirziyoyev 米尔济约耶夫', zh: ['米尔济约耶夫'], lat: ['Mirziyoyev', 'Мирзиёев'] },
  { label: 'Aliyev 阿利耶夫', zh: ['阿利耶夫', '阿里耶夫', '伊利哈姆'], lat: ['Aliyev', 'Алиев', 'İlham', 'Ilham'] },
  { label: 'Rahmon 拉赫蒙', zh: ['拉赫蒙'], lat: ['Rahmon', 'Раҳмон'] },
  { label: 'Erdoğan 埃尔多安', zh: ['埃尔多安'], lat: ['Erdoğan', 'Erdogan', 'Эрдоған'] },
  { label: 'Putin 普京', zh: ['普京'], lat: ['Putin', 'Путин'] },
];

/** 应与 `analyze-proper-nouns` 的 SHOULD_BE_CHINESE 一致 */
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
const LC = /[A-Za-z]/;
const SPLIT = /[\s，。、；：（）()「」“”"'·—\-–/《》【】!?！？]+/;

const beijingDates = (days: number) =>
  Array.from({ length: days }, (_, i) =>
    new Date(Date.now() - i * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }),
  );

/** 去掉 HTML 标签、链接、图片文件名 —— 剩下的才是「读者能看见的文字」 */
const visible = (s: string) =>
  (s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\S+\.(png|jpe?g|gif|webp|svg)\b/gi, ' ');

async function load(country: string, date: string): Promise<Row[]> {
  const res = await fetch(`${BASE}/api/articles?country=${country}&date=${date}&limit=300`);
  if (!res.ok) return [];
  const j = (await res.json()) as { articles: Row[] };
  return j.articles.map((a) => ({ ...a, country }));
}

const pct = (n: number, d: number) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);

async function main() {
  const all: Row[] = [];
  for (const d of beijingDates(DAYS)) for (const c of COUNTRIES) all.push(...(await load(c, d)));
  if (!all.length) {
    console.error('没取到任何行 —— 检查 SITE_BASE 与日期窗口');
    process.exit(1);
  }
  const seen = new Set<number>();
  const uniq = all.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  uniq.sort((a, b) => b.id - a.id);

  const recent = uniq.slice(0, TAKE);
  const older = uniq.slice(TAKE);
  console.log(`窗口 ${DAYS} 天 × ${COUNTRIES.length} 国 ｜ 去重后 ${uniq.length} 篇`);
  console.log(`\n【切分点】最近一轮 = ${recent.length} 篇，id ${Math.min(...recent.map((r) => r.id))}–${Math.max(...recent.map((r) => r.id))}`);
  console.log(`           历史各轮 = ${older.length} 篇，id ≤ ${Math.max(...older.map((r) => r.id))}`);
  console.log('⚠️ 先确认这个 id 区间就是你想验的那一轮，再看下面的数\n');

  // ---------- 1 / 2：书写系统混用 ----------
  const t1 = (rows: Row[]) =>
    rows.filter((r) => [r.title, r.summary, r.content].some((f) => mixedScriptTokens(f || '').length)).length;
  const t2 = (rows: Row[]) =>
    rows.filter((r) =>
      [r.title, r.summary, r.content].some((f) => visible(f).split(SPLIT).some((t) => LC.test(t) && CYR.test(t))),
    ).length;
  // T3 汉字+拉丁粘连 —— 用户 09-24 第二次报的那一类（`斯皮塔梅en区`，id=4492）。
  //
  // ⚠️ **T1 为 0 不代表「全清」**：`mixedScriptTokens` 只抓汉字+西里尔，
  // 对这类完全无感。这条判据（`utils.mixedScriptTokensLatin`）目前**还没进生产闸**，
  // 所以这里的「最近一轮」数字就是「新提示词到底管不管得住」的直接答案：
  //   - 最近一轮 ≈ 0 而历史明显多 ⇒ 提示词已经管住了，用户在截图里看到的是**改口径前的存量行**
  //     （被补发/回看窗口重新捞出来推的），修法在「清理存量」而不是「加闸」；
  //   - 最近一轮仍然有 ⇒ 提示词管不住（它第 6 条早就逐字写了 `斯皮塔梅en` 这个反例），
  //     必须把判据接进生产闸。
  const t3 = (rows: Row[]) =>
    rows.filter((r) =>
      [r.title, r.summary, r.content].some((f) => mixedScriptTokensLatin(visible(f)).length),
    ).length;
  console.log('=== 验收 1（书写系统混用）===');
  console.log(`  T1 汉字+西里尔：最近一轮 ${t1(recent)} 篇（${pct(t1(recent), recent.length)}）  ／ 历史 ${t1(older)} 篇（${pct(t1(older), older.length)}）`);
  console.log(`  T2 拉丁+西里尔：最近一轮 ${t2(recent)} 篇（${pct(t2(recent), recent.length)}）  ／ 历史 ${t2(older)} 篇（${pct(t2(older), older.length)}）`);
  console.log(`  T3 汉字+拉丁：  最近一轮 ${t3(recent)} 篇（${pct(t3(recent), recent.length)}）  ／ 历史 ${t3(older)} 篇（${pct(t3(older), older.length)}）　★ 这一行才是用户报的那一类`);
  // 最近一轮的 T3 逐条打出来（数量应很少）—— 有它才判得出「该加闸还是该清存量」
  for (const r of recent) {
    for (const [where, raw] of [
      ['标题', r.title],
      ['摘要', r.summary],
      ['正文', r.content],
    ] as Array<[string, string]>) {
      for (const tok of mixedScriptTokensLatin(visible(raw))) {
        const m = tok.match(/[a-z]{2,}/);
        const at = m && m.index !== undefined ? m.index : 0;
        console.log(
          `    ★ T3 [${r.id}][${r.country}] ${where}：…${tok.slice(Math.max(0, at - 14), at + 16)}…`,
        );
      }
    }
  }

  // ---------- 3：人名「同篇混用」（这一条才是要盯的）----------
  console.log('\n=== 验收 2（人名：同篇混用应为 0）===');
  let totalBoth = 0;
  for (const p of PERSONS) {
    const calc = (rows: Row[]) => {
      let zh = 0, lat = 0, both = 0;
      for (const r of rows) {
        const t = `${r.title} ${r.summary} ${r.content}`;
        const hz = p.zh.some((s) => t.includes(s));
        const hl = p.lat.some((s) => t.includes(s));
        if (hz && hl) both++;
        else if (hz) zh++;
        else if (hl) lat++;
      }
      return { zh, lat, both };
    };
    const a = calc(recent);
    const b = calc(older);
    if (a.zh + a.lat + a.both + b.zh + b.lat + b.both === 0) continue;
    totalBoth += a.both;
    console.log(
      `  ${a.both > 0 ? '❌' : '✅'} ${p.label.padEnd(24)} 最近一轮 中文${a.zh}/拉丁${a.lat}/**混用${a.both}**  ｜ 历史 中文${b.zh}/拉丁${b.lat}/混用${b.both}`,
    );
  }
  console.log(`  ⇒ 最近一轮同篇混用合计 ${totalBoth} 处（历史口径改前为 15/1757 = 0.85%）`);

  // ---------- 4：国名/城市是否单独写成英文 ----------
  console.log('\n=== 验收 3（国名/城市：单独出现的英文才算违规）===');
  const glued = (f: string, idx: number, len: number) => {
    const l = f.slice(0, idx).match(/[A-Za-z][A-Za-z'&.-]*\s*$/);
    const r = f.slice(idx + len).match(/^\s*[A-Za-z][A-Za-z'&.-]*/);
    return Boolean((l && l[0].trim()) || (r && r[0].trim()));
  };
  let bare = 0;
  for (const s of SHOULD_BE_CHINESE) {
    const re = new RegExp(`\\b${s.en}\\b`);
    let nameN = 0;
    let bareN = 0;
    for (const r of recent) {
      for (const raw of [r.title, r.summary, r.content]) {
        const f = visible(raw);
        const m = re.exec(f);
        if (!m || m.index === undefined) continue;
        const isName = glued(f, m.index, m[0].length);
        if (isName) nameN++;
        else {
          bareN++;
          console.log(`    ★ 疑似违规 [${r.id}][${r.country}]：…${f.slice(Math.max(0, m.index - 45), m.index + 55).replace(/\s+/g, ' ')}…`);
        }
      }
    }
    bare += bareN;
    if (nameN + bareN > 0) console.log(`  ${bareN > 0 ? '❌' : '△'} ${s.cn}：专名括注 ${nameN} 处 ／ 疑似单独违规 ${bareN} 处`);
  }
  console.log(`  ⇒ 疑似单独违规合计 ${bare} 处（逐条看上面的 ★，引用英文原标题/专名括注不算违规）`);

  // ---------- 5：掉稿（按国家篇数）----------
  console.log('\n=== 验收 4（有没有整体掉稿）===');
  for (const c of COUNTRIES) {
    const n = recent.filter((r) => r.country === c).length;
    console.log(`  ${c}: ${String(n).padStart(3)} 篇`);
  }
}

main();
