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
//
// ⚠️ 这个接口是「立即返回、后台跑完」的（见 fetch-news 里的说明），所以**不能**
// 发完 POST 就当抓取结束了。旧版就是这么写的，于是
// `await runFetchNews(); await runWechatPush();` 看着是串行，实际推送在抓取刚起步时
// 就执行了，读到的永远是上一轮的旧数据 —— 早报会把前一晚推过的新闻再推一遍。
// 现在改成「触发 → 轮询 GET 到 running=false 且 finishedAt 变新 → 才让推送开始」。
//
// 等待上限 25 分钟：2026-09-18 实测一轮抓取要十几分钟（触发后 9 分钟内库里一篇没多，
// 之后才陆续入库）。超时也会继续推送 —— 宁可推稍旧的数据，也不要整轮什么都不做，
// 但会打 warn，方便从日志看出「这轮是超时后硬推的」。
const FETCH_POLL_INTERVAL_MS = 15_000;
const FETCH_WAIT_TIMEOUT_MS = 25 * 60_000;

interface FetchRunStateLite {
  running?: boolean;
  finishedAt?: string | null;
  summary?: unknown;
  error?: string | null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 读一次抓取状态。失败返回 null，由调用方决定忽略还是继续等。
async function readFetchState(): Promise<FetchRunStateLite | null> {
  try {
    const res = await fetch(`${API_BASE}/api/fetch-news`, { cache: 'no-store' });
    return await res.json() as FetchRunStateLite;
  } catch (error) {
    console.log(`[${new Date().toISOString()}] 读取抓取状态失败（忽略，继续等）:`, error);
    return null;
  }
}

async function runFetchNews() {
  console.log(`[${new Date().toISOString()}] 开始抓取当天新闻...`);

  // 先记下「此刻」的 finishedAt，用它区分「等到的完成」是新一轮还是上一轮的残留状态。
  // 取不到（GET 失败）时为 null，下面的判断同样成立。
  const before = await readFetchState();
  const finishedBefore = before?.finishedAt ?? null;

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
    console.log(`[${new Date().toISOString()}] 新闻抓取已触发:`, JSON.stringify(result));

    const deadline = Date.now() + FETCH_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(FETCH_POLL_INTERVAL_MS);
      const state = await readFetchState();
      if (!state) continue;

      const finishedNow = state.finishedAt ?? null;
      if (!state.running && finishedNow && finishedNow !== finishedBefore) {
        // summary 是各源采集量与最终入库数；失败时这里是 error 字符串
        console.log(
          `[${new Date().toISOString()}] 新闻抓取完成:`,
          JSON.stringify(state.summary ?? state.error ?? state)
        );
        return;
      }
    }

    console.warn(
      `[${new Date().toISOString()}] 等待抓取超过 ${FETCH_WAIT_TIMEOUT_MS / 60_000} 分钟仍未结束，` +
        `不再等待、直接开始推送（本轮可能用的是上一轮的数据）`
    );
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