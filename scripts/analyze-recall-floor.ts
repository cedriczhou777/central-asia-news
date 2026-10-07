/**
 * 「把召回下限抬到优先档下限」（= 砍掉补充档）在生产形态批次上的效果与代价。
 *
 * 用法：
 *   pnpm tsx scripts/analyze-recall-floor.ts                          # 默认 3 天、钉 zhipu、下限抬到 0.35
 *   pnpm tsx scripts/analyze-recall-floor.ts --days 3 --floor 0.3
 *   pnpm tsx scripts/analyze-recall-floor.ts --limit 60 --provider zhipu-flash
 *
 * ⚠️ **没有 `--country` 选项**：`GET /api/dedupe-check` 本来就不接受 `country=`，
 * 它的返回是**按国家分组**的（`llmJudge[]`），逐国看即可。
 * 这里明写一句，是因为「脚本声明了一个线上读不到的参数」正是本项目反复栽的那类坑
 * （声明了但没接上 ⇒ 参数被静默忽略 ⇒ 实验组和对照组长得一模一样）。
 *
 * ## 它要回答的问题（为什么值得花 token）
 *
 * 2026-10-06 在 3 天窗口上量出：**108 个「判是」里有 69 个 `sim < 0.36`** ——
 * 也就是**全部落在补充档**（`0.20 ≤ sim < 0.35`）。最坏的一例是一组 4 条，
 * 3 条互不相干，靠并查集被一起静默丢掉。
 *
 * 于是有一个非常直接的可证伪假说：
 *
 *   H2：**把召回下限抬到优先档下限（0.35）= 砍掉整个补充档**
 *       ⇒ 那 69 个低分「判是」**根本没机会被问**，误合并大幅下降。
 *       代价 = 「真重复但 sim < 0.35」的那部分再也合不了（漏合并）。
 *
 * 这个实验在 2026-10-07 之前**工具上做不到** —— 体检入口不能改召回层参数。
 * 现在 `minside` 接上了（见 `src/lib/dedupe-knobs.ts`），才第一次能跑。
 *
 * ## ★ 内建的两条可证伪不变量（不满足就说明旋钮接错了）
 *
 * 1. `minside = PAIR_PRIORITY_SIM` 时，**优先档必须一模一样**：
 *    `selectCandidatePairs` 里 `priority = max(minSim, prioritySim)`，
 *    所以抬高 `minSim` 到 `prioritySim` **不会改变** `high` / `tier1`。
 *    ⇒ 两轮同国的 `candidatesAbovePriority` 必须**逐数相同**。
 *    不同 ⇒ 旋钮影响到了它不该影响的东西。
 * 2. 抬高后的 `candidatesAboveFloor` 必须**等于**抬高前的 `candidatesAbovePriority`
 *    （两者都是「`sim ≥ 0.35` 的对数」）。
 *    **这一条能抓住「minside 被接到了 prioritySim 上」这类错接** ——
 *    那种错接下两个数字不会相等。
 *
 * ## ⚠️ 本脚本不做标注判断
 *
 * 它只负责把「消掉了哪些对」逐对打出来（标题 + sim）。**哪些是真重复、哪些是误合并
 * 需要人来判** —— 本脚本不会替你下结论，也不会输出任何「净收益为正」的话。
 * 这是刻意的：本项目的教训是「没有标注就算不出净值」（见 AGENTS 的 R-5）。
 */
const BASE = process.env.BASE || 'https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

const days = Math.max(1, Number(argValue('days') ?? '3') || 3);
const limit = Math.max(1, Number(argValue('limit') ?? '60') || 60);
const floor = Number(argValue('floor') ?? '0.35') || 0.35;
const provider = argValue('provider') ?? 'zhipu';
const pv = argValue('pv') ?? '3';
const retry429 = Math.max(0, Number(argValue('retry') ?? '3') || 3);
const BASE_RETRY_MS = 8_000;

