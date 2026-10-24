/**
 * **跨批次重复**的识别（2026-10-25 加）。
 *
 * ## 要解决什么
 *
 * 用户 2026-10-20 与 10-24 两次报「又出现重复」。查下来是**两半**：
 * · **同批次内**的重复 ⇒ 由 pair 判组 + 相似度地板处理（10-21 已上线）；
 * · ★ **跨批次**的重复（昨天发过、今天又发）⇒ **总审结构上看不见**
 *   （它只拿到本轮 15 条）⇒ **一直没处理**。
 *
 * 实测证据（5 个批次 2109 篇）：「贝莱因…以 207 亿美元收购 Perfectum」（10-20 批）与
 * 「维欧恩以 2.07 亿美元收购 Perfectum」（10-19 批）是**同一件事，隔了一天分两批发**。
 *
 * ## 口径：**只识别，不删**
 *
 * ⇒ 相似度只用来**筛出「可能重复」的稿子**并把**已发过的标题**一起交给总审，
 *   **由总审决定要不要重复发**。理由：
 * · 总审有**原文对照**（`original_content`），它能判断「这俩是不是同一件事」；
 * · 总审还知道**哪条是重大事件**（`relevanceScore` 在线上恒为 0，**不能**当判据）；
 * · 而「昨天发过、今天又发」**有时是合理的**（事件有进展）⇒ 机械删会误删真稿。
 *
 * ## 地板为什么是 0.40
 *
 * 实测分档（人工判读）：`[0.20,0.24)` 真重复率 21%｜`[0.24,0.28)` 30%｜
 * `[0.28,0.34)` 52%｜`[0.34,0.46)` **75%**。
 * ⇒ 0.40 落在最后一档里（约 70–80% 真重复）⇒
 *   · 比同批次的 0.28 **激进**（用户口径是「宁多勿少，重复别太多」）⇒
 *   · 比 0.30–0.40 那一档（**一半误报**）**保守**。
 * ⚠️ 而**真正的把关在总审**（它有原文对照）⇒ 这道闸只负责「把可能的挑出来」。
 */
import { similarity } from './utils';

/** 跨批次的相似度地板（见上面的分档实测）。 */
export const CROSS_BATCH_SIM_FLOOR = 0.4;

/** 一条「可能与最近发过的稿子重复」的记录。 */
export interface CrossBatchHit {
  /** 在**本轮候选**里的下标 */
  index: number;
  /** 本轮那条的标题 */
  title: string;
  /** 最近发过的那条的标题 */
  matchedTitle: string;
  /** 相似度 */
  sim: number;
}

/**
 * 找出「与最近发过的稿子高度相似」的本轮候选。
 *
 * @param candidates 本轮候选的标题（顺序即下标）
 * @param recentTitles 最近发过的稿子的标题
 * @param floor 相似度地板
 */
export function findCrossBatchDuplicates(
  candidates: string[],
  recentTitles: string[],
  floor: number = CROSS_BATCH_SIM_FLOOR,
): CrossBatchHit[] {
  const hits: CrossBatchHit[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < candidates.length; i++) {
    const t = candidates[i] || '';
    if (!t) continue;
    let best = { sim: 0, title: '' };
    for (const r of recentTitles) {
      if (!r) continue;
      const s = similarity(t, r);
      if (s > best.sim) best = { sim: s, title: r };
    }
    if (best.sim < floor) continue;
    // 同一稿只记一次（取最像的那条已发稿）
    const key = `${i}|${best.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ index: i, title: t, matchedTitle: best.title, sim: best.sim });
  }
  return hits.sort((a, b) => b.sim - a.sim);
}

/**
 * 挑出「最近发过、但**不是本轮**」的标题。
 *
 * ⚠️ 「不是本轮」这件事**必须显式排除** ⇒ 否则同一件事在**本轮内部**就会
 * 被当成「跨批次重复」⇒ 既浪费总审的注意力，又会让计数虚高。
 *
 * @param recentTitles 库里查到的标题（带本轮标记）
 */
export function excludeCurrentBatch(
  recentTitles: Array<{ title: string; isCurrentBatch: boolean }>,
): string[] {
  return recentTitles.filter((r) => !r.isCurrentBatch && r.title).map((r) => r.title);
}
