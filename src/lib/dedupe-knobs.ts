/**
 * 体检接口的「召回层」对照旋钮：`cand` / `minside` / `prisim`。
 *
 * ## 为什么要有这个文件（2026-10-07）
 *
 * `JudgeOptions` 里**早就有** `minSim` / `maxPairs` / `prioritySim` 三个字段，
 * 而且注释写明它们的理由是「让**召回层**也能被单独钉住做对照」——
 * 但 `/api/dedupe-check` 从来没把它们接出来过（`pv=` / `judge=` / `mode=` 都接了，
 * 偏偏这三个没接）。于是 2026-10-06 量出**「批的大小与组成会改变判定」**
 * （见 `scripts/fixtures/judge-gold.json` 的 `_⚠️使用时三条硬规矩` 第 1 条：
 * 同一对 [14] 在 15 对语料里稳定判「否」、在 23 对语料里稳定判「是」）之后，
 * **手上没有任何工具能在生产形态的批次上验证任何一个修法**：
 *
 * - 唯一能改批大小的入口是 `POST /api/judge-pairs`，但它走「显式配对」形态
 *   （把每对的标题摊平成 2N 个条目再编号），而生产是**从文章列表编号再给配对** ——
 *   **两种形态的绝对数字不能对照**（`scripts/analyze-judge-order.ts` 头部已写明）；
 * - 而且它还有 `MAX_PAIRS = 40` 的硬上限，**小于**生产的 `PAIR_MAX_CANDIDATES = 48`，
 *   ⇒ 连生产那批 48 对都复现不出来（AGENTS 的 R-5b 记的就是这个缺口）。
 *
 * 所以这个文件做的是**把已经声明过的意图接上线**，不是新增判据、不改任何默认值。
 * 生产链路（`fetch-news` / `wechat/push`）**永远不传**这三个旋钮。
 *
 * ## 与 `pv=` 同一条规矩
 *
 * **非法值当场 400，绝不静默回退。** 静默回退会让 `cand=99999` 这类手误跑出一个
 * 「看起来正常」的默认值结果，而那正是这套参数要消灭的「分不清跑的是哪一档」
 * —— 见 `dedupe-check/route.ts` 里 `pv=` 那段注释的同一理由。
 *
 * ## 2026-10-07 补：通道旋钮 `provider=`
 *
 * 同一个入口还必须能**钉住模型通道**。理由与召回层三旋钮一样是「钉住要研究的变量」：
 * 降级链按 `PROVIDERS` 顺序取第一个不报错的通道，而「谁不报错」取决于这一刻谁被 429
 * 限流 —— 实测同一次 A/B 的两臂落到了不同通道。而通道间差 **5.07 对**、
 * 通道内标准差 **0.09**（差 50 倍）⇒ 钉住了批大小却放开了型号，等于只钉了一半。
 */

/**
 * 一个旋钮的取值域。
 *
 * ⚠️ `lo` / `hi` 一律取**自然定义域**或**可量化理由**下的范围，不许拍脑袋：
 * - `minSim` / `prioritySim` 的定义域就是 `similarity()` 的值域 `[0, 1]`
 *   （0 = 任意两条都成候选对，1 = 一对都不会有），所以边界不是选出来的；
 * - `maxPairs` 的上限只控制**提示词长度**：每行 `编号 | 标题A || 标题B`（标题截断 80 字）
 *   ≈ 170 字符，48 行 ≈ 8.2 KB、200 行 ≈ 34 KB，都远在 200K 上下文之内；
 *   再大写没有实测意义（生产实测的「≥0.35 对数最大」是 44）。
 */
export interface PairRecallKnobSpec {
  /** 查询参数名（对外口径） */
  param: 'minside' | 'prisim' | 'cand';
  /** 落到 `JudgeOptions` 上的字段名（对内口径） */
  field: 'minSim' | 'prioritySim' | 'maxPairs';
  integer: boolean;
  lo: number;
  hi: number;
  why: string;
}

