/**
 * 整体总审（终审编辑）的离线回归 —— 不联网、不调模型。
 *
 * 用法：`pnpm test:editor-review`
 *
 * ## 为什么这个脚本必须存在，而且必须双向
 *
 * 总审是全链路里**权限最大**的模型环节：它不但能删稿，还能**改写要发出去的文字**。
 * 而它的失败形态全是**静默**的 —— 删错了不会报错，只是成品里少一条；
 * 改错了不会报错，只是发出去的话变了意思。这与本项目反复踩过的
 * 「删除类判据」是同一类风险（对照 `same-event.ts` 的做法）。
 *
 * 所以这里测的不是「模型判得准不准」（那要靠线上体检），而是：
 *   ① 合规的处置**确实**被执行（不然这层是摆设）；
 *   ② 越界的处置**确实**被挡住，并且**留了痕**（不然护栏是摆设）；
 *   ③ 模型整个失败时**一条都不改**（不然「模型今天不行」= 静默丢稿）。
 *
 * ⚠️ 其中最容易被后人删掉的两条，单独说明：
 *   - `fixes` 的 `before` 必须逐字匹配。它是**唯一**能发现「模型改错了条目」的手段。
 *   - 终审写出的文字必须**通过翻译层那几道闸**（`descendingMultiplePhrases` /
 *     书写系统闸）。否则会出现荒谬的循环：翻译层刚拦下 `下调1.5倍`，总审又写回来。
 */

import {
  applyVerdict,
  buildEditorPrompt,
  crossCountryOverlaps,
  DROP_KINDS,
  DUP_SIM_FLOOR,
  EDITOR_PROMPT,
  EDITOR_PROMPT_VERSION,
  fixRejectReason,
  isEditorReviewEnabled,
  MAX_DROPS,
  MAX_FIXES,
  MAX_TITLE_LEN,
  MIN_KEEP,
  ORIGINAL_EXCERPT_MAX,
  parseVerdict,
  PLACEHOLDER_TOKENS,
  planCoverBorrows,
  QUOTE_MIN,
  reviewDraft,
  type ReviewItem,
} from '../src/lib/editor-review';
import { pickDraftCover } from '../src/lib/draft-cover';
import { PAIR_CANDIDATE_MIN_SIM } from '../src/lib/same-event';
import { similarity } from '../src/lib/utils';
import { readFileSync } from 'fs';
import { resolve } from 'path';

let passed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
  } else {
    failures.push(`${name}${detail ? ' —— ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`);
  }
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

/** 造一批待审稿件。标题用真实的线上标题，方便对着看。 */
function mkItems(n: number, titles?: string[]): ReviewItem[] {
  const base = titles ?? [
    '阿塞拜疆与亚洲基础设施投资银行就基础设施项目合作进行讨论',
    '阿塞拜疆与亚洲基础设施投资银行讨论扩大在绿色经济转型方面的合作',
    '哈萨克斯坦总统下令国防部开展全面检查',
    '哈萨克斯坦国防部启动审计',
    '乌兹别克斯坦大型电力用户白天电价下调1.5倍',
    '塔吉克斯坦桑搏世锦赛开幕',
    '吉尔吉斯斯坦曼纳斯市 R. Azimov 第 13 中学新增 500 个学生名额',
    '阿塞拜疆航空与国立音乐学院举办国家音乐日竞赛',
  ];
  return Array.from({ length: n }, (_, i) => ({
    title: base[i] ?? `第 ${i} 条稿件`,
    summary: `第 ${i} 条摘要，讲了一件有金额和主体的事。`,
    category: 'economy',
    source: 'Test.az',
    time: '2026-09-28 10:00',
    hasImage: i % 2 === 0,
    relevance: 10 - i,
    contentPeek: `第 ${i} 条正文开头两百字。`,
  }));
}

/**
 * 造一条**合规**的 duplicate 理由。
 *
 * v3 起 `reason` 必须**逐字引用 ≥6 字原文**（见 `QUOTE_MIN`），所以夹具里不能随手写
 * 「与第 0 条重复」这种空话 —— 那正是 2026-09-29 事故的形态（五国交上来的理由一模一样、
 * 且不是本批任何一条的原文），现在会被护栏当场拦下。
 *
 * 这个 helper 把**引哪一段原文**变成夹具里显式可见的东西：`quote` 必须真出现在
 * 被指那条的标题里，否则断言会红 —— 这正是我们想要的那种红。
 */
function dupReason(sameAsIdx: number, quote: string): string {
  return `与第 ${sameAsIdx} 条同为「${quote}」那一件事`;
}

// ============================================================
// 一、开关与版本
// ============================================================

section('一、开关（EDITOR_REVIEW）与提示词版本');

{
  const saved = process.env.EDITOR_REVIEW;
  const restore = () => {
    if (saved === undefined) delete process.env.EDITOR_REVIEW;
    else process.env.EDITOR_REVIEW = saved;
  };
  try {
    delete process.env.EDITOR_REVIEW;
    ok('未设 EDITOR_REVIEW 时总审**默认开**', isEditorReviewEnabled() === true);
    for (const off of ['off', 'OFF', '0', 'false', ' false ']) {
      process.env.EDITOR_REVIEW = off;
      ok(`EDITOR_REVIEW=${JSON.stringify(off)} 关掉总审（紧急刹车可用）`, isEditorReviewEnabled() === false);
    }
    process.env.EDITOR_REVIEW = 'on';
    ok('EDITOR_REVIEW=on 打开总审', isEditorReviewEnabled() === true);
  } finally {
    restore();
  }
}
ok('提示词有版本号（改了提示词要能分辨）', EDITOR_PROMPT_VERSION.length > 0, EDITOR_PROMPT_VERSION);
// ⚠️ 这条是**故意写死字面量**的：它是一个「改了提示词就得改版本号」的哨兵。
// 提示词一改而版本没动，`summary.review[].promptVersion` 就会撒谎，
// 「两次结论不同」也就分不清是换了提示词还是换了模型 —— 那正是这个字段存在的唯一理由。
// 改动提示词时把它 +1，并同步这条断言（`AGENTS.md` 的改动清单里提到过）。
ok(
  '提示词版本号与 v4 对齐（改了提示词必须先改版本号）',
  EDITOR_PROMPT_VERSION === 'v4',
  `现在是 ${EDITOR_PROMPT_VERSION} —— 若你刚改了提示词，请把 EDITOR_PROMPT_VERSION +1 并同步这条断言`,
);
// v4 的触发条件是**用户拿着截图逐条报错**（2026-10-01 晚报）：凭空年份、量级错、
// 州名错、张冠李戴的国名、标题与正文自相矛盾…… 这些**没有一条**能靠「中文自洽性」查到，
// 全都要求拿原文对照。而总审从来没看过原文 ⇒ v4 的第一件事就是把原文喂进去。
// 这条哨兵存在的意义：`summary.review[].promptVersion` 若撒谎，
// 「同一批稿子两次结论不同」就分不清是换了提示词还是换了模型。

// ============================================================
// 二、正常路径：合规的处置必须**真的被执行**
// ============================================================

section('二、正常路径（合规处置确实生效）');

{
  const items = mkItems(8);
  // 前置条件自证：这一对锚点的相似度必须真的过得了 v3 的 `DUP_SIM_FLOOR`，
  // 否则下面的「删稿被采纳」测的就不是正常路径，而是护栏。
  const anchorSim = similarity(items[1].title, items[0].title);
  ok(
    `锚点相似度 ${anchorSim.toFixed(4)} ≥ DUP_SIM_FLOOR(${DUP_SIM_FLOOR})（前置条件）`,
    anchorSim >= DUP_SIM_FLOOR,
    `只有 ${anchorSim.toFixed(4)} —— 夹具变了？`,
  );
  const { decision, audit } = applyVerdict(items, {
    // 故意给一个**被打乱**的顺序：验证排序真的被采纳
    order: [1, 0, 3, 2, 5, 4, 7, 6],
    drops: [
      // 真实的线上场景：这两条是同一场会谈（阿塞拜疆政府与 AIIB）
      {
        index: 1,
        kind: 'duplicate',
        sameAs: 0,
        reason: dupReason(0, '阿塞拜疆与亚洲基础设施投资银行'),
      },
    ],
    fixes: [
      {
        index: 4,
        field: 'title',
        before: '乌兹别克斯坦大型电力用户白天电价下调1.5倍',
        after: '乌兹别克斯坦大型电力用户白天电价降至原来的 1/1.5（约低 33%）',
        why: '下降方向不能用倍，原意是除以 1.5',
      },
    ],
    needsImage: [0, 3],
    verdict: '有一条重复，一条倍数说反了',
  });

  ok('删稿被采纳', audit.appliedDrops === 1, JSON.stringify(audit));
  ok('删的是第 1 条（保留信息更全的第 0 条）', decision.drops[0]?.index === 1);
  ok('删稿的 kind 与理由被带出来（审计要能回答「凭什么删」）', decision.drops[0]?.kind === 'duplicate' && (decision.drops[0]?.reason.length ?? 0) > 8);
  ok('重排被采纳', audit.orderAccepted === true);
  ok('最终顺序剔掉了被删的第 1 条，且保持模型给的相对次序', JSON.stringify(decision.finalIndices) === JSON.stringify([0, 3, 2, 5, 4, 7, 6]), JSON.stringify(decision.finalIndices));
  ok('文字修正被采纳', decision.fixes.length === 1 && audit.appliedFixes === 1);
  ok('修正保留了 before/after 两端（能追溯改了哪句）', decision.fixes[0]?.before.includes('下调1.5倍') && decision.fixes[0]?.after.includes('1/1.5'));
  ok('needsImage 被采纳', JSON.stringify(decision.needsImage) === JSON.stringify([0, 3]));
  ok('总评被带出', decision.verdict.includes('重复'));
  ok('没有任何护栏拒绝记录（正常路径不该有噪音）', audit.rejections.length === 0, JSON.stringify(audit.rejections));
}

// ============================================================
// 三、护栏：越界的处置必须被挡住，且留痕
// ============================================================

section('三、护栏 · order 必须是完整排列');

{
  const items = mkItems(8);
  // 少了几个（模型只给了「它关心的」那几条）
  const r1 = applyVerdict(items, { order: [0, 1, 2] });
  ok('order 少给 ⇒ 整条作废，保持原序', JSON.stringify(r1.decision.finalIndices) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7]), JSON.stringify(r1.decision.finalIndices));
  ok('order 少给 ⇒ 留痕', r1.audit.orderAccepted === false && r1.audit.rejections.some((x) => x.includes('完整排列')));

  // 有重复
  const r2 = applyVerdict(items, { order: [0, 0, 2, 3, 4, 5, 6, 7] });
  ok('order 有重复 ⇒ 整条作废', r2.audit.orderAccepted === false);

  // 越界
  const r3 = applyVerdict(items, { order: [0, 1, 2, 3, 4, 5, 6, 99] });
  ok('order 越界 ⇒ 整条作废', r3.audit.orderAccepted === false && r3.audit.rejections.some((x) => x.includes('越界')));

  // 不是数组
  const r4 = applyVerdict(items, { order: 'first-to-last' });
  ok('order 不是数组 ⇒ 保持原序并留痕', r4.audit.orderAccepted === false && JSON.stringify(r4.decision.finalIndices) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7]));

  // 不动顺序时也应当被认定为「合法」
  const r5 = applyVerdict(items, { order: [0, 1, 2, 3, 4, 5, 6, 7] });
  ok('原序也是合法排列（不该报错）', r5.audit.orderAccepted === true && r5.audit.rejections.length === 0);
}

