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

/** 默认频道。这些频道 id 均经 t.me/s/<id> 公开预览验证可读。 */
export const DEFAULT_TELEGRAM_CHANNELS =
  'kz:@tengrinews, uz:@kunuzofficial@gazetauz, kg:@akipress, tj:@asiaplus';

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
