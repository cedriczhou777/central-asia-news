/**
 * 进程内存读数（2026-10-13 加）。
 *
 * ## 为什么需要它
 *
 * 「能不能把云托管规格从 1核2G 降到 0.5核1G」卡在一个数上：内存的**绝对**峰值。
 * 控制台的「内存使用率」只给**百分比**，而分母是「本服务 2 GiB」还是「宿主机」
 * 直接决定 1 GiB 够不够 —— 且 OOM 是**内核杀进程**（进程直接消失、不打应用日志），
 * 表现为「静默丢稿」。⇒ 这个数**不能靠试**，必须实测。
 * （`grep memoryUsage|heapUsed|rss` 在 `src/` 下曾经 **0 命中** ⇒ 应用此前从不记录自身内存。）
 *
 * ## 为什么取 `maxRSS` 而不是连续采样
 *
 * `process.resourceUsage().maxRSS` 是**内核准的进程生命周期峰值**，
 * 不是采样、也不是瞬时值 ⇒ **一轮就给出一轮的真实峰值**，
 * 不需要连续采样、不进轮次时长、不影响账单。
 * `memoryUsage()` 那两个是**收尾时刻**的瞬时值，用来回答「峰值离收尾有多远」。
 *
 * ⚠️ 因为它是**进程生命周期**峰值，所以**两侧都要读**：调度器是
 * 「抓取跑完 → 再触发推送」串联（`scheduler.ts` 的 `triggerAndWait`），两段同一进程，
 * 而峰值很可能在推送那段（图片下载 + 转码、总审把整批稿件连摘要喂模型）。
 * 只读抓取端会**系统性低估**。`maxRSS` 单调不减 ⇒ 推送端 ≥ 抓取端，判读以推送端为准；
 * 两者之差本身有信息量（峰值属于哪个阶段）。
 *
 * ## ⚠️ 单位：一律按 KB 换算，**不要按平台分支**
 *
 * Node 已经把平台差异吃掉了。2026-10-13 在 darwin 上实测同进程
 * `maxRSS = 42128` 而 `memoryUsage().rss = 43171840 B`（= 41 MB）
 * ⇒ `42128 KB ≈ 41 MB` 成立，说明 macOS 拿到的**也是 KB**。
 * （初版按 `darwin ? 字节 : KB` 写了分支，实测算出来是 **0 MB** ——
 * 那是个会撒谎的仪器，比没有仪器更糟。）
 *
 * ## 部署指纹
 *
 * {@link MEMORY_PROBE_VERSION} 由 `GET /api/fetch-news` 与 `GET /api/wechat/push`
 * 各自报出来，用来回答「线上跑的是不是带探针的那一版」——
 * 没有指纹的改动只能证明「推上去了」，证明不了「跑的是它」。
 */

/** 探针版本指纹。**改动本文件的读数逻辑时必须 +1。** */
export const MEMORY_PROBE_VERSION = 1;

export interface MemorySnapshot {
  /** 进程生命周期内的**峰值** RSS（MB）。由内核给，非采样。 */
  maxRssMB: number;
  /** 收尾时刻的 RSS（MB） */
  rssMB: number;
  /** 收尾时刻的 V8 已用堆（MB） */
  heapUsedMB: number;
}

/**
 * 读取当前进程的内存读数。**无副作用**（只读两个系统调用），可随时调用。
 */
export function readMemorySnapshot(): MemorySnapshot {
  const resourceUsage = process.resourceUsage();
  const memSnapshot = process.memoryUsage();

  const maxRssMB = Math.round(resourceUsage.maxRSS / 1024);
  const rssMB = Math.round(memSnapshot.rss / 1024 / 1024);
  const heapUsedMB = Math.round(memSnapshot.heapUsed / 1024 / 1024);

  // 自洽断言：`maxRSS` 是**峰值**、`rss` 是**当前值** ⇒ 峰值不可能小于当前值。
  // 不成立就说明上面「一律 /1024」的前提错了 —— 那正是初版踩过的坑（算出 0 MB）。
  // ⚠️ 这里**只 warn 不 throw**：探针不该因为自己坏掉而毁掉一整轮。
  //    但也**不许静默** —— 静默失败正是这个探针本身要防的东西。
  if (!(maxRssMB >= rssMB)) {
    console.warn(
      `[memory-probe] ⚠️ 自洽断言失败：maxRssMB=${maxRssMB} < rssMB=${rssMB}。` +
      `多半是 maxRSS 的单位不是 KB（见 src/lib/memory-probe.ts 的注释）—— ` +
      `此时**峰值读数不可信**，不要拿它判断降规格。`
    );
  }

  return { maxRssMB, rssMB, heapUsedMB };
}
