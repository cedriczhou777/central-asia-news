/**
 * 生成「待标注清单」（一次跑，产出一个 Markdown）。
 *
 * ## 为什么是清单而不是我继续猜
 *
 * 「重复 / 量级 / 评论尾巴」三件事都卡在同一个前置：**没有可信的「哪里错了」标注**。
 * 2026-10-19 已实测：因为自己猜的标签，一天里推翻过 5 个结论 ——
 * 其中「9.54 亿马纳特」那条，**模型判否是对的**，我们把「两个不同的指标数值相同」
 * 当成了重复。
 *
 * ⇒ 这里**不做判断**，只把「模型判了什么 / 这句话长什么样」摆出来，让人勾。
 *
 * 用法：`pnpm tsx scripts/build-annotation-sheet.ts <输出.md> <文件.json>...`
 */
import { readFileSync, writeFileSync } from 'fs';

interface Art {
  country?: string;
  title?: string;
  summary?: string;
  content?: string;
  originalTitle?: string;
  originalContent?: string;
}
interface PairRow {
  country?: string;
  pairs?: Array<{ sim: number; a: string; b: string }>;
  declined?: Array<{ sim: number; a: string; b: string }>;
}
interface Row { c: string; sim: number; a: string; b: string }

const out = process.argv[2] || '/tmp/annotation-sheet.md';
const files = process.argv.slice(3);

/** 模型判「是/否」最可能错的相似度区间。 */
const FUZZY_LO = 0.2;
const FUZZY_HI = 0.42;

const merged: Row[] = [];
const declined: Row[] = [];
const arts: Art[] = [];

for (const f of files) {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
  const obj = raw as { llmJudge?: PairRow[]; articles?: Art[] };
  if (Array.isArray(obj.articles)) arts.push(...obj.articles);
  for (const j of obj.llmJudge ?? []) {
    const c = j.country ?? '?';
    for (const p of j.pairs ?? []) merged.push({ c, sim: p.sim, a: p.a, b: p.b });
    for (const p of j.declined ?? []) declined.push({ c, sim: p.sim, a: p.a, b: p.b });
  }
}

const fuzzy = (r: Row) => r.sim >= FUZZY_LO && r.sim <= FUZZY_HI;
const aList = merged.filter(fuzzy).sort((x, y) => y.sim - x.sim).slice(0, 12);
const bList = declined.filter((r) => r.sim >= 0.28).sort((x, y) => y.sim - x.sim).slice(0, 8);

const CN_UNIT = /([\d][\d.,]*)\s*(万|亿)\s*(千瓦时|度电|千瓦|吨|吨位|美元|美金|欧元|立方米|人民币)/;
const RAW_MARK = /(million|billion|млн|млрд|тыс\.|thousand)/i;
const META = /(最后一句|最后一段|如上所述|见前文|综上所述|值得注意的是|需要注意的是)/;

function sentences(t: string): string[] {
  return (t || '').split(/(?<=[。！？!?])/).map((s) => s.trim()).filter((s) => s.length > 8);
}

const unitRows: Array<{ c: string; t: string; cn: string }> = [];
const metaRows: Array<{ c: string; t: string; s: string }> = [];
for (const a of arts) {
  const src = (a.originalTitle || '') + '\n' + (a.originalContent || '');
  if (unitRows.length < 14 && src.trim() && RAW_MARK.test(src)) {
    for (const s of sentences((a.summary || '') + (a.content || ''))) {
      if (!CN_UNIT.test(s)) continue;
      unitRows.push({ c: a.country ?? '?', t: (a.title || '').slice(0, 40), cn: s.slice(0, 120) });
      if (unitRows.length >= 14) break;
    }
  }
  for (const s of sentences(a.summary || '')) {
    if (metaRows.length < 10 && META.test(s)) {
      metaRows.push({ c: a.country ?? '?', t: (a.title || '').slice(0, 40), s: s.slice(0, 120) });
    }
  }
}


