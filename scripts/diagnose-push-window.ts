/**
 * 「今天为什么只推了 N 个国家」—— 把推送选稿漏斗在**同一批真实数据**上复现一遍（只读）。
 *
 * 用法：
 *   pnpm diagnose:push --period morning                 # 今天的早报窗口（默认）
 *   pnpm diagnose:push --period morning --date 2026-09-27
 *   pnpm diagnose:push --start 2026-09-26T11:00:00Z --end 2026-09-26T23:00:00Z
 *   pnpm diagnose:push --period morning --max-id 6068    # 只看「那一刻库里已有的」行
 *   pnpm diagnose:push --period morning --limit 2000     # 回放更早的窗口（默认 500 只够约 2 天）
 *   pnpm diagnose:push --period morning --allow-truncated # 明知窗口被截断，仍要看截断结果
 *   SITE_BASE=http://localhost:3000 pnpm diagnose:push --period evening
 *
 * ## ⚠️ 窗口被截断时本脚本**退出码非 0**（2026-10-05 改）
 *
 * **服务端还会把 `limit` 截到 1000**（实测 `limit=2500` 只返回 1000 行）——
 * 所以本脚本**最多**能可靠回放约 4 天的窗口，再早的窗口无论 `--limit` 给多大都覆盖不到左端，
 * 那时只能改用 `--start/--end` 显式圈一个能被覆盖的区间。
 *
 * 默认 `--limit 500` 在实测流量下只覆盖约 36~48 小时。回放更早的窗口时，
 * 返回集的**左端**会落在窗口起点之后 ⇒ 「窗口内 N 篇」只是后半段的数。
 * 这曾经让一次排查得出「吉尔吉斯整轮只有 1 篇稿」的结论，而真相是仪器把窗口砍了一半。
 * 现在这种情况下会打印修法并**直接退出**（见 `assertWindowCovered`）——
 * 与 `assertBodyFieldPresent` 同一个立场：**宁可报错，也不给一份看着正常的漏数**。
 *
 * ## `--max-id` 是复现「推送跑在抓取前面」的关键旋钮
 *
 * `id` 是自增的，所以**入库顺序就是 id 顺序**，而且一轮抓取插入的行是**一整段连续 id**。
 * 于是「推送那一刻库里有什么」= 取 `id ≤ 上一轮抓取的最大 id`。
 * 用它筛一遍，就能把「推送读到的库」和「现在的库」分开。
 *
 * 2026-09-27 早报就是靠这个定位的：推送在 09:30:02 跑，抓取 09:34:51 才结束，
 * 加 `--max-id 6068` 后结果与线上草稿**完全一致**（只有 kg、且正好 6 篇）——
 * 这才排除掉「翻译/去重/判据」这些看起来更像原因的嫌疑人。
 *
 * ## 存在的理由（这是补上一次真实的观测缺口）
 *
 * `POST /api/wechat/push` 的 `summary.failures` **只记两类事**：单国读取失败、
 * 建草稿失败。而下面这些「国家被跳过」的路径**一个字段都不留**：
 *
 *   - `articles.length === 0`            → `continue`（日志有，响应里没有）
 *   - 全部被 `pushExclusionReason` 挡掉    → `continue`
 *   - 去重后一条不剩                      → `continue`
 *
 * 于是 2026-09-27 早报的现实是：
 *   `drafts: [kg], failures: []` —— 响应看起来「成功」，实际 5 国里 4 国没出草稿，
 *   而**为什么没出**从接口上完全读不出来，只能进容器控制台翻日志（外面拿不到）。
 *
 * 用户看到的现象是「今天早上好像只有吉尔吉斯的新闻推送了」。要回答这个问题，
 * 需要的是**每一国各自卡在哪一段**，不是一句「success」。
 *
 * ## 判据必须是同一份实现
 *
 * 这里 import 的是生产真正在用的 `pushExclusionReason` / `dedupeStoriesDeterministic`，
 * **不是照抄一份**。照抄是本项目反复栽过的坑（见 `pushExclusionReason` 的注释：
 * `/api/dedupe-check` 抄漏判据后，把永远进不了生产的体育新闻喂给模型，
 * 于是「L2 不稳定」这个结论本身就是假的）。
 *
 * ## 已知的口径差（读结论前先看这里）
 *
 * 1. ~~**`original_title` 拿不到**~~ → **2026-10-05 已修**：`rowToApi` 现在返回
 *    `originalTitle`，`GET /api/articles` 也真的 select 了这一列，
 *    所以 `identityKeys` 的 `orig:` 那一刀在本脚本里同样生效，与生产同一套判据。
 *    （这条原先写的是「拿不到」，而真因不是「接口没写这个字段」，是**SQL 选择列漏了** ——
 *    见 `db-articles.ARTICLE_COLUMNS` 的说明。）
 * 2. **L2（模型判组）不跑**。本脚本调的是同步的 `dedupeStoriesDeterministic`，
 *    不碰模型（也因此不会在这里偷偷花掉配额）。⚠️ **但「两边可比」这句自 2026-09-28 起不再成立**：
 *    生产推送端当时把 L2 默认翻成了**开**，所以本脚本报的「进精选」现在是
 *    **生产真值的上限**（L2 还会再合掉一些跨源同一件事的稿子）。
 *    想连 L2 一起看，用 `GET /api/dedupe-check?days=2&llm=1&debug=1`。
 * 3. **排序（投资相关性）不影响「有几条」**，只影响「是哪几条」。本脚本仍按
 *    生产同样的顺序排 —— 因为 `dedupeStoriesDeterministic` 是**顺序敏感**的
 *    （先到的先保留），顺序不对会换出不同的保留集。
 */

