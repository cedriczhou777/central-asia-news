/**
 * 任务期自保活 —— 「实例只在**真的在跑**的时候活着」（2026-10-14 新增）。
 *
 * ## 为什么需要它
 *
 * `minNum = 0` 时平台规则是「**30 分钟没有任何入站请求**就把实例缩容到 0」
 * （官方《异步任务场景使用指南》原文，摘录见 `container.config.json:234-240`）。
 * 而本项目抓取**全程是出站**（拉 RSS / Telegram → 调翻译 API），平台侧看不到任何入站请求
 * ⇒ 一轮跑到第 25 分钟就会被回收。
 *
 * 现状的解法是控制台那条「定时扩缩容：每日 03:45 → 11:15、扩容至 1 个实例」：
 * 窗口内实例被规则**钉住**，不需要任何 ping，很可靠。**但它有一个直接代价：**
 * **窗口长度 = 计费时长**（`container.config.json:225-228` 自己写着这句）。
 *
 * 2026-10-14 的 L3 明细账单实测：`T = 7.61555556 h`（CPU 7.61555556 核时、内存 15.23111111 GiB·h，
 * 两者相除 = 2.0 ⇒ 1核2G），金额 0.91000000 元/天。
 * 而**真任务只有 4.48 h**（04:00 → 08:29）⇒ **2.77 h（占计费时长 36%）是纯空转**。
 *
 * 本模块把「保活」与「窗口」**解耦**：实例只在任务运行期自我续命，
 * 于是控制台窗口可以收窄到「只够冷启动 + 注册 cron」（如 03:45 → 04:10），
 * **计费跟着实际耗时走**。
 *
 * ## 靶子为什么必须是 `GET /api/fetch-news`
 *
 * 它是**无副作用**的只读接口（`container.config.json:217` 已经把它指定为保活靶子）。
 * ⚠️ **绝不能 POST** —— `POST /api/fetch-news` 和 `POST /api/wechat/push` 都是
 * 「一打就跑一轮」，会把草稿重复推出去。
 *
 * ## 为什么必须打**公网域名**，不能打 localhost
 *
 * 平台的「有没有入站请求」是**在它自己的反向代理那一层**判定的。
 * 同进程内 `fetch('http://localhost:PORT/...')` **根本不经过那层代理**
 * ⇒ 平台仍然认为这个实例空闲 ⇒ **保活无效**。
 *
 * 这不是推测，本项目里有一个跑了两个多月的反例：
 * `scheduler.ts` 的 `readRunState()` 走的是 `resolveSelfBaseUrl()`（**localhost**），
 * 抓取期间每 15 秒读一次状态、连读 80 分钟，**从未阻止过任何一次缩容**。
 * ⇒ 所以 `KEEPALIVE_TARGET_URL` 必须填**外网可访问的完整 URL**。
 *
 * ## ⚠️ 一个未验证的前提（必须知道）
 *
 * **「自己 ping 自己」算不算平台眼里的『入站请求』，本项目从未实测过。**
 * 若不算，本模块只是白花几 KB 流量、并多打几行日志 ——
 * **不会比不写更糟**（窗口那条规则还在兜着）。
 * 上线后要用一次**超出窗口的长轮次**验证它到底管不管用，
 * 判据是那轮的 `finishedAt` 能否超出窗口末端（见 `readKeepaliveStatus().pings` 与轮次日志对照）。
 *
 * ## 失败模式（唯一会「反向变贵」的那条）
 *
 * 若 `stopKeepalive()` 没被调用，实例会一直活着到 {@link KeepaliveOptions.hardMaxMs}。
 * 两道防线：
 *   ① 调用方用 `try/finally` 保证停；
 *   ② **自愈**：每次 ping 会读响应里的 `lastRun.finishedAt`，一旦发现
 *      「基线 `finishedAt` 变了且 `running === false`」⇒ 说明那一轮早就结束了，
 *      是停的逻辑被漏掉 ⇒ **自动停**并写 warn。
 * 硬上限本身**刻意与 `FETCH_HARD_WAIT_MS + PUSH_HARD_WAIT_MS` 同源**
 * （由调用方 `scheduler.ts` 传入，不在本模块里重写数字 —— 同一个量只许有一个出处），
 * 所以最坏情况也只是回到「原来那条 7.5 小时窗口」，**不会比现状贵**。
 */