section('三之二、护栏 · drops 的三重上限');

{
  const items8 = mkItems(8); // 上限 = min(4, floor(8/3)=2) = 2
  const dupA = { index: 1, kind: 'duplicate', sameAs: 0, reason: dupReason(0, '阿塞拜疆与亚洲基础设施投资银行') };
  const dupB = { index: 2, kind: 'duplicate', sameAs: 3, reason: dupReason(3, '哈萨克斯坦国防部') };
  // 前置条件：第 2/3 条也得过得了相似度下限，否则这两格测的就不是上限了
  ok(
    `第 2/3 条这一对也过得了下限（前置条件，sim=${similarity(items8[2].title, items8[3].title).toFixed(4)}）`,
    similarity(items8[2].title, items8[3].title) >= DUP_SIM_FLOOR,
  );
  const r1 = applyVerdict(items8, { drops: [dupA, dupB] });
  ok(`删 ${2} 条（= 上限）被采纳`, r1.audit.appliedDrops === 2, JSON.stringify(r1.audit));

  const r2 = applyVerdict(items8, {
    drops: [
      dupA,
      dupB,
      {
        index: 5,
        kind: 'not_news',
        reason: '「塔吉克斯坦桑搏世锦赛」是体育赛事，不是投资新闻',
      },
    ],
  });
  ok('超比例上限 ⇒ **整组作废**（不是取前 2 条）', r2.audit.appliedDrops === 0, JSON.stringify(r2.audit));
  ok('整组作废时保留全部稿件', r2.decision.finalIndices.length === 8);
  ok('整组作废的理由写清了是比例超限', r2.audit.rejections.some((x) => x.includes('整组作废')), JSON.stringify(r2.audit.rejections));

  // 保留下限：6 条删 2 条只剩 4 < MIN_KEEP=5
  const items6 = mkItems(6);
  const r3 = applyVerdict(items6, {
    drops: [
      { index: 1, kind: 'duplicate', sameAs: 0, reason: dupReason(0, '阿塞拜疆与亚洲基础设施投资银行') },
      { index: 2, kind: 'duplicate', sameAs: 3, reason: dupReason(3, '哈萨克斯坦国防部') },
    ],
  });
  ok(`删完低于保留下限 ${MIN_KEEP} 条 ⇒ 整组作废`, r3.audit.appliedDrops === 0, JSON.stringify(r3.audit));
  ok('保留下限的理由写清了', r3.audit.rejections.some((x) => x.includes('保留下限')));
  const r4 = applyVerdict(items6, {
    drops: [{ index: 1, kind: 'duplicate', sameAs: 0, reason: dupReason(0, '阿塞拜疆与亚洲基础设施投资银行') }],
  });
  ok('删 1 条（删完 = 保留下限）仍被采纳', r4.audit.appliedDrops === 1, JSON.stringify(r4.audit));

  ok(`MAX_DROPS 常量存在且有限（护栏可被断言）`, Number.isFinite(MAX_DROPS) && MAX_DROPS > 0, String(MAX_DROPS));
}

section('三之三、护栏 · drops 的逐条合规');

{
  const items = mkItems(8);
  const cases: Array<{ name: string; raw: unknown; needle: string }> = [
    { name: 'index 越界', raw: { index: 99, kind: 'duplicate', reason: '看着像重复' }, needle: '越界' },
    { name: 'index 不是整数', raw: { index: 'first', kind: 'duplicate', reason: '看着像重复' }, needle: '越界' },
    { name: 'kind 非法', raw: { index: 1, kind: 'boring', reason: '这条太无聊' }, needle: 'kind 非法' },
    { name: 'kind 为空', raw: { index: 1, reason: '这条太无聊' }, needle: 'kind 非法' },
    { name: '理由为空', raw: { index: 1, kind: 'duplicate', reason: '' }, needle: '具体理由' },
    { name: '理由太短（「重复」两个字不算具体）', raw: { index: 1, kind: 'duplicate', reason: '重复' }, needle: '具体理由' },
    // 抄示例占位符、以及「指不出与第几条重复」这两格。
    // ⚠️ v4 起第二格（缺 sameAs）从「附加理由」升级成了**该 kind 唯一的证据要求** ——
    //    见第十之二节：duplicate 这件事只认 sameAs，不再额外要引文。
    { name: '理由照抄了示例占位符', raw: { index: 1, kind: 'duplicate', sameAs: 0, reason: `与第 0 条同为「${PLACEHOLDER_TOKENS[0]}」` }, needle: '占位符' },
    { name: 'duplicate 却指不出与第几条重复（没有 sameAs）', raw: { index: 1, kind: 'duplicate', reason: dupReason(0, '阿塞拜疆与亚洲基础设施投资银行') }, needle: 'sameAs' },
  ];
  for (const c of cases) {
    const r = applyVerdict(items, { drops: [c.raw] });
    ok(`逐条拒绝：${c.name}`, r.audit.appliedDrops === 0 && r.audit.rejections.some((x) => x.includes(c.needle)), JSON.stringify(r.audit.rejections));
  }
  const dupOnce = { index: 1, kind: 'duplicate', sameAs: 0, reason: dupReason(0, '阿塞拜疆与亚洲基础设施投资银行') };
  const r = applyVerdict(items, { drops: [dupOnce, { ...dupOnce }] });
  ok('同一条被提了两次 ⇒ 只算一次', r.audit.appliedDrops === 1, JSON.stringify(r.audit));
}

section('三之四、护栏 · fixes 的 before 必须逐字匹配（防改错条目）');

{
  const items = mkItems(8);
  const target = items[4]; // 电价那条
  const r1 = applyVerdict(items, {
    fixes: [{ index: 4, field: 'title', before: '这行字和原文完全不同', after: '电价降至原来的 1/1.5', why: '改倍数' }],
  });
  ok('before 与原文不符 ⇒ 拒绝', r1.audit.appliedFixes === 0, JSON.stringify(r1.audit));
  ok('并留痕说清「模型抄的和实际不是同一条」', r1.audit.rejections.some((x) => x.includes('before 与原文不符')), JSON.stringify(r1.audit.rejections));

  const r2 = applyVerdict(items, {
    fixes: [{ index: 4, field: 'title', before: target.title, after: '电价降至原来的 1/1.5（约低 33%）', why: '改倍数' }],
  });
  ok('before 逐字相同 ⇒ 采纳', r2.audit.appliedFixes === 1, JSON.stringify(r2.audit));

  // 允许首尾空白差异（模型偶尔会带上换行/空格），但不允许内容差异
  const r3 = applyVerdict(items, {
    fixes: [{ index: 4, field: 'title', before: `  ${target.title}  `, after: '电价降至原来的 1/1.5（约低 33%）', why: '改倍数' }],
  });
  ok('before 只差首尾空白 ⇒ 仍采纳（不苛求空白）', r3.audit.appliedFixes === 1);

  const r4 = applyVerdict(items, {
    fixes: [{ index: 4, field: 'content', before: target.title, after: '改正文', why: 'x' }],
  });
  ok('field 只认 title/summary（不许改正文）', r4.audit.appliedFixes === 0 && r4.audit.rejections.some((x) => x.includes('field 非法')));

  const r5 = applyVerdict(items, {
    fixes: [
      { index: 4, field: 'title', before: target.title, after: '电价降至原来的 1/1.5（约低 33%）', why: '改倍数' },
      { index: 4, field: 'title', before: target.title, after: '另一种改法', why: '又改一次' },
    ],
  });
  ok('同一条同字段重复给出 ⇒ 只取第一条', r5.audit.appliedFixes === 1 && r5.decision.fixes[0]?.after.includes('1/1.5'));

  // 上限
  // ⚠️ 这里必须让 (index, field) **两两不同**，否则撞上的是「同一条同字段重复给出」那条去重护栏，
  // 测的就不是上限了（第一版夹具就是这么写错的：9 条全是 index 0 / summary，最后只留 1 条）。
  const many = Array.from({ length: MAX_FIXES + 3 }, (_, i) => {
    const index = i % items.length; // 0..7,0 → 前 8 条彼此不同，第 9 条回到 0/title 与第 1 条重复
    const field: 'title' | 'summary' = i % 2 === 0 ? 'title' : 'summary';
    return {
      index,
      field,
      before: field === 'title' ? items[index].title : items[index].summary,
      after: `第 ${i} 种改法（够长的一段文字，避免被长度下限挡住）`,
      why: '测试上限',
    };
  });
  const r6 = applyVerdict(items, { fixes: many });
  ok(`fixes 超过上限 ${MAX_FIXES} ⇒ 只采纳前 ${MAX_FIXES} 条`, r6.audit.appliedFixes === MAX_FIXES, JSON.stringify(r6.audit));
  ok(`提案 9 条里确实有 ${MAX_FIXES} 条以上是合规的（否则上一条断言测不到东西）`, r6.audit.proposedFixes === MAX_FIXES + 3);
}

section('三之五、护栏 · 终审写出的文字必须通过翻译层的闸（防「闸自己开口子」）');

