/**
 * TELEGRAM_CHANNELS 解析自测 —— 纯本地、不联网、不碰数据库。
 *
 * 用法：pnpm test:channels
 *
 * 覆盖的是那个「按文档配了却一个频道都抓不到」的坑：
 * 单段多频道 `@a@b` 必须被拆成两个频道，而不是当成一个名字。
 */
import {
  parseTelegramChannels,
  DEFAULT_TELEGRAM_CHANNELS,
} from '../src/lib/telegram-channels';

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
    console.error(`      期望: ${e}`);
    console.error(`      实际: ${a}`);
  }
}

console.log('TELEGRAM_CHANNELS 解析用例\n');

// 单个国家单频道
check(
  '单国单频道 kz:@tengrinews',
  parseTelegramChannels('kz:@tengrinews'),
  [{ country: 'kz', channel: '@tengrinews' }],
);

// 核心回归：单段多频道（旧版就是在这里瞎的）
check(
  '单国多频道 @a@b 展开为两个（回归用例）',
  parseTelegramChannels('uz:@kunuzofficial@gazetauz'),
  [
    { country: 'uz', channel: '@kunuzofficial' },
    { country: 'uz', channel: '@gazetauz' },
  ],
);

// 空格分隔的多频道
check(
  '空格分隔 @a @b',
  parseTelegramChannels('uz:@kunuzofficial @gazetauz'),
  [
    { country: 'uz', channel: '@kunuzofficial' },
    { country: 'uz', channel: '@gazetauz' },
  ],
);

// 裸写法（不带 @）要补回 @
check(
  '裸写法自动补 @',
  parseTelegramChannels('kg:akipress'),
  [{ country: 'kg', channel: '@akipress' }],
);

// 多国
check(
  '多国逗号分隔',
  parseTelegramChannels('kz:@tengrinews, uz:@kunuzofficial@a, kg:akipress'),
  [
    { country: 'kz', channel: '@tengrinews' },
    { country: 'uz', channel: '@kunuzofficial' },
    { country: 'uz', channel: '@a' },
    { country: 'kg', channel: '@akipress' },
  ],
);

// 容错：多余空格、空段、尾逗号
check(
  '容忍多余空格与空段',
  parseTelegramChannels('  kz : @tengrinews ,, uz:@a , '),
  [
    { country: 'kz', channel: '@tengrinews' },
    { country: 'uz', channel: '@a' },
  ],
);

// 容错：没有冒号的段直接跳过
check('无冒号的段跳过', parseTelegramChannels('garbage, kz:@tengrinews'), [
  { country: 'kz', channel: '@tengrinews' },
]);

// 容错：空值
check('空字符串', parseTelegramChannels(''), []);
check('undefined', parseTelegramChannels(undefined), []);
check('只有逗号', parseTelegramChannels(',,,'), []);

// 空频道名（kz: 后面什么都没有）应被跳过
check('国家后无频道名则跳过', parseTelegramChannels('kz:, uz:@a'), [
  { country: 'uz', channel: '@a' },
]);

// 默认值本身必须是能解析出频道的
check('默认配置可解析且非空', parseTelegramChannels(DEFAULT_TELEGRAM_CHANNELS).length > 0, true);

console.log(`\n──────── 结果 ────────`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);

if (failed > 0) {
  console.error('\n✗ 存在失败用例，Telegram 频道解析行为不符合预期。');
  process.exit(1);
}

console.log('\n✓ 全部通过。');