type Judged = { sim: number; a: string; b: string };
type CountryProbe = {
  country: string;
  /**
   * ★ 这一条**必须**在类型里（2026-10-07 漏了它 ⇒ `tsc` 报 TS2339 ⇒ **云端构建失败**）。
   *
   * 它是服务端 `dedupe-check` 真的会返回的字段（`route.ts` 里 `ran: llm.ran`），
   * 而 `answeredCountries()` 的分母口径正是靠它把「模型答了但答的是否」与
   * 「这一国根本没跑成」分开（见 AGENTS R-4 第 3 条）。
   * 教训：**本地复刻的服务端形状是「声明」，服务端才是「事实」** ——
   * 复刻时少抄一个字段，编译器就在别人的构建机上替你发现。
   */
  ran?: boolean;
  /** 与 `ran` 配套：`llm.ok` 的语义是「**判出了可合并的组**」，不是「调用成功」。 */
  ok?: boolean;
  rowsInWindow?: number;
  sampleSize?: number;
  judgedSampleSize?: number;
  candidatePairs?: number;
  candidatesAboveFloor?: number;
  candidatesAbovePriority?: number;
  judgedPairs?: number;
  vetoedPairs?: number;
  declinedPairs?: number;
  provider?: string;
  groups?: number;
  error?: string;
  pairs?: Judged[];
  declined?: Judged[];
  vetoed?: Judged[];
  groupTitles?: Array<{ kept: string; dropped: string[] }>;
};
type DedupeResult = {
  ok?: boolean;
  error?: string;
  llmJudge?: CountryProbe[];
  llmJudgeParams?: {
    providerRequested?: string;
    judgePromptVersionUsed?: number;
    pairRecallUsed?: { minSim: number; prioritySim: number; maxPairs: number; overridden: string[] };
  };
};

const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms));

/**
 * 发一次体检请求。
 *
 * ⚠️ 服务端会把模型的 429 **包在 HTTP 200 里**（`ok:false` / `error` 含 `HTTP 429`），
 * 只看 `res.status` 会把限流读成成功。这里两条都查，并只对限流重试。
 */
