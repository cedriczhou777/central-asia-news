import cron from 'node-cron';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// 北京时间定时任务
// 08:00, 12:30, 15:00, 22:00
const SCHEDULES = [
  '0 8 * * *',    // 北京时间 08:00
  '30 12 * * *',  // 北京时间 12:30
  '0 15 * * *',   // 北京时间 15:00
  '0 22 * * *',   // 北京时间 22:00
];

async function runPipeline() {
  console.log(`[${new Date().toISOString()}] 开始执行定时新闻抓取任务...`);
  
  try {
    // 调用本地 pipeline API
    const response = await fetch('http://localhost:5000/api/pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ push: true }),
    });
    
    const result = await response.json();
    console.log(`[${new Date().toISOString()}] 任务执行完成:`, JSON.stringify(result));
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 任务执行失败:`, error);
  }
}

export function startScheduler() {
  console.log('启动定时任务调度器...');
  
  SCHEDULES.forEach((schedule, index) => {
    cron.schedule(schedule, () => {
      console.log(`[${new Date().toISOString()}] 触发定时任务 #${index + 1} (${schedule})`);
      runPipeline();
    }, {
      timezone: 'Asia/Shanghai',
    });
    console.log(`已注册定时任务 #${index + 1}: ${schedule} (北京时间)`);
  });
  
  console.log(`共注册 ${SCHEDULES.length} 个定时任务`);
}
