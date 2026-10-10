/**
 * 定时推送窗口的回归测试（**不联网、不碰数据库、不调模型**）。
 *
 *   pnpm test:publish-window
 *
 * ## 这个测试在防什么
 *
 * 2026-09-24，早晚报**各空跑一轮**，用户两次看到「草稿箱是空的」。
 * 两轮的根因是同一条：推送窗口的起点算的是「**执行时刻** − hours」，
 * 于是抓取被 429 拖到 2–3 小时候，窗口整体后移 ——
 * 既漏掉开头那一段（当期没人覆盖、下一期也不是它），又与上一轮重叠（重复推送）。
 *
 * 这个文件把「窗口必须由时刻表钟点决定、与迟到无关」钉成断言。
 * 它跑得很快，所以「改 cron 忘了改别处」这类错误在本地就会红，
 * 而不是等到读者说「今天的草稿呢」。
 *
 * ## 2026-10-10 起：只剩一段（原早晚报合并成 04:00 日报，窗口 24h）
 *
 * 合并**删掉的是一整类不变量**（「两段必须首尾相接」），所以有几组断言
 * 从「两段互相咬合」改成了「单段 + 相邻两轮咬合」——
 * 不是把断言放松了，而是被断言的对象少了一个。
 * ⚠️ 别把它们当成「测试变简单了」就顺手删掉：剩下的每一条都还对着一个
 * **真实发生过的故障**，删掉不会有任何东西变红，只会在某天悄悄丢稿。
 *
 * ## 怎么读这些断言
 *
 * 每个时间点都写成**北京墙上时间**再换算成 UTC 常量，因为约定（04:00）
 * 讲的是北京时间。直接写 UTC 会让人每看一行都要心算一次 -8。
 */
import { cronHour, scheduleHoursCrossCheck, scheduledWindow, PUBLISH_SCHEDULES } from '../src/lib/publish-schedule';
import {
  FETCH_HARD_WAIT_MS,
  MEASURED_WORST_FETCH_MS,
  MEASURED_WORST_PER_ARTICLE_MS,
  MERGED_ROUND_MAX_CANDIDATES,
  mergedRoundWorstMs,
  waitBudgetCrossCheck,
} from '../src/lib/scheduler';
import { readFileSync } from 'fs';
import { resolve } from 'path';

let passed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
  } else {
    failures.push(`${name}${detail ? ' —— ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`);
  }
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

/** 北京墙上时间 → 真实时刻（测试里只用来构造输入，被测函数自己也会做同样的换算） */
function bj(y: number, mo: number, d: number, h: number, mi = 0): Date {
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - 8 * 60 * 60 * 1000);
}

const iso = (x: Date | undefined) => (x ? x.toISOString() : String(x));

/** 一天一段时，所有断言的窗口都从这个 period 取 —— 别在这里写死 `'daily'`。 */
const P = PUBLISH_SCHEDULES[0]?.period;

// ---------------------------------------------------------------------------

section('cronHour · 从表达式取小时，取不到就抛');
{
  ok('0 4 * * * → 4', cronHour('0 4 * * *') === 4, String(cronHour('0 4 * * *')));
  // 下面两个是**历史值**（2026-09-24 ~ 2026-10-09 的早晚报）。留着是因为
  // `cronHour` 是通用解析函数，历史表达式一旦出现在别处（例如回放旧窗口的脚本里）
  // 也得能解析对。
  ok('0 7 * * * → 7（历史早报）', cronHour('0 7 * * *') === 7, String(cronHour('0 7 * * *')));
  ok('0 19 * * * → 19（历史晚报）', cronHour('0 19 * * *') === 19, String(cronHour('0 19 * * *')));
  for (const bad of ['* * * *', '0 4 * *', 'every day', '']) {
    let threw = false;
    try {
      cronHour(bad);
    } catch {
      threw = true;
    }
    ok(`非法 cron 抛错（不回退默认值）：${JSON.stringify(bad)}`, threw);
  }
}

