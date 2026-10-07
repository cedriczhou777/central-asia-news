/**
 * 召回层旋钮的**上线后台验收**（打线上公网域名，读 `GET /api/dedupe-check`）。
 *
 * 用法：`pnpm verify:knobs-live`（可加 `BASE=…` 换环境）
 *
 * ## 它验什么
 *
 * | 组 | 验的东西 | 花模型调用吗 |
 * |---|---|---|
 * | C / D | `cand=abc` / `provider=zzz` **当场 400**，且错误里点名参数、顺便回取值域 | 不花（在调模型之前就返回） |
 * | A | 钉通道 `provider=` ⇒ 实际回答的通道就是它 | 花（每国 1 次） |
 * | B | 限批 `cand=3` ⇒ **候选对真的 ≤ 3**（不只是回显了一个数字） | 花（每国 1 次） |
 *
 * ## 为什么值得单独有一个脚本（2026-10-07 实测）
 *
 * 它第一次跑就抓到一个**注释与事实不符**的缺陷：本文件的两处注释都写着
 * 「顶层 `pairRecall`」，而那个字段**只存在于参数非法的 400 响应体里** ⇒
 * 成功响应上根本读不到，照注释写的断言会**静默判错**（`undefined !== 48`）。
 * 纯读代码看不出来 —— 只有真打一次接口才会暴露。已修（成功响应也报默认三值），
 * 并在 `test:dedup` 里加了「字段必须在**成功响应**里」的源码断言。
 *
 * ⚠️ 判据设计上的一条纪律（本轮**连踩两次**，都记在下面，因为同类错误还会再来）：
 *
 * 1. **断言的前提必须可达。** A 组第一版要求「每国 `provider` 都是 zhipu」，
 *    但**候选对为 0 的国家根本不会调模型**、按设计就不报 `provider`
 *    ⇒ 那条断言**恒假**，看起来像功能坏了。
 * 2. ★ **「选出了候选对」不等于「调用成功」。** 第二版把 `candidatePairs > 0`
 *    当成「答了模型」，于是前提断言恒真、而主断言变成**环境相关** ——
 *    钉的通道恰好被限流时它照样红。正确区分：
 *    - `candidatePairs > 0` = 召回层**选出了要问的对**（与调用成败无关）；
 *    - `provider` 有值   = **调用成功且有人答了**（`askLlmJson` 成功时无条件带出通道名，
 *      而 `judgeExplicitPairs` 的两个早退分支 —— 调用失败 / 非法 JSON —— **都不带**）。
 *    ⇒ 所以 `provider` 缺失是**可用性**信号，不是接线信号。
 *
 * 现在的写法：只在**真的调通**的国家上断言「通道就是钉的那个」（防的是「别的通道漏进来」）；
 * 一个国家都没调通时判为 **⚠️ 无法验证**（退出码 2），**不让空集合恒真地过**。
 * 逐国会打出 `provider(选N/判N/否N)` 与失败原因，便于判断是「接线坏了」还是「上游在限流」。
 */
import { isJudgeAnswered } from './lib/judge-probe';

const BASE = process.env.BASE || 'https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com';
/**
 * 钉住的通道。默认取 **`zhipu-flash`**（`glm-4-flash-250414`）。
 *
 * ⚠️ 默认**不**取 `zhipu`（`glm-4.7-flash`）：那个是第一优先的免费档，
 * 但本项目实测它**常态 429**（1305 平台过载）。钉它会让这条验收大半时间
 * 落在「没一个国家调通」上 ⇒ 判为「无法验证」。钉一个**答得动**的通道，
 * 验的才是「only 有没有真的接上」，而不是「上游今天心情如何」。
 * 想验别的通道：`ONLY=zhipu pnpm verify:knobs-live`。
 */
const ONLY = process.env.ONLY || 'zhipu-flash';

type CountryProbe = {
  country: string;
  ran?: boolean;
  candidatePairs?: number;
  /** 模型判为「同一件事」的对数（**只有调用成功且有合法 JSON 时才可能 > 0**） */
  judgedPairs?: number;
  /** 被模型判「否」的对数（同上） */
  declinedPairs?: number;
  /** 这一国失败/降级的原因（调用失败、非法 JSON、簇超限…） */
  error?: string;
  provider?: string;
};
type Resp = {
  ok?: boolean;
  error?: string;
  llmJudge?: CountryProbe[];
  pairRecallKnobs?: Array<{ param: string; range: string }>;
  availableProviders?: string[];
  /** 默认三值（**生产口径**）—— 与 `llmJudgeParams.pairRecallUsed`（实际生效）分开报 */
  pairRecall?: { minSim: number; prioritySim: number; maxPairs: number };
  llmJudgeParams?: {
    providerRequested?: string;
    pairRecallUsed?: { minSim: number; prioritySim: number; maxPairs: number; overridden: string[] };
  };
};

