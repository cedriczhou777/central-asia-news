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
 * ⚠️ 判据设计上的一条纪律（本轮也踩到）：**断言的前提必须可达**。
 * A 组第一版要求「每国 `provider` 都是 zhipu」，但**候选对为 0 的国家根本不会调模型**、
 * 因此按设计就不报 `provider`（见 `same-event.ts` 里 `DedupResult.llm.provider` 的注释）
 * ⇒ 那条断言**恒假**，看起来像功能坏了。现在改成：
 * 只对**真的问过模型**的国家断言通道，并**单独断言**「候选对为 0 的国家不报 provider」
 * 这个规定行为本身。
 */
const BASE = process.env.BASE || 'https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com';

type CountryProbe = {
  country: string;
  ran?: boolean;
  candidatePairs?: number;
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
    const a = await req('days=1&llm=1&limit=20&provider=zhipu&pv=3');
    const p = a.json?.llmJudgeParams;
    ok('A 请求成功且返回逐国判定', a.status === 200 && Array.isArray(a.json?.llmJudge), `status=${a.status}`);
    ok('A providerRequested=zhipu（声明）', p?.providerRequested === 'zhipu', JSON.stringify(p?.providerRequested));
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
    // ⚠️ 只对**真的问过模型**的国家断言通道：候选对为 0 的国家按设计不调模型、
    //    因而不报 `provider`。第一版没区分，于是断言恒假（看着像功能坏了）。
    const answered = ran.filter((c) => (c.candidatePairs ?? 0) > 0);
    const wrong = answered.filter((c) => c.provider !== 'zhipu');
    ok(
      'A 前提：本轮确实有国家真的问了模型（否则下一条恒真）',
      answered.length > 0,
      `答过模型的=${answered.map((c) => c.country).join(',') || '(一个都没有)'}；候选对为 0 的=${ran
        .filter((c) => (c.candidatePairs ?? 0) === 0)
        .map((c) => c.country)
        .join(',') || '无'}`,
    );
    ok(
      '★ A 每国**实际**通道都是 zhipu（钉住生效；有别的通道就说明 only 没传进去）',
      answered.length > 0 && wrong.length === 0,
      `答过模型的国家=${answered.map((c) => `${c.country}:${c.provider ?? '?'}`).join(' ')}`,
    );
    ok(
      'A 候选对为 0 的国家**不报 provider**（规定行为，不是 bug —— 见 same-event.ts 的注释）',
      ran.filter((c) => (c.candidatePairs ?? 0) === 0).every((c) => c.provider === undefined),
      JSON.stringify(ran.map((c) => `${c.country}:${c.provider ?? '—'}`)),
    );
  }

  // ---- B：限制批大小 ----
  {
    const b = await req('days=1&llm=1&limit=20&provider=zhipu&pv=3&cand=3');
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

  console.log(`\n${fails === 0 ? '✅ 全部通过' : `❌ ${fails} 项失败`}`);
  process.exit(fails === 0 ? 0 : 1);
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
