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
 * ## 现行的唯一一段（2026-10-10 起：原早晚报合并成日报）
 *
 * 日报 04:00 → `[昨日04:00, 今日04:00]`，正好 24 小时。
 * 一天只有一段，所以**「两段必须首尾相接」这件事不存在了**。
 *
 * ⚠️ 为什么起跑定在 **04:00**（而不是合并前的 07:00）：合并后单轮翻倍、硬上限放宽到
 * 400 分钟，所以起跑必须提前，否则最坏情况要拖到下午。见 `PUBLISH_SCHEDULES` 的注释。
 *
 * 📌 **起跑时刻挪动既不加钱也不省钱，只挪时间线。** 一段永远覆盖完整 24 小时，
 * 而实例存活时长是「预热 → 抓完 → 推送」这段，两头跟着一起挪 ——
 * 所以选时刻只有一个判据：**你希望草稿几点躺在草稿箱里**。
 * 04:00 起跑 ⇒ 典型情况约 06:35 出稿，最坏约 10:50。
 *
 * ### 为什么合并（这是刻意的简化，但账要算对）
 *
 * 两段设计的复杂度不在「多推一次」，而在**两段之间的衔接**这条不变量：
 * 改一个时段就得同步改另一段（`hours` 与 cron 双向绑定），历史上违反过两次
 * ——2026-09-19 重复推送、2026-09-24 早晚各空跑一轮。
 * 只剩一段时，`scheduledWindow` 的「起点 = 上一段的钟点」自动退化成
 * 「起点 = 自己前一天的钟点」，结构上就没有衔接这回事了。
 *
 * ⚠️ **但省的钱不是一半**。每轮窗口 = 冷启动余量 + 采集 + **翻译** + 推送；
 * 占大头的翻译时长由「当日产量」决定，**不随轮数变化** ⇒ 合并只省掉
 * 「一轮的固定开销（冷启动 + 采集 + 推送 ≈ 28 分钟/天）」。实测口径下
 * 约省 25% 的实例成本。真正的省钱杠杆是「让每轮更快」和「别让实例 24h 常驻」。
 *
 * ⚠️ 代价有两个，都记在这儿免得日后当成新 bug：
 *   1. 单轮候选量翻倍（约 270 → 约 540）⇒ `FETCH_HARD_WAIT_MS` 必须
 *      跟着放宽（240 → 400 分钟），否则单篇耗时一退化（实测有 37 秒/篇）
 *      就撞穿上限、那一轮直接不推送 = **丢一整天**（原来只丢 12 小时）。
 *   2. 晚报那 12 小时的内容现在要晚一天才到读者手里（时效性取舍，产品决策）。
 *
 * ⚠️ 还有一处跟它配套、不在本文件里：
 * `container.config.json` 的 `triggers`（`warmup-daily-head` / `-core` / `-tail`）——
 * 实例被缩容到零时靠它们提前唤醒并全程保活，时刻也要跟着改（文件里是 UTC）。
 */
export interface PublishSchedule {
  /** node-cron 表达式，按 `Asia/Shanghai` 解释（`startScheduler` 里显式传了时区） */
  cron: string;
  /** 日志里显示用的中文标签 */
  label: string;
  /**
   * 传给 `POST /api/wechat/push` 的时段标记，只影响草稿标题的后缀。
   *
   * 2026-10-10 起只有一个 `'daily'`（合并前的 `'morning'` / `'evening'` 已取消）。
   * 这里刻意**不用字符串**而是联合类型：`scheduledWindow` 现在靠「period 在不在表里」
   * 判定，类型收紧后「写了个不在表里的 period」在编译期就会红，不必等运行时。
   */
  period: 'daily';
  /**
   * 回看窗口小时数 —— ⚠️ **只是交叉校验值，不是窗口来源**。
   *
   * 窗口由 {@link scheduledWindow} 从本表的 `cron` 钟点推导；这里写 24 是为了让
   * 「表里声明的长度」和「实际推导出的长度」能被 `scheduleHoursCrossCheck()` 比出来，
   * 谁只改了一处就会红。**别再按「起点 = 执行时刻 − hours」理解它** ——
   * 那个浮动算法正是缺陷 19（2026-09-24 两次空跑）的成因，只留给人工补跑用。
   */
  hours: number;
}

