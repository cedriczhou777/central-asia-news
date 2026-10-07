/**
 * 「这一国算不算答了」判据的回归测试，含**双向**验证。
 *
 * 用法：`pnpm test:judge-probe`（离线、不联网）
 *
 * ## 它守的是什么
 *
 * 2026-10-07 的实测缺陷：`analyze-recall-floor.ts` 用 `c.ran && !c.error` 当
 * 「答了」的判据，把**大组护栏的提示**（模型答完了、只是一条链超过 4 条被整簇否掉）
 * 当成「模型没跑成」，于是 5 国里剔掉 4 国，对照实验只在 1 个国家上做，
 * 却照常打出一份完整的汇总。判据已收进 `scripts/lib/judge-probe.ts`。
 *
 * ## 为什么 fixture 用的是**线上真实那一轮**的原始行
 *
 * 因为这条 bug 的全部要害是**字段的组合**：`ran=true` 与 `error` 有值
 * **同时成立**时，旧判据才误判。自己编的行很容易编成「要么有 provider 要么有 error」，
 * 那样新判据和旧判据会得出相同的结果 —— 测试看着绿，其实什么都没守。
 * 下面第 ④ 条就是防这个的：断言 fixture 里**确实存在**
 * 「provider 与 error 同时有值」的行。
 *
 * ## 双向验证
 *
 * 第 ③ 条把**旧判据**写进测试里，断言它在同一批真实数据上得出**不同**的答案。
 * 一条判据的绿灯，必须先在旧写法上跑一次、看它变红，才算数 ——
 * 本项目已经栽过一次「回归断言自己恒真」。
 */
import { isJudgeAnswered, splitJudgeRows, whyNotAnswered, type JudgeProbeRow } from './lib/judge-probe';

let passed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = '') {
  if (cond) passed++;
  else failures.push(detail ? `${name} —— ${detail}` : name);
}

const GUARD_MSG = '有 1 个簇因超过 4 条被整簇丢弃（模型的判定在传递）';

/**
 * 线上真实那一轮（2026-10-07，`days=3&llm=1&provider=zhipu-flash&pv=3&limit=60`）
 * 逐国抄下来的字段。`judgedPairs` 5/8/18/13/46 说明**每一国都答了**。
 */
const LIVE_ROWS: JudgeProbeRow[] = [
  { country: 'kz', ran: true, provider: 'zhipu-flash', candidatePairs: 13 },
  { country: 'uz', ran: true, provider: 'zhipu-flash', candidatePairs: 28, error: GUARD_MSG },
  { country: 'az', ran: true, provider: 'zhipu-flash', candidatePairs: 30, error: GUARD_MSG },
  { country: 'kg', ran: true, provider: 'zhipu-flash', candidatePairs: 24, error: GUARD_MSG },
  { country: 'tj', ran: true, provider: 'zhipu-flash', candidatePairs: 46, error: GUARD_MSG },
];

/** 旧判据的原文，只在这一处出现，用来做反证。 */
const oldCriterion = (c: JudgeProbeRow) => c.ran && !c.error;

// ----- ① 真实数据上：5 国全部算「答了」 -----

{
  const answered = LIVE_ROWS.filter(isJudgeAnswered);
  ok('★ 线上那一轮 5 国**全部**算「答了」', answered.length === 5, `只留下 ${answered.length} 国`);
  ok(
    '  逐国判定与预期一致',
    LIVE_ROWS.every((r) => isJudgeAnswered(r)),
    LIVE_ROWS.filter((r) => !isJudgeAnswered(r))
      .map((r) => r.country)
      .join(','),
  );
}

// ----- ② 大组护栏的提示不参与分母 -----

{
  const withGuard = LIVE_ROWS.filter((r) => r.error === GUARD_MSG);
  ok('② fixture 里有 4 国带大组护栏的提示', withGuard.length === 4, `只有 ${withGuard.length}`);
  ok(
    '② 带护栏提示的国家**照样**算答了（提示不是调用失败）',
    withGuard.every(isJudgeAnswered),
    withGuard
      .filter((r) => !isJudgeAnswered(r))
      .map((r) => r.country)
      .join(','),
  );
}

// ----- ③ 反证：旧判据必须在同一批数据上得出**不同**的答案 -----

