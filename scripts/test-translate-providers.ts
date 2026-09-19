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
 *
 * 跑法：./node_modules/.bin/tsx scripts/test-translate-providers.ts
 */
import { probeTranslationProviders, translateNews } from '../src/lib/translate';

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

const ZHIPU = 'open.bigmodel.cn';
const DEEPSEEK = 'api.deepseek.com';

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

  check('两个通道都发起了请求', calls.length, 2);
  check(
    '智谱请求体显式关闭 thinking（否则单篇超时→降级付费）',
    (zhipuCall?.body.thinking as { type?: string } | undefined)?.type,
    'disabled',
  );
  check('智谱仍然带上 model', zhipuCall?.body.model, 'glm-4.7-flash');
  check('DeepSeek 请求体不带 thinking（避免参数串台被 400）', deepseekCall?.body.thinking, undefined);
  check('DeepSeek 仍然带上 model', deepseekCall?.body.model, 'deepseek-flash');

  // ── 用例 3：ZHIPU_MODEL 覆盖生效 ──────────────────────────────
  process.env.ZHIPU_MODEL = 'glm-4.5-flash';
  calls = [];
  installMock([
    [ZHIPU, () => okResponse()],
    [DEEPSEEK, () => okResponse()],
  ]);
  await probeTranslationProviders();
  check('ZHIPU_MODEL 覆盖生效', calls.find((c) => c.url.includes(ZHIPU))?.body.model, 'glm-4.5-flash');
  delete process.env.ZHIPU_MODEL;

  // ── 用例 4：401（Key 无效）不重试，直接降级 ────────────────────
  calls = [];
  installMock([
    [ZHIPU, () => errorResponse(401, 'invalid api key')],
    [DEEPSEEK, () => okResponse()],
  ]);
  const r401 = await translateNews('Тест', 'Содержание новости', 'ru');
  const zhipu401Calls = calls.filter((c) => c.url.includes(ZHIPU)).length;

  check('401 只打 1 次（旧版会打 3 次）', zhipu401Calls, 1);
  check('401 后降级到 deepseek', r401.provider, 'deepseek');
  check('降级后翻译成功', r401.translated, true);

  // ── 用例 5：429（限流）值得重试，打满 3 次 ─────────────────────
  calls = [];
  installMock([
    [ZHIPU, () => errorResponse(429, 'rate limit exceeded')],
    [DEEPSEEK, () => okResponse()],
  ]);
  await translateNews('Тест', 'Содержание новости', 'ru');
  check('429 重试满 3 次', calls.filter((c) => c.url.includes(ZHIPU)).length, 3);

  // ── 用例 6：404（型号不存在）不重试 ───────────────────────────
  calls = [];
  installMock([
    [ZHIPU, () => errorResponse(404, 'model not found')],
    [DEEPSEEK, () => okResponse()],
  ]);
  await translateNews('Тест', 'Содержание новости', 'ru');
  check('404（型号代号过期）只打 1 次', calls.filter((c) => c.url.includes(ZHIPU)).length, 1);

  // ── 用例 7：两个通道都不可用时如实返回 translated=false ─────────
  calls = [];
  installMock([
    [ZHIPU, () => errorResponse(401, 'invalid api key')],
    [DEEPSEEK, () => errorResponse(402, 'Insufficient Balance')],
  ]);
  const rAllFail = await translateNews('Тест', 'Содержание новости', 'ru');
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

  console.log(`\n──────── 结果 ────────\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    process.exitCode = 1;
    console.log('\n✗ 有用例未通过。');
  } else {
    console.log('\n✓ 全部通过。');
  }
}

main();