import { countryList } from '../src/lib/data/countries';
import {
  EXCLUDED_CATEGORIES,
  isPushableText,
  pushExclusionReason,
  type PushExclusion,
} from '../src/lib/article-format';
import { hasSourceBody } from '../src/lib/article-body';
import { dedupeStoriesDeterministic } from '../src/lib/same-event';
import { scheduledWindow } from '../src/lib/publish-schedule';
import { compareByInvestmentRelevance, investmentRelevanceOf } from '../src/lib/investment-score';

const BASE =
  process.env.SITE_BASE ||
  'https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com';

/** 与 `POST /api/wechat/push` 的 `maxPerCountry` 一致 —— 改一处要改两处，这里是刻意的重复。 */
const MAX_PER_COUNTRY = 15;

/**
 * 默认拉取上限。可用 `--limit N` 覆盖。
 *
 * ⚠️ **500 只够回放最近约两天的窗口**（实测 12h 窗口 36~176 篇，24h 约 250~350 篇，
 * 而夜间时段常低到每小时 1~6 篇 ⇒ 500 篇大约覆盖 36~48 小时）。
 * 想回放更早的窗口必须显式给更大的 `--limit`，否则**左侧会被截断**、
 * 「窗口内 N 篇」变成漏数 —— 这正是 2026-10-05 排查「吉尔吉斯是不是停推了」
 * 时踩到的：被截断的窗口报出 `kg 窗口内 1 篇`，而那只统计到窗口的后半段。
 * 下面是**硬失败**（不是告警），见 `assertWindowCovered()`。
 */
const DEFAULT_FETCH_LIMIT = 500;

interface ApiArticle {
  id: number;
  title: string;
  summary: string | null;
  content: string | null;
  country: string;
  category: string | null;
  source: string | null;
  sourceUrl: string | null;
  /**
   * 原文标题。`identityKeys` 里 `orig:` 那一刀的输入（见 `same-event.ts`）。
   * 缺了它，本脚本的确定性去重会比生产**少**剔一部分 ⇒ 报出的「进精选」是上限。
   */
  originalTitle: string | null;
  /**
   * 原文正文。**必须有**：推送侧第 0 条闸（`hasSourceBody`）判的就是它
   * （见 `article-format.ts` 里 `PushExclusion` 的说明和第 0 条闸的注释）。
   *
   * ⚠️ 注意这里判「有没有」的依据是 `hasSourceBody`（内容层面），
   * 但**上面这条注释曾经和现实相反**：2026-10-05 之前 `GET /api/articles`
   * 根本没 select 这一列，字段在 JSON 里**整个不存在**，于是这个计数被**恒报成满格**
   * （不是 0）—— 五国全部「无原文正文」，一份完全虚假的漏斗。
   * 字段级的存在性由下面的 `assertBodyFieldPresent()` 单独把关。
   */
  originalContent: string | null;
  publishedAt: string | null;
}

