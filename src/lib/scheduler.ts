import cron from 'node-cron';
import { resolveSelfBaseUrl } from './runtime';
import { PUBLISH_SCHEDULES, scheduledWindow, scheduleHoursCrossCheck } from './publish-schedule';

// 北京时间定时任务
//
// ## 现行：每天一次（2026-10-10 起，原早报 + 晚报合并成日报）
//   日报 **04:00** → 回看 24 小时（昨日 04:00 → 今日 04:00）
//
// ⚠️ 04:00 不是随手定的，是**与合并同批**定的 —— 合并后单轮候选翻倍、
// 硬上限放宽到 400 分钟，起跑必须提前，否则「典型情况」的草稿要从早上六点半
// 滑到九点多。对照表写在 `publish-schedule.ts` 的 `PUBLISH_SCHEDULES` 上方。
//
// 合并的原因与代价，权威版本写在 `./publish-schedule.ts` 的头部注释里。
// 这里只留一句最容易被忘掉的：**单轮候选量翻倍（约 270 → 约 540）**，
// 所以下面 `FETCH_HARD_WAIT_MS` 必须跟着放宽，否则「单篇耗时一退化就丢一整天」。
//
// ## 历史（2026-09-24 ~ 2026-10-09：首尾相接的两段）
//   早报 07:00 → 12 小时（昨日 19:00 → 今日 07:00）
//   晚报 19:00 → 12 小时（今日 07:00 → 今日 19:00）
// 再早的旧版两轮都用「过去 24 小时」，中间 13 小时重叠 ⇒ 同一条新闻连着推两次，
// 而且草稿标题里的日期取的是 UTC 日、两次落在同一个 UTC 日 ⇒ 标题完全相同、草稿箱成对出现。
//
// ⚠️ 当年那条纪律「两段窗口绑在一起，改一个时段必须同步改两处 `hours`」**已随合并作废** ——
// 现在窗口由时刻表钟点推导，`hours` 只是交叉校验值（见 `publish-schedule.ts`）。
// 保留这段说明是因为仓库里大量注释还在引用它，别把「历史约束」当成「现行约束」。
//
// 时刻表本体与详细表格在 `./publish-schedule.ts`（纯数据，路由也要读它来报指纹）。
//
// 代价：某一时段整体失败（例如容器没被预热唤醒）时，这一段窗口的新闻
// 不会被下一次推送自动补上。人工补齐的办法是手动调一次
//   POST /api/wechat/push  {"hours": 24, "period": "manual"}
// 它不走增量窗口，按指定小时数汇总；period=manual 让标题带「补报」后缀，
// 从而与当天自动跑的早报/晚报区分开（不传 period 会和上一次人工补跑同名 → 草稿箱出现同名草稿）。
//
// 2026-09-27 起又多了一个「整轮不推送」的情形：抓取在**硬上限**内没跑完
// （见下面 FETCH_HARD_WAIT_MS 的注释）。此时补跑要**等抓取真跑完再发**，
// 否则补出来的还是同一份缺国家的稿子。
//
// ⚠️ 推送接口是**异步**的（和抓取一样）：POST 只代表任务已启动，立刻返回 200。
// 结果要 GET 同一个地址、读 lastRun（summary.drafts 是建成功的草稿，
// summary.failures 是失败的国家和原因）。
// 直接对着公网域名 curl 会拿到 HTTP 504 —— 网关 65 秒就切断，
// 而一轮推送（逐张下载外链图 → 转码 → 传素材库）远不止 65 秒。
// 那只是响应送不回来，请求在服务端照样跑完；想知道结果就轮询 lastRun。
// 应用内调度器走 localhost，不经过网关，没有这个问题。
// 时刻表本体（cron / label / period / hours）在 `./publish-schedule.ts`：
// 纯数据、无副作用，因为 `GET /api/wechat/push` 也要读它（报出来当线上指纹）。

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
// 耗时构成：
//   - 纯采集阶段（26 个 RSS + 12 个 Telegram，干跑、不翻译不取图）= 156 秒
//   - 翻译：**顺序执行、一次一篇**，是唯一的变动量 —— 按篇数线性增长
//   - 逐篇取 og:image 封面 ≈ 4 分钟
//
// 实测（2026-09-20）：一轮 268 篇 → 73 分钟；另一轮 89.5 分钟。
// 也就是说 **约 16 秒/篇**，而这个数字由「篇数 × 单篇耗时」决定，任一项变大都会顶穿上限：
//   - 篇数：400 篇的日子 ≈ 105 分钟
//   - 单篇耗时：智谱免费档在拥挤时段单次要 17–25 秒（实测，见 /api/translate-check），
//     这时即使篇数不变也会明显变慢
// 所以 100 分钟只剩 10% 余量，太薄 → 先给到 150 分钟。
//
// ⚠️ 2026-09-27 早报证明**150 分钟也已经不够**，而且它踩坑的方式比「不够」更糟：
//   07:00 触发 → 抓取实际跑了 **154 分 51 秒**（finishedAt 01:34:51Z）；
//   软上限 150 分钟在 **01:30:00Z** 到点，`triggerAndWait` 只打了一行 warn
//   就**继续往下走**，于是推送在 01:30:02Z 启动 —— 比抓取结束早 **4 分 49 秒**。
//   那一刻库里窗口内的行只有上一轮留下的 8 篇（id ≤ 6068），
//   于是：草稿只剩 kg 一篇（6 条），kz/uz/az/tj 四个国家**窗口内 0 篇**
//   直接 `continue`，而 `summary.failures` 是 **空的** —— 接口看起来是成功的。
//   复现方式（⚠️ 用**显式窗口**，不要用 `--period`：09-27 那轮是合并前的 12h 早报窗口，
//   而现在的 `--period daily` 给的是 24h 窗口，两者不是同一段）：
//   `pnpm diagnose:push --start 2026-09-26T11:00:00Z --end 2026-09-26T23:00:00Z --max-id 6068`
//   输出 kg 正好 6 篇、其余 0 篇，与线上草稿逐字吻合。
//
// 所以现在的等待是**两段式**：
//   - 软上限（下面 `softMs`）：到点打 ⚠️ 并**继续等**（加时），不再是「放弃」的信号；
//   - 硬上限（`hardMs`）：到点才算真等不到，此时 `runPublishCycle` **直接不推送**。
// 为什么超时后不推送、而不是「推一份缺国家的」：上面那行「宁可晚，也不要在库半空时
// 推出一份缺国家的草稿」本来就是这段等待存在的**唯一理由**，而旧实现在超时后照样推，
// 等于把这个理由取消了。窗口是按时刻表固定的（见 publish-schedule），
// 所以**晚推不会与下一轮重叠、也不会漏** —— 迟到的代价只是读者晚看到，比缺国家轻。
//
// ⚠️⚠️ **2026-10-10 合并成日报后，这两个上限必须跟着放大**（这是合并的直接代价）：
//   合并前每轮约 270 篇候选，合并后单轮约 540 ⇒ 同样的单篇耗时下耗时翻倍。
//   按 `MERGED_ROUND_MAX_CANDIDATES × MEASURED_WORST_PER_ARTICLE_MS`
//   （600 × 37 秒 ≈ 370 分钟）定到 **400 分钟**，留 30 分钟余量。
//   若这里偷懒不改：单篇耗时一退化到实测过的 37 秒/篇，一轮就是约 333 分钟 > 240 分钟
//   ⇒ 撞硬上限 ⇒ **直接不推送** ⇒ 丢一整天（合并前只丢 12 小时）。
//   ⇒ 「合并省下的实例窗口时间」是拿「硬上限必须放宽、窗口跟着变宽」换来的，
//     净省约 **25%** 而不是一半。账要这么算。
//
// ⚠️ 单篇耗时为什么从 16 秒涨到 ~37 秒（252 候选 → 155 分钟）还没查完，
// 大概率是缺陷 21（429 放大 / 翻译退化）。**真正的解法是压低单篇耗时或改并发**，
// 把上限继续往上加只是把撞墙时间推后。
export const FETCH_SOFT_WAIT_MS = 240 * 60_000;
export const FETCH_HARD_WAIT_MS = 400 * 60_000;
// 推送比抓取快，但它要做「逐篇下载外链图 → 转码 → 传微信素材库 → 建草稿」，
// 5 个国家串行，留 20 分钟足够宽松。
export const PUSH_SOFT_WAIT_MS = 20 * 60_000;
export const PUSH_HARD_WAIT_MS = 40 * 60_000;

