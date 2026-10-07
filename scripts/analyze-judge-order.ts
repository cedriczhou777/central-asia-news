/**
 * 「判定是不是被**顺序**操纵的」—— 直接在**生产真实候选批**上做反事实实验。
 *
 * 用法：
 *   pnpm tsx scripts/analyze-judge-order.ts                       # 全部国家，默认 2 个顺序
 *   pnpm tsx scripts/analyze-judge-order.ts --days 3 --top 40
 *   pnpm tsx scripts/analyze-judge-order.ts --country uz --shuffles 2
 *   pnpm tsx scripts/analyze-judge-order.ts --provider zhipu --retry 4
 *
 * ## 为什么需要它（2026-10-06）
 *
 * 固定语料 A/B 实测：**同一版本、同一通道、同一批对，只把顺序倒过来**，
 * `zhipu` 上 pv=3 有 9 对翻转、pv=4 有 2 对；`zhipu-flash` 上分别是 13 / 12 对，
 * 而且**两个通道的翻转方向正好相反**（zhipu 倒序偏「否」、flash 倒序偏「是」）。
 * 版本之间的差异只有 ≤7 对 —— **顺序的影响比要比较的东西还大**。
 *
 * 更要紧的是：固定语料是**按语义手工排的**，它的"正序"与生产顺序没有关系。
 * 而生产的顺序是**确定的、可查的**：`selectCandidatePairs` 把候选对按
 * `sim` **降序**拼接（优先档 `sim ≥ 0.35` 在前，补充档 `0.20–0.35` 在后）。
 *
 * 于是有一个可证伪的机制性假说：
 *
 *   H1：模型对批次里**靠后**的条目更倾向判「是」；
 *       而生产恰好把**风险最高的候选对（补充档，0.20–0.35）放在最后**
 *       ⇒ 位置偏置正好作用在最容易被误合并的那批对上。
 *
 * 线上 3 天窗口的实测支持它：6 个已核实的误合并 `sim` 全在 **0.207–0.333**，
 * 也就是全部落在补充档。
 *
 * 本脚本就是 H1 的实验：**同一批对，两个顺序各发一次**，
 * 看 (a) 判定会不会变、(b) 变了多少、(c) 往哪个方向变。
 *
 * ## ⚠️ 本脚本**不能**用来复现生产的判定
 *
 * `/api/judge-pairs` 走的是「显式配对」形态（把每对的标题摊平成 2N 个条目再编号），
 * 生产的 pair 形态是从**文章列表**里编号再给配对 —— **提示词的条目构成不同**。
 * 所以这里的绝对数字不可与 `dedupe-check` 的判定逐对对照；
 * 本脚本的用途是**同一形态下的两个顺序相比**，那个比较是干净的。
 *
 * ## ⚠️ 还差一截：`judge-pairs` 的上限比生产小
 *
 * `MAX_PAIRS = 40`（route 里写死），而生产 `PAIR_MAX_CANDIDATES = 48`。
 * 既然批次组成会改变判定，这就意味着**用本接口验不出 48 对时的生产行为**。
 * 脚本会把这 8 对差额显式打出来，别当没发生。
 */
const BASE = process.env.BASE || 'https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

const days = Math.max(1, Number(argValue('days') ?? '3') || 3);
const limit = Math.max(1, Number(argValue('limit') ?? '400') || 400);
const topN = Math.max(2, Number(argValue('top') ?? '40') || 40);
const onlyCountry = argValue('country');
const pinnedProvider = argValue('provider');
const shuffles = Math.max(0, Number(argValue('shuffles') ?? '0') || 0);
/** 是否加一个「打散」顺序。默认开（`--interleave 0` 关掉）—— 它是「不重排批次、只改次序」里最像修法的那个候选。 */
const interleave = argValue('interleave') !== '0';
const retry429 = Math.max(0, Number(argValue('retry') ?? '4') || 0);
const delayMs = Math.max(0, Number(argValue('delay') ?? '0') || 0);
const BASE_RETRY_MS = 8_000;