section('scheduledWindow · 准时跑时的窗口（与时刻表一致）');
{
  // 2026-10-10 凌晨 04:00 北京时间触发
  const w = scheduledWindow(P, bj(2026, 10, 10, 4));
  ok('日报窗口终点 = 今日 04:00（北京）', iso(w?.end) === '2026-10-09T20:00:00.000Z', iso(w?.end));
  ok('日报窗口起点 = 昨日 04:00（北京）', iso(w?.start) === '2026-10-08T20:00:00.000Z', iso(w?.start));
  ok('日报窗口 24 小时', w?.hours === 24, String(w?.hours));
  // 来源标记必须说「按时刻表固定」—— 它是响应/日志里区分两条代码路径的唯一字段。
  ok('窗口来源 = schedule（不是浮动的 hours 分支）', w?.source === 'schedule', String(w?.source));
}

section('★ scheduledWindow · 迟到时窗口**不移动**（2026-09-24 空跑那一轮的回归）');
{
  // 真实情形：04:00 触发，抓取被拖到 10:30 才轮到推送。
  const onTime = scheduledWindow(P, bj(2026, 10, 10, 4));
  const late = scheduledWindow(P, bj(2026, 10, 10, 10, 30));
  ok('迟到 6.5h，起点不变', iso(late?.start) === iso(onTime?.start), `${iso(onTime?.start)} vs ${iso(late?.start)}`);
  ok('迟到 6.5h，终点不变', iso(late?.end) === iso(onTime?.end), `${iso(onTime?.end)} vs ${iso(late?.end)}`);
  ok('迟到 6.5h，窗口长度仍 24h', late?.hours === 24, String(late?.hours));

  // 极端：拖到当天最后一分钟也不该动（硬上限 400 分钟 ⇒ 最晚约 10:50，这条是余量）
  const lateEnd = scheduledWindow(P, bj(2026, 10, 10, 23, 59));
  ok('拖到当日 23:59 仍不变', iso(lateEnd?.start) === iso(onTime?.start) && iso(lateEnd?.end) === iso(onTime?.end));

  // ⚠️ **已知边界，不是缺陷（当前不成立）**：窗口锚在「**执行日的北京日期**」上 ——
  // 所以推送一旦跨过北京午夜，`beijingFields` 拿到的是新的一天，窗口就漂到下一轮，
  // 而这正是缺陷 19 那个形态（漏一段 + 与上一轮重叠）。
  // 现在 04:00 起跑 + 硬上限 400 分钟 ⇒ 最晚约 10:50 收工，**到不了午夜**，所以不构成现实风险。
  // 钉成断言的理由是：**若哪天把起跑改到下午/晚上，这条就会变成真风险**。
  // 到那时这条测试仍然是绿的，但你改时刻表时应该先看到这段注释。
  const crossed = scheduledWindow(P, bj(2026, 10, 11, 0, 30));
  ok(
    '跨过北京午夜 ⇒ 窗口漂到下一轮（已知边界：改起跑时刻前必须重看这段）',
    iso(crossed?.start) !== iso(onTime?.start),
    `${iso(onTime?.start)} vs ${iso(crossed?.start)}`,
  );

  // 对照组：**旧算法**（执行时刻 − hours）在同一情形下会漂走。
  // 留着这一条是为了让「为什么必须固定」在测试里就是个可执行的结论，
  // 而不只是注释里的一段叙述。
  const oldStart = new Date(bj(2026, 10, 10, 10, 30).getTime() - 24 * 3_600_000);
  ok(
    '对照：旧算法（执行时刻−24h）的起点确实与固定窗口不同',
    oldStart.toISOString() !== iso(late?.start),
    `旧=${oldStart.toISOString()} 新=${iso(late?.start)}`,
  );
  ok(
    '对照：旧算法的起点更晚 ⇒ 会漏掉 [昨日04:00, 昨日10:30] 这一段',
    oldStart.getTime() > (late?.start.getTime() ?? 0),
    iso(oldStart),
  );
  ok(
    '对照：旧算法的终点伸进下一轮窗口 ⇒ 与下一轮重叠（重复推送的来源）',
    late !== null && bj(2026, 10, 10, 10, 30).getTime() > late.end.getTime(),
  );
}

