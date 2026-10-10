/**
 * 「翻译前去重」（`DEDUP_BEFORE_TRANSLATE`）的回归断言。
 *
 * 用法：`pnpm test:dedup-before-translate`（离线、不联网、不碰数据库）
 *
 * ## 为什么需要一个专门的脚本
 *
 * 这条优化有**两个会静默失效**的点，而且失效时看起来都像「什么都没发生」：
 *
 * 1. **开关默认必须关**。默认开的话，就没有「不优化」的同期基线可比 ——
 *    而这条改动的全部价值只能靠对比读数证明（`durationMs`、
 *    `dedup.skippedBeforeTranslate` 与 `dedup.againstDb` 的此消彼长）。
 * 2. **位置必须真的在翻译之前**。挪到 `translateNews` 之后，代码照样能跑、
 *    类型照样过、功能上**完全等价于什么都没做**（闸 2 反正会丢掉那些稿子）——
 *    唯一的症状是「省的钱没出现」。这类「不动集合、只动成本」的改动，
 *    靠功能测试是**测不出来**的，只能靠结构断言把位置钉住。
 *
 * 另外两条断言是为了防止「优化把正确性吃掉」：
 *   · 前置探测的结果必须进 `preKnown*`，**不能**替闸 2 的 `existing*`；
 *   · 闸 2 那次查询仍必须在循环**之后**（它能看见循环期间别的进程新插的行）。
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  isDedupBeforeTranslateEnabled,
  dedupPreWindowDays,
} from '../src/lib/dedup-before-translate';

let passed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
  } else {
    failures.push(detail ? `${name} —— ${detail}` : name);
  }
}

// ----- ① 开关解析：默认必须是「关」 -----

// `undefined` 是「环境变量没设」的真实形态（`process.env.X` 不存在时就是这个值）。
const offCases: Array<[string, string | undefined]> = [
  ['未设置（undefined）', undefined],
  ['空串', ''],
  ['纯空格', '   '],
  ['off', 'off'],
  ['0', '0'],
  ['false', 'false'],
  // 大小写与空白的容错：环境变量很容易被写成 " ON "。
  ['OFF（大写）', 'OFF'],
  ['False（混合大小写）', 'False'],
];
for (const [label, raw] of offCases) {
  ok(`开关默认关：${label} ⇒ false`, isDedupBeforeTranslateEnabled(raw) === false);
}

const onCases = [
  ['1', '1'],
  ['on', 'on'],
  ['true', 'true'],
  ['ON（大写）', 'ON'],
  [' true （带空白）', ' true '],
  ['True（混合大小写）', 'True'],
];
for (const [label, raw] of onCases) {
  ok(`开关可显式打开：${label} ⇒ true`, isDedupBeforeTranslateEnabled(raw) === true);
}

// ----- ② 前置窗口必须严格窄于库内窗口 -----

ok(
  '窗口：DB_DEDUP_WINDOW_DAYS=3 ⇒ 前置窗口 2 天（必须窄一天）',
  dedupPreWindowDays(3) === 2,
  `实际 ${JSON.stringify(dedupPreWindowDays(3))}`,
);
ok('窗口：2 ⇒ 1', dedupPreWindowDays(2) === 1, `实际 ${JSON.stringify(dedupPreWindowDays(2))}`);
// 下面这些必须返回 null（= 关掉优化），**不能**退化成等宽 —— 等宽会丢稿，
// 理由见 `dedupPreWindowDays` 的注释。
ok('窗口：1 ⇒ null（收不出更窄窗口，必须关掉而不是等宽）', dedupPreWindowDays(1) === null);
ok('窗口：0 ⇒ null', dedupPreWindowDays(0) === null);
ok('窗口：负数 ⇒ null', dedupPreWindowDays(-3) === null);
ok('窗口：NaN ⇒ null', dedupPreWindowDays(Number.NaN) === null);
ok('窗口：Infinity ⇒ null', dedupPreWindowDays(Number.POSITIVE_INFINITY) === null);

// ----- ③ 结构断言：位置、护栏、以及「别把闸 2 吃掉」 -----

const ROUTE = join(process.cwd(), 'src/app/api/fetch-news/route.ts');
const src = readFileSync(ROUTE, 'utf8');
ok('route.ts 读到了内容（否则下面所有结构断言都是空转的绿灯）', src.length > 10_000, `${src.length} 字节`);

/** 取子串位置；找不到返回 -1（调用方必须显式处理，别让它当 0 用）。 */
function pos(needle: string): number {
  return src.indexOf(needle);
}

