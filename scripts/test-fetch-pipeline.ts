/**
 * `fetch-pipeline`（共用零件）的回归（2026-10-27）。
 *
 * ## 为什么要有这个
 *
 * 2026-10-27 把 8 个采集零件从 `fetch-news/route.ts` **逐字搬到** `src/lib/fetch-pipeline.ts`
 * ⇒ 目的是让新增的 `POST /api/telegram-ingest` 与 RSS 路径**走同一套判据**。
 *
 * ⚠️ 而「搬出来」这类改动最危险的不是搬错（门禁能验类型），而是
 * **两边各写一份、日后慢慢漂移** ⇒ ⇒ 所以这里钉住三件事：
 *
 * ① ★ **组装字段集一致** —— `buildArticleRow` 与 route.ts 里那个内联 push
 *    **必须字段名完全一样**（少一个字段 ⇒ 入库少一个字段 ⇒ 静默丢数据）。
 * ② ★ **零件只有一份出处** —— route.ts 里**不许**再出现本地定义
 *    （出现两份 ⇒ 改一份忘另一份 ⇒ 判据分叉；这个项目栽过五次同类）。
 * ③ ★ **鉴权必须 fail-closed** —— 未配置 secret ⇒ 401（绝不「没配置就放开」）。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { buildArticleRow } from '../src/lib/fetch-pipeline';

let passed = 0;
const failures: string[] = [];
function section(name: string): void {
  console.log(`\n${'-'.repeat(60)}\n${name}\n${'-'.repeat(60)}`);
}
function ok(desc: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${desc}`);
  } else {
    failures.push(`${desc}${detail ? `　→ ${detail}` : ''}`);
    console.log(`  ✗ ${desc}${detail ? `　→ ${detail}` : ''}`);
  }
}

const R = (f: string) => readFileSync(resolve(process.cwd(), f), 'utf8');
const route = R('src/app/api/fetch-news/route.ts');
const lib = R('src/lib/fetch-pipeline.ts');
const ingest = R('src/app/api/telegram-ingest/route.ts');

// ============================================================
// 一、★ 组装字段集一致（route.ts 的内联 push vs buildArticleRow）
// ============================================================
section('★ 组装字段集：两边必须完全一致');

/** 从 `articlesToInsert.push({ ... })` 里抽出字段名。 */
function fieldsOfPush(src: string): string[] {
  const i = src.indexOf('articlesToInsert.push({');
  assert(i >= 0, 'route.ts 里找不到 articlesToInsert.push({');
  const j = src.indexOf('});', i);
  assert(j > i, 'route.ts 里 push 的结尾找不到');
  const body = src.slice(i, j);
  // 顶层字段名：`xxx:` 且**不在嵌套对象里**
  //
  // ⚠️ 深度必须**从 push 那一行之后**开始算 —— `push({` 自己带一个 `{`，
  // 若把它算进去，深度会从 1 起步 ⇒ **一个字段都抽不到**（2026-10-27 踩到）。
  const out: string[] = [];
  let depth = 0;
  const lines = body.split('\n');
  for (let k = 1; k < lines.length; k++) {
    const line = lines[k];
    // ⚠️ 两种写法都要认：`xxx:`（带值）与 `xxx,`（**简写**，值在上面已经算好了）
    // ⇒ route.ts 里 `category` / `tags` 就是简写 ⇒ 只认 `:` 会漏两个字段（2026-10-27 踩到）。
    const m = /^\s{10}([a-z_]+)\s*[:,]/.exec(line);
    if (m && depth === 0) out.push(m[1]);
    depth += (line.match(/[{[(]/g) || []).length - (line.match(/[}\])]/g) || []).length;
  }
  return out;
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const pushFields = fieldsOfPush(route);
const row = buildArticleRow({
  titleZh: 't',
  summaryZh: 's',
  contentZh: 'c',
  countryCode: 'kz',
  category: 'economy',
  sourceName: 'Telegram/@x',
  sourceUrl: 'https://t.me/x/1',
  originalTitle: 'o',
  originalContent: 'oc',
  originalLanguage: 'ru',
  publishedAt: '2026-01-01T00:00:00.000Z',
  tags: ['综合'],
  coverImage: '',
  imageUrls: [],
});
const rowFields = Object.keys(row).sort();

ok('route.ts 里那个 push 抽得出字段', pushFields.length > 0, `抽到 ${pushFields.length} 个`);
ok(
  '★ buildArticleRow 的字段集 == route.ts 里那个 push 的字段集（**少一个就是静默丢数据**）',
  JSON.stringify(rowFields) === JSON.stringify([...pushFields].sort()),
  `route=${JSON.stringify([...pushFields].sort())}\n     lib =${JSON.stringify(rowFields)}`,
);
ok('★ 两边都有 `country_code`（写错 ⇒ intl 稿永远推不出去）', rowFields.includes('country_code'));
ok('★ 两边都有 `original_title` / `original_content`（总审要靠它核对）',
  rowFields.includes('original_title') && rowFields.includes('original_content'));
ok('★ 两边都有 `published_at`（Postgres 拒收脏时间戳 ⇒ 整批失败）', rowFields.includes('published_at'));

// ============================================================
// 二、★ 零件只有一份出处
// ============================================================
section('★ 零件只有一份出处（route.ts 里不许再有本地定义）');

for (const name of [
  'toSafeIso',
  'isJunkTitle',
  'isInvestmentRelevant',
  'extractTags',
  'extractImagesFromHtml',
  'fetchOgImage',
  'backfillBody',
]) {
  const local = new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, 'm').test(route);
  const inLib = new RegExp(`^export (?:async )?function ${name}\\b`, 'm').test(lib);
  ok(
    `★ ${name}：只存在于 lib（route.ts 里不该再有本地定义）`,
    inLib && !local,
    `route 里${local ? '有' : '没有'}本地定义 / lib 里${inLib ? '有' : '没有'}导出`,
  );
}
ok('★ route.ts 从 fetch-pipeline 导入这些零件',
  route.includes("from '@/lib/fetch-pipeline'") && route.includes('buildArticleRow') === false,
  '⚠️ route.ts 若也开始用 buildArticleRow，说明两边已合流（那是好事，但要确认字段集断言还在）');
