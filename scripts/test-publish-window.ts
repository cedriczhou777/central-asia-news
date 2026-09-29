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
 * ## 怎么读这些断言
 *
 * 每个时间点都写成**北京墙上时间**再换算成 UTC 常量，因为约定（07:00 / 19:00）
 * 讲的是北京时间。直接写 UTC 会让人每看一行都要心算一次 -8。
 */
import { cronHour, scheduleHoursCrossCheck, scheduledWindow, PUBLISH_SCHEDULES } from '../src/lib/publish-schedule';
import {
  FETCH_HARD_WAIT_MS,
  MEASURED_WORST_FETCH_MS,
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

// ---------------------------------------------------------------------------

section('cronHour · 从表达式取小时，取不到就抛');
{
  ok('0 7 * * * → 7', cronHour('0 7 * * *') === 7, String(cronHour('0 7 * * *')));
  ok('0 19 * * * → 19', cronHour('0 19 * * *') === 19, String(cronHour('0 19 * * *')));
  for (const bad of ['* * * *', '0 7 * *', 'every day', '']) {
    let threw = false;
    try {
      cronHour(bad);
    } catch {
      threw = true;
    }
    ok(`非法 cron 抛错（不回退默认值）：${JSON.stringify(bad)}`, threw);
  }
}

section('scheduledWindow · 准时跑时的窗口（与设计文档一致）');
{
  // 2026-09-24 早报 07:00 北京时间触发
  const m = scheduledWindow('morning', bj(2026, 9, 24, 7));
  ok('早报窗口终点 = 今日 07:00', iso(m?.end) === '2026-09-23T23:00:00.000Z', iso(m?.end));
  ok('早报窗口起点 = 昨日 19:00', iso(m?.start) === '2026-09-23T11:00:00.000Z', iso(m?.start));
  ok('早报窗口 12 小时', m?.hours === 12, String(m?.hours));

  // 2026-09-24 晚报 19:00 北京时间触发
  const e = scheduledWindow('evening', bj(2026, 9, 24, 19));
  ok('晚报窗口起点 = 今日 07:00', iso(e?.start) === '2026-09-23T23:00:00.000Z', iso(e?.start));
  ok('晚报窗口终点 = 今日 19:00', iso(e?.end) === '2026-09-24T11:00:00.000Z', iso(e?.end));
  ok('晚报窗口 12 小时', e?.hours === 12, String(e?.hours));
}

section('★ scheduledWindow · 迟到时窗口**不移动**（2026-09-24 空跑那一轮的回归）');
{
  // 今晚的真实情形：19:00 触发，抓取跑到 21:30 才轮到推送。
  const onTime = scheduledWindow('evening', bj(2026, 9, 24, 19));
  const late = scheduledWindow('evening', bj(2026, 9, 24, 21, 30));
  ok('晚报迟到 2.5h，起点不变', iso(late?.start) === iso(onTime?.start), `${iso(onTime?.start)} vs ${iso(late?.start)}`);
  ok('晚报迟到 2.5h，终点不变', iso(late?.end) === iso(onTime?.end), `${iso(onTime?.end)} vs ${iso(late?.end)}`);

  // 早上那次：07:00 触发，抓取跑了 150 分钟，推送迟到到 10:30
  const mOnTime = scheduledWindow('morning', bj(2026, 9, 24, 7));
  const mLate = scheduledWindow('morning', bj(2026, 9, 24, 10, 30));
  ok('早报迟到 3.5h，窗口也不变', iso(mLate?.start) === iso(mOnTime?.start) && iso(mLate?.end) === iso(mOnTime?.end));

  // 对照组：**旧算法**（执行时刻 − hours）在同一情形下会漂走。
  // 留着这一条是为了让「为什么必须固定」在测试里就是个可执行的结论，
  // 而不只是注释里的一段叙述。
  const oldStart = new Date(bj(2026, 9, 24, 21, 30).getTime() - 12 * 3_600_000);
  ok(
    '对照：旧算法（执行时刻−12h）的起点确实与固定窗口不同',
    oldStart.toISOString() !== iso(late?.start),
    `旧=${oldStart.toISOString()} 新=${iso(late?.start)}`,
  );
  ok(
    '对照：旧算法的起点更晚 ⇒ 会漏掉 [07:00, 09:30] 这一段',
    oldStart.getTime() > (late?.start.getTime() ?? 0),
    iso(oldStart),
  );
  ok(
    '对照：旧算法的终点伸进次日早报窗口 ⇒ 与下一轮重叠（重复推送的来源）',
    late !== null && bj(2026, 9, 24, 21, 30).getTime() > late.end.getTime(),
  );
}

section('两段首尾相接：合起来正好 24 小时，不重叠不留空档');
{
  // 以 2026-09-24 这一天为基准，取「昨日晚报 / 今日早报 / 今日晚报 / 明日早报」四个窗口
  const eve23 = scheduledWindow('evening', bj(2026, 9, 23, 19));
  const mor24 = scheduledWindow('morning', bj(2026, 9, 24, 7));
  const eve24 = scheduledWindow('evening', bj(2026, 9, 24, 19));
  const mor25 = scheduledWindow('morning', bj(2026, 9, 25, 7));

  ok('昨日晚报终点 = 今日早报起点', iso(eve23?.end) === iso(mor24?.start), `${iso(eve23?.end)} / ${iso(mor24?.start)}`);
  ok('今日早报终点 = 今日晚报起点', iso(mor24?.end) === iso(eve24?.start), `${iso(mor24?.end)} / ${iso(eve24?.start)}`);
  ok('今日晚报终点 = 明日早报起点', iso(eve24?.end) === iso(mor25?.start), `${iso(eve24?.end)} / ${iso(mor25?.start)}`);
  ok(
    '连续四段无缝：没有空档也没有重叠',
    [eve23, mor24, eve24].every((w, i) => iso(w?.end) === iso([mor24, eve24, mor25][i]?.start)),
  );
  ok('相邻两段合计 24 小时（正好一整天）', (mor24?.hours ?? 0) + (eve24?.hours ?? 0) === 24);
}

section('人工补跑仍走「执行时刻 − hours」');
{
  // 人工补跑要的是「从现在往回数 N 小时」，不能套固定钟点 —— 否则
  // 「补一段指定范围」这个用途就没有了。
  ok('period=manual → null（交给 hours 分支）', scheduledWindow('manual', bj(2026, 9, 24, 22)) === null);
  ok('period 缺失 → null', scheduledWindow(undefined, bj(2026, 9, 24, 22)) === null);
  ok('period 为空串 → null', scheduledWindow('', bj(2026, 9, 24, 22)) === null);
  ok('period=evening 仍返回窗口', scheduledWindow('evening', bj(2026, 9, 24, 22)) !== null);
}

section('时刻表自身的一致性（跨字段校验）');
{
  ok('早晚两段都在表里', PUBLISH_SCHEDULES.length === 2, String(PUBLISH_SCHEDULES.length));
  const check = scheduleHoursCrossCheck();
  for (const c of check) {
    ok(`${c.period} 声明的 hours 与按 cron 推导的一致`, c.ok, `声明 ${c.declared} vs 推导 ${c.derived}`);
  }
  ok('两段的钟点分别是 7 与 19', cronHour(PUBLISH_SCHEDULES[0].cron) === 7 && cronHour(PUBLISH_SCHEDULES[1].cron) === 19);
}

section('调度器等待预算（抓取没跑完就不该往下走）');
{
  // 2026-09-27 早报：软上限 150 分钟在 01:30:00 到点，而抓取实际跑了 154 分 51 秒，
  // 推送于是在抓取结束前 4 分 49 秒启动，读到一份半空的库 ——
  // 最终只出 1 个国家的草稿。下面这几条把「上限必须留出余量」钉住。
  for (const c of waitBudgetCrossCheck()) ok(c.name, c.ok, c.detail);
  ok(
    '硬上限留了 ≥30 分钟余量（不是刚刚压过实测值）',
    FETCH_HARD_WAIT_MS - MEASURED_WORST_FETCH_MS >= 30 * 60_000,
    `余量 ${Math.round((FETCH_HARD_WAIT_MS - MEASURED_WORST_FETCH_MS) / 60_000)} 分钟`,
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
    '先推/并行 = 读到上一轮的旧数据，早报把前一晚推过的新闻再推一遍',
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