export const PUBLISH_SCHEDULES: PublishSchedule[] = [
  // 只有一段。`hours: 24` 是**交叉校验值**，不是窗口来源 —— 窗口由下面
  // `scheduledWindow` 从 cron 钟点推导（唯一一段 ⇒ 起点自动落到前一天同一钟点）。
  //
  // ⚠️ **为什么是 04:00 而不是原来的 07:00**（2026-10-10 与合并同批改的）：
  // 合并后单轮候选翻倍，硬上限放宽到 400 分钟，而**推送必须等抓取真跑完**。
  //   07:00 起跑：典型 144 分钟 ⇒ 09:24 抓完 ⇒ 草稿 ~09:35；最坏 400 分钟 ⇒ 13:50。
  //   04:00 起跑：典型 144 分钟 ⇒ 06:24 抓完 ⇒ **草稿 ~06:35**；最坏 400 分钟 ⇒ 10:50。
  // ⇒ 起跑提前 3 小时，把「典型情况下的送达时刻」从九点多拉回**早上六点半**，
  //   同时给最坏情况留出「上午就结束」的余量。
  //
  // 📌 起点从 05:00 再前移到 04:00（用户 2026-10-10 定的）：成本不变（见文件头
  // 「起跑时刻挪动既不加钱也不省钱」），只是把送达时刻再提前 1 小时。
  //
  // ⚠️ 配套改动（改这个钟点必须一起改，否则预热赶不上、或窗口白开）：
  //   - `container.config.json` 的 `triggers`（`warmup-daily-head` / `-core` / `-tail`
  //     三条：03:45 唤醒 + 04:00–11:15 每 15 分钟保活）
  //   - 控制台的**定时扩缩容**窗口（要覆盖 03:45 → 抓完 + 推送，即约 03:45–11:15）
  //
  // ⚠️⚠️ **为什么预热必须留足 ≥15 分钟**：`node-cron` 是在**容器启动时**注册的，
  // 而 `0 4 * * *` 只在 **04:00:00 那一秒**触发。容器若在 04:00:30 才起来，
  // 这一天的任务**整个被跳过**（不是迟到，是不跑）。合并成日报后跳过 = **一整天没有草稿**，
  // 所以预热时刻宁早勿晚，别贴着 04:00 写。
  { cron: '0 4 * * *', label: '凌晨 04:00（日报）', period: 'daily', hours: 24 },
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

/** 由「北京墙上时间」构造真实时刻（时刻表的钟点都落在整点，所以没有分钟参数） */
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
 * 定时时段的**固定**回看窗口。
 *
 * 只有一段定时时段时，它等于「**昨日同一钟点 → 今日同一钟点**」＝ 24 小时 ——
 * 但这不是特例分支，是下面那条通用规则的自然退化结果（见「边界由时刻表推导」）。
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
 * ## 边界由**时刻表本身**推导，不由手写的 `hours` 决定
 *
 * 每一段的起点 = **上一段**的钟点，终点 = 本段的钟点。
 *
 * ⚠️ **只剩一段时这条规则会自然退化**：`(idx - 1 + 1) % 1 === 0` 就是它自己，
 * 于是 `prevHour === selfHour` ⇒ 走「前一天」分支 ⇒ `[昨日04:00, 今日04:00]`。
 * 也就是说「2026-10-10 合并成一段」**不需要改这里的算法** ——
 * 算法本来就是写成环形的。合并后 `hours` 从 12 变 24 只是交叉校验值跟上。
 *
 * ## `period` 的判定**从表里推导**，不再手写白名单
 *
 * 旧版第一行是 `if (period !== 'morning' && period !== 'evening') return null;` ——
 * 一份与表并排维护的手写白名单：**改了表却忘了改它**会静默返回 `null`，
 * 调用方就退回「执行时刻 − hours」的浮动窗口，退化成缺陷 19 那个形态，
 * 而且不报错、不报警。现在直接看 `scheduleIndex()`：
 * 在表里 ⇒ 返回固定窗口；不在表里 ⇒ `null`（「手动补报」`manual` 走这条，
 * 它要的就是「从现在往回数 N 小时」，不能套固定钟点）。
 */
export function scheduledWindow(
  period: unknown,
  now: Date = new Date(),
): { start: Date; end: Date; hours: number; label: string; source: 'schedule' } | null {
  if (typeof period !== 'string') return null;
  const idx = scheduleIndex(period);
  if (idx < 0) return null;

  const self = PUBLISH_SCHEDULES[idx];
  const selfHour = cronHour(self.cron);
  // 「上一段」= 排在前面那个，环形取模。只剩一段时取到的就是**它自己**
  // （`(0 - 1 + 1) % 1 === 0`），于是下面 prevHour === selfHour，落进「前一天」分支。
  const prevHour = cronHour(PUBLISH_SCHEDULES[(idx - 1 + PUBLISH_SCHEDULES.length) % PUBLISH_SCHEDULES.length].cron);

  const { y, mo, d } = beijingFields(now);
  const end = fromBeijing(y, mo, d, selfHour);
  // prevHour >= selfHour ⇒ 上一段落在**前一天**。
  // 只剩一段时 prevHour === selfHour 也走这里 ⇒ 正好 24 小时，这是想要的。
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