let fails = 0;
/**
 * 「本轮**无法验证**」的项（与「失败」分开）。
 *
 * 存在的理由：有些断言的前提依赖**上游可用性**（钉住的通道此刻有没有被限流），
 * 前提不成立时那条断言要么**恒真**（空集合上「每国通道都是 x」恒真）、
 * 要么**误报失败**（看起来像功能坏了）。两种都错，所以单列一档，
 * 并用**不同的退出码**把它和真失败分开 —— 否则运维会把它当成前者。
 */
const inconclusive: string[] = [];
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? `  —— ${detail}` : ''}`);
  if (!cond) fails++;
};

async function req(qs: string): Promise<{ status: number; json: Resp | null; raw: string }> {
  const res = await fetch(`${BASE}/api/dedupe-check?${qs}&cb=${Date.now()}`, {
    signal: AbortSignal.timeout(240_000),
  });
  const text = await res.text();
  let json: Resp | null = null;
  try {
    json = JSON.parse(text) as Resp;
  } catch {
    /* 保留 raw */
  }
  return { status: res.status, json, raw: text.slice(0, 300) };
}

async function main() {
  console.log(`目标：${BASE}\n`);

  // ---- C / D：非法值必须当场 400（先跑，不花钱）----
  {
    const c = await req('days=1&llm=1&cand=abc');
    ok('C cand=abc ⇒ HTTP 400', c.status === 400, `status=${c.status} ${c.raw}`);
    ok(
      'C 错误信息点名 cand',
      typeof c.json?.error === 'string' && c.json.error.includes('cand'),
      c.json?.error ?? '(无 error)',
    );
    ok(
      'C 同时回可用的取值域（手误的人不用去翻源码）',
      Array.isArray(c.json?.pairRecallKnobs) && c.json.pairRecallKnobs.length === 3,
      JSON.stringify(c.json?.pairRecallKnobs),
    );

    const d = await req('days=1&llm=1&provider=zzz');
    ok('D provider=zzz ⇒ HTTP 400', d.status === 400, `status=${d.status} ${d.raw}`);
    ok(
      'D 错误信息点名 provider',
      typeof d.json?.error === 'string' && d.json.error.includes('provider=zzz'),
      d.json?.error ?? '(无 error)',
    );
    ok(
      'D 同时回可用通道清单',
      Array.isArray(d.json?.availableProviders) && d.json.availableProviders.length > 0,
      JSON.stringify(d.json?.availableProviders),
    );
    ok(
      '★ 400 响应里也带**默认三值**（`pairRecall`）—— 报错时也能顺便看清生产口径',
      c.json?.pairRecall?.maxPairs === 48,
      JSON.stringify(c.json?.pairRecall),
    );
  }

  // ---- A：钉通道 ----
  {
    const a = await req(`days=1&llm=1&limit=20&provider=${ONLY}&pv=3`);
    const p = a.json?.llmJudgeParams;
    ok('A 请求成功且返回逐国判定', a.status === 200 && Array.isArray(a.json?.llmJudge), `status=${a.status}`);
    ok(
      `A providerRequested=${ONLY}（声明）`,
      p?.providerRequested === ONLY,
      JSON.stringify(p?.providerRequested),
    );
    ok(
      'A pairRecallUsed.overridden 为空（没被召回旋钮覆盖，= 生产口径）',
      Array.isArray(p?.pairRecallUsed?.overridden) && p.pairRecallUsed.overridden.length === 0,
      JSON.stringify(p?.pairRecallUsed),
    );
    ok(
      '★ A 成功响应里也有**顶层 pairRecall**（默认三值，与 pairRecallUsed 分开）—— 2026-10-07 修的那个缺陷',
      a.json?.pairRecall?.maxPairs === 48 && a.json?.pairRecall?.prioritySim === 0.35,
      JSON.stringify(a.json?.pairRecall),
    );

    const ran = (a.json?.llmJudge ?? []).filter((c) => c.ran);
    /**
     * ★★ 判据的关键区分（2026-10-07 实测踩过，两次）：
     *
     * - `candidatePairs > 0` 只说明**召回层选出了要问的对**，
     *   **不等于**「真的问成了」——模型调用可能 429、也可能返回的 JSON 解析不了；
     * - 只有 `provider` 有值才说明**调用成功且有人答了**（`askLlmJson` 成功时无条件带出通道名）。
     *
     * 第一版把 `candidatePairs > 0` 当成「答了模型」，于是那条断言变成**环境相关**：
     * 钉的通道恰好被限流时，它照样红 —— 看起来像「钉通道失效」，其实什么都没坏。
     * `provider` 只在**成功**分支里带出（见 `judgeExplicitPairs`：非法 JSON / 调用失败
     * 两个早退分支都不带），所以「缺失」本身是**可用性**信号，不是接线信号。
     *
     * ⚠️ 第三版（就是现在这版）：**判据收进 `lib/judge-probe.ts`，别在这儿再写一遍**。同一个
     * 「算不算答了」在 `analyze-recall-floor.ts` 里曾被写成 `ran && !error`，把大组护栏的
     * 提示当成调用失败、导致 5 国只剩 1 国进对照。判据各写一份就是这个项目的复发型缺陷。
     */
    const answered = (a.json?.llmJudge ?? []).filter(isJudgeAnswered);
    /** 真的发起过模型调用的那些（零候选对的国家按设计不报 provider，要单独放行） */
    const called = answered.filter((c) => c.provider !== undefined);
    const wrong = called.filter((c) => c.provider !== ONLY);
    const detail = ran
      .map(
        (c) =>
          `${c.country}:${c.provider ?? '—'}` +
          `(选${c.candidatePairs ?? 0}/判${c.judgedPairs ?? 0}/否${c.declinedPairs ?? 0})` +
          `${c.error ? ` ⚠${String(c.error).slice(0, 40)}` : ''}`,
      )
      .join('  ');

    if (answered.length === 0) {
      // ★ 一个都没调通时，**不能**让「每国通道都是 zhipu」这条溜过去 ——
      //   空集合上它恒真，那又是一次「恒真的绿灯」。这里显式判为「无法验证」。
      inconclusive.push('A 钉通道');
      console.log(`⚠️ A 钉通道**本轮无法验证**：没有任何国家调通模型`);
      console.log(`   逐国：${detail}`);
      console.log(`   ⇒ 缺的不是接线，大概率是 provider= 钉的那个通道此刻被限流。换个时间重跑。`);
    } else {
      ok(
        '★ A 每国**实际**通道都是 zhipu（有别的通道就说明 only 没传进去）',
        wrong.length === 0,
        `逐国：${detail}`,
      );
      console.log(
        `   前提满足：${called.length} 国真的调通（「选出候选对」算不上调通）；` +
          `另有 ${answered.length - called.length} 国零候选对、没有可问的对`,
      );
    }
    ok(
      'A 候选对为 0 的国家**不报 provider**（规定行为，不是 bug —— 见 same-event.ts 的注释）',
      ran.filter((c) => (c.candidatePairs ?? 0) === 0).every((c) => c.provider === undefined),
    );
  }

  // ---- B：限制批大小 ----
  {
    const b = await req(`days=1&llm=1&limit=20&provider=${ONLY}&pv=3&cand=3`);
    const p = b.json?.llmJudgeParams;
    ok('B 请求成功', b.status === 200 && Array.isArray(b.json?.llmJudge), `status=${b.status}`);
    ok('B pairRecallUsed.maxPairs=3（实际生效）', p?.pairRecallUsed?.maxPairs === 3, JSON.stringify(p?.pairRecallUsed));
    ok(
      'B overridden 恰为 ["cand"]（声明 vs 实际）',
      JSON.stringify(p?.pairRecallUsed?.overridden) === '["cand"]',
      JSON.stringify(p?.pairRecallUsed?.overridden),
    );
    ok(
      '★ B 顶层 pairRecall 仍是默认 48（默认值与实际值**分开报**，不许被覆盖值污染）',
      b.json?.pairRecall?.maxPairs === 48,
      `pairRecall=${JSON.stringify(b.json?.pairRecall)}（若是 undefined，说明成功响应缺这个字段）`,
    );
    const ran = (b.json?.llmJudge ?? []).filter((c) => c.ran);
    const over = ran.filter((c) => (c.candidatePairs ?? 0) > 3);
    ok(
      '★ B 每国候选对 ≤ 3（旋钮真的抵达召回层，不只是回显了一个数字）',
      ran.length > 0 && over.length === 0,
      ran.map((c) => `${c.country}:${c.candidatePairs}`).join(' '),
    );
  }

  console.log('');
  if (fails === 0 && inconclusive.length === 0) {
    console.log('✅ 全部通过');
    process.exit(0);
  }
  if (fails === 0) {
    console.log(`⚠️ 没有失败，但有 ${inconclusive.length} 项**本轮无法验证**：${inconclusive.join('、')}`);
    console.log('   ⇒ 这不是「功能坏了」，是上游此刻不可用（多半是钉的通道被限流）。换时间重跑即可。');
    process.exit(2);
  }
  console.log(`❌ ${fails} 项失败${inconclusive.length ? `（另有 ${inconclusive.length} 项无法验证：${inconclusive.join('、')}）` : ''}`);
  process.exit(1);
}

main().catch((e) => {
  console.error('脚本抛错：', e);
  process.exit(1);
});

/**
 * ★ 这一行**不是装饰**：本仓库的 `tsconfig` 把 `scripts/` 也编进同一个 program，
 * 而没有 `import`/`export` 的文件是「脚本」不是「模块」，顶层声明会进全局命名空间
 * ⇒ 和其它脚本重名就会让**云端构建失败**（2026-10-07 实测踩过）。
 * 结构性防线见 `scripts/test-script-hygiene.ts`。
 */
export {};
