import cron from 'node-cron';

// 北京时间定时任务
// 用户需求：取消网页端后，每天仅推送 2 次 —— 早上 08:00、晚上 19:00，整理当天新闻推送公众号
const PUBLISH_SCHEDULES = [
  { cron: '0 8 * * *', label: '早上 08:00' },
  { cron: '0 19 * * *', label: '晚上 19:00' },
];

// 服务端口：优先取环境变量（生产环境微信云托管注入的真实端口），fallback 到 5000
const API_PORT = process.env.PORT || process.env.NODE_PORT || '5000';
const API_BASE = `http://localhost:${API_PORT}`;

// 抓取当天新闻（每国 15 篇）
async function runFetchNews() {
  console.log(`[${new Date().toISOString()}] 开始抓取当天新闻...`);

  try {
    const response = await fetch(`${API_BASE}/api/fetch-news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        minPerCountry: 15,
        skipTranslation: false,
      }),
    });

    const result = await response.json();
    console.log(`[${new Date().toISOString()}] 新闻抓取完成:`, JSON.stringify(result));
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 新闻抓取失败:`, error);
  }
}

// 微信公众号推送（汇总过去 24h 新闻，每个国家精选 15 篇）
async function runWechatPush() {
  console.log(`[${new Date().toISOString()}] 开始执行微信公众号推送任务...`);

  try {
    const response = await fetch(`${API_BASE}/api/wechat/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hours: 24,
        minPerCountry: 15,
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

export function startScheduler() {
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