/**
 * 本模块的部署指纹。它**纯属加法**，改一次加一 —— 用途见下面 `readKeepaliveStatus()`。
 *
 * 版本史：
 *   · `1` —— 2026-10-14 首版（`a5614da`）。
 *   · `2` —— 2026-10-15：`configured` / `targetHost` 改为**实时从环境变量现算**
 *     （此前只在轮次启动时锁存 ⇒ 「环境变量注入成功了吗」在跑轮次之前**无法自证**；
 *     而「加环境变量 + 重新部署」恰恰发生在**收窗口之前**，见 `readKeepaliveStatus()` 的注释），
 *     并让 `startKeepalive()` **构造上不可能抛**。
 */
export const KEEPALIVE_VERSION = 2;

/**
 * 两次 ping 的间隔。
 *
 * 平台的缩容红线是 **30 分钟**，取 15 分钟是为了**容错一次失败**：
 * 单次 ping 超时（冷启动实测 31.2 秒，见 `COST_2026-10-13.md`）或网络抖动时，
 * 下一轮还在红线内。与官方《异步任务场景使用指南》的实操例子
 * 「每 15 分钟发起请求，保持活跃」一致。
 */
export const PING_INTERVAL_MS = 15 * 60_000;

/** 单次 ping 失败后的重试间隔。比正常间隔短，是为了别把容错额度一次用光。 */
export const PING_RETRY_MS = 5 * 60_000;

/**
 * 单次 ping 的超时上限。
 *
 * 60 秒 = 冷启动实测 31.2 秒的约 2 倍。不能用更短的：窗口外第一次 ping 会撞上冷启动，
 * 而**那一次恰恰是最需要它成功的**（不打就缩容了）。
 */
export const PING_TIMEOUT_MS = 60_000;

export interface KeepaliveOptions {
  /** 保活的理由，只进日志和状态回显（例：`轮次开始（时段 daily）`）。 */
  reason: string;
  /**
   * 硬上限：从启动那一刻起算，到点**无条件停**。
   *
   * 由调用方传 `FETCH_HARD_WAIT_MS + PUSH_HARD_WAIT_MS`（见 `scheduler.ts`）。
   * **不在本模块里写死这个数**：同一个量有两份说明迟早会分叉，
   * 而这里分叉的后果是「保活比等待上限还短⇒长轮次被腰斩」这种静默丢稿。
   */
  hardMaxMs: number;
}

/** 活体状态。全部字段都会被 `GET /api/fetch-news` 原样回显。 */
export interface KeepaliveStatus {
  version: number;
  /**
   * **环境变量 `KEEPALIVE_TARGET_URL` 配上了吗**（前缀合法即算配了）。false ⇒ 整个机制不启用（而不是报错）。
   *
   * ⚠️ 它是**实时从环境变量现算**的，所以**不需要先跑一轮**就能读到真值 ——
   * 这一点至关重要：「加环境变量 + 重新部署」这件事必须在**收窗口之前**验证，
   * 而窗口一旦收窄、保活却没生效，长轮次会被缩容腰斩 ⇒ 丢一整天。
   * 语义上请与 `active` 分开读：`configured` = 配上了没有，`active` = 此刻真的在保活。
   */
  configured: boolean;
  /** 此刻在保活吗 */
  active: boolean;
  /**
   * 靶子 URL 的 host（只报 host：报出来是为了能一眼确认「打的是对的那个域名」）。
   *
   * ⚠️ 与 `configured` 组合读：`configured:true` 而 `targetHost:null`
   * = **配了、前缀也对，但 URL 本身不合法**（`new URL()` 解析不了 ⇒ 一定打不通）。
   */
  targetHost: string | null;
  startReason: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  stopReason: string | null;
  /** 硬上限时刻 */
  hardDeadline: string | null;
  /** 成功的 ping 次数 */
  pings: number;
  /** 失败的 ping 次数 */
  pingErrors: number;
  lastPingAt: string | null;
  /** 上一次 ping 的 HTTP 状态；0 = 网络层就没连上 */
  lastStatus: number | null;
  lastError: string | null;
  /** 启动时记下的 `lastRun.finishedAt`，自愈判据的基线 */
  baselineFinishedAt: string | null;
}

