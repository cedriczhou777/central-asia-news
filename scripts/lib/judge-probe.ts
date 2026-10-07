/**
 * 体检响应里「这一国到底算不算答了」的判据 —— **所有读 `llmJudge[]` 的脚本共用这一份**。
 *
 * ## 为什么必须共享（2026-10-07 实测，代价是一份看着很完整的假汇总）
 *
 * 判据原先在 `analyze-recall-floor.ts` 里是这么写的：
 *
 *     (r.llmJudge ?? []).filter((c) => c.ran && !c.error)
 *
 * 它把**两件完全不同的事**混成了「没跑成」：
 *
 * 1. **模型调用真的没成功** —— 429、非法 JSON。这类确实该剔除。
 * 2. **模型答完了、而且判出了一堆「是」，只是其中一条链超过大组上限被整簇否掉。**
 *    `same-event.ts` 在 pair 模式下一旦 `filterOversizedGroups` 否掉任何一簇，就会写
 *    `judgedError = 有 N 个簇因超过 MAX_GROUP_SIZE 条被整簇丢弃（模型的判定在传递）`
 *    —— **覆盖**在同一字段上。它是一条**护栏提示**，不是调用失败。
 *
 * 第 2 类恰恰是对照实验**最想看的信号**（模型在借相似度传递），却被当成「没跑成」剔掉了。
 *
 * 实测后果：`days=3&provider=zhipu-flash` 那一轮，5 国**全部** `ran=true` 且
 * `provider=zhipu-flash`、`judgedPairs` 分别是 5/8/18/13/46 —— 全都答了，
 * 但旧判据只留下 1 国（kz），于是对照实验实际只比了 **1/5 的国家**，
 * 脚本却照常打出「共消掉 4 对」这样一份**像模像样的汇总**。这正是本项目反复栽的
 * 「仪器自己撒谎」：不报错、不变红，只给一个假的确定感。
 *
 * ## 正确的判据：不问文本，只问事实
 *
 * `provider` 只在**调用成功且解析出结果**时才被带上
 * （`same-event.ts`：`if (judgedProvider) llm.provider = judgedProvider;`，
 * 而 `judgeExplicitPairs` 的「调用失败」与「非法 JSON」两个早退分支都不带它）。
 * 于是：
 *
 * - 有 `provider` ⇒ 答了（**不管 `error` 里写了什么**）；
 * - 没 `provider` 但**候选对本身就是 0** ⇒ 没有对可问，不算失败，也算答了；
 * - 其余 ⇒ 没答成。
 *
 * ⚠️ 这里**刻意不去解析 `error` 的文本**判断它属于哪一类。
 * 一旦靠字符串嗅探，服务端改一个措辞就会静默改变分母 ——
 * 那是同一个坑的另一种写法。提示文本只当**信息**原样打出来。
 */
export type JudgeProbeRow = {
  country?: string;
  /** `same-event.ts` 进入模型分支时置 true（确定性闸之后不足 2 条则一直是 false） */
  ran?: boolean;
  /** 只在**调用成功且解析出结果**时才有值 —— 它是「答了」的充分条件 */
  provider?: string;
  /** 召回层选出来要问模型的对数 */
  candidatePairs?: number;
  /** 服务端附的提示：可能是调用失败，也可能是大组护栏的消息 */
  error?: string;
};

/** 这一国的判定能不能进对照分母。 */
export function isJudgeAnswered(c: JudgeProbeRow): boolean {
  if (c.ran !== true) return false;
  if (c.provider !== undefined) return true;
  // 没有候选对 = 没有可问的东西，不是调用失败。
  return (c.candidatePairs ?? 0) === 0;
}

/** 为什么没答成 —— 只在 `isJudgeAnswered` 为 false 时有意义。 */
export function whyNotAnswered(c: JudgeProbeRow): string {
  if (c.ran !== true) return '没跑（确定性闸之后不足 2 条，或这一国被跳过）';
  return `召回层选了 ${c.candidatePairs ?? 0} 对，但模型没答成（限流 / 非法 JSON）`;
}

export type JudgeDenominator = {
  /** 可对照的国家 */
  answered: JudgeProbeRow[];
  /** 不可对照的国家（附原因） */
  notAnswered: Array<{ row: JudgeProbeRow; reason: string }>;
  /**
   * 答了、但服务端另附了提示的国家。
   *
   * **它们已经是 `answered` 的成员**，列出来只为提醒：这条提示不参与分母，
   * 别拿它当剔除理由。哪一类提示要靠看文本判读，本模块不替你判。
   */
  guardNoticed: JudgeProbeRow[];
};

/** 把 `llmJudge[]` 按「能不能进对照分母」切开。 */
export function splitJudgeRows(rows: JudgeProbeRow[]): JudgeDenominator {
  const answered: JudgeProbeRow[] = [];
  const notAnswered: Array<{ row: JudgeProbeRow; reason: string }> = [];
  for (const row of rows) {
    if (isJudgeAnswered(row)) answered.push(row);
    else notAnswered.push({ row, reason: whyNotAnswered(row) });
  }
  return {
    answered,
    notAnswered,
    guardNoticed: answered.filter((r) => r.error !== undefined && r.error !== ''),
  };
}
