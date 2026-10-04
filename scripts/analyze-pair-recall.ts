/**
 * 召回下限（`PAIR_CANDIDATE_MIN_SIM`）的**影响面体检** —— 只读，不调模型，不改数据。
 *
 * 用法：
 *   pnpm analyze:pair-recall          # 最近 7 天 × 5 国
 *   pnpm analyze:pair-recall 3
 *
 * ## 为什么这一步必须先跑
 *
 * 用户这两天的投诉里有 5 条是「同一件事推了两遍」。L2 是一条流水线：
 *
 *   确定性去重(L0/L1/L1.5) → candidatePairs 召回 → 模型逐对二选一 → 簇合并
 *
 * **召回漏了，后面再准也没用**。所以先要回答的是：用户看到的那几对重复，
 * 是真的「排不进候选」，还是「进了候选但模型没判出来」，抑或「两条压根不在同一批里
 * （跨批次/跨天）——那时调阈值一点用都没有」。
 *
 * ## ★ 第 6 节是本次最重要的产出
 *
 * 库里的稿子是**整条流水线跑完**的结果。所以库里出现一对 sim ≥ `LEGACY_FLOOR` 的稿子，
 * 只有三种解释：
 *
 *   (A) **它压根没进候选** —— 排不进 `PAIR_MAX_CANDIDATES`。⇒ 修**名额/排序**；
 *   (B) **它进了候选、模型判了「不是同一件事」**。⇒ 修**提示词/模型**；
 *   (C) **被 `hasOppositePolarity` 确定性拦下**（方向相反，本来就**不该**合并）。
 *
 * 三者的修法完全不同，而只看「阈值是多少」是分不出来的 —— 这正是「阈值不能拍」的由来。
 * 本脚本用 `candidatePairs` 的**同一份实现**重算候选，把 (A) 逐条打出来。
 *
 * 判读标准：
 *   · (A) 多 → 瓶颈在 **12 个名额**，降下限只会让名额更紧张（要单独解决）；
 *   · (B) 多 → 瓶颈在**判据/提示词**，与阈值无关；
 *   · `新增候选` 里出现「明显同一件事」→ 旧下限确实太高；
 *   · `跨天相似对` 多 → 问题在**窗口**，与本阈值无关。
 */
import { countries } from '../src/lib/data/countries';
import type { CountryCode } from '../src/lib/data/types';
import {
  candidatePairs,
  dedupeStoriesDeterministic,
  hasOppositePolarity,
  PAIR_CANDIDATE_MIN_SIM,
  PAIR_MAX_CANDIDATES,
  PAIR_PRIORITY_SIM,
  type StoryLike,
} from '../src/lib/same-event';
import { similarity } from '../src/lib/utils';

const BASE =
  process.env.SITE_BASE || 'https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com';
const COUNTRIES: CountryCode[] = ['kz', 'uz', 'kg', 'az', 'tj'];
const DAYS = Number(process.argv[2] || 7);

/** 观察用的下限：比现值再低一档，用来看「还要不要再降」。 */
const WATCH_FLOOR = 0.12;
/**
 * **改动前**的召回下限（2026-10-05 前 = 0.35）。
 *
 * ⚠️ 必须写成字面量、**不能** import `PAIR_CANDIDATE_MIN_SIM` —— 那个常量已经改成 0.20，
 * 拿它当「旧值」会让「改动前后」两次运行变成同一次，脚本就不再是验证工具了。
 */
const LEGACY_FLOOR = 0.35;
/** 当前实现的下限（= `PAIR_CANDIDATE_MIN_SIM`）。 */
const NEW_FLOOR = PAIR_CANDIDATE_MIN_SIM;

interface Row {
  id: number;
  title: string;
  summary: string;
  content: string;
  country: string;
  sourceUrl: string;
  source: string;
  publishedAt: string;
}

function beijingDates(days: number): string[] {
  const out: string[] = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    out.push(
      new Date(now - i * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }),
    );
  }
  return out;
}

