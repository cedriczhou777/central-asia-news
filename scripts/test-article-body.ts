/**
 * 原文正文补抓（`src/lib/article-body.ts`）离线回归。
 *
 * 用法：`pnpm tsx scripts/test-article-body.ts`（纯内存，**不联网**）
 *
 * ## 为什么必须有这个脚本
 *
 * 这一层是 2026-10-02 那轮根因修复的地基：阿塞拜疆 8 个源里有 5 个 RSS
 * **完全没有正文**，于是模型照着标题编正文、总审拿空原文核对（结构性失明）。
 * 修法是「去文章页把正文抓回来，抓不到就不入库」。
 *
 * 但这条修法的每一步都踩在**静默失效**上，而且方向各不相同：
 *
 *   | 失效 | 后果 | 为什么没人会发现 |
 *   |---|---|---|
 *   | 抽出来的不是正文（是导航/相关阅读） | 垃圾冒充原文进库，翻译照它编 | 不报错，成品看着正常 |
 *   | 该抽到的没抽到（正文被嵌套标签腰斩） | 关键事实（国名、数字）落在被截掉的后半段 | 抽到的部分读起来是通顺的 |
 *   | 长度判据把标签也算进去 | 空壳 RSS 被当成「有正文」，**补抓路径整个不触发** | 计数变小，看着像「这个源本来就正常」 |
 *   | 两处长度判据各写一份 | 采集侧认定「够长」而推送侧认定「不够长」 | 两边的日志各自都自洽 |
 *
 * 所以这里钉三类东西：**纯函数的行为**（可离线精确断言）、
 * **几条结构性不变量**（抽取结果必须能通过它自己的长度闸）、
 * 以及**跨模块共用的那个常量**（采集侧与推送侧必须同一个数）。
 *
 * ⚠️ 本脚本**只测离线部分**。真实页面长什么样只能看联网探针
 * （`scripts/probe-article-body.ts`）—— 两者的分工别混：
 * 离线证明「给定 HTML 时逻辑对」，联网证明「真实 HTML 长这样」。
 */

import {
  BODY_FETCH_GAP_MS,
  BODY_MAX_CHARS,
  decodeEntities,
  extractBodyFromHtml,
  fetchArticleBody,
  hasSourceBody,
  htmlToText,
  MIN_SOURCE_BODY_CHARS,
  needsBodyFetch,
  sourceBodyLength,
} from '../src/lib/article-body';
import { pushExclusionReason, type PushExclusion } from '../src/lib/article-format';

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

/** 造一段「够长」的正文（真实语料是西里尔/拉丁，这里用等价结构的假文）。 */
function bodyText(n = MIN_SOURCE_BODY_CHARS + 20): string {
  let s = '';
  while (s.length < n) s += '阿塞拜疆国家石油公司公布投资计划，总额约 12 亿美元。';
  return s.slice(0, n);
}

/**
 * 两段**内容不同**的正文。
 *
 * ⚠️ 必须不同：`cleanParagraphs` 会把逐字重复的段落只留第一次，
 * 用同一段文字造「两段」会让断言实际测的是去重规则，而不是它声称要测的那条。
 */
const PARA_A = '巴库举行第二届阿塞拜疆国际投资论坛，签署总额 10.8 亿美元的投资协议。'.repeat(2);
const PARA_B = '该论坛由经济部主办，共有 23 家机构参与，签约项目覆盖能源与物流两个领域。'.repeat(2);

/**
 * ⚠️ 全部断言包在 `main()` 里，**不能用顶层 await**：
 * 本仓库的 `tsx` 输出是 CJS 格式，顶层 await 会让脚本直接报
 * `Top-level await is currently not supported with the "cjs" output format`，
 * 而那段报错看起来像「脚本写错了」，容易让人去改断言。
 */
