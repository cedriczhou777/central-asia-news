/**
 * **草稿审稿审计**（2026-10-30）
 *
 * ## 为什么要有它
 *
 * 2026-10-30 用户要求「站在审稿人的角度，检查翻译、数据、概括准不准」。
 * ⇒ ⇒ 人工读 10 篇能看出问题，但**读不完 86 篇** ⇒ ⇒ 而且**每次都读一遍**不现实
 * ⇒ ⇒ **必须变成自动指标**，每次 push 后跑一遍出报告。
 *
 * ## 三个指标（对应用户提的三点）
 *
 * ① **数据**：正文里的「百分比 / 金额 / 倍数」是否都能在**原文**里找到
 *    ⇒ 关键在**数字归一化**（见 {@link normalizeNumbers}）：
 *    俄语用逗号作小数点（`65,4`）、千位用空格（`28 27 трлн`）、
 *    中文用「万亿/亿/万」⇒ ⇒ 不归一化就全是假阳性。
 * ② **翻译**：正文里出现**原文语言里没有的拉丁字母词**（例如俄语原文里冒出英文单词）
 *    ⇒ 这是「翻译掺了原文没有的东西」的信号。
 * ③ **概括**：标题里混进了**源站的体裁后缀**（`- 摄影作品` / `- фото`）
 *    ⇒ 以及「标题与摘要指向不同事实」。
 *
 * ## ⚠️ 这个工具的定位：**筛子，不是判决**
 *
 * 它报的是「**值得人工看的清单**」⇒ ⇒ **报出来的每一条都要人工判读**
 * ⇒ ⇒ 报「有差异」**不等于**「有问题」（可能是表达差异）
 * ⇒ ⇒ **但「没报出来」也不等于「没问题」**（原文太短 ⇒ 核对不了 ⇒ ⚠️ 静默通过）。
 *
 * ## 用法
 *
 *   npx tsx scripts/audit-drafts.ts                 # 审计最近两日入库的稿子
 *   npx tsx scripts/audit-drafts.ts 2026-10-29      # 指定某一天
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { SELF_KEYWORDS } from '../src/lib/country-relevance';

const BASE = 'https://central-asia-news-307705-12-1480606601.sh.run.tcloudbase.com';

/** 中文/俄文里「乘以 10^n」的单位 ⇒ 归一到「亿」。 */
const UNITS: Record<string, number> = {
  万亿: 1e12, 十亿: 1e9, 亿: 1e8, 千万: 1e7, 百万: 1e6, 十万: 1e5, 万: 1e4, 千: 1e3,
  трлн: 1e12, млрд: 1e9, млн: 1e6, тыс: 1e3, тыщ: 1e3,
};

/** 「百分比」不算金额，单独一类（归一到「%」）。 */
const PCT = '%％';

/**
 * 抽出一段文本里的「数值 + 单位」并归一。
 *
 * @returns 形如 `['43.34%', '282700亿', '60倍']` 的集合（已归一，单位统一）
 */