interface MutableState extends KeepaliveStatus {
  timer: NodeJS.Timeout | null;
}

function freshState(): MutableState {
  return {
    version: KEEPALIVE_VERSION,
    configured: false,
    active: false,
    targetHost: null,
    startReason: null,
    startedAt: null,
    stoppedAt: null,
    stopReason: null,
    hardDeadline: null,
    pings: 0,
    pingErrors: 0,
    lastPingAt: null,
    lastStatus: null,
    lastError: null,
    baselineFinishedAt: null,
    timer: null,
  };
}

const state: MutableState = freshState();

/**
 * **纯函数**：把环境变量的原始值判成靶子 URL（前缀不是 http(s) 就返回 null）。
 *
 * ⚠️ 这里**刻意不打印任何东西**。它会被 `readKeepaliveStatus()` 在**每次 GET 时**调用，
 * 而状态接口会被调度器每 15 秒轮询一次 ⇒ 把 warn 放这里会刷屏。
 * 告警统一放在下面那个只跑一次的 `resolveTargetUrl()` 里。
 */
function parseTargetUrl(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  // 只接受 http(s)：`ftp://` 之类打不通，早报错好过晚发现。
  return /^https?:\/\//i.test(v) ? v : null;
}

/**
 * 解析靶子 URL（**带告警**，只在轮次启动时调用一次）。**没配就是没启用** ——
 * 本模块不猜、不兜底到 localhost。
 *
 * 为什么不做「兜底到 `resolveSelfBaseUrl()`」：那是 localhost，
 * 打它等于什么都没做（理由见文件头）。**静默地打一个无效的靶子，
 * 比明确地不启用更危险** —— 前者会让人以为保活已经在工作了。
 */
