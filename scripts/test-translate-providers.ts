/**
 * 翻译通道请求体的回归用例（不需要真实 API Key，全程 mock fetch）。
 *
 * 锁住 2026-09-19 那次「智谱 Key 配了、型号也是对的免费档，钱却全花在 DeepSeek 上」
 * 的根因，以及修复它的两个约定：
 *
 *   1. **智谱 GLM-4.7 系列默认 `thinking.type = "enabled"`**，翻译必须显式关掉
 *      （`thinking: { type: 'disabled' }`）。开着 thinking 会让单篇耗时冲到几十秒、
 *      撞上 60s 超时，然后静默降级到付费通道。
 *   2. **不可重试的失败不要重试**。旧版对 401（Key 错）也会硬重试 3 次，
 *      只是把同一份错误报 3 遍、拖慢整批，最后照样降级到付费通道。
 *   3. （2026-09-24 补）**`askLlmJson` 的 `only=` 必须真的把链收窄成一条**。
 *      它是判组 A/B 的「钉住通道」，靠它把「换了型号」这个变量从对照里去掉。
 *
 * ⚠️ 本文件在 2026-09-24 之前**既没有 npm 脚本、也不在 `verify:local` 里** ——
 * 也就是说上面这三类约定一直只有代码注释在守，没有闸门。已补上 `test:translate-providers`。
 *
 * 跑法：pnpm test:translate-providers
 */
import {
  probeTranslationProviders,
  translateNews,
  askLlmJson,
  resolveProviderChain,
  availableProviderNames,
  classifyProviderError,
  looksLikeContentFilter,
  resetTranslationStats,
  getTranslationStats,
  PROVIDERS,
} from '../src/lib/translate';

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
  }
}

/** 一次模型请求的记录 */
interface Call {
  url: string;
  body: Record<string, unknown>;
}
let calls: Call[] = [];

/** 安装 mock fetch；routes 的 key 是 URL 子串，value 返回 Response */
function installMock(routes: Array<[string, (n: number) => Response]>) {
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, body });

    for (const [key, make] of routes) {
      if (url.includes(key)) {
        const n = calls.filter((c) => c.url.includes(key)).length;
        return make(n);
      }
    }
    return new Response('unmatched route', { status: 500 });
  }) as unknown as typeof fetch;
}

