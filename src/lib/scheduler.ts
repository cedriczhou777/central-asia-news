import cron from 'node-cron';
import { resolveSelfBaseUrl } from './runtime';

// 北京时间定时任务
// 用户需求：取消网页端后，每天仅推送 2 次 —— 早上 08:00、晚上 19:00，整理当天新闻推送公众号
const PUBLISH_SCHEDULES = [
  { cron: '0 8 * * *', label: '早上 08:00' },
  { cron: '0 19 * * *', label: '晚上 19:00' },
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

// 微信公众号推送（汇总过去 24h 新闻，按"今日精选投资资讯"逐国推送，不写死篇数）
async function runWechatPush() {
  console.log(`[${new Date().toISOString()}] 开始执行微信公众号推送任务...`);

  try {
    const response = await fetch(`${API_BASE}/api/wechat/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hours: 24,
      }),
    });

    const result = await response.json();
    console.log(`[${new Date().toISOString()}] 微信公众号推送任务完成:`, JSON.stringify(result));
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 微信公众号推送任务失败:`, error);
  }
}

// 每次推送：先抓最新新闻，再整理推送公众号
async function runPublishCycle() {
  await runFetchNews();
  await runWechatPush();
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

  PUBLISH_SCHEDULES.forEach(({ cron: schedule, label }) => {
    cron.schedule(schedule, () => {
      console.log(`[${new Date().toISOString()}] 触发公众号推送任务 (${label})`);
      runPublishCycle();
    }, {
      timezone: 'Asia/Shanghai',
    });
    console.log(`已注册公众号推送任务：${schedule} (${label})`);
  });

  console.log(`共注册 ${PUBLISH_SCHEDULES.length} 个定时任务`);
}