section('单段：相邻两轮严格首尾相接（不重叠、不留空档）');
{
  // 2026-10-10 合并成一段后，「两段互相咬合」退化成「**相邻两轮**互相咬合」：
  // 第 N 轮的终点必须是第 N+1 轮的起点，否则中间那段新闻**永远不会被任何一轮覆盖**。
  const d9 = scheduledWindow(P, bj(2026, 10, 9, 4));
  const d10 = scheduledWindow(P, bj(2026, 10, 10, 4));
  const d11 = scheduledWindow(P, bj(2026, 10, 11, 4));

  ok('10-09 轮终点 = 10-10 轮起点', iso(d9?.end) === iso(d10?.start), `${iso(d9?.end)} / ${iso(d10?.start)}`);
  ok('10-10 轮终点 = 10-11 轮起点', iso(d10?.end) === iso(d11?.start), `${iso(d10?.end)} / ${iso(d11?.start)}`);
  ok(
    '连续两轮无缝：没有空档也没有重叠',
    [d9, d10].every((w, i) => iso(w?.end) === iso([d10, d11][i]?.start)),
  );
  ok('单段本身覆盖 24 小时（正好一整天）', d10?.hours === 24, String(d10?.hours));
  ok(
    '相邻两轮的窗口长度相同（长度不与「哪一天」挂钩）',
    d9?.hours === d10?.hours && d10?.hours === d11?.hours,
    `${d9?.hours} / ${d10?.hours} / ${d11?.hours}`,
  );
}

section('人工补跑仍走「执行时刻 − hours」；不在表里的 period 一律 null');
{
  // 人工补跑要的是「从现在往回数 N 小时」，不能套固定钟点 —— 否则
  // 「补一段指定范围」这个用途就没有了。
  ok('period=manual → null（交给 hours 分支）', scheduledWindow('manual', bj(2026, 10, 10, 22)) === null);
  ok('period 缺失 → null', scheduledWindow(undefined, bj(2026, 10, 10, 22)) === null);
  ok('period 为空串 → null', scheduledWindow('', bj(2026, 10, 10, 22)) === null);
  ok('period 非字符串（数字）→ null', scheduledWindow(42, bj(2026, 10, 10, 22)) === null);
  ok('period=daily 仍返回窗口', scheduledWindow(P, bj(2026, 10, 10, 22)) !== null);

  // ⚠️ **2026-10-10 之后行为变了，这两条是刻意钉住的**：
  // 旧实现第一行是手写白名单 `if (period !== 'morning' && period !== 'evening') return null;`，
  // 合并后白名单改成「period 在不在表里」推导 ⇒ `'morning'` / `'evening'` 现在**不在表里**
  // ⇒ 返回 null ⇒ 调用方退回浮动窗口（`executionTime - hours`）。
  // 生产路径上没人会传它们（调度器只从表里取 period，人工补跑传 `'manual'`），
  // 但**手抄一条 curl 时很容易顺手写成 morning** —— 那时它会静默走浮动窗口。
  // 钉住的理由：这个 null 是「白名单从手写改成表推导」的直接结果，
  // 谁哪天把白名单加回来、或把 daily 改名，这里会红。
  ok("period='morning'（已取消的旧时段）→ null", scheduledWindow('morning', bj(2026, 10, 10, 22)) === null);
  ok("period='evening'（已取消的旧时段）→ null", scheduledWindow('evening', bj(2026, 10, 10, 22)) === null);
}

section('时刻表自身的一致性（跨字段校验）');
{
  ok('表里只有一段（2026-10-10 合并成日报）', PUBLISH_SCHEDULES.length === 1, String(PUBLISH_SCHEDULES.length));
  for (const c of scheduleHoursCrossCheck()) {
    ok(`${c.period} 声明的 hours 与按 cron 推导的一致`, c.ok, `声明 ${c.declared} vs 推导 ${c.derived}`);
  }
  ok('钟点是凌晨 4 点', cronHour(PUBLISH_SCHEDULES[0].cron) === 4, PUBLISH_SCHEDULES[0].cron);
  ok('hours 声明值是 24（一天一段）', PUBLISH_SCHEDULES[0].hours === 24, String(PUBLISH_SCHEDULES[0].hours));
  ok("period 是 'daily'（草稿标题后缀「日报」靠它）", PUBLISH_SCHEDULES[0].period === 'daily', PUBLISH_SCHEDULES[0].period);
}

