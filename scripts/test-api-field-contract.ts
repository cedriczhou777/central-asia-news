/**
 * 「接口字段 vs 查询列」契约回归（离线，不联网、不碰数据库）。
 *
 * 用法：
 *   pnpm tsx scripts/test-api-field-contract.ts
 *
 * ## 为什么需要这条回归
 *
 * 本项目已经**三次**栽在同一类缺口上 —— 「字段明明在库里 / 代码里，但没有任何
 * 代码读过它」，而它**不报错、不告警**，只表现为「判据上线了却没有效果」：
 *
 * | # | 缺口 | 后果 | 发现方式 |
 * | --- | --- | --- | --- |
 * | 1 | 总审没读 `original_content` | 6 条内容缺陷全穿过总审 | 人工逐条比对原文 |
 * | 2 | `getArticles` 没 select `original_content` | 诊断漏斗把五国全部报成「无正文/出不了草稿」| 人工核对接口返回的键名 |
 * | 3 | 登记表里加了字段、消费方没接 | 「加了条很正确的判据但现象没变」| 反查调用链 |
 *
 * 每次都靠人肉发现。这条回归要拦的是**第 2 类**的具体形态：
 *
 *   `rowToApi` 从 DB 行里读 `row.X`，而 `getArticles` 的 `select(...)` 里没有 X。
 *   ⇒ `row.X === undefined` ⇒ `JSON.stringify` 把键**整个丢掉** ⇒
 *     接口不报错，只是静默少一个字段 ⇒ 下游（诊断脚本）拿 `undefined`
 *     当「没有值」，得出与事实相反的结论。
 *
 * ## 判据（三条，都是文本级静态检查 —— 不需要数据库）
 *
 * 1. `rowToApi` 里出现的每个 `row.<field>` 都必须在 `ARTICLE_COLUMNS` 里；
 * 2. `db-articles.ts` 里的 inline `.select('<列清单>')` **只允许两种**：
 *    (a) 窄投影（不含 `content`）—— 例如 `'id, source_url'`，且每一列都必须真实存在于
 *        `ARTICLE_COLUMNS`（防拼错、防选了不存在的列）；
 *    (b) 宽投影（含 `content`）—— 必须**同时**在同文件里有一个
 *        `Pick<ArticleRow, …>` 把这份列清单**逐字声明**出来，且两者集合相等。
 *    这条防的是「又冒出一个读取方，自己写一份全字段清单」—— 那正是第 2 类缺口的成因：
 *    两份清单只会在其中一份被改的时候分叉，而分叉不会报错。
 *    （`getArticleIdentities` 就是 (b) 的样板：它有 `Pick<ArticleRow, …>` 对照。）
 * 3. `rowToApi` 必须**真的把 `originalTitle` / `originalContent` 暴露出去** ——
 *    `scripts/diagnose-push-window.ts` 的第 0 条闸与身份判据全靠这两个键。
 *    光把它们放进 select 还不够（这正是上次的错：列在、输出没有）。
 *
 * ## 自检（这条回归自己会不会撒谎）
 *
 * 末尾有一段「反向自检」：把 `rowToApi` 故意改坏（塞一个不在列清单里的字段），
 * 断言检查器**必须**报出来。没有这段的话，一个恒返回 `[]` 的检查器也能「全部通过」——
 * 那就是本项目的 O-3-1（**仪器撒谎**）。参考 `scripts/test-editor-review.ts` 的同类做法。
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const DB_SRC = resolve(ROOT, 'src/lib/db-articles.ts');
const ROUTE_SRC = resolve(ROOT, 'src/app/api/articles/route.ts');

// ----- 极简断言 -----

let passed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(detail ? `${name} —— ${detail}` : name);
    console.log(`  ✗ ${name}${detail ? `  —— ${detail}` : ''}`);
  }
}

// ----- 解析 -----

/** 把 `const ARTICLE_COLUMNS = 'a, b' + 'c';` 解析成列名集合（把相邻字符串字面量拼起来）。 */
function parseColumns(dbSrc: string): string[] {
  const m = dbSrc.match(/const\s+ARTICLE_COLUMNS\s*=([\s\S]*?);/);
  if (!m) return [];
  const literals = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  const joined = literals.join('');
  return joined
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `ArticleRow` 接口声明的全部字段名。
 *
 * 用途：判断某处 inline 投影有没有选「这个表上根本不存在的列」。
 * ⚠️ 判据必须是**这个类型**，不能拿 `ARTICLE_COLUMNS` 当全集 ——
 * `ARTICLE_COLUMNS` 是「读一篇完整文章要取哪些列」，**故意不含** `created_at`
 * （那是「存量 vs 新产生」才需要的时间戳，见 `getArticleIdentities`）、
 * 也不含 `cover_image` / `image_urls`。拿它当全集会把合法的窄投影误判成拼错。
 */
function parseArticleRowFields(dbSrc: string): string[] {
  const m = dbSrc.match(/export interface ArticleRow\s*\{([\s\S]*?)\n\}/);
  if (!m) return [];
  return [...m[1].matchAll(/^\s*([a-z_][a-z0-9_]*)\s*[?:]/gim)].map((x) => x[1]);
}

/** 取出 `function rowToApi(...) { ... }` 的函数体原文（到行首的 `}` 为止）。 */
function extractRowToApi(routeSrc: string): string {
  const start = routeSrc.indexOf('function rowToApi');
  if (start < 0) return '';
  const end = routeSrc.indexOf('\n}', start);
  return end < 0 ? routeSrc.slice(start) : routeSrc.slice(start, end);
}

/** 检查器本体。抽成纯函数是为了下面能做反向自检。 */
function findMissingColumns(routeSrc: string, columns: string[]): string[] {
  const body = extractRowToApi(routeSrc);
  const used = new Set([...body.matchAll(/\brow\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((x) => x[1]));
  const have = new Set(columns);
  return [...used].filter((f) => !have.has(f)).sort();
}

/** `db-articles.ts` 里所有 inline 的 `.select('<字面量>')` 的列集合（跳过 `ARTICLE_COLUMNS` / `'*'` / 无参）。 */
function findInlineSelectColumns(dbSrc: string): string[][] {
  return [...dbSrc.matchAll(/\.select\(([^)]*)\)/g)]
    .map((x) => x[1].trim())
    .filter((arg) => arg !== 'ARTICLE_COLUMNS' && arg !== "'*'" && arg.length > 0)
    .map((arg) =>
      [...arg.matchAll(/'([^']*)'/g)]
        .flatMap((lit) => lit[1].split(','))
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .filter((cols) => cols.length > 0);
}

/** 文件里所有 `Pick<ArticleRow, 'a' | 'b' | …>` 的键集合（排序后，便于比较）。 */
function findPickKeySets(dbSrc: string): string[][] {
  return [...dbSrc.matchAll(/Pick<\s*ArticleRow\s*,\s*([^>]+)>/g)].map((m) =>
    [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort(),
  );
}

/**
 * 宽投影（含 `content`）的检查器 —— 抽成纯函数以便反向自检。
 *
 * 返回**不合格**的宽投影清单：每项含列清单、以及不合格的原因。
 */
function findBadWideSelects(dbSrc: string): Array<{ cols: string[]; why: string }> {
  const picks = findPickKeySets(dbSrc);
  const bad: Array<{ cols: string[]; why: string }> = [];
  for (const cols of findInlineSelectColumns(dbSrc)) {
    if (!cols.includes('content')) continue;
    const sorted = [...cols].sort();
    const matched = picks.some(
      (p) => p.length === sorted.length && p.every((k, i) => k === sorted[i]),
    );
    if (!matched) {
      bad.push({
        cols,
        why: '是一份全字段清单，但文件里没有任何 Pick<ArticleRow, …> 与它逐字对应',
      });
    }
  }
  return bad;
}

// ----- 主流程 -----

const dbSrc = readFileSync(DB_SRC, 'utf8');
const routeSrc = readFileSync(ROUTE_SRC, 'utf8');
const columns = parseColumns(dbSrc);

console.log('字段契约回归：接口字段 vs 查询列');
console.log('='.repeat(60));

console.log(`\n① ARTICLE_COLUMNS 解析（${columns.length} 列）`);
ok('列清单非空', columns.length > 0, `解析到 ${columns.length} 列`);
ok('列清单里没有重复项', new Set(columns).size === columns.length);
for (const need of ['original_content', 'original_title', 'source_url', 'published_at']) {
  ok(`含 \`${need}\``, columns.includes(need));
}

console.log('\n② rowToApi 读的每个 row.* 都在列清单里');
const missing = findMissingColumns(routeSrc, columns);
ok(
  '没有「读了但没 select」的字段',
  missing.length === 0,
  missing.length > 0
    ? `rowToApi 读了 ${missing.map((m) => `row.${m}`).join('、')}，但 ARTICLE_COLUMNS 里没有` +
      ` ⇒ 接口会静默丢掉这些键`
    : undefined,
);
ok('rowToApi 函数体解析成功', extractRowToApi(routeSrc).length > 0);

console.log('\n③ inline 投影列清单都合法');
const inlineCols = findInlineSelectColumns(dbSrc);
ok('解析到 inline 投影', inlineCols.length > 0, `共 ${inlineCols.length} 处`);

const rowFields = parseArticleRowFields(dbSrc);
ok('ArticleRow 字段解析成功', rowFields.length >= 10, `解析到 ${rowFields.length} 个字段`);
const haveField = new Set(rowFields);

const invented = inlineCols.flatMap((cols) => cols.filter((c) => !haveField.has(c)));
ok(
  'inline 投影里没有「ArticleRow 上不存在的列」（防拼错列名）',
  invented.length === 0,
  invented.length > 0 ? `选了不存在的列：${[...new Set(invented)].join('、')}` : undefined,
);
ok(
  'ARTICLE_COLUMNS 的每一列都是 ArticleRow 上的字段',
  columns.every((c) => haveField.has(c)),
  columns.filter((c) => !haveField.has(c)).join('、') || undefined,
);

const badWide = findBadWideSelects(dbSrc);
ok(
  '★ 全字段投影都有 Pick<ArticleRow, …> 逐字对照',
  badWide.length === 0,
  badWide.length > 0
    ? badWide.map((b) => `[${b.cols.length} 列] ${b.why}`).join('；')
    : undefined,
);

console.log('\n④ 诊断脚本依赖的两个键必须被真的暴露出去');
const rowBody = extractRowToApi(routeSrc);
for (const key of ['originalTitle', 'originalContent']) {
  ok(`rowToApi 返回对象里有 \`${key}\``, new RegExp(`\\b${key}\\s*:`).test(rowBody));
}

console.log('\n⑤ 自检：故意改坏之后，检查器必须报出来');
const brokenSrc = routeSrc.replace(
  /function rowToApi\(row: ArticleRow\) \{/,
  'function rowToApi(row: ArticleRow) {\n    __selfTest: row.definitely_not_a_real_column,',
);
const brokenMiss = findMissingColumns(brokenSrc, columns);
ok(
  '★ 反向自检：注入一个不存在的列，检查器报出来',
  brokenMiss.includes('definitely_not_a_real_column'),
  `检查器返回 [${brokenMiss.join(', ')}] —— 若为空说明它是个恒真的假检查器`,
);
// 再确认它不会误报：没动过的源码上仍然是 0
ok('★ 反向自检：未改动的源码上不误报', findMissingColumns(routeSrc, columns).length === 0);

// ★ 最要紧的一条：**精确复现 2026-10-05 那次事故的形状** ——
// 把 `original_content` 从列清单里拿掉（其它一律不动），检查器必须点名它。
// 没有这条，上面那些自检只证明「检查器会看 row.*」，不证明它认得**这个**缺陷。
const columnsWithoutBody = columns.filter((c) => c !== 'original_content');
ok(
  '★ 反向自检：列清单漏掉 original_content 时，检查器点名 original_content',
  columnsWithoutBody.length === columns.length - 1 &&
    findMissingColumns(routeSrc, columnsWithoutBody).includes('original_content'),
  `返回 [${findMissingColumns(routeSrc, columnsWithoutBody).join(', ')}]`,
);

// 同一个道理检查 ③ 的宽投影判据：把一处窄投影换成「没声明过的全字段投影」，必须报出来。
const brokenWideSrc = dbSrc.replace(
  ".select('id, original_title')",
  ".select('id, title, content, definitely_not_declared')",
);
ok(
  '★ 反向自检：注入一处无 Pick 对照的全字段投影，检查器报出来',
  brokenWideSrc !== dbSrc && findBadWideSelects(brokenWideSrc).length > 0,
  brokenWideSrc === dbSrc
    ? '注入点没匹配上（脚本正则会失效，需要同步更新）'
    : `检查器返回 ${findBadWideSelects(brokenWideSrc).length} 处`,
);
ok('★ 反向自检：未改动的源码上宽投影判据不误报', findBadWideSelects(dbSrc).length === 0);

// ----- 汇总 -----

console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项断言`);
  process.exit(0);
}
console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
for (const f of failures) console.log(`   - ${f}`);
process.exit(1);