ok('★ 垃圾标题词表只搬了一份（不在 route.ts 里）',
  !/^const JUNK_TITLE_KEYWORDS/m.test(route) && /^export const JUNK_TITLE_KEYWORDS/m.test(lib));

// ============================================================
// 三、★ 鉴权必须 fail-closed
// ============================================================
section('★ ingest 接口的鉴权必须 fail-closed');

ok('★ 未配置 TELEGRAM_INGEST_SECRET ⇒ 一律 401（不许「没配置就放开」）',
  /if \(!expected\)[\s\S]{0,260}status: 401/.test(ingest));
ok('★ secret 不匹配 ⇒ 401', /provided !== expected[\s\S]{0,120}status: 401/.test(ingest));
ok('★ secret 从 header 读（不是 query、不是 body）', /headers\.get\('x-ingest-secret'\)/.test(ingest));
ok('★ 查重失败 ⇒ fail-closed（本批不入库）',
  /查重失败[\s\S]{0,200}status: 503/.test(ingest));
ok('★ 频道不在表里 ⇒ 400（不知道国家就不能入库）',
  /不在频道表里[\s\S]{0,160}status: 400/.test(ingest));

// ============================================================
// 四、★ ingest 与 RSS 用的是同一批零件
// ============================================================
section('★ ingest 与 RSS 用的是同一批零件（判据只有一份）');

for (const name of [
  'toSafeIso',
  'isJunkTitle',
  'isInvestmentRelevant',
  'extractTags',
  'extractImagesFromHtml',
  'fetchOgImage',
  'backfillBody',
  'buildArticleRow',
]) {
  ok(`ingest 用了 ${name}`, new RegExp(`\\b${name}\\b`).test(ingest));
}
ok('★ ingest 与 route.ts 都从同一个模块 import（不是各写一份）',
  ingest.includes("from '@/lib/fetch-pipeline'") && route.includes("from '@/lib/fetch-pipeline'"));
ok('★ ingest 用的是同一个 translateNews', ingest.includes("from '@/lib/translate'"));

// ============================================================
console.log(`\n${'='.repeat(64)}`);
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
