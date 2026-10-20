/**
 * 「量级」确定性校验（2026-10-20）—— 抓「模型把十亿当成亿」这一类错。
 *
 * ## 起因（真实语料实测，不是设想）
 *
 * 2026-10-20 在真实批次上抓到 **系统性**的错误：
 *
 * | 原文 | 正确中文 | 译文 | |
 * |---|---|---|---|
 * | `12 млрд` / `12 billion` | **120 亿** | 「12 亿」 | ❌ 少一个零 |
 * | `8 млрд` / `8 миллиардов` | **80 亿** | 「8 亿」 | ❌ |
 * | `3 млрд` | **30 亿** | 「3 亿」 | ❌ |
 * | `200 млн` | **2 亿** | 「2000 万」 | ❌ 少 10 倍 |
 * | `30 млн` | **3000 万** | 「30 万」 | ❌ 少 100 倍 |
 *
 * ⇒ ★ **根因：模型缺少「1 十亿 = 10 亿」「1 百万 = 100 万」这一步换算** ——
 * 它把「billion / млрд」**直接当成「亿」**来写。
 * ⇒ 而 `translate.ts` 的提示词里**已经有**这条规则（`:601`「「млрд」/「十亿」= 十亿」）
 * ⇒ **光靠提示词压不住**（这已是本项目第 N 次「提示词写了却仍然发生」）。
 *
 * ## 为什么这道闸**敢开**
 *
 * ① **误报后果很轻**：它只判「这篇的数字对不上」，而处置是**打回重译**，
 *    **不是删稿** ⇒ 判错只是多花一次翻译费，不会丢掉一篇稿子。
 * ② **判据是纯机械的**：两边都归一到基本单位再比，不需要模型、不需要对齐。
 * ③ **实测误报为 0**：1485 篇真实语料里，命中项逐条人工读过。
 *
 * ## 它**不做什么**（边界必须写清）
 *
 * · **不删稿、不改稿** —— 它只说「这篇的数字与原文对不上」。
 * · **不判断「哪个数错了」** —— 只报「原文这个值在译文里找不到接近的」。
 * · **译文侧没有带量级词的数时一律跳过** ——
 *   原文提到某个数、译文没提（漏译）**不是量级错**，那是另一类问题。
 * · 「带量级词」只认 **中文的「亿 / 万」** 与 **原文的
 *   `млрд/миллиард/billion`、`млн/миллион/million`、`тыс/тысяч/thousand`**
 *   —— 纯数字（如「55000 索姆」）**不算量级词**，因为它没有歧义。
 */

/** 中文侧的「带量级词」的数。 */
const CN_SCALED: Array<{ re: RegExp; mult: number; label: string }> = [
  { re: /([\d][\d.,]*)\s*亿/g, mult: 1e8, label: '亿' },
  { re: /([\d][\d.,]*)\s*万/g, mult: 1e4, label: '万' },
];

/** 原文侧的「带量级词」的数。★ 换算关系是确定的：1 млрд = 10 亿、1 млн = 100 万。 */
const RAW_SCALED: Array<{ re: RegExp; mult: number; label: string }> = [
  { re: /([\d][\d.,]*)\s*(?:млрд|миллиард|billion)/gi, mult: 1e9, label: '十亿' },
  { re: /([\d][\d.,]*)\s*(?:млн|миллион|million)/gi, mult: 1e6, label: '百万' },
  { re: /([\d][\d.,]*)\s*(?:тыс|тысяч|thousand)/gi, mult: 1e3, label: '千' },
];

/**
 * 解析数字串。⚠️ **俄语/乌兹别克语用逗号作小数点**（「15,5 млн」= 15.5 million），
 * 而英文用点 ⇒ **同一个字符在两种语言里含义不同**。
 * 判据：**逗号后面只有 1–2 位数字 ⇒ 小数点；否则 ⇒ 千分位**（3 位就该是千分位）。
 */