async function main(): Promise<void> {
// ============================================================
// 一、HTML → 纯文本（后面所有判据都建立在这一步上）
// ============================================================

section('一、htmlToText / decodeEntities');

{
  ok(
    '剥掉标签、留下文本',
    htmlToText('<p>巴库</p><p>签署协议</p>').replace(/\s+/g, '') === '巴库签署协议',
    JSON.stringify(htmlToText('<p>巴库</p><p>签署协议</p>')),
  );
  ok('块级标签的闭合变成换行（段落边界不能丢）', htmlToText('<p>第一段</p><p>第二段</p>').includes('\n'));
  ok('<br> 也变成换行', htmlToText('上行<br>下行').includes('\n'));

  // ★ 顺序判据：先剥标签、再解实体。反过来会把正文里的字面示例当标签剥掉。
  ok(
    '❗ 正文里写成 `&lt;div&gt;` 的字面示例**不被当标签剥掉**（顺序：先剥标签再解实体）',
    htmlToText('<p>代码里写成 &lt;div&gt; 就是块级元素</p>').includes('<div>'),
    `实际：${JSON.stringify(htmlToText('<p>代码里写成 &lt;div&gt; 就是块级元素</p>'))}`,
  );

  // ★ 实体：三类都要能解，解不出来必须原样保留（猜错比留着更糟）
  ok('具名实体 &amp; &nbsp; &laquo; 解开', decodeEntities('&amp;&nbsp;&laquo;') === '& «', decodeEntities('&amp;&nbsp;&laquo;'));
  ok('十进制实体解开', decodeEntities('&#1053;&#1086;&#1074;') === 'Нов', decodeEntities('&#1053;&#1086;&#1074;'));
  ok('十六进制实体解开（大小写 x 都要认）', decodeEntities('&#x41;&#X42;') === 'AB', decodeEntities('&#x41;&#X42;'));
  ok('大小写不规范的具名实体也认（&NBSP; 实测存在）', decodeEntities('&NBSP;') === ' ');
  ok(
    '❗ 解不出来的实体**原样保留**（不乱猜）',
    decodeEntities('&foobar;') === '&foobar;',
    `实际：${decodeEntities('&foobar;')}`,
  );
  ok('超出 Unicode 范围的数字实体原样保留', decodeEntities('&#x110000;') === '&#x110000;');
  ok('`&#0;` 原样保留（0 不是合法码位）', decodeEntities('&#0;') === '&#0;');
  ok('不换行空格（U+00A0）归一成普通空格', htmlToText('a\u00a0b') === 'a b');

  // ★★ 长度判据必须建立在**剥完标签**的文本上。
  //    这一条如果坏了，最隐蔽的后果是「补抓路径整个不触发」。
  ok(
    '❗❗ 长度不含标签字符（`<div><br></div>` 算 0 字）',
    sourceBodyLength('<div><br></div>') === 0,
    `实际 ${sourceBodyLength('<div><br></div>')} —— 若 >0，空壳 RSS 会被当成「有正文」`,
  );
  ok(
    '❗❗ 长度不含 `<script>` 里的 JS（否则一段垃圾会冒充原文进库，还挡掉补抓）',
    sourceBodyLength('<script>var a = "x".repeat(200);</script>') === 0,
    `实际 ${sourceBodyLength('<script>var a = "x".repeat(200);</script>')}`,
  );
  ok(
    '长度也不含 `<style>` 里的 CSS',
    sourceBodyLength('<style>.a{color:red;font-size:12px;line-height:1.5}</style>') === 0,
  );
  ok('畸形输入不抛异常（空串 / 半个标签 / 裸实体）', (() => {
    for (const s of ['', '<div class="', '&', '<p>&amp</p>', '&'.repeat(500)]) {
      try {
        htmlToText(s);
      } catch {
        return false;
      }
    }
    return true;
  })());
}

// ============================================================
// 二、长度判据：采集侧与推送侧必须是**同一个数**
// ============================================================

section('二、needsBodyFetch / hasSourceBody（两侧共用同一个阈值）');

{
  ok('空串 ⇒ 需要补抓', needsBodyFetch('') === true);
  ok('null / undefined ⇒ 需要补抓（不改签名，让调用方不用先判空）', needsBodyFetch(null) === true && needsBodyFetch(undefined) === true);
  ok('空串 / null ⇒ 不许推送', hasSourceBody('') === false && hasSourceBody(null) === false);
  ok('纯 HTML 空壳（只有标签）⇒ 需要补抓', needsBodyFetch('<div><p></p><br></div>') === true);

  // ★★★ 这条不变量是整个修复的地基之一：
  //     同一个常量被喂给采集侧（要不要去抓）和推送侧（能不能推）。
  //     两边一旦分叉，就会出现「采集认为够长不补抓、推送认为太短全挡掉」——
  //     表现为「这一国突然没稿子了」，而两边的日志各自都自洽。
  const probes: Array<string | null | undefined> = [
    '',
    null,
    undefined,
    '<div><br></div>',
    '短'.repeat(MIN_SOURCE_BODY_CHARS - 1),
    '短'.repeat(MIN_SOURCE_BODY_CHARS),
    bodyText(),
    '<p>' + '长'.repeat(300) + '</p>',
  ];
  ok(
    '❗❗ needsBodyFetch 与 hasSourceBody 是两个互补口径（永不分叉）',
    probes.every((p) => needsBodyFetch(p) === !hasSourceBody(p)),
    probes.map((p) => `${sourceBodyLength(p)}:${needsBodyFetch(p)}/${hasSourceBody(p)}`).join(' '),
  );

  // 边界两侧各测一次（只测一边的话，> 写成 >= 也抓不到）
  ok(
    `长度恰好 ${MIN_SOURCE_BODY_CHARS} ⇒ 放行`,
    hasSourceBody('甲'.repeat(MIN_SOURCE_BODY_CHARS)) === true,
  );
  ok(
    `长度 ${MIN_SOURCE_BODY_CHARS - 1} ⇒ 不放行`,
    hasSourceBody('甲'.repeat(MIN_SOURCE_BODY_CHARS - 1)) === false,
  );

  // ★ 阈值本身钉住。为什么值得钉：这条闸一上线，「候选变少」是最可能的症状，
  //   而最顺手的「修法」就是把阈值调低 —— 那等于把「宁可不推，也不推模型编的内容」
  //   这条决定反过来。真要调，先看 `funnelByCountry.droppedNoBody` 是哪几个源。
  ok(
    '❗ 阈值 = 60（实测 Inbusiness.kz 86 / Total.kz 91 / AKIpress 97 都在这条线之上）',
    MIN_SOURCE_BODY_CHARS === 60,
    `现在是 ${MIN_SOURCE_BODY_CHARS} —— 调低它会让「模型编的正文」重新入库，先看 droppedNoBody 再决定`,
  );
  ok(
    '实测那三个「正文短但真实」的源都在线之上（阈值没有紧到误杀真源）',
    [86, 91, 97].every((n) => hasSourceBody('字'.repeat(n)) === true),
  );

  // 重试/间隔的调参是量出来的，别被后人「顺手优化」掉
  ok(
    '❗ 同一台站两次抓取之间至少留 1 秒（实测 600ms 连打全撞在同一个封禁窗口里）',
    BODY_FETCH_GAP_MS >= 1000,
    `现在是 ${BODY_FETCH_GAP_MS}ms —— 调小会让 azertag 那类被 Cloudflare 罩住的站全变 403`,
  );
  ok('正文上限存在（防某个巨型页面把内存和时间吃掉）', BODY_MAX_CHARS > 0 && BODY_MAX_CHARS <= 20_000);
}

// ============================================================
// 三、抽取：三级降级，顺序不能换
// ============================================================

section('三、extractBodyFromHtml · 三级降级与顺序');

{
  const longPara = bodyText(200);
  const paraA = PARA_A;
  const paraB = PARA_B;

  // ★★ 页面里**同时**有 JSON-LD 和正文容器：必须是 JSON-LD 赢。
  //    这条断言 2026-10-02 抓到过一个死代码 —— JSON-LD 本身就是一段 `<script>`，
  //    而调用方先 `stripNeverUseful()` 把 script 全剥了再去读它 ⇒ 第一级降级从来没生效过。
  const both =
    `<html><body><script type="application/ld+json">{"@type":"NewsArticle","articleBody":${JSON.stringify(paraA + '\n\n' + paraB)}}</script>` +
    `<div class="article-body"><p>${bodyText(300)}</p></div></body></html>`;
  const r1 = extractBodyFromHtml(both);
  ok(
    '❗❗ ① JSON-LD 优先于页面里的正文容器（读到的是它的内容，不是容器里的）',
    r1?.via === 'jsonld' && (r1?.text || '').includes('巴库'),
    `via=${r1?.via} —— 若为 container，检查是不是先剥了 <script> 再读 JSON-LD`,
  );
  ok('① JSON-LD 里的段落分隔被保住（\\n\\n 切段）', (r1?.paragraphs || 0) === 2, `paragraphs=${r1?.paragraphs}`);

  // JSON-LD 里的转义必须解开（真实页面里 \uXXXX 很常见）。
  // 这里现场把汉字转成 `\uXXXX` 生成，而不是手写一串 —— 手写容易写短，
  // 一旦正文不足 60 字，这条断言会**因为长度闸而通过不了**，
  // 看起来像「转义没解开」，排查方向就歪了。
  const cjkBody = PARA_A + '该论坛由经济部主办，共有 23 家机构参与，签约项目覆盖能源与物流两个领域。';
  const escapedBody = [...cjkBody]
    .map((c) => (/[\u4e00-\u9fff]/.test(c) ? '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') : c))
    .join('');
  // `headline` 里的填充只是为了让整页长度过 200 字节的入口下限，不参与断言
  const escaped =
    `<html><body><script type="application/ld+json">{"@type":"NewsArticle","headline":"${'x'.repeat(220)}",` +
    `"articleBody":"${escapedBody}"}</script></body></html>`;
  ok('（自检）这份语料确实是 \\uXXXX 转义形态，且足够长', escapedBody.includes('\\u') && cjkBody.length >= MIN_SOURCE_BODY_CHARS);
  const rEsc = extractBodyFromHtml(escaped);
  ok(
    '① JSON-LD 的 \\uXXXX 转义被解开（不解开等于存了一串反斜杠）',
    rEsc !== null && rEsc.text.includes('巴库') && !rEsc.text.includes('\\u'),
    JSON.stringify(rEsc?.text),
  );

  // ② 容器路径
  const r2 = extractBodyFromHtml(
    `<html><body><nav>首页 关于我们</nav><div class="article-content"><p>${paraA}</p><p>${paraB}</p></div></body></html>`,
  );
  ok('② 认得出 class 里的正文提示（article-content）', r2?.via === 'container', `via=${r2?.via}`);
  ok('② 多段都留下来了（两段不同内容）', (r2?.paragraphs || 0) === 2, `paragraphs=${r2?.paragraphs}`);

  // ★★ 嵌套同名标签：非贪婪正则会腰斩正文，而关键事实常在最后一段。
  //    线上实证：Economist.kg 那条「电站位于贾拉拉巴德州纳伦河上」就在全文最后一句。
  const nested =
    `<html><body><section class="post-content">` +
    `<p>${longPara}</p>` +
    `<section><p>中间插了一段引用块，里面还有个 section，用来制造同名嵌套。</p></section>` +
    `<p>电站位于贾拉拉巴德州纳伦河上，装机容量 1200 兆瓦。</p>` +
    `</section></body></html>`;
  const rNest = extractBodyFromHtml(nested);
  ok(
    '❗❗ 嵌套同名标签不腰斩正文（最后一段必须还在）',
    (rNest?.text || '').includes('贾拉拉巴德州'),
    `抽出来的结尾：${JSON.stringify((rNest?.text || '').slice(-60))}`,
  );

  // ★★ 导语常写在 <article><header> 里，容器路径上**不能**剥 header。
  //    （两段刻意用**不同**内容：同内容会被「重复段只留第一次」规则吃掉，
  //      那样测的就变成去重规则了 —— 这两个判据的区别很重要。）
  const withHeader =
    `<html><body><article><header><p>${paraA}</p></header><p>${paraB}</p></article></body></html>`;
  const rHdr = extractBodyFromHtml(withHeader);
  ok(
    '❗❗ 容器路径**不剥** header（站点常把导语放在 <article><header> 里）',
    (rHdr?.text || '').includes('巴库') && (rHdr?.text || '').includes('23 家机构'),
    `长度 ${(rHdr?.text || '').length}，导语疑似被吃掉`,
  );

  // ③ 整页兜底：这时**要**剥掉 nav/footer
  const noContainer =
    `<html><body><nav>${'首页 关于我们 订阅 '.repeat(20)}</nav>` +
    `<main>${'<p>' + longPara + '</p>'}</main>` +
    `<footer>${'版权所有 联系邮箱 '.repeat(20)}</footer></body></html>`;
  const r3 = extractBodyFromHtml(noContainer);
  ok('③ 没有正文容器时走整页兜底', r3?.via === 'paragraphs' || r3?.via === 'container', `via=${r3?.via}`);
  ok(
    '③ 兜底路径剥掉了导航与页脚（不剥的话长度会被外框撑起来，看着像有正文）',
    !(r3?.text || '').includes('版权所有'),
    JSON.stringify((r3?.text || '').slice(-80)),
  );
}

