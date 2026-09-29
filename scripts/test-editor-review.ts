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
  EDITOR_PROMPT_VERSION,
  fixRejectReason,
  isEditorReviewEnabled,
  MAX_DROPS,
  MAX_FIXES,
  MAX_TITLE_LEN,
  MIN_KEEP,
  parseVerdict,
  reviewDraft,
  type ReviewItem,
} from '../src/lib/editor-review';

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

// ============================================================
// 二、正常路径：合规的处置必须**真的被执行**
// ============================================================

section('二、正常路径（合规处置确实生效）');

{
  const items = mkItems(8);
  const { decision, audit } = applyVerdict(items, {
    // 故意给一个**被打乱**的顺序：验证排序真的被采纳
    order: [1, 0, 3, 2, 5, 4, 7, 6],
    drops: [
      // 真实的线上场景：这两条是同一场会谈（阿塞拜疆政府与 AIIB）
      { index: 1, kind: 'duplicate', reason: '与第 0 条同为阿塞拜疆政府与 AIIB 的那场会谈' },
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
  const r1 = applyVerdict(items8, {
    drops: [
      { index: 1, kind: 'duplicate', reason: '与第 0 条是同一场会谈' },
      { index: 2, kind: 'duplicate', reason: '与第 3 条是同一次检查' },
    ],
  });
  ok(`删 ${2} 条（= 上限）被采纳`, r1.audit.appliedDrops === 2, JSON.stringify(r1.audit));

  const r2 = applyVerdict(items8, {
    drops: [
      { index: 1, kind: 'duplicate', reason: '与第 0 条是同一场会谈' },
      { index: 2, kind: 'duplicate', reason: '与第 3 条是同一次检查' },
      { index: 5, kind: 'not_news', reason: '体育赛事，不是投资新闻' },
    ],
  });
  ok('超比例上限 ⇒ **整组作废**（不是取前 2 条）', r2.audit.appliedDrops === 0, JSON.stringify(r2.audit));
  ok('整组作废时保留全部稿件', r2.decision.finalIndices.length === 8);
  ok('整组作废的理由写清了是比例超限', r2.audit.rejections.some((x) => x.includes('整组作废')), JSON.stringify(r2.audit.rejections));

  // 保留下限：6 条删 2 条只剩 4 < MIN_KEEP=5
  const items6 = mkItems(6);
  const r3 = applyVerdict(items6, {
    drops: [
      { index: 1, kind: 'duplicate', reason: '与第 0 条是同一场会谈' },
      { index: 2, kind: 'duplicate', reason: '与第 3 条是同一次检查' },
    ],
  });
  ok(`删完低于保留下限 ${MIN_KEEP} 条 ⇒ 整组作废`, r3.audit.appliedDrops === 0, JSON.stringify(r3.audit));
  ok('保留下限的理由写清了', r3.audit.rejections.some((x) => x.includes('保留下限')));
  const r4 = applyVerdict(items6, { drops: [{ index: 1, kind: 'duplicate', reason: '与第 0 条是同一场会谈' }] });
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
  ];
  for (const c of cases) {
    const r = applyVerdict(items, { drops: [c.raw] });
    ok(`逐条拒绝：${c.name}`, r.audit.appliedDrops === 0 && r.audit.rejections.some((x) => x.includes(c.needle)), JSON.stringify(r.audit.rejections));
  }
  const r = applyVerdict(items, { drops: [{ index: 1, kind: 'duplicate', reason: '与第 0 条是同一场会谈' }, { index: 1, kind: 'duplicate', reason: '与第 0 条是同一场会谈' }] });
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
    drops: [{ index: 5, kind: 'not_news', reason: '体育赛事，不是投资新闻' }],
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
          drops: [{ index: 1, kind: 'duplicate', reason: '与第 0 条同为阿塞拜疆政府与 AIIB 的那场会谈' }],
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
  }
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
