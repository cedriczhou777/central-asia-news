/**
 * 判组提示词的**固定语料 A/B**：同一批标题对，逐版本跑一遍，报对照结果。
 *
 * 用法：
 *   pnpm judge:ab                            # 跑所有可用版本，比对照
 *   pnpm judge:ab --versions 1,3             # 只跑指定版本
 *   pnpm judge:ab --provider zhipu-flash     # 钉住通道（**跑 A/B 应该总是带上**）
 *   pnpm judge:ab --provider zhipu-flash --repeat 3   # 每版 3 轮，分出噪声
 *   pnpm judge:ab --provider zhipu --repeat 3 --delay 2000 --retry 5   # 主通道被限流时
 *   pnpm judge:ab --provider zhipu --repeat 3 --shuffles 3            # 多顺序对照（定版必须）
 *   BASE=http://localhost:3000 pnpm judge:ab
 *   pnpm judge:ab --strict                   # 默认版本有任何一对判错就退出码 1（当闸门用）
 *
 * ## 为什么不是「跑两遍影子运行比一比」
 *
 * `GET /api/dedupe-check` 的逐对判定依赖**当天库里的候选对** —— 窗口滑动、
 * 新闻每天更新，同一份提示词在不同日子喂到模型的是不同的对。于是
 * 「这次结论和上次不一样」永远有两种解释：**提示词改了**／**今天新闻换了**。
 * 拿它在改判据前后各跑一次，比出来的差异**分不清是哪一种**。
 *
 * 这个脚本喂的是 `scripts/fixtures/judge-gold.json` 里写死的标题对，
 * 配 `pv=` 切换版本 —— **唯一变量只剩提示词**。
 *
 * ## ⚠️ 但「只剩提示词」还得再钉住通道才成立
 *
 * 2026-09-24 实测：不传 `provider` 时，降级链按 `PROVIDERS` 顺序取第一个不报错的
 * 通道，而「谁不报错」取决于这一刻谁被 429 限流。同一次运行的两臂就落到了不同通道：
 *
 *   pv=1 → provider=zhipu       （跑第一臂时 glm-4.7-flash 恰好没被限流）
 *   pv=3 → provider=zhipu-flash （跑第二臂时 zhipu 已经 429）
 *
 * 于是「两臂判定不同」多出第三种解释：**换了型号**。这与「窗口滑动」是同一类污染，
 * 只是藏在更下游、更看不出来 —— 输出的对照表长得完全正常。
 * 所以本脚本会**检查各臂实际用的通道**：不一致就大字警告，
 * `--strict` 下直接退出码 1（宁可没有结论，也不要一个被污染的结论）。
 *
 * ## ⚠️ 还有一个变量：模型自己不稳
 *
 * 12 对语料上 v1 与 v3 都报 11/12，差别只是**各自错的那一对不同** ——
 * 这种量级下头条数字由**一个翻转**决定，而它可能来自提示词、也可能来自模型噪声。
 * `--repeat N` 先量出**版本自身的摇摆对数**（噪声地板），再把版本差异分成
 * 「稳定差异」与「摇摆」，只有前者能拿来定版。只跑 1 轮就下结论 = 比谁运气好。
 *
 * ## ⚠️⚠️ 限流会把「稳定性」这一节变成假绿灯（2026-10-06 实测）
 *
 * 主通道 `zhipu` 是共享账号，429 是常态。跑 `--versions 3,4 --repeat 3` 时
 * **六条请求只过了一条**，于是：pv=4 整臂全失败、pv=3 只有 1 轮有证据。
 * 而当时的「自身稳定性」只看「判成的那些轮里一不一致」——
 * 一个**只判成 1 轮**的对自己也是「一致」，脚本就打出了
 * `pv=3 自身稳定性（3 轮）：其余判定全部一致`。**限流被读成了结论。**
 *
 * 两处修法（都在本脚本里）：
 * ① 请求级 429 退避（`--retry`，默认 4 次指数退避；`--delay` 控制请求间隔）；
 * ② 稳定性按**证据轮数**算：轮数 < `repeat` 的对单列一档，不算稳定；
 *    若全批没有任何一对凑满 `repeat` 轮，整节直接判「不成立」。
 *    `--strict` 下这些对同样算失败 —— 单轮的正确不叫验证过。
 *
 * ## ⚠️⚠️ 顺序不是「噪声」，是**混淆项**（2026-10-06 实测，这一条改变了比较方法）
 *
 * 23 对语料、每版 3 轮（自身 0 摇摆）：
 *
 *   | 顺序 | pv=3  | pv=4  | Δ(pv4−pv3) |
 *   | 正序 | 17/23 | 22/23 | **+5**     |
 *   | 倒序 | 20/23 | 20/23 | **0**      |
 *
 * pv=3 的 6 个误合并**倒序后全部消失**，其顺序敏感对翻转方向 **100% 是「是→否」**。
 * ⇒ 单序比较等于比两个任意采样点：Δ 在 +5 与 0 之间跳，谁也定不了版。
 * ⇒ 生产链路的顺序由候选生成器排定，**既不是正序也不是倒序** —— 单序成绩不对应线上成绩。
 *
 * 所以定版前一律加 `--shuffles N`，脚本按**同序配对 Δ 是否在所有顺序下同号**下结论：
 * 全同号 ⇒ 只有**方向**可信（幅度不可引用）；异号 ⇒ 分辨不出，别改默认版本。
 *
 * ## ⚠️⚠️ 最要命的一条：**判定对「列表顺序」敏感**
 *
 * `--repeat` 量的是「同一顺序、多跑几次」—— 2026-09-24 实测这个抖动是 **0/12**。
 * 但同一版本、同一通道、**同一批 12 对**，只把顺序**倒过来**发：
 *
 *   翻转 **3/12 对**，其中包括用户报的那对 Unibank（原顺序判「是」→ 倒序判「否」）。
 *
 * 而 v1 与 v3 的版本差异只有 **1–2 对** ⇒ **噪声 > 信号，这 12 对分辨不出两个版本。**
 * ⇒ 脚本固定跑一节「顺序敏感性」，并在噪声 ≥ 差异时打出大字警告：
 *   **★修好 / ★★回退 均不可作为定版依据。**
 *
 * 这也顺带解释了两件旧事：
 *   ① 代码注释里记的「同一批候选对，两次分别判出 4 对 / 10 对」；
 *   ② `judge-gold.json` 里 `observedV1/V2` 两列（采自 `dedupe-check` 的**当天列表**）
 *      与今天 `pv=1` 的判定在 [1] / [11] 两对上不一致 —— **顺序/组成变了**，
 *      所以那两列**不能**与 `judge-pairs` 的结果直接对照。
 *
 * ## 语料的期望值从哪来
 *
 * 人工标注（`expect: same|diff` + `note` 写理由），标题**逐字取自线上**。
 * 标注只用于**统计对错**，不会被传给模型 —— 模型只看得到标题。
 *
 * ⚠️ 语料不是「越多越好」而是「越准越好」：`expect` 标错一对，就会让
 * 一个正确的判据看起来像错的，然后被「修」坏。改标注前先想清楚理由，
 * 拿不准的一对标 `expect: null`（脚本会把它算作未标注、不计入对错）。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const BASE = process.env.BASE || 'https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com';
const FIXTURE = 'scripts/fixtures/judge-gold.json';

/** 单次请求超时。服务端判组自己的超时是 45s，这里留出余量。 */
const REQUEST_TIMEOUT_MS = 90_000;