function resolveTargetUrl(): string | null {
  const raw = process.env.KEEPALIVE_TARGET_URL;
  const url = parseTargetUrl(raw);
  if (!url && raw?.trim()) {
    console.warn(
      `[keepalive] ⚠️ KEEPALIVE_TARGET_URL 必须以 http:// 或 https:// 开头，` +
      `当前值被忽略（保活不启用）。`
    );
  }
  return url;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** 破坏各级缓存：状态查询必须每次拿到最新值，被缓存住就等于没打。 */
function withCacheBuster(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}cb=${Date.now()}`;
}

/**
 * 发一次 ping。返回是否成功（决定下一次用正常间隔还是重试间隔）。
 *
 * 顺带做两件事：
 *   ① 读响应里的 `lastRun` 作**自愈**判据（见文件头「失败模式」）；
 *   ② 把状态写进 {@link state}，供接口回显。
 */
async function pingOnce(): Promise<boolean> {
  const url = resolveTargetUrl();
  if (!url) return false;

  try {
    const res = await fetch(withCacheBuster(url), {
      cache: 'no-store',
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    state.lastPingAt = new Date().toISOString();
    state.lastStatus = res.status;

    if (!res.ok) {
      state.pingErrors += 1;
      state.lastError = `HTTP ${res.status}`;
      console.warn(
        `[keepalive] ⚠️ 保活 ping 返回 HTTP ${res.status}（第 ${state.pingErrors} 次失败）` +
        `—— 平台若在这段时间里判定空闲，实例会被缩容。`
      );
      return false;
    }

    state.pings += 1;
    state.lastError = null;

    // 自愈：读到「有新的一轮已经完成」而我们还活着 ⇒ stop 那条路被漏掉了。
    // 只读不写业务状态，纯读 GET 的响应体。
    const body = (await res.json().catch(() => null)) as
      | { lastRun?: { running?: boolean; finishedAt?: string | null } | null }
      | null;
    const finishedAt = body?.lastRun?.finishedAt ?? null;
    const running = body?.lastRun?.running;

    console.log(
      `[keepalive] 保活 ping 成功（第 ${state.pings} 次，间隔 ${PING_INTERVAL_MS / 60_000} 分钟）` +
      `：running=${running} finishedAt=${finishedAt ?? null}`
    );

    if (
      state.baselineFinishedAt &&
      finishedAt &&
      finishedAt !== state.baselineFinishedAt &&
      running === false
    ) {
      stopKeepalive(
        `自愈：观测到新的一轮已完成（finishedAt=${finishedAt}），` +
        `说明本轮结束时 stopKeepalive 没被调用`
      );
    }
    return true;
  } catch (error) {
    state.lastPingAt = new Date().toISOString();
    state.lastStatus = 0;
    state.pingErrors += 1;
    state.lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.warn(
      `[keepalive] ⚠️ 保活 ping 失败（第 ${state.pingErrors} 次）：${state.lastError}` +
      `—— ${PING_RETRY_MS / 60_000} 分钟后重试。`
    );
    return false;
  }
}

/** 递归 setTimeout 而不是 setInterval：这样下一次的间隔可以随成败动态调整。 */
function scheduleNext(delayMs: number): void {
  if (!state.active) return;
  state.timer = setTimeout(() => {
    void (async () => {
      const ok = await pingOnce();
      scheduleNext(ok ? PING_INTERVAL_MS : PING_RETRY_MS);
    })();
  }, delayMs);
  // 不让定时器把进程「钉」住：本服务有 HTTP listener，正常情况下不会因此退出；
  // 但一旦 listener 关了，保活定时器不该成为最后那个不肯走的东西。
  state.timer.unref?.();
}

/**
 * 启动保活（对外入口）。**幂等**，且**绝不抛**。
 *
 * 第一次 ping **刻意不等一个完整间隔再打**：实例可能刚被规则拉起（03:45），
 * 或者刚从 0 冷启动。等到第 15 分钟才打，用的是「最后一次平台可见的入站」到现在的时间，
 * 而那个时刻**可能已经过去很久**（例如规则拉起后实例空转到 30 分钟红线）。
 * 所以启动后立刻打一次，把「平台可见的最近一次入站」重新锚到现在。
 *
 * ## ⚠️ 为什么必须包一层 try/catch（2026-10-15）
 *
 * 调用方是 `scheduler.ts` 的 `runPublishCycle()`，而 `startKeepalive(...)` 写在它的
 * **`try {` 之前**（`scheduler.ts:426` vs `:430`）—— 那里抛出去的异常**没有任何 catch**，
 * 后果是那一轮**抓取与推送整轮不执行 = 丢一整天**。
 *
 * 本模块是**优化**不是**正确性**：它坏掉最多让实例多活一会儿（多花几分钱），
 * 但绝不该有能力毁掉一轮日报。而它读的 `KEEPALIVE_TARGET_URL` 是**人手在控制台敲进去的**，
 * 写错是常态 ⇒ **不让它的正确性依赖调用方的 try 边界**。
 */
export function startKeepalive(options: KeepaliveOptions): void {
  try {
    startKeepaliveInner(options);
  } catch (error) {
    // 不重新抛出，也不静默：吞成一行 warn（本模块的既有约定 —— 自坏可以，静默不行）。
    console.warn(
      `[keepalive] ⚠️ 启动保活时内部异常，已忽略（本轮照常跑，只是少一层保活）：` +
      `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
    );
  }
}

