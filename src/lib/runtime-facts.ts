/**
 * 运行时事实（2026-10-16 新增）—— 把「环境变量 / 容器规格」从「只能到控制台去看」
 * 变成「一条零副作用 GET 就能问清楚」。
 *
 * ## 为什么必须存在（本项目 2026-10-15/16 两天里撞到的同一个缺口，两种表现）
 *
 * ① **环境变量改动没有代码指纹。** 2026-10-16 把 `NODE_OPTIONS` 从
 *    `--max-old-space-size=640` 改成 `320`，控制台只多出一个版本、备注
 *    `server config change`（⚠️ 而「改规格」与「改环境变量」**用的是同一个备注**，
 *    版本列表**分不出**是哪类改动）。没有代码变化 ⇒ `codeVersion` 不变
 *    ⇒ 从外部**无法自证**「env 真的变成 320 了」。
 * ② **规格改动同样没有指纹。** CPU 0.5 核 → 0.25 核、内存 1 G → 0.5 G
 *    只反映在控制台那个下拉框和**面板的百分比**上
 *    （那个百分比的分母是规格，所以要靠「百分比是否翻倍」反推，间接、易错）。
 *
 * ⇒ 本模块把这两件事变成进程内**现算**的读数，且**不依赖任何构建产物**。
 * 它与 `KEEPALIVE_VERSION` / `MEMORY_PROBE_VERSION` 同一个理由：
 * **能在花钱之前问清楚，就不要靠事后翻日志。**
 *
 * ## 读法
 *
 * · `nodeOptions` 非 null ⇒ 环境变量确实注入了（**回显原值，不做解析**）。
 * · `heapSizeLimitMB` 明显小于 Node 默认值（64 位约 4 GB）⇒ `--max-old-space-size`
 *   **真的被 V8 采纳了**。⚠️ 它**不等于**那个参数值：V8 的 `heap_size_limit`
 *   是**总**堆上限（含 new space），比 `--max-old-space-size` 略大。
 * · `memoryLimitMB` / `cpuQuotaCores` ⇒ 容器规格。⚠️ **不要用 `os.totalmem()` /
 *   `os.cpus().length` 代替**：它们返回的是**宿主机**的内存与核数，
 *   拿它们当「容器规格」会得到一个看起来正常、实际完全错误的数
 *   （例如把 0.5 G 的容器报成 64 G ⇒ 后面所有据此推出的安全余量全部作废）。
 *
 * ## 边界（必须说清，否则会被当成更强的保证）
 *
 * · cgroup 读不到时**返回 `null`，不猜、不兜底**。`null` 的含义是「这个环境
 *   没有暴露限制」（例如在本机跑测试），**不是「无限」**。
 * · 本模块**构造上不可能抛**：所有读取都包在 `try` 里。
 *   它被 `GET /api/fetch-news` 调用，而那个接口是**保活靶子** ——
 *   它抛出去会让保活失败，进而让实例被缩容腰斩（长轮次丢一整天）。
 */
import { readFileSync } from 'fs';
import { getHeapStatistics } from 'v8';

/**
 * 本模块的部署指纹。**纯加法**，改一次加一。
 * 用途：`GET /api/fetch-news` 的响应里有 `runtimeFacts.version` ⇒
 * 能判断「线上这版到底带没带这个回显」（字段整个不存在 = 旧版）。
 */
export const RUNTIME_FACTS_VERSION = 1;

/** 1 MiB —— cgroup 给的是字节。 */
const MB = 1024 * 1024;

/**
 * cgroup **v1** 在「未设限」时给出的哨兵值（约 8 EiB）。
 * 它是「没有上限」，**不是一个真实上限** ⇒ 必须排除，否则会把 8 EiB 报成规格。
 * ⚠️ 排除条件用 `>= 2**60` 而不是 `=== 那个哨兵`：不同内核给的数略有不同。
 */
const CGROUP_UNLIMITED = 2 ** 60;

function readTrimmed(path: string): string | null {
  try {
    const s = readFileSync(path, 'utf8').trim();
    return s.length > 0 ? s : null;
  } catch {
    // 读不到是常态（文件不存在 / 无权限 / 非 Linux）。**不抛、不猜。**
    return null;
  }
}

/**
 * 容器内存上限（MiB）；读不到 cgroup 时 `null`。
 *
 * v2：`/sys/fs/cgroup/memory.max`（未设限时字面量就是 `max`）。
 * v1：`/sys/fs/cgroup/memory/memory.limit_in_bytes`（未设限时是那个天文数字）。
 */
