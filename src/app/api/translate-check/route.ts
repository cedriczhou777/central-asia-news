import { NextResponse } from 'next/server';
import { probeTranslationProviders, type ProviderProbe } from '@/lib/translate';

export const dynamic = 'force-dynamic';

/**
 * 「thinking 到底关掉没有」——只看 latencyMs 判不出来，必须和对照组比。
 *
 * 两种情况的处置完全不同：
 *   ① `thinking:{type:'disabled'}` 生效了，只是这家通道本身慢 → 忍，或者换型号；
 *   ② 参数被无视了（型号换代/字段名变了）→ 必须改参数或换型号，否则单篇十几秒，
 *      一整轮翻译要一个多小时。
 * 判据用**响应里的 reasoningChars**（最直接）和「正测 vs 对照组的耗时差」（旁证）。
 */
function thinkingNote(p: ProviderProbe): string | null {
  if (!p.control) return null;
  if (!p.ok) return null;
  if (!p.control.ok) return `${p.provider}：对照组调用失败，无法比较（${p.control.detail}）`;
  if ((p.reasoningChars ?? 0) > 0) {
    return `⚠️ ${p.provider}：明明传了 thinking=disabled，响应里仍有 ${p.reasoningChars} 字 reasoning_content`
      + ` —— 参数被无视了，单篇 ${p.latencyMs}ms 的慢就是 thinking 造成的`;
  }
  const saved = p.control.latencyMs - p.latencyMs;
  if (saved > 3000) {
    return `${p.provider}：thinking 确实关掉了（不关 ${p.control.latencyMs}ms → 关掉 ${p.latencyMs}ms）`;
  }
  return `${p.provider}：关不关 thinking 耗时接近（${p.control.latencyMs}ms vs ${p.latencyMs}ms）`
    + `，慢的原因不在 thinking（多半是该通道本身排队/限流）`;
}

/**
 * GET /api/translate-check —— 翻译通道体检。
 *
 * 对每个配置了 Key 的翻译通道真实打一次极小的请求，返回：
 *   - 用的是哪个型号（含环境变量覆盖后的实际值）
 *   - 通 / 不通
 *   - 不通的**原始报错**（HTTP 状态码 + 响应体片段）
 *   - 单次耗时（`latencyMs`）—— 判断「thinking 有没有真关掉」的关键指标
 *   - `reasoningChars` + `control`（去掉 thinking 参数的对照组）—— 直接给出
 *     「thinking 关掉了没有」的结论，见 `notes`
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
 *   - `notes` 里出现「传了 disabled 仍有 reasoning_content」→ thinking 没关掉，
 *     这就是翻译慢/贵的原因
 *   - `latencyMs` 只有几秒 = 正常；几十秒 = 该通道慢（再看 notes 定位是谁的锅）
 *
 * 它不写库、不改全局统计，所以**抓取正在跑的时候也可以调**。
 * 注意每条通道会打**两次**（正测 + 对照），单次上限 25 秒，最坏 50 秒 ——
 * 刻意压在网关 65 秒之内。
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

  const notes = providers.map(thinkingNote).filter((n): n is string => Boolean(n));

  return NextResponse.json(
    {
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      okCount,
      verdict,
      notes,
      providers,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
