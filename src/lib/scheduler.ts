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
//   POST /api/wechat/push  {"hours": 24, "period": "manual"}
// 它不走增量窗口，按指定小时数汇总；period=manual 让标题带「补报」后缀，
// 从而与当天自动跑的早报/晚报区分开（不传 period 会和上一次人工补跑同名 → 草稿箱出现同名草稿）。
//
// ⚠️ 推送接口是**异步**的（和抓取一样）：POST 只代表任务已启动，立刻返回 200。
// 结果要 GET 同一个地址、读 lastRun（summary.drafts 是建成功的草稿，
// summary.failures 是失败的国家和原因）。
// 直接对着公网域名 curl 会拿到 HTTP 504 —— 网关 65 秒就切断，
// 而一轮推送（逐张下载外链图 → 转码 → 传素材库）远不止 65 秒。
// 那只是响应送不回来，请求在服务端照样跑完；想知道结果就轮询 lastRun。
// 应用内调度器走 localhost，不经过网关，没有这个问题。
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
// 轮询间隔，抓取与推送共用 —— 两者都是「触发后要等一会儿」的后台任务。
const POLL_INTERVAL_MS = 15_000;
// 等待上限。这个值**必须显著高于实测抓取耗时**，否则推送会在库还空着的时候就跑，
// 结果就是草稿箱一篇都没有（2026-09-19 晚就栽在这上面，整晚 5 国全零）。
//
// 耗时构成（2026-09-20 凌晨实测）：
//   - 纯采集阶段（26 个 RSS + 12 个 Telegram，干跑、不翻译不取图）= 156 秒
//   - 翻译：顺序执行、一次一篇，约 166 篇 × 15 秒 ≈ 41 分钟
//   - 逐篇取 og:image 封面 ≈ 4 分钟
// 合计 ~50 分钟。旧上限 60 分钟余量太薄（源一多就超），所以给到 100 分钟。
// 代价只是「草稿出现得晚一点」（08:00 → 最晚 09:40），比推不出去好得多。
const FETCH_WAIT_TIMEOUT_MS = 100 * 60_000;
// 推送比抓取快，但它要做「逐篇下载外链图 → 转码 → 传微信素材库 → 建草稿」，
// 5 个国家串行，留 20 分钟足够宽松。
const PUSH_WAIT_TIMEOUT_MS = 20 * 60_000;

