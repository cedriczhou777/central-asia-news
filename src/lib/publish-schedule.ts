/**
 * 定时推送的时刻表 —— **纯数据，不带任何副作用**。
 *
 * 为什么单独一个文件（而不是留在 `scheduler.ts` 里）：
 * 这份时刻表需要被 **两个地方**读到 ——
 *   1. `scheduler.ts`：用它注册 node-cron 任务；
 *   2. `GET /api/wechat/push`：把它**报出来**，当作「线上跑的是哪版时刻表」的指纹。
 * 如果直接 `import { PUBLISH_SCHEDULES } from '@/lib/scheduler'`，
 * 路由的 bundle 里就会连带打进 `node-cron` 和 `resolveSelfBaseUrl()` 的模块级求值 ——
 * 一个纯数据常量不值得带这些副作用。所以拆出来。
 *
 * ## 回看窗口：**已改为由本表推导的固定钟点**（2026-09-24，修缺陷 19）
 *
 * 曾经这里是「改 cron 就必须同步改 hours」的一条**口头纪律**，因为窗口起点算的是
 * `now - hours`（浮动）。那条纪律两次都没守住 —— 2026-09-24 早晚报各空跑一轮，
 * 根因都是「推送迟到 ⇒ 窗口整体后移 ⇒ 漏掉一段、又与上一轮重叠」。
 *
 * 现在窗口由 {@link scheduledWindow} 从**本表的钟点**推导：
 * 每段的起点 = 上一段的钟点，终点 = 本段的钟点，迟到不再影响边界。
 * ⇒ **改 cron 就够了**，不需要再记得改别的地方；`hours` 退化为**交叉校验值**
 * （`test:publish-window` 会断言它与推导值一致，`scheduleHoursCrossCheck()` 也会
 * 随接口报出来）。
 *
 * 现行的两段（2026-09-24 起）：早报 07:00 → `[昨日19:00, 今日07:00]`；
 * 晚报 19:00 → `[今日07:00, 今日19:00]`。首尾相接、合起来正好 24 小时。
 * 19:00 之后发的稿子归**次日早报**（`[今日19:00, 明日07:00]`）——
 * 迟到时窗口**不漂移**是刻意的：重复推送读者看得见，窗口漂移的漏稿没人能发现。
 *
 * ⚠️ 还有一处跟它配套、不在本文件里：
 * `container.config.json` 的 `triggers[].warmup-morning` ——
 * 实例被缩容到零时靠它提前唤醒，时刻也要跟着改（文件里是 UTC，`50 22 * * *` = 北京 06:50）。
 */
export interface PublishSchedule {
  /** node-cron 表达式，按 `Asia/Shanghai` 解释（`startScheduler` 里显式传了时区） */
  cron: string;
  /** 日志里显示用的中文标签 */
  label: string;
  /** 传给 `POST /api/wechat/push` 的时段标记，只影响草稿标题的「早报 / 晚报」后缀 */
  period: 'morning' | 'evening';
  /** 回看窗口小时数（窗口起点 = 执行时刻 − hours） */
  hours: number;
}

export const PUBLISH_SCHEDULES: PublishSchedule[] = [
  { cron: '0 7 * * *', label: '早上 07:00（早报）', period: 'morning', hours: 12 },
  { cron: '0 19 * * *', label: '晚上 19:00（晚报）', period: 'evening', hours: 12 },
];

// ---------------------------------------------------------------------------
// 定时时段的**固定回看窗口**（2026-09-24 修缺陷 19）
// ---------------------------------------------------------------------------

/**
 * 北京时区固定 +8 小时（中国不实行夏令时，所以是个常量而不是规则表）。
 *
 * 为什么不用 `Intl`/`toLocaleString` 取「北京当前是几点」：那要构造格式化器、
 * 依赖 ICU 数据，还要再从字符串解析回来 —— 而这里需要的只是
 * 「把某个 UTC 时刻换算成北京墙上时间」，纯算术足够且可在测试里断言。
 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 取「北京墙上时间」的年月日 + 时 */
function beijingFields(d: Date) {
  const t = new Date(d.getTime() + BEIJING_OFFSET_MS);
  return {
    y: t.getUTCFullYear(),
    mo: t.getUTCMonth(),
    d: t.getUTCDate(),
    h: t.getUTCHours(),
  };
}

/** 由「北京墙上时间」构造真实时刻（`mi` 默认 0：时刻表都落在整点） */
function fromBeijing(y: number, mo: number, d: number, h: number): Date {
  return new Date(Date.UTC(y, mo, d, h) - BEIJING_OFFSET_MS);
}

/**
 * 从 cron 表达式里取出**小时**（`0 7 * * *` → 7）。
 *
 * ⚠️ **只接受 5 段式**，其他形态一律抛错，不做兼容：
 * 带秒的 6 段式里小时在**第三位**（`秒 分 时 日 月 周`），如果这里按「第二位」去读，
 * 会静默读出一个错的钟点 —— 而钟点直接决定推送窗口，错了就是漏稿或重复推送。
 * 本仓库的时刻表都是 5 段式；哪天要加 6 段式，让它在这里报错比默默算错好。
 */
