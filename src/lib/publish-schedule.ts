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
 * ## ⚠️ 触发时刻与回看窗口是**绑在一起**的：改一个必须改另一个
 *
 * 窗口起点算的是 `now - hours`（在 `api/wechat/push/route.ts` 里），
 * 与触发时刻是浮动关系。所以：
 *
 * | 改动 | 必须同步做 | 否则 |
 * |---|---|---|
 * | 早报时刻前移 1 小时 | 早报 `hours` **减** 1 | 起点滑到昨日 18:00，与前一晚晚报**重叠 1 小时**（重复推送）|
 * | 早报时刻后移 1 小时 | 早报 `hours` **加** 1 | 与前一晚晚报之间出现**空档**，那段新闻永久漏掉 |
 * | 早报时刻变了 | 晚报 `hours` **反向调 1**（保持两段相接）| 同上，重叠或空档二选一 |
 *
 * 现行的两段（2026-09-24 起）：早报 07:00 回看 12h → `[昨日19:00, 今日07:00]`；
 * 晚报 19:00 回看 12h → `[今日07:00, 今日19:00]`。首尾相接、合起来正好 24 小时。
 *
 * **为什么这条要反复强调**：只改 cron 不改 hours，两种错法**都要过几天才被发现** ——
 * 重叠靠读者投诉「这条早上推过了」，漏掉则**永远没人知道**。
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