type GoldPair = { a: string; b: string; expect?: 'same' | 'diff' | null; note?: string };
type GoldFile = { _README?: string; _provenance?: Record<string, string>; pairs: GoldPair[] };

type ProbePair = {
  i: number;
  a: string;
  b: string;
  expect?: 'same' | 'diff';
  note?: string;
  /** `error` = 模型调用失败（**不是**判否），不该被算进「判错」 */
  verdict: 'same' | 'diff' | 'vetoed' | 'error';
  correct?: boolean;
  sim: number | null;
};
type ProbeResponse = {
  ok: boolean;
  error?: string;
  judgePromptVersion?: number;
  judgePromptVersionUsed?: number;
  judgePromptVersions?: number[];
  judgeMode?: string;
  /** 实际回答的通道 —— 与 `providerRequested` 一起读，才知道这个结论值不值得信 */
  provider?: string;
  providerRequested?: string;
  availableProviders?: string[];
  candidateCount?: number;
  judgedSameCount?: number;
  declinedCount?: number;
  vetoed?: Array<{ sim: number; a: string; b: string }>;
  results?: ProbePair[];
  accuracy?: { labeled: number; correct: number; wrong: ProbePair[] };
};

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

const strict = process.argv.includes('--strict');
const fixturePath = argValue('file') || FIXTURE;

/**
 * 要钉住的通道。`--provider zhipu-flash` 或环境变量 `PROVIDER`。
 *
 * 不传也允许（比如只想看看当前状态），但脚本会检查各臂实际用了哪条通道，
 * 不一致就警告 —— 见文件头「还得再钉住通道才成立」。
 */
const pinnedProvider = argValue('provider') || process.env.PROVIDER || undefined;

/**
 * 每个版本重复跑几次。默认 1（只跑一次）。
 *
 * ## 为什么需要它（2026-09-24 的教训）
 *
 * 12 对语料上 v1 与 v3 都是 11/12 —— 差别只是**各自错的那一对不同**。
 * 这种量级下，「哪版更准」的头条数字**由一个翻转决定**，而这个翻转可能来自：
 * ① 提示词真的改了；② 模型自己不稳（`JUDGE_TEMPERATURE = 0` 也不保证逐字一致，
 * 本项目已实测过同一批候选两次判出 4 对 / 10 对）。
 * 只跑一次，这两种解释分不开，A/B 就成了「比谁运气好」。
 *
 * 跑 N 次后：先看**版本自身的摇摆对数**（噪声地板），再看版本间的差异是
 * 稳定差异还是摇摆 —— 只有稳定差异才能拿来判「哪版更准」。
 */
const repeat = Math.max(1, Number(argValue('repeat') ?? '1') || 1);

/**
 * 两次判定请求之间至少间隔多久（毫秒）。`--delay 3000`。默认 0。
 *
 * 只在**主通道被限流**时需要：连续发请求会一直撞 429，一条都过不去。
 */
const delayMs = Math.max(0, Number(argValue('delay') ?? '0') || 0);

/**
 * 遇到 429 时最多重试几次。默认 4（`--retry 0` 可关掉）。
 *
 * ## 为什么必须给 429 留退避（2026-10-06 实测）
 *
 * `zhipu` 是共享账号，**429 是常态而不是异常**。而不重试的后果不是「少几对」，
 * 是**整张对照表作废**：有一次 `--versions 3,4 --repeat 3` 六条请求只过了一条，
 * 结果 pv=4 整臂全失败、pv=3 只有一个轮次有证据 —— 而「自身稳定性」那一节
 * 因为只看「判成的那些轮次里一不一致」，把**单轮的判定**报成了
 * 「3 轮：其余判定全部一致」。一个被限流限出来的假绿灯。
 *
 * ⚠️ 重试**不是**在掩盖失败：每次重试都打一行日志，重试耗尽后依旧按失败返回，
 * 由调用方算进「未判成」。它只是把「一次瞬时限流」与「这一版真的不会判」分开。
 */
const retry429 = Math.max(0, Number(argValue('retry') ?? '4') || 0);
const RETRY_BASE_MS = 8_000;

/**
 * 除正序/倒序外，再跑几个**确定性乱序**。默认 0。
 *
 * ## 为什么是「必须」而不是「锦上添花」（2026-10-06 实测）
 *
 * 23 对语料、`zhipu`、每版 3 轮，正序与倒序各跑一次：
 *
 * | 顺序 | pv=3 | pv=4 | Δ(pv4−pv3) |
 * |---|---|---|---|
 * | 正序 | 17/23 | 22/23 | **+5** |
 * | 倒序 | 20/23 | 20/23 | **0** |
 *
 * pv=3 的 6 个误合并**在倒序下全部消失**，而它的 9 个顺序敏感对翻转方向
 * **100% 是「是→否」**。⇒ **判定力不是一个数，是「顺序 → 正确数」的一条曲线**，
 * 而正序只是这条曲线上的一个点。拿单个顺序比两版，等于比两个任意采样点。
 *
 * 更要紧的是：**生产链路的顺序是候选生成器排出来的，既不是正序也不是倒序**。
 * 所以「正序成绩」根本不对应线上成绩 —— 只有**跨多个顺序的分布**才对应。
 *
 * 跑 N 个乱序后，脚本改为按「同序配对 Δ 是否在所有顺序下同号」判显著性：
 * 方向全一致 ⇒ 方向可参考（幅度仍不可引用）；出现异号 ⇒ 这批语料分辨不出。
 */