/**
 * ★ 把一条稿子映射到它**真正所属的那一轮推送**。
 *
 * ## 为什么这一步必须做（2026-10-05 纠正）
 *
 * 第一版按「国别 + 北京日期」分组，量出来每批 **200+ 条** —— 而真实推送每批只有 ~15 条。
 * 差异的来源：`GET /api/articles` 返回的是**当天入库的全部稿子**，
 * 而推送只吃 `PUBLISH_SCHEDULES` 给出的那 **12 小时窗口**。
 *
 * 这个单位错得**很致命**，而且方向是「把问题放大」：
 * 用户报的重复是**同一份公众号草稿里出现两条**，那就必须落在**同一个窗口**里。
 * 跨窗口的两条（一条 05:00、一条 10:00）分别进早报和晚报，用户根本不会并排看到它们
 * —— 把它们算成「该合并没合并」是冤枉代码。
 *
 * 窗口定义（北京时区，来自 `PUBLISH_SCHEDULES`）：
 *   · 早报 07:00 触发，回看 12h ⇒ `[前一日 19:00, 当日 07:00)`
 *   · 晚报 19:00 触发，回看 12h ⇒ `[当日 07:00, 当日 19:00)`
 *
 * ⚠️ 所以 **19:00 之后发的稿子属于「次日早报」**，不是当天晚报。这一点最容易写错。
 */
function pushWindowOf(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  // 直接加到 UTC 时间戳上，再用 getUTC* 读 —— 等价于「北京墙上时间」，且不用管本机时区。
  const bj = new Date(t + 8 * 3600 * 1000);
  const y = bj.getUTCFullYear();
  const m = String(bj.getUTCMonth() + 1).padStart(2, '0');
  const d = String(bj.getUTCDate()).padStart(2, '0');
  const h = bj.getUTCHours();
  const day = `${y}-${m}-${d}`;
  if (h < 7) return `${day} 早报`;
  if (h < 19) return `${day} 晚报`;
  return `${new Date(bj.getTime() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'UTC' })} 早报`;
}

async function load(country: CountryCode, date: string): Promise<Row[]> {
  const res = await fetch(`${BASE}/api/articles?country=${country}&date=${date}&limit=300`);
  if (!res.ok) return [];
  const j = (await res.json()) as { articles: Row[] };
  return j.articles || [];
}

const visible = (s: string) =>
  (s || '').replace(/<[^>]*>/g, ' ').replace(/https?:\/\/\S+/g, ' ').trim();

