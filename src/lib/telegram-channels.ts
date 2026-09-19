/**
 * Telegram 频道配置解析（纯函数，可独立测试）。
 *
 * 环境变量 TELEGRAM_CHANNELS 的格式：
 *   `国家:频道[@频道...]`，多个国家用逗号分隔，频道可带或不带 `@`。
 *
 * 例：
 *   `kz:@tengrinews, uz:@kunuzofficial@gazetauz`
 *   → [
 *       { country: 'kz', channel: '@tengrinews' },
 *       { country: 'uz', channel: '@kunuzofficial' },
 *       { country: 'uz', channel: '@gazetauz' },
 *     ]
 *
 * 为什么单独抽出来：旧版把整段 `"@a@b"` 当成一个频道名去请求 API，
 * 也就是「按文档格式配了，但一个频道也抓不到」，而且日志里看不出任何异常。
 * 抽成纯函数后可以用 scripts/test-telegram-channels.ts 直接跑用例锁住行为。
 */

/**
 * 默认频道。
 *
 * **每一个 id 都在 2026-09-19 用 `https://<worker>/?channel=<id>` 实测过**
 * （返回非空 posts 且最新一条是当日/前一日）。加频道前必须这样验一次 ——
 * 频道名写错时 Worker 只会返回 `{posts:[]}`，静默得像「那天没新闻」。
 *
 * 实测**不可用**的候选（别再往里加）：@kabar_kg、@tazabek、@vesti_kg、@24kgnews、
 * @khovar、@ozodi_org、@tajikistan_news、@azertac、@trend_az、@modernaz、@haqqinaz。
 * 死频道写进来只会白白多跑一轮 Worker 请求，而且让 sourceErrors 里常年挂着噪音。
 */
export const DEFAULT_TELEGRAM_CHANNELS =
  // 哈萨克斯坦：Tengrinews（最大民营新闻社）
  'kz:@tengrinews, ' +
  // 乌兹别克斯坦：Kun.uz（最大新闻站）、Gazeta.uz（独立媒体）、Spot.uz（商业财经）
  'uz:@kunuzofficial@gazetauz@spotuz, ' +
  // 吉尔吉斯斯坦：AKIpress（通讯社）、Economist.kg（商业财经）、Sputnik 吉语台
  'kg:@akipress@economist_kg@sputnik_kyrgyzstan, ' +
  // 塔吉克斯坦：Asia-Plus（主要独立媒体）、Sputnik 塔语台
  // （Khovar 国家通讯社没有可读的公开频道，只能靠 RSS）
  'tj:@asiaplus@sputnik_tajikistan, ' +
  // 阿塞拜疆：APA（通讯社）、Qafqazinfo（新闻门户）、Banker.az（金融财经，对投资者最直接）
  // （AZERTAC / Trend.az 官方台都没有公开预览频道，只能靠 RSS）
  'az:@apa_az@qafqazinfo@banker_az';

export interface TelegramChannelEntry {
  country: string;
  channel: string;
}

/**
 * 解析 `TELEGRAM_CHANNELS` 原始字符串。
 *
 * 容错规则：
 * - 空值 / 只有空白 → 返回空数组（调用方据此跳过，不伪造）
 * - 段内没有 `:` 或国家名为空 → 跳过该段
 * - 频道名的分隔符是「空白或 `@`」，所以 `@a@b`、`@a @b`、`@a,b`（逗号已在更外层切分）
 *   都能拆出正确的频道列表
 * - 未带 `@` 的裸写法会补上 `@`
 */
export function parseTelegramChannels(
  raw: string | undefined | null,
): TelegramChannelEntry[] {
  if (!raw) return [];

  const entries: TelegramChannelEntry[] = [];
  for (const seg of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = seg.indexOf(':');
    if (idx <= 0) continue;

    const country = seg.slice(0, idx).trim();
    if (!country) continue;

    const names = seg
      .slice(idx + 1)
      .split(/[\s@]+/)
      .map((c) => c.trim())
      .filter(Boolean);

    for (const name of names) {
      entries.push({ country, channel: `@${name}` });
    }
  }
  return entries;
}