const shuffles = Math.max(0, Number(argValue('shuffles') ?? '0') || 0);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 确定性洗牌（LCG）。**必须确定性**：同一命令重跑要给出同一组顺序，
 * 否则「这次结论不一样」又会多一种解释（顺序换了）。
 */
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
 * 发一次判定请求，带 429 退避。
 *
 * ⚠️ 服务端把模型的 429 **包在 HTTP 200 里**返回（`ok:false` + `error` 里带 `HTTP 429`），
 * 所以只看 `res.ok` 是看不见限流的 —— 必须同时看 `json.ok` 与 `json.error`。
 * 这也意味着：任何「只看 HTTP 状态码」的下游都会把限流读成成功。
 */
async function postJudge(body: unknown, label: string): Promise<ProbeResponse> {
  let last: ProbeResponse | undefined;
  for (let attempt = 0; attempt <= retry429; attempt++) {
    if (attempt > 0) {
      const wait = RETRY_BASE_MS * 2 ** (attempt - 1);
      console.log(`  ⏳ ${label} 第 ${attempt} 次重试（被限流），等 ${(wait / 1000).toFixed(0)}s`);
      await sleep(wait);
    } else if (delayMs) {
      await sleep(delayMs);
    }
    const res = await fetch(`${BASE}/api/judge-pairs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = (await res.json()) as ProbeResponse;
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}：${json.error || JSON.stringify(json).slice(0, 300)}`);
    }
    last = json;
    if (json.ok !== false) return json;
    // 不是限流就**不要**重试：重试一个「通道名写错了」的请求只会白等 2 分钟。
    if (!/429|访问量过大|rate ?limit/i.test(json.error ?? '')) return json;
  }
  console.log(`  ⚠️ ${label}：重试 ${retry429} 次后依旧被限流 —— 这一段计入「未判成」`);
  return last!;
}

async function probe(pv: number | undefined): Promise<ProbeResponse> {
  const gold = JSON.parse(readFileSync(resolve(process.cwd(), fixturePath), 'utf8')) as GoldFile;
  const body = {
    ...(pv !== undefined ? { pv } : {}),
    ...(pinnedProvider ? { provider: pinnedProvider } : {}),
    // 只把 a/b/expect/note 传过去；`expect` 服务端只用来统计对错，不喂模型。
    pairs: gold.pairs.map((p) => ({
      a: p.a,
      b: p.b,
      ...(p.expect ? { expect: p.expect } : {}),
      ...(p.note ? { note: p.note } : {}),
    })),
  };
  return postJudge(body, `pv=${pv ?? '默认'}（正序）`);
}

/** 判定标签的显示映射。`error` 单独一档：调用失败**不是**判否，别让它们长得一样。 */
function cell(v: string | undefined): string {
  const map: Record<string, string> = { same: '是', diff: '否', vetoed: '拦', error: '!失败' };
  return (map[v ?? ''] ?? '?').padEnd(2, ' ');
}

/**
 * 按**指定顺序**发同一批对，用于测「顺序敏感性」。
 *
 * `order[k]` = 第 k 个**发出去**的条目对应 fixture 里的第几个 pair。
 * 收到结果后要按 `order` 映射回来才能逐对比。
 *
 * 为什么需要它（2026-09-24 实测，**这条改写了整个仪器的可信度**）：
 * 同一个版本、同一条通道、**同一批 12 对**，只把顺序倒过来，
 * **3/12 对翻转** —— 含用户报的那对 Unibank（原顺序判「是」，倒序判「否」）。
 * 而 v1 与 v3 的版本差异只有 1–2 对 ⇒ **差异比顺序噪声还小，
 * 这批语料根本分辨不出两版。** 不测这一项，就会把顺序噪声当成版本收益去定版。
 */
async function probeInOrder(
  pv: number | undefined,
  order: number[],
  label: string,
): Promise<{ res: ProbeResponse; order: number[] }> {
  const gold = JSON.parse(readFileSync(resolve(process.cwd(), fixturePath), 'utf8')) as GoldFile;
  const body = {
    ...(pv !== undefined ? { pv } : {}),
    ...(pinnedProvider ? { provider: pinnedProvider } : {}),
    // 只发 a/b —— `expect`/`note` 一律不发，它们只用于本地统计与展示。
    pairs: order.map((i) => ({ a: gold.pairs[i].a, b: gold.pairs[i].b })),
  };
  return { res: await postJudge(body, label), order };
}