/** 造一个合法的 OpenAI 兼容成功响应，content 是本项目的 LLM JSON 约定 */
function okResponse() {
  const payload = JSON.stringify({
    title: '哈萨克斯坦央行上调基准利率至百分之十六',
    summary: '哈萨克斯坦国家银行宣布将基准利率上调，以抑制通货膨胀并稳定坚戈汇率。',
    content:
      '哈萨克斯坦国家银行今日宣布，将基准利率上调至百分之十六。该行表示，此举旨在抑制持续高企的通货膨胀，并稳定本币坚戈的汇率。这是本年度第三次加息。',
    category: 'economy',
    investorRelevant: true,
  });
  return new Response(JSON.stringify({ choices: [{ message: { content: payload } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, message: string) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 造一个「**HTTP 200 但被内容审核拦下**」的响应。
 *
 * 这是 2026-10-04 用户报的那类故障的真实形态：**状态码是 200**（所以
 * `!response.ok` 那条分支根本进不去）、`content` 为空、`finish_reason` 说明原因。
 * 旧代码把它归到「返回内容为空 ⇒ 可重试」，于是同一段文字被原样重试 3 次、
 * 每次都必然被同一个审核器拒掉，最后只留下「返回内容为空」——真实原因丢失。
 */
function contentFilterResponse() {
  return new Response(
    JSON.stringify({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

const ZHIPU = 'open.bigmodel.cn';
const DEEPSEEK = 'api.deepseek.com';

/**
 * 智谱两条通道的型号。**断言一律按型号数，不按域名数。**
 *
 * 为什么（2026-09-24 实测的教训）：`zhipu` 与 `zhipu-flash` **共用 `open.bigmodel.cn`，
 * 只是 model 不同**。原先四条断言都写成
 * `calls.filter(c => c.url.includes(ZHIPU)).length`，在只剩一条智谱通道时是对的；
 * 2026-09-20 加了 `zhipu-flash` 之后，这个计数就把两条通道混成一条，
 * 期望 1 的用例实测 2、期望 3 的实测 6 —— **而本文件当时既没有 npm 脚本、
 * 也不在 `verify:local` 里，所以四条断言坏了整整四天没人知道**。
 * 计数口径改成型号后，再加同域名的通道也不会误伤。
 */
const MODEL_ZHIPU = 'glm-4.7-flash';
const MODEL_ZHIPU_FALLBACK = 'glm-4-flash-250414';
const MODEL_DEEPSEEK = 'deepseek-flash';

/** 按**型号**数本文件记录到的请求次数 */
function countByModel(model: string): number {
  return calls.filter((c) => c.body.model === model).length;
}

// 两个通道都当作「已配置」
process.env.ZHIPU_API_KEY = 'test-zhipu-key';
process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
delete process.env.ZHIPU_MODEL;
delete process.env.DEEPSEEK_MODEL;

async function main() {
  console.log('翻译通道请求体 / 重试策略用例\n');

  // ── 用例 1、2：请求体参数不能串台 ──────────────────────────────
  calls = [];
  installMock([
    [ZHIPU, () => okResponse()],
    [DEEPSEEK, () => okResponse()],
  ]);
  await probeTranslationProviders();

  const zhipuCall = calls.find((c) => c.url.includes(ZHIPU));
  const deepseekCall = calls.find((c) => c.url.includes(DEEPSEEK));

  // 意图是「每条已配置通道都被问到」，不是「HTTP 请求恰好 N 次」——
  // 后者随「加一条通道」「给带 extraBody 的通道加一次 thinking 对照调用」而失效。
  const askedModels = new Set(calls.map((c) => String(c.body.model)));
  const expectedModels = PROVIDERS.map((p) => process.env[p.modelEnv] || p.defaultModel);
  check(
    '每条已配置通道都被问到（按型号判，两条智谱同域名不混）',
    expectedModels.filter((m) => askedModels.has(m)),
    expectedModels,
  );
  check(
    '带 thinking 开关的通道额外打了一次对照（同型号 2 次）',
    countByModel(MODEL_ZHIPU),
    2,
  );
  check(
    '智谱请求体显式关闭 thinking（否则单篇超时→降级付费）',
    (zhipuCall?.body.thinking as { type?: string } | undefined)?.type,
    'disabled',
  );
  check('智谱仍然带上 model', zhipuCall?.body.model, MODEL_ZHIPU);
  check('DeepSeek 请求体不带 thinking（避免参数串台被 400）', deepseekCall?.body.thinking, undefined);
  check('DeepSeek 仍然带上 model', deepseekCall?.body.model, MODEL_DEEPSEEK);

  // ── 用例 3：ZHIPU_MODEL 覆盖生效 ──────────────────────────────
  process.env.ZHIPU_MODEL = 'glm-4.5-flash';
  calls = [];
  installMock([
    [ZHIPU, () => okResponse()],
    [DEEPSEEK, () => okResponse()],
  ]);
  await probeTranslationProviders();
  check('ZHIPU_MODEL 覆盖生效', countByModel('glm-4.5-flash') > 0, true);
  // 覆盖只该打到 `zhipu`（它的 modelEnv 是 ZHIPU_MODEL）。
  // 如果写成了全局，`zhipu-flash` 也会跟着变 —— 那会让「智谱的第二个免费型号」
  // 这个降级位形同虚设，而且界面上完全看不出来。
  check('覆盖不串台到 zhipu-flash', countByModel(MODEL_ZHIPU_FALLBACK), 1);
  delete process.env.ZHIPU_MODEL;

  // ── 用例 4：401（Key 无效）不重试，直接降级 ────────────────────
  calls = [];
  installMock([
    [ZHIPU, () => errorResponse(401, 'invalid api key')],
    [DEEPSEEK, () => okResponse()],
  ]);
  // 国名是必传参数（2026-10-01 起）：这里只测降级链，国名随便给一个俄罗斯即可。
  const r401 = await translateNews('Тест', 'Содержание новости', 'ru', '俄罗斯');

  check('401 每个智谱型号只打 1 次（旧版会打 3 次）', [countByModel(MODEL_ZHIPU), countByModel(MODEL_ZHIPU_FALLBACK)], [1, 1]);
  check('401 后降级到 deepseek', r401.provider, 'deepseek');
  check('降级后翻译成功', r401.translated, true);

  // ── 用例 5：429（限流）值得重试，打满 3 次 ─────────────────────
  calls = [];
  installMock([
    [ZHIPU, () => errorResponse(429, 'rate limit exceeded')],
    [DEEPSEEK, () => okResponse()],
  ]);
  await translateNews('Тест', 'Содержание новости', 'ru', '俄罗斯');
  check('429 每个智谱型号各重试满 3 次', [countByModel(MODEL_ZHIPU), countByModel(MODEL_ZHIPU_FALLBACK)], [3, 3]);

  // ── 用例 6：404（型号不存在）不重试 ───────────────────────────
  calls = [];
  installMock([
    [ZHIPU, () => errorResponse(404, 'model not found')],
    [DEEPSEEK, () => okResponse()],
  ]);
  await translateNews('Тест', 'Содержание новости', 'ru', '俄罗斯');
  check('404（型号代号过期）每个智谱型号只打 1 次', [countByModel(MODEL_ZHIPU), countByModel(MODEL_ZHIPU_FALLBACK)], [1, 1]);

  // ── 用例 7：两个通道都不可用时如实返回 translated=false ─────────
  calls = [];
  installMock([
    [ZHIPU, () => errorResponse(401, 'invalid api key')],
    [DEEPSEEK, () => errorResponse(402, 'Insufficient Balance')],
  ]);
  const rAllFail = await translateNews('Тест', 'Содержание новости', 'ru', '俄罗斯');
  check('全通道失败时 translated=false（不入库）', rAllFail.translated, false);
  check('全通道失败时 provider=none', rAllFail.provider, 'none');

  // ── 用例 8：体检接口把原始报错原样带出来 ───────────────────────
  calls = [];
  installMock([
    [ZHIPU, () => errorResponse(401, 'invalid api key')],
    [DEEPSEEK, () => okResponse()],
  ]);
  const probes = await probeTranslationProviders();
  const zp = probes.find((p) => p.provider === 'zhipu');
  const dp = probes.find((p) => p.provider === 'deepseek');
  check('体检：智谱 ok=false', zp?.ok, false);
  check('体检：报错里带 HTTP 401', zp?.detail.includes('401'), true);
  check('体检：DeepSeek ok=true', dp?.ok, true);

  // ── 用例 9：only= 真的跳过前面能成功的通道 ──────────────────────
  //
  // 这是判组 A/B 的「钉住通道」。**必须让前一条通道返回成功**，用例才有意义 ——
  // 如果让 zhipu 报错，那它本来就会被跳过，测不出「钉住」到底有没有生效。
  calls = [];
  installMock([
    [ZHIPU, () => okResponse()],
    [DEEPSEEK, () => okResponse()],
  ]);
  const pinned = await askLlmJson('测试提示词', { only: 'deepseek' });
  check('only=deepseek：答话的是 deepseek', pinned.ok ? pinned.provider : '（失败）', 'deepseek');
  check('only=deepseek：完全没碰 zhipu（钉住生效）', calls.filter((c) => c.url.includes(ZHIPU)).length, 0);

  // ── 用例 10：未知通道名**报错而不是回退全链** ───────────────────
  //
  // 回退全链会产出一个「看起来正常」的结果，但它恰恰不是被钉住的那一档 ——
  // 又一次「分不清跑的是哪个配置」。同 `pv=` / `promptBuilderFor` 的规矩。
  calls = [];
  installMock([
    [ZHIPU, () => okResponse()],
    [DEEPSEEK, () => okResponse()],
  ]);
  const bogus = await askLlmJson('测试提示词', { only: 'zhipu-flash2' });
  check('未知通道：ok=false', bogus.ok, false);
  check('未知通道：错误里列出可用通道', !bogus.ok && bogus.error.includes('zhipu'), true);
  check('未知通道：一个请求都没发（没有静默回退全链）', calls.length, 0);

  // ── 用例 11：不传 only 时行为不变（生产链路走全链） ──────────────
  const full = resolveProviderChain(undefined);
  check('不传 only：放行全部通道', full.ok && full.providers.length, availableProviderNames().length);
  const one = resolveProviderChain('zhipu');
  check('only=zhipu：只放行 1 条', one.ok && one.providers.map((p) => p.name), ['zhipu']);

  // ── 用例 12：错误分类表（纯函数；分类直接决定「重试还是换通道」）───────
  //
  // 2026-10-05 新增。用户 2026-10-04 报的两条错（「glm-4.7-flash 超时」、
  // 「glm-4-flash-250414 HTTP 400 contentFilter」）之所以成为悬案，是因为
  // 旧代码只会把它们都压成一句自由文本，**分不出该重试还是该换通道**。
  {
    const cases: Array<[string, Parameters<typeof classifyProviderError>[0], { kind: string; retryable: boolean }]> = [
      ['429 限流（智谱 code 1305 也走这条）', { status: 429, body: '{"error":{"code":"1305"}}' }, { kind: 'rate-limit', retryable: true }],
      ['401 Key 无效', { status: 401, body: 'invalid api key' }, { kind: 'auth', retryable: false }],
      ['403 同样算认证', { status: 403, body: 'forbidden' }, { kind: 'auth', retryable: false }],
      ['404 型号不存在', { status: 404, body: 'model not found' }, { kind: 'model-missing', retryable: false }],
      ['500 服务端抖动（可重试）', { status: 500, body: 'internal error' }, { kind: 'server', retryable: true }],
      ['400 且报文提到 contentFilter ⇒ 内容审核（**不可重试**）', { status: 400, body: '{"error":"contentFilter"}' }, { kind: 'content-filter', retryable: false }],
      ['400 且报文提到「敏感」⇒ 内容审核', { status: 400, body: '请求内容包含敏感信息' }, { kind: 'content-filter', retryable: false }],
      ['普通 400（参数非法）', { status: 400, body: 'bad request' }, { kind: 'bad-request', retryable: false }],
      ['异常：超时 ⇒ timeout（**不重试**，说明通道当前不可用）', { thrown: 'The operation was aborted due to timeout' }, { kind: 'timeout', retryable: false }],
      ['异常：DNS/连接失败 ⇒ network', { thrown: 'fetch failed' }, { kind: 'network', retryable: false }],
    ];
    for (const [why, input, want] of cases) {
      const got = classifyProviderError(input);
      check(`分类：${why}`, { kind: got.kind, retryable: got.retryable }, want);
    }
    // 顺序护栏：**先看状态码、最后才猜内容**。反过来的话，429 响应里偶然出现
    // 「敏感」二字就会被误判成内容审核，从而「不可重试」——把限流当成永久故障。
    check(
      '顺序：429 里哪怕出现「敏感」也仍判限流（先状态码、后猜内容）',
      classifyProviderError({ status: 429, body: '该模型当前访问量过大，请稍后再试（敏感词无关）' }).kind,
      'rate-limit',
    );
    check('内容审核识别：finish_reason 形态', looksLikeContentFilter('{"finish_reason":"content_filter"}'), true);
    check('内容审核识别：风控 code 形态', looksLikeContentFilter('{"code":"1301"}'), true);
    check('内容审核识别：正常文本不误报', looksLikeContentFilter('{"same":[0,2]}'), false);
  }

  // ── 用例 13：200 + content_filter 不许重试，且原因必须留痕 ──────────
  //
  // 这是用户报的那条错的**端到端**回归：mock 两个通道都返回
  // 「200 + finish_reason=content_filter」，断言：
  //   ① 每个型号只被调 1 次（旧行为是 3 次：白等 2.4 秒且永远不可能成功）；
  //   ② `translationStats.errors` 里留下的是 **content-filter**，不是含糊的「返回内容为空」。
  {
    resetTranslationStats();
    calls = [];
    installMock([
      [ZHIPU, () => contentFilterResponse()],
      [DEEPSEEK, () => contentFilterResponse()],
    ]);
    const r = await translateNews('Тест', 'Содержание новости', 'ru', '俄罗斯');
    check('content_filter：不入库（translated=false）', r.translated, false);
    check('content_filter：智谱型号只打 1 次（不做无意义重试）', countByModel(MODEL_ZHIPU), 1);
    check('content_filter：免费档型号也只打 1 次', countByModel(MODEL_ZHIPU_FALLBACK), 1);
    check('content_filter：付费兜底也只打 1 次', countByModel(MODEL_DEEPSEEK), 1);
    const errs = getTranslationStats().errors;
    // 降级链有 **3** 条通道（zhipu / zhipu-flash / deepseek）——
    // 注意 zhipu 与 zhipu-flash 共用域名但**是两条通道**（见上面 `countByModel` 的教训），
    // 所以这里期望 3 而不是 2。
    check('content_filter：留痕 3 条（每通道按 provider+kind 聚合）', errs.length, 3);
    check('content_filter：分类是 content-filter（不是空的 error 文本）', errs.map((e) => e.kind), ['content-filter', 'content-filter', 'content-filter']);
    check('content_filter：次数记成 1', errs.map((e) => e.count), [1, 1, 1]);
    check('content_filter：报错文案写明了原因', /内容审核/.test(errs[0]?.label ?? ''), true);
  }

  // ── 用例 14：同类错误**累加计数**（旧版每通道只留第一条，看不出常发还是偶发）──
  {
    resetTranslationStats();
    calls = [];
    // 第 1 篇：两个通道都 429；第 2 篇：同样
    installMock([
      [ZHIPU, () => errorResponse(429, 'rate limited')],
      [DEEPSEEK, () => errorResponse(429, 'rate limited')],
    ]);
    await translateNews('Тест', 'Содержание новости', 'ru', '俄罗斯');
    await translateNews('Тест2', 'Содержание новости', 'ru', '俄罗斯');
    const errs = getTranslationStats().errors;
    check('计数：三条通道各留 1 条（不是每篇一条）', errs.length, 3);
    check('计数：次数累加到 >1（可区分常发与偶发）', errs.every((e) => (e.count ?? 0) > 1), true);
    check('计数：分类是 rate-limit', errs.map((e) => e.kind), ['rate-limit', 'rate-limit', 'rate-limit']);
  }

  console.log(`\n──────── 结果 ────────\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    process.exitCode = 1;
    console.log('\n✗ 有用例未通过。');
  } else {
    console.log('\n✓ 全部通过。');
  }
}

main();
