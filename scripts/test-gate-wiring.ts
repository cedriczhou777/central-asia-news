/**
 * **闸门接线审计**（2026-10-24）—— 「每个质检闸，它真的接上了吗？」
 *
 * ## 为什么要有这个脚本
 *
 * 2026-10-23 查出一个**极难发现的失效**：
 * 10-20 加的「量级闸」与「内容层闸」只产生了 `reject`，**没接进 `ok`** ⇒
 * `result.translated` 仍为 true ⇒ `translateNews` 里
 * `if (result.translated && …) return result;` **抢先命中** ⇒
 * **`reject` 被完全忽略** ⇒ **那两道闸从来没生效过**。
 *
 * ⚠️⚠️ 而它**外表完全看不出来**：有代码、有注释、有测试、有统计字段、有部署指纹，
 * **线上还「看起来正常」**（模型自己偶尔会改对）⇒ ⇒ **只能靠「逐个核对接线」发现**。
 *
 * ## 这个脚本查什么
 *
 * 对每个机制查两件事：
 * ① **它被调用了吗**（代码里有没有出现）；
 * ② **★ 它的输出真的进了最终结果吗**（返回值 / 判定列表用的是不是它算出来的那份）。
 *
 * ② 才是关键 —— ① 成立而 ② 不成立，就是「装饰品闸」。
 *
 * ## 为什么必须是**门禁的一部分**
 *
 * 因为**人会忘**。⇒ 以后每加一道闸，这个脚本会自动问它「你真的接上了吗」。
 * ⇒ 门禁红 ⇒ 就是有闸没接上 ⇒ **当场就能查出来**，而不是等用户投诉。
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const R = (f: string) => readFileSync(resolve(process.cwd(), f), 'utf8');

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

const tr = R('src/lib/translate.ts');
const ed = R('src/lib/editor-review.ts');
const se = R('src/lib/same-event.ts');
const pu = R('src/app/api/wechat/push/route.ts');
const fe = R('src/app/api/fetch-news/route.ts');
const dc = R('src/app/api/dedupe-check/route.ts');

/** `normalizeResult` 的函数体（从它到下一个函数声明）。 */
const nrm = tr.slice(tr.indexOf('function normalizeResult'), tr.indexOf('function resolveModel'));
/** `normalizeResult` 的返回语句。 */
const ret = tr.slice(tr.indexOf('return {\n    result: {\n      titleZh'), tr.indexOf('function resolveModel'));
/** `translateNews` 的函数体。 */
const tn = tr.slice(tr.indexOf('export async function translateNews'));

// ============================================================
// 一、翻译层：每道闸的输出**真的进了返回值**吗
// ============================================================
section('翻译层：机械清理/改写 ⇒ 真的进了返回值');

// ★ 链条：titleZh → stripNote → stripTrailingPhotoLabel → westernScaleToChinese
ok('FOTO 剥离被调用', nrm.includes('stripTrailingPhotoLabel(titleZh)'));
ok(
  '★ 返回的 title 是「剥过 FOTO + 改写过西式量级词」的那一份',
  ret.includes('titleZh: ok ? westernTitle.text'),
  ret.match(/titleZh: ok \? [^\n]*/)?.[0] ?? '（没找到 titleZh 的返回）',
);
ok('西式量级词改写被调用（摘要/正文各一次）',
  nrm.includes('westernScaleToChinese(metaStrippedSummary.text)') &&
    nrm.includes('westernScaleToChinese(metaStrippedContent.text)'));
ok('★ 返回的 summary 是改写后的', ret.includes('summaryZh: ok ? westernSummary.text'));
ok('★ 返回的 content 是改写后的', ret.includes('contentZh: ok ? westernContent.text'));
ok('元评语剥离被调用（摘要 + 正文）',
  nrm.includes('stripMetaComments(summaryZh)') && nrm.includes('stripMetaComments(contentZh)'));