{
  const oldKept = LIVE_ROWS.filter(oldCriterion).length;
  const newKept = LIVE_ROWS.filter(isJudgeAnswered).length;
  ok(
    '★ 旧判据 `ran && !error` 在同一批真实数据上**只留下 1 国**（这就是那个缺陷）',
    oldKept === 1,
    `旧判据留下 ${oldKept} 国 —— 若这里变了，说明 fixture 或旧判据被改过，反证失效`,
  );
  ok(
    '★ 新旧判据结论**不同**（差值恰为 4）⇒ 这条测试真的在守东西，不是恒真',
    newKept !== oldKept && newKept - oldKept === 4,
    `旧 ${oldKept} vs 新 ${newKept}`,
  );
}

// ----- ④ 规则非空转：fixture 里必须真有「provider 与 error 同时有值」的行 -----

{
  const both = LIVE_ROWS.filter((r) => r.provider !== undefined && r.error !== undefined);
  ok(
    '★ fixture 里存在「provider 与 error 同时有值」的行（否则新判据与旧判据会得出相同结论，测试形同虚设）',
    both.length >= 1,
    `只有 ${both.length} 行同时有两者`,
  );
}

// ----- ⑤ 反向自检：`provider` 真的在参与判定 -----

{
  const answeredRow = LIVE_ROWS[1];
  ok(
    '★ 反向自检：抹掉 provider 之后，同一行（候选对 28）必须变成「没答成」',
    isJudgeAnswered(answeredRow) && !isJudgeAnswered({ ...answeredRow, provider: undefined }),
    `抹掉后仍是 ${isJudgeAnswered({ ...answeredRow, provider: undefined })}`,
  );
}

// ----- ⑥ 零候选对不是失败 -----

{
  const none: JudgeProbeRow = { country: 'kz', ran: true, candidatePairs: 0 };
  ok('⑥ 候选对为 0 的国家算「答了」（没有对可问，不是调用失败）', isJudgeAnswered(none));
  ok(
    '⑥ 它不报 provider —— 与 `verify-knobs-live` 里那条断言是同一个事实',
    none.provider === undefined,
  );
}

// ----- ⑦ 真失败：没有 provider 但有候选对 -----

{
  const failed: JudgeProbeRow = {
    country: 'uz',
    ran: true,
    candidatePairs: 28,
    error: 'HTTP 429 访问量过大',
  };
  ok('⑦ 有候选对却没有 provider ⇒ 算「没答成」', !isJudgeAnswered(failed));
  ok(
    '⑦ 原因里同时出现对数与「没答成」，看得出是限流/非法 JSON 那一类',
    /28/.test(whyNotAnswered(failed)) && /没答成/.test(whyNotAnswered(failed)),
    whyNotAnswered(failed),
  );
}

// ----- ⑧ 压根没跑 -----

{
  ok('⑧ `ran` 为 false ⇒ 不算答了', !isJudgeAnswered({ country: 'kg', ran: false, candidatePairs: 5 }));
  ok('⑧ `ran` 缺省 ⇒ 不算答了', !isJudgeAnswered({ country: 'kg', candidatePairs: 5 }));
  ok(
    '⑧ 原因文案是「没跑」而不是「没答成」——两者含义不同',
    /没跑/.test(whyNotAnswered({ country: 'kg', ran: false, candidatePairs: 5 })),
  );
}

// ----- ⑨ splitJudgeRows 的两组切得对 -----

{
  const d = splitJudgeRows(LIVE_ROWS);
  ok('⑨ answered 是 5 国', d.answered.length === 5, String(d.answered.length));
  ok('⑨ notAnswered 为空', d.notAnswered.length === 0, String(d.notAnswered.length));
  ok(
    '⑨ guardNoticed 恰是带提示的那 4 国，且它们是 answered 的子集',
    d.guardNoticed.length === 4 &&
      d.guardNoticed.every((r) => r.error === GUARD_MSG) &&
      d.guardNoticed.every((r) => d.answered.includes(r)),
    d.guardNoticed.map((r) => r.country).join(','),
  );

  const mixed = splitJudgeRows([
    ...LIVE_ROWS,
    { country: 'xx', ran: true, candidatePairs: 7, error: 'HTTP 429' },
    { country: 'yy', ran: false },
  ]);
  ok('⑨ 混入真失败与没跑的行之后，answered 仍是 5', mixed.answered.length === 5);
  ok(
    '⑨ notAnswered 收到 2 条且各自带了原因',
    mixed.notAnswered.length === 2 && mixed.notAnswered.every((x) => x.reason.length > 0),
    mixed.notAnswered.map((x) => `${x.row.country}:${x.reason}`).join(' / '),
  );
}

// ----- 汇总 -----

console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