async function runOnce(label: string, extraQuery: string): Promise<DedupeResult> {
  const qs = new URLSearchParams({ days: String(days), llm: '1', pv, provider, limit: String(limit), debug: '1' });
  const url = `${BASE}/api/dedupe-check?${qs.toString()}${extraQuery}`;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    const text = await res.text();
    let json: DedupeResult = {};
    try {
      json = JSON.parse(text) as DedupeResult;
    } catch {
      return { ok: false, error: `返回不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}` };
    }
    const blob = JSON.stringify(json.llmJudge ?? []);
    const throttled = /HTTP 429|访问量过大|rate ?limit/i.test(blob);
    if (throttled && attempt < retry429) {
      const wait = BASE_RETRY_MS * 2 ** attempt;
      console.log(`   [${label}] 第 ${attempt + 1} 次撞上限流，${wait / 1000}s 后重试…`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}：${text.slice(0, 200)}`, llmJudge: json.llmJudge };
    return json;
  }
}

function pairKey(p: { a: string; b: string }): string {
  return `${p.a}|||${p.b}`;
}

function fmtPair(p: Judged): string {
  return `sim ${p.sim.toFixed(3)}  「${p.a}」↔「${p.b}」`;
}

/** 两轮都真的判成了（不是「没答」）—— 分母必须这样对齐，见 AGENTS R-4 第 3 条。 */
function answeredCountries(r: DedupeResult): CountryProbe[] {
  return (r.llmJudge ?? []).filter((c) => c.ran && !c.error);
}

async function main() {
  console.log(`召回下限对照：days=${days} limit=${limit} pv=${pv} provider=${provider} 抬高到 floor=${floor}`);
  console.log(`基线 = 不传 minside（走 PAIR_CANDIDATE_MIN_SIM）；实验组 = minside=${floor}\n`);

  const baseRun = await runOnce('基线', '');
  if (baseRun.ok === false && !baseRun.llmJudge) {
    console.error(`基线请求失败：${baseRun.error}`);
    process.exit(1);
  }
  const raisedRun = await runOnce('实验组', `&minside=${floor}`);
  if (raisedRun.ok === false && !raisedRun.llmJudge) {
    console.error(`实验组请求失败：${raisedRun.error}`);
    process.exit(1);
  }

  const showConv = (label: string, r: DedupeResult) => {
    const p = r.llmJudgeParams;
    console.log(
      `[${label}] pairRecallUsed=${JSON.stringify(p?.pairRecallUsed)}` +
        ` 覆盖档=${p?.pairRecallUsed?.overridden.join(',') || '(无)'}` +
        ` | providerRequested=${p?.providerRequested ?? '(未钉)'} pvUsed=${p?.judgePromptVersionUsed}`,
    );
  };
  showConv('基线', baseRun);
  showConv('实验组', raisedRun);
  console.log('');

  const baseBy = new Map(answeredCountries(baseRun).map((c) => [c.country, c]));
  const raisedBy = new Map(answeredCountries(raisedRun).map((c) => [c.country, c]));

  const skipped = (baseRun.llmJudge ?? [])
    .filter((c) => c.error || !c.ran)
    .map((c) => `${c.country}(${c.error ?? 'ran=false'})`);
  if (skipped.length) console.log(`⚠️ 基线里没跑成的国家：${skipped.join(' / ')}\n`);

  let totalRemoved = 0;
  let totalAdded = 0;

  for (const [cc, b] of baseBy) {
    const r = raisedBy.get(cc);
    console.log(`${'='.repeat(72)}\n${cc}`);
    if (!r) {
      console.log(`  ⚠️ 实验组缺这个国家（可能被限流），跳过`);
      continue;
    }
    console.log(
      `  行数 基线=${b.rowsInWindow} / 实验=${r.rowsInWindow}` +
        `   | 喂模型 基线=${b.judgedSampleSize} / 实验=${r.judgedSampleSize}`,
    );
    if (b.judgedSampleSize !== r.judgedSampleSize) {
      console.log(
        `  ⚠️ **喂给模型的行数不同** ⇒ 两轮的输入不是同一批（抬高下限会缩小「有对可选的条目」集合吗？` +
          `不会 —— 下限只影响选对，不影响喂进去的行）。这个差必须解释清楚再看下面的数字。`,
      );
    }
    console.log(
      `  候选对 基线=${b.candidatePairs}（下限之上 ${b.candidatesAboveFloor} / 优先档之上 ${b.candidatesAbovePriority}）` +
        `  实验=${r.candidatePairs}（下限之上 ${r.candidatesAboveFloor} / 优先档之上 ${r.candidatesAbovePriority}）`,
    );
    console.log(
      `  判「是」 基线=${b.judgedPairs}  实验=${r.judgedPairs}` +
        `   | 判「否」 基线=${b.declinedPairs}  实验=${r.declinedPairs}` +
        `   | 极性否决 基线=${b.vetoedPairs}  实验=${r.vetoedPairs}`,
    );
    console.log(
      `  合并成组 基线=${b.groups}  实验=${r.groups}` +
        `   | 通道 基线=${b.provider ?? '?'}  实验=${r.provider ?? '?'}`,
    );

    // ---- 内建不变量 ----
    if (b.candidatesAbovePriority !== r.candidatesAbovePriority) {
      console.log(
        `  ❌ 不变量①不成立：优先档之上的对数本该**一模一样**` +
          `（minside 抬到 prioritySim 不该改变 tier1），却 ${b.candidatesAbovePriority} ≠ ${r.candidatesAbovePriority}` +
          ` ⇒ **旋钮接到了不该接的地方**，下面的差异不可信。`,
      );
    } else {
      console.log(`  ✅ 不变量①：优先档之上的对数两轮相同（${b.candidatesAbovePriority}）⇒ tier1 未被扰动`);
    }
    if (r.candidatesAboveFloor !== b.candidatesAbovePriority) {
      console.log(
        `  ⚠️ 不变量②不成立：抬高后的「下限之上」本应等于抬高前的「优先档之上」` +
          `（两者都是 sim ≥ ${floor} 的对数），却 ${r.candidatesAboveFloor} ≠ ${b.candidatesAbovePriority}` +
          ` ⇒ 可能把 minside 接到了 prioritySim 上，或线上默认值与本地假设不同。`,
      );
    } else {
      console.log(`  ✅ 不变量②：抬高后的下限之上（${r.candidatesAboveFloor}）== 抬高前的优先档之上`);
    }

    // ---- 消掉的对：基线问了、实验组**根本没问** ----
    const askedRaised = new Set(
      [...(r.pairs ?? []), ...(r.declined ?? []), ...(r.vetoed ?? [])].map(pairKey),
    );
    const askedBase = new Set(
      [...(b.pairs ?? []), ...(b.declined ?? []), ...(b.vetoed ?? [])].map(pairKey),
    );

    const removed = (b.pairs ?? []).filter((p) => !askedRaised.has(pairKey(p)));
    const added = (r.pairs ?? []).filter((p) => !askedBase.has(pairKey(p)));

    totalRemoved += removed.length;
    totalAdded += added.length;

    if (removed.length) {
      console.log(
        `\n  ★ 基线判「是」但实验组**根本没问**的 ${removed.length} 对` +
          `（= 砍掉补充档直接消掉的合并；**逐对人工看有没有真重复**）：`,
      );
      for (const p of removed.sort((x, y) => x.sim - y.sim)) console.log(`     ${fmtPair(p)}`);
    } else {
      console.log(`\n  （基线判「是」的对里，没有一对是实验组没问的）`);
    }

    if (added.length) {
      console.log(`\n  ⚠️ 实验组判「是」但基线**没问**的 ${added.length} 对：`);
      for (const p of added.sort((x, y) => x.sim - y.sim)) console.log(`     ${fmtPair(p)}`);
    }

    // ---- 代价：抬高下限后**再也不会被问**的真重复窗口 ----
    const lostFromDeclined = (b.declined ?? []).filter(
      (p) => !askedRaised.has(pairKey(p)) && p.sim >= floor,
    );
    if (lostFromDeclined.length) {
      console.log(
        `\n  ⚠️ 基线判「否」、实验组没问、且 sim ≥ ${floor} 的 ${lostFromDeclined.length} 对` +
          `（应当为空；非空说明两轮输入不同）`,
      );
    }

    // ---- 实际合并结果（最直接的后果）----
    const fmtGroups = (g?: Array<{ kept: string; dropped: string[] }>) =>
      (g ?? []).map((x) => `${x.kept} ⊃[${x.dropped.length}]`).join('  ·  ') || '(无)';
    console.log(`\n  基线组：${fmtGroups(b.groupTitles)}`);
    console.log(`  实验组：${fmtGroups(r.groupTitles)}`);
    console.log(
      `  静默丢弃条数 基线=${(b.groupTitles ?? []).reduce((n, g) => n + g.dropped.length, 0)}` +
        `  实验=${(r.groupTitles ?? []).reduce((n, g) => n + g.dropped.length, 0)}`,
    );
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`汇总：砍掉补充档共消掉 **${totalRemoved}** 对基线判「是」的合并；新增 **${totalAdded}** 对。`);
  console.log(
    `⚠️ 这**不是**净值：消掉的那些里有多少是**真重复**（= 代价）需要人工过目上面的标题。` +
      `本脚本刻意不下这个结论 —— 没有标注就算不出净值（AGENTS R-5）。`,
  );
  console.log(
    `⚠️ 两轮是**先后**跑的，窗口随新闻滑动。若某国「喂模型的行数」两轮不同，该国数字不可直接对照。`,
  );
}

main().catch((e) => {
  console.error('脚本抛错：', e);
  process.exit(1);
});

/**
 * ★ 这一行**不是装饰**，删掉会让**云端构建失败**（2026-10-07 实测踩到）。
 *
 * `tsconfig.json` 的 `include` 是个通配全部 `.ts` 的 glob（`**` 接 `/*.ts`），而
 * `scripts/build.sh` 里的
 * `pnpm next build` 会跑它自己的 TypeScript 步骤 ⇒ **`scripts/` 下的每个 .ts
 * 都被编进同一个 program**。
 *
 * 而 **`import` / `export` 一个都没有的文件是「脚本」而不是「模块」** ——
 * 它的顶层声明落在**全局命名空间**里。于是两个各自写着 `const BASE` 的脚本
 * （本文件 + `analyze-judge-order.ts`）会让构建报：
 *
 *     Type error: Cannot redeclare block-scoped variable 'BASE'.
 *
 * 症状极具迷惑性：**旧容器继续服务**，外部看到的就是「推送成功、版本没换」，
 * 与「推送没触发构建」**在观测上完全同形**。
 * 结构性防线见 `scripts/test-script-hygiene.ts`。
 */
export {};
