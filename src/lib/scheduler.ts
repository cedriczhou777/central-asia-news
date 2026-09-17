import cron from 'node-cron';
import { resolveSelfBaseUrl } from './runtime';

// 北京时间定时任务
// 用户需求：取消网页端后，每天推送 2 次 —— 早上 08:00（早报）、晚上 19:00（晚报）。
//
// 回看窗口怎么切（改动的原因）：
// 旧版两次都用「过去 24 小时」，两段窗口中间有 13 小时重叠，结果是
//   1) 同一条新闻连着进两次推送；
//   2) 草稿标题里的日期取的是 UTC 日期，北京 08:00 和 19:00 落在同一个 UTC 日，
//      两次生成的 5 国草稿标题完全相同，草稿箱里成对出现。
// 现在改成首尾相接、互不重叠的两段：
//   早报 08:00 → 回看 13 小时（昨日 19:00 → 今日 08:00）
//   晚报 19:00 → 回看 11 小时（今日 08:00 → 今日 19:00）
// 加起来正好覆盖完整的一天，既不重复也不漏。
//
// 代价（知情选择）：某一时段整体失败（例如容器没被预热唤醒）时，这一段窗口的新闻
// 不会被下一次推送自动补上。人工补齐的办法是手动调一次
//   POST /api/wechat/push  {"hours": 24}
// 它不传 period，不走增量窗口，按老口径汇总过去 24 小时。
const PUBLISH_SCHEDULES = [
  { cron: '0 8 * * *', label: '早上 08:00（早报）', period: 'morning', hours: 13 },
  { cron: '0 19 * * *', label: '晚上 19:00（晚报）', period: 'evening', hours: 11 },
];

// 内部接口互调的地址。端口口径统一由 lib/runtime 决定，避免多处写死不一致。
const API_BASE = resolveSelfBaseUrl();

// 抓取当天新闻（每国先凑足一个下限量，具体推送篇数由推送端"今日精选"决定）
async function runFetchNews() {
  console.log(`[${new Date().toISOString()}] 开始抓取当天新闻...`);

  try {
    const response = await fetch(`${API_BASE}/api/fetch-news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        minPerCountry: 10,
        skipTranslation: false,
      }),
    });

    const result = await response.json();
    console.log(`[${new Date().toISOString()}] 新闻抓取完成:`, JSON.stringify(result));
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 新闻抓取失败:`, error);
  }
}

// 微信公众号推送（按固定时段汇总新闻，逐国推送，不写死篇数）
// hours 由定时表给出：早报 13h、晚报 11h，两段首尾相接不重叠。
// period 只影响草稿标题里的「早报 / 晚报」标记，让同一天的两份草稿能区分开。
async function runWechatPush(hours: number, period: string) {
  console.log(`[${new Date().toISOString()}] 开始执行微信公众号推送任务（时段 ${period}，回看过去 ${hours} 小时）...`);

  try {
    const response = await fetch(`${API_BASE}/api/wechat/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hours,
        period,
      }),
    });

    const result = await response.json();
    console.log(`[${new Date().toISOString()}] 微信公众号推送任务完成:`, JSON.stringify(result));
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 微信公众号推送任务失败:`, error);
  }
}

// 每次推送：先抓最新新闻，再按本时段窗口整理推送公众号
async function runPublishCycle(hours: number, period: string) {
  await runFetchNews();
  await runWechatPush(hours, period);
}

// 幂等锁：定时任务只允许注册一次。
// 重复注册会让到点同时跑多轮「抓取 + 推送」，公众号草稿箱里出现重复草稿，
// 而且日志里两轮输出交织在一起，很难判断到底跑了几次。
// 目前 startScheduler 只有 src/server.ts 一个调用点，这里加锁是为了让将来
// 任何「多调用一次」的改动都不会退化成静默的重复推送。
let schedulerStarted = false;

export function startScheduler() {
  if (schedulerStarted) {
    console.warn('定时任务调度器已注册过，跳过重复注册（防止重复推送）');
    return;
  }
  schedulerStarted = true;

  console.log('启动定时任务调度器...');

  PUBLISH_SCHEDULES.forEach(({ cron: schedule, label, period, hours }) => {
    cron.schedule(schedule, () => {
      console.log(`[${new Date().toISOString()}] 触发公众号推送任务 (${label})`);
      runPublishCycle(hours, period);
    }, {
      timezone: 'Asia/Shanghai',
    });
    console.log(`已注册公众号推送任务：${schedule} (${label})，回看 ${hours} 小时`);
  });

  console.log(`共注册 ${PUBLISH_SCHEDULES.length} 个定时任务`);
}