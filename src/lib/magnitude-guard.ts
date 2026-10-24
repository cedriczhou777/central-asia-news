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

/**
 * 原文侧的「带量级词」的数。★ 换算关系是确定的：1 млрд = 10 亿、1 млн = 100 万。
 *
 * ⚠️⚠️ **词表必须覆盖各源语言的当地写法**（2026-10-24 实测补的）：
 * 1995 篇真实语料里，原文实际出现的量级词有 **15 种写法**，而只看「млн/млрд/тыс」
 * 会漏掉这些**当地写法**：
 * · `milyard`（**38 次**，阿塞拜疆/土耳其语的「十亿」）
 * · `milyon`（**33 次**，土耳其语的「百万」）
 * · `mlrd`（**14 次**，哈萨克/乌兹别克语的「十亿」）
 * · `mln`（3 次，乌兹别克语的「百万」）← **用户报的「207 亿」就是它**
 * ⇒ 漏掉它们 ⇒ **阿塞拜疆的「十亿」类错误必然反复发生**（az 是 5 国之一）。
 *
 * ⚠️ 词形变化（复数/格）用**前缀匹配**覆盖：`миллионов`/`миллиона`/`тысячи`/`тысячах`
 * 都能被 `миллион`/`тысяч` 匹配上（正则不做词尾锚定 ⇒ 多余的后缀被忽略）。
 * ⚠️ 顺序上**长写法在前**（`milyard` 先于 `mln`），避免短写法先吃掉前缀。
 */
const RAW_SCALED: Array<{ re: RegExp; mult: number; label: string }> = [
  // 十亿：俄/乌/哈/土/阿塞拜疆的各种写法
  { re: /([\d][\d.,]*)\s*(?:млрд|миллиард|billion|milyard|milyar|mlrd)/gi, mult: 1e9, label: '十亿' },
  // 百万：俄/乌/哈/土/阿塞拜疆的各种写法
  { re: /([\d][\d.,]*)\s*(?:млн|миллион|million|milyon|mln)/gi, mult: 1e6, label: '百万' },
  // 千
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
  /**
   * **数值部分**（去掉量级词与分隔符后的数字，如 `207 млн` ⇒ `207`）。
   *
   * ⚠️ 为什么要单独留它（2026-10-24 实测发现）：一篇稿子里常有**多个**量级词，
   * 而译文里对应的数**可能根本没被译出来** ⇒ 于是「取最接近的译文值」会配到
   * **另一个数**上（实测：`5,5 тыс` 对上了译文里的「55 亿」⇒ 报差 100 万倍 ⇒ **误报**）。
   * ⇒ 而**量级错一定是「同一个数、换了个量级词」** ⇒ 数值部分必须对得上
   * （取前缀即可：`200 млн` → 译文「2000 万」也算对得上）。
   */
  digits: string;
}

/** 取数值部分：去掉分隔符（`,` `.` 空格）只留数字。 */
function digitsOf(raw: string): string {
  return raw.replace(/[^\d]/g, '');
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
      out.push({ value: n * mult, label, raw: m[0].trim(), digits: digitsOf(String(m[1] ?? '')) });
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
/**
 * 两个数值部分是否「对得上」：**一个是另一个的前缀**（或完全相同）。
 *
 * ⚠️ 用前缀而不是「完全相等」：实测「`200 млн` 被写成「2000 万」」也是真错
 * （数值 200 → 2000，差了一个零）⇒ 完全相等会漏掉这一类。
 */
function digitsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

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
    // ★ 只在「**数值部分对得上**」的译文值里挑最接近的那个。
    // ⇒ 「量级错」一定是同一个数换了个量级词 ⇒ 数值部分必须一致（取前缀即可：
    //   `200 млн` → 译文「2000 万」也算对得上）。
    // ⇒ 而原文里那些**根本没被译出来**的数（`5,5 тыс`）就配不上 ⇒ **误报被排除**。
    let best: ScaledAmount | null = null;
    let bestDiff = Infinity;
    for (const c of cns) {
      if (!digitsMatch(r.digits, c.digits)) continue;
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

/**
 * 把**西式量级词**改成中文的「万 / 亿」（2026-10-24）。
 *
 * ## 问题
 *
 * 中文不用「百万 / 十亿」这两个词（那是英文/俄文直译过来的），中文说「万 / 亿」。
 * 模型有时会照抄：「总预算为 **30.12 百万**索姆」⇒ 用户 2026-10-24 报过
 * 「3012 万和 30.12 百万，数值是一致的，但 30.12 百万不符合中文习惯」。
 *
 * ## 为什么能**机械改写**（不需要模型、不需要重试）
 *
 * `N 百万` = N × 10⁶ = **N×100 万**（`30.12 百万` ⇒ `3012 万`）；
 * `N 十亿` = N × 10⁹ = **N×10 亿**（`3 十亿` ⇒ `30 亿`）。
 * ⇒ 换算是确定的 ⇒ 直接改写即可，**零误报、零成本**。
 *
 * ## 形状收得极窄（误报 = 静默把好稿子改坏）
 *
 * · **只认「数字 + 百万/十亿」**，且**后面必须紧跟货币或重量单位**
 *   （美元 / 欧元 / 索姆 / 坚戈 / 马纳特 / 里亚 / 卢布 / 吨 / 千克 …）。
 * ⇒ 「**300 万人**」「**百万富翁**」「**十亿分之一的精度**」这些**中文本来就这么说**的，一个都不碰。
 * · 只在**数字与量级词之间**是空格时改（`30.12 百万`）⇒ 贴着写的不改。
 */
const WESTERN_SCALE = /(\d[\d.,]*)\s+(百万|十亿)(?=\s*(?:美元|美金|欧元|英镑|索姆|苏姆|坚戈|马纳特|里拉|卢布|塔吉克索姆|坦|阿尼|迪拉姆|里亚尔|腾格|格里夫纳|雷伊|福林|兹罗提|库姆|索姆|克朗|克鲁尼||第纳尔|里亚尔|吨|千克|公里|米|平方|立方|千瓦|兆瓦|度))/g;

/** 把「N 百万 / N 十亿」改写成「N×100 万 / N×10 亿」。 */
export function westernScaleToChinese(text: string): { text: string; rewritten: string[] } {
  const rewritten: string[] = [];
  const out = text.replace(WESTERN_SCALE, (_m, num: string, unit: string) => {
    const n = parseAmount(num);
    if (!Number.isFinite(n) || n === 0) return _m;
    const factor = unit === '百万' ? 1e6 : 1e9;
    const v = n * factor;
    let cn: string;
    if (v >= 1e8) {
      cn = `${trimNum(v / 1e8)} 亿`;
    } else if (v >= 1e4) {
      cn = `${trimNum(v / 1e4)} 万`;
    } else {
      cn = trimNum(v);
    }
    rewritten.push(`${num} ${unit} → ${cn}`);
    return cn;
  });
  return { text: out, rewritten };
}

/** 去掉多余的小数尾零（`3012.000000` ⇒ `3012`）。 */
function trimNum(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  return Number.isInteger(r) ? String(r) : String(r);
}