// 两个接口的 GET 都返回同样形状的 lastRun，这里只声明调度器真正用到的字段。
interface RunStateLite {
  running?: boolean;
  startedAt?: string | null;
  finishedAt?: string | null;
  summary?: unknown;
  error?: string | null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 读一次任务状态。
 *
 * ⚠️ 这里曾经有一个**静默了整整两天**的 bug，改动之前先看懂它：
 * `GET /api/fetch-news` 和 `GET /api/wechat/push` 返回的不是 lastRun 本身，
 * 而是一个信封：`{ message, usage, dryRunHint, sources, lastRun }`。
 * 旧代码直接 `return await res.json()`，于是 `state.running` / `state.finishedAt`
 * **永远是 undefined** —— 轮询循环里的完成判据
 * `!state.running && finishedNow && finishedNow !== finishedBefore` 永远为假。
 *
 * 后果不是报错，而是「每一轮都干等到超时上限」：
 *   抓取等待固定 100 分钟、推送等待固定 20 分钟、流水线每一步固定 60 分钟。
 * 表现：19:00 触发的那一轮，到 20:19（79 分钟后）还停在抓取等待里，
 * **推送那一步根本没开始** —— 用户看到的就是「到点了草稿箱还是空的」。
 * 抓取其实早就跑完了（19:00→20:13），只是没人往下走。
 *
 * 所以：必须取 body.lastRun。留一个兜底 —— 若将来某个接口直接返回状态本身，
 * 也不会又退化成「永远拿不到状态」。
 */
async function readRunState(path: string): Promise<RunStateLite | null> {
  try {
    // 带 cb 破坏缓存：状态查询必须每次都拿到最新值，被任何一层缓存住就等于没等。
    const res = await fetch(`${API_BASE}${path}?cb=${Date.now()}`, { cache: 'no-store' });
    const body = await res.json() as { lastRun?: RunStateLite | null };
    // 有 lastRun 这个键 → 取它；lastRun 为 null 表示「还没跑过」，给个空对象
    // （running/finishedAt 都是 undefined/null，循环会继续等，正是想要的）。
    if (body && typeof body === 'object' && 'lastRun' in body) {
      return body.lastRun ?? {};
    }
    // 兜底：万一某个接口直接返回状态本身（没有信封），也照样能用。
    return (body as unknown as RunStateLite) ?? null;
  } catch (error) {
    console.log(`[${new Date().toISOString()}] 读取 ${path} 状态失败（忽略，继续等）:`, error);
    return null;
  }
}

// 「触发 → 轮询到跑完」的通用流程，抓取与推送共用。
//
// 为什么必须等：这两个接口都是「立即返回、后台跑完」的 —— POST 返回 200 只代表
// 任务已启动，真正的工作还在后台。旧调度器写的是
//   await runFetchNews(); await runWechatPush();
// 看着是串行，实际推送在抓取刚起步时就执行了，读到的永远是上一轮的旧数据，
// 早报会把前一晚已经推过的新闻再推一遍。
//
// 判据必须是「running === false 且 finishedAt 与触发前不同」：
// 只判 running === false 会立刻命中上一轮留下的终态，等于没等。
//
// 另有一条哨兵日志（每 8 轮 ≈ 2 分钟打一次）：把「当前观测到的状态」和
// 「已等了多久」写进日志。旧版整段等待期间一行都不打，于是「状态读错了 →
// 一直等到超时」这件事在日志里表现为「触发之后就没了」，只能靠事后猜。
// 现在拿不到 running / finishedAt 会直接打 `running=undefined`，一眼可见。
async function triggerAndWait(
  label: string,
  path: string,
  timeoutMs: number,
  trigger: () => Promise<void>,
) {
  const before = await readRunState(path);
  const finishedBefore = before?.finishedAt ?? null;

  try {
    await trigger();
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ${label}触发失败:`, error);
    return;
  }

  const startedWaitingAt = Date.now();
  const deadline = startedWaitingAt + timeoutMs;
  let polls = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const state = await readRunState(path);
    if (!state) continue;

    polls += 1;
    const finishedNow = state.finishedAt ?? null;

    // 哨兵：拿不到布尔/时间戳说明状态读错了（信封没拆），必须能在日志里看见。
    if (polls % 8 === 0) {
      console.log(
        `[${new Date().toISOString()}] 仍在等待${label}` +
        `（已等 ${Math.round((Date.now() - startedWaitingAt) / 60_000)} 分钟）:` +
        ` running=${state.running} startedAt=${state.startedAt ?? null} finishedAt=${finishedNow}`
      );
    }

    if (!state.running && finishedNow && finishedNow !== finishedBefore) {
      // summary 是各源采集量与最终入库数，或本轮建的草稿与失败国家；失败时这里是 error
      console.log(
        `[${new Date().toISOString()}] ${label}完成（等了 ${Math.round((Date.now() - startedWaitingAt) / 60_000)} 分钟）:`,
        JSON.stringify(state.summary ?? state.error ?? state)
      );
      return;
    }
  }

  // 超时也继续往下走：宁可推稍旧的数据 / 少一条日志，也不要整轮什么都不做。
  // 但打 warn，方便从日志看出「这轮是超时后硬走的」。
  console.warn(
    `[${new Date().toISOString()}] 等待${label}超过 ${timeoutMs / 60_000} 分钟仍未结束，不再等待` +
    `（最后一轮观测：running=${(await readRunState(path))?.running}）`
  );
}

// 抓取当天新闻（每国先凑足一个下限量，具体推送篇数由推送端"今日精选"决定）
async function runFetchNews() {
  await triggerAndWait('新闻抓取', '/api/fetch-news', FETCH_WAIT_TIMEOUT_MS, async () => {
    console.log(`[${new Date().toISOString()}] 开始抓取当天新闻...`);
    const response = await fetch(`${API_BASE}/api/fetch-news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        minPerCountry: 10,
        skipTranslation: false,
      }),
    });
    console.log(
      `[${new Date().toISOString()}] 新闻抓取已触发:`,
      JSON.stringify(await response.json())
    );
  });
}

// 微信公众号推送（按固定时段汇总新闻，逐国推送，不写死篇数）
// hours 由定时表给出：早报 13h、晚报 11h，两段首尾相接不重叠。
// period 只影响草稿标题里的「早报 / 晚报」标记，让同一天的两份草稿能区分开。
//
// 推送接口和抓取一样是异步的（原因见 push/route.ts 顶部的注释：手动调公网域名
// 会被网关 65 秒切断）。调度器走 localhost 本来就不受那个限制，
// 但同样要等到终态，日志里才会留下「本轮建了哪几个草稿 / 哪几个国家失败」这行 ——
// 排查「今天怎么没推」全靠它。
async function runWechatPush(hours: number, period: string) {
  await triggerAndWait('微信公众号推送', '/api/wechat/push', PUSH_WAIT_TIMEOUT_MS, async () => {
    console.log(
      `[${new Date().toISOString()}] 开始执行微信公众号推送任务（时段 ${period}，回看过去 ${hours} 小时）...`
    );
    const response = await fetch(`${API_BASE}/api/wechat/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hours, period }),
    });
    console.log(
      `[${new Date().toISOString()}] 微信公众号推送任务已触发:`,
      JSON.stringify(await response.json())
    );
  });
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
      // cron 回调没人 await，必须在这里兜住异常，否则会变成 unhandled rejection
      runPublishCycle(hours, period).catch((err) => {
        console.error(`[${new Date().toISOString()}] 本轮「抓取 + 推送」异常:`, err);
      });
    }, {
      timezone: 'Asia/Shanghai',
    });
    console.log(`已注册公众号推送任务：${schedule} (${label})，回看 ${hours} 小时`);
  });

  console.log(`共注册 ${PUBLISH_SCHEDULES.length} 个定时任务`);
}