export const PAIR_RECALL_KNOB_SPECS: readonly PairRecallKnobSpec[] = [
  {
    param: 'minside',
    field: 'minSim',
    integer: false,
    lo: 0,
    hi: 1,
    why: '定义域就是 similarity() 的值域 [0,1]，所以 0 和 1 都是合法端点（不是选出来的阈值）',
  },
  {
    param: 'prisim',
    field: 'prioritySim',
    integer: false,
    lo: 0,
    hi: 1,
    why: '同 minside；实际生效值是 max(minside, prisim)，见 selectCandidatePairs',
  },
  {
    param: 'cand',
    field: 'maxPairs',
    integer: true,
    lo: 1,
    hi: 200,
    why: '上限只控制提示词长度：48 行 ≈ 8.2 KB、200 行 ≈ 34 KB，都在 200K 上下文内',
  },
];

/** 解析结果里「这次真的覆盖了哪几档」——用于「声明 vs 实际」对照。 */
export interface PairRecallKnobValues {
  minSim?: number;
  prioritySim?: number;
  maxPairs?: number;
}

export type ParsePairRecallKnobsResult =
  | { ok: true; values: PairRecallKnobValues; applied: PairRecallKnobSpec['param'][] }
  | { ok: false; error: string };

/**
 * 从查询参数解析三个召回层旋钮。
 *
 * 未传（或传空串）⇒ 该项**不出现在** `values` 里 ⇒ `selectCandidatePairs` 用它自己的
 * 默认参数值（`undefined` 会触发默认值，与「不传」完全等价）。
 * 传了但非法 ⇒ `ok: false`，由路由当场 400。
 */
export function parsePairRecallKnobs(params: URLSearchParams): ParsePairRecallKnobsResult {
  const values: PairRecallKnobValues = {};
  const applied: PairRecallKnobSpec['param'][] = [];

  for (const spec of PAIR_RECALL_KNOB_SPECS) {
    const raw = params.get(spec.param);
    if (raw === null || raw.trim() === '') continue; // 未传 / 传空 = 用默认值

    const text = raw.trim();
    const n = Number(text);
    const bad =
      !Number.isFinite(n) ||
      (spec.integer && !Number.isInteger(n)) ||
      n < spec.lo ||
      n > spec.hi;

    if (bad) {
      const 域 = spec.integer ? `${spec.lo}–${spec.hi} 的整数` : `${spec.lo}–${spec.hi} 的实数`;
      return {
        ok: false,
        error: `参数 ${spec.param}=${text} 非法：需要 ${域}。${spec.why}。`,
      };
    }

    // 逐字段赋值而不是展开 `{ [spec.field]: n }` —— 后者会把 field 推成 string，
    // 与 `PairRecallKnobValues` 的显式字段类型对不上（TS 会报索引签名错）。
    if (spec.field === 'minSim') values.minSim = n;
    else if (spec.field === 'prioritySim') values.prioritySim = n;
    else values.maxPairs = n;
    applied.push(spec.param);
  }

  return { ok: true, values, applied };
}

/**
 * 通道旋钮 `provider=` 的解析结果。
 *
 * `usable` 由调用方传入（= `availableProviderNames()`）而不是在这里 import：
 * 一来让本模块**不依赖 `translate.ts`**（离线测试不需要任何环境变量），
 * 二来「可用通道清单」是运行时事实，写死在库里迟早和 `PROVIDERS` 分叉。
 */
export type ParseProviderOnlyResult =
  | { ok: true; only?: string }
  | { ok: false; error: string };

export function parseProviderOnly(params: URLSearchParams, usable: string[]): ParseProviderOnlyResult {
  const raw = params.get('provider');
  if (raw === null || raw.trim() === '') return { ok: true }; // 未传 / 空串 = 走完整降级链

  const name = raw.trim();
  if (!usable.includes(name)) {
    return {
      ok: false,
      error: `未知的模型通道 provider=${name}；可用：${usable.join(', ')}`,
    };
  }
  return { ok: true, only: name };
}

