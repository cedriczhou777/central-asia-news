import { NextResponse } from 'next/server';
import { probeTelegramChannel } from '@/lib/scraper';
import { DEFAULT_TELEGRAM_CHANNELS, parseTelegramChannels } from '@/lib/telegram-channels';

export const dynamic = 'force-dynamic';

/** 对照组：用容器自己发起一次到「国内肯定可达」的请求，作为网络基线。 */
async function egressControl(): Promise<{ url: string; ok: boolean; status: number | null; latencyMs: number; error: string | null }> {
  const url = 'https://www.baidu.com';
  const startedAt = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    return { url, ok: res.ok, status: res.status, latencyMs: Date.now() - startedAt, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { url, ok: false, status: null, latencyMs: Date.now() - startedAt, error: message };
  }
}

/**
 * GET /api/telegram-check —— Telegram 转发桥体检。
 *
 * 一次调用回答四个问题：
 *   1. `TELEGRAM_WORKER_URL` 到底配的是什么？（原样回显，方便一眼看出配错/截断）
 *   2. 容器**能不能上外网**？（对照组请求百度）
 *   3. 容器**能不能到得了那个 Worker**？（网络层通不通 / HTTP 状态码）
 *   4. Worker 能不能从 t.me 拿到内容？（每个频道的条数与原始报错）
 *
 * 为什么必须有它：微信云托管在大陆网络，`*.workers.dev` 这类境外域名**不一定可达**。
 * 而旧版代码把「DNS 不通」「HTTP 404」「频道不存在」三种情况统一 `return []`，
 * 在 `GET /api/fetch-news` 里看起来都是「Worker 返回 0 条」——完全无法定位。
 *
 * 怎么读结果：
 *   - `egressControl.ok=true` 但所有频道 `status=null` 且 error 含 `fetch failed` / `Timeout`
 *     → **容器到不了 workers.dev 这个域名**（不是频道名的问题，也不是配置写错）
 *   - 频道 `status=404` → Worker 地址写错了（路径不对）
 *   - 频道 `status=400` + `invalid ?channel` → 频道名不合规
 *   - 频道 `postCount>0` → 这条链路是通的
 *
 * 只读、不写库、不改状态，可以随时调（抓取正在跑也可以）。
 */
export async function GET() {
  const startedAt = Date.now();
  const rawChannels = process.env.TELEGRAM_CHANNELS || DEFAULT_TELEGRAM_CHANNELS;
  const entries = parseTelegramChannels(rawChannels);

  // 顺序探测即可：频道之间没有依赖，但并发打会让免费 Worker 更容易被限流，
  // 而且这里本来就只有十来个频道，快慢无所谓，可读性更重要。
  const channels = [];
  for (const entry of entries) {
    const probe = await probeTelegramChannel(entry.channel);
    channels.push({ country: entry.country, ...probe });
  }

  const control = await egressControl();
  const okCount = channels.filter((c) => c.postCount > 0).length;
  const notReachable = channels.filter((c) => c.status === null).length;

  let verdict: string;
  if (!process.env.TELEGRAM_WORKER_URL) {
    verdict = '未配置 TELEGRAM_WORKER_URL，Telegram 通道整体未启用。';
  } else if (okCount > 0) {
    verdict = `${okCount}/${channels.length} 个频道可用，Telegram 链路正常。`;
  } else if (!control.ok) {
    verdict = '容器连百度都不通 —— 是容器完全没有外网，不是 Telegram 的问题。';
  } else if (notReachable > 0) {
    verdict =
      '容器能上外网（百度通），但**到不了 TELEGRAM_WORKER_URL 这个域名**。' +
      '微信云托管在大陆网络常访问不了 *.workers.dev —— 需要给 Worker 绑一个自定义域名，或换一个可达的转发地址。' +
      '这不是频道名写错，改 TELEGRAM_CHANNELS 没有用。';
  } else {
    verdict = '能连上 Worker，但每个频道都拿不到内容 —— 看 channels[].error 里的原始报错。';
  }

  return NextResponse.json(
    {
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workerUrlConfigured: Boolean(process.env.TELEGRAM_WORKER_URL),
      workerUrl: process.env.TELEGRAM_WORKER_URL || null,
      channelsSource: process.env.TELEGRAM_CHANNELS ? 'env:TELEGRAM_CHANNELS' : '代码默认值 DEFAULT_TELEGRAM_CHANNELS',
      channelCount: channels.length,
      okCount,
      egressControl: control,
      verdict,
      channels,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
