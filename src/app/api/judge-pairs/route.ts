/**
 * 判组判据的**固定语料对照**入口（只读，不碰数据库）。
 *
 * ## 为什么需要它
 *
 * 判定链路的改动只有一种验收方式：看**逐对**判定。而 `GET /api/dedupe-check`
 * 给出的逐对判定依赖**当天库里的候选对** —— 窗口随日期滑动、新闻每天更新，
 * 同一份提示词在不同日子喂到模型的是不同的对。于是「这次结论和上次不一样」
 * 永远有两种解释：**提示词改了**，或者**今天新闻换了**。分不清这两者，A/B 就是白跑。
 *
 * 这个入口把「配对集合」也变成入参：同一批**写死的**标题对，配 `pv=1|3`
 * 切换判据版本，**唯一的变量就只剩提示词**。
 *
 * ⚠️ 但「只剩提示词」这件事**还得再钉一个参数才成立**：`provider`。降级链按
 * `PROVIDERS` 顺序取第一个不报错的通道，谁不报错取决于这一刻谁被 429 限流 ——
 * 实测同一次 A/B 两臂就落到了不同通道（pv=1→zhipu、pv=3→zhipu-flash）。
 * 不钉通道，比出来的差异分不清是提示词还是型号。**跑 A/B 一律带上 `provider`**。
 *
 * ## 用法
 *
 *   curl -s -X POST "$BASE/api/judge-pairs" -H 'content-type: application/json' -d '{
 *     "pv": 1,
 *     "provider": "zhipu-flash",
 *     "pairs": [
 *       {"a": "「Unibank 推出…」原文", "b": "另一条标题", "expect": "same"},
 *       {"a": "标题甲", "b": "标题乙", "expect": "diff"}
 *     ]
 *   }'
 *
 * `expect`（`same` / `diff`）是**人工标注的期望**，只是为了让返回里带一个
 * 「对/错」的分组统计，方便一眼看出哪几对判反了 —— 它**不参与任何判定**，
 * 也不会被传给模型（模型只看标题，看不到标注）。
 *
 * 只读且无副作用：不读库、不写库、不需要数据库配置，只调用一次模型。
 * 与 `POST /api/dedupe-check`（那个 `apply:true` 会**真删数据**）刻意分开，
 * 免得「验证提示词」这种日常操作挨着一条能删库的入口。
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  judgeExplicitPairs,
  JUDGE_PROMPT_VERSION,
  availablePromptVersions,
} from '@/lib/same-event';
import { availableProviderNames } from '@/lib/translate';

export const dynamic = 'force-dynamic';

/**
 * 单次最多问多少对。
 *
 * 上限的理由不是成本而是**判断力**：一次塞太多对，模型会在长列表上糊弄
 * （`group` 形态那次 18 条并成一组就是例子）。体检链路每次也只问十几对。
 */
const MAX_PAIRS = 40;

type RawPair = { a?: unknown; b?: unknown; expect?: unknown; note?: unknown };