// ============================================================
// 四、抽取：抽不到就返回 null —— 绝不返回半截垃圾
// ============================================================

section('四、抽不到 ⇒ null（不许把导航当正文）');

{
  const cases: Array<[string, string]> = [
    ['空串', ''],
    ['过短的片段（<200 字节，不可能是文章页）', '<p>太短了</p>'],
    ['只有骨架的空页', `<html><body><div></div></body></html>${' '.repeat(300)}`],
    ['只有脚本（脚本内容不能被当正文）', `<html><body>${'<script>var a = 1;</script>'.repeat(20)}</body></html>`],
    ['只有导航链接', `<html><body><nav>${'<a href="/x">栏目名</a>'.repeat(40)}</nav></body></html>`],
    ['只有一段短话（撑不起一篇报道，也没法核对数字）', `<html><body><p>${'短'.repeat(10)}</p></body></html>`],
  ];
  for (const [name, html] of cases) {
    const out = extractBodyFromHtml(html);
    ok(`抽不出正文 ⇒ null：${name}`, out === null, `实际 via=${out?.via} ${out?.text.length} 字`);
  }

  // ★ 结构性不变量：只要返回非 null，它就**必须**能通过推送侧那道闸。
  //   否则会出现「采集侧存了一条原文，推送侧认为它没原文」——
  //   一条稿子被自己人挡掉，而且两边都觉得自己对。
  const probes = [
    `<html><body><div class="article-body"><p>${bodyText(300)}</p></div></body></html>`,
    `<html><body><p>${bodyText(300)}</p><p>${bodyText(280)}</p></body></html>`,
    `<html><body><script type="application/ld+json">{"articleBody":${JSON.stringify(bodyText(300))}}</script></body></html>`,
  ];
  ok(
    '❗❗ 抽取结果非 null ⇒ 必定能过 hasSourceBody（两侧口径一致）',
    probes.every((h) => {
      const out = extractBodyFromHtml(h);
      return out !== null && hasSourceBody(out.text);
    }),
    probes.map((h) => JSON.stringify(extractBodyFromHtml(h)?.text.length)).join(','),
  );
  ok(
    '抽取结果的正文不超过上限',
    probes.every((h) => (extractBodyFromHtml(h)?.text.length || 0) <= BODY_MAX_CHARS),
  );

  // 超长正文要截断（提示词撑爆是另一回事，这里先保证存进库的不失控）
  const huge = `<html><body><div class="article-body"><p>${'长'.repeat(BODY_MAX_CHARS + 3000)}</p></div></body></html>`;
  const rHuge = extractBodyFromHtml(huge);
  ok(
    `超长正文被截到 ${BODY_MAX_CHARS} 字以内`,
    rHuge !== null && rHuge.text.length <= BODY_MAX_CHARS,
    `实际 ${rHuge?.text.length}`,
  );
}