/** 与 `src/lib/utils.ts` 同源。**必须同源**：本脚本要靠它校验线上给的 `sim`。 */
function normalizeText(text: string, maxLen = 120): string {
  return (text || '')
    .replace(/<[^>]+>/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, maxLen)
    .join(' ');
}
function charBigrams(text: string): Set<string> {
  const set = new Set<string>();
  const cleaned = text.replace(/\s+/g, '');
  if (cleaned.length <= 1) {
    set.add(cleaned);
    return set;
  }
  for (let i = 0; i < cleaned.length - 1; i++) set.add(cleaned.substring(i, i + 2));
  return set;
}
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  const sa = charBigrams(na);
  const sb = charBigrams(nb);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 确定性洗牌：同一命令重跑给出同一组顺序，否则「结论变了」又会多一种解释。 */
function shuffledOrder(n: number, seed: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 「打散」顺序：把 sim 最高的一半与最低的一半**交错**排列（`[0, n-1, 1, n-2, …]`）。
 *
 * 用于区分两种机制（2026-10-06）：
 *  · **M1 位置**：越靠后越容易判「是」 ⇒ 只要风险对不集中在末尾就好 ⇒ 打散有效；
 *  · **M2 锚定**：头几条的形状定下「这批有没有重复」的基调 ⇒ 打散只能部分缓解。
 * 两种机制都预测「打散的结果介于降序与升序之间」，但 M1 还预测「打散时低相似对的判是率
 * 明显低于降序」。所以看**分档判是率**，不是只看总数。
 */
function interleavedOrder(n: number): number[] {
  const out: number[] = [];
  let lo = 0;
  let hi = n - 1;
  let takeLow = true;
  while (lo <= hi) {
    if (takeLow) out.push(lo++);
    else out.push(hi--);
    takeLow = !takeLow;
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Pair = { sim: number; a: string; b: string };
type JudgeResponse = {
  ok: boolean;
  error?: string;
  provider?: string;
  judgePromptVersionUsed?: number;
  results?: Array<{ i: number; verdict: 'same' | 'diff' | 'vetoed' | 'error' }>;
};

async function postJudge(body: unknown, label: string): Promise<JudgeResponse> {
  let last: JudgeResponse | undefined;
  for (let attempt = 0; attempt <= retry429; attempt++) {
    if (attempt > 0) {
      const wait = BASE_RETRY_MS * 2 ** (attempt - 1);
      console.log(`    ⏳ ${label} 第 ${attempt} 次重试（被限流），等 ${(wait / 1000).toFixed(0)}s`);
      await sleep(wait);
    } else if (delayMs) {
      await sleep(delayMs);
    }
    const res = await fetch(`${BASE}/api/judge-pairs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const json = (await res.json()) as JudgeResponse;
    if (!res.ok) throw new Error(`HTTP ${res.status}：${json.error || JSON.stringify(json).slice(0, 300)}`);
    last = json;
    if (json.ok !== false) return json;
    if (!/429|访问量过大|rate ?limit/i.test(json.error ?? '')) return json;
  }
  console.log(`    ⚠️ ${label}：重试 ${retry429} 次后依旧被限流`);
  return last!;
}

/** 按给定顺序（数组元素 = `pairs` 的下标）发一批并映射回 `pairs` 下标。 */
async function sendInOrder(
  pairs: Pair[],
  order: number[],
  label: string,
): Promise<{ verdict: Map<number, string>; provider?: string; ok: boolean; error?: string }> {
  const body = {
    ...(pinnedProvider ? { provider: pinnedProvider } : {}),
    pairs: order.map((i) => ({ a: pairs[i].a, b: pairs[i].b })),
  };
  const res = await postJudge(body, label);
  const verdict = new Map<number, string>();
  for (const [k, r] of (res.results ?? []).entries()) verdict.set(order[k], r.verdict);
  return { verdict, provider: res.provider, ok: res.ok, error: res.error };
}

const cell = (v: string | undefined) =>
  ({ same: '是', diff: '否', vetoed: '拦', error: '!失败' })[v ?? ''] ?? '?';

async function main() {
  console.log(`服务：${BASE}`);
  console.log(`窗口：最近 ${days} 天（limit=${limit}）；每国取 sim 最高的 ${topN} 对（= 生产顺序的前缀）`);
  console.log(`通道：${pinnedProvider ?? '未钉住（走降级链）'}`);
  console.log('');

  const url = `${BASE}/api/dedupe-check?days=${days}&llm=1&debug=1&limit=${limit}`;
  const dump = (await (await fetch(url, { signal: AbortSignal.timeout(180_000) })).json()) as {
    window?: { since?: string };
    llmJudgeParams?: { judgePromptVersionUsed?: number; scope?: unknown };
    llmJudge?: Array<Record<string, unknown>>;
  };
  const arr = dump.llmJudge ?? [];
  if (!arr.length) throw new Error('dedupe-check 没返回 llmJudge —— 是不是没加 ?llm=1&debug=1？');
  console.log(
    `部署指纹：judgePromptVersionUsed = ${dump.llmJudgeParams?.judgePromptVersionUsed}；窗口起点 ${dump.window?.since}`,
  );
  console.log('');

  const orderLabels = ['sim降序(生产)', 'sim升序', ...(interleave ? ['打散(交错)'] : []), ...Array.from({ length: shuffles }, (_, k) => `乱序#${k + 1}`)];
  let totalFlips = 0;
  let totalPairs = 0;
  let fwd = 0;
  let back = 0;

  for (const c of arr) {
    const country = String(c.country ?? '?');
    if (onlyCountry && country !== onlyCountry) continue;

    // 一次判定里三类结果的并集就是**完整候选批**（互不相交）。
    const all: Pair[] = [
      ...((c.pairs ?? []) as Pair[]),
      ...((c.declined ?? []) as Pair[]),
      ...((c.vetoed ?? []) as Pair[]),
    ];
    const declared = Number(c.candidatePairs ?? NaN);
    if (all.length !== declared) {
      throw new Error(
        `${country}：pairs+declined+vetoed = ${all.length}，但响应自称 candidatePairs = ${declared} —— ` +
          '三类结果的并集不再是完整候选批，说明响应字段语义变了；下面的结论会少掉一部分对，先修脚本。',
      );
    }
    // 用本地 similarity 复核线上给的 sim：对不上就说明字段语义/实现变了，
    // 那「按 sim 排序」这件事本身就不成立了，必须当场报出来。
    const badSim = all.filter((p, i) => Math.abs(similarity(p.a, p.b) - p.sim) > 1e-6);
    if (badSim.length) {
      throw new Error(
        `${country}：${badSim.length}/${all.length} 对的 sim 与本地 similarity() 对不上（例：` +
          `线上 ${badSim[0].sim} vs 本地 ${similarity(badSim[0].a, badSim[0].b)}）。` +
          '本脚本的整个前提是「能自己重建生产顺序」，先修 similarity 再谈别的。',
      );
    }

    const sorted = [...all].sort((x, y) => y.sim - x.sim);
    const batch = sorted.slice(0, topN);
    const dropped = sorted.length - batch.length;

    console.log('='.repeat(78));
    console.log(
      `${country}：候选 ${all.length} 对，本脚本发 ${batch.length} 对` +
        (dropped ? `（⚠️ **少发 ${dropped} 对** —— judge-pairs 的 MAX_PAIRS=40，生产上限是 48）` : ''),
    );
    console.log(
      `  这 ${batch.length} 对的 sim：${batch[0].sim.toFixed(3)} … ${batch[batch.length - 1].sim.toFixed(3)}；` +
        `其中 ≥0.35（优先档）${batch.filter((p) => p.sim >= 0.35).length} 对、` +
        `<0.35（补充档）${batch.filter((p) => p.sim < 0.35).length} 对`,
    );

    const orders: number[][] = [batch.map((_, i) => i)];
    orders.push(batch.map((_, i) => batch.length - 1 - i)); // sim 升序
    if (interleave) orders.push(interleavedOrder(batch.length));
    for (let k = 0; k < shuffles; k++) orders.push(shuffledOrder(batch.length, 0x9e3779b9 ^ ((k + 1) * 2654435761)));

    const verdicts: Array<Map<number, string>> = [];
    for (let k = 0; k < orderLabels.length; k++) {
      const { verdict, provider, ok, error } = await sendInOrder(batch, orders[k], `${country}/${orderLabels[k]}`);
      verdicts.push(verdict);
      const same = [...verdict.values()].filter((v) => v === 'same').length;
      const judged = [...verdict.values()].filter((v) => v === 'same' || v === 'diff').length;
      console.log(
        `  ${orderLabels[k].padEnd(16)} provider=${provider ?? '?'} 判「是」${String(same).padStart(2)} ` +
          `（判成 ${judged}/${batch.length}）${ok ? '' : `　⚠️ ${error ?? '调用失败'}`}`,
      );
    }
    console.log('');

    // 分档判是率 —— 这一列才是「位置偏置 vs 锚定」的判据。
    //
    // 位置机制（M1）预测：**降序时补充档的判是率异常高**（它们被放在末尾），
    //   而打散后补充档的判是率明显回落 ⇒ 打散是有用的。
    // 锚定机制（M2）预测：判是率主要由**头几条**的样子定，打散只能部分缓解。
    const bands: Array<[string, (p: Pair) => boolean]> = [
      ['优先档(≥0.35)', (p) => p.sim >= 0.35],
      ['补充档(<0.35)', (p) => p.sim < 0.35],
    ];
    for (let k = 0; k < orderLabels.length; k++) {
      if (k === 0 || orderLabels[k].startsWith('乱序')) continue; // 只看「降序 / 升序 / 打散」
      const parts = bands.map(([name, f]) => {
        const idx = batch.map((p, i) => [p, i] as const).filter(([p]) => f(p)).map(([, i]) => i);
        const same = idx.filter((i) => verdicts[k].get(i) === 'same').length;
        return `${name} ${same}/${idx.length}`;
      });
      console.log(`      ${orderLabels[k]} 分档判是：${parts.join('、')}`);
    }

    // 逐对比：以第 1 个顺序（生产顺序）为基准
    const flips: string[] = [];
    /** 与 `flips` 一一对应的 fixture 下标，用来把翻转对**标题**打出来（只打下标读的人还得回头找）。 */
    const flipIdx: number[] = [];
    for (let i = 0; i < batch.length; i++) {
      const base = verdicts[0].get(i);
      if (base !== 'same' && base !== 'diff') continue;
      for (let k = 1; k < verdicts.length; k++) {
        const other = verdicts[k].get(i);
        if (other !== 'same' && other !== 'diff') continue;
        totalPairs++;
        if (base !== other) {
          totalFlips++;
          if (base === 'same') fwd++;
          else back++;
          flips.push(`[${i}] sim=${batch[i].sim.toFixed(3)} ${orderLabels[0]}判${cell(base)}→${orderLabels[k]}判${cell(other)}`);
          flipIdx.push(i);
        }
      }
    }
    if (flips.length) {
      console.log(`  逐对翻转 ${flips.length} 条：`);
      for (const f of flips) console.log(`    ${f}`);
      // 只看第一条会把一整类误合并当成孤例 —— 打前 3 条，够看清形态又不会刷屏。
      for (const i of [...new Set(flipIdx)].slice(0, 3)) {
        console.log(`    ↳ 「${batch[i].a}」`);
        console.log(`      「${batch[i].b}」`);
      }
    } else {
      console.log('  逐对翻转 0 条 —— 这一国在本接口形态下对顺序不敏感。');
    }

    // ── 「多顺序取交」这个候选修法的量化 ──────────────────────────────
    //
    // 位置偏置是**单向**的（某个方向下更容易判「是」），所以「同一批对按两个顺序各判一次、
    // 只有**所有顺序都判是**才合并」应当能消掉相当一部分误合并，代价是漏掉一部分真重复。
    // 这正好对上项目已定的取舍：**误合并是不可逆丢信息，漏合并只是冗余**。
    //
    // ⚠️ 这里给的是**条数**，不是准确率 —— 本接口没有人工标注（那 23 对才是标注语料）。
    // 要判「值不值得」，得看 `noisy` 里有多少条是**已核实的误合并形态**（同主体不同客体 /
    // 不同指标 / 不同机构议程），那是人工在 `judge-gold.json` 里标过的那几类。
    const allSame = new Set<number>();
    let firstOrder = true;
    for (const v of verdicts) {
      const s = new Set([...v.entries()].filter(([, x]) => x === 'same').map(([i]) => i));
      if (firstOrder) {
        for (const i of s) allSame.add(i);
        firstOrder = false;
      } else {
        for (const i of [...allSame]) if (!s.has(i)) allSame.delete(i);
      }
    }
    const baseSame = new Set([...verdicts[0].entries()].filter(([, x]) => x === 'same').map(([i]) => i));
    const removed = [...baseSame].filter((i) => !allSame.has(i));
    console.log(
      `  多序取交：${orderLabels[0]}判「是」${baseSame.size} 条 ⇒ 各顺序都判「是」**${allSame.size}** 条` +
        `（去掉 ${removed.length} 条）`,
    );
    if (removed.length) {
      console.log(`    被去掉的 ${removed.length} 条 sim：${removed.map((i) => batch[i].sim.toFixed(3)).join('、')}`);
      console.log('    （sim 越低越像「同模板不同槽位」那一类——那一类正是线上已核实的误合并）');
    }
    console.log('');
  }

  console.log('='.repeat(78));
  console.log(
    `合计：可比对次 ${totalPairs}，翻转 ${totalFlips} 条` +
      (totalPairs ? `（${((totalFlips / totalPairs) * 100).toFixed(1)}%）` : ''),
  );
  if (totalFlips) {
    console.log(`  方向：是→否 ${fwd} 条、否→是 ${back} 条` + (fwd === totalFlips || back === totalFlips ? '（**全朝同一方向**）' : ''));
    console.log(
      fwd > back
        ? '  ⇒ 把风险对**往后放**会让它更容易被判「是」 —— 生产顺序（sim 降序）正是这样排的。H1 成立。'
        : '  ⇒ 方向与 H1 相反：往后放反而更容易判「否」 —— H1 不成立，别照它改生产顺序。',
    );
  } else {
    console.log('  ⇒ 本接口形态下没测到顺序效应 —— **不等于生产也没有**（提示词条目构成不同），别据此推翻固定语料的结论。');
  }
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
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
 * （本文件 + `analyze-recall-floor.ts`）会让构建报：
 *
 *     ./scripts/analyze-judge-order.ts:46:7
 *     Type error: Cannot redeclare block-scoped variable 'BASE'.
 *
 * 症状极具迷惑性：**旧容器继续服务**，外部看到的就是「推送成功、版本没换」，
 * 与「推送没触发构建」**在观测上完全同形**。本次为此误判了一轮 C″。
 * ⚠️ 而 `tsc -p tsconfig.json` **能**抓到它 —— 前提是你**在最后一个文件写完之后**跑；
 * 本次漏掉的原因就是 tsc 在新增第二个脚本**之前**跑的。
 * 结构性防线见 `scripts/test-script-hygiene.ts`（断言 scripts 下每个 .ts 都是模块）。
 */
export {};