export async function POST(req: NextRequest) {
  let body: { pairs?: RawPair[]; pv?: unknown; judge?: unknown; debug?: unknown; provider?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const rawPairs = Array.isArray(body.pairs) ? body.pairs : null;
  if (!rawPairs || rawPairs.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: '需要 pairs 字段，形如 [{"a":"标题A","b":"标题B","expect":"same|diff"}]',
      },
      { status: 400 },
    );
  }
  if (rawPairs.length > MAX_PAIRS) {
    return NextResponse.json(
      { ok: false, error: `pairs 最多 ${MAX_PAIRS} 对（收到 ${rawPairs.length}），拆成多次调用` },
      { status: 400 },
    );
  }
  for (const [i, p] of rawPairs.entries()) {
    if (typeof p?.a !== 'string' || typeof p?.b !== 'string' || !p.a.trim() || !p.b.trim()) {
      return NextResponse.json(
        { ok: false, error: `第 ${i} 对缺少非空的 a / b 字符串` },
        { status: 400 },
      );
    }
    if (p.expect !== undefined && p.expect !== 'same' && p.expect !== 'diff') {
      return NextResponse.json(
        { ok: false, error: `第 ${i} 对的 expect 只能是 "same" 或 "diff"` },
        { status: 400 },
      );
    }
  }

  // 版本校验与 `dedupe-check` 的 `pv=` 同一条规矩：非法值当场 400，不静默回退。
  // 静默回退会让 `pv=9` 跑出一个看起来正常的「当前版本」结果，
  // 而那正是这个参数存在的意义所在 —— 消灭「分不清跑的是哪版」。
  let promptVersion: number | undefined;
  if (body.pv !== undefined && body.pv !== null) {
    promptVersion = Number(body.pv);
    const usable = availablePromptVersions();
    if (!Number.isInteger(promptVersion) || !usable.includes(promptVersion)) {
      return NextResponse.json(
        {
          ok: false,
          error: `未知的判组提示词版本 pv=${String(body.pv)}；可用：${usable.join(', ')}`,
          judgePromptVersions: usable,
        },
        { status: 400 },
      );
    }
  }

  // 钉住通道。和 `pv=` 同一条规矩：非法值当场 400，不静默回退。
  //
  // 为什么这个参数是**必需**而不是锦上添花：降级链按 `PROVIDERS` 顺序取第一个
  // 不报错的通道，而「谁不报错」取决于这一刻谁被 429 限流。实测同一次 A/B 的两臂
  // 就落到了不同通道（pv=1→zhipu、pv=3→zhipu-flash）—— 那样「结论不同」多出一种
  // 解释：换了通道。钉住它，A/B 才真的只剩提示词一个变量。
  let only: string | undefined;
  if (body.provider !== undefined && body.provider !== null) {
    const usable = availableProviderNames();
    if (typeof body.provider !== 'string' || !usable.includes(body.provider)) {
      return NextResponse.json(
        {
          ok: false,
          error: `未知的模型通道 provider=${String(body.provider)}；可用：${usable.join(', ')}`,
          availableProviders: usable,
        },
        { status: 400 },
      );
    }
    only = body.provider;
  }

  const judgeMode = body.judge === 'think' ? 'think' : body.judge === 'nothink' ? 'nothink' : undefined;
  const extraBody =
    judgeMode === undefined ? undefined : ({ thinking: { type: judgeMode === 'think' ? 'enabled' : 'disabled' } } as Record<string, unknown>);

  // 把「每一对」摊平成一个条目数组：pair i 占 2i / 2i+1。
  // 这样能直接复用 `judgeExplicitPairs` —— 它与生产链路是**同一份实现**，
  // 所以这里测出来的判定行为就是生产的行为（差异只在「问哪些对」）。
  const items = rawPairs.flatMap((p) => [{ title: String(p.a) }, { title: String(p.b) }]);
  const pairs = rawPairs.map((_, i) => ({ a: i * 2, b: i * 2 + 1 }));

  const res = await judgeExplicitPairs(pairs, items, {
    mode: 'pair',
    ...(promptVersion !== undefined ? { promptVersion } : {}),
    ...(only !== undefined ? { only } : {}),
    ...(extraBody ? { extraBody } : {}),
    ...(body.debug === true ? { collectRaw: true } : {}),
  });

  // 判「是」/判「否」/被极性拦下 —— 三条列表都以 `a` 为键，合成一张 sim 表。
  // 被极性拦下的对不在 pairs/declined 里，所以必须单独收，否则它会报成「无相似度」。
  const simOf = new Map<number, number>();
  for (const p of [...res.pairs, ...res.declined, ...res.vetoed]) simOf.set(p.a, p.sim);
  const vetoedA = new Set(res.vetoed.map((p) => p.a));
  const sameA = new Set(res.pairs.map((p) => p.a));

  const results = rawPairs.map((p, i) => {
    const a = i * 2;
    const verdict: 'same' | 'diff' | 'vetoed' | 'error' = res.error
      ? // ⚠️ 调用失败时**不能**每对都报 'diff'：那与「模型真的全判否」在响应里
        // 完全一样，而这正是本项目反复栽过的形态（失败与空结果长得一样）。
        // 单列一档，前端/脚本一眼就能分辨，也不会被算进「判错」。
        'error'
      : vetoedA.has(a)
        ? // 「被极性拦下」不是模型判的「否」—— 模型没看到这对，报成 diff 会让人
          // 以为模型判断力有问题。单列一档，与 `vetoed` 的语义对齐。
          'vetoed'
        : sameA.has(a)
          ? 'same'
          : 'diff';
    const expect = p.expect === 'same' || p.expect === 'diff' ? p.expect : undefined;
    return {
      i,
      a: String(p.a),
      b: String(p.b),
      ...(expect ? { expect } : {}),
      ...(typeof p.note === 'string' && p.note ? { note: p.note } : {}),
      verdict,
      // 被极性拦下 / 调用失败的对没有「对/错」可言（不是模型答的），标成未知而不是错。
      ...(expect && verdict !== 'vetoed' && verdict !== 'error' ? { correct: verdict === expect } : {}),
      sim: simOf.get(a) ?? null,
    };
  });

  const labeled = results.filter((r) => r.expect !== undefined && r.verdict !== 'vetoed' && r.verdict !== 'error');
  const wrong = labeled.filter((r) => !r.correct);

  return NextResponse.json({
    ok: !res.error,
    ...(res.error ? { error: res.error } : {}),
    /** 部署指纹：当前版本，永远返回（与 `dedupe-check` 顶层同义） */
    judgePromptVersion: JUDGE_PROMPT_VERSION,
    /** 这一次**实际用的**版本 —— A/B 记录必须引用它 */
    judgePromptVersionUsed: promptVersion ?? JUDGE_PROMPT_VERSION,
    judgePromptVersions: availablePromptVersions(),
    ...(judgeMode ? { judgeMode } : {}),
    /**
     * 钉住的通道（没传就是 `undefined`）。**必须同时报出 requested 和实际 answering 的
     * 通道**：只报实际的那个，读的人分不清「它是被钉住才走这条」还是「它只是恰好没被限流」，
     * 而这两者对应的结论可信度完全不同。
     */
    ...(only ? { providerRequested: only } : {}),
    ...(res.provider ? { provider: res.provider } : {}),
    /** 可用通道清单（给脚本/人校验入参，避免本地硬编码通道名） */
    availableProviders: availableProviderNames(),
    candidateCount: res.candidateCount,
    judgedSameCount: res.pairs.length,
    /** ⚠️ 是**数量**，不是列表 —— 与 `dedupe-check` 的同名字段（列表）不同，别混读 */
    declinedCount: res.declined.length,
    /** 被极性判据拦下、**没问模型**的对（模型答什么都无效） */
    vetoed: res.vetoed.map((v) => ({ sim: v.sim, a: items[v.a]?.title ?? '', b: items[v.b]?.title ?? '' })),
    results,
    ...(labeled.length
      ? {
          accuracy: {
            labeled: labeled.length,
            correct: labeled.length - wrong.length,
            wrong: wrong.map((r) => ({
              i: r.i,
              expect: r.expect,
              verdict: r.verdict,
              sim: r.sim,
              a: r.a,
              b: r.b,
            })),
          },
        }
      : {}),
    ...(body.debug === true && res.raw ? { raw: res.raw.map((t) => t.slice(0, 1500)) } : {}),
  });
}
