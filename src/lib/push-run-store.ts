/**
 * push 运行状态的**持久化**（2026-10-28）。
 *
 * ## 为什么必须有它（**这是今天最大的可观测性缺口**）
 *
 * 2026-10-28 上午：用户报「草稿箱只有 2 篇」。
 * ⇒ 我查 `GET /api/wechat/push` 的 `lastRun` ⇒ **`summary: null`、`error: null`、全空**。
 * ⇒ 我手动补跑一次 ⇒ **跑了 30+ 分钟，`running` 变 false，但 `summary` 仍是 null、`error` 仍是 null**。
 * ⇒ ⇒ **完全查不出那轮发生了什么**（是崩了？被杀了？还是本来就空？）
 *
 * ## 根因
 *
 * `pushRunState` 是**模块级内存态** ⇒ ⇒ **实例一换（部署 / 缩容 / 冷启动）就全丢**。
 * ⇒ ⇒ 而云托管**恰好经常换实例**（窗口 03:45–09:30 之外缩容到 0）。
 * ⇒ ⇒ 所以「上一轮为什么只有 2 篇」这件事，**在架构上是查不到的**。
 *
 * ## 修法
 *
 * 把状态**落库**（表 `push_runs`，单行 `id = 'latest'`）⇒ ⇒ 跨实例可查。
 * ⇒ ⚠️ **表不存在时静默降级**（用内存态 + 一次 warn）⇒ ⇒
 * ⇒ **不因为这张表卡住整条推送链路**（表是可选的增强，不是必需件）。
 */

/** 落库的形状。字段名与 `PushRunState` 对齐，但多了 `id`（单行 upsert）。 */
export interface PersistedPushRun {
  /** 固定 'latest'（只保留最近一轮）⇒ ⇒ 免去清理 */
  id: 'latest';
  started_at: string | null;
  finished_at: string | null;
  running: boolean;
  duration_ms: number | null;
  error: string | null;
  /** 整轮摘要（草稿数 / skipped / failures / 限流读数…） */
  summary: unknown;
  updated_at: string;
}

const TABLE = 'push_runs';
const ROW_ID = 'latest';

let warnedMissingTable = false;

/**
 * 写 push 状态。**永不抛异常** ⇒ ⇒ 落库失败绝不能影响推送本身。
 *
 * @param state 与 `PushRunState` 同形的状态
 */
export async function persistPushRun(state: {
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  running: boolean;
  error: string | null;
  summary: unknown;
}): Promise<void> {
  try {
    const { getSupabaseClient } = await import('@/storage/database/supabase-client');
    const sb = getSupabaseClient();
    const row: PersistedPushRun = {
      id: ROW_ID,
      started_at: state.startedAt,
      finished_at: state.finishedAt,
      running: state.running,
      duration_ms: state.durationMs,
      error: state.error,
      summary: state.summary,
      updated_at: new Date().toISOString(),
    };
    const { error } = await sb.from(TABLE).upsert(row, { onConflict: 'id' });
    if (error) {
      if (!warnedMissingTable) {
        warnedMissingTable = true;
        console.warn(
          `[push-run] 落库失败（不阻塞推送）：${error.message}` +
            `—— 若是「表不存在」，执行 outputs/push-runs-table.sql 建表即可`,
        );
      }
    }
  } catch (e) {
    if (!warnedMissingTable) {
      warnedMissingTable = true;
      console.warn(
        `[push-run] 落库不可用（不阻塞推送）：${e instanceof Error ? e.message : String(e)}` +
          `—— 若是「表不存在」，执行 outputs/push-runs-table.sql 建表即可`,
      );
    }
  }
}

/**
 * 读最近一轮 push 状态。**读不到就返回 null**（调用方退回内存态）。
 */
export async function loadPersistedPushRun(): Promise<PersistedPushRun | null> {
  try {
    const { getSupabaseClient } = await import('@/storage/database/supabase-client');
    const sb = getSupabaseClient();
    const { data, error } = await sb.from(TABLE).select('*').eq('id', ROW_ID).maybeSingle();
    if (error || !data) return null;
    return data as PersistedPushRun;
  } catch {
    return null;
  }
}