{
  // 这一节是整套护栏里最重要的一条：如果总审能把翻译层刚拦下的东西写回来，
  // 前面几道闸全部作废 —— 而且这次**没人再拦**（成品直接发出去）。
  const items = mkItems(8);

  const bad = [
    { name: '把「下调 1.5 倍」写回来', after: '乌兹别克斯坦电价下调1.5倍', needle: '不成立的倍数' },
    { name: '把「下调 13000 倍」写回来', after: '法院将赔偿金额下调 13000 倍', needle: '不成立的倍数' },
    { name: '写出半译专名', after: '新部长 库罗诺Boyev 上任', needle: '半译专名' },
    { name: '写出「汉字+西里尔」混排', after: '米尔зиёё夫总统讲话', needle: '汉字+西里尔' },
    { name: '写出空串', after: '   ', needle: '空' },
    { name: '写出带换行的文本', after: '第一行\n第二行', needle: '换行' },
    { name: '写出 HTML 标签', after: '电价<b>下调</b>', needle: 'HTML' },
    { name: '标题改成一个字', after: '电', needle: '太短' },
    { name: '标题超出微信上限', after: '电'.repeat(MAX_TITLE_LEN + 5), needle: '太长' },
  ];
  for (const c of bad) {
    const r = applyVerdict(items, {
      fixes: [{ index: 4, field: 'title', before: items[4].title, after: c.after, why: '测试' }],
    });
    ok(`拒绝危险改写：${c.name}`, r.audit.appliedFixes === 0 && r.audit.rejections.some((x) => x.includes(c.needle)), JSON.stringify(r.audit.rejections));
  }

  // 反向：合规的改写必须能过（否则这层等于废掉，等于「保护性关闭」）
  const good = applyVerdict(items, {
    fixes: [{
      index: 4,
      field: 'title',
      before: items[4].title,
      after: '乌兹别克斯坦大型电力用户 09:00–17:00 电价降至原来的 1/1.5（约低 33%）',
      why: '修正倍数方向',
    }],
  });
  ok('合规改写能通过（否则护栏变成「一律不改」）', good.audit.appliedFixes === 1, JSON.stringify(good.audit));

  // `fixRejectReason` 直接测：合规文本返回 null
  ok('fixRejectReason 对合规文本返回 null', fixRejectReason('这是一条合规的摘要文字', 'summary', 20) === null);
  ok('fixRejectReason 能识别倍数病句', fixRejectReason('电价下调 1.5 倍', 'title', 20)?.includes('倍数') === true);

  // 半译专名：终审用的是**放宽版**判据（连首字母大写也拦）。
  // 这一格是用户报过的原样文本，翻译层的 `mixedScriptTokensLatin` 恰好漏掉它
  // （只认全小写），所以终审这里必须比翻译层严。
  ok(
    'fixRejectReason 拦下用户原样报过的「库罗诺Boyev」（首字母大写）',
    fixRejectReason('卡赫拉莫恩·库罗诺Boyev 出任部长', 'title', 20)?.includes('半译专名') === true,
    String(fixRejectReason('卡赫拉莫恩·库罗诺Boyev 出任部长', 'title', 20)),
  );
  // 反向：这条路必须留着 —— 终审**要能**把半译专名改对（全汉字输出不命中任何判据）。
  // 如果这条不过，说明护栏把「修复半译专名」这条正路也堵死了。
  ok('但「把半译专名改对」这条路留着（全汉字输出放行）', fixRejectReason('卡赫拉莫恩·库罗诺博耶夫出任部长', 'title', 20) === null);
  // 规定写法「中文职务 + 空格 + 拉丁人名」也不该被误伤（否则终审一改就掉）。
  ok('规定写法「职务 + 空格 + 拉丁人名」不被误伤', fixRejectReason('纳扎尔巴耶夫 Nazarbayev 出席峰会', 'title', 20) === null);
}

section('三之六、护栏 · needsImage');

{
  const items = mkItems(8);
  const r = applyVerdict(items, {
    drops: [{ index: 5, kind: 'not_news', reason: '「塔吉克斯坦桑搏世锦赛开幕」是体育赛事，不是投资新闻' }],
    needsImage: [0, 5, 7, 99, -1, 'x'],
  });
  ok('needsImage 过滤越界项', JSON.stringify(r.decision.needsImage) === JSON.stringify([0, 7]), JSON.stringify(r.decision.needsImage));
  ok('needsImage 剔除已被删掉的条目（不提示给不存在的稿子配图）', !r.decision.needsImage.includes(5));
}

// ============================================================
// 四、解析模型返回（模型经常包一层 ```json 或带前后话）
// ============================================================

section('四、parseVerdict（模型的返回不可信，必须先解析成功）');

{
  ok('裸 JSON', parseVerdict('{"order":[0,1]}')?.order !== undefined);
  ok('围栏 json', parseVerdict('```json\n{"order":[0,1]}\n```')?.order !== undefined);
  ok('无语言标记的围栏', parseVerdict('```\n{"order":[0,1]}\n```')?.order !== undefined);
  ok('前后带解释文字也能抽出 JSON', parseVerdict('好的，我审完了：\n{"order":[0,1]}\n希望有帮助。')?.order !== undefined);
  ok('不是 JSON ⇒ null', parseVerdict('我觉得这份稿子还行') === null);
  ok('空串 ⇒ null', parseVerdict('') === null);
  ok('只有括号没有内容 ⇒ null', parseVerdict('{}') !== null && parseVerdict('{') === null);
}

// ============================================================
// 五、提示词：把该说的说清楚
// ============================================================

section('五、提示词（buildEditorPrompt）');

{
  const items = mkItems(8);
  const prompt = buildEditorPrompt({ countryName: '阿塞拜疆', items });
  ok('带上了国名', prompt.includes('阿塞拜疆'));
  ok('篇数出现（模型要知道总数才能给完整排列）', prompt.includes('共 8 篇') && prompt.includes('（8 篇）'));
  ok('每一条标题都在', items.every((it) => prompt.includes(it.title)));
  ok('带上了配图有无（第四件事才有依据）', prompt.includes('有图') && prompt.includes('无图'));
  ok('带上了相关性分（排序的参考基线）', prompt.includes('相关性分'));
  ok('写明了「跨国重复不归你管」（防止它替我们做跨国去重）', prompt.includes('跨国重复**不归你管') || prompt.includes('不要据此删'));
  ok('写明了「不确定就不要动」', prompt.includes('不确定就不要动'));
  ok('写明了「你是审不是写，不许新增事实」', prompt.includes('不许新增原文没有的事实'));
  ok('写明了 order 必须是完整排列', prompt.includes('完整排列'));
  // ⚠️ 序号范围必须写成「0 到 N-1」而不是「0 到 N」—— 差一格会让模型不敢用最后一个序号
  ok('序号范围写对了（8 篇 ⇒ 0 到 7）', prompt.includes('0 到 7 之间'), prompt.slice(prompt.indexOf('0 到'), prompt.indexOf('0 到') + 14));
  // JSON 示例里的 order 必须是**完整的恒等排列**，否则等于教模型输出不完整排列
  ok('JSON 示例给的是完整恒等排列（[0, 1, ..., 7]）', prompt.includes('[0, 1, 2, 3, 4, 5, 6, 7]'));
  ok('写明了 drops 必须给具体理由', prompt.includes('具体的') || prompt.includes('写不出具体理由就别删'));
  ok('写明了 fixes 的 before 必须逐字相同', prompt.includes('逐字完全相同'));
  ok('JSON 契约里的字段名都给了（order/drops/fixes/needsImage/verdict）',
    ['"order"', '"drops"', '"fixes"', '"needsImage"', '"verdict"'].every((k) => prompt.includes(k)));
  // 不喂全文是**刻意的**取舍，写成断言免得后人以为是漏了
  ok('不喂全文（contentPeek 只到 200 字，见该函数的取舍说明）', items[0].contentPeek.length <= 200);

  // ------------------------------------------------------------
  // v2：两处「提示词在撒谎」的修正 —— 两处都是**反例断言**
  // ------------------------------------------------------------
  //
  // ① 第四件事原来写「这些会由排版环节优先补图」。**链路里从来没有补图环节**
  //    （`article-format.ts` 反而把 unsplash/picsum 当编造图拦掉）。
  //    后果不是「白说一句」，而是让模型为了兑现一个不存在的机制去凑清单。
  ok(
    '⚠️ 不再声称「排版环节会优先补图」（那是从未实现的承诺）',
    !prompt.includes('优先补图'),
    '提示词里仍有「优先补图」—— 请检查是不是又写回了一个不存在的环节',
  );
  ok('第四件事改成实话：只给人工看、不会自动补图', prompt.includes('不会自动补图'));

  // ② 第五件事（真实性）—— 用户明确要求「审新闻的真实性」，
  //    而 v1 的四个 job 里没有一个管这件事。
  ok('提示词里是「七件事」（真实性 + 国家归属 + 与原文核对这三件事真的加进去了）', prompt.includes('七件事'));
  ok(
    '明说「无法联网、不要试图核实是否属实」（不夸口做不到的事）',
    // ⚠️ 断言不能写整句 —— 提示词里「不要」两侧有 `**` 加粗标记，整句子串匹配不到。
    // 这不是妥协：一条被加粗切碎的断言将来还会再骗人一次。
    prompt.includes('无法联网') && prompt.includes('试图核实'),
    prompt.includes('无法联网') ? '' : '提示词里找不到「无法联网」—— 是不是把外部核查当成了这一层的职责？',
  );
  // ★ 这条是本轮最值钱的一条：v1 里 `unreliable` **只出现在约束 2 的括号列表里**，
  //   从没说什么时候该用它 —— 那等于给了一个从未被说明的权限。现在三个 kind 都有判据。
  //   （断言用 `kind: "x"` 而不是裸子串：裸子串在 v1 里也是绿的，抓不到这个缺口。）
  ok(
    '三个 drop kind 都有明确判据（v1 的 `unreliable` 从未被定义）',
    DROP_KINDS.every((k) => prompt.includes(`kind: "${k}"`)),
    `缺判据的 kind：${DROP_KINDS.filter((k) => !prompt.includes(`kind: "${k}"`)).join(' / ')}`,
  );
  ok(
    '删稿类判据自带「最保守」的止损语（删错不可逆）',
    prompt.includes('最保守') && prompt.includes('留着') && prompt.includes('读者永远看不到'),
  );

  // ------------------------------------------------------------
  // v3：2026-09-29 晚报的四个缺陷，逐条钉在提示词上
  // ------------------------------------------------------------
  //
  // 这一节全部是**反例断言**：它们测的不是「提示词说了什么」，而是
  // 「提示词里**不再有**那个害人的东西」。事故经过见 `EDITOR_PROMPT_VERSION` 的 v3 说明。

  // ★★ 最值钱的一条：`"order": [{ORDER_EXAMPLE}]` 渲染出双层数组，
  //    模型照抄 ⇒ 五国排序全部作废（报了「给了 0 个序号」，看起来像模型没给）。
  ok(
    '❗ JSON 契约里的 order 示例**没有**被套成双层数组（09-29 排序全废的根因）',
    !prompt.includes('[['),
    `提示词里出现了 "[[" —— 检查模板是不是又写成了 "[{ORDER_EXAMPLE}]"。\n` +
      `    实际渲染：${prompt.slice(prompt.indexOf('"order"'), prompt.indexOf('"order"') + 60)}`,
  );
  ok(
    'order 示例渲染成完整恒等排列且**只有一层**',
    prompt.includes('"order": [0, 1, 2, 3, 4, 5, 6, 7],'),
    prompt.slice(prompt.indexOf('"order"'), prompt.indexOf('"order"') + 50),
  );
  ok(
    '「不想改顺序」那句说的是同一个形状（不是 [[…]]）',
    prompt.includes('就原样输出 [0, 1, 2, 3, 4, 5, 6, 7]。'),
  );

  // ★★ 第二值钱的一条：示例里那句**可以直接当答案照抄**的理由。
  //    09-29 五国交上来的 reason **逐字就是它**，配在 5 条互不相干的稿子上，
  //    把 5 条真稿子静默删掉了（KIOGE 石油展、乌美 70 亿美元项目、黄金特许权费率、
  //    TPAO 增产、费尔干纳论坛 —— 每一条都是投资者会看的东西）。
  for (const poison of [
    '阿塞拜疆政府与 AIIB',
    '下调1.5倍',
    '下降方向不能用倍',
    '与第 2 条同为',
  ]) {
    ok(
      `示例里不再有可直接照抄的成句内容：「${poison}」`,
      !EDITOR_PROMPT.includes(poison),
      '示例里的中文必须是**占位符** —— 模型会把示例当内容模板抄，09-29 就是这么丢的稿子',
    );
  }
  ok('明说了「示例里的中文全是占位符」', prompt.includes('一个字符都不许照抄'));
  // 占位符清单与提示词**双向**对齐（只测一个方向的话，改了提示词忘了改常量，
  // `PLACEHOLDER_TOKENS` 那道闸就静默失效 —— 那是本项目反复踩过的坑）
  ok(
    `每个占位符都在提示词里出现（${PLACEHOLDER_TOKENS.length} 个）`,
    PLACEHOLDER_TOKENS.every((t) => EDITOR_PROMPT.includes(t)),
    `不在提示词里的：${PLACEHOLDER_TOKENS.filter((t) => !EDITOR_PROMPT.includes(t)).join(' / ')}`,
  );

  // ★ 缺陷①：不是新闻的图书推广稿（UzDaily「外交部…赢得世界以实现国家繁荣」，
  //   封面就是一本宣传册）当成政治新闻发出去了 —— 当时 `not_news` 只列了
  //   「广告、招商软文、情绪表态」，这几类一个都不沾。
  ok(
    'not_news 判据列全了（图书/报告的推广、署名评论、致辞表态、人物简介、广告软文）',
    ['推广或预告', '署名评论', '致辞', '人物简介', '软文'].every((k) => prompt.includes(k)),
  );
  ok(
    '给了 not_news 的可操作判据（「谁、在什么时候、发生了什么」）',
    prompt.includes('谁、在什么时候、发生了什么'),
  );
  ok(
    '明说「category 不是它是新闻的证据」（那几类推广稿都挂在政治/经济下面）',
    prompt.includes('不能**当作「它是新闻」的证据') || prompt.includes('不是「它是新闻」的证据'),
  );

  // ★ 缺陷④：吉尔吉斯斯坦的稿子写成「哈萨克斯坦建设部长视察奥什机场」。
  //   第六件事是 v3 新增的，而且它**必须**知道这一篇属于哪一国 —— 那是判据的前置条件。
  ok('第六件事存在：国家归属与专名核查', prompt.includes('国家归属与专名核查'));
  ok(
    '❗ 提示词里**明写了这一篇属于哪一国**（不然国家归属矛盾判不出来）',
    prompt.includes('你审的这一篇属于「阿塞拜疆」'),
    '`{COUNTRY}` 没被替换 —— 缺少这个，第六件事等于没有判据',
  );
  ok('给了国家归属矛盾的具体形态（本国事件写成别国主体）', prompt.includes('国家归属矛盾'));
  ok('把「凭空添了国名」点明为翻译缺陷', prompt.includes('凭空添了国名'));

  // ★ 缺陷③：封面。日报封面取第一位的图，所以「第一位没图」就是「封面是空图」。
  ok('提示词里写明了封面规则（第一条没图就让有图的靠前）', prompt.includes('封面规则'));
  ok('明说了封面取的是第一位那条的配图', prompt.includes('排在第一位的'));
}