/**
 * 已知**最坏**的一次抓取耗时（2026-09-27 早报，读 `/api/fetch-news` 的 lastRun 得到）。
 *
 * ⚠️ 这是**合并前**（每轮约 270 篇）的记录，现在只作历史留档 ——
 * 合并后单轮的预期最坏值是 {@link mergedRoundWorstMs}，那才是约束现行上限的数。
 * 留着的价值：它证明了「单篇耗时能退化到 37 秒/篇」，这个事实不因合并而消失。
 */
export const MEASURED_WORST_FETCH_MS = 154 * 60_000 + 51_000;

/**
 * 合并成日报后**单轮**的候选量上限。
 *
 * 合并前每轮约 270 篇（实测 2026-09-20：一轮 268 篇 → 73 分钟），每天两轮
 * ⇒ 日产量约 540 篇（与库里按 `published_at` 统计的 537–584 篇/天吻合）。
 * 合并后这一整天的量都落在**同一轮**里 ⇒ 单轮候选翻倍。
 * 取 600 而不是 540，是给「某天产量偏高」留一点余量。
 */
export const MERGED_ROUND_MAX_CANDIDATES = 600;

/**
 * 实测**最坏**的单篇耗时（2026-09-27 早报：252 候选 → 154 分 51 秒 ≈ 37 秒/篇）。
 *
 * 这不是「性能目标」，是**已经发生过的事实**，所以上限必须按它定：
 * 按健康值（16 秒/篇）定上限，等于把「一退化就丢稿」写进设计。
 */