/**
 * 真正的启动逻辑。**幂等** —— 已在跑时只记一行日志，不重置计时。
 * 不抛的保证由上面的 `startKeepalive()` 提供，所以这里只管写清逻辑。
 */
function startKeepaliveInner(options: KeepaliveOptions): void {
  const url = resolveTargetUrl();
  state.configured = url !== null;

  if (!url) {
    console.log(
      '[keepalive] 未配置 KEEPALIVE_TARGET_URL ⇒ 保活不启用（实例存活仍由控制台的定时扩缩容窗口负责）。' +
      ' 这不是错误：没配置时窗口就是唯一保活机制，与改动前行为一致。'
    );
    return;
  }

  if (state.active) {
    console.log(`[keepalive] 已在保活中（${state.startReason}），本次调用忽略：${options.reason}`);
    return;
  }

  state.active = true;
  state.targetHost = hostOf(url);
  state.startReason = options.reason;
  state.startedAt = new Date().toISOString();
  state.stoppedAt = null;
  state.stopReason = null;
  state.hardDeadline = new Date(Date.now() + options.hardMaxMs).toISOString();

  // 立刻打第一次：把「平台可见的最近一次入站」重新锚到当下。
  // 用 5 秒而不是 0 秒 —— 刚被 cron 触发的这一瞬容器可能还在处理启动，
  // 早打会失败，而失败要等 PING_RETRY_MS 才补，白丢一次容错额度。
  console.log(
    `[keepalive] ▶️ 启动任务期保活：${options.reason}｜靶子 ${state.targetHost}` +
    `｜间隔 ${PING_INTERVAL_MS / 60_000} 分钟｜硬上限 ${new Date(state.hardDeadline).toISOString()}` +
    `（${Math.round(options.hardMaxMs / 60_000)} 分钟）`
  );
  scheduleNext(5_000);
}

/**
 * 停止保活。**幂等** —— 没在跑时是 no-op（`finally` 里可能被重复调用）。
 *
 * ⚠️ 停完之后**不做任何清理等待**：实例会在平台的「30 分钟无入站」规则到达后自然缩容，
 * 这正是省钱的部分 —— 别在这里加「再 ping 一次确认」之类的逻辑，
 * 那等于把刚省下的时间又花回去。
 */
export function stopKeepalive(reason: string): void {
  if (!state.active) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.active = false;
  state.stoppedAt = new Date().toISOString();
  state.stopReason = reason;

  const startedMs = state.startedAt ? Date.parse(state.startedAt) : Date.now();
  const aliveMin = Math.round((Date.now() - startedMs) / 60_000);
  console.log(
    `[keepalive] ⏹️ 停止任务期保活：${reason}｜共 ping ${state.pings} 次` +
    `（失败 ${state.pingErrors} 次）｜保活 ${aliveMin} 分钟。` +
    ` 之后不再续命，实例将在平台「30 分钟无入站请求」规则到达后自然缩容。`
  );
}

/**
 * 读当前状态（给接口回显用）。返回副本，调用方拿不到内部可变对象。
 *
 * ## ⚠️ `configured` / `targetHost` 为什么是「现算」而不是「回显锁存值」（2026-10-15，`KEEPALIVE_VERSION=2`）
 *
 * 这两个字段原本只在 `startKeepalive()` 里写，而那个函数**只在轮次开始时被调用**。
 * 于是有一个只会在结论里出错、不报错的缺口：
 *
 *   **「环境变量到底注入成功了没有」在跑过一轮之前，从外面完全看不出来** ——
 *   `configured` 恒为 `false`，与「没配」长得一模一样。
 *
 * 而这件事偏偏必须在**收窗口之前**验证（窗口一收窄、保活却没生效 ⇒ 长轮次被缩容腰斩 = 丢一整天），
 * 也就是说：**要验证的东西在窗口内才可见，而要做的决定在窗口外就得做**。
 * 现算之后，一次零副作用的 `GET /api/fetch-news` 就能回答「环境变量在不在、值对不对」，
 * 既不用先跑一轮，也不用进控制台翻日志。
 *
 * ⚠️ 因此这里**只能调纯函数 `parseTargetUrl()`**，不能调带告警的 `resolveTargetUrl()`——
 * 后者会在每次 GET 时打 warn，而调度器每 15 秒轮询一次 ⇒ 刷屏。
 */