/** 断言 A 出现在 B 之前，且两个 needle 都真的存在。 */
function okBefore(label: string, a: string, b: string) {
  const pa = pos(a);
  const pb = pos(b);
  if (pa < 0 || pb < 0) {
    ok(label, false, `锚点缺失：${pa < 0 ? `「${a}」` : ''}${pb < 0 ? `「${b}」` : ''}`);
    return;
  }
  ok(label, pa < pb, `${a} @${pa} 不在 ${b} @${pb} 之前`);
}

// ③-1 开关确实被调用，并且带了「干跑模式不做」这个条件。
ok(
  '③-1 开关经 `isDedupBeforeTranslateEnabled()` 读取（不是直接读 process.env 绕过）',
  pos('isDedupBeforeTranslateEnabled()') >= 0,
);
ok(
  '③-1 窗口经 `dedupPreWindowDays(DB_DEDUP_WINDOW_DAYS)` 计算（不是自己拍一个天数）',
  pos('dedupPreWindowDays(DB_DEDUP_WINDOW_DAYS)') >= 0,
);
ok(
  '③-1 干跑模式（skipTranslation）不做前置跳过',
  pos('&& !skipTranslation') >= 0,
  '开关表达式里没看到 dry-run 排除条件',
);

// ③-2 ★ 位置：前置判定必须在第一次翻译调用之前。
// 这条是本次改动**唯一**能坏掉价值而不报错的地方，所以用结构断言钉死。
okBefore(
  '③-2 ★ 前置判定（preKnownUrls.has）在 `await translateNews(` 之前',
  'preKnownUrls.has(',
  'await translateNews(',
);
// 顺带钉住「在 og:image 抓取之前」—— 那是另一个花钱的网络调用。
okBefore(
  '③-2 前置判定在 og:image 抓取（fetchOgImage）之前',
  'preKnownUrls.has(',
  'await fetchOgImage(',
);

// ③-3 前置判定必须被 `preKnownOk` 门住（探测失败时一条都不许跳）。
okBefore(
  '③-3 前置判定被 `if (preKnownOk)` 门住',
  'if (preKnownOk) {',
  'preKnownUrls.has(',
);

// ③-4 前置探测的结果只能进 preKnown*，不能替闸 2 的 existing*。
ok(
  '③-4 前置探测把结果写进 preKnown*（不是 existing*）',
  pos('preKnownUrls = urlWindow.urls') >= 0 && pos('preKnownOriginals = originalWindow.keys') >= 0,
);

// ③-5 ★ 闸 2 必须还在，而且仍在循环之后（它能看见循环期间别的进程新插的行）。
// 这是「前置只是优化、正确性由闸 2 承担」这条分工的机械化检查。
const THIRD_STEP = '// 第三步：去重并入库';
ok('③-5 第三步（闸 1/2/3）仍在文件里', pos(THIRD_STEP) >= 0);
okBefore(
  '③-5 ★ 前置探测在「第三步」之前（它跑在采集循环之前）',
  'preKnownUrls = urlWindow.urls',
  THIRD_STEP,
);
okBefore(
  '③-5 ★ 闸 2 的权威查询在「第三步」之后（不许被前置探测替代）',
  THIRD_STEP,
  'existingUrls = urlWindow.urls',
);
ok(
  '③-5 闸 1（批内身份去重）未被删除',
  pos('let intraBatchDropped = 0') >= 0 && pos('const withinBatch') >= 0,
);
ok(
  '③-5 闸 2 的 fail-closed 分支未被删除（dbCheckError ⇒ 不入库）',
  pos('dbCheckError\n    ? []') >= 0 || pos('? []\n    : withinBatch.filter((a) => {') >= 0,
  '没找到 `dbCheckError ? [] : withinBatch.filter(...)` 这个 fail-closed 写法',
);

