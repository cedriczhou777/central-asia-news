import cron from 'node-cron';

// 北京时间定时任务
// 网页端抓取：08:00, 12:30, 15:00, 22:00
// 微信公众号推送：08:30（在网页端抓取完成后）
const WEB_FETCH_SCHEDULES = [
  '0 8 * * *',    // 北京时间 08:00
  '30 12 * * *',  // 北京时间 12:30
  '0 15 * * *',   // 北京时间 15:00
  '0 22 * * *',   // 北京时间 22:00
];

const WECHAT_PUSH_SCHEDULE = '30 8 * * *';  // 北京时间 08:30

// 服务端口：优先取环境变量（生产环境微信云托管注入的真实端口），fallback 到 5000
const API_PORT = process.env.PORT || process.env.NODE_PORT || '5000';
const API_BASE = `http://localhost:${API_PORT}`;

// 网页端新闻抓取
async function runWebFetch() {
  console.log(`[${new Date().toISOString()}] 开始执行网页端新闻抓取任务...`);
  
  try {
    // 调用 fetch-news API，每个国家至少 3 篇
    const response = await fetch(`${API_BASE}/api/fetch-news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        minPerCountry: 3,
        skipTranslation: false 
      }),
    });
    
    const result = await response.json();
    console.log(`[${new Date().toISOString()}] 网页端抓取任务完成:`, JSON.stringify(result));
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 网页端抓取任务失败:`, error);
  }
}

// 微信公众号推送（汇总过去 24h 新闻，每个国家精选 5 篇）
async function runWechatPush() {
  console.log(`[${new Date().toISOString()}] 开始执行微信公众号推送任务...`);
  
  try {
    // 调用 wechat/push API，按国别分组推送
    const response = await fetch(`${API_BASE}/api/wechat/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        hours: 24,  // 汇总过去 24 小时
        minPerCountry: 7  // 每个国家精选至少 7 篇
      }),
    });
    
    const result = await response.json();
    console.log(`[${new Date().toISOString()}] 微信公众号推送任务完成:`, JSON.stringify(result));
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 微信公众号推送任务失败:`, error);
  }
}

// 完整 Pipeline（抓取 + 翻译 + 入库 + 推送）
async function runFullPipeline() {
  console.log(`[${new Date().toISOString()}] 开始执行完整 Pipeline 任务...`);
  
  try {
    // 调用 pipeline API
    const response = await fetch('http://localhost:5000/api/pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        push: true,
        minPerCountry: 3
      }),
    });
    
    const result = await response.json();
    console.log(`[${new Date().toISOString()}] 完整 Pipeline 任务完成:`, JSON.stringify(result));
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 完整 Pipeline 任务失败:`, error);
  }
}

export function startScheduler() {
  console.log('启动定时任务调度器...');
  
  // 注册网页端抓取任务（4 个时间段）
  WEB_FETCH_SCHEDULES.forEach((schedule, index) => {
    cron.schedule(schedule, () => {
      console.log(`[${new Date().toISOString()}] 触发网页端抓取任务 #${index + 1} (${schedule})`);
      runWebFetch();
    }, {
      timezone: 'Asia/Shanghai',
    });
    console.log(`已注册网页端抓取任务 #${index + 1}: ${schedule} (北京时间)`);
  });
  
  // 注册微信公众号推送任务（每天 08:30）
  cron.schedule(WECHAT_PUSH_SCHEDULE, () => {
    console.log(`[${new Date().toISOString()}] 触发微信公众号推送任务 (${WECHAT_PUSH_SCHEDULE})`);
    runWechatPush();
  }, {
    timezone: 'Asia/Shanghai',
  });
  console.log(`已注册微信公众号推送任务：${WECHAT_PUSH_SCHEDULE} (北京时间)`);
  
  console.log(`共注册 ${WEB_FETCH_SCHEDULES.length + 1} 个定时任务`);
}