// ============================================================
// 五、段落清洗：重复段与碎段
// ============================================================

section('五、段落清洗（重复段只留第一次 / 碎段丢弃）');

{
  const para = bodyText(120);
  // 线上实证 `id 8765`：同一句正文连着出现两次 ⇒ 重复段必须去掉
  const dup = `<html><body><div class="article-body"><p>${para}</p><p>${para}</p></div></body></html>`;
  const rDup = extractBodyFromHtml(dup);
  ok(
    '逐字重复的段落只留第一次（线上 id 8765 正文重复两遍）',
    (rDup?.text.split(para).length || 2) - 1 === 1,
    `出现 ${((rDup?.text.split(para).length || 2) - 1)} 次`,
  );

  // 模板句（相关阅读/订阅提示）不该进正文；但**真实短段**（日期条）要留
  const noise = `<html><body><div class="article-body"><p>${para}</p><p>相关阅读</p><p>2026 年 10 月 1 日</p><p>订阅我们的频道</p></div></body></html>`;
  const rNoise = extractBodyFromHtml(noise);
  ok('过短的碎段（「相关阅读」4 字）被丢掉', !(rNoise?.text || '').includes('相关阅读'));
  ok(
    '带日期的短段**留下**（「2026 年 10 月 1 日」13 字，丢了可惜 —— 阈值刻意取小）',
    (rNoise?.text || '').includes('2026 年 10 月 1 日'),
    `实际：${JSON.stringify(rNoise?.text)}`,
  );
}