// ③-6 前置探测失败时不许污染 `dbCheckError`（那会变成「本轮不入库」）。
// 用「早退/降级那段的 warn 文案」定位，并断言它不是设置 dbCheckError。
const advisoryCatch = src.indexOf('翻译前去重探测失败');
ok('③-6 前置探测有独立的降级 catch（不是静默失败）', advisoryCatch >= 0);
if (advisoryCatch >= 0) {
  // 从 warn 往前找 1200 字，确认这段里没有把 dbCheckError 设成非 null。
  const around = src.slice(Math.max(0, advisoryCatch - 1200), advisoryCatch + 1200);
  ok(
    '③-6 前置探测失败**不**设置 dbCheckError（只影响省不省时间，不影响正确性）',
    !/dbCheckError\s*=[^=]/.test(around),
    '降级那一段里出现了对 dbCheckError 的赋值',
  );
}

// ----- ④ 活体回显：不花一轮就能确认开关（2026-10-10 加） -----
//
// 起因：这个开关是**控制台设的环境变量**，而一轮真跑 2.5 小时 + 翻译费。
// 没有回显时，「环境变量到底设上没有」只能等跑完一轮才知道 ——
// 而若那时它其实没生效，那一轮量到的是「关闭态」，两天的排期就白排了。
// 所以下面钉住的是「**不花钱就能问清楚**」这个能力本身。
const GET_ANCHOR = 'export async function GET()';
const getAt = pos(GET_ANCHOR);
ok('④ GET 处理器仍在文件里（否则下面几条是空转的绿灯）', getAt >= 0);
const getBody = getAt >= 0 ? src.slice(getAt) : '';

ok('④ GET 里回显开关本身（`switch`）', getBody.includes('switch: dedupBeforeTranslateSwitch'));
ok(
  '④ GET 里回显解析出的前置窗口（`windowDays`）',
  getBody.includes('windowDays: dedupBeforeTranslateWindowDays'),
);
ok(
  '④ GET 里给出综合判据（`effective` = switch && windowDays !== null）',
  getBody.includes('effective: dedupBeforeTranslateSwitch && dedupBeforeTranslateWindowDays !== null'),
);
ok(
  '④ 回显经 `isDedupBeforeTranslateEnabled()` 现算（不是直接读 process.env，绕过解析容错）',
  getBody.includes('isDedupBeforeTranslateEnabled()') &&
    !getBody.includes('process.env.DEDUP_BEFORE_TRANSLATE'),
  '回显要么没走纯函数，要么直接读了环境变量',
);
ok(
  '④ 回显现算而不是从 lastRun 里取（后者是内存态，冷启动读到的空态会骗人）',
  !/dedupBeforeTranslateSwitch\s*=\s*fetchRunState/.test(getBody),
);
// ★ 这条守的是「别把保活 ping 打到会跑一轮的接口上」那件事的另一半：
//   GET 既然被文档推荐当保活靶子，就必须**永远**没有副作用。
ok(
  '④ ★ GET 无副作用：不翻译、不入库、不抓取（它被推荐当保活 ping 的靶子）',
  !/translateNews\(/.test(getBody) && !/insertArticles\(/.test(getBody) && !/fetchFeed\(/.test(getBody),
  'GET 处理器里出现了翻译/入库/抓取调用',
);
// 干跑时 `active` 必须为 false（干跑不翻译 ⇒ 没有「白翻」可省）——
// 与上面 ③-1 的 `&& !skipTranslation` 是同一个约束的两种写法，两处都要在。
ok(
  '④ 轮次结果里也盖章了本轮的因果（`beforeTranslate` 三字段）',
  pos('switch: dedupBeforeTranslateSwitch,') >= 0 &&
    pos('active: dedupBeforeTranslate,') >= 0 &&
    pos('windowDays: preWindowDays,') >= 0,
);

// ----- 汇总 -----

console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