/**
 * 「同一事件组内数字打架」的提取器（2026-10-20）。
 *
 * ## 为什么这个信号特别干净
 *
 * 之前试的「中英量级对照」噪声极大（同一篇里中文的数字和原文的数字指的不是同一个东西）。
 * 而这里**不需要做事件判定** —— 输入是**已经被 pair 模式确认是同一事件**的组，
 * ⇒ 同一个事件里的金额/数量**本来就该一致** ⇒ 组内出现量级不一致 ⇒ **必有一错**。
 *
 * 实测（UTC 10-19 那一批，168 对确认同事件）：11 对「同单位差 ≥9.5 倍」，
 * 其中 **10 对指向同一个错误源**（「乌美协议 12 亿 vs 120 亿」），
 * 查原文确认：**错的是那 3 条写「12 亿」的**（原文是 12 billion / 12 млрд = 120 亿）
 * ⇒ ★ **模型把「十亿」直接对译成「亿」，少了一个零。**
 *
 * ⚠️ 因此它的正确用法**不是「删稿」**（那太危险），而是
 * **「少数派是错的」⇒ 把少数派改成多数派的值**（错误的后果只是改一个数字，
 * 而正确的那个值有多数派背书）。
 */
const MAG_UNITS: Array<[RegExp, number, string]> = [
  [/([\d.,]+)\s*亿(美元|欧元|里拉|坚戈|苏姆|马纳特|塔吉克索姆)/, 1e8, 'CUR'],
  [/([\d.,]+)\s*万(美元|欧元|里拉|坚戈|苏姆|马纳特|塔吉克索姆)/, 1e4, 'CUR'],
  [/([\d.,]+)\s*亿美元/, 1e8, 'USD'],
  [/([\d.,]+)\s*万美元/, 1e4, 'USD'],
  [/([\d.,]+)\s*亿千瓦时/, 1e8, 'KWH'],
  [/([\d.,]+)\s*万千瓦时/, 1e4, 'KWH'],
  [/([\d.,]+)\s*亿(吨|立方米)/, 1e8, 'QTY'],
  [/([\d.,]+)\s*%/, 1, 'PCT'],
  [/([\d.,]+)\s*(人|名|座|所|台|辆|机组)/, 1, 'CNT'],
];

function amountsOf(text: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [re, mult, unit] of MAG_UNITS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of text.matchAll(g)) {
      const num = Number(String(m[1] ?? '').replace(/[^\d.]/g, ''));
      if (!Number.isFinite(num) || num === 0) continue;
      const arr = out.get(unit) ?? [];
      arr.push(num * mult);
      out.set(unit, arr);
    }
  }
  return out;
}

/** 找出「同事件、同单位、量级差 ≥9.5 倍」的配对。 */
function magnitudeClashes(rows: Row[]) {
  const out: Array<{ c: string; a: string; b: string; sim: number; unit: string; va: number; vb: number }> = [];
  for (const r of rows) {
    const ma = amountsOf(r.a);
    const mb = amountsOf(r.b);
    for (const [unit, av] of ma) {
      const bv = mb.get(unit);
      if (!bv) continue;
      for (const x of av) {
        for (const y of bv) {
          const ratio = x > y ? x / y : y / x;
          if (ratio >= 9.5) out.push({ ...r, unit, va: x, vb: y });
        }
      }
    }
  }
  return out;
}