export const MEASURED_WORST_PER_ARTICLE_MS = 37_000;

/**
 * 合并后单轮的**预期最坏**耗时 = 候选上限 × 实测最坏单篇耗时 ≈ 370 分钟。
 *
 * 抽成函数而不是写死一个毫秒数：这样「候选上限」或「单篇最坏值」任一个被改动，
 * 硬上限的余量断言（{@link waitBudgetCrossCheck}）会立刻跟着重算，
 * 不会留下一个只会越来越僵死的数字。
 */
export function mergedRoundWorstMs(): number {
  return MERGED_ROUND_MAX_CANDIDATES * MEASURED_WORST_PER_ARTICLE_MS;
}

/**
 * 等待预算的自检 —— 与 `scheduleHoursCrossCheck()` 同一形式：
 * 把「必须成立的关系」报出来，改数字时本地就会红，而不是等到读者说「今天只有一国的稿子」。
 */
export function waitBudgetCrossCheck(): Array<{ name: string; ok: boolean; detail: string }> {
  const min = (ms: number) => `${Math.round(ms / 60_000)} 分钟`;
  return [
    {
      name: '抓取硬上限 > 软上限（超时后必须还能继续等，不能直接放弃）',
      ok: FETCH_HARD_WAIT_MS > FETCH_SOFT_WAIT_MS,
      detail: `软 ${min(FETCH_SOFT_WAIT_MS)} / 硬 ${min(FETCH_HARD_WAIT_MS)}`,
    },
    {
      name: '抓取硬上限 > 已知最坏实测耗时（低于它必然重演「半库推送」）',
      ok: FETCH_HARD_WAIT_MS > MEASURED_WORST_FETCH_MS,
      detail: `硬 ${min(FETCH_HARD_WAIT_MS)} vs 实测 ${min(MEASURED_WORST_FETCH_MS)}`,
    },
    {
      // 2026-10-10 合并成日报后**新增的这条才是真正管用的那条**：
      // 上面那条比的是「合并前」的单轮记录（270 篇量级），而合并后单轮量翻倍，
      // 拿旧记录当基准会得出「余量很足」的假结论。
      name: '★ 抓取硬上限 > 合并后单轮预期最坏耗时（候选翻倍后的真基准）',
      ok: FETCH_HARD_WAIT_MS > mergedRoundWorstMs(),
      detail: `硬 ${min(FETCH_HARD_WAIT_MS)} vs 预期最坏 ${min(mergedRoundWorstMs())}` +
        `（${MERGED_ROUND_MAX_CANDIDATES} 候选 × ${MEASURED_WORST_PER_ARTICLE_MS / 1000} 秒/篇）`,
    },
    {
      name: '推送硬上限 > 软上限',
      ok: PUSH_HARD_WAIT_MS > PUSH_SOFT_WAIT_MS,
      detail: `软 ${min(PUSH_SOFT_WAIT_MS)} / 硬 ${min(PUSH_HARD_WAIT_MS)}`,
    },
  ];
}

