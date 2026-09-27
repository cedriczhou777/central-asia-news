/**
 * 「今天为什么只推了 N 个国家」—— 把推送选稿漏斗在**同一批真实数据**上复现一遍（只读）。
 *
 * 用法：
 *   pnpm diagnose:push --period morning                 # 今天的早报窗口（默认）
 *   pnpm diagnose:push --period morning --date 2026-09-27
 *   pnpm diagnose:push --start 2026-09-26T11:00:00Z --end 2026-09-26T23:00:00Z
 *   pnpm diagnose:push --period morning --max-id 6068    # 只看「那一刻库里已有的」行
 *   SITE_BASE=http://localhost:3000 pnpm diagnose:push --period evening
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
 * 1. **`original_title` 拿不到**。`GET /api/articles` 的 `rowToApi` 不返回它，
 *    而它是 `identityKeys` 里 `orig:` 这一条的来源。结果：本脚本的确定性去重
 *    **只能按链接判**，会比生产**少**剔一部分（生产还有原文标题指纹那一刀）。
 *    ⇒ 本脚本报的「进精选」是**上限**，真实值可能更低。
 * 2. **L2（模型判组）不跑**。`dedupeStories` 里的模型那一层需要 API Key 与逐国调用，
 *    这里只跑确定性层。生产上 L2 默认**关闭**（`isLlmJudgeEnabled()`），
 *    所以生产此刻也是确定性层在起作用，两边可比。
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
import { dedupeStoriesDeterministic } from '../src/lib/same-event';
import { scheduledWindow } from '../src/lib/publish-schedule';
import { compareByInvestmentRelevance, investmentRelevanceOf } from '../src/lib/investment-score';

const BASE =
  process.env.SITE_BASE ||
  'https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com';

/** 与 `POST /api/wechat/push` 的 `maxPerCountry` 一致 —— 改一处要改两处，这里是刻意的重复。 */
const MAX_PER_COUNTRY = 15;

/** 拉取上限。给足余量：12h 窗口实测 100~200 篇，500 是安全水位（见下方的截断自检）。 */
const FETCH_LIMIT = 500;

interface ApiArticle {
  id: number;
  title: string;
  summary: string | null;
  content: string | null;
  country: string;
  category: string | null;
  source: string | null;
  sourceUrl: string | null;
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
const KNOWN_FLAGS = new Set(['start', 'end', 'period', 'date', 'max-id']);

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

const REASON_LABEL: Record<PushExclusion, string> = {
  untranslated: '非中文（未翻译/翻译退化）',
  category: '文体类（EXCLUDED_CATEGORIES）',
  missing_source: '源正文缺失',
  country: '与本国无关（讲了别国）',
};

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
  // 下面统计出的「窗口内 N 篇」是漏的。宁可报错也不要给一个看起来正常的漏数。
  const oldest = all.reduce(
    (m, a) => (a.publishedAt && a.publishedAt < m ? a.publishedAt : m),
    all[0].publishedAt || '',
  );
  const newest = all.reduce(
    (m, a) => (a.publishedAt && a.publishedAt > m ? a.publishedAt : m),
    all[0].publishedAt || '',
  );
  console.log(`拉取 ${all.length} 篇，published_at 覆盖 ${oldest} … ${newest}`);
  if (oldest && oldest > startIso) {
    console.log(
      `  ⚠️ 返回集最早的一篇（${oldest}）新于窗口起点（${startIso}）` +
        ` —— 窗口左端没覆盖到，下面的计数偏少。把 limit 调大或缩短窗口。`,
    );
  }

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
      reason: { untranslated: 0, category: 0, missing_source: 0, country: 0 },
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
      const reason = pushExclusionReason(
        { title: a.title, content: a.content, summary: a.summary, category: a.category },
        country.code,
      );
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
      `     非中文 ${f.reason.untranslated}  |  文体类 ${f.reason.category}  |  ` +
        `源缺失 ${f.reason.missing_source}  |  国别无关 ${f.reason.country}`,
    );
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