/**
 * 召回层旋钮解析器的**活体探针** —— 给推送端 `codeVersion.dedupeKnobProbe` 用。
 *
 * 为什么要活体：本项目已经栽过一次「手写的 `true` 在代码被删掉之后依然是 `true`」
 * （见 `cyrillicLatinGateProbe` 的注释）。这里当场把**每个旋钮的两个边界各过一遍**
 * 并**核对返回值**，再把「越界必须被拒」也过一遍 ——
 * 判据被删会编译不过，被改坏则字符串里的 `✓` 会变成 `✗`。
 *
 * ⚠️ 刻意**不写**成 `dedupeKnobs: 'cand,minside,prisim'` 这样的名字清单：
 * 名字清单只能证明「有人写了这几个字」，证明不了「边界判对了」——
 * 而边界正是最容易错的地方（`0.7` 是 `0.75` 的前缀、`1` 是 `10` 的前缀，
 * 这类前缀式判据天生会撒谎，见 `DEPLOY_WECHAT_CLOUD.md` 里那次假报「新版已上线」）。
 */
export function pairRecallKnobProbe(): string {
  const parts: string[] = [];
  for (const spec of PAIR_RECALL_KNOB_SPECS) {
    const marks: string[] = [];

    // 两个边界值：必须被接受，且**返回值与传入值相等**
    for (const edge of [spec.lo, spec.hi] as const) {
      const r = parsePairRecallKnobs(new URLSearchParams(`${spec.param}=${edge}`));
      const got = r.ok ? r.values[spec.field] : undefined;
      marks.push(got === edge ? '✓' : `✗(应=${edge} 得=${r.ok ? got : '拒绝'})`);
    }

    // 两侧越界：必须**都被拒绝**（只测一侧会漏掉单边符号错误）
    for (const out of [spec.lo - 1, spec.hi + 1] as const) {
      const r = parsePairRecallKnobs(new URLSearchParams(`${spec.param}=${out}`));
      marks.push(r.ok ? `✗(应拒绝 ${out} 却收下)` : '✓');
    }

    // 非数字：必须被拒绝（`Number('')` / `Number('abc')` 的坑）
    const nan = parsePairRecallKnobs(new URLSearchParams(`${spec.param}=abc`));
    marks.push(nan.ok ? '✗(应拒绝 abc 却收下)' : '✓');

    parts.push(`${spec.param}[lo/hi/越界/非数字]=${marks.join('')}`);
  }

  // 全缺省必须「一项都不覆盖」—— 这是「生产不传旋钮」那条约定的可执行版本
  const none = parsePairRecallKnobs(new URLSearchParams());
  parts.push(`全缺省→applied=${none.ok ? none.applied.length : '✗'}`);

  // 通道旋钮：用一个**固定的假清单**跑，不依赖真实 PROVIDERS
  //（真实清单会随通道增减而变，把真实清单写进哨兵会让哨兵跟着漂）
  const fake = ['chan-a', 'chan-b'];
  const marks: string[] = [];
  const good = parseProviderOnly(new URLSearchParams('provider=chan-a'), fake);
  marks.push(good.ok && good.only === 'chan-a' ? '✓' : '✗(在册通道被拒或没传下去)');
  const bad = parseProviderOnly(new URLSearchParams('provider=chan-z'), fake);
  marks.push(bad.ok ? '✗(不在册通道被收下)' : '✓');
  const absent = parseProviderOnly(new URLSearchParams(), fake);
  marks.push(absent.ok && absent.only === undefined ? '✓' : '✗(缺省竟钉住了通道)');
  parts.push(`provider[在册/不在册/缺省]=${marks.join('')}`);

  return parts.join(' · ');
}