// 两个接口的 GET 都返回同样形状的 lastRun，这里只声明调度器真正用到的字段。
interface RunStateLite {
  running?: boolean;
  startedAt?: string | null;
  finishedAt?: string | null;
  summary?: unknown;
  error?: string | null;
}

/**
 * 「触发并等待」的结局。**必须把三种结局分开报**，否则调用方无从判断
 * 「任务完成了」和「等到超时了」——这正是 2026-09-27 早报漏掉 4 个国家的原因：
 * 旧实现的 `triggerAndWait` 返回 `void`，两种结局在调用方看来完全一样。
 */
interface WaitOutcome {
  /** 任务真的跑完了（观测到新的 finishedAt） */
  finished: boolean;
  /** 过了软上限、进入加时 */
  overtime: boolean;
  /** 连硬上限都过了，任务仍未结束 */
  timedOut: boolean;
  waitedMs: number;
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
//
// ## 两段式上限（2026-09-27 起）
//
// `softMs` 到点**不再放弃**，只打 ⚠️ 然后继续等到 `hardMs`。旧实现只有一个上限，
// 到点后照样返回、由调用方继续往下走 —— 于是「等到超时」和「任务已完成」
// 在调用方看来**一模一样**，两者唯一的区别只在一行 warn 里。
// 2026-09-27 早报就是在软上限到点后 2 秒开始推送的，读到一份半空的库。
//
// 返回值用 {@link WaitOutcome} 把三种结局分开，调用方才有机会做不同的事。
async function triggerAndWait(
  label: string,
  path: string,
  softMs: number,
  trigger: () => Promise<void>,
  hardMs: number = softMs,
): Promise<WaitOutcome> {
  const before = await readRunState(path);
  const finishedBefore = before?.finishedAt ?? null;

  try {
    await trigger();
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ${label}触发失败:`, error);
    return { finished: false, timedOut: true, overtime: false, waitedMs: 0 };
  }

  const startedWaitingAt = Date.now();
  const softDeadline = startedWaitingAt + softMs;
  const hardDeadline = startedWaitingAt + hardMs;
  let polls = 0;
  let softWarned = false;
  while (Date.now() < hardDeadline) {
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
      const waitedMs = Date.now() - startedWaitingAt;
      // summary 是各源采集量与最终入库数，或本轮建的草稿与失败国家；失败时这里是 error
      console.log(
        `[${new Date().toISOString()}] ${label}完成（等了 ${Math.round(waitedMs / 60_000)} 分钟` +
        `${softWarned ? '，**已超过软上限**' : ''}）:`,
        JSON.stringify(state.summary ?? state.error ?? state)
      );
      return { finished: true, timedOut: false, overtime: softWarned, waitedMs };
    }

    if (!softWarned && Date.now() >= softDeadline) {
      softWarned = true;
      console.warn(
        `[${new Date().toISOString()}] ⚠️ ${label}超过软上限 ${softMs / 60_000} 分钟仍未结束` +
        `，进入加时等待（硬上限 ${hardMs / 60_000} 分钟）。` +
        `加时是为了「宁可晚，也不要在数据只到一半时就往下走」—— 见 FETCH_HARD_WAIT_MS 的注释。`
      );
    }
  }

  const waitedMs = Date.now() - startedWaitingAt;
  console.error(
    `[${new Date().toISOString()}] ⛔ ${label}等待超过硬上限 ${hardMs / 60_000} 分钟仍未结束，放弃等待` +
    `（最后一轮观测：running=${(await readRunState(path))?.running}）。` +
    `调用方**不应**把这一轮当成正常结束。`
  );
  return { finished: false, timedOut: true, overtime: true, waitedMs };
}

// 抓取当天新闻（每国先凑足一个下限量，具体推送篇数由推送端"今日精选"决定）
async function runFetchNews(): Promise<WaitOutcome> {
  return await triggerAndWait('新闻抓取', '/api/fetch-news', FETCH_SOFT_WAIT_MS, async () => {
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
  }, FETCH_HARD_WAIT_MS);
}

// 微信公众号推送（按固定时段汇总新闻，逐国推送，不写死篇数）
// hours 由定时表给出：2026-10-10 起只有一段，日报 24h（昨日04:00 → 今日04:00）。
// period 只影响草稿标题里的「日报 / 补报」标记（`morning` / `evening` 是历史别名，
// 保留是为了滚动发布的窗口里「老容器还在跑」那一瞬不推出无后缀标题）。
//
// 推送接口和抓取一样是异步的（原因见 push/route.ts 顶部的注释：手动调公网域名
// 会被网关 65 秒切断）。调度器走 localhost 本来就不受那个限制，
// 但同样要等到终态，日志里才会留下「本轮建了哪几个草稿 / 哪几个国家失败」这行 ——
// 排查「今天怎么没推」全靠它。
async function runWechatPush(hours: number, period: string): Promise<WaitOutcome> {
  return await triggerAndWait('微信公众号推送', '/api/wechat/push', PUSH_SOFT_WAIT_MS, async () => {
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
  }, PUSH_HARD_WAIT_MS);
}

// 每次推送：先抓最新新闻，再按本时段窗口整理推送公众号
//
// ⚠️ 抓取**没在硬上限内跑完**时，本轮**不推送**。
//
// 这不是新增的策略，而是把这段等待本来就宣称的目的落到实处 ——
// 见 FETCH_HARD_WAIT_MS 上方那行「宁可晚，也不要在库半空时推出一份缺国家的草稿」。
// 旧实现在超时后照样往下走，于是 2026-09-27 早报推出一份只有 kg 的稿子，
// 而 `summary.failures` 是空的（跳过是静默的），看起来一切正常。
//
// 少推一轮的代价可控：窗口按时刻表固定（`publish-schedule`），
// 所以下一个时段不会替它补，但也**不会重复**；补的办法是抓取跑完后手工调
//   POST /api/wechat/push {"hours": 24, "period": "manual"}
async function runPublishCycle(hours: number, period: string) {
  // 变量名刻意不叫 `fetch` —— 那会遮住全局的 fetch，将来在这个函数里加一次请求就会踩空。
  const fetchOutcome = await runFetchNews();
  if (!fetchOutcome.finished) {
    console.error(
      `[${new Date().toISOString()}] ⛔ 抓取未在 ${FETCH_HARD_WAIT_MS / 60_000} 分钟内完成` +
      `（时段 ${period}）—— **本轮不推送**，避免推出一份缺国家的稿子。` +
      `等抓取跑完后手工补：POST /api/wechat/push {"hours":24,"period":"manual"}`
    );
    return;
  }
  if (fetchOutcome.overtime) {
    console.warn(
      `[${new Date().toISOString()}] ⚠️ 抓取是加时才完成的（耗时 ${Math.round(fetchOutcome.waitedMs / 60_000)} 分钟，` +
      `软上限 ${FETCH_SOFT_WAIT_MS / 60_000} 分钟）—— 本轮照常推送，但请留意单篇耗时是否在恶化。`
    );
  }
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
    // 打**推导出来的**窗口，而不是 `hours`：2026-09-24 起窗口由时刻表的钟点决定，
    // `hours` 只是交叉校验值。启动日志是唯一能确认「这个容器里的窗口到底覆盖哪一段」
    // 的地方（接口响应也能看到，但要先发一个请求）。
    const w = scheduledWindow(period);
    console.log(
      `已注册公众号推送任务：${schedule} (${label})，窗口 ` +
        (w ? `${w.start.toISOString()} → ${w.end.toISOString()}（${w.hours}h，按时刻表固定）` : '（未知：时刻表里没有这一段）')
    );
  });

  // 声明值与推导值必须一致 —— 不一致说明有人只改了 cron 或只改了 hours。
  // 这里**主动报出来**而不是留给测试：容器里跑的是编译产物，测试没在容器里跑过。
  for (const c of scheduleHoursCrossCheck()) {
    if (c.ok) continue;
    console.warn(
      `⚠️ 时刻表不一致：${c.period} 声明 hours=${c.declared}，但按 cron 推导是 ${c.derived}。` +
        `窗口以**推导值**为准（见 publish-schedule.scheduledWindow），请把 hours 改成 ${c.derived}。`
    );
  }

  console.log(`共注册 ${PUBLISH_SCHEDULES.length} 个定时任务`);
}