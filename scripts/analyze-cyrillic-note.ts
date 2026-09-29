/**
 * 量「含西里尔的括注」这一类，并**干跑**（dry-run）确定性后处理
 * `stripCyrillicParentheticals` —— 让人在动线上之前先看见**到底会删掉什么**。
 *
 * 用法：
 *   BASE=https://<你的服务域名>
 *   for d in 2026-09-22 2026-09-23 2026-09-24; do
 *     curl -s "$BASE/api/articles?date=$d&limit=1000" -o "/tmp/arts-$d.json"
 *   done
 *   python3 - <<'PY'          # 合并去重（同 analyze:cover-gaps / analyze:mixed-script）
 *   import json,glob
 *   seen={}
 *   for f in glob.glob('/tmp/arts-*.json'):
 *       for a in json.load(open(f)).get('articles',[]): seen[a['id']]=a
 *   json.dump(list(seen.values()),open('/tmp/sample.json','w'),ensure_ascii=False)
 *   PY
 *   pnpm analyze:cyrillic-note /tmp/sample.json
 *
 * ## 为什么必须先干跑
 *
 * 这个函数**会改成品文字**（与闸不同：闸只决定「要不要重试」）。
 * 它没有丢稿风险，但「删多了」是**不可逆**的 —— 所以上线前必须看见：
 * ① 命中规模多大（爆炸半径）；② 每一处删掉的是什么、前文有没有可读的中文名。
 * 本项目已经反复栽在「靠报告说没事、没逐条看」上（见 AGENTS.md 的 M-6/M-8）。
 *
 * ## 第 4 节是最有价值的一节
 *
 * 「删前 / 删后」分别跑一遍**生产的那几道闸**：
 * 如果某篇**删完就从「有闸命中」变成「干净」**，说明那个缺陷本来就活在冗余括注里
 * （典型：`哈萨克斯坦紧急事务部（MЧS）` —— 括注里的 `MЧS` 是「拉丁+西里尔」，
 * 现在会被闸 4 拦下、重试 ×3 之后可能**丢稿**）。
 * 这一节把「后处理顺带救回多少篇」变成数字 —— 它也是「先删还是先过闸」这个
 * 顺序问题的唯一依据。
 */
import { readFileSync } from 'fs';
import {
  cyrillicParentheticalNotes,
  descendingMultiplePhrases,
  latinCyrillicTokens,
  mixedScriptTokens,
  mixedScriptTokensLatin,
  stripCyrillicParentheticals,
  MIN_HAN_CONTENT,
  MIN_HAN_TITLE,
  isChineseText,
} from '../src/lib/utils';

type A = { id: number; title: string; summary: string | null; content: string | null; country: string };

const path = process.argv[2];
if (!path) {
  console.error('用法：pnpm analyze:cyrillic-note <articles.json>（见本文件头部注释）');
  process.exit(2);
}

const arts: A[] = JSON.parse(readFileSync(path, 'utf8'));
const pct = (n: number, d: number) => (d === 0 ? '0.0%' : `${((100 * n) / d).toFixed(2)}%`);

console.log(`样本 ${arts.length} 篇`);

const fieldsOf = (a: A): Array<[string, string]> => [
  ['标题', a.title || ''],
  ['摘要', a.summary || ''],
  ['正文', a.content || ''],
];

// ---- 1. 规模：括注命中（**命中一律来自生产函数 `cyrillicParentheticalNotes`**，
//      仪器不自己写正则 —— 判据只能有一份，否则体检与生产会分叉）----
let noteCount = 0;
let artWithNote = 0;
const distinct = new Map<string, { id: number; where: string; before: string }>();

for (const a of arts) {
  let hit = 0;
  for (const [where, raw] of fieldsOf(a)) {
    for (const note of cyrillicParentheticalNotes(raw)) {
      noteCount++;
      hit++;
      if (!distinct.has(note)) {
        const at = raw.indexOf(note);
        distinct.set(note, {
          id: a.id,
          where,
          before: raw.slice(Math.max(0, at - 24), at).replace(/\s+/g, ' '),
        });
      }
    }
  }
  if (hit) artWithNote++;
}
console.log(`\n=== 1. 规模 ===`);
console.log(`  会被删掉的括注：${noteCount} 处`);
console.log(`  涉及篇数：${artWithNote} / ${arts.length}  ${pct(artWithNote, arts.length)}`);
console.log(`  ⚠️ 「内含汉字的括注」由生产判据直接排除（它们不进这个数）—— 反例见 test:cyrillic-strip。`);

// ---- 2. 干跑：逐处打出「删掉的是什么」+ 前文 ----
console.log(`\n=== 2. 干跑（逐处：删掉的串 + 前 24 字）===`);
let changedFields = 0;
let changedArticles = 0;
for (const a of arts) {
  let artChanged = false;
  for (const [, raw] of fieldsOf(a)) {
    if (!raw) continue;
    const out = stripCyrillicParentheticals(raw);
    if (out === raw) continue;
    changedFields++;
    artChanged = true;
  }
  if (artChanged) changedArticles++;
}
console.log(`  被删掉的括注**去重后** ${distinct.size} 种（全列，逐条人工过目）：`);
for (const [note, info] of [...distinct.entries()].sort((x, y) => x[0].localeCompare(y[0], 'zh'))) {
  console.log(`    「${note}」\n        前文：…${info.before}  [${info.where} id=${info.id}]`);
}

console.log(`\n=== 3. 改动的爆炸半径 ===`);
console.log(`  改动的字段数：${changedFields}`);
console.log(`  改动的篇数：${changedArticles} / ${arts.length}  ${pct(changedArticles, arts.length)}`);

// ---- 4. 「删完从有闸命中变干净」= 后处理顺带救回的篇数 ----
const gateKinds = (a: A): string[] => {
  const f = [a.title || '', a.summary || '', a.content || ''];
  const kinds: string[] = [];
  if (!(isChineseText(a.title || '', MIN_HAN_TITLE) && isChineseText(a.content || '', MIN_HAN_CONTENT)))
    kinds.push('语言闸');
  if (f.some((x) => mixedScriptTokens(x).length)) kinds.push('汉字+西里尔');
  if (f.some((x) => mixedScriptTokensLatin(x).length)) kinds.push('汉字+拉丁');
  if (f.some((x) => latinCyrillicTokens(x).length)) kinds.push('拉丁+西里尔');
  if (f.some((x) => descendingMultiplePhrases(x).length)) kinds.push('下降N倍');
  return kinds;
};
const strippedCopy = (a: A): A => ({
  ...a,
  title: stripCyrillicParentheticals(a.title || ''),
  summary: a.summary ? stripCyrillicParentheticals(a.summary) : a.summary,
  content: a.content ? stripCyrillicParentheticals(a.content) : a.content,
});

let gatedBefore = 0;
let gatedAfter = 0;
let rescued = 0;
let newlyGated = 0;
const rescueExamples: string[] = [];
const newlyGatedExamples: string[] = [];
for (const a of arts) {
  const before = gateKinds(a);
  const after = gateKinds(strippedCopy(a));
  if (before.length) gatedBefore++;
  if (after.length) gatedAfter++;
  if (before.length && after.length === 0) {
    rescued++;
    if (rescueExamples.length < 12) {
      rescueExamples.push(`    id=${a.id} [${a.country}] 删前命中【${before.join(' + ')}】\n        标题：${a.title}`);
    }
  }
  if (before.length === 0 && after.length) {
    newlyGated++;
    if (newlyGatedExamples.length < 8) {
      newlyGatedExamples.push(
        `    id=${a.id} [${a.country}] 删**后**才命中【${after.join(' + ')}】\n        标题：${a.title}`,
      );
    }
  }
}
console.log(`\n=== 4. 干跑前后「会不会被闸拦下」===`);
console.log(`  删前有闸命中：${gatedBefore} 篇  ${pct(gatedBefore, arts.length)}`);
console.log(`  删后有闸命中：${gatedAfter} 篇  ${pct(gatedAfter, arts.length)}`);
console.log(`  ⇒ **删完变干净（后处理顺带救回，本来会走「重试×3 → 可能丢稿」）：${rescued} 篇**`);
for (const e of rescueExamples) console.log(e);
// ⚠️ 这一行是**风险指标**，不是成绩单：删掉一段文字**可能**让本来分开的两个词贴到一起，
// 于是「删完才被闸拦」——那等于后处理**制造**了一次重试。这一项必须是 0，
// 不为 0 就说明判据要收紧（收紧永不误杀）。
console.log(`  ⚠️ 删完**才**被闸拦（后处理制造的重试，必须是 0）：${newlyGated} 篇`);
for (const e of newlyGatedExamples) console.log(e);
console.log(`  校验：${gatedBefore} − ${rescued} = ${gatedBefore - rescued} ${gatedBefore - rescued === gatedAfter && newlyGated === 0 ? '== 删后命中数 ✓ 且无新增' : '✗ 与删后命中数对不上'}`);

console.log(
  `\n⇒ 判断标准：第 2 节**逐条**看过去，只要有一处「删掉之后读者拿不到信息」，\n` +
    `   就必须收紧判据（只收不放松 —— 收紧永不误杀）。第 4 节的「救回篇数」\n` +
    `   是决定「先删还是先过闸」的依据。`,
);