// ============================================================
// 五之二、v4：原文必须**真的**进提示词（第七件事的全部判据挂在这上面）
// ============================================================
//
// 2026-10-01 用户贴了 8 张截图，逐条报错。把那 7 条缺陷按「为什么 v3 没抓到」分一下类，
// 会得到一张很难看的表 —— **其中 5 条根本不是「中文不自洽」**：
//
//   ② 凭空年份（原文没写 2023）      ③ 量级/序数错（100 миң 写成 100 万；第三阶段写成第二阶段）
//   ④ 量词错（1200 орундуу 写成 1200 座学校）  ⑤ 张冠李戴的国名+州名（吉尔吉斯斯坦稿写成东哈州）
//   ⑥ 州名/地名不按约定俗成译（Чүй→楚州、Манас→曼纳斯）
//
// 这些错误的共同形态是：**中文读起来完全自洽**。你从中文里怎么查都查不出来 ——
// 因为判据不在中文里，在原文里。而总审从上线起就**从来没看过原文**：
// `original_content` / `original_language` / `original_title` 从 2026-09 就写进库了，
// 但**没有任何一行代码读过它们**（这一类缺口最难发现：不报错、不告警，
// 只表现为「判据上线了但没有效果」）。
//
// 所以这一节测的不是「提示词里说了第七件事」，而是**那根线接上了没有**：
//   字段 → ReviewItem → renderItems → 提示词。

section('五之二、v4 · 原文进提示词（字段→ReviewItem→renderItems）');

{
  const withOriginals = mkItems(3).map((it, i) => ({
    ...it,
    originalTitle: `Оригинал заголовок ${i}`,
    originalExcerpt: `原文正文第 ${i} 条：Ош шаарында 1200 орундуу жаңы мектеп курулду`,
    originalLang: 'ky',
  }));
  const p = buildEditorPrompt({ countryName: '吉尔吉斯斯坦', items: withOriginals });
  ok(
    '❗ 原文**标题**进了提示词',
    p.includes('Оригинал заголовок 0'),
    '原文没进提示词 ⇒ 第七件事在提示词里再漂亮也只是文字',
  );
  ok(
    '❗ 原文**正文**进了提示词',
    p.includes('原文正文第 0 条'),
    '只喂标题不够：国名、量级、序数都写在正文里（实测 Economist.kg 的「贾拉拉巴德州」在**最后一段**）',
  );
  ok('标出了原文语种（模型据此判断该用西里尔还是拉丁写专名）', p.includes('[ky]'));
  ok(
    '每条都有一行「原文：」（读者/事后审计能按序号对上）',
    (p.match(/原文：/g) || []).length >= 3,
    `只找到 ${(p.match(/原文：/g) || []).length} 处`,
  );

  // 原文缺失时必须**明说缺失**。静默留空最危险：模型会把「我们没喂」读成「原文里没有」，
  // 于是把一条真实稿子判成「凭空添加」⇒ 误删。缺材料只能报，不能当证据。
  const p2 = buildEditorPrompt({ countryName: '吉尔吉斯斯坦', items: mkItems(3) });
  ok(
    '❗ 原文缺失时**明写**「无法核对」',
    p2.includes('（原文缺失，无法核对'),
    '静默留空 ⇒ 模型会把「没喂原文」当成「原文里没有」，然后开始判凭空添加',
  );
  ok('并且明确禁止据此判「凭空添加」', p2.includes('不许据此判'));

  // 截断标记是**判据的一部分**，不是排版。第七件事的分支判据是
  // 「原文里看不到 ⇒ 先看是不是被截断了」；省略号一没，这条分支就失效。
  const long = mkItems(1).map((it) => ({
    ...it,
    originalExcerpt: 'О'.repeat(ORIGINAL_EXCERPT_MAX + 50),
  }));
  const p3 = buildEditorPrompt({ countryName: '哈萨克斯坦', items: long });
  ok(
    `超长原文被截断到 ${ORIGINAL_EXCERPT_MAX} 字（不是整篇灌进去把提示词撑爆）`,
    !p3.includes('О'.repeat(ORIGINAL_EXCERPT_MAX + 1)),
  );
  ok(
    '❗ 截断处**留了省略号**（没它模型会把「被截断」误判成「原文里没有」）',
    p3.includes('（已截断）'),
    '截断标记丢了 —— 第七件事的分支判据就没了依据',
  );

  // 第七件事的判据文字本身。这些都是**反例断言**：它们钉的是「不许模型干什么」。
  // ⚠️ `prompt` 在上一节的作用域里，这里得自建一个（用带原文的那批，更接近线上）。
  const prompt = buildEditorPrompt({ countryName: '吉尔吉斯斯坦', items: withOriginals });
  ok(
    '原文核对是**独立的一件事**（不是挂在第五件事下面的附带）',
    prompt.includes('与原文核对'),
  );
  ok(
    '逐项对照的**四类硬信息**都点了名（地名/机构人名/数字/年月）',
    ['国名 / 州名 / 城市名', '机构名 / 人名', '数字', '年份 / 日期'].every((k) =>
      prompt.includes(k),
    ),
    '缺哪一类，那一类就会继续漏',
  );
  ok(
    '❗ 明确了**量级**与**序数**都要单独对一遍（不是「数字对得上」就够）',
    prompt.includes('量级') && prompt.includes('序数'),
    '②③两条缺陷都是这一条没写：「100 миң → 100 万」是量级错，「үчүнчү фаза → 第二阶段」是序数错',
  );
  ok(
    '❗ 把「译文里凭空出现一个年份」点名为**致命**（读者会以为在拿三年前的旧数据当新闻）',
    prompt.includes('凭空') && prompt.includes('三年前'),
    'Spot.uz 那条巴西劳务移民的稿子，原文只有「по итогам года」，译文里出现了「2023 年」',
  );
  ok(
    '判定的**两个分支**都在：原文有而中文错 ⇒ 改；原文本来就查不到 ⇒ 只报',
    prompt.includes('thinSource') && prompt.includes('禁止你补'),
    '少任何一个分支，模型都会往「编一个出来」的方向走 —— 那比缺要素严重得多',
  );
  ok(
    '❗ 明令**不许为了「要素齐全」补原文没有的来源/数字/日期**',
    prompt.includes('绝对不许为了'),
    '这是薄弱材料稿唯一安全的处置：报出来，别编',
  );
  ok(
    '把「原文是摘录、可能被截断」写进了判据（防止把截断误判成凭空）',
    prompt.includes('被截断'),
  );
  ok(
    '给了「拿不准就不要报」的止损语（漏报只少改一处，误报可能删掉真新闻）',
    prompt.includes('拿不准就不要报'),
  );
}

// ============================================================
// 六、跨国重复：只观测、不改
// ============================================================

section('六、crossCountryOverlaps（跨国重复只报不改）');