/**
 * 取命令行参数。**同时支持 `--k=v` 与 `--k v`**。
 *
 * 为什么要写这一条：第一版只认 `--k=v`，于是 `--max-id 6068` 这种空格写法被
 * **静默忽略**，脚本照常跑完、照常输出一份看起来正常的结果 ——
 * 而那一份结果答的是另一个问题。这和本项目里反复出现的
 * 「跑不完的门禁 / 判据在两处各写一份」是同一类毛病：
 * **不报错的错最危险**。所以这里的第二个出口是抛错，不是返回 undefined。
 */
function argValue(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) {
    const v = process.argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      console.error(`--${name} 后面没有跟值（写成 --${name}=xxx 或 --${name} xxx）`);
      process.exit(1);
    }
    return v;
  }
  return undefined;
}

/** 认得的开关。写错一个字母就该报错，而不是悄悄跑默认值。 */
const KNOWN_FLAGS = new Set(['start', 'end', 'period', 'date', 'max-id', 'limit', 'allow-truncated']);

function assertNoUnknownFlags(): void {
  const bad = process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => (a.includes('=') ? a.slice(0, a.indexOf('=')) : a))
    .map((a) => a.slice(2))
    .filter((n) => !KNOWN_FLAGS.has(n));
  if (bad.length > 0) {
    console.error(
      `不认识的参数：${bad.map((b) => '--' + b).join('、')}。` +
        `可用：${[...KNOWN_FLAGS].map((f) => '--' + f).join('、')}`,
    );
    process.exit(1);
  }
}

function resolveWindow(): { start: Date; end: Date; label: string } {
  const startArg = argValue('start');
  const endArg = argValue('end');
  if (startArg && endArg) {
    const start = new Date(startArg);
    const end = new Date(endArg);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      console.error(`--start / --end 不是合法时间：${startArg} / ${endArg}`);
      process.exit(1);
    }
    return { start, end, label: '手工指定' };
  }

  const period = argValue('period') || 'morning';
  const dateArg = argValue('date');
  // `scheduledWindow` 是按**北京时间日期**推导的，所以要把「想复现的那一天」
  // 转成一个北京日期正确的 `Date` 再喂进去 —— 直接 new Date() 会拿到今天，
  // 想复现昨天那轮就永远复现不出来。
  const anchor = dateArg
    ? new Date(`${dateArg}T07:00:00+08:00`)
    : new Date();
  if (dateArg && Number.isNaN(anchor.getTime())) {
    console.error(`--date 不是合法日期：${dateArg}（要 YYYY-MM-DD）`);
    process.exit(1);
  }

  const w = scheduledWindow(period, anchor);
  if (!w) {
    console.error(
      `--period=${period} 推不出固定窗口（只支持 morning / evening）。` +
        `人工补跑请改用 --start/--end 显式给窗口。`,
    );
    process.exit(1);
  }
  return { start: w.start, end: w.end, label: `${w.label}（${w.hours}h）` };
}