// ============================================================
// 六、fetchArticleBody 的入参护栏（不联网）
// ============================================================

section('六、fetchArticleBody：非 http(s) 直接拒绝，且永不抛异常');

{
  // 这些全部在发请求**之前**就返回，所以这一段不联网
  const bad = ['', 'not a url', 'ftp://example.com/x', 'javascript:alert(1)', '//example.com/x'];
  let allFail: boolean = true;
  for (const u of bad) {
    const r = await fetchArticleBody(u);
    if (r.ok || !r.reason) allFail = false;
  }
  ok('❗ 非 http(s) 链接一律拒绝，且给出可读原因（不抛异常）', allFail);
}

// ============================================================
// 七、跨模块：`no_source_body` 这条排除原因必须存在
// ============================================================

section('七、与推送侧的契约（`PushExclusion` 里必须有 no_source_body）');

{
  // ★★ 下面这一行是**编译期断言**，不是运行期断言：
  //     `PushExclusion` 里没有 `no_source_body` 这个名字，`ts-check` 就会红。
  //     为什么必须这样钉：推送侧那条闸记的账走这个联合类型，
  //     类型里没它的后果是计数只能塞进 `Record<string, number>` ——
  //     拼错一个字母不报错，只是那个数字永远是 0，
  //     于是「为什么不推送」又一次变成只能进容器翻日志。
  const reasons: PushExclusion[] = ['untranslated', 'category', 'missing_source', 'country', 'no_source_body'];
  ok('❗❗ `no_source_body` 是 PushExclusion 的正式成员（类型级，见上面的说明）', reasons.includes('no_source_body'));

  // ★★ 反向：这条原因**不许**由 `pushExclusionReason` 返回。
  //    它需要 `original_content`，而那个函数的签名只收「文本三件套」，
  //    而 `dedupe-check` 是拿 `as never` 调它的 ⇒ 一旦有人「顺手」把它挪进去，
  //    那边 `original_content` 恒为 `undefined` ⇒ **把全部稿子判掉，而且静默**。
  //    （同形态事故在本项目已经发生过三次，见 `pushExclusionReason` 的注释。）
  const zhBody = '据当地媒体报道，该项目总投资约 1.2 亿美元，计划于 2027 年建成投产。';
  ok(
    '❗❗ `pushExclusionReason` 永远不返回 `no_source_body`（它拿不到 original_content）',
    pushExclusionReason({ title: '哈萨克斯坦铁路项目开工', content: zhBody, category: 'economy' }, 'kz') !==
      'no_source_body',
    '把它挪进 pushExclusionReason ⇒ dedupe-check 用 as never 调用时会把全部稿子静默判掉',
  );
}

// ----- 汇总 -----

console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}

}

main().catch((err) => {
  console.error('回归脚本自身报错：', err);
  process.exit(1);
});