function readMemoryLimitMB(): number | null {
  const v2 = readTrimmed('/sys/fs/cgroup/memory.max');
  if (v2 !== null) {
    if (v2 === 'max') return null;
    const n = Number(v2);
    // `> 0` 同时挡掉 `Number(null) === 0` 那种坑。
    if (Number.isFinite(n) && n > 0 && n < CGROUP_UNLIMITED) return Math.round(n / MB);
  }
  const v1 = readTrimmed('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  if (v1 !== null) {
    const n = Number(v1);
    if (Number.isFinite(n) && n > 0 && n < CGROUP_UNLIMITED) return Math.round(n / MB);
  }
  return null;
}

/** 保留两位小数：`0.25` 就该显示 `0.25`，`1.3333333` 该显示 `1.33`。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * CPU 配额（核）；`0.25` 表示「四分之一核」。读不到或不限时 `null`。
 *
 * v2：`/sys/fs/cgroup/cpu.max`，内容是 `"<quota> <period>"`（如 `25000 100000` = 0.25 核），
 *     不限时 quota 位置是字面量 `max`。
 * v1：`cpu.cfs_quota_us` ÷ `cpu.cfs_period_us`。
 */
function readCpuQuotaCores(): number | null {
  const v2 = readTrimmed('/sys/fs/cgroup/cpu.max');
  if (v2 !== null) {
    const [quotaRaw, periodRaw] = v2.split(/\s+/);
    if (quotaRaw !== 'max') {
      const quota = Number(quotaRaw);
      const period = Number(periodRaw);
      if (Number.isFinite(quota) && Number.isFinite(period) && quota > 0 && period > 0) {
        return round2(quota / period);
      }
    }
    return null;
  }
  const quota = Number(readTrimmed('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
  const period = Number(readTrimmed('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
  // ⚠️ `Number(null) === 0`，靠 `> 0` 挡掉（文件不存在时 `readTrimmed` 给 null）。
  if (Number.isFinite(quota) && Number.isFinite(period) && quota > 0 && period > 0) {
    return round2(quota / period);
  }
  return null;
}

export interface RuntimeFacts {
  /** 部署指纹（`RUNTIME_FACTS_VERSION`）。字段整个不存在 ⇒ 线上是旧版。 */
  version: number;
  /** `process.env.NODE_OPTIONS` 原样回显；`null` = 没设这个变量。 */
  nodeOptions: string | null;
  /**
   * V8 **实际**的堆上限（MiB）。
   * ⚠️ 它比 `--max-old-space-size` 略大（那个只管 old space，这个是总堆），
   * 所以**不能**断言两者相等 —— 只能说「明显小于默认的约 4 GB ⇒ 参数被采纳了」。
   */
  heapSizeLimitMB: number | null;
  /** 容器内存上限（MiB）；读不到 cgroup 时 `null`（**不是无限**）。 */
  memoryLimitMB: number | null;
  /** CPU 配额（核），如 `0.25`；读不到或不限时 `null`。 */
  cpuQuotaCores: number | null;
  /** 一行可读摘要 —— 一次 `curl` 就能肉眼核，不必逐个字段对。 */
  probe: string;
}

/** 读一次全部事实。**永不抛**，任何一项读不到就那一项给 `null`。 */
export function readRuntimeFacts(): RuntimeFacts {
  let heapSizeLimitMB: number | null = null;
  try {
    heapSizeLimitMB = Math.round(getHeapStatistics().heap_size_limit / MB);
  } catch {
    heapSizeLimitMB = null;
  }

  const nodeOptions = process.env.NODE_OPTIONS ?? null;
  const memoryLimitMB = readMemoryLimitMB();
  const cpuQuotaCores = readCpuQuotaCores();

  return {
    version: RUNTIME_FACTS_VERSION,
    nodeOptions,
    heapSizeLimitMB,
    memoryLimitMB,
    cpuQuotaCores,
    probe:
      `NODE_OPTIONS=${nodeOptions ?? '(未设)'}｜V8堆上限=${heapSizeLimitMB ?? '未知'}MB` +
      `｜容器内存上限=${memoryLimitMB ?? '未暴露'}MB｜CPU配额=${cpuQuotaCores ?? '未暴露'}核` +
      `（后两项为 null = 这个环境没有暴露 cgroup 限制，**不是「无限」**）`,
  };
}