export function cronHour(cron: string): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron 必须是 5 段式（分 时 日 月 周），收到 ${parts.length} 段：${JSON.stringify(cron)}`);
  }
  const h = Number(parts[1]);
  if (!/^\d{1,2}$/.test(parts[1]) || !Number.isInteger(h) || h < 0 || h > 23) {
    throw new Error(`cron 里的小时字段不合法：${JSON.stringify(parts[1])}（来自 ${JSON.stringify(cron)}）`);
  }
  return h;
}

/** 某个 period 在时刻表里排的位置（取它的**上一段**要用到）。 */
function scheduleIndex(period: string): number {
  return PUBLISH_SCHEDULES.findIndex((s) => s.period === period);
}

/**
 * 定时时段（早报 / 晚报）的**固定**回看窗口。
 *
 * ## 为什么必须固定，不能是 `now - hours`
 *
 * 原来的起点算的是「执行时刻 − hours」。定时那一轮**准时**时两者重合，
 * 但只要这一轮迟到（抓取被 429 拖到 2–3 小时是常态），窗口就跟着整体后移：
 *
 *   2026-09-24 早报：抓取跑了 185 分钟，推送迟到 150 分钟 ⇒ 窗口从设计的
 *   `[昨日19:00, 今日08:00]` 滑成 `[昨日21:30, 今日10:30]`。
 *   后果有两层：① `[昨日19:00, 21:30]` 那一段**永久漏掉**（当期没人覆盖、
 *   下一期也不是它）；② 窗口里只剩「刚刚跑完那一轮」的稿子，与当晚晚报**重叠**。
 *   当天晚报又踩了同一个坑（见 `AGENTS.md` H 节缺陷 19）。
 *
 * 固定窗口把这两件事一起解决，而且它**本来就是设计意图** ——
 * 文档里一直写的是「早报 `[昨日19:00, 今日07:00]`、晚报 `[今日07:00, 今日19:00]`」，
 * 只有实现是浮动的。
 *
 * ## 边界由**时刻表本身**推导，不由手写的 `hours` 决定
 *
 * 每一段的起点 = **上一段**的钟点，终点 = 本段的钟点。这样「两段首尾相接」
 * 是结构性质，不再依赖「改 cron 时记得同步改 hours」这条口头纪律
 * （那条纪律已经因为「只改一处」栽过；现在 `hours` 退化为一个**交叉校验值**，
 * `test:publish-window` 会断言它与推导值一致，改歪了立刻红）。
 *
 * ## 迟到时会发生什么（这是刻意的，不是遗漏）
 *
 * 晚报迟到到 21:30 才跑，窗口**仍是** `[今日07:00, 今日19:00]` ——
 * 晚于 19:00 发的稿子不会被这一轮推到，它们属于**次日早报**的窗口
 * `[今日19:00, 明日07:00]`。换句话说：固定的两段合起来仍然覆盖完整的一天，
 * 代价是「深夜稿子次日早上才推」而不是「窗口跟着漂、把已推过的再推一遍」。
 * 这个取舍是有意的 —— 重复推送是读者能看见的错，而窗口漂移带来的漏稿
 * 从来没人能发现（两者在本项目都发生过）。
 *
 * `period` 不是定时时段（`manual` / 空）时返回 `null`，调用方按原来的
 * 「执行时刻 − hours」处理。
 */
export function scheduledWindow(
  period: unknown,
  now: Date = new Date(),
): { start: Date; end: Date; hours: number; label: string; source: 'schedule' } | null {
  if (period !== 'morning' && period !== 'evening') return null;
  const idx = scheduleIndex(period);
  if (idx < 0) return null;

  const self = PUBLISH_SCHEDULES[idx];
  const selfHour = cronHour(self.cron);
  // 上一段：排在前面那个；早报的上一段是**前一天的晚报**（所以下面对 19 > 7 的情况回退一天）
  const prevHour = cronHour(PUBLISH_SCHEDULES[(idx - 1 + PUBLISH_SCHEDULES.length) % PUBLISH_SCHEDULES.length].cron);

  const { y, mo, d } = beijingFields(now);
  const end = fromBeijing(y, mo, d, selfHour);
  // prevHour >= selfHour ⇒ 上一段落在**前一天**（早报 07:00 的上一段是昨日 19:00）
  const start =
    prevHour < selfHour ? fromBeijing(y, mo, d, prevHour) : fromBeijing(y, mo, d - 1, prevHour);

  return {
    start,
    end,
    hours: (end.getTime() - start.getTime()) / 3_600_000,
    label: self.label,
    source: 'schedule',
  };
}

/** 只给「指纹 / 测试」用：把每段的 `hours` 声明值与从 cron 推导值并排报出来。 */
export function scheduleHoursCrossCheck(): Array<{
  period: string;
  declared: number;
  derived: number;
  ok: boolean;
}> {
  return PUBLISH_SCHEDULES.map((s) => {
    const w = scheduledWindow(s.period);
    const derived = w ? w.hours : Number.NaN;
    return { period: s.period, declared: s.hours, derived, ok: s.hours === derived };
  });
}
