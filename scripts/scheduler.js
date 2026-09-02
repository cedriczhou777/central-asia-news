#!/usr/bin/env node
/**
 * 每日新闻定时采集调度器
 * 北京时间 (UTC+8): 08:00, 12:30, 15:00, 21:00
 */

const cron = require('node-cron');
const { execSync } = require('child_process');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..');
const SCRIPT = path.join(PROJECT_DIR, 'scripts', 'daily-fetch.sh');

// 北京时间 = UTC+8
// 08:00 CST = 00:00 UTC
// 12:30 CST = 04:30 UTC
// 15:00 CST = 07:00 UTC
// 21:00 CST = 13:00 UTC

const schedule = [
  { time: '0 0 * * *', label: '08:00 CST' },
  { time: '30 4 * * *', label: '12:30 CST' },
  { time: '0 7 * * *', label: '15:00 CST' },
  { time: '0 13 * * *', label: '21:00 CST' },
];

console.log('[Scheduler] Starting daily news fetch scheduler');
console.log('[Scheduler] Timezone: Beijing Time (UTC+8)');
console.log('[Scheduler] Schedule:');
schedule.forEach(s => console.log(`  - ${s.label} (UTC: ${s.time})`));

schedule.forEach(({ time, label }) => {
  cron.schedule(time, () => {
    const now = new Date().toISOString();
    console.log(`\n[${now}] Running scheduled fetch (${label})`);
    try {
      const result = execSync(`${SCRIPT} 10 true`, {
        cwd: PROJECT_DIR,
        timeout: 300000, // 5 minutes timeout
        encoding: 'utf-8',
      });
      console.log(`[${now}] Fetch completed successfully`);
      console.log(result);
    } catch (error) {
      console.error(`[${now}] Fetch failed:`, error.message);
      if (error.stdout) console.log('stdout:', error.stdout);
      if (error.stderr) console.error('stderr:', error.stderr);
    }
  }, {
    timezone: 'Asia/Shanghai',
  });
});

console.log('[Scheduler] Scheduler started. Waiting for scheduled tasks...');

// Keep the process running
process.on('SIGINT', () => {
  console.log('\n[Scheduler] Shutting down...');
  process.exit(0);
});