function fmtBeijing(d: Date): string {
  // 容器/本机时区不定，显式按 +08:00 渲染
  const s = new Date(d.getTime() + 8 * 3600_000).toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 16)}`;
}

/**
 * 各判据挡掉几篇的中文名。
 *
 * ⚠️ `no_source_body` **排在第一位**，因为它在生产里就是第 0 条闸
 * （`wechat/push/route.ts` 的 `eligible` filter，跑在 `pushExclusionReason` 之前）——
 * 顺序在这里也必须保持一致，否则「先被哪条挡掉」的归属会串。
 */
const REASON_LABEL: Record<PushExclusion, string> = {
  no_source_body: '无原文正文（第 0 条闸）',
  untranslated: '非中文（未翻译/翻译退化）',
  category: '文体类（EXCLUDED_CATEGORIES）',
  missing_source: '源正文缺失',
  country: '与本国无关（讲了别国）',
};

/**
 * 字段存在性自检 —— 挡住一整类**看起来正常的假报告**。
 *
 * ## 为什么必须单独有这一步
 *
 * 下面所有统计都建立在 `a.originalContent` 上（第 0 条闸 `hasSourceBody`）。
 * 而「这一列没被 select」和「这一列的值是 NULL」在 JS 里长得很不一样、
 * 在**报告里却长得一样**：
 *
 * | 情况 | `a.originalContent` | 报告里的表现 |
 * | --- | --- | --- |
 * | 库里是 NULL（真的是采集侧问题） | `null` | 这一条算 `no_source_body` ✅ 真实 |
 * | 查询没 select 这一列（代码问题） | `undefined`（JSON 里键都不存在） | **全部**条目算 `no_source_body` ❌ 假 |
 *
 * 2026-10-05 就是这么栽的：五国 100% 「无原文正文」，看起来像采集侧全线塌了，
 * 实际是 `getArticles` 的 `select(...)` 漏了这一列。
 *
 * ⇒ 契约是：**这一列必须至少在一条记录上是「存在的键」**（哪怕是 `null`）。
 * 一条都没有，说明是接口/查询的问题，此时**任何**漏斗数字都不可信 ⇒ 直接退出。
 * 这与本脚本 `argValue` 的立场一致：**宁可报错，也不要给一份看着正常的结果**。
 */
function assertBodyFieldPresent(rows: ApiArticle[]): void {
  const withKey = rows.filter((a) => Object.prototype.hasOwnProperty.call(a, 'originalContent'));
  if (withKey.length === 0) {
    console.error(
      '✖ 接口返回的 ' +
        rows.length +
        ' 条记录里，**没有一条**带 `originalContent` 这个键。\n' +
        '  这不是「都没有正文」，而是「这一列压根没被查出来」——\n' +
        '  两种情况的报告长得一样，但结论相反：前者是采集侧问题，后者是代码问题。\n' +
        '  查 `src/lib/db-articles.ts` 的 `ARTICLE_COLUMNS` 有没有漏、\n' +
        '  以及 `src/app/api/articles/route.ts` 的 `requiredColumn()` 有没有被绕过。\n' +
        '  在这条修好之前，下面的漏斗数字**一律不可信**，所以直接退出。',
    );
    process.exit(1);
  }
  const nonNull = withKey.filter((a) => a.originalContent != null).length;
  console.log(
    `字段自检：${withKey.length}/${rows.length} 条带 originalContent 键，` +
      `其中非空 ${nonNull} 条（${((nonNull / withKey.length) * 100).toFixed(1)}%）`,
  );
}

/**
 * **窗口覆盖自检 —— 截断必须硬失败，不许只告警。**
 *
 * ## 为什么从「打印 ⚠️」改成「exit 1」
 *
 * 这段逻辑原先只打一行告警就继续跑，而它上面那句注释写的是
 * 「宁可报错也不要给一个看起来正常的漏数」—— **注释写的和代码做的是两件事**。
 * 2026-10-05 就是这么再次栽的：用默认 `limit=500` 回放 2026-10-03 早报窗口时，
 * 返回集最早只到北京时间 10-03 01:00，而窗口起点是 10-02 19:00 ——
 * 于是「窗口内 N 篇」只统计到后半段，报出 `kg 窗口内 1 篇`，
 * 看起来像「吉尔吉斯整轮没稿」，实际是**仪器把窗口砍了一半**。
 *
 * ⇒ 判据：返回集最早的一篇**新于**窗口起点 ⇒ 左端没覆盖 ⇒ 退出。
 * 需要故意看截断结果时加 `--allow-truncated`（那时告警仍会打印，只是不退出）。
 *
 * 这是本项目第三次同类：**「不报错的错」比报错的错危险得多**。
 * 见 `assertBodyFieldPresent`（字段没查出来时同样硬失败）与 `argValue`（参数写错就抛）。
 */
function assertWindowCovered(args: {
  oldest: string;
  startIso: string;
  limit: number;
  allowTruncated: boolean;
}): void {
  const { oldest, startIso, limit, allowTruncated } = args;
  if (!oldest || oldest <= startIso) return;
  const msg =
    `返回集最早的一篇是 ${oldest}，**新于**窗口起点 ${startIso}` +
    ` ⇒ 窗口左端没被覆盖，下面的「窗口内 N 篇」是**漏数**（不是「那一轮真的没稿」）。\n` +
    `  当前 limit=${limit}。修法二选一：\n` +
    `    · 调大取数上限：--limit ${Math.min(limit * 4, 5000)}\n` +
    `    · 或只回放能覆盖到的区间：--start/--end 显式给窗口\n` +
    `  确认要看截断结果（仅用于对照）时加 --allow-truncated。`;
  if (allowTruncated) {
    console.log(`  ⚠️ ${msg}`);
    return;
  }
  console.error(`✖ ${msg}`);
  process.exit(1);
}

interface Funnel {
  total: number;
  reason: Record<PushExclusion, number>;
  deterministicDrops: number;
  dedupReasons: Map<string, number>;
  eligible: number;
  selected: number;
  examples: Map<PushExclusion, ApiArticle[]>;
  dedupExamples: Array<{ dropped: ApiArticle; reason: string; keptTitle: string }>;
}

async function main(): Promise<void> {
  assertNoUnknownFlags();
  const win = resolveWindow();
  const startIso = win.start.toISOString();
  const endIso = win.end.toISOString();

  console.log('='.repeat(72));
  console.log(`推送窗口复现：${win.label}`);
  console.log(`  ${startIso}  →  ${endIso}`);
  console.log(`  北京时间 ${fmtBeijing(win.start)}  →  ${fmtBeijing(win.end)}`);
  const spanH = (win.end.getTime() - win.start.getTime()) / 3600_000;
  console.log(`  窗口长度 ${spanH}h，每国上限 ${MAX_PER_COUNTRY} 篇`);
  console.log(`  数据来源 ${BASE}`);
  console.log('='.repeat(72));

  const limitArg = argValue('limit');
  const FETCH_LIMIT = limitArg === undefined ? DEFAULT_FETCH_LIMIT : Number(limitArg);
  if (!Number.isFinite(FETCH_LIMIT) || FETCH_LIMIT <= 0) {
    console.error(`--limit 不是正整数：${limitArg}`);
    process.exit(1);
  }
  const allowTruncated = process.argv.includes('--allow-truncated');

  const res = await fetch(`${BASE}/api/articles?limit=${FETCH_LIMIT}`);
  if (!res.ok) {
    console.error(`拉取文章失败：HTTP ${res.status}`);
    process.exit(1);
  }
  const body = (await res.json()) as { articles: ApiArticle[] };
  const all = body.articles || [];
  if (all.length === 0) {
    console.error('接口没返回任何文章 —— 先确认库里有数据，再谈漏斗。');
    process.exit(1);
  }

  // 先验字段，再算漏斗。顺序不能反：字段缺失时下面每一格都是假的。
  assertBodyFieldPresent(all);

  // `--max-id`：模拟「推送那一刻」的库。理由见文件头 —— id 顺序就是入库顺序，
  // 一轮抓取是一整段连续 id，所以「当时库里有什么」可以按 id 切出来。
  const maxIdArg = argValue('max-id');
  const maxId = maxIdArg === undefined ? Infinity : Number(maxIdArg);
  if (maxIdArg !== undefined && !Number.isFinite(maxId)) {
    console.error(`--max-id 不是数字：${maxIdArg}`);
    process.exit(1);
  }
  const inDb = maxId === Infinity ? all : all.filter((a) => a.id <= maxId);
  if (maxId !== Infinity) {
    console.log(
      `--max-id ${maxId}：只保留 id ≤ ${maxId} 的 ${inDb.length} 篇` +
        `（模拟「推送执行那一刻」的库；越界的 ${all.length - inDb.length} 篇是之后才入库的）`,
    );
  }

  // 截断自检：如果返回集里最早的一篇**新于**窗口起点，说明窗口左端没被覆盖，
  // 下面统计出的「窗口内 N 篇」是漏的。
  const oldest = all.reduce(
    (m, a) => (a.publishedAt && a.publishedAt < m ? a.publishedAt : m),
    all[0].publishedAt || '',
  );
  const newest = all.reduce(
    (m, a) => (a.publishedAt && a.publishedAt > m ? a.publishedAt : m),
    all[0].publishedAt || '',
  );
  console.log(`拉取 ${all.length} 篇（limit=${FETCH_LIMIT}），published_at 覆盖 ${oldest} … ${newest}`);
  assertWindowCovered({ oldest, startIso, limit: FETCH_LIMIT, allowTruncated });

  const inWindow = inDb.filter((a) => {
    const t = a.publishedAt;
    return !!t && t >= startIso && t <= endIso;
  });
  console.log(`落在窗口内 ${inWindow.length} 篇`);
  if (maxId !== Infinity && inWindow.length === 0) {
    console.log(
      '  ⚠️ 这个切片下窗口内一篇都没有 —— 推送当时看到的正是这个状态，' +
        '五国都会走 `articles.length === 0 → continue`。',
    );
  }
  console.log();

  const funnels = new Map<string, Funnel>();

  for (const country of countryList) {
    const f: Funnel = {
      total: 0,
      reason: { no_source_body: 0, untranslated: 0, category: 0, missing_source: 0, country: 0 },
      deterministicDrops: 0,
      dedupReasons: new Map(),
      eligible: 0,
      selected: 0,
      examples: new Map(),
      dedupExamples: [],
    };
    funnels.set(country.code, f);

    const mine = inWindow
      .filter((a) => a.country === country.code)
      .sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
    f.total = mine.length;

    // 第一步：非中文（与 push 路由同一函数）
    const chinese = mine.filter((a) => isPushableText(a.title, a.content));

    // 第二步：排序（投资相关性为主 + 分类为辅 + 时间兜底）
    const scored = chinese
      .map((a) => ({ ...a, relevanceScore: investmentRelevanceOf(a.title, a.summary || '') }))
      .sort(compareByInvestmentRelevance);

    // 第三步：逐条判据，分别记账（push 路由里是 filter，这里要保留原因明细）
    const eligible = scored.filter((a) => {
      // 第 0 条：库里没有原文正文的一律不推 —— 与生产同一处判据、同一个谓词
      // （`hasSourceBody` 从 `article-body.ts` import，**不在这里照抄一份**）。
      // 为什么必须先判它：它判的不是「内容好不好」，而是「这篇到底是不是新闻」；
      // 阿塞拜疆那 5 个源 RSS 完全没有正文，旧代码照样拿去翻译 ⇒ 模型照着标题编正文。
      const reason: PushExclusion | null = hasSourceBody(a.originalContent)
        ? pushExclusionReason(
            { title: a.title, content: a.content, summary: a.summary, category: a.category },
            country.code,
          )
        : 'no_source_body';
      if (!reason) return true;
      f.reason[reason] += 1;
      const ex = f.examples.get(reason) || [];
      if (ex.length < 3) ex.push(a);
      f.examples.set(reason, ex);
      return false;
    });
    f.eligible = eligible.length;

    // 第四步：确定性去重（L0/L1 + 逐字重复 + 标题逐字相同）
    const { kept, drops } = dedupeStoriesDeterministic(eligible);
    f.deterministicDrops = drops.length;
    for (const d of drops) {
      f.dedupReasons.set(d.reason, (f.dedupReasons.get(d.reason) || 0) + 1);
      if (f.dedupExamples.length < 3) {
        f.dedupExamples.push({
          dropped: d.dropped as ApiArticle,
          reason: d.reason,
          keptTitle: (d.kept as ApiArticle).title,
        });
      }
    }

    // 第五步：截取上限
    f.selected = Math.min(kept.length, MAX_PER_COUNTRY);

    const name = country.name.padEnd(7, ' ');
    const flag = country.code;
    console.log(`${flag} ${name} 窗口内 ${String(f.total).padStart(3)} 篇`);
    console.log(
      `     无原文正文 ${f.reason.no_source_body}  |  非中文 ${f.reason.untranslated}  |  ` +
        `文体类 ${f.reason.category}  |  源缺失 ${f.reason.missing_source}  |  国别无关 ${f.reason.country}`,
    );
    // 单独提示：这一格偏大说明**源站的 RSS 根本没给正文**，属于采集侧的问题
    // （`fetch-news` 的补抓没能抓到，见 `article-body.ts`），
    // 不是选稿判据调歪了 —— 别去动 `pushExclusionReason` 或 `maxPerCountry`。
    if (f.reason.no_source_body > 0) {
      console.log(
        `     ⚠️ 其中 ${f.reason.no_source_body} 篇是**库里没有原文正文**（第 0 条闸）——` +
          ` 去查那些源站的 RSS 有没有正文，别调选稿判据。`,
      );
    }
    console.log(
      `     ⇒ 合格候选 ${f.eligible} 篇，确定性去重剔除 ${f.deterministicDrops} 篇` +
        `（${f.deterministicDrops > 0 ? [...f.dedupReasons].map(([k, v]) => `${k} ${v}`).join('、') : '—'}）`,
    );
    console.log(
      `     ⇒ 去重后剩 ${kept.length} 篇，截取上限 ${MAX_PER_COUNTRY} 后进精选 **${f.selected} 篇**` +
        (f.selected === 0 ? '   ← 这一国本轮不会出草稿' : ''),
    );

    if (f.selected === 0 && f.total > 0) {
      for (const [reason, list] of f.examples) {
        if (f.reason[reason] === 0) continue;
        console.log(`     · ${REASON_LABEL[reason]}（${f.reason[reason]} 篇），例如：`);
        for (const a of list) console.log(`         「${(a.title || '').slice(0, 44)}」`);
      }
      for (const d of f.dedupExamples) {
        console.log(`     · 去重剔除（${d.reason}）：「${(d.dropped.title || '').slice(0, 40)}」`);
        console.log(`         与保留的「${(d.keptTitle || '').slice(0, 40)}」同一条`);
      }
      if (f.selected === 0 && f.eligible === 0 && f.total > 0) {
        console.log('     · 合格候选为 0 —— 上面四条判据吃掉了全部候选，不是「没抓到新闻」。');
      }
    }
    console.log();
  }

  const zero = [...funnels.entries()].filter(([, f]) => f.selected === 0).map(([k]) => k);
  const withArticles = [...funnels.entries()].filter(([, f]) => f.total > 0).map(([k]) => k);
  console.log('-'.repeat(72));
  console.log(
    `汇总：窗口内有文章的国家 ${withArticles.length} 个（${withArticles.join(' ')}）；` +
      `其中**没出草稿**的 ${zero.length} 个（${zero.join(' ') || '—'}）`,
  );
  if (zero.length > 0) {
    console.log(
      '  ↑ 这行就是「今天怎么只推了某国」的答案。对照 `GET /api/wechat/push` 的 lastRun：\n' +
        '    `failures: []` 不代表五国都成功，只代表**没有异常**——被跳过的国家不写进任何字段。',
    );
  }
}

main().catch((err) => {
  console.error('诊断失败：', err);
  process.exit(1);
});