section('调度器等待预算（抓取没跑完就不该往下走）');
{
  // 2026-09-27 早报：软上限 150 分钟在 01:30:00 到点，而抓取实际跑了 154 分 51 秒，
  // 推送于是在抓取结束前 4 分 49 秒启动，读到一份半空的库 ——
  // 最终只出 1 个国家的草稿。下面这几条把「上限必须留出余量」钉住。
  for (const c of waitBudgetCrossCheck()) ok(c.name, c.ok, c.detail);

  ok(
    '硬上限留了 ≥30 分钟余量（不是刚刚压过**合并前**的实测值）',
    FETCH_HARD_WAIT_MS - MEASURED_WORST_FETCH_MS >= 30 * 60_000,
    `余量 ${Math.round((FETCH_HARD_WAIT_MS - MEASURED_WORST_FETCH_MS) / 60_000)} 分钟`,
  );

  // ★ 2026-10-10 新增，**这条才是合并后真正管用的那条**：
  // 上面那条比的是合并前的单轮记录（270 篇量级 / 155 分钟），
  // 而合并后单轮候选翻倍 ⇒ 拿旧记录当基准会得出「余量很足」的假结论。
  // 真基准是 `MERGED_ROUND_MAX_CANDIDATES × MEASURED_WORST_PER_ARTICLE_MS`。
  const mergedWorst = mergedRoundWorstMs();
  const min = (ms: number) => `${Math.round(ms / 60_000)} 分钟`;
  ok(
    '★ 抓取硬上限 > 合并后单轮预期最坏耗时（候选翻倍后的真基准）',
    FETCH_HARD_WAIT_MS > mergedWorst,
    `硬 ${min(FETCH_HARD_WAIT_MS)} vs 预期最坏 ${min(mergedWorst)}` +
      `（${MERGED_ROUND_MAX_CANDIDATES} 候选 × ${MEASURED_WORST_PER_ARTICLE_MS / 1000} 秒/篇）`,
  );
  ok(
    '★ 合并后余量 ≥30 分钟（按真基准算，不是按合并前的旧记录）',
    FETCH_HARD_WAIT_MS - mergedWorst >= 30 * 60_000,
    `余量 ${min(FETCH_HARD_WAIT_MS - mergedWorst)}`,
  );
}

// ------------------------------------------------------------
// ★ 源码断言：抓取没在硬上限内跑完 ⇒ **本轮不推送**（缺陷第 20 条）
// ------------------------------------------------------------
//
// 为什么这里只能用**源码断言**，不能用行为断言：`runPublishCycle` 一跑就真的
// 会发 HTTP、读库、建草稿 —— 单测里不可能调它。而这条早退是「静默丢稿」的
// 唯一防线：2026-09-27 早报在抓取结束前 4 分 49 秒启动推送，读到半空的库，
// 最后只出了 kg 一国，而 `summary.failures` 是**空的**（接口看起来是成功的）。
//
// ⚠️ 删掉这个 `return` 不会有任何测试变红，只会让某天的草稿箱悄悄变空 ——
// 正是本项目最怕的那类形态。所以退而求其次：把它在**源码里的形状**钉死。
// 这类断言比行为断言脆（改个变量名就会红），但红的时候看一眼就知道是不是真删了。
try {
  const src = readFileSync(resolve(process.cwd(), 'src/lib/scheduler.ts'), 'utf8');
  ok(
    '★ 抓取未完成时 `runPublishCycle` **直接 return**（不许推一份缺国家的稿子）',
    /if\s*\(\s*!fetchOutcome\.finished\s*\)\s*\{[\s\S]{0,700}?return;/.test(src),
    '这条没了 = 2026-09-27「五国只推一国、failures 却是空的」会重演',
  );
  ok(
    '★ 早退走的是 `console.error`（不是 warn / log）',
    /!fetchOutcome\.finished\s*\)\s*\{[\s\S]{0,700}?console\.error/.test(src),
    '降成 warn 就会被淹没在推流的日志里',
  );
  ok(
    '★ 早退的日志里带了「手工补推」的指引（否则这一轮新闻永久漏掉）',
    /手工补[\s\S]{0,200}?period["']?\s*:\s*["']?manual/.test(src),
    '没有补推指引 = 运维只知道失败了，不知道该做什么',
  );
  ok(
    '★ 抓取与推送在同一个函数里**串行**（推送不得先于抓取跑）',
    /const fetchOutcome = await runFetchNews\(\);[\s\S]{0,1400}?await runWechatPush\(/.test(src),
    '先推/并行 = 读到上一轮的旧数据，把上一次推过的新闻再推一遍',
  );
} catch (err) {
  ok('能读到 scheduler.ts 做源码断言', false, err instanceof Error ? err.message : String(err));
}

console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