ok('★ 两条清理**串成一条链**（westernScale 作用在剥离后的文本上）',
  nrm.includes('westernScaleToChinese(metaStrippedSummary.text)') &&
    nrm.includes('westernScaleToChinese(metaStrippedContent.text)'),
  'westernScale 必须吃 metaStripped 的输出，否则同时命中两种问题时元评语会漏掉');
ok('★ 检出用的是**最终文本**（western 之后）',
  nrm.includes('findContentIssues(\n    `${westernTitle.text}') ||
    nrm.includes('`${westernTitle.text}\n${westernSummary.text}`'));

// ============================================================
// 二、软闸：它真的拦得住、且耗尽后**不丢稿**
// ============================================================
section('软闸：命中 ⇒ 重试一次；再命中 ⇒ 放行（绝不丢稿）');

ok('translateNews 解构了 softIssues', tn.includes('const { result, reject, softIssues }'));
ok('★ 有「第一次命中 ⇒ 带说明重试」的分支',
  tn.includes('repairHint = buildSoftHint(softIssues)') && tn.includes('softRetried = true;'));
ok('★ 命中时**不 return**（要落到下一次尝试）', tn.includes('// ⚠️ **不 return**'));
ok('★ 第二次命中 ⇒ 放行（不是 translated:false）',
  tn.includes('softGivenUp') &&
    /软闸重试后仍命中[\s\S]{0,600}return result;/.test(tn),
);
ok('★ softRetried 是跨通道共享的一个布尔（不是每通道各算一次）',
  /let softRetried = false;/.test(tn) && /softRetried = true;/.test(tn));
ok('★ softIssues 不在 `ok` 的合取里（进去 ⇒ 三次不过 ⇒ 丢稿）',
  !/const ok =[\s\S]{0,500}magnitudeIssues/.test(nrm) &&
    !/const ok =[\s\S]{0,500}contentIssues/.test(nrm));
ok('★ softIssues 真的从 normalizeResult 返回了',
  nrm.includes('...(softIssues ? { softIssues } : {})'));

// ============================================================
// 三、相似度地板：它真的影响「哪些对被合并」吗
// ============================================================
section('相似度地板：低于地板的判定不采信');

ok('applySimFloor 被调用', se.includes('applySimFloor(verdict, asked)'));
ok('★ pairs 用的是 keptVerdict（地板之上的）', se.includes('pairs: keptVerdict.map'));
ok('★ 被地板驳回的也进了 declined（漏合并窗口完整）',
  se.includes('!accepted.has(i) || asked[i].sim < PAIR_SIM_FLOOR'));
ok('★ 被驳回的**单独**报在 belowFloor（不混进「模型判否」）',
  se.includes('belowFloor: belowFloor.map') && se.includes('belowFloor?: Array<'));

// ============================================================
// 四、总审侧：清理不许进 `ok`（进 `ok` ⇒ 丢稿）
// ============================================================
section('总审侧：「有图/无图」标记不许进 ok');

ok('stripTitleMarkers 被调用', ed.includes('stripTitleMarkers(after)'));
ok('★ 清理不在 ok 的合取里', !/const ok =[\s\S]{0,300}stripTitleMarkers/.test(ed));

// ============================================================
// 四之二、★ 总审的跨批次提示：占位符在模板里 + 真的传下去
// ============================================================
//
// ⚠️ 2026-10-25 晚上在这儿**连续踩了两次同一种错**：
//   ① `reviewDraft` 内部调 `buildEditorPrompt` 时**没把 `recentSimilar` 传下去**；
//   ② 模板里**没有 `{RECENT_PUBLISHED}` 这个占位符**（`.replace` 挂在一个不存在的占位符上）。
// ⇒ 而这两种都**不报错、测试也可能全绿** ⇒ 只能靠「查每一环」钉住。
section('总审：跨批次提示的每一环都接上了');

ok('★ 模板里有 {RECENT_PUBLISHED} 占位符',
  ed.includes('{RECENT_PUBLISHED}\n') || ed.includes('\n{RECENT_PUBLISHED}'),
  '模板里没有这个占位符 ⇒ .replace 挂在空处 ⇒ 整段提示不会出现');