async function main() {
  const gold = JSON.parse(readFileSync(resolve(process.cwd(), fixturePath), 'utf8')) as GoldFile;
  const labeled = gold.pairs.filter((p) => p.expect === 'same' || p.expect === 'diff').length;
  console.log(`语料：${fixturePath}（${gold.pairs.length} 对，其中 ${labeled} 对有人工标注）`);
  console.log(`服务：${BASE}`);
  console.log(
    `通道：${pinnedProvider ? `已钉住 ${pinnedProvider}` : '未钉住（走降级链）'}` +
      (pinnedProvider ? '' : '　⚠️ 各臂可能落到不同型号，对照表可能被污染'),
  );
  if (gold._provenance?.capturedAt) console.log(`语料采集于：${gold._provenance.capturedAt}`);
  if (repeat > 1) console.log(`重复轮次：每版 ${repeat} 轮（用于把模型噪声与提示词差异分开）`);
  console.log('');

  // 先探一次（不带 pv）拿到服务端**实际**注册的版本清单。
  // 不本地硬编码：那样会出现「本地以为有 v3、线上还没部署」的假对照 —— 脚本报出的
  // 对照表看起来正常，实际两次跑的是同一版。
  const first = await probe(undefined);
  const available = first.judgePromptVersions ?? [];
  if (available.length === 0) {
    throw new Error('服务端没返回 judgePromptVersions，无法确定可用版本 —— 是不是部署太旧？');
  }
  // 通道名也先在探针里校验一次：写错了要**现在**就报，而不是等跑完所有臂
  // 才发现每条请求都在悄悄走全链（那正是 `provider=` 想消灭的形态）。
  const serverProviders = first.availableProviders;
  if (pinnedProvider && serverProviders && !serverProviders.includes(pinnedProvider)) {
    throw new Error(
      `服务端没有通道 ${pinnedProvider}；可用：${serverProviders.join(', ')}`,
    );
  }
  console.log(
    `部署指纹 judgePromptVersion = ${first.judgePromptVersion}；可用版本：${available.join(', ')}` +
      (available.length < 2 ? '　⚠️ 只剩一个版本，对照已经退化（pv 参数失去意义）' : ''),
  );

  const wantArg = argValue('versions');
  const versions = wantArg
    ? wantArg.split(',').map((s) => Number(s.trim()))
    : // 不含 pv 的那次探针结果就当第一个版本，避免重复调用
      available;
  const unknown = versions.filter((v) => !available.includes(v));
  if (unknown.length) throw new Error(`服务端没有这些版本：${unknown.join(', ')}；可用：${available.join(', ')}`);

  const runs: Array<{ v: number; res: ProbeResponse }> = [];
  /** 版本 → 该版本跑过的全部结果（`--repeat` 次）。用于把「版本差异」和「模型噪声」分开。 */
  const reps = new Map<number, ProbeResponse[]>();
  for (const v of versions) {
    const list: ProbeResponse[] = [];
    for (let n = 0; n < repeat; n++) {
      // 不带 pv 的那次探针跑的就是**默认版本**，与它同版本时复用它，省一次模型调用。
      // 只在第 1 轮复用：后面的轮次要真跑，否则 `--repeat` 测不出噪声。
      const res = n === 0 && v === first.judgePromptVersionUsed ? first : await probe(v);
      list.push(res);
    }
    reps.set(v, list);
    const res = list[0];
    runs.push({ v, res });
    const used = res.provider ?? '?';
    // 钉了通道却没走它 → 必须当场显眼标出来。这种「配置写了、实际没生效」
    // 是本项目反复踩的形态（cron 的 hours、Telegram 的频道格式都是同一类）。
    const offPin = pinnedProvider && used !== pinnedProvider ? `　⚠️ 没走钉住的 ${pinnedProvider}` : '';
    console.log(
      `pv=${v}：provider=${used}${offPin} 问 ${res.candidateCount} 对，判「是」${res.judgedSameCount}、` +
        `判「否」${res.declinedCount}、极性拦下 ${res.vetoed?.length ?? 0}` +
        (res.accuracy ? `　标注 ${res.accuracy.labeled} 对里对 ${res.accuracy.correct}` : '') +
        (res.error ? `　⚠️ ${res.error}` : ''),
    );
  }
  console.log('');

  /** 某个版本、某一对在 `--repeat` 轮里出现过的判定集合（含 `error`/`vetoed`） */
  const verdictSet = (v: number, i: number): Set<string> =>
    new Set(
      (reps.get(v) ?? []).map(
        (r) => r.results?.find((x) => x.i === i)?.verdict ?? '?',
      ),
    );
  /**
   * 只有「是 / 否」算**真的判过**。
   *
   * `error`（模型调用失败）与 `vetoed`（极性判据拦下、**根本没问模型**）都不是判定 ——
   * 这是本项目的铁律：**失败与判否不能长得一样**。服务端的 `accuracy` 已经这么算了，
   * 但客户端第一版漏了这一步，后果实测可见：本地跑（没配 Key、所有调用都失败）时，
   * 脚本报出「12 对全部判错」+「自身稳定性：全部一致，噪声地板 = 0 对」——
   * 一个**完全虚假**的结论。而这里恰恰是决定「留哪版提示词」的地方，不能有假阳性。
   */
  const JUDGED = new Set(['same', 'diff']);
  const judgedSet = (v: number, i: number): Set<string> =>
    new Set([...verdictSet(v, i)].filter((x) => JUDGED.has(x)));
  /**
   * 某一对在几轮里**真的判成了**（`same`/`diff`）。取值 0…`repeat`。
   *
   * ⚠️ 这是「稳定性」那一节的**证据量**，而 `judgedSet` 只回答「判成的那些轮里出现过什么」。
   * 一个**只判成 1 轮**的对自己也是 `size === 1` —— 与「3 轮都判成且完全一致」
   * 在下面那张表里**长得一模一样**。
   *
   * 2026-10-06 实测：`--versions 3,4 --repeat 3` 六条请求被 429 挡掉五条，
   * pv=3 只有 1 轮有证据，脚本照样打出「3 轮：其余判定全部一致」——
   * 一个被限流限出来的假绿灯，而这一节恰恰是「噪声地板」，是判「版本差异是否显著」的依据。
   * **少几轮证据的「稳定」不是稳定，是没有证据。**
   */
  const judgedRounds = (v: number, i: number): number =>
    (reps.get(v) ?? []).filter((r) => {
      const x = r.results?.find((y) => y.i === i)?.verdict;
      return x === 'same' || x === 'diff';
    }).length;
  /**
   * 共识判定：在**判过的**那些轮里完全一致才给值。
   * 摇摆、全是失败、全被拦 —— 一律返回 undefined（没有资格参与对错统计）。
   */
  const consensus = (v: number, i: number): string | undefined => {
    const s = judgedSet(v, i);
    return s.size === 1 ? [...s][0] : undefined;
  };

  // 自身稳定性：这是整张对照表的**噪声地板**。
  // 如果版本差异比噪声还小，那这个差异就不是差异 —— 2026-09-24 的 v1/v3 正是这种情况。
  if (repeat > 1) {
    let allDead = true;
    /** 有没有**任意一版、任意一对**拿到了完整的 `repeat` 轮证据。没有 ⇒ 这一节整体不成立。 */
    let anyFull = false;
    for (const v of versions) {
      const wobble: string[] = [];
      const thin: string[] = [];
      let dead = 0;
      for (let i = 0; i < gold.pairs.length; i++) {
        const s = judgedSet(v, i);
        if (s.size === 0) {
          dead++;
          continue;
        }
        allDead = false;
        const rounds = judgedRounds(v, i);
        if (rounds >= repeat) anyFull = true;
        else thin.push(`[${i}] ${rounds}/${repeat}`);
        if (s.size > 1) wobble.push(`[${i}] ${[...s].map((x) => cell(x).trim()).join('/')}`);
      }
      const deadPart = dead
        ? `⚠️ ${dead}/${gold.pairs.length} 对**没判成**（调用失败或被极性拦下，不计入稳定性）`
        : '';
      const thinPart = thin.length
        ? `⚠️ ${thin.length} 对**证据轮数不足**（${thin.join('、')}）—— 只在部分轮次里判成的对，` +
          '它的「一致」是没被检验的一致，**不算稳定**'
        : '';
      const rest = gold.pairs.length - dead;
      const stablePart = !rest
        ? ''
        : wobble.length
          ? `${wobble.length} 对摇摆 —— ${wobble.join('、')}`
          : thin.length
            ? '其余对在**已判成的轮次里**一致（但见上面的轮数不足，别当噪声地板用）'
            : '其余判定全部一致';
      console.log(
        `pv=${v} 自身稳定性（${repeat} 轮）：` + [deadPart, thinPart, stablePart].filter(Boolean).join('；'),
      );
    }
    if (allDead) {
      console.log('');
      console.log('!'.repeat(70));
      console.log('⚠️ 两版**一对都没真的判成** —— 下面所有数字只反映「调用失败」，不反映判定力。');
      console.log('   本地最常见的成因：没配 API Key（本项目 .env.local 是私密配置，仓库里只有 example）。');
      console.log('!'.repeat(70));
    } else if (!anyFull) {
      // ⚠️ 这一条是 2026-10-06 补的：以前只要**不是全挂**就算「有证据」，
      // 于是「1/3 轮有证据」被当成「稳定」，把限流读成了结论。
      console.log('');
      console.log('!'.repeat(70));
      console.log(
        `⚠️ **没有任何一对拿到完整的 ${repeat} 轮证据** —— 这一节的「稳定性」**不成立**，` +
          '它只反映了「哪几轮恰好没被限流」。',
      );
      console.log('   最常见成因：主通道被限流（429）。加大 --retry / --delay，或换到不挤的时间重跑。');
      console.log('!'.repeat(70));
    } else {
      console.log('  ↳ 说明：摇摆的对**不能**用来判「哪版更准」—— 下面的版本差异会单独标出它们。');
    }
    console.log('');
  }

  // 通道一致性：这是「这批对照结论能不能用」的前置条件，必须排在所有结论之前说。
  const usedProviders = [
    ...new Set(versions.flatMap((v) => (reps.get(v) ?? []).map((r) => r.provider ?? '?'))),
  ];
  const confounded = usedProviders.length > 1;
  if (confounded) {
    console.log('!'.repeat(70));
    console.log(`⚠️ 各轮用的通道不一样：${usedProviders.join('、')}`);
    console.log('   下面的「版本间差异」分不清是**提示词**造成的还是**型号**造成的，★结论不可采信。');
    console.log(`   重跑并钉住一条通道：pnpm judge:ab --provider ${usedProviders[0]}`);
    console.log('!'.repeat(70));
    console.log('');
  }

  // 逐对并排
  //
  // 不做精细列对齐：标题里是中英混排（双宽字符），用 `.padEnd` 算出来的宽度
  // 在终端里本来就会错位，硬凑只会让代码变复杂而输出照旧乱。改成「一行一对、
  // 版本判定直接跟在后面」，靠固定分隔符读，反而更清楚。
  const byV = runs.map((r) => new Map((r.res.results ?? []).map((x) => [x.i, x])));
  console.log(`逐对判定（期望 = 人工标注；√ 判对，× 判错，拦 = 被极性判据拦下没问模型）`);
  if (repeat > 1) console.log(`（多轮：显示该版本多轮的判定；出现「是/否」这种斜杠表示它自己就摇摆）`);
  console.log('');
  for (let i = 0; i < gold.pairs.length; i++) {
    const g = gold.pairs[i];
    const expectLabel = g.expect === 'same' ? '是' : g.expect === 'diff' ? '否' : '未标';
    const parts = runs.map(({ v }) => {
      const all = verdictSet(v, i);
      const s = judgedSet(v, i);
      // 没判成的对（失败 / 被拦）与摇摆的对都**不给** √/×：
      // 它们既不是判对也不是判错，判据还没走到能评它的那一步。
      const notJudged = s.size === 0;
      const shaky = s.size > 1;
      const text = notJudged
        ? [...all].map((x) => cell(x).trim()).join('/') || '?'
        : shaky
          ? [...s].map((x) => cell(x).trim()).join('/')
          : cell([...s][0]).trim();
      const mark = notJudged ? ' ' : shaky ? '~' : !g.expect ? ' ' : [...s][0] === g.expect ? '√' : '×';
      return `pv${v}=${text}${mark}`;
    });
    const sim = byV[0].get(i)?.sim;
    console.log(`[${String(i).padStart(2)}] sim=${sim === null || sim === undefined ? ' -' : sim.toFixed(2)} 期望=${expectLabel}  ${parts.join('  ')}`);
    console.log(`     「${g.a}」`);
    console.log(`     「${g.b}」`);
    // 判错的对把理由打出来，省得回头翻语料
    const anyBad = runs.some(({ v }) => {
      const c = consensus(v, i);
      return g.expect !== undefined && c !== undefined && c !== g.expect;
    });
    if (anyBad && g.note) console.log(`     ↳ 应为「${expectLabel}」：${g.note}`);
  }
  console.log('');

  // 逐版本汇总
  console.log('='.repeat(70));
  for (const { v } of runs) {
    const accs = (reps.get(v) ?? []).map((r) => r.accuracy).filter((a) => a !== undefined);
    if (!accs.length) {
      // ⚠️ 这里**不能**只说「没有标注对」：真正的原因通常是**一次判定都没成功**
      // （调用失败 / 全被极性拦下），而语料里 12 对全都有人工标注。
      // 两者混在一句里，会让人以为「是语料的问题」。
      const judgedAny = gold.pairs.some((_, i) => judgedSet(v, i).size > 0);
      console.log(
        `pv=${v}：` +
          (judgedAny
            ? '没有标注对，无法统计（语料里 expect 全为空？）'
            : '⚠️ 一对都没判成（调用失败或被极性拦下）—— **不是「语料没标注」**，看上面每对的 pv 列'),
      );
      continue;
    }
    if (repeat > 1) {
      // 多轮时**不报单轮数字**：那会让人误以为它就是这一版的成绩。
      // 报「逐轮正确数」（看波动）+「共识判错的对」（看稳定错误）。
      console.log(`pv=${v}：逐轮正确数 = ${accs.map((a) => `${a.correct}/${a.labeled}`).join('、')}`);
      const stableWrong: string[] = [];
      for (let i = 0; i < gold.pairs.length; i++) {
        const g = gold.pairs[i];
        if (g.expect !== 'same' && g.expect !== 'diff') continue;
        const c = consensus(v, i);
        if (c !== undefined && c !== g.expect) stableWrong.push(`[${i}] 期望「${g.expect === 'same' ? '是' : '否'}」实际「${c === 'same' ? '是' : '否'}」`);
      }
      console.log(
        `        共识判错 ${stableWrong.length} 对` +
          (stableWrong.length ? `：\n        × ${stableWrong.join('\n        × ')}` : ''),
      );
    } else {
      const a = accs[0];
      console.log(`pv=${v}：${a.correct}/${a.labeled} 正确` + (a.wrong.length ? `；判错 ${a.wrong.length} 对` : '；全对'));
      for (const w of a.wrong) {
        console.log(`        × 期望「${w.expect === 'same' ? '是' : '否'}」实际「${w.verdict === 'same' ? '是' : '否'}」：${w.a}　||　${w.b}`);
      }
    }
  }

  // 版本间差异：这才是「这次改动动了哪几对」的答案
  if (runs.length > 1) {
    console.log('');
    console.log(`版本间差异（基准 pv=${runs[0].v}${repeat > 1 ? `，每版 ${repeat} 轮取共识` : ''}）：`);
    let flips = 0;
    let stableFlips = 0;
    let shakyFlips = 0;
    let incomparable = 0;
    for (let i = 0; i < gold.pairs.length; i++) {
      const baseSet = judgedSet(runs[0].v, i);
      for (let k = 1; k < runs.length; k++) {
        const curSet = judgedSet(runs[k].v, i);
        // 有一边没判成 → **不可比**，不是「无差异」。
        // 把它算成「一致」会让「这一版跑挂了」伪装成「两版结论相同」。
        if (baseSet.size === 0 || curSet.size === 0) {
          incomparable++;
          continue;
        }
        // 判定集合完全相同才算「没有差异」—— 摇摆过的对不因为某一轮碰巧相同就放过。
        const identical =
          baseSet.size === curSet.size && [...baseSet].every((x) => curSet.has(x));
        if (identical) continue;
        flips++;
        const g = gold.pairs[i];
        // 两个集合**完全不相交**（任一轮都不重叠）才叫稳定差异。
        // 有交集 = 模型自己也会在两版之间摇摆，这批语料分辨不出来。
        const stable = [...baseSet].every((x) => !curSet.has(x));
        const b = consensus(runs[0].v, i);
        const c = consensus(runs[k].v, i);
        const good = stable && g.expect && c === g.expect && b !== g.expect;
        const label = stable
          ? good
            ? ' ★修好'
            : g.expect && b === g.expect
              ? ' ★★回退'
              : ''
          : ' ～摇摆（语料分辨不出，别据此定版）';
        if (stable) stableFlips++;
        else shakyFlips++;
        // ⚠️ 标签必须带**下标 + 两条标题**。原先只打 `g.a`，而语料里存在两对
        // **共用同一个 `a`** 的对（「阿塞拜疆与塞尔维亚讨论战略伙伴关系」既是
        // 「…关系关系」那对的 a，也是「阿塞拜疆与美国讨论战略关系」那对的 a）。
        // 结果是「★修好」和「★★回退」打出两行**一模一样**的文字，
        // 看起来像脚本坏了 —— 而这一节恰恰是决定「留哪版」的唯一依据，不能有歧义。
        const show = (s: Set<string>) =>
          `{${[...s].map((x) => cell(x).trim()).join('/')}}`;
        console.log(
          `  [${String(i).padStart(2)}] pv${runs[0].v}${show(baseSet)} → pv${runs[k].v}${show(curSet)}${label}`,
        );
        console.log(`        「${g.a}」 ↔ 「${g.b}」`);
      }
    }
    if (!flips) {
      console.log(
        incomparable
          ? `  无差异 —— 但其中 ${incomparable} 对**没判成**（失败/被拦），这部分是「不可比」而不是「一致」。`
          : '  无差异 —— 两个版本在这批语料上判定完全一致',
      );
    } else {
      console.log(
        `  小计：稳定差异 ${stableFlips} 对、摇摆 ${shakyFlips} 对、不可比 ${incomparable} 对` +
          (repeat === 1
            ? '（只跑了 1 轮，无法区分「提示词改的」与「模型不稳」—— 加 --repeat 3 再判）'
            : ''),
      );
    }

    // ── 多顺序对照：**这才是版本比较的正确姿势** ──────────────────────────
    //
    // `--repeat` 量的是「同一顺序、多跑几次」的抖动（实测经常是 0）。
    // 但真正决定结论能不能用的是**换一个顺序它会不会翻** —— 2026-09-24 实测：
    // 同一版本、同一通道、同一批 12 对，仅倒序 → **3 对翻转**。
    //
    // ⚠️ 2026-10-06 的实测把这一节彻底改写了。23 对语料、每版 3 轮（自身 0 摇摆）：
    //
    //   | 顺序 | pv=3  | pv=4  | Δ(pv4−pv3) |
    //   | 正序 | 17/23 | 22/23 | **+5**     |
    //   | 倒序 | 20/23 | 20/23 | **0**      |
    //
    // pv=3 的 6 个误合并**在倒序下全部消失**，其 9 个顺序敏感对翻转方向
    // **100% 是「是→否」**。三条结论：
    // ① 「判定力」不是一个数，是「顺序 → 正确数」的一条曲线，正序只是其中一个点；
    // ② 拿单序比两版 = 比两个任意采样点，Δ 可以在 +5 与 0 之间跳；
    // ③ 生产链路的顺序由候选生成器决定，**既不是正序也不是倒序**
    //    ⇒ 单序成绩根本不对应线上成绩。
    //
    // 所以：**每版各自测，且在多序下比同序 Δ 的符号**。
    // 各序 Δ 同号 ⇒ 方向可参考（幅度仍不可引用）；出现异号 ⇒ 这批语料分辨不出。
    // 这是项目自己写下的解封条件：「先消掉顺序敏感」。
    if (!confounded) {
      console.log('');
      const orderLabels = ['正序', '倒序', ...Array.from({ length: shuffles }, (_, k) => `乱序#${k + 1}`)];
      console.log(`多顺序对照（同一批对按 ${orderLabels.length} 种顺序各发一次，每版各测一遍）：`);
      /** 版本 → 顺序标签 → 「fixture 下标 → 判定」。正序用 `--repeat` 轮的判定集合表示。 */
      const orderVerdicts = new Map<number, Map<string, Map<number, Set<string>>>>();
      const noiseByV = new Map<number, number>();
      for (const { v } of runs) {
        const byOrder = new Map<string, Map<number, Set<string>>>();
        const fwd = new Map<number, Set<string>>();
        for (let i = 0; i < gold.pairs.length; i++) fwd.set(i, judgedSet(v, i));
        byOrder.set('正序', fwd);
        const flipDetail: string[] = [];
        let flipCount = 0;
        for (let k = 0; k < orderLabels.length - 1; k++) {
          const label = orderLabels[k + 1];
          // 倒序是 `n-1-i`；乱序用确定性种子，同一命令重跑给出同一组顺序。
          const order =
            k === 0
              ? gold.pairs.map((_, i) => gold.pairs.length - 1 - i)
              : shuffledOrder(gold.pairs.length, 0x9e3779b9 ^ ((k + 1) * 2654435761));
          try {
            const { res: ordRes, order: sent } = await probeInOrder(v, order, `pv=${v}（${label}）`);
            const m = new Map<number, Set<string>>();
            for (const [idx, r] of (ordRes.results ?? []).entries()) {
              m.set(sent[idx], new Set(JUDGED.has(r.verdict) ? [r.verdict] : []));
            }
            byOrder.set(label, m);
          } catch (err) {
            console.log(`  ⚠️ pv=${v} 的「${label}」测不了：${err instanceof Error ? err.message : String(err)}`);
          }
        }
        // 顺序敏感对数：正序唯一判定 vs 该顺序唯一判定，不一致就记一笔（只报数，逐对明细在下面）。
        for (const [label, m] of byOrder) {
          if (label === '正序') continue;
          for (let i = 0; i < gold.pairs.length; i++) {
            const a = fwd.get(i)!;
            const b = m.get(i);
            if (!b || a.size !== 1 || b.size !== 1) continue;
            if ([...a][0] !== [...b][0]) {
              flipCount++;
              const dir = [...a][0] === 'same' ? '是→否' : '否→是';
              flipDetail.push(`[${i}]${label} ${dir}`);
            }
          }
        }
        noiseByV.set(v, flipCount);
        orderVerdicts.set(v, byOrder);
        console.log(
          `  pv=${v}：跨顺序翻转 ${flipCount} 次（各顺序下「判成」的对数须一致才可比；` +
            (flipDetail.length ? `${flipDetail.join('、')}` : '无翻转') +
            '）',
        );
      }
      console.log('');

      // 逐顺序的「同序配对」成绩 —— 这一张表才是能下结论的地方。
      //
      // ⚠️ 两个必须做的校正（2026-10-06 实测暴露）：
      // ① **分母必须对齐**：正序那一格曾出现 `pv3 13/18` 对 `pv4 22/23` ——
      //    pv3 有 5 对没判成（被限流），直接比 13 与 22 是把「没答」当成了「答错」。
      //    这里只统计**两版都判成了**的对，分母因此恒等。
      // ② **「打平」不是「异号」**：Δ 出现 `+9、0、+3、+1` 时，旧判据按
      //    `every(d>0)` 判成「异号 ⇒ 分辨不出」。可 0 是平局，不是反向 ——
      //    「没有一个顺序显示 A 更差」与「A 有时更差」是两回事。
      const perOrder: Array<{ label: string; cells: Map<number, { correct: number; n: number }> }> = [];
      const labeledIdx = gold.pairs.map((g, i) => ({ g, i })).filter(({ g }) => g.expect === 'same' || g.expect === 'diff');
      const vList = runs.map((r) => r.v);
      for (const label of orderLabels) {
        const cells = new Map<number, { correct: number; n: number }>();
        /** 两版**都**给出唯一判定的对 —— 只有这些对能进分母，否则分母不等就没法比。 */
        const common = labeledIdx.filter(({ i }) =>
          vList.every((v) => {
            const s = orderVerdicts.get(v)?.get(label)?.get(i);
            return !!s && s.size === 1;
          }),
        );
        for (const v of vList) {
          const m = orderVerdicts.get(v)?.get(label);
          if (!m) continue;
          let correct = 0;
          for (const { g, i } of common) if ([...m.get(i)!][0] === g.expect) correct++;
          cells.set(v, { correct, n: common.length });
        }
        perOrder.push({ label, cells });
      }
      console.log('顺序        ' + vList.map((v) => `pv${v}`.padEnd(10)).join('') + '同序 Δ');
      const deltas: number[] = [];
      for (const { label, cells } of perOrder) {
        if (vList.some((v) => !cells.has(v))) {
          console.log(`  ${label.padEnd(8)} 未测全（有版本被限流）`);
          continue;
        }
        const ns = vList.map((v) => cells.get(v)!.n);
        const cs = vList.map((v) => cells.get(v)!.correct);
        const delta = cs[cs.length - 1] - cs[0];
        deltas.push(delta);
        const sameDen = new Set(ns).size === 1;
        console.log(
          `  ${label.padEnd(8)} ` +
            cs.map((c, k) => `${c}/${ns[k]}`.padEnd(10)).join('') +
            (delta > 0 ? `+${delta}（pv${vList[vList.length - 1]} 好）` : delta < 0 ? `${delta}（pv${vList[0]} 好）` : '0（平）') +
            (sameDen ? '' : '　⚠️ 分母不等（不该出现，脚本有 bug）'),
        );
      }

      if (!deltas.length) {
        console.log('  ⇒ 没有一条顺序测全，**拿不到可比成绩**，别据此定版。');
      } else {
        const A = vList[0];
        const B = vList[vList.length - 1];
        const fmt = deltas.map((d) => (d > 0 ? `+${d}` : `${d}`)).join('、');
        const better = deltas.filter((d) => d > 0).length;
        const worse = deltas.filter((d) => d < 0).length;
        const tie = deltas.filter((d) => d === 0).length;
        console.log('');
        if (worse === 0 && better > 0) {
          // 「没有一个顺序显示 B 更差」—— 这是**符号检验**意义上的结论，比「全同号正」弱、
          // 比「分辨不出」强得多。而且它配得上一个实测到的大差异（顺序噪声 21 vs 3 次）。
          console.log(
            `  ⇒ ${deltas.length} 个顺序里，pv${B} **没有一个顺序更差**（更好 ${better} 个、打平 ${tie} 个）：` +
              `Δ = ${fmt}。`,
          );
          console.log(`     ⇒ 方向可信：**pv${B} 不劣于 pv${A}**；幅度在 0…${Math.max(...deltas)} 对之间，别引用具体数字。`);
        } else if (better === 0 && worse > 0) {
          console.log(
            `  ⇒ ${deltas.length} 个顺序里，pv${B} **没有一个顺序更好**（更差 ${worse} 个、打平 ${tie} 个）：Δ = ${fmt}。`,
          );
          console.log(`     ⇒ 方向可信：**pv${B} 不优于 pv${A}** —— 不要切到 pv${B}。`);
        } else if (better > 0 && worse > 0) {
          console.log('  ' + '!'.repeat(66));
          console.log(
            `  ⚠️ 各顺序下的 Δ **异号**（${fmt}）：pv${B} 在 ${better} 个顺序下更好、在 ${worse} 个顺序下更差` +
              ' ⇒ 这批语料**分辨不出这两个版本**。',
          );
          console.log('     上面的 ★修好 / ★★回退 **不可作为定版依据** —— 换个顺序就可能反过来。');
          console.log('     要定版必须先扩语料（门 1：历史 42S/24D 那份从未落盘），或先消掉顺序敏感。');
          console.log('  ' + '!'.repeat(66));
        } else {
          console.log(`  ⇒ 各顺序 Δ 全为 0（${fmt}）—— 这批语料上两版判定一致，不必改默认版本。`);
        }
        const worst = Math.max(...[...noiseByV.values()], 0);
        if (worst >= Math.max(1, stableFlips + shakyFlips)) {
          console.log(
            `     ⚠️ 同时记一笔：单版跨顺序仍会翻 ${worst} 次，而版本间差异只有 ${stableFlips + shakyFlips} 对。` +
              '⇒ 上面那张逐对表的 ★修好 / ★★回退 **仍不可当逐对证据**，只能用整体方向。',
          );
        }
      }
      const spread = [...noiseByV.values()];
      if (spread.length > 1 && Math.min(...spread) !== Math.max(...spread)) {
        console.log(
          `  ↳ 各版跨顺序翻转次数相差 ${Math.min(...spread)}–${Math.max(...spread)} 次：**顺序敏感本身不是所有版本共有的** ——` +
            '更稳的那一版在生产里更可信（线上的顺序是候选生成器排的，你无法选择）。' +
            '⚠️ 这是**跨顺序**的次数（每版 × (顺序数−1)），与单序翻转对数不是同一量纲，别互相对照。',
        );
      }
    }
  }

  if (strict) {
    // 被污染的对照比「判错几对」更该拦住：它不报错，只是给出一个**错的结论**。
    // 一个错的结论会被当依据去改判据，然后越改越远 —— 代价比退出码 1 大得多。
    if (confounded) {
      console.log('');
      console.log('--strict：各臂通道不一致，对照被污染，退出码 1（加 --provider 重跑）');
      process.exit(1);
    }
    // 拿不到版本号就**报错退出**，不要当成「0 对判错」放过 ——
    // 那会让一个本该拦住的坏结果静默通过，正是本脚本存在的意义所在。
    const defV = first.judgePromptVersionUsed ?? first.judgePromptVersion;
    if (defV === undefined) {
      console.log('');
      console.log('--strict：服务端没返回 judgePromptVersion，无法判定默认版本，退出码 1');
      process.exit(1);
    }
    // 用**共识**判错数，不用某一轮的数字 —— 单轮数字可能是噪声甩出来的一次。
    // 带上下标一起走，别用 `indexOf`（语料里**存在完全相同的对**，
    // `{a,b}` 重复时 `indexOf` 会把两对指到同一个下标上）。
    const labeledIdx = gold.pairs
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => g.expect === 'same' || g.expect === 'diff');
    const wrong = labeledIdx.filter(({ g, i }) => {
      const c = consensus(defV, i);
      return c !== undefined && c !== g.expect;
    }).length;
    // ⚠️ **没判成的对也要算失败。** 只数「判错」的话，模型全挂（没 Key / 被限流）
    // 会得到 wrong=0 ⇒ `--strict` 给一个**绿灯**。那就是最糟的一种闸门：
    // 它把「什么都没验到」报成「验过了，没问题」。
    const unjudged = labeledIdx.filter(({ i }) => consensus(defV, i) === undefined).length;
    // ⚠️ **证据轮数不足的对也要算失败。** 这一条与上一条是同一类漏洞的另一半：
    // `unjudged` 只抓「**一轮都没**判成」的对，而「3 轮里只判成 1 轮」的对自己
    // `consensus` 照样给得出值（size===1），于是它既不算判错、也不算未判成 ——
    // `--strict` 会给一个**看着很干净**的绿灯，而事实上它是一对**没被重复验证**的对。
    // 只在 `--repeat > 1` 时有意义（跑 1 轮本来就谈不上「轮数不足」）。
    const thin = repeat > 1
      ? labeledIdx.filter(({ i }) => {
          const r = judgedRounds(defV, i);
          return r > 0 && r < repeat;
        }).length
      : 0;
    if (wrong > 0 || unjudged > 0 || thin > 0) {
      console.log('');
      console.log(
        `--strict：默认版本 pv=${defV} 共识判错 ${wrong} 对、未判成 ${unjudged} 对、` +
          `证据轮数不足 ${thin} 对，退出码 1`,
      );
      if (unjudged) {
        console.log('        （「未判成」= 调用失败或被极性拦下 —— 没验到就是没验到，不算通过）');
      }
      if (thin) {
        console.log(
          `        （「轮数不足」= ${repeat} 轮里只有部分轮次判成 —— 单轮的正确不叫验证过，` +
            '多半是主通道被限流；加大 --retry / --delay 重跑）',
        );
      }
      process.exit(1);
    }
  }
}

main().catch((err) => {
  // 打全错误再退出：这个脚本的失败原因通常是网络/部署，截断信息会让人误以为是判据问题。
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