export function normalizeNumbers(text: string): Set<string> {
  const out = new Set<string>();
  const clean = (text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  // 数值：支持千位空格（俄语 `28 27`）与逗号小数（俄语 `65,4`）
  const num = '(?:\\d{1,3}(?:\\s\\d{3})+|\\d+)(?:[.,]\\d+)?';
  const re = new RegExp(`(${num})\\s*(${Object.keys(UNITS).join('|')}|${PCT}|倍|раз|в раза|раза)`, 'gu');
  for (const m of clean.matchAll(re)) {
    let raw = m[1].replace(/\s+/g, '');
    const comma = raw.includes(',');
    raw = raw.replace(',', '.');
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const unit = m[2];
    if (unit === PCT || unit === '％') {
      out.add(`${v}%`);
      continue;
    }
    if (unit === '倍' || unit === 'раз' || unit === 'в раза' || unit === 'раза') {
      out.add(`${v}倍`);
      continue;
    }
    const scale = UNITS[unit];
    if (scale === undefined) continue;
    // 归一到「亿」：值 / 1e8
    const yi = v * scale / 1e8;
    out.add(`${Number(yi.toFixed(4))}亿`);
  }
  // 纯百分比（没有单位的 % 已被上面捕获）
  return out;
}

/** 俄语原文里不该出现的拉丁词（排除专有名词常见的英文字母缩写不算）。 */
const LATIN_WORD = /[A-Za-z]{4,}/g;

export interface AuditItem {
  country: string;
  title: string;
  reason: string;
  detail: string;
}

/** 一篇稿子的审计。 */
export function auditArticle(a: {
  title?: string | null;
  summary?: string | null;
  content?: string | null;
  originalContent?: string | null;
  country?: string | null;
}): AuditItem[] {
  const items: AuditItem[] = [];
  const oc = a.originalContent || '';
  const body = (a.content || '').replace(/<[^>]+>/g, ' ');
  const title = a.title || '';

  // ① 数据：正文里的数字是否都在原文里
  const bodyNums = normalizeNumbers(body);
  const origNums = normalizeNumbers(oc);
  const missing = [...bodyNums].filter((n) => !origNums.has(n));
  if (missing.length > 0) {
    items.push({
      country: a.country || '?',
      title,
      reason: '数据',
      detail: `正文有、原文里找不到：${missing.slice(0, 5).join('、')}`,
    });
  }

  // ② 翻译：**只在原文本身就含拉丁字母时**才做「拉丁词比对」。
  //
  // ⚠️⚠️ **这一条曾经几乎全是假阳性**（2026-10-30 首版实测 89 篇命中）：
  // 俄语原文里的**人名/地名在中文正文里是拉丁转写**（Амина Меликова → amina、melikova）
  // ⇒ ⇒ 「原文里没有这些拉丁词」是**必然**的 ⇒ ⇒ 对俄语源一律不成立。
  // ⇒ ⇒ 判据收紧成：**原文含拉丁字母**（英语/阿塞拜疆语等）时才查。
  // ⇒ ⇒ 俄语源只能靠**数字一致 + 专名一致**判断翻译质量（见上）。
  const origHasLatin = /[A-Za-z]/.test(oc);
  const origLatin = new Set((oc.match(LATIN_WORD) || []).map((w) => w.toLowerCase()));
  const bodyLatin = new Set(
    (body.replace(/https?:\/\/\S+/g, ' ').match(LATIN_WORD) || []).map((w) => w.toLowerCase()),
  );
  const extra = origHasLatin ? [...bodyLatin].filter((w) => !origLatin.has(w)) : [];
  if (extra.length > 0) {
    items.push({
      country: a.country || '?',
      title,
      reason: '翻译',
      detail: `正文出现原文里没有的拉丁词：${extra.slice(0, 5).join('、')}`,
    });
  }

  // ② 翻译：**中文正文里出现了原文语言里不可能有的结构** ⇒ 例如俄语原文里出现中文标点/汉字
  // （翻译时把原文的中文稿子又塞回去、或把别的稿子的中文混进来）
  if (/[\u4e00-\u9fff]/.test(oc)) {
    const hanInOrig = (oc.match(/[\u4e00-\u9fff]/g) || []).length;
    if (hanInOrig > 0 && hanInOrig > oc.length * 0.05) {
      items.push({
        country: a.country || '?',
        title,
        reason: '翻译',
        detail: `原文里混进了 ${hanInOrig} 个汉字（原文不像中文稿）`,
      });
    }
  }

  // ③ 概括：标题里混进了源站的体裁后缀
  const suffix = /\s*[-–—|｜]\s*(摄影作品|图片|照片|视频|现场图片|фото|Фото|видео|Видео)\s*$/;
  if (suffix.test(title)) {
    items.push({
      country: a.country || '?',
      title,
      reason: '概括',
      detail: '标题末尾混进了源站的体裁后缀',
    });
  }

  // ③ 概括：标题里的数字，摘要里没有（用户看到的「标题与摘要对不上」）
  const titleNums = normalizeNumbers(title);
  const sumNums = normalizeNumbers(a.summary || '');
  const tOnly = [...titleNums].filter((n) => !sumNums.has(n));
  if (titleNums.size > 0 && tOnly.length === titleNums.size && sumNums.size === 0) {
    items.push({
      country: a.country || '?',
      title,
      reason: '概括',
      detail: '标题含数字但摘要里一个都没有 ⇒ 标题与摘要信息不匹配',
    });
  }

  return items;
}

async function fetchDay(date: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${BASE}/api/articles?date=${date}&limit=900`);
  const j = (await res.json()) as { articles?: Array<Record<string, unknown>> };
  return j.articles || [];
}

// ---------------------------------------------------------------------------
// 四、★ 2026-10-31：把「标准新闻稿件要素 + 可读性」落成**可量化的检查项**
// ---------------------------------------------------------------------------
//
// ## 为什么要有它
//
// 用户问：「能不能做一个独立 AI 调用审核翻译准确性、概括改写、数据核实、
// 内容合理性、相关性、可读性，达到标准新闻稿件的要素要求，改到完美？」
//
// ⇒ 现有总审的「七件事」已经覆盖了其中 5 个维度（见 `editor-review.ts` 的
// `EDITOR_PROMPT` 第一节）⇒ **真正缺的是「可读性」与「标准要素」的可量化判据**。
// 而「完美」要能收敛，**前提是它得先是个数** —— 这一节就是把形容词变成指标。
//
// ## ⚠️ 这一节的定位：**筛子，不是判决**
//
// 与上面三项指标同一性质：报出来 = **值得人工看**，没报出来 ≠ 没问题。
// ⇒ 全部判据都必须是**确定性**的（可回归、零成本、不调模型）。
//
// ## 为什么只量「能确定性判」的子项
//
// 六要素（谁/何时/何地/何事/为何/结果）里，「何事」「为何」「结果」
// **没法用规则判**（需要语义）⇒ 那正是现有总审（对着原文逐项核对）在做的事。
// ⇒ 这里只量**四个能用规则判**的，**不假装能全判**。

/** 时间表达（要素「何时」）。 */
const TIME_WORDS = [
  '今日', '昨日', '昨天', '明天', '本周', '上周', '本月', '上月', '今年', '去年', '明年',
  '近期', '日前', '近日', '当天', '本周', '季度', '上半年', '下半年', '月初', '月末',
  '星期', '周一', '周二', '周三', '周四', '周五', '周六', '周日',
];

/** 机构 / 职务类词（要素「谁」）。 */
const ORG_WORDS = [
  '政府', '部', '央行', '银行', '公司', '集团', '企业', '工厂', '项目', '委员会', '协会',
  '基金会', '交易所', '统计局', '议会', '总统', '总理', '部长', '主席', '总理府',
  '监管', '局', '署', '办公室', '部门', '商行', '运营商', '投资人', '投资者',
  // ⚠️ v2 校准补的**职务词**（2026-10-31 抽验发现漏了）：
  // 「吉尔吉斯斯坦**议员**提议将学校课程…」被判「无主体」⇒ 词表不全造成的**假阳性**。
  '议员', '代表', '市长', '州长', '区长', '区长', '专家', '学者', '发言人', '秘书长',
  '署长', '行长', '总理府', '内阁', '议会', '法院', '检察院', '统计局', '海关', '税务局',
  // 政区名当主体（「比什凯克市所有四个行政区…」—— 主体就是那个市）
  '市', '州', '区',
];

/** 评论腔连接词（可读性：标题不该是摘要）。 */
const COMMENT_WORDS = ['尽管', '虽然', '同时', '此外', '另一方面', '不仅', '但是', '然而', '值得注意的是'];

/** 拉丁缩写（可读性：术语未解释）。 */
const ABBR_RE = /\b[A-Z]{2,6}\b/g;

/** 去掉正文里的 HTML。 */
function plain(html: string): string {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 一篇稿子的「要素 + 可读性」体检。
 *
 * @param countryCode 该稿所属国家（用于判「何地」）
 * @param countryNames 该国的中文名/别名（用于判「何地」）
 */
export function auditQuality(a: {
  title?: string | null;
  summary?: string | null;
  content?: string | null;
  originalContent?: string | null;
  country?: string | null;
}, countryNames: string[] = []): AuditItem[] {
  const items: AuditItem[] = [];
  const title = (a.title || '').trim();
  const summary = (a.summary || '').trim();
  const head = title + ' ' + summary;
  const body = plain(a.content || '');

  const push = (reason: string, detail: string) =>
    items.push({ country: a.country || '?', title, reason, detail });

  // ---- 要素「何时」----
  const hasTime =
    TIME_WORDS.some((w) => head.includes(w)) ||
    /\d{4}\s*年/.test(head) ||
    /\d{1,2}\s*月\s*\d{1,2}\s*日/.test(head) ||
    /\d{1,2}\s*月/.test(head);
  if (!hasTime) {
    push('要素·时间锚点', '稿面没有任何日期锚点（**日报场景下版式已给日期 ⇒ 这是软指标**）');
  }

  // ---- 要素「何事/数据」----
  // 排除纯日期型数字（2026 年、10 月 29 日）⇒ 只看「非日期数字」。
  // ⚠️ **v2 校准**：只看「标题+摘要」会假阳性 —— 正文常常在第二句就补出金额
  // ⇒ 判据放宽到「标题 + 摘要 + 正文前 150 字」。
  const numScope = head + ' ' + body.slice(0, 150);
  const nonDateNums = (numScope.replace(/\d{4}\s*年/g, '')
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*日/g, '')
    .replace(/\d{1,2}\s*月/g, '')
    .match(/\d/g) || []).length;
  if (nonDateNums === 0) {
    push('要素·数据', '标题与摘要里没有任何金额/比例/规模 ⇒ 对投资日报来说这是硬伤（读者无法判断重要性）');
  }

  // ---- 要素「谁」----
  // ⚠️ **v2 校准**：第一版只认中文机构词 ⇒ **「专名」被误判成「没有主体」** ——
  // 「Wildberries 为吉尔吉斯斯坦所有用户提供 Click&Collect 线下提货服务」
  // 的主体就是 Wildberries（一个品牌专名）⇒ 第一版报「没有主体」是错的。
  // ⇒ 现在**中文机构词 或 拉丁专名**任一命中就算有主体。
  const hasOrg =
    ORG_WORDS.some((w) => head.includes(w)) ||
    /\b[A-Z][A-Za-z]{2,}/.test(head);
  if (!hasOrg) {
    push('要素·主体', '标题与摘要里看不到任何机构、职务或专名主体 ⇒ 读起来像「有件事发生了」但不知道是谁');
  }

  // ---- 要素「何地」----
  // ⚠️ **v2（2026-10-31 校准）**：第一版只看「国名」⇒ **大量假阳性** ——
  // 「Tazalyk 因车辆尾气排放超标被罚款」那条的摘要里写的是「**比什凯克**市政企业」，
  // 地点其实是有的 ⇒ 报「没有地点」是错的。
  // ⇒ 改成判「国名 **或** 本国城市/州名」（复用 `SELF_KEYWORDS`，**不新增维护点**：
  // 那张表本来就是判国别相关性的权威清单）。
  if (countryNames.length > 0 && !countryNames.some((n) => head.includes(n))) {
    push('要素·地点', `标题与摘要里既没有本国名、也没有本国城市/州名（${countryNames.slice(0, 3).join('、')}…）⇒ 读者不知道这条具体发生在哪`);
  }

  // ---- 可读性 ----
  if (title.length > 42) {
    push('可读性·标题过长', `标题 ${title.length} 字（> 42）⇒ 微信后台一行放不下，会被截断`);
  }
  if (COMMENT_WORDS.some((w) => title.startsWith(w))) {
    push('可读性·标题是摘要', '标题以评论连接词开头 ⇒ 读者要的是「发生了什么」，不是「尽管…且…」');
  }
  const sentences = body.split(/(?<=[。！？])/).map((x) => x.trim()).filter(Boolean);
  if (sentences.length > 0) {
    const avg = body.length / sentences.length;
    const longest = Math.max(...sentences.map((x) => x.length));
    if (avg > 65) {
      push('可读性·句子过长', `平均句长 ${avg.toFixed(0)} 字（> 65）⇒ 中文新闻的可读上限约 40–45 字`);
    }
    if (longest > 120) {
      push('可读性·长句', `最长一句 ${longest} 字（> 120）⇒ 读者会跳读`);
    }
  }
  const abbrs = [...new Set((body.match(ABBR_RE) || []))];
  if (abbrs.length >= 3 && !abbrs.some((x) => summary.includes(x))) {
    push('可读性·术语未解释', `正文出现 ${abbrs.length} 个未在摘要解释的缩写：${abbrs.slice(0, 6).join('、')}`);
  }

  return items;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const dates = arg ? [arg] : ['2026-10-29', '2026-10-30'];
  const arts: Array<Record<string, unknown>> = [];
  for (const d of dates) arts.push(...(await fetchDay(d)));
  console.log(`审计 ${arts.length} 篇（${dates.join('、')}）\n`);

  const byReason = new Map<string, AuditItem[]>();
  let clean = 0;
  let tooShort = 0;
  for (const a of arts) {
    const oc = String(a.originalContent || '');
    if (oc.length < 300) tooShort++;
    const items = auditArticle(a as never);
    if (items.length === 0) clean++;
    for (const it of items) {
      const k = it.reason;
      const arr = byReason.get(k) || [];
      arr.push(it);
      byReason.set(k, arr);
    }
  }

  // ⚠️⚠️ 模板字符串里**不能写 `//`**（它会被当成注释，把后面的 `)}` 一起吃掉 ⇒ 语法错）
  // ⇒ 2026-10-30 今晚在 `fetch-telegram.ts` 与这里**各栽一次** ⇒ ⇒ 一律先算好再插值。
  const pct = (x: number): number => Math.round((x * 100) / Math.max(1, arts.length));
  console.log(`★ 三项指标全过：${clean} 篇（${pct(clean)}%）`);
  console.log(`★ 原文不足 300 字符（**正文基本无法核对**）：${tooShort} 篇（${pct(tooShort)}%）`);

  for (const [reason, items] of byReason) {
    console.log(`\n${'='.repeat(70)}\n=== 【${reason}】命中 ${items.length} 篇 ===`);
    for (const it of items.slice(0, 20)) {
      console.log(`  [${it.country}] ${it.title.slice(0, 50)}`);
      console.log(`      ⇒ ${it.detail}`);
    }
    if (items.length > 20) console.log(`  … 另 ${items.length - 20} 篇`);
  }
  console.log(
    '\n⚠️ 这些是「**值得人工看**」的清单 ⇒ **报出来不等于有问题**（可能是表达差异）；' +
      '\n   但「没报出来」**也不等于没问题**（原文太短 ⇒ 核对不了 ⇒ 静默通过）。',
  );

  // ---- ★★ 总审「看不见的那部分」：正文 200 字之后的违规数字（2026-10-31）----
  //
  // ## 为什么这个指标是关键
  //
  // 总审的「与原文核对」（第七件事）只看**正文前 200 字**（`toReviewItem` 的 `contentPeek`）
  // ⇒ ⇒ **正文 200 字之后的幻觉它根本看不见**。
  // 真实样本（塔吉克斯坦「杜尚别 30 日交通临时管制」那条）：
  // 前 200 字是真的（交通管制 + 山体滑坡），
  // 后面凭空接了 **9 段「塔吉克宏观经济综述」**（汇率 87.42 / GDP 5.2% / 预算 /
  // 外资 5 亿美元 / 通胀 5.1% / 失业率 4.3% / 人均 GDP 1,200 美元 …）
  // ⇒ **那些数字原文里一个都没有** ⇒ 而总审**没机会**发现它们。
  //
  // ⇒ 所以要分开量：「全文违规」 vs 「200 字之后违规」
  // ⇒ **后者 = 总审的结构性缺口有多大**（这是决定「要不要加长 contentPeek」的依据）。
  {
    const PEER_LIMIT = 200;
    let fullHit = 0;
    let tailHit = 0;
    let tailOnly = 0;
    const samples: string[] = [];
    for (const a of arts) {
      const oc = String(a.originalContent || '');
      const body = String(a.content || '').replace(/<[^>]+>/g, ' ');
      if (body.length <= PEER_LIMIT) continue;
      const bodyNums = normalizeNumbers(body);
      const origNums = normalizeNumbers(oc);
      const missing = [...bodyNums].filter((n) => !origNums.has(n));
      if (missing.length === 0) continue;
      fullHit++;
      // 只看 200 字之后那部分有没有违规数字
      const tailNums = normalizeNumbers(body.slice(PEER_LIMIT));
      const tailMissing = [...tailNums].filter((n) => !origNums.has(n));
      // 「前 200 字干净、后段才有违规」= 总审**完全没机会**发现的那一类
      const headNums = normalizeNumbers(body.slice(0, PEER_LIMIT));
      const headMissing = [...headNums].filter((n) => !origNums.has(n));
      if (headMissing.length === 0) tailOnly++;
      if (tailMissing.length > 0) {
        tailHit++;
        if (samples.length < 6) {
          samples.push(`  [${a.country}] ${String(a.title).slice(0, 42)} ⇒ 后段违规 ${tailMissing.slice(0, 4).join('、')}`);
        }
      }
    }
    console.log(`\n${'='.repeat(70)}\n=== ★★ 总审看不见的那部分（正文 > ${PEER_LIMIT} 字的 ${arts.filter((a) => String(a.content || '').replace(/<[^>]+>/g, ' ').length > PEER_LIMIT).length} 篇）===`);
    console.log(`全文含「原文里查不到的数字」：${fullHit} 篇`);
    console.log(`★ 其中**违规数字落在 200 字之后**（= 总审看不见）：${tailHit} 篇`);
    console.log(`★★ 只在后段违规（前 200 字干净 ⇒ 总审完全没机会）：${tailOnly} 篇`);
    console.log(`   （前 200 字里也有违规 ⇒ 总审**有机会**发现但没删 ⇒ 那是闸/提示词的问题，不是盲区）`);
    console.log('样本：');
    for (const x of samples) console.log(x);
  }

  // ---- ★ 要素 + 可读性基线（2026-10-31）----
  const qByReason = new Map<string, AuditItem[]>();
  let qClean = 0;
  const perCountry = new Map<string, { total: number; hit: number }>();
  for (const a of arts) {
    const cc = String(a.country || '?');
    // 本国词表里只取**中文**部分（拉丁词在中文稿面里不会出现）
    const names = (SELF_KEYWORDS[cc as keyof typeof SELF_KEYWORDS] || []).filter((w) => /[\u4e00-\u9fff]/.test(w));
    const q = auditQuality(a as never, names);
    const bucket = perCountry.get(cc) || { total: 0, hit: 0 };
    bucket.total++;
    if (q.length === 0) qClean++;
    else bucket.hit++;
    perCountry.set(cc, bucket);
    for (const it of q) {
      const arr = qByReason.get(it.reason) || [];
      arr.push(it);
      qByReason.set(it.reason, arr);
    }
  }
  console.log(`\n${'='.repeat(70)}\n=== ★ 要素 + 可读性基线（${arts.length} 篇）===`);
  console.log(`★ 四项全过：${qClean} 篇（${pct(qClean)}%）`);
  console.log('★ 按国家（命中篇数 / 总篇数）：');
  for (const [cc, b] of [...perCountry.entries()].sort()) {
    console.log(`    ${cc}  ${b.hit} / ${b.total}`);
  }
  for (const [reason, list] of [...qByReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n--- 【${reason}】命中 ${list.length} 篇（${pct(list.length)}%）---`);
    for (const it of list.slice(0, 8)) {
      console.log(`  [${it.country}] ${it.title.slice(0, 48)}`);
      console.log(`      ⇒ ${it.detail}`);
    }
    if (list.length > 8) console.log(`  … 另 ${list.length - 8} 篇`);
  }
}
void main();
