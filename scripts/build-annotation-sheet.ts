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