export function readKeepaliveStatus(): KeepaliveStatus {
  const { timer: _timer, ...snapshot } = state;
  const url = parseTargetUrl(process.env.KEEPALIVE_TARGET_URL);
  return {
    ...snapshot,
    configured: url !== null,
    targetHost: url ? hostOf(url) : null,
  };
}

/** 平台空闲红线：30 分钟没有任何入站请求就缩容到 0（`container.config.json:234-240`）。 */
const PLATFORM_IDLE_LIMIT_MS = 30 * 60_000;

/**
 * 常量自检 —— 与 `scheduler.ts` 的 `waitBudgetCrossCheck()` **同一形式**：
 * 把「必须成立的关系」写出来，改数字时**本地就红**，而不是等某天长轮次被缩容腰斩、
 * 或者实例白活一整天之后才发现。
 *
 * `expectedHardMaxMs` 由调用方传进来（= `FETCH_HARD_WAIT_MS + PUSH_HARD_WAIT_MS`），
 * **刻意不在本模块里读那个常量** —— 那会形成 `keepalive ⇄ scheduler` 的循环 import，
 * 而循环 import 在打包产物里的表现是「有时能用」，属于最难查的那类问题。
 * 传参还有第二个好处：算式留在**调用点**（`scheduler.ts`），
 * 于是「保活最多活多久」与「最多等多久」在算术上不可能分叉。
 *
 * ⚠️ 它的边界，说清楚免得被当成更强的保证：这几条只能防「有人把间隔/超时改成一个
 * 荒唐的值」，**防不了**「调度器的等待上限改了、而调用点忘了同步」——
 * 后者由调用点直接写算式（而不是写死一个数）来保证。
 */
export function keepaliveCrossCheck(
  expectedHardMaxMs: number,
): Array<{ name: string; ok: boolean; detail: string }> {
  const min = (ms: number) => `${Math.round(ms / 60_000)} 分钟`;
  return [
    {
      name: '保活间隔 < 平台空闲红线（≥ 红线则第一次缩容发生在补 ping 之前）',
      ok: PING_INTERVAL_MS < PLATFORM_IDLE_LIMIT_MS,
      detail: `间隔 ${min(PING_INTERVAL_MS)} vs 红线 ${min(PLATFORM_IDLE_LIMIT_MS)}`,
    },
    {
      name: '失败重试 < 保活间隔（否则一次失败就把容错额度吃光）',
      ok: PING_RETRY_MS < PING_INTERVAL_MS,
      detail: `重试 ${min(PING_RETRY_MS)} vs 间隔 ${min(PING_INTERVAL_MS)}`,
    },
    {
      name: '单次 ping 超时 < 保活间隔（单次卡住不能把下一次挤掉）',
      ok: PING_TIMEOUT_MS < PING_INTERVAL_MS,
      detail: `超时 ${min(PING_TIMEOUT_MS)} vs 间隔 ${min(PING_INTERVAL_MS)}`,
    },
    {
      name: '保活硬上限 ≥ 一个保活间隔（否则一次都没打就自己停了）',
      ok: Number.isFinite(expectedHardMaxMs) && expectedHardMaxMs >= PING_INTERVAL_MS,
      detail: `调用方传入 ${min(expectedHardMaxMs)}`,
    },
  ];
}