export function parseAmount(raw: string): number {
  let t = raw.replace(/\s/g, '');
  t = t.replace(/,/g, (_m, off: number) => {
    const after = t.slice(off + 1);
    return /^\d{1,2}$/.test(after) ? '.' : '';
  });
  t = t.replace(/[^\d.]/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

export interface ScaledAmount {
  /** 换算到基本单位后的值 */
  value: number;
  /** 量级词的标签（中文侧是「亿/万」，原文侧是「十亿/百万/千」） */
  label: string;
  /** 原文里的写法（留痕用） */
  raw: string;
}

/**
 * 归一**俄语式千分位**：`1 072 млрд` 里的空格是千分位，不是分隔符。
 *
 * ⚠️ 不做这一步，正则只会抓到 `072`（把 `1 072` 当成两个数）⇒
 * 算出来的值差 10 倍 ⇒ 判据整个失效（`1 072 млрд` 那个用例就是这么红的）。
 * ⚠️ 判据：`数字 + 空格 + 恰好 3 位数字 + 非数字` ⇒ 空格是千分位。
 * 「12 млрд」后面不是 3 位数字 ⇒ 不受影响。
 */
function normalizeThousands(text: string): string {
  return text.replace(/(\d)\s(\d{3})(?![\d])/g, '$1$2');
}

function collectScaled(text: string, table: typeof CN_SCALED): ScaledAmount[] {
  const out: ScaledAmount[] = [];
  const src = normalizeThousands(text);
  for (const { re, mult, label } of table) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of src.matchAll(g)) {
      const n = parseAmount(String(m[1] ?? ''));
      if (!Number.isFinite(n) || n === 0) continue;
      out.push({ value: n * mult, label, raw: m[0].trim() });
    }
  }
  return out;
}

export interface MagnitudeMismatch {
  /** 原文里的那个值（换算到基本单位） */
  raw: ScaledAmount;
  /** 译文里最接近它的那个值 */
  closest: ScaledAmount | null;
  /** 差了几倍（closest/raw） */
  ratio: number;
}

/**
 * 找出「原文的量级词数值在译文里找不到接近的」。
 *
 * ⚠️ **只在译文侧也有带量级词的数时才判** —— 否则「原文提到、译文没提」会被误当成量级错。
 */
export function findMagnitudeMismatches(
  originalText: string,
  translatedText: string,
): MagnitudeMismatch[] {
  const raws = collectScaled(originalText, RAW_SCALED);
  if (!raws.length) return [];
  const cns = collectScaled(translatedText, CN_SCALED);
  // 译文侧一个带量级词的数都没有 ⇒ 不判（那是「漏译」，不是量级错）
  if (!cns.length) return [];

  const out: MagnitudeMismatch[] = [];
  for (const r of raws) {
    // ① **每个原文值只配「最接近的那个」译文值** ——
    //    跨所有组合会制造额外命中（原文 3 个数 × 译文 4 个数 = 12 种组合）。
    let best: ScaledAmount | null = null;
    let bestDiff = Infinity;
    for (const c of cns) {
      const diff = Math.abs(c.value - r.value);
      if (diff < bestDiff) { bestDiff = diff; best = c; }
    }
    if (!best) continue;
    // ② 判定：**比值恰好是 10 的整数次幂**。
    //
    // 为什么（2026-10-20 在 1485 篇真实语料上逐条读过 47 条命中之后才定下来的）：
    // · **真错**的形态是「量级词降了一档」⇒ 比值**恰好**是 10 / 100 / 1000
    //   （`12 млрд`→「12 亿」=10；`500 тыс`→「5 亿」=1000；`30 млн`→「30 万」=100）。
    // · **误报**的形态是「原文的另一个数在译文里根本没出现」
    //   （`25 тыс` 对上「3100 亿」⇒ 比值 1.2e7，**不是 10 的幂**）。
    // ⇒ 用「比值是 10 的幂」当判据，**把全部误报都排除了**，
    //   代价是漏掉少数「数字本身也变了」的真错（比值不是 10 的幂）——
    //   **宁可漏，不可误**（误报会打回重译，真错漏了只是没修好）。
    const ratio = r.value > 0 ? best.value / r.value : 0;
    if (ratio <= 0) continue;
    const lg = Math.log10(ratio);
    const isPowerOfTen = Math.abs(lg - Math.round(lg)) < 0.02 && Math.round(lg) !== 0;
    if (!isPowerOfTen) continue;
    out.push({ raw: r, closest: best, ratio: Math.max(ratio, 1 / ratio) });
  }
  return out;
}

/** 一句话描述（给日志与审计用）。 */
export function describeMagnitudeMismatch(m: MagnitudeMismatch): string {
  const c = m.closest;
  return (
    `原文「${m.raw.raw}」= ${m.raw.value.toLocaleString()}（${m.raw.label}），` +
    `译文里最接近的是「${c?.raw ?? '（无）'}」= ${c ? c.value.toLocaleString() : '-'}（${c?.label ?? '-'}），` +
    `差 ${m.ratio >= 1000 ? (m.ratio / 1000).toFixed(1) + ' 千倍' : m.ratio.toFixed(1) + ' 倍'}`
  );
}