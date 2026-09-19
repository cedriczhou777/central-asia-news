import { NextResponse } from 'next/server';
import { probeTranslationProviders } from '@/lib/translate';

export const dynamic = 'force-dynamic';

/**
 * GET /api/translate-check —— 翻译通道体检。
 *
 * 对每个配置了 Key 的翻译通道真实打一次极小的请求，返回：
 *   - 用的是哪个型号（含环境变量覆盖后的实际值）
 *   - 通 / 不通
 *   - 不通的**原始报错**（HTTP 状态码 + 响应体片段）
 *   - 单次耗时（`latencyMs`）—— 判断「thinking 有没有真关掉」的关键指标
 *
 * 为什么需要它：翻译通道失败时线上只有两个症状 —— 「文章不入库」或「钱全花在
 * 付费通道上」，两个都**不报错到界面**。原来定位一次要跑完一整轮抓取（40–60 分钟），
 * 才在 `GET /api/fetch-news` 的 `lastRun.summary.translation` 里看到一行报错。
 *
 * 用法：
 *   curl -s "$URL/api/translate-check" | python3 -m json.tool
 *
 * 怎么读结果：
 *   - `zhipu.ok=false` + `HTTP 401` → Key 无效或复制时截断了
 *   - `zhipu.ok=false` + `404` / `model not found` → 型号代号过期，用 `ZHIPU_MODEL` 覆盖
 *   - `zhipu.ok=false` + `429` → 免费档限流（确认没有并发在跑）
 *   - `zhipu.ok=false` + `调用异常: The operation was aborted` → 单次超过 60s，
 *     多半是 thinking 没关（本项目已在 PROVIDERS 里显式传 `thinking: disabled`）
 *   - `latencyMs` 只有几秒 = 正常；几十秒 = thinking 还开着
 *
 * 它不写库、不改全局统计，所以**抓取正在跑的时候也可以调**。
 */
export async function GET() {
  const startedAt = Date.now();
  const providers = await probeTranslationProviders();
  const okCount = providers.filter((p) => p.ok).length;

  const usable = providers.filter((p) => p.ok).map((p) => p.provider);
  // 把结论直接写成一句话，省得每次都要自己对照上面那张表
  const verdict =
    okCount === 0
      ? '没有任何可用的翻译通道 —— 抓到的文章会在入库前被全部丢弃。先修 Key / 型号。'
      : usable[0] === 'zhipu'
        ? '智谱（免费档）可用，翻译不会花钱。'
        : `智谱不可用，实际会走 ${usable.join('、')}（付费）。以上面 providers[].detail 里的报错为准去修。`;

  return NextResponse.json(
    {
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      okCount,
      verdict,
      providers,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