{
  // 真实锚点：这两条在 2026-09-29 的线上数据里确实分别出现在阿塞拜疆的两条稿件上
  const az = mkItems(2, [
    '阿塞拜疆与亚洲基础设施投资银行就基础设施项目合作进行讨论',
    '哈萨克斯坦总统下令国防部开展全面检查',
  ]);
  const others = [
    {
      country: '乌兹别克斯坦',
      items: mkItems(1, ['阿塞拜疆与亚洲基础设施投资银行讨论扩大在绿色经济转型方面的合作']),
    },
  ];
  const ov = crossCountryOverlaps(az, others);
  ok('能认出跨国同一场会谈（真实语料锚点）', ov.length === 1, JSON.stringify(ov));
  ok('带上「和哪个国家撞了」', ov[0]?.withCountry === '乌兹别克斯坦');
  // ⚠️ 阈值是量出来的：这对真实标题实测 0.4595。
  // 第一版把阈值定在 0.5，结果这一对**直接被漏掉**（这条断言就是当时的红灯）。
  ok('带上相似度（人要能自己判断是否真是同一条）', typeof ov[0]?.sim === 'number' && ov[0].sim > 0.4, String(ov[0]?.sim));
  ok('不相干的标题不会被牵进来', !ov.some((o) => o.title.includes('国防部')));

  const none = crossCountryOverlaps(az, [{ country: 'X', items: mkItems(1, ['塔吉克斯坦桑搏世锦赛开幕']) }]);
  ok('没有相近标题时返回空数组', none.length === 0);
}

// ============================================================
// 七、端到端：失败必须**无损**（不许因为模型不行就少稿子）
// ============================================================

section('七、reviewDraft 端到端（失败无损 / 成功生效）');

async function endToEnd(): Promise<void> {
  const items = mkItems(8);
  const originalTitles = items.map((i) => i.title);

  // (1) 模型调用失败 → 一条都不改
  {
    const r = await reviewDraft({
      countryName: '哈萨克斯坦',
      items,
      ask: async () => ({ ok: false as const, error: 'zhipu：HTTP 429 code 1305' }),
    });
    ok('模型调用失败 ⇒ 一条都不删', r.decision.finalIndices.length === 8 && r.decision.drops.length === 0);
    ok('模型调用失败 ⇒ 一处都不改', r.decision.fixes.length === 0);
    ok('模型调用失败 ⇒ ok=false 且 error 留痕（否则和「本来就没问题」分不开）', r.audit.ok === false && (r.audit.error ?? '').includes('429'));

    // (2) 返回不是 JSON → 一条都不改
    const r2 = await reviewDraft({ countryName: '哈萨克斯坦', items, ask: async () => ({ ok: true as const, text: '我审完了，没问题。' }) });
    ok('返回不是 JSON ⇒ 一条都不改', r2.decision.finalIndices.length === 8 && r2.decision.fixes.length === 0);
    ok('返回不是 JSON ⇒ 留痕', r2.audit.ok === false && (r2.audit.error ?? '').includes('JSON'));

    // (3) 正常返回 → 生效，并带出「谁答的」
    const r3 = await reviewDraft({
      countryName: '哈萨克斯坦',
      items,
      ask: async () => ({
        ok: true as const,
        provider: 'fake-model',
        text: JSON.stringify({
          order: [1, 0, 2, 3, 4, 5, 6, 7],
          drops: [{ index: 1, kind: 'duplicate', sameAs: 0, reason: dupReason(0, '阿塞拜疆与亚洲基础设施投资银行') }],
          fixes: [],
          needsImage: [0],
          verdict: '有一条重复',
        }),
      }),
    });
    ok('正常返回 ⇒ 生效', r3.decision.drops.length === 1 && r3.audit.ok === true);
    ok('带出回答通道名（排查「换了通道」还是「模型不稳」）', r3.audit.provider === 'fake-model');
    ok('原始数组没有被就地改动（改由调用方按 finalIndices 重建）', items.map((i) => i.title).join('|') === originalTitles.join('|'));

    // (4) 稿件少于 2 条 → 不跑模型（省一次调用），也不算失败
    const r4 = await reviewDraft({ countryName: 'X', items: mkItems(1), ask: async () => { throw new Error('不该被调用'); } });
    ok('稿件少于 2 条时**不调模型**（ran=false）', r4.audit.ran === false && r4.audit.ok === true);
    ok('稿件少于 2 条时保持原样', r4.decision.finalIndices.length === 1);

    // (5) v4：原文与「材料薄」的报告必须能一路走出 reviewDraft。
    //     只在 applyVerdict 里活着不算 —— 那正是「字段在库里、没人读」的同一种失误
    //     （判据写了，但链路上某一环没接）。
    const r5 = await reviewDraft({
      countryName: '吉尔吉斯斯坦',
      items: mkItems(8).map((it, i) =>
        i === 2 ? { ...it, originalExcerpt: 'Ош шаарында 1200 орундуу жаңы мектеп' } : it,
      ),
      ask: async () => ({
        ok: true as const,
        text: JSON.stringify({
          order: [0, 1, 2, 3, 4, 5, 6, 7],
          drops: [],
          fixes: [],
          needsImage: [],
          thinSource: [2],
          verdict: '有一条材料偏薄',
        }),
      }),
    });
    ok(
      '❗ thinSource 走出了 reviewDraft（不是只在 applyVerdict 里活着）',
      JSON.stringify(r5.decision.thinSource) === JSON.stringify([2]),
      JSON.stringify(r5.decision.thinSource),
    );
    ok(
      '审计带出「有几条真的带上了原文」= 1',
      r5.audit.originalsSeen === 1,
      `originalsSeen=${r5.audit.originalsSeen}`,
    );
    ok('原文缺失的条目不会被当成失败（thinsource/原文都是**只报**）', r5.audit.ok === true && r5.decision.finalIndices.length === 8);
  }
}

// ============================================================
// 八、版本指纹：GET /api/wechat/push 的 codeVersion
// ============================================================
//
// 2026-09-29 加这一节的原因值得写下来：那天排查「改动到底上线没有」走了一大圈
// （先怀疑召回、再怀疑代码、最后才发现是部署没上线），唯一的依据是
// 「`summary` 里有没有 `merges`」这种**字段存在性**——它只在「这次改动恰好加了字段」
// 时成立。于是把「行为开关本身」暴露进 GET，并用断言钉住它不许被删。
//
// 断言用**源码级**（route 文件不好做单测），重点钉两件事：
//   ① 这几个值必须**从代码现算**，不能手写常量 —— 手写的迟早和代码分叉，
//      然后反过来误导排查（这正是它比 `BUILD_ID` 强的地方）；
//   ② 「终审默认开关」必须在里面 —— 它是区分 `fe0f84a` 与 `312644b` 的那一位。

section('八、版本指纹（GET 的 codeVersion）');