ok('★ 有对它的 .replace', ed.includes(".replace('{RECENT_PUBLISHED}'"));
ok('★ buildEditorPrompt 的参数里有 recentSimilar',
  /export function buildEditorPrompt\(args: \{[\s\S]{0,700}recentSimilar\?:/.test(ed));
ok('★ ★ reviewDraft 把它传给了 buildEditorPrompt（**漏这一行 ⇒ 功能为零**）',
  /buildEditorPrompt\(\{[\s\S]{0,600}recentSimilar/.test(ed),
  'reviewDraft → buildEditorPrompt 这一环没接上');
ok('★ 措辞含「可以不重复发」（用户口径：宁多勿少）', ed.includes('可以不重复发'));
ok('★ 措辞含「即使重复也请保留」（用户口径：重大事件重复无妨）', ed.includes('即使重复也请保留'));

// ============================================================
// 四之三、★ `llm.ok` 的语义：**「判组完全生效」**，不是「有没有判出重复」
// ============================================================
//
// ⚠️ 2026-10-27 实测发现：kg / az / tj 三国 `ok:false` **而且没有 `error`**
// ⇒ 「跑了、但没发现重复」被显示成「失败」⇒ **排查时会误判成故障**。
section('★ llm.ok：没有判出重复 ≠ 失败');
ok('★ 「一条都没判出」的分支里，ok 由 judgedError **与 candidateCount** 共同决定',
  /llm\.ok = !judgedError && \(llm\.candidateCount \?\? 0\) > 0;/.test(se),
  '找不到 `llm.ok = !judgedError && (llm.candidateCount ?? 0) > 0` ⇒ ' +
  '「没问模型」与「问了但没发现重复」又分不开（既有守卫要求前者是 false）');
ok('★ 类型注释写明了新语义（避免下一个人又按旧语义读）',
  /「判组完全生效」/.test(se));

// ============================================================
// 五、簇形态：**只挂诊断**，不许进生产
// ============================================================
section('簇形态：只挂体检接口，生产链路仍走 pair');

ok('★ 生产路径没有指定 cluster', !pu.includes("mode: 'cluster'"));
ok('体检接口放行了 mode=cluster', dc.includes("'cluster'"));

// ============================================================
// 六、观测：每个闸的计数都要能从接口读到
// ============================================================
section('观测：每个闸的计数都在接口的类型里');

for (const k of [
  'magnitude',
  'contentIssue',
  'metaStripped',
  'photoLabelStripped',
  'westernScaleRewritten',
  'softRetry',
  'softGivenUp',
]) {
  ok(`termGate.${k} 可观测`, fe.includes(k) || tr.includes(k));
}

// ============================================================
// 九、★★ 2026-10-28 事故的三条守卫（**今天的纰漏不许再发生**）
// ============================================================
section('★★ push：判组前必须有候选上限（2026-10-28 事故的根因）');
{
  // 事故：选稿时 `eligible` = 本国**全部**合格候选（kz 一国 165 篇），
  // `dedupeStories` 内部两两配对 ⇒ O(n²) ⇒ 约 1.35 万次 bigram 运算
  // ⇒ 而容器只有 0.25 核 ⇒ ⇒ 整轮在逐国发布的中途崩掉
  // ⇒ ⇒ 草稿箱里只剩前两国的稿子，后三国整轮没出来。
  const limits = R('src/lib/push-limits.ts');
  ok('★ 上限常量存在（PUSH_JUDGE_CANDIDATE_CAP）',
    /export const PUSH_JUDGE_CANDIDATE_CAP\s*=\s*\d+/.test(limits));
  ok('★ 上限有上限值（不是 0 / 不是天文数字）',
    (() => {
      const m = limits.match(/PUSH_JUDGE_CANDIDATE_CAP\s*=\s*(\d+)/);
      if (!m) return false;
      const v = Number(m[1]);
      return v > 0 && v <= 200;
    })());
  ok('★ ★ 截断真的在**判组之前**（dedupeStories 的入参是截断后的量）',
    /judgeCandidates/.test(pu) &&
      /dedupeStories\(judgeCandidates\)/.test(pu) &&
      // 截断必须在 dedupeStories 之前出现
      pu.indexOf('PUSH_JUDGE_CANDIDATE_CAP') < pu.indexOf('dedupeStories(judgeCandidates)'),
    '截断点必须排在 dedupeStories 调用之前');
  ok('★ 截断量被报进 summary（不许静默截断）',
    /candidatesDroppedByLimit\.push\(/.test(pu) && /stage:\s*'before_judge'/.test(pu));
}

section('★★ push：一国失败不许带走整轮（2026-10-28 事故的直接防线）');
{
  // 事故：整轮崩在**第 3 国** ⇒ 草稿箱里只剩前两国的稿子。
  // ⇒ 而 `addDraft` **早就有** try/catch（跳过该国）——
  // ⇒ **漏掉的是它前面那些**：正文外链图上传（每篇一次网络请求）、缩略图上传、HTML 生成
  // ⇒ ⇒ **它们一崩，整轮就没了**。
  // ⇒ 所以断言的是：**整个国家块**外面有 try ⇒ ⇒ 某国失败 ⇒ 跳过该国、其余照常。
  const pubStart = pu.indexOf('for (const { country, articles: selectedArticles } of prepared) {');
  const pubEnd = pu.indexOf('results.push({', pubStart);
  const pubBlock = pu.slice(pubStart, pubEnd);
  ok('★ 逐国发布循环**整块**被 try 包住（图片上传/缩略图/建草稿全在内）',
    /try\s*\{/.test(pubBlock),
    '崩溃点若在 try 之外 ⇒ 一国失败就会带走整轮');
  ok('★ 失败时记进 `failures`（不静默）',
    /failures\.push\(\{/.test(pu.slice(pubStart, pubStart + 12000)));
  ok('★ 失败时 `continue`（继续下一个国家，不是整轮中止）',
    /catch[\s\S]{0,400}?continue;/.test(pu.slice(pubStart, pubStart + 12000)));
}

section('★★ push 状态必须落库（2026-10-28 最大可观测性缺口）');
{
  // 事故：`pushRunState` 是**模块级内存态** ⇒ 实例一换（部署/缩容/冷启动）就全丢
  // ⇒ ⇒ 「上一轮为什么只出了 2 篇」在架构上**查不到**（summary 与 error 都是 null）。
  ok('★ 落库模块存在', /export async function persistPushRun/.test(R('src/lib/push-run-store.ts')));
  // ⚠️ 判的是**写入处**（`void persistPushRun(pushRunState);`），
  // 不是 import 那一行（`import { persistPushRun, … }` 没有左括号，不该计入）。
  const persistCalls = (pu.match(/void persistPushRun\(/g) || []).length;
  ok('★ POST 的**开始 / 成功 / 失败**三处都落库（崩了的原因必须留下）',
    persistCalls >= 3,
    `找到 ${persistCalls} 处写入（开始 / 成功 / 失败 各 1 处）`);
  ok('★ GET 优先读库（跨实例可查）', /loadPersistedPushRun\(\)/.test(pu));
  ok('★ 落库失败不阻塞推送（永不抛异常）',
    /export async function persistPushRun/.test(R('src/lib/push-run-store.ts')) &&
      /catch\s*\(/.test(R('src/lib/push-run-store.ts')));
}

section('★★ 增源：加源前必须判重（2026-10-28 新增纪律）');
{
  ok('★ 判重工具存在（check-source-dup）', /Jaccard|DUP_RATIO/.test(R('scripts/check-source-dup.ts')));
  ok('★ 判重阈值不是 0（否则等于不判重）', (() => {
    const m = R('scripts/check-source-dup.ts').match(/DUP_RATIO\s*=\s*([\d.]+)/);
    return !!m && Number(m[1]) > 0 && Number(m[1]) <= 1;
  })());
}

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