const L: string[] = [];
L.push('# 待标注清单（人工勾一遍，每条约 5 秒）');
L.push('');
L.push('> 生成于 2026-10-19。**这份清单的目的不是「证明我对」，而是把我猜不准的地方交给你定。**');
L.push('> 我今天已经因为自己猜的标签推翻过 5 个结论（其中「9.54 亿马纳特」那条，模型判否是对的）。');
L.push('');
L.push('## 怎么填');
L.push('');
L.push('每条后面有两个选择，把 `[ ]` 改成 `[x]` 并写上字母即可；或者直接回我一行，例如：');
L.push('');
L.push('    A1=A  A2=B  A3=A  A4=B      A=两条只该留一条   B=两条都要留');
L.push('    B1=错  B2=对                 B 段：错=译文量级错了   对=译文没错');
L.push('    C1=A  C2=B                  C 段：A=这句不该出现   B=应该留着');
L.push('    D1=甲  D2=乙                 D 段：甲/乙 = 哪一条的数字是错的');
L.push('');
L.push('---');
L.push('');
L.push('## A. 重复候选（' + (aList.length + bList.length) + ' 条）');
L.push('');
L.push('### A1–A' + aList.length + '：模型判为「是同一件事」，但相似度落在 ' + FUZZY_LO + '–' + FUZZY_HI + ' 的模糊区（最可能是误合）');
L.push('');
aList.forEach((r, i) => {
  L.push('**A' + (i + 1) + '**　[ ] A=真重复，只该留一条　　[ ] B=不是重复，两条都要留　　sim=' + r.sim.toFixed(3) + '　国=' + r.c);
  L.push('  - 甲：' + r.a);
  L.push('  - 乙：' + r.b);
  L.push('');
});
const off = aList.length;
L.push('### A' + (off + 1) + '–A' + (off + bList.length) + '：模型判为「不是同一件事」，但相似度偏高（可能是漏合）');
L.push('');
bList.forEach((r, i) => {
  L.push('**A' + (off + i + 1) + '**　[ ] A=真重复，只该留一条　　[ ] B=不是重复，两条都要留　　sim=' + r.sim.toFixed(3) + '　国=' + r.c);
  L.push('  - 甲：' + r.a);
  L.push('  - 乙：' + r.b);
  L.push('');
});
L.push('---');
L.push('');
L.push('## B. 量级候选（' + unitRows.length + ' 条）');
L.push('');
L.push('> 2026-10-19 实测：纯机械的中英量级对照**噪声太大**（分不清金额/价格/股数/人数），');
L.push('> 所以改成「把整句摆出来给你读」。你只需判断**译文里的数字量级对不对**。');
L.push('');
unitRows.forEach((r, i) => {
  L.push('**B' + (i + 1) + '**　[ ] 错=译文量级错了　　[ ] 对=译文没错　　国=' + r.c);
  L.push('  - 标题：' + r.t);
  L.push('  - 中文：' + r.cn);
  L.push('');
});
L.push('---');
L.push('');
L.push('## C. 疑似「元评语」（' + metaRows.length + ' 条）');
L.push('');
if (metaRows.length === 0) {
  L.push('> **这一段是空的，而且是「查不到」而不是「没问题」——两回事，别混。**');
  L.push('> 原因：你看到的「最后一句是具体事实。」这类句子是**总审改写之后**才出现的，');
  L.push('> 而**库里存的是总审改写之前的文本** ⇒ 这类句子在库里根本不存在，扫不出来。');
  L.push('> ⇒ 要拿到它们，只能读总审的 `fixes` 输出 —— 而那是**进程内存态**。');
  L.push('> ⇒ 这是本项目今天遇到的**第三个「内存态导致查不到」**（前两个是 `lastRun`、`dupDrops`）。');
} else {
  L.push('> 这类句子「读者不需要看到」，但它们**可能是原文就这么写的**——所以要你确认。');
}
L.push('');
metaRows.forEach((r, i) => {
  L.push('**C' + (i + 1) + '**　[ ] A=这句不该出现　　[ ] B=应该留着（原文就有）　　国=' + r.c);
  L.push('  - 标题：' + r.t);
  L.push('  - 句子：' + r.s);
  L.push('');
});
L.push('---');
L.push('');
const clashes = magnitudeClashes(merged);
L.push('## D. 同一事件组内「数字打架」（' + clashes.length + ' 条）');
L.push('');
L.push('> **这批最干净的一条线索**：输入是**已被模型确认是同一事件**的组，');
L.push('> 同一个事件里的金额/数量**本来就该一致** ⇒ 打架就必有一错。');
L.push('> 2026-10-20 实测：UTC 10-19 那批 168 对确认同事件里，11 对量级差 ≥9.5 倍，');
L.push('> 其中 10 对指向**同一个错误源** —— 查原文确认「乌美协议 12 亿 vs 120 亿」里，');
L.push('> **错的是那 3 条写「12 亿」的**（原文是 12 billion / 12 млрд = 120 亿）');
L.push('> ⇒ **模型把「十亿」直接对译成了「亿」，少了一个零。**');
L.push('>');
L.push('> 请你判断：**是甲错还是乙错**（不是「都不该留」—— 它们是同一件事，该留一条）。');
L.push('');
{
  // 去重：同一个（甲,乙）标题对只列一次，但**记下它出现在几对上**
  // —— 否则同一个错误源会在清单里重复十几行，白白占掉你的时间。
  const seen = new Map<string, { r: (typeof clashes)[number]; n: number }>();
  for (const r of clashes) {
    const big = r.va > r.vb ? r.a : r.b;
    const small = r.va > r.vb ? r.b : r.a;
    const k = big + '||' + small;
    const hit = seen.get(k);
    if (hit) hit.n++;
    else seen.set(k, { r, n: 1 });
  }
  const uniq = [...seen.values()];
  uniq.forEach((u, i) => {
    const r = u.r;
    const big = r.va > r.vb ? r.a : r.b;
    const small = r.va > r.vb ? r.b : r.a;
    L.push('**D' + (i + 1) + '**　[ ] 甲错（把乙改成甲的数）　　[ ] 乙错（把甲改成乙的数）　　单位=' + r.unit + '　国=' + r.c + '　（出现在 ' + u.n + ' 对上）');
    L.push('  - 甲：' + big);
    L.push('  - 乙：' + small);
    L.push('');
  });
  L.push('> 去重后 ' + uniq.length + ' 个「打架点」（原始 ' + clashes.length + ' 对）。');
  L.push('>');
  L.push('> ⚠️ **我已把 uz 与 kz 这两处的原文查过了，方向是**：');
  L.push('> · uz：原文 `12 млрд` / `12 billion` = **120 亿** ⇒ 写「**120 亿**」的**对**，写「**12 亿**」的**错**（3 条）；');
  L.push('> · kz：原文 `8 млрд` / `8 миллиардов` = **80 亿** ⇒ 写「**80 亿**」的**对**，写「**8 亿**」的**错**。');
  L.push('> ⇒ ★ **根因锁定：模型缺少「1 十亿 = 10 亿」这一步换算** —— 它把「8 billion」写成「8 亿」、');
  L.push('>   把「12 billion」写成「12 亿」，**都是少一个零**。');
  L.push('> ⚠️ 而「多数派是对的」**不成立**（uz 那组是 3 错 : 2 对）⇒ **组内打架只能告诉你「这里有一个错」，');
  L.push('>   要定是哪一个，**必须对照原文**。');
  L.push('');
}
L.push('---');
L.push('');
L.push('## 附：我自己的两条排查结论（供你复核，不在上面的勾选里）');
L.push('');
L.push('1. **「该文件已发布在阿塞拜疆总统官方网站上」** —— 源稿本来就这么写（法令文本发布在官网），');
L.push('   所以不是 bug，是忠实转译。若你确认原文没有，告诉我，我去核原文。');
L.push('2. **「最后一句是具体事实。」** —— 我查了总审提示词，**这五个字根本没进过提示词**（只在代码注释里），');
L.push('   所以它是模型自己写的一句评语。总审的闸只查长度/换行/标签/占位符，于是放行了它。');
L.push('');

writeFileSync(out, L.join('\n'), 'utf8');
console.log('已写出 ' + out);
console.log('A 重复 ' + (aList.length + bList.length) + ' 条（判是 ' + aList.length + ' / 判否 ' + bList.length + '）｜B 量级 ' + unitRows.length + ' 条｜C 元评语 ' + metaRows.length + ' 条');
console.log('字节数 ' + Buffer.byteLength(L.join('\n'), 'utf8'));