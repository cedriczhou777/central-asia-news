/**
 * 量「一个词里同时含拉丁字母和西里尔字母」这一类缺陷 —— 并且**逐条打出上下文**，
 * 让人能判每一条是「译文真缺陷」还是「误报」。
 *
 * 用法：
 *   # ① 先抓一份样本（线上接口，按 UTC 日聚合，多抓几天更稳）
 *   BASE=https://<你的服务域名>
 *   for d in 2026-09-26 2026-09-27 2026-09-28; do
 *     curl -s "$BASE/api/articles?date=$d&limit=1000" -o "/tmp/arts-$d.json"
 *   done
 *   # ② 合并去重成一个数组文件（同 analyze:cover-gaps 的做法）
 *   python3 - <<'PY'
 *   import json,glob
 *   seen={}
 *   for f in glob.glob('/tmp/arts-*.json'):
 *       for a in json.load(open(f)).get('articles',[]): seen[a['id']]=a
 *   json.dump(list(seen.values()),open('/tmp/sample.json','w'),ensure_ascii=False)
 *   PY
 *   # ③ 量
 *   pnpm analyze:mixed-script /tmp/sample.json
 *
 * ## 这个脚本要回答的问题
 *
 * `utils.latinCyrillicTokens` 是一条**结构性**判据（一个词不可能一半拉丁一半西里尔），
 * 但项目纪律是：**下游是「重试三次后丢稿」的判据，必须先拿真实语料量误报率**。
 * 所以这里不预设结论，只把两件事变成数字：
 *
 * 1. **误报率**：命中里有多少是 URL 文件名、双语括注这类正常写法。
 * 2. **增量覆盖率**：命中里有多少是**现有三条闸抓不到**的（token 里不含汉字）。
 *    如果增量是 0，那这条判据就不值得进闸 —— 「看起来更全」不是理由。
 *
 * ⚠️ 这里跑的是**原始字段**（不剥 HTML），因为生产闸 `normalizeResult` 拿到的
 * 就是原始字段。剥了标签再量，量到的就不是你要上线的那个东西。
 */
import { readFileSync } from 'fs';
import { latinCyrillicTokens, mixedScriptTokens, mixedScriptTokensLatin } from '../src/lib/utils';

type A = { id: number; title: string; summary: string | null; content: string | null; country: string };

const path = process.argv[2];
if (!path) {
  console.error('用法：pnpm analyze:mixed-script <articles.json>（见本文件头部注释，含怎么生成它）');
  process.exit(2);
}

const arts: A[] = JSON.parse(readFileSync(path, 'utf8'));
const pct = (n: number, d: number) => (d === 0 ? '0.0%' : `${((100 * n) / d).toFixed(2)}%`);
const HAN = /[\u4e00-\u9fff]/;

console.log(`样本 ${arts.length} 篇`);

const hitsByArticle = new Map<number, { country: string; where: string; tok: string }[]>();
const tokenCount = new Map<string, number>();
let articlesHit = 0;

for (const a of arts) {
  const rows: { country: string; where: string; tok: string }[] = [];
  for (const [where, raw] of [
    ['标题', a.title],
    ['摘要', a.summary],
    ['正文', a.content],
  ] as Array<[string, string | null]>) {
    for (const tok of latinCyrillicTokens(raw || '')) {
      rows.push({ country: a.country, where, tok });
      tokenCount.set(tok, (tokenCount.get(tok) || 0) + 1);
    }
  }
  if (rows.length) {
    articlesHit++;
    hitsByArticle.set(a.id, rows);
  }
}

console.log(`\n=== 1. 总量 ===`);
console.log(`  命中篇数：${articlesHit} / ${arts.length}  ${pct(articlesHit, arts.length)}`);
console.log(`  不同词种：${tokenCount.size}`);

// ---- 2. 逐条上下文：判误报就靠这一段 ----
console.log(`\n=== 2. 逐条上下文（按出现次数降序，全部列出）===`);
console.log(`  「含汉字？」= 现有闸 mixedScriptTokens/Latin 是否也抓得到；✗ 表示本判据的**增量**`);
let incremental = 0;
let coveredAlready = 0;
for (const [tok, n] of [...tokenCount.entries()].sort((x, y) => y[1] - x[1])) {
  // 找到这个词的一个实例，打出 ±24 字上下文
  let ctx = '';
  let where = '';
  let id = 0;
  let country = '';
  for (const [aid, rows] of hitsByArticle) {
    const r = rows.find((x) => x.tok === tok);
    if (r) {
      const a = arts.find((z) => z.id === aid)!;
      const raw = (r.where === '标题' ? a.title : r.where === '摘要' ? a.summary : a.content) || '';
      const at = raw.indexOf(tok);
      ctx = raw.slice(Math.max(0, at - 24), at + tok.length + 24).replace(/\s+/g, ' ');
      where = r.where;
      id = aid;
      country = r.country;
      break;
    }
  }
  const hasHan = HAN.test(tok);
  if (hasHan) coveredAlready++;
  else incremental++;
  console.log(
    `  ${String(n).padStart(3)}×  ${tok}   含汉字？${hasHan ? '✓（现有闸也抓）' : '✗（本判据增量）'}\n` +
      `         [${country} id=${id} ${where}] …${ctx}…`,
  );
}

// ---- 3. 增量覆盖率：现有三条闸抓不到多少 ----
console.log(`\n=== 3. 增量覆盖率（决定「值不值得进闸」的那一行）===`);
console.log(`  token 含汉字 ⇒ 现有闸也抓：${coveredAlready} 种`);
console.log(`  token 不含汉字 ⇒ **本判据独有**：${incremental} 种`);

let incArticles = 0;
for (const [, rows] of hitsByArticle) {
  const onlyNew = rows.filter((r) => !HAN.test(r.tok));
  if (onlyNew.length) incArticles++;
}
console.log(`  独有命中覆盖的篇数：${incArticles} / ${arts.length}  ${pct(incArticles, arts.length)}`);

// ---- 4. 对照组：现有两条闸在这个样本上的量（用于说明「不是重复劳动」）----
let hanCyr = 0;
let hanLat = 0;
for (const a of arts) {
  const fields = [a.title, a.summary || '', a.content || ''];
  if (fields.some((f) => mixedScriptTokens(f).length)) hanCyr++;
  if (fields.some((f) => mixedScriptTokensLatin(f).length)) hanLat++;
}
console.log(`\n=== 4. 对照组（同一样本上现有两条闸的量）===`);
console.log(`  汉字+西里尔混排：${hanCyr} 篇  ${pct(hanCyr, arts.length)}`);
console.log(`  汉字+拉丁半译：  ${hanLat} 篇  ${pct(hanLat, arts.length)}`);

console.log(
  `\n⇒ 判误报：逐条看第 2 节。**凡命中里有一条是正常写法，就不能把本判据当硬闸**\n` +
    `   （下游是「重试 → 三次不过丢稿」，误报 = 静默丢稿）。`,
);