{
  const src = readFileSync(resolve(process.cwd(), 'src/app/api/wechat/push/route.ts'), 'utf8');
  ok('GET 暴露了 codeVersion', /codeVersion\s*:/.test(src), '没找到 codeVersion —— 版本指纹又被删了？');
  ok(
    '含「终审默认开关」（区分 fe0f84a 与 312644b 的那一位）',
    /editorReviewDefault:\s*isEditorReviewEnabled\(\)/.test(src),
  );
  ok('含「判组默认开关」（区分 640a76f 与 fe0f84a）', /dedupeLlmDefault:\s*isLlmJudgeEnabled\(\)/.test(src));
  ok(
    '提示词版本**从代码取**，不是手写字符串',
    /editorPromptVersion:\s*EDITOR_PROMPT_VERSION/.test(src),
    '写成了字面量 —— 那样提示词一改它就撒谎',
  );
  ok(
    '护栏上限**从代码取**（调参后能确认线上拿到的是新值）',
    /maxDrops:\s*MAX_DROPS/.test(src) && /maxFixes:\s*MAX_FIXES/.test(src),
  );
  ok(
    '仍保留 lastRun（「进程年龄」指纹的载体：内存态，容器一重启就清零）',
    /lastRun:\s*pushRunState/.test(src),
    'lastRun 没了 —— 就少了一条不依赖「这次改动恰好加了字段」的版本证据',
  );
  ok(
    '含「借图配对下限」（它**存在**就说明这一版带上了借图）',
    /coverBorrowMinSim:\s*PAIR_CANDIDATE_MIN_SIM/.test(src),
  );
  // 借图的两条接线上限：捐赠者只许来自「被判重复」的稿子，且只能插进正文开头。
  // 这两条都是**安全边界**（拿错图的后果比没图严重），所以用源码断言钉住。
  ok(
    "借图的捐赠者只从 `kind === 'duplicate'` 的稿子里取（not_news / unreliable 的图不能要）",
    /d\.kind === 'duplicate'/.test(src),
    '捐赠者的来源放宽了 —— 那会把「不是同一件事」的稿子的图挪过来，属于事实错误',
  );
  ok(
    '借图靠把 `<img>` 插进正文开头（`cover_image` 字段不入库，这是唯一的存图办法）',
    /target\.content = `<img src="\$\{b\.imageUrl\}"/.test(src),
  );
  ok(
    '借图用**重排之后**的数组来配对（否则 targetIndex 对不上，会把图插到别的稿子上）',
    /survivors:\s*pc\.articles\.map\(/.test(src),
  );

  // ---- v3（2026-09-29 晚报）新增的接线 ----
  //
  // 这几条同样用源码断言：route 文件没法单测，而它们都是**改了就必须同时改两边**的东西
  // （常量→指纹、判据→探针、映射→候选）。
  ok(
    'v3 两道闸的系数进了版本指纹（从常量现算，调参后能确认线上拿到的是新值）',
    /dupSimFloor:\s*DUP_SIM_FLOOR/.test(src) && /quoteMin:\s*QUOTE_MIN/.test(src),
    '系数没进指纹 —— 改了阈值就没法确认线上生效的是哪一版',
  );
  ok(
    '❗ order 示例的**活体探针**在（09-29 排序全废就是因为没人看得见示例长什么样）',
    /editorOrderExampleProbe/.test(src),
    '探针没了 —— 模板再被写成 [[…]] 就又只能靠猜',
  );
  ok(
    '❗ 抄示例护栏的**活体探针**在（正确值是「删了 0 条｜…最长引文 N 字 < 6…」）',
    /editorDropGuardProbe/.test(src),
    '探针没了 —— 护栏失效就完全不可见了',
  );
  ok(
    '封面改为「第一条有图的」（不再是只看 wechatArticles[0]）',
    /pickDraftCover\(/.test(src),
    '还只看第一条 —— 第一条没图时会退成品牌图，那是用户 09-29 贴出来的那张截图',
  );
  ok(
    '封面来源写进 drafts 审计（否则「封面怎么是这张」没法回答）',
    /cover_from_index:\s*draftCover \? draftCover\.index : null/.test(src),
  );
  ok(
    'drops 审计带出 sameAs + 对应标题（事后能核对「它说和谁重复」）',
    /sameAsTitle:/.test(src),
    '事故当晚五国的 reason 全是抄来的空话，而审计里没有任何字段能回答「它指谁」',
  );

  // ---- v4（2026-10-01 晚报）新增的接线 ----
  //
  // 这一轮新增的三条**全是「跑一遍真代码、返回一个字符串」的活体探针**，
  // 不是手写的常量：那一轮排查「部署到底上线没有」绕了一大圈，教训就是
  // 手写的 `true` 只能证明「有人写过这一行」，不能证明「线上跑的是这版逻辑」。
  ok(
    '❗ 「原文进没进提示词」的活体探针在（v4 的核心改动，必须是跑出来的）',
    /editorOriginalProbe/.test(src) &&
      /editorOriginalProbe[\s\S]{0,400}buildEditorPrompt\(/.test(src),
    '探针没了 —— 「原文喂进总审了没有」就只能靠读代码猜',
  );
  ok(
    '❗ 证据分型的**两条**探针都在（一条证明 duplicate 放行，一条证明 not_news 仍要引文）',
    /editorDupEvidenceProbe/.test(src) &&
      /editorNotNewsQuoteProbe/.test(src) &&
      /editorDupEvidenceProbe[\s\S]{0,500}applyVerdict\(/.test(src) &&
      /editorNotNewsQuoteProbe[\s\S]{0,500}applyVerdict\(/.test(src),
    '只留一条的话，「duplicate 不再要引文」和「闸被整个拆了」分不开 —— 必须成对看',
  );
  ok(
    '❗ 原文覆盖率能从线上查（?db=1 时才真去查库）',
    /originalCoverage/.test(src) && /getArticlesByDateRange\(/.test(src),
    '没有这个口子，「原文喂进去了但库里本来就没原文」完全不可见（originalsSeen 会一直是 0）',
  );
  ok(
    '原文覆盖率默认必须是「未查询」这种字符串（探活不能被数据库拖慢，也不能写死 true）',
    /未查询/.test(src),
    '默认就查库会让探活变慢；默认写死一个值则等于撒谎',
  );
}

// ============================================================
// 九、借图（planCoverBorrows）—— 2026-09-29「只挪真图」
// ============================================================
//
// 用户的选项原话是「只挪真图」（另一个选项「去图库搜一张」被否了）。
// 「真」的含义就是**它必须是这条新闻的照片**，所以这个函数只有一条铁律：
// **只在有「同一件事」既成判断的地方挪，宁可挪不到，也不挪错。**
//
// 本节的标题**全部是线上真实标题**（2026-09-29 从 3 天 1152 篇里筛出来的），
// 相似度也是实测值 —— 因为本项目已经栽过一次「阈值拍脑袋、恰好漏掉唯一真实锚点」
// （见 `crossCountryOverlaps` 的注释）。锚点必须是量出来的。

section('九、借图（planCoverBorrows）');

{
  // ---- 真·同一件事的正例（有图那侧当捐赠者）----
  const POS = [
    {
      sim: 0.5833,
      donor: '巴库举行第二届阿塞拜疆国际投资论坛，签署总额 10.8 亿美元协议',
      survivor: '第二届阿塞拜疆国际投资论坛签署 23 份投资协议，总金额 108 亿美元',
    },
    {
      sim: 0.5313,
      donor: '希姆肯特四名博主因 TikTok 直播被处以行政拘留',
      survivor: '希姆肯特四名博主因 TikTok 直播中辱骂被拘留达 17 天',
    },
    {
      // 边界正例：0.375 只比下限高一点点 —— 它必须能被借到，
      // 否则等于把阈值悄悄抬到了 0.4（就是那个「拍阈值」的老毛病）
      sim: 0.375,
      donor: '第二届阿塞拜疆国际投资论坛期间签署文件',
      survivor: '世界媒体聚焦阿塞拜疆国际投资论坛',
    },
  ];

  for (const p of POS) {
    // 前置条件先自证：锚点的相似度确实和注释里写的一致（防止标题被改后断言变成空转）
    const actual = similarity(p.donor, p.survivor);
    ok(
      `锚点相似度自证 = ${p.sim}（真实标题，非编造）`,
      Math.abs(actual - p.sim) < 0.002,
      `实测 ${actual.toFixed(4)}，注释/断言写的是 ${p.sim} —— 标题被改过？`,
    );
    const plan = planCoverBorrows({
      survivors: [{ title: p.survivor, hasImage: false }],
      donors: [{ title: p.donor, imageUrl: 'https://cdn.example.az/photo.jpg' }],
    });
    ok(`同一件事 ⇒ 借图（sim ${p.sim}）`, plan.length === 1 && plan[0].targetIndex === 0, JSON.stringify(plan));
    ok(`借图带出相似度（事后能回答「凭什么认为是一件事」）`, plan[0]?.sim === actual);
    ok(`借图带出「从哪条借的」`, plan[0]?.fromTitle === p.donor);
  }

  // ---- 负例：相似度**低于下限**，必须一条都不借 ----
  // ① 「同类事件、不同地点」——最危险的一类：挪了图就是**另一场事故的照片**
  const n1a = '希杰兹恩发生交通事故';
  const n1b = '巴尔达地区发生交通事故，造成人员死亡';
  ok('负例①相似度确实低于下限（前置条件）', similarity(n1a, n1b) < PAIR_CANDIDATE_MIN_SIM, String(similarity(n1a, n1b)));
  ok(
    '❗同类事件、不同地点 ⇒ **不借**（挪了就是另一场事故的照片）',
    planCoverBorrows({
      survivors: [{ title: n1b, hasImage: false }],
      donors: [{ title: n1a, imageUrl: 'https://cdn.example.az/x.jpg' }],
    }).length === 0,
  );
  // ② 同一场论坛的两条不同侧记（0.3103）—— 看着像，但没到「同一件事」的判据
  const n2a = '阿塞拜疆外长在纽约举行 37 场双边会议';
  const n2b = '阿塞拜疆外长在纽约与联合国秘书长会晤';
  ok('负例②相似度确实低于下限（前置条件）', similarity(n2a, n2b) < PAIR_CANDIDATE_MIN_SIM, String(similarity(n2a, n2b)));
  ok(
    '相似但未到下限 ⇒ **不借**',
    planCoverBorrows({
      survivors: [{ title: n2b, hasImage: false }],
      donors: [{ title: n2a, imageUrl: 'https://cdn.example.az/y.jpg' }],
    }).length === 0,
  );

  // ---- 三条「不许发生」的护栏 ----
  const d1 = '巴库举行第二届阿塞拜疆国际投资论坛，签署总额 10.8 亿美元协议';
  const s1 = '第二届阿塞拜疆国际投资论坛签署 23 份投资协议，总金额 108 亿美元';

  ok(
    '幸存稿**已经有图** ⇒ 不借（绝不覆盖原有封面）',
    planCoverBorrows({
      survivors: [{ title: s1, hasImage: true }],
      donors: [{ title: d1, imageUrl: 'u' }],
    }).length === 0,
  );
  ok(
    '捐赠者**没标题** ⇒ 不借（没法证明是一件事）',
    planCoverBorrows({ survivors: [{ title: s1, hasImage: false }], donors: [{ title: '', imageUrl: 'u' }] }).length === 0,
  );
  ok(
    '捐赠者**没图 URL** ⇒ 不借（空图会插一个破 `<img>` 进正文）',
    planCoverBorrows({ survivors: [{ title: s1, hasImage: false }], donors: [{ title: d1, imageUrl: '' }] }).length === 0,
  );
  ok('没有捐赠者 ⇒ 返回空数组', planCoverBorrows({ survivors: [{ title: s1, hasImage: false }], donors: [] }).length === 0);

  // 两条捐赠者争同一条幸存稿 ⇒ 只借一次（否则会把两张图叠进同一篇正文）
  const s2 = '希姆肯特四名博主因 TikTok 直播中辱骂被拘留达 17 天';
  const two = planCoverBorrows({
    survivors: [
      { title: s2, hasImage: false },
      { title: '完全不相干的一条稿子标题在这里', hasImage: false },
    ],
    donors: [
      { title: '希姆肯特四名博主因 TikTok 直播被处以行政拘留', imageUrl: 'a' },
      { title: '希姆肯特四名博主因TikTok直播被处以行政拘留', imageUrl: 'b' },
    ],
  });
  ok(
    '两条捐赠者争同一条幸存稿 ⇒ 只借一次（不叠两张图）',
    two.filter((b) => b.targetIndex === 0).length === 1,
    JSON.stringify(two),
  );
  ok('另一条找不到匹配对象时不会被硬塞', two.every((b) => b.targetIndex === 0));

  // 阈值必须是**复用的既有常量**，不是新拍的数
  ok(
    '默认下限 === PAIR_CANDIDATE_MIN_SIM（复用回测过的常量，不是新拍一个数）',
    planCoverBorrows({
      survivors: [{ title: s1, hasImage: false }],
      donors: [{ title: d1, imageUrl: 'u' }],
      // 不传 minSim，走默认
    }).length === 1 && PAIR_CANDIDATE_MIN_SIM === 0.35,
  );
  ok(
    '显式调高下限能挡住（参数真的生效）',
    planCoverBorrows({
      survivors: [{ title: s1, hasImage: false }],
      donors: [{ title: d1, imageUrl: 'u' }],
      minSim: 0.9,
    }).length === 0,
  );
}

// ============================================================
// 十、v3 护栏：2026-09-29 晚报那 5 次误删必须被挡住
// ============================================================
//
// 这一节的**标题和理由全部是线上原样**（取自那一轮 `summary.review[].drops`）。
// 背景：五国各删了一条**真实、且与投资者直接相关**的稿子，而**五条理由里四条是同一句**
// 抄自提示词示例的空话（`与第 2 条同为 9 月 27 日阿塞拜疆政府与 AIIB 的那场会谈`），
// 配在 KIOGE 石油展、乌美 70 亿美元项目、黄金特许权费率、TPAO 增产这四件互不相干的事上。
// 第五国（tj）把「美国协助塔吉克斯坦…战略」抄了上去 —— 那句**确实是**同一批里的一条标题，
// 所以它骗过了引文闸，只能靠相似度闸（两条其实毫不相干，实测 0.1020）。
//
// ⚠️ 这一节的价值不在「护栏工作」（那是上面几节的事），而在**方向**：
// 它同时证明「抄示例 → 删不掉」和「真重复 → 照样删得掉」。只测前者会得到一道
// 「一律不删」的废闸 —— 那种闸看起来最安全，实际上等于把总审关掉。
//
// v4 补记：这道「一律不删」的废闸**真的发生过**。v3 的引文闸在 2026-10-01 把阿塞拜疆
// 一次**正确**的重复删除拦掉了（见第十之二节）。所以这一节现在对每条理由走**三条路径**。

section('十、v3/v4 · 「抄示例理由」那 5 次误删必须被挡住（线上实测数据）');

{
  const ECHO = '与第 2 条同为 9 月 27 日阿塞拜疆政府与 AIIB 的那场会谈';
  // 四国用的是同一句（线上原样）。第五列是该国当时的另一条真实标题，充当「批内其它稿」。
  const SAME_REASON = [
    {
      c: 'kz',
      dropped:
        '第 30 届国际石油和天然气展览会 KIOGE 2026 将于 9 月 30 日至 10 月 2 日在阿拉木图举行，共吸引 62 个国家的 500 多家公司参与，旨在讨论哈萨克斯坦能源行业未来、国际合作及新兴技术。',
      other: '阿拉木图市政府要求定期清洗 1 万个垃圾桶',
    },
    { c: 'uz', dropped: '乌兹别克斯坦与美国落实 70 亿美元项目', other: '2027 年起银行将分配养老金' },
    { c: 'kg', dropped: '议员建议将黄金特许权使用费率提高至 8%', other: '比什凯克 Kampa Industrial Park 工业园正式投入运营' },
    { c: 'az', dropped: '土耳其 TPAO 计划将每日石油产量提升至 100 万桶', other: 'AB 将重组 Davr Bank 领导层' },
  ];

  for (const t of SAME_REASON) {
    // 6 条：删 1 条既在上限内（cap = min(4, floor(6/3)=2) = 2）、也在保留下限之上，所以
    // 一旦护栏失效，`appliedDrops` 会变成 1 —— 断言会红，不会静默放过。
    const items = mkItems(6, [t.dropped, t.other, `${t.c} 的第三条稿件`, `${t.c} 的第四条稿件`, `${t.c} 的第五条稿件`, `${t.c} 的第六条稿件`]);
    //
    // ⚠️ v4 起「抄示例的理由」会被**三条不同的闸**拦，取决于它冒充哪种 kind。
    //    旧版本只测第一条路径（引文闸），而那恰好是 v4 拆掉的那条：
    //    v4 把闸按 kind 分了型（duplicate 看 sameAs、not_news/unreliable 看引文），
    //    于是「同一条空话理由」走 duplicate 时**不再经过引文闸**。
    //    如果这里还只断言「留痕里有『原文片段』」，它会红 —— 而它红得**没有意义**：
    //    真正该守住的是「同一条空话，无论冒充哪种 kind，都删不掉」。
    //    所以三条路径都要走一遍。少测一条，就少一道「这道闸被拆了」的监测。
    const sim = similarity(items[0].title, items[1].title);
    ok(
      `[${t.c}] 前置条件：这一对毫不相干（sim=${sim.toFixed(4)} < ${DUP_SIM_FLOOR}）`,
      sim < DUP_SIM_FLOOR,
      '夹具变了 ⇒ 下面第三条路径测的就不是「相似度闸」了',
    );

    // 路径①：冒充 duplicate、**指不出与谁重复** ⇒ sameAs 闸
    {
      const r = applyVerdict(items, { drops: [{ index: 0, kind: 'duplicate', reason: ECHO }] });
      ok(`[${t.c}] 抄示例 + 指不出与谁重复 ⇒ 一条都不删`, r.audit.appliedDrops === 0, JSON.stringify(r.audit));
      ok(
        `[${t.c}] 留痕说清了是「缺 sameAs」`,
        r.audit.rejections.some((x) => x.includes('sameAs')),
        JSON.stringify(r.audit.rejections),
      );
    }

    // 路径②：冒充 duplicate、**乱指一个序号** ⇒ 相似度闸兜底
    {
      const r = applyVerdict(items, {
        drops: [{ index: 0, kind: 'duplicate', sameAs: 1, reason: ECHO }],
      });
      ok(`[${t.c}] 抄示例 + 乱指序号 ⇒ 一条都不删（相似度闸兜底）`, r.audit.appliedDrops === 0, JSON.stringify(r.audit));
      ok(
        `[${t.c}] 留痕说清了是相似度不足`,
        r.audit.rejections.some((x) => x.includes('相似度')),
        JSON.stringify(r.audit.rejections),
      );
    }

    // 路径③：冒充 not_news ⇒ 引文闸（这是 v3 唯一测过的那条，v4 保留）
    {
      const r = applyVerdict(items, { drops: [{ index: 0, kind: 'not_news', reason: ECHO }] });
      ok(`[${t.c}] 抄示例 + 冒充 not_news ⇒ 一条都不删`, r.audit.appliedDrops === 0, JSON.stringify(r.audit));
      ok(
        `[${t.c}] 留痕说清了是「没有可核对的原文片段」`,
        r.audit.rejections.some((x) => x.includes('原文片段')),
        JSON.stringify(r.audit.rejections),
      );
    }
  }

  // ---- 第五国（tj）：抄的那句**真的是**批内一条标题，引文闸放行 ⇒ 由相似度闸兜底 ----
  {
    const items = mkItems(6, [
      '塔吉克斯坦总统战略研究中心与地方政府在胡占德举办第二届费尔干纳和平论坛',
      '美国协助塔吉克斯坦制定返乡移民经济融入战略',
      '塔吉克斯坦驻瑞士大使在苏黎世与瑞士州长会晤',
      '杜尚别将主办国际电联区域论坛',
      '塔吉克斯坦计划储备超过 408 千吨饲料用于牲畜越冬',
      '塔吉克斯坦内务部第一副部长与英国国防大臣举行会晤，讨论安全领域合作',
    ]);
    const sim = similarity(items[0].title, items[1].title);
    ok('tj 锚点相似度自证 = 0.1020（线上实测，非编造）', Math.abs(sim - 0.102) < 0.005, `实测 ${sim.toFixed(4)}`);
    ok(`tj 那一对相似度低于下限 ${DUP_SIM_FLOOR}（前置条件）`, sim < DUP_SIM_FLOOR);
    const r = applyVerdict(items, {
      drops: [
        {
          index: 0,
          kind: 'duplicate',
          sameAs: 1,
          reason: '与第 1 条同为美国协助塔吉克斯坦制定返乡移民经济融入战略',
        },
      ],
    });
    ok('❗ 抄了真实标题、但两条毫不相干 ⇒ 仍然删不掉（相似度闸兜底）', r.audit.appliedDrops === 0, JSON.stringify(r.audit));
    ok('留痕写清了是相似度不足', r.audit.rejections.some((x) => x.includes('相似度')), JSON.stringify(r.audit.rejections));
  }

  // ---- 反向：**真重复必须照样删得掉**（否则这道闸等于把总审关掉）----
  //
  // 这一对是 09-29 晚报**真的漏掉**的重复（用户投诉「明显是同样的新闻」的两张截图）：
  // Gazeta.uz「向第 120 万名乘客发放一年免费交通卡」 vs Spot.uz「客流量创纪录，达 120 万人次」。
  // 两条都进了成品。它是本项目**最难的那对真锚点**（措辞差别大，实测 0.2188），
  // 所以它同时是「`DUP_SIM_FLOOR=0.15` 够不够低」的检验。
  {
    const items = mkItems(8, [
      '塔什干地铁向第 120 万名乘客发放一年免费交通卡',
      '塔什干地铁客流量创纪录，达 120 万人次',
      '乌兹别克斯坦央行建议银行严格评估以唯一住房为抵押的贷款',
      '2027年起可在 ЕПИГУ 领取现金养老金',
      '乌兹别克斯坦代表团参加联合国荒漠化防治公约第 XXIX 次缔约方大会',
      '世界银行预测 Transcaspiy Corridor 投资将使货运量增至 3 倍并创造 200 万个就业岗位',
      '乌兹别克斯坦总统签署法令表彰教育领域模范工作者',
      '卡什卡达里亚州卡拉苏举办现场办公会：Sadriddin Turdiev 现场解决土地与房产确权问题',
    ]);
    const sim = similarity(items[0].title, items[1].title);
    ok('uz 真重复锚点相似度自证 = 0.2188（线上实测，非编造）', Math.abs(sim - 0.2188) < 0.005, `实测 ${sim.toFixed(4)}`);
    ok(
      `它过得了下限 ${DUP_SIM_FLOOR}（前置条件：下限不能把唯一的最难真锚点挡掉）`,
      sim >= DUP_SIM_FLOOR,
      `实测 ${sim.toFixed(4)} —— 若低于下限，说明阈值拍高了（本项目栽过一次）`,
    );
    const r = applyVerdict(items, {
      // 顺带给一个合法 order：这一格要断言「整条路径零噪音」，
      // 不传 order 会多出一条「order 缺失」的拒绝（那是合法行为，但会污染这条断言）。
      order: [1, 0, 2, 3, 4, 5, 6, 7],
      drops: [
        {
          index: 0,
          kind: 'duplicate',
          sameAs: 1,
          reason: '与第 1 条同为「塔什干地铁客流量」这条 120 万人次的纪录',
        },
      ],
    });
    ok('❗ 真重复仍然删得掉（护栏没把正确答案一起挡住）', r.audit.appliedDrops === 1, JSON.stringify(r.audit));
    ok('真重复路径上没有任何拒绝噪音', r.audit.rejections.length === 0, JSON.stringify(r.audit.rejections));
    ok('删掉的记录带出 sameAs（事后能回答「它说和谁重复」）', r.decision.drops[0]?.sameAs === 1);
  }

  // ---- 引文闸的边界：≥6 字算引用、5 字不算 ----
  {
    const items = mkItems(6, ['塔什干地铁客流量创纪录，达 120 万人次', '塔什干地铁向第 120 万名乘客发放一年免费交通卡', '甲稿', '乙稿', '丙稿', '丁稿']);
    const r6 = applyVerdict(items, { drops: [{ index: 0, kind: 'not_news', reason: '「塔什干地铁客流量」不是新闻' }] });
    ok(`引文 ≥${QUOTE_MIN} 字 ⇒ 通过引文闸（只剩别的理由可能拒它）`, !r6.audit.rejections.some((x) => x.includes('原文片段')), JSON.stringify(r6.audit.rejections));
    const r5 = applyVerdict(items, { drops: [{ index: 0, kind: 'not_news', reason: '「塔什干地铁」不是新闻' }] });
    ok(`引文只有 5 字 < ${QUOTE_MIN} ⇒ 被引文闸拒`, r5.audit.rejections.some((x) => x.includes('原文片段')), JSON.stringify(r5.audit.rejections));
    ok(`QUOTE_MIN 就是 ${QUOTE_MIN}（断言钉住这个数，改了要一起改）`, QUOTE_MIN === 6);
  }

  // ---- 占位符回抄：`after` 是要发出去的文字，绝不能是一句占位符 ----
  {
    const items = mkItems(6);
    const r = applyVerdict(items, {
      fixes: [{ index: 0, field: 'title', before: items[0].title, after: '（只改正错处）', why: '（错在哪）' }],
    });
    ok('改写值照抄了占位符 ⇒ 拒绝（否则标题会变成一句「（只改正错处）」）', r.audit.appliedFixes === 0, JSON.stringify(r.audit));
    ok('留痕说清了是占位符回抄', r.audit.rejections.some((x) => x.includes('占位符')), JSON.stringify(r.audit.rejections));
  }
}

// ============================================================
// 十之二、v4 · 证据分型：一种判断只要一份「机器能核对」的证据
// ============================================================
//
// 这一节是**用户截图直接催生的**，而且事故形态很丢人：**我们的护栏把我们的正确答案拦掉了**。
//
// 2026-10-01 晚报，阿塞拜疆那批里 APA 与 Qafqazinfo 各发了一条「政府吊销两家非银行
// 信贷机构许可证」。模型**正确**提出删掉后一条，并且给了 `sameAs` ——
// 却被「reason 里必须有 ≥6 字引文」这道闸拒掉。用户截图报的
// 「阿塞拜疆又出现两条重复」，**直接原因就是这道闸**。
// 而它指的那一对标题实测相似度 **0.2105 ≥ DUP_SIM_FLOOR(0.15)**：
// 它的证据**完全够**，我们却额外又要了一份（两道闸叠加 = 双重受罚）。
//
// 原则：**一种判断只需要一份机器能核对的证据，不必凑两份。**
//   · `duplicate` 有 `sameAs` —— 有字段可指认，代码当场量相似度 ⇒ 引文是多余的；
//   · `not_news` / `unreliable` 没有任何字段可指认 ⇒ 引文是唯一证据。
//
// ⚠️ 必须**双向**测，两条一起看才说明是「分型」而不是「拆闸」：
//    · 只测「duplicate 不再要引文」⇒ 谁都能删；
//    · 只测「not_news 仍要引文」⇒ 回到双重受罚（就是这次的事故）。

section('十之二、v4 · 证据分型（duplicate 看 sameAs、其余看引文）');

{
  // 真实锚点：`mkItems` 的第 0/1 条就是 09-29 线上那对 AIIB 会谈（阿塞拜疆两篇日报的稿子），
  // 若夹具被改动，下面的前置断言会红。
  const items8 = mkItems(8);
  const anchor = similarity(items8[0].title, items8[1].title);
  ok(
    `前置条件：锚点相似度 ${anchor.toFixed(4)} ≥ DUP_SIM_FLOOR(${DUP_SIM_FLOOR})（与线上被误杀那对的 0.2105 同档）`,
    anchor >= DUP_SIM_FLOOR,
    '夹具变了 —— 下面「放行」测的就不是正常路径了',
  );

  // ---- (1) 反向：duplicate 只给 sameAs、**不给引文** ⇒ 必须放行（被误杀的就是这一形态）----
  {
    const r = applyVerdict(items8, {
      // 顺带给一个合法 order：这一格要断言「零拒绝痕」，不传 order 会多出一条
      // 「order 缺失」的合法拒绝，把这条断言污染掉。
      order: [1, 0, 2, 3, 4, 5, 6, 7],
      drops: [{ index: 1, kind: 'duplicate', sameAs: 0, reason: '与第 0 条是同一件事的两家报道（此处故意不引用原文）' }],
    });
    ok(
      '❗ duplicate 只给 sameAs、不给引文 ⇒ **放行**（v3 会在这里误杀，那正是用户报的「又出现两条重复」）',
      r.audit.appliedDrops === 1,
      JSON.stringify(r.audit.rejections),
    );
    ok(
      '被采纳的重复删稿**不留拒绝痕**（留痕说明它又被引文闸蹭了一下）',
      r.audit.rejections.length === 0,
      JSON.stringify(r.audit.rejections),
    );
    ok('sameAs 被带进决策（事后能回答「它说和谁重复」）', r.decision.drops[0]?.sameAs === 0);
  }

  // ---- (2) 正向：分型**不是拆闸** —— 没有可指认字段的 kind，引文仍是唯一证据 ----
  {
    const r = applyVerdict(mkItems(8), {
      drops: [{ index: 1, kind: 'not_news', reason: '这一条是推广稿，不是新闻（故意不引用任何原文）' }],
    });
    ok(
      '❗ not_news 没有引文 ⇒ **仍然删不掉**（分型不是拆闸）',
      r.audit.appliedDrops === 0 && r.audit.rejections.some((x) => x.includes('原文片段')),
      JSON.stringify(r.audit.rejections),
    );

    const r2 = applyVerdict(mkItems(8), {
      drops: [{ index: 1, kind: 'not_news', reason: `「${items8[1].title.slice(0, 8)}」这种通稿不是新闻` }],
    });
    ok(
      'not_news 引了中文稿原话（≥6 字）⇒ 放行',
      r2.audit.appliedDrops === 1,
      JSON.stringify(r2.audit.rejections),
    );
  }

  // ---- (3) 没有 sameAs 的 duplicate ⇒ 仍然拒（否则「重复」两个字就能删稿）----
  {
    const r = applyVerdict(mkItems(8), {
      drops: [{ index: 1, kind: 'duplicate', reason: '这条重复了（但指不出跟谁重复）' }],
    });
    ok(
      'duplicate 指不出与谁重复 ⇒ 仍然删不掉',
      r.audit.appliedDrops === 0 && r.audit.rejections.some((x) => x.includes('sameAs')),
      JSON.stringify(r.audit.rejections),
    );
  }

  // ---- (4) ★ v4：引文允许来自**本条原文**（第七件事明说「或该条【原文】里的原话」）----
  //
  // 护栏和提示词必须是**同一条判据**。v3 的 `longestQuotedSpan` 只在中文稿里找引文，
  // 于是「原文写的是 1200 орундуу мектеп（一座 1200 个名额的学校），中文写成了 1200 座学校」
  // 这种**完全合规**的理由会被误杀 —— 它引的正是原文。
  {
    const withOrig = mkItems(8).map((it, i) =>
      i === 1 ? { ...it, originalExcerpt: 'Ош шаарында 1200 орундуу жаңы мектептин курулушу аяктады' } : it,
    );
    const r = applyVerdict(withOrig, {
      drops: [
        {
          index: 1,
          kind: 'unreliable',
          reason: '原文写的是「1200 орундуу мектеп」（一座 1200 个名额的学校），中文写成了 1200 座学校',
        },
      ],
    });
    ok(
      '❗ 引文本条**原文**也算证据（v3 只在中文稿里找引文 ⇒ 会误杀这条完全合规的理由）',
      r.audit.appliedDrops === 1,
      JSON.stringify(r.audit.rejections),
    );
  }

  // ---- (5) 审计：原文覆盖率与「材料薄」的报告 ----
  {
    const mixed = mkItems(3).map((it, i) => (i === 0 ? { ...it, originalExcerpt: 'Ош шаарында жаңы мектеп' } : it));
    const a = applyVerdict(mixed, {});
    ok(
      '审计报出「有几条真的带上了原文」（它若长期为 0，第七件事就是空转）',
      a.audit.originalsSeen === 1,
      `originalsSeen=${a.audit.originalsSeen}`,
    );

    const r = applyVerdict(mkItems(8), { thinSource: [0, 5, 5, 99, 'x'] });
    ok(
      'thinSource 过闸成「合法且去重」的序号',
      JSON.stringify(r.decision.thinSource) === JSON.stringify([0, 5]),
      JSON.stringify(r.decision.thinSource),
    );
    ok('thinSource 是**只报不改**：不影响删留与顺序', r.decision.finalIndices.length === 8 && r.decision.drops.length === 0);
    ok('审计报了 thinSource 的条数（不用去翻数组）', r.audit.thinSources === 2, `thinSources=${r.audit.thinSources}`);

    const r2 = applyVerdict(mkItems(8), {
      drops: [{ index: 1, kind: 'duplicate', sameAs: 0, reason: dupReason(0, '阿塞拜疆与亚洲基础设施投资银行') }],
      thinSource: [1],
    });
    ok(
      '❗ 被删的那条**也照样**出现在 thinSource 里（它一样材料薄，抹掉反而少一个信号）',
      JSON.stringify(r2.decision.thinSource) === JSON.stringify([1]),
      JSON.stringify(r2.decision.thinSource),
    );
  }
}

// ============================================================
// 十一、草稿封面兜底（pickDraftCover）—— 用户「直接使用第二个新闻的图片做封面」
// ============================================================
//
// 09-29 晚报 az 篇的实际情况：第一条是「土耳其 TPAO 计划将每日石油产量提升至 100 万桶」
// （AZERTAC 俄语源、无图），而封面取的是第一条的图 ⇒ 退成内置品牌图。
// 用户贴出的那张「阿塞拜疆 - 2026-09-29 晚报」草稿截图，封面就是那张没有任何信息的品牌图。
//
// 提示词里的「封面规则」负责**首选**（把有图且重要性相当的那条排到第一位）；
// 这个函数负责**兜底**（实在没有，就往后借一条的图）——两层互补，不是二选一。

section('十一、草稿封面兜底（pickDraftCover）');

{
  const c0 = pickDraftCover([
    { title: '土耳其 TPAO 计划将每日石油产量提升至 100 万桶', imageUrl: undefined },
    { title: 'AB 将重组 Davr Bank 领导层', imageUrl: 'https://cdn.example.az/b.jpg' },
  ]);
  ok('第一条没图 ⇒ 借后面第一条有图的（这正是用户在报的那种情况）', c0?.index === 1, JSON.stringify(c0));
  ok('带出被借那条的标题（「封面是哪条稿子的」必须有答案）', c0?.title === 'AB 将重组 Davr Bank 领导层');
  ok('带出的 URL 就是那条的图', c0?.url === 'https://cdn.example.az/b.jpg');

  const c1 = pickDraftCover([
    { title: '第一条有图', imageUrl: 'https://cdn.example.az/a.jpg' },
    { title: '第二条也有图', imageUrl: 'https://cdn.example.az/b.jpg' },
  ]);
  ok('第一条有图 ⇒ 就用第一条（正常情况，行为与改动前完全一致）', c1?.index === 0);
  ok('不会舍近求远', c1?.url === 'https://cdn.example.az/a.jpg');

  ok('一条都没图 ⇒ null（由调用方退回内置品牌图，旧行为）', pickDraftCover([{ title: 'A' }, { title: 'B' }]) === null);
  ok('空数组 ⇒ null（不抛异常）', pickDraftCover([]) === null);
  ok(
    '空白串不算「有图」（否则会把一个坏 <img> 当成封面去下载）',
    pickDraftCover([{ title: 'A', imageUrl: '   ' }, { title: 'B', imageUrl: 'u' }])?.index === 1,
  );
  ok(
    '往后找时跳过中间所有没图的条目',
    pickDraftCover([{ title: 'A' }, { title: 'B' }, { title: 'C', imageUrl: 'u' }])?.index === 2,
  );
}

// ============================================================
// 汇总
// ============================================================

endToEnd()
  .then(() => {
    console.log(`\n${'='.repeat(64)}`);
    if (failures.length === 0) {
      console.log(`✅ 全部通过：${passed} 项断言`);
      process.exit(0);
    } else {
      console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
      for (const f of failures) console.log(`   - ${f}`);
      process.exit(1);
    }
  })
  .catch((e) => {
    console.error('回归脚本自身抛异常：', e);
    process.exit(1);
  });