/** 最长公共子串长度 —— 用来快速判断「像不像同一件事」，比标题肉眼比对可靠。 */
function lcsLen(a: string, b: string): number {
  const norm = (s: string) => s.replace(/[\s，。：、！？·—「」“”()（）0-9.,:;]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  let best = 0;
  let prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] === y[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

const pairKey = (a: number, b: number) => `${a}-${b}`;

function toStories(rows: Row[]): StoryLike[] {
  return rows.map((r) => ({
    title: visible(r.title),
    content: visible(r.content),
    summary: visible(r.summary),
    country_code: r.country,
    // ⚠️ `/api/articles` **不返回** original_content / original_title，
    // 所以 L1（原文指纹）在本脚本里是失效的（见第 0 节的 2812→2812）。
    source_url: r.sourceUrl || '',
    original_title: '',
  }));
}

async function main() {
  // 多取一天：最早那天的「早报」窗口横跨前一日 19:00。
  const dates = beijingDates(DAYS + 1);
  const buckets = new Map<string, number>();
  const bucketOf = (s: number) => {
    if (s >= 0.9) return '≥0.90';
    if (s >= 0.7) return '0.70–0.90';
    if (s >= 0.5) return '0.50–0.70';
    if (s >= 0.35) return '0.35–0.50';
    if (s >= 0.25) return '0.25–0.35';
    if (s >= 0.20) return '0.20–0.25';
    if (s >= WATCH_FLOOR) return `${WATCH_FLOOR}–0.20`;
    return '<' + WATCH_FLOOR;
  };

  let totalRows = 0;
  let totalKept = 0;
  let batchCount = 0;

  interface P {
    c: string;
    d: string;
    sim: number;
    lcs: number;
    veto: boolean;
    a: string;
    b: string;
  }
  const added: P[] = [];
  const lost: P[] = [];
  const tail: P[] = [];
  // 第 6 节：库里 sim ≥ 0.35 却两条都在（= 没被合并）的对，按原因分类
  const highNotAsked: P[] = []; // (A) 排不进 12
  const highAsked: P[] = []; // (B) 问了、模型没判出来
  const highVetoed: P[] = []; // (C) 极性拦下（正常）
  const batchRows: Array<{
    c: string;
    d: string;
    kept: number;
    ge35: number;
    ge20: number;
    chosen35: number;
    chosen20: number;
  }> = [];

  for (const c of COUNTRIES) {
    // ★ 先按**推送窗口**分组，而不是按北京日期（见 `pushWindowOf` 的说明）。
    const byWindow = new Map<string, StoryLike[]>();
    const rawByWindow = new Map<string, number>();
    for (const d of dates) {
      const rows = await load(c, d);
      if (rows.length === 0) continue;
      totalRows += rows.length;
      for (const r of rows) {
        const w = pushWindowOf(r.publishedAt);
        if (!w) continue;
        const key = `${c}|${w}`;
        const arr = byWindow.get(key) || [];
        arr.push(...toStories([r]));
        byWindow.set(key, arr);
        rawByWindow.set(key, (rawByWindow.get(key) || 0) + 1);
      }
    }

    for (const [key, stories] of [...byWindow.entries()].sort()) {
      const [cc, ...rest] = key.split('|');
      const w = rest.join('|');
      const { kept } = dedupeStoriesDeterministic(stories);
      totalKept += kept.length;
      if (kept.length < 2) continue;
      batchCount++;

      const pairs: Array<{ a: number; b: number; sim: number }> = [];
      for (let i = 0; i < kept.length; i++) {
        for (let j = i + 1; j < kept.length; j++) {
          const s = similarity(kept[i].title || '', kept[j].title || '');
          if (s >= WATCH_FLOOR) pairs.push({ a: i, b: j, sim: s });
        }
      }
      if (pairs.length === 0) continue;
      for (const p of pairs) {
        const k = bucketOf(p.sim);
        buckets.set(k, (buckets.get(k) || 0) + 1);
      }

      const pickedOld = candidatePairs(kept, LEGACY_FLOOR, PAIR_MAX_CANDIDATES);
      const pickedNew = candidatePairs(kept, NEW_FLOOR, PAIR_MAX_CANDIDATES);
      const keyOld = new Set(pickedOld.map((p) => pairKey(p.a, p.b)));
      const keyNew = new Set(pickedNew.map((p) => pairKey(p.a, p.b)));

      const mk = (p: { a: number; b: number; sim: number }): P => ({
        c: cc,
        d: w,
        sim: p.sim,
        lcs: lcsLen(kept[p.a].title, kept[p.b].title),
        veto: hasOppositePolarity(kept[p.a].title, kept[p.b].title),
        a: kept[p.a].title,
        b: kept[p.b].title,
      });

      batchRows.push({
        c: cc,
        d: w,
        kept: kept.length,
        ge35: pairs.filter((p) => p.sim >= LEGACY_FLOOR).length,
        ge20: pairs.filter((p) => p.sim >= NEW_FLOOR).length,
        chosen35: pickedOld.length,
        chosen20: pickedNew.length,
      });

      for (const p of pickedNew) if (!keyOld.has(pairKey(p.a, p.b))) added.push(mk(p));
      for (const p of pickedOld) if (!keyNew.has(pairKey(p.a, p.b))) lost.push(mk(p));
      for (const p of pairs) if (p.sim < NEW_FLOOR) tail.push(mk(p));

      // 第 6 节：库里 ≥0.35 的对，为什么没被合并
      for (const p of pairs) {
        if (p.sim < LEGACY_FLOOR) continue;
        const x = mk(p);
        if (x.veto) highVetoed.push(x);
        // ★ 判「有没有被问到」用的是**当前实现**（keyNew），不是旧实现 ——
        //   这一版要回答的问题是「现在还会不会漏」。
        else if (keyNew.has(pairKey(p.a, p.b))) highAsked.push(x);
        else highNotAsked.push(x);
      }
    }
  }

  console.log(`窗口 ${dates[dates.length - 1]} ~ ${dates[0]}（北京日期）｜${COUNTRIES.length} 国`);
  console.log(
    `原始 ${totalRows} 篇 → 确定性去重后 ${totalKept} 条（⚠️ API 不返回原文，L1 在本脚本失效）`,
  );
  console.log(`★ 批次数 = 推送轮数 = ${batchCount}（按**推送窗口**分组，不是按日期）`);

  console.log('\n=== 0. 标题相似度分桶（同国同日，确定性去重后）===');
  for (const k of [
    '≥0.90',
    '0.70–0.90',
    '0.50–0.70',
    '0.35–0.50',
    '0.25–0.35',
    '0.20–0.25',
    `${WATCH_FLOOR}–0.20`,
    '<' + WATCH_FLOOR,
  ]) {
    const v = buckets.get(k) || 0;
    if (v) console.log(`  ${k.padEnd(12)} ${String(v).padStart(6)} 对`);
  }

  console.log(`\n=== 6. ★★ 库里 sim ≥ ${LEGACY_FLOOR} 的对：为什么没被合并 ===`);
  const tot = highNotAsked.length + highAsked.length + highVetoed.length;
  console.log(`  共 ${tot} 对`);
  console.log(
    `  (A) 当前实现下**仍没被问到**（⇒ 真的漏）：${highNotAsked.length} 对` +
      `　（判据 = 当前 ${NEW_FLOOR} 下限 + 优先档 ≥${PAIR_PRIORITY_SIM} + 上限 ${PAIR_MAX_CANDIDATES}）`,
  );
  console.log(`  (B) 当前实现**会问到**、但库里没合并（⇒ 查当时是否真问过/模型判得对不对）：${highAsked.length} 对`);
  console.log(`  (C) 方向相反被确定性拦下（本来就**不该**合并）：      ${highVetoed.length} 对`);
  console.log(
    '  ⚠️ 判读边界：离线只能算「**当前实现**会不会问到」，算不出「那一轮当时问没问过」' +
      `（线上当时可能还是旧口径）。所以 (B) 不等于「模型判错了」——` +
      `要确认模型判得对不对，看 GET /api/dedupe-check?days=1&llm=1 的真实判定。`,
  );

  console.log(`\n--- (A) 排不进候选的名额牺牲品（按 sim 降序，前 60）---`);
  highNotAsked.sort((x, y) => y.sim - x.sim);
  for (const x of highNotAsked.slice(0, 60)) {
    console.log(`  [${x.c} ${x.d}] sim=${x.sim.toFixed(4)} lcs=${String(x.lcs).padStart(2)}`);
    console.log(`      A「${x.a.slice(0, 52)}」`);
    console.log(`      B「${x.b.slice(0, 52)}」`);
  }

  console.log(`\n--- (B) 问了但没判出来（按 sim 降序，前 60）---`);
  highAsked.sort((x, y) => y.sim - x.sim);
  for (const x of highAsked.slice(0, 60)) {
    console.log(`  [${x.c} ${x.d}] sim=${x.sim.toFixed(4)} lcs=${String(x.lcs).padStart(2)}`);
    console.log(`      A「${x.a.slice(0, 52)}」`);
    console.log(`      B「${x.b.slice(0, 52)}」`);
  }

  console.log(
    `\n=== 每批候选名额压力（ge35 = 该批 ≥${LEGACY_FLOOR} 的对数 = 优先档；` +
      `chosen35 = 优先档独享名额时问到几对（= 旧口径）；chosen20 = 当前口径问到几对）===`,
  );
  batchRows
    .filter((b) => b.ge35 > 0)
    .sort((a, b) => b.ge35 - a.ge35)
    .forEach((b) => {
      const flag = b.ge35 > b.chosen35 ? ' ⚠️ 超额' : '';
      console.log(
        `  [${b.c} ${b.d}] 条目 ${String(b.kept).padStart(2)}｜≥${LEGACY_FLOOR} ${String(b.ge35).padStart(2)} 对｜≥${NEW_FLOOR} ${String(b.ge20).padStart(3)} 对｜旧问 ${b.chosen35} → 新问 ${b.chosen20}${flag}`,
      );
    });

  console.log(`\n=== 2. 降阈新增候选（${LEGACY_FLOOR} → ${NEW_FLOOR}）：${added.length} 对 ===`);
  console.log('判读：出现「明显同一件事」= 0.35 确实太高；全是噪声 = 白花 token');
  added.sort((x, y) => y.sim - x.sim);
  for (const x of added.slice(0, 60)) {
    console.log(
      `  [${x.c} ${x.d}] sim=${x.sim.toFixed(4)} lcs=${String(x.lcs).padStart(2)}${x.veto ? ' ✗极性拦下' : ''}`,
    );
    console.log(`      A「${x.a.slice(0, 52)}」`);
    console.log(`      B「${x.b.slice(0, 52)}」`);
  }
  if (added.length > 60) console.log(`  …（其余 ${added.length - 60} 对略）`);

  console.log(`\n=== 3. ★ 单调性：降阈**丢掉**的对（原本会问、降阈后反而没被问到）：${lost.length} 对 ===`);
  console.log(
    `  判据 = candidatePairs(${NEW_FLOOR}, cap) ⊇ candidatePairs(${LEGACY_FLOOR}, cap)` +
      `　（「降低下限不得让原来会问的对变得问不到」，见 PAIR_PRIORITY_SIM）`,
  );
  console.log(
    lost.length === 0
      ? '  ✅ 无违规：降阈是**纯增量** —— 优先档独享名额，低分对只吃剩下的（分档生效）'
      : `  ❌ 违反单调性：${lost.length} 对原本会问、降阈后没被问到 ⇒ 名额分配还没修好（这些就是「高分对给低分对让路」的现场）`,
  );
  lost.sort((x, y) => y.sim - x.sim);
  for (const x of lost.slice(0, 30)) {
    console.log(`  [${x.c} ${x.d}] sim=${x.sim.toFixed(4)} lcs=${String(x.lcs).padStart(2)}`);
    console.log(`      A「${x.a.slice(0, 52)}」`);
    console.log(`      B「${x.b.slice(0, 52)}」`);
  }

  console.log(`\n=== 4. 尾部：${WATCH_FLOOR} ≤ sim < ${NEW_FLOOR}（降到 0.20 也够不着的对）===`);
  const tailInteresting = tail.filter((x) => x.lcs >= 8);
  console.log(`  共 ${tail.length} 对，其中「最长公共子串 ≥8 字」的 ${tailInteresting.length} 对，列前 40：`);
  tailInteresting.sort((x, y) => y.lcs - x.lcs || y.sim - x.sim);
  for (const x of tailInteresting.slice(0, 40)) {
    console.log(`  [${x.c} ${x.d}] sim=${x.sim.toFixed(4)} lcs=${String(x.lcs).padStart(2)}`);
    console.log(`      A「${x.a.slice(0, 52)}」`);
    console.log(`      B「${x.b.slice(0, 52)}」`);
  }

  console.log(`\n（国家：${COUNTRIES.map((c) => `${c}=${countries[c].name}`).join(' ')}）`);
}

main();
