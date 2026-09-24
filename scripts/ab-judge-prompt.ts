/**
 * 判组提示词的**固定语料 A/B**：同一批标题对，逐版本跑一遍，报对照结果。
 *
 * 用法：
 *   pnpm judge:ab                            # 跑所有可用版本，比对照
 *   pnpm judge:ab --versions 1,3             # 只跑指定版本
 *   pnpm judge:ab --provider zhipu-flash     # 钉住通道（**跑 A/B 应该总是带上**）
 *   pnpm judge:ab --provider zhipu-flash --repeat 3   # 每版 3 轮，分出噪声
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
  return json;
}

/** 判定标签的显示映射。`error` 单独一档：调用失败**不是**判否，别让它们长得一样。 */
function cell(v: string | undefined): string {
  const map: Record<string, string> = { same: '是', diff: '否', vetoed: '拦', error: '!失败' };
  return (map[v ?? ''] ?? '?').padEnd(2, ' ');
}

/**
 * 按**倒序**发同一批对，用于测「顺序敏感性」。
 *
 * `order[k]` = 第 k 个**发出去**的条目对应 fixture 里的第几个 pair。
 * 倒序时第 k 条对应 `n-1-k`，所以要映射回来才能逐对比。
 *
 * 为什么需要它（2026-09-24 实测，**这条改写了整个仪器的可信度**）：
 * 同一个版本、同一条通道、**同一批 12 对**，只把顺序倒过来，
 * **3/12 对翻转** —— 含用户报的那对 Unibank（原顺序判「是」，倒序判「否」）。
 * 而 v1 与 v3 的版本差异只有 1–2 对 ⇒ **差异比顺序噪声还小，
 * 这批语料根本分辨不出两版。** 不测这一项，就会把顺序噪声当成版本收益去定版。
 */
async function probeReversed(
  pv: number | undefined,
): Promise<{ res: ProbeResponse; order: number[] }> {
  const gold = JSON.parse(readFileSync(resolve(process.cwd(), fixturePath), 'utf8')) as GoldFile;
  const n = gold.pairs.length;
  const rev = gold.pairs.map((_, i) => n - 1 - i); // 发出去的顺序（fixture 下标）
  const body = {
    ...(pv !== undefined ? { pv } : {}),
    ...(pinnedProvider ? { provider: pinnedProvider } : {}),
    // 只发 a/b —— `expect`/`note` 一律不发，它们只用于本地统计与展示。
    pairs: rev.map((i) => ({ a: gold.pairs[i].a, b: gold.pairs[i].b })),
  };
  const res = await fetch(`${BASE}/api/judge-pairs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = (await res.json()) as ProbeResponse;
  if (!res.ok) throw new Error(`HTTP ${res.status}：${json.error || JSON.stringify(json).slice(0, 300)}`);
  return { res: json, order: rev };
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
    for (const v of versions) {
      const wobble: string[] = [];
      let dead = 0;
      for (let i = 0; i < gold.pairs.length; i++) {
        const s = judgedSet(v, i);
        if (s.size === 0) {
          dead++;
          continue;
        }
        allDead = false;
        if (s.size > 1) wobble.push(`[${i}] ${[...s].map((x) => cell(x).trim()).join('/')}`);
      }
      const deadPart = dead
        ? `⚠️ ${dead}/${gold.pairs.length} 对**没判成**（调用失败或被极性拦下，不计入稳定性）`
        : '';
      const rest = gold.pairs.length - dead;
      const stablePart = !rest
        ? ''
        : wobble.length
          ? `${wobble.length} 对摇摆 —— ${wobble.join('、')}`
          : '其余判定全部一致';
      console.log(
        `pv=${v} 自身稳定性（${repeat} 轮）：` + [deadPart, stablePart].filter(Boolean).join('；'),
      );
    }
    if (allDead) {
      console.log('');
      console.log('!'.repeat(70));
      console.log('⚠️ 两版**一对都没真的判成** —— 下面所有数字只反映「调用失败」，不反映判定力。');
      console.log('   本地最常见的成因：没配 API Key（本项目 .env.local 是私密配置，仓库里只有 example）。');
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

    // ── 顺序敏感性：**这是真正的噪声地板** ────────────────────────────────
    //
    // `--repeat` 量的是「同一顺序、多跑几次」的抖动（实测经常是 0）。
    // 但真正决定结论能不能用的是**换一个顺序它会不会翻** —— 2026-09-24 实测：
    // 同一版本、同一通道、同一批 12 对，仅倒序 → **3 对翻转**，
    // 而版本间差异只有 1–2 对 ⇒ 差异被噪声淹没，这批语料**分辨不出两版**。
    // 所以这一节必须报，而且要在版本差异之后紧接着报（它是差异的解释边界）。
    if (!confounded) {
      console.log('');
      console.log(`顺序敏感性（pv=${runs[0].v}，同一批对仅**倒序**发一次）：`);
      try {
        const { res: revRes, order } = await probeReversed(runs[0].v);
        const revVerdict = new Map<number, string>();
        for (const [k, r] of (revRes.results ?? []).entries()) revVerdict.set(order[k], r.verdict);
        const orderFlips: string[] = [];
        for (let i = 0; i < gold.pairs.length; i++) {
          const a = [...judgedSet(runs[0].v, i)];
          const b = revVerdict.get(i);
          if (a.length !== 1 || (b !== 'same' && b !== 'diff')) continue; // 没判成的不比
          if (a[0] !== b) orderFlips.push(`[${i}] ${cell(a[0]).trim()}→${cell(b).trim()}`);
        }
        console.log(`  ${orderFlips.length}/${gold.pairs.length} 对翻转` + (orderFlips.length ? ` —— ${orderFlips.join('、')}` : ''));
        if (orderFlips.length === 0) {
          console.log('  ⇒ 本批语料对顺序不敏感，上面的版本差异可以当结论用。');
        } else if (orderFlips.length >= Math.max(1, stableFlips + shakyFlips)) {
          console.log('');
          console.log('  ' + '!'.repeat(66));
          console.log(
            `  ⚠️ **顺序噪声（${orderFlips.length} 对）≥ 版本间差异（${stableFlips + shakyFlips} 对）**` +
              ' ⇒ 这批语料**分辨不出这两个版本**。',
          );
          console.log('     上面的 ★修好 / ★★回退 **不可作为定版依据** —— 换个顺序就可能反过来。');
          console.log('     要定版必须先扩语料（门 1：历史 42S/24D 那份从未落盘），或先消掉顺序敏感。');
          console.log('  ' + '!'.repeat(66));
        } else {
          console.log(`  ⇒ 顺序噪声（${orderFlips.length} 对）小于版本差异（${stableFlips + shakyFlips} 对），差异方向可参考。`);
        }
      } catch (err) {
        console.log(`  ⚠️ 顺序敏感性测不了：${err instanceof Error ? err.message : String(err)}`);
        console.log('  ⇒ 没有噪声地板，上面的版本差异**无法判断是否显著**，别据此定版。');
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
    if (wrong > 0 || unjudged > 0) {
      console.log('');
      console.log(
        `--strict：默认版本 pv=${defV} 共识判错 ${wrong} 对、未判成 ${unjudged} 对，退出码 1`,
      );
      if (unjudged) {
        console.log('        （「未判成」= 调用失败或被极性拦下 —— 没验到就是没验到，不算通过）');
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
