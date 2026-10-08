/**
 * 「同一件事」识别 —— 内容级去重的唯一入口。
 *
 * ## 为什么需要这个文件
 *
 * 2026-09-21 用户在公众号草稿预览里截到一对新闻：两条都在讲「阿斯塔纳跨阿雷斯河新建桥梁」，
 * 一条写「八车道、总长 1.2 公里」，另一条写「七车道、2026 年 10 月竣工」。
 * 看起来是两篇，实际是同一条新闻被处理了两遍。
 *
 * 排查后发现原去重有两处根本问题（都有实测数据支撑，不是推测）：
 *
 * 1. **链接去重是精确字符串比较**，而同一篇原文的链接形式会变形
 *    （`?from=rss`、末尾斜杠、`utm_*`…）。实测线上库 200 篇里 4% 是
 *    **source_url 逐字相同**的重复行；换一个更早的 200 篇快照更是 22%。
 *    → 由 `utils.canonicalUrl` + `dedupeStoriesDeterministic` 的 `same_url` 处理。
 *
 * 2. **字符相似度判据实际上从不生效**。原 `isDuplicateContent` 要求
 *    「标题相似度 ≥0.8」或「标题+正文平均相似度 ≥0.6」。拿真实数据实测：
 *    连同一篇原文的两次翻译都只有 avg≈0.18（桥梁那对），而上面那对
 *    土耳其/以色列大使馆的**不同事件**却能达到 avg≈0.32 ——
 *    也就是说这个判据既抓不到该抓的，又（在阈值附近）可能误伤。
 *    单纯调阈值解决不了：正负样本的分数区间是**重叠**的。
 *    → 实测打分器确实做不到「理解」，所以这里引入模型判定（见 `judgeSameEventPairs`）。
 *
 * ## 三层机制（按可靠性从高到低）
 *
 * | 层 | 判据 | 性质 | 成本 |
 * |---|---|---|---|
 * | L0 `same_url` | 归一化链接相同 | 确定性，可断言 | 0 |
 * | L1 `same_original` | 原文标题相同（链接不同 → 同稿多链） | 确定性，可断言 | 0 |
 * | L1.5 `same_title` | **中译标题**接近逐字相同（正文可不参与） | 确定性，可断言 | 0 |
 * | L2 `llm_same_event` | 模型判「表述不同、实际同一件事」 | 概率性，可回退 | 每国 1 次调用 |
 *
 * `same_title` 是 2026-09-23 补的，补的是一个**确定性的洞**：L1 只看**原文**标题，
 * 而同一件事被两家不同语种的源各报一遍时原文标题必然不同 ⇒ L1 接不住；
 * 但它们的**中译**标题常常一字不差。这条不花 token、不依赖模型，见 {@link isSameTitle}。
 *
 * L2 是「理解机制」本体：像「金价下跌」vs「金价上涨」、「土耳其大使馆」vs「以色列大使馆」
 * 这种**字面很像但语义相反/不同**的对，只有看懂内容才分得开。
 * 因此提示词里**显式并列了这类反例**，并把「拿不准就不要合并」写进判据 ——
 * 宁可漏合并，也不能把两条不同的新闻合成一条（那是丢信息，比重复更糟）。
 *
 * L2 不可用时（没配 Key / 调用失败 / 返回不合法）**自动降级为只跑 L0+L1**，
 * 并在返回值里带上 `llm.error`，让调用方能看出来这次有没有真正跑过模型。
 */
import { canonicalUrl, similarity, originalTitleKey, textFingerprint } from './utils';
import { askLlmJson } from './translate';
// 判组提示词与它的版本号都在 `judge-prompts` 里 —— 那边同时冻着 v1 对照组。
// `TITLE_MAX` 也从那里取，保证标题截断长度两边只有一个真值。
//
// ⚠️ 必须**先 import 再 export**：`export { x } from './y'` 只是转发，
// **不会在本模块建立绑定**，本文件内部用 `buildPairPrompt` 会报未定义
// （2026-09-24 踩过，靠 `test:dedup` 的端到端断言抓到 —— 类型检查是后知后觉的）。
import {
  TITLE_MAX,
  JUDGE_PROMPT_VERSION,
  buildPairPrompt,
  availablePromptVersions,
  promptBuilderFor,
} from './judge-prompts';

// 转出去，保持既有调用点（`/api/dedupe-check`、`scripts/test-dedup.ts`）的 import 路径不变。
export { TITLE_MAX, JUDGE_PROMPT_VERSION, buildPairPrompt, availablePromptVersions };

/** 判定「是不是同一件事」所需的最小字段集。DB 行与抓取中间产物都能满足。 */
export interface StoryLike {
  title: string;
  content?: string | null;
  summary?: string | null;
  country_code?: string | null;
  /** DB 行字段名 */
  source_url?: string | null;
  original_title?: string | null;
  /** API 返回的驼峰字段名 */
  sourceUrl?: string | null;
  originalTitle?: string | null;
  publishedAt?: string | null;
}

export type DedupReason =
  | 'same_url'
  | 'same_original'
  | 'same_text'
  | 'same_title'
  /** 推送端专属：中译标题近似（`sim ≥ TITLE_NEAR_MIN_SIM`），见 `dedupeNearTitles` */
  | 'same_title_near'
  | 'llm_same_event';

export interface DedupDrop<T> {
  /** 被保留下来的那一条（组内排最前的） */
  kept: T;
  /** 被丢弃的这一条 */
  dropped: T;
  reason: DedupReason;
}

export interface DedupResult<T> {
  kept: T[];
  drops: DedupDrop<T>[];
  /**
   * **数字护栏「留下没合」的对**（2026-10-05 新增，见 `hasConflictingNumbers`）。
   *
   * 它和 `drops` 是**反方向**的记录：`drops` 说「删了谁」，这里说「本来要删、被拦住了」。
   * 为什么必须留痕：护栏的价值**等于它拦下的东西**，而它拦下的是「一次删除的取消」——
   * 没有任何输出字段能反映出来。不留痕的话，「护栏到底有没有生效」只能靠读代码猜。
   *
   * 存**标题**而不是下标：这是给人看的告警，而 `llm.indexTitles` 上还有一次
   * 「下标基准在哪」的坑（见该字段），不值得为一条日志再引入一次映射风险。
   */
  numericSpared?: Array<{ kept: string; blocked: string }>;
  /**
   * L2 的执行情况。`ran=false` 表示本次没跑模型（没配 Key 或条数不足）。
   *
   * `groups` 是**采信结果**（下标分组，每组 ≥2 条，组内保留第 0 条）。
   * pair 形态下它由模型判出的**对**合并而来，所以额外带上 `pairs` / `candidateCount` ——
   * 体检时「模型被问了几对、答了哪几对」比「最后合成了几个组」更能说明问题：
   * 前者能看出模型是否在乱答，后者经过合并/熔断后可能已经看不出原始行为了。
   */
  llm: {
    ran: boolean;
    ok: boolean;
    /** 本次实际用的任务形态（`pair` = 逐对二选一，`group` = 长串找组，已停用） */
    mode: JudgeMode;
    groups: number[][];
    /**
     * ★ **模型本次看到的「下标基准」** —— `groups` / `pairs` / `vetoed` / `declined`
     * 里所有下标的含义都是「这个数组的第 i 条」，**不是**调用方传进来的 `items`。
     *
     * ## 为什么必须有这个字段（2026-10-05，踩到的真缺陷）
     *
     * `dedupeStories` 在问模型**之前**先跑确定性去重（L0/L1/L1.5 + 闸 3.5 近同名），
     * 删掉若干条才把 `keptAfterIdentity` 交给模型。于是**两套下标从第一步就错位了**：
     * `keptAfterIdentity[i]` 对应的是 `items[i + 删掉的条数]`。
     *
     * 体检接口原先拿调用方自己的数组去解释这些下标，结果：
     *   · 报出来的每一对标题**都是不相干的两条**（下标被整体前移）；
     *   · `sim` 因此普遍算成 0 —— 看着像「候选对里混进了毫不相似的对」；
     *   · 还会得出「模型把消防火灾和医疗赔偿判成同一件事」这种**假结论**。
     *   而真相是**仪器错了，模型没错**（同类前科见 AGENTS O-3-1）。
     *
     * ⇒ **凡是要按下标取标题/算相似度的地方，一律用这个数组，不许用调用方的入参。**
     * 拿不到它时（`ran=false`）就不要报下标类明细，宁可报空。
     */
    indexTitles?: string[];
    /**
     * pair 形态：模型判为「同一件事」的下标对（原样保留，未做合并）。
     *
     * `sim` 与 `vetoed`/`declined` 同口径（三条列表形状一致），这样体检报告与
     * `POST /api/judge-pairs` 的输出可以一视同仁地读，不必为「判是的」单独再算一遍
     * 相似度（两处各算一次，迟早会算出不一致的数字 —— 本项目栽过同类跟头）。
     */
    pairs?: Array<{ a: number; b: number; sim: number }>;
    /** pair 形态：本轮问了多少个候选对 */
    candidateCount?: number;
    /**
     * pair 形态：**下限之上共有多少对**（截断前）。
     *
     * `candidatesAboveFloor > candidateCount` ⇒ 这一轮发生了截断（有一批够像的对
     * 因为名额上限没被问到）。2026-10-05 新增 —— 在此之前这件事**完全不可见**，
     * 而用户报的重复恰好全是这一形态。见 `PairJudgeResult.candidatesAboveFloor`。
     */
    candidatesAboveFloor?: number;
    /**
     * pair 形态：**优先档之上共有多少对**（截断前，见 {@link PAIR_PRIORITY_SIM}）。
     *
     * 它 > `candidateCount` 才说明**真的漏了**（连最像的那批都没装下）；
     * 只有 `candidatesAboveFloor` 超标属预期（低分对没挤进来）。两者分开报，
     * 是为了让「上限该不该再调大」这个问题有答案，而不是靠感觉。
     */
    candidatesAbovePriority?: number;
    /** pair 形态：被确定性判据（反向极性）拦下、没问模型的对 */
    vetoed?: Array<{ a: number; b: number; sim: number }>;
    /** pair 形态：问了模型、但模型判「否」的对（用来发现**漏合并**） */
    declined?: Array<{ a: number; b: number; sim: number }>;
    /**
     * 这次判定**由哪条通道回答的**（`zhipu` / `zhipu-flash` / `deepseek`）。
     *
     * 为什么必须报出来：判定链路的随机源不止温度一个 —— `askLlmJson` 会按顺序
     * 在通道间降级，**不同型号给出不同答案**也是候选解释之一。没有这个字段时，
     * 「同一份输入两次结论不同」只能停在「不稳定，原因未知」。
     *
     * ⚠️ **它不是「排除性工具」，它就是主因** —— 这里曾写反过一次，2026-09-22 更正：
     * 实测（14 天窗口、同一批候选内按通道分组）通道间差 5.07 对 / 通道内标准差 0.09，
     * 差 50 倍；干净口径下 uz / az 的通道内标准差**恰好是 0**。也就是说
     * 「同样输入两次结论不同」里**绝大部分是通道切换造成的**，不是模型随机。
     *
     * ⇒ 看到这个字段就该去比「同批候选里两条通道各答了什么」，
     * 而不是像旧注释那样用它宣布「通道无罪」。工具：`pnpm test:dedup-stability`。
     * 但注意钉固定通道只换来**可复现性**，精度还得靠确定性加证（见
     * `JUDGE_TEMPERATURE` 第 2 层）—— 两条通道各有各的错，不是「有一条是对的」。
     *
     * 另：**没有真的调用模型时这个字段为空**（候选对为 0 → 直接返回）。
     * 体检里看到 `provider` 缺失，先看 `candidatePairs` 是不是 0，别当成 bug。
     */
    provider?: string;
    error?: string;
    raw?: string[];
    /**
     * 本次送进模型的提示词指纹，**只在 `collectRaw`（= `debug=1`）时出现**。
     * 用来把「同一窗口内重复跑、答案却变了」归因：两次指纹相同 ⇒ 只能赖通道在
     * `temperature=0` 下仍不确定；不同 ⇒ 提示词组成漂了。
     * 见 {@link PairJudgeResult.promptHash} 与 `JUDGE_STABILITY_2026-10-08.md` 第二节·补二。
     */
    promptHash?: string;
  };
}

// ----- 字段读取（兼容 snake_case / camelCase 两种来源）-----

function urlOf(a: StoryLike): string {
  return a.source_url ?? a.sourceUrl ?? '';
}

function originalTitleOf(a: StoryLike): string {
  return a.original_title ?? a.originalTitle ?? '';
}

function countryOf(a: StoryLike): string {
  return a.country_code ?? '';
}

/**
 * 一条新闻参与身份判定的 key。空字符串表示「这条没有可用身份」。
 * 导出是为了让离线体检脚本能直接断言「哪两条被判成同一条」。
 *
 * `originalTitleKey` 定义在 `utils.ts`：`db-articles.ts` 入库去重时也要用同一个指纹，
 * 放在这里会让 db 模块反向依赖本文件（进而依赖 translate），没必要。
 */
export function identityKeys(a: StoryLike): string[] {
  const keys: string[] = [];
  const cu = canonicalUrl(urlOf(a));
  if (cu) keys.push(`url:${cu}`);
  const ot = originalTitleKey(originalTitleOf(a));
  if (ot) keys.push(`orig:${countryOf(a)}:${ot}`);
  return keys;
}

// ----- L0 + L1 + 原字符相似度（纯同步、确定性）-----

/**
 * 兜底的「文本几乎逐字相同」判据 —— 只认**真正逐字重复**，不认「主题像」。
 *
 * 为什么把阈值收到这么紧（标题 0.9 + 正文 0.8）：
 *
 * 这条判据的前身是 `utils.isDuplicateContent`（标题 0.8 / 平均 0.6）。
 * 拿真实语料量过之后发现它两头都不对：
 *
 *   - **真实数据上一个真阳性都没有**。在 200 篇 / 1000 篇两份线上快照上跑，
 *     它一次都没触发（真实的重复全被链接判据先拦掉了）。
 *   - **却有一个可复现的误杀**。两条**方向相反**的新闻 ——
 *     「全球市场黄金和白银价格下跌」与「……上涨」，正文只差一个字 ——
 *     标题相似度 0.71、正文相似度 0.9，平均值 0.81 ≥ 0.6 → **被合并**，
 *     等于直接把一条利空/利多相反的消息删掉。
 *
 * 结论：一个「真实数据零贡献、却有实际误杀风险」的判据不该留在链路里。
 * 收成「几乎逐字相同」之后它只负责最后一种情况 ——
 * 同一段文本被两个入口各抓了一份（连标题带正文都一样），
 * 这种情况无论怎么判都该合并。
 *
 * 「表述不同、实际同一件事」（例如「团结的力量」与「团结之力」）交给 L2 模型判组，
 * **不要**试图靠调这里的阈值解决：那类正负样本的相似度区间实测是**重叠**的。
 */
function isNearIdenticalText(a: StoryLike, b: StoryLike): boolean {
  if (similarity(a.title, b.title) < 0.9) return false;
  return similarity(a.content || '', b.content || '') >= 0.8;
}

/**
 * 中译标题「几乎逐字相同」⇒ 同一件事。**不需要正文参与。**
 *
 * ## 为什么另立这一条（2026-09-23）
 *
 * `isNearIdenticalText` 要求**标题和正文都**逐字接近（0.9 / 0.8）。
 * 那个正文门槛是为了挡「标题像、事实相反」的对（见上面的取舍说明），但它有个副作用：
 * **同一件事被两家源各写一遍时，中译正文的详略本来就不同**，正文相似度只有 0.1–0.3，
 * 于是「标题一字不差」的重复行被漏判。实测（10 天 × 5 国、1674 篇库内行）漏了三对：
 *
 * | 对 | 中译标题相似度 | 正文相似度 |
 * |---|---|---|
 * | kz `id=3925/3909` 托卡耶夫会见俄语组织秘书长博恰罗娃（Newtimes.kz ↔ Egemen Qazaqstan） | **1.000** | 0.274 |
 * | kz `id=3741/3915` 2027 年启动无人驾驶出租车服务（The Astana Times ↔ Egemen Qazaqstan） | **1.000** | 0.138 |
 * | az `id=4164/4134` 伊朗航空公司暂停飞往阿塞拜疆的航班（Modern.az ↔ APA） | **1.000** | 0.155 |
 *
 * 它们的 `source_url` 与 `original_title` 都不同（不同源、不同语种），所以 L0/L1 也接不住 ——
 * 第三层是它们唯一的兜底，而第三层默认关着 ⇒ 三条一直重复进推送。
 *
 * ## 0.95 这个门槛是量出来的，不是拍的
 *
 * 同一批数据（1674 篇）里，**相似度 ≥0.85 的对只有 3 对，且全部恰好 = 1.000**，
 * 0.85–0.99 这一段**一对都没有**；危险的那几类都远在下面：
 * 「同主体不同事」0.55、「同题不同场（上合两场会）」0.42、「不同地点的同名项目」0.40。
 * 所以 0.85–1.0 之间**没有需要区分的东西**，门槛落在这一段里的哪一格都等价 ——
 * 取 0.95 是为了容忍 `normalizeText` 之后仍剩下的零星差异（长标题差 1 字实测 ≈0.92，
 * 仍会被挡在外面，这是有意的：宁可漏合并，也不要靠一个字去赌）。
 *
 * ⚠️ **这一条只处理「几乎逐字」**，不处理「换词重写」—— 后者分数实测落在 0.35 一档，
 * 归 L2 模型判（L2 自 2026-09-28 起**默认开**，但入库端显式关，见 `DedupOptions.useLlm`）。
 *
 * ## 反向极性仍然确定性否决
 *
 * `sim ≥ 0.95` 理论上能被「同一句话改一个方向词」满足，而那是**两条相反的消息**
 * （后果是删掉一条利多或一条利空）。方向词是封闭集合、不需要语义推断，
 * 没有理由交给阈值去赌 ⇒ 用 `hasOppositePolarity` 在阈值之前拦掉。
 * 实测那类对（金价跌/涨）只有 0.71–0.81，本来也过不了 0.95，这条是双保险。
 */
export const TITLE_IDENTICAL_MIN_SIM = 0.95;

/**
 * `isSameTitle` 的**文本级**形态 —— 闸 2（跨轮、入库前）复用这条判据时用它。
 *
 * 为什么导出成独立函数、而不是让闸 2 自己拿两个标题算相似度：
 * 「批内判重」（闸 3）与「跨轮拦重复」（闸 2）必须**逐字同一份代码**。
 * 一旦两边各抄一份，阈值就会悄悄分叉 —— `article-format.pushExclusionReason`
 * 那边因为诊断接口自己抄判据（还抄漏了）得出过相反结论，同类事故已有先例。
 * 闸 2 的调用点见 `fetch-news` 的「闸 2 之二」段。
 *
 * 占位标题（`'无标题'`）在这里就否决，**不靠调用方记得跳过**：
 * `normalizeText('无标题')` 之后两篇「无标题」的相似度是 1.0，
 * 不在谓词里拦就会把所有无标题稿判成同一篇 —— 而这类约定靠「调用方自觉」
 * 迟早被漏掉（闸 2 丢的行不可追，赌不起）。`db-articles.getRecentTitlesByCountry`
 * 里的同名过滤只是省循环，**不是**防线的本体。
 */
export function isSameTitleText(ta: string, tb: string): boolean {
  return titleDupAt(ta, tb, TITLE_IDENTICAL_MIN_SIM);
}

/** `isSameTitleText` / `isNearSameTitleText` 共用的本体：占位标题 + 反向极性 + 阈值。 */
function titleDupAt(ta: string, tb: string, minSim: number): boolean {
  if (!ta || !tb) return false;
  if (ta === '无标题' || tb === '无标题') return false;
  if (hasOppositePolarity(ta, tb)) return false;
  return similarity(ta, tb) >= minSim;
}

/** 中译标题近似相同 ⇒ 同一条新闻（见 {@link TITLE_IDENTICAL_MIN_SIM} 的取舍说明）。 */
export function isSameTitle(a: StoryLike, b: StoryLike): boolean {
  return isSameTitleText(a.title || '', b.title || '');
}

/**
 * 抽出一条标题里的**阿拉伯数字 token**（保序，含百分号与小数点）。
 *
 * ⚠️ **只认阿拉伯数字，不认中文数字**（`三`、`十亿`、`上个世纪`）—— 这是刻意的：
 * 「上个世纪」vs「20世纪」是**同一个人说的话**（实测 `sim=0.7037`），
 * 把中文数字也抽出来会让这一对因为 `[]` vs `['20']` 判成冲突、把真重复挡在外面。
 * 中文数字在这套语料里几乎只出现在**量级词**里（数十亿、百万吨），
 * 而量级词不构成「两条不同新闻」的证据。
 */
export function numericTokensOf(title: string): string[] {
  // 把百分号并进 token（98% 与 82.2% 必须是两个不同的 token，而不是 ['98'] 与 ['82.2']）
  return [...title.matchAll(/\d+(?:[.\u066B]\d+)*\s*%?/g)]
    .map((m) => m[0].replace(/\s+/g, ''))
    .filter((s) => s.length > 0);
}

/** `needle` 是否是 `hay` 的**保序子序列**（允许中间插数字）。空数组视为子序列。 */
function isSubsequence(needle: string[], hay: string[]): boolean {
  let i = 0;
  for (const h of hay) {
    if (i < needle.length && needle[i] === h) i++;
  }
  return i === needle.length;
}

/**
 * **数字冲突护栏** —— 两条标题近乎相同、但里面的数字**互相矛盾** ⇒ 不是同一件事。
 *
 * ## 它治的是哪一类错（两个方向都有）
 *
 * | 症状 | 例子 | 不设护栏的后果 |
 * | --- | --- | --- |
 * | **过度合并**：同一份统计公报的不同数字被当成同一件事 | az「2025 年新住宅区占比 **98%**」↔「建筑工作占比 **82.2%**」（实测 `sim` 只有 0.20–0.26，但**模型全判了「是」**） | **静默丢数据** —— 8 条不同的事实合并成 1 条 |
 * | **边界抖动**：同一件事的两个写法数字不同，时合时不合 | 用户第 12 条报的「发现数十亿坚戈」那类（实测 `0.7222 / 0.75`，卡在**旧阈值 0.75** 的边上）| 同一件事一会儿合一会儿不合，用户隔天看到重复 |
 *
 * ⚠️ 上表第二行的**抖动本身已由阈值 0.75 → 0.70 消掉**（`0.7222` 与 `0.75` 现在都在闸内），
 * 无需护栏介入。但「长共同模板 + 一个极短差异槽 + 无数字」那一类仍旧是阈值治不了的
 * —— 见 {@link TITLE_NEAR_MIN_SIM} 里列的**构造得出、30 天零实例**的那条已知风险。
 * 这一行留在这里是因为护栏与阈值降档是**同一次**一起做的（降阈值必须配护栏）。
 *
 * ## 判据（保守：只在**明显矛盾**时否决）
 *
 * 两条标题各自抽出数字序列；**只有当两边都有数字、且任一序列都不是另一方的保序子序列时**
 * 才算「冲突」。这几条实测都因此**照常合并**（护栏不能误伤它们）：
 *
 * ```
 * 「在亚洲运动会中夺得金牌」      vs「在2026年亚洲运动会中夺得金牌」   [] vs ['2026']      → 合并
 * 「17.5%降至12%」               vs「17.5%下调至12%」                相等               → 合并
 * 「我军已停滞于上个世纪」         vs「我军已停滞在20世纪」             [] vs ['20']       → 合并
 * 「反极端主义行动中搜查48处」      vs「反恐行动中搜查48处地址」          ['48'] vs ['48']   → 合并
 * ```
 *
 * 这几条则被否决（正是要拦的）：
 *
 * ```
 * 「制造业投资额为6.628亿马纳特」   vs「非油气资本投资占比75%」          ['6.628'] vs ['75%'] → 冲突
 * 「新住宅区占比98%」             vs「建筑工作占比82.2%」              ['98%'] vs ['82.2%'] → 冲突
 * 「投资5.2亿」                  vs「投资3.1亿」                     ['5.2'] vs ['3.1']   → 冲突
 * ```
 *
 * ## ⚠️ 它**只能**用在确定性那一层（两条边界，都试过、都有代价）
 *
 * **调用点只有一个**：{@link isNearSameTitleText}（近同名闸，推送端专属）。
 *
 * ### 边界一：不要加进 {@link titleDupAt}
 *
 * 那条同时给**入库前**闸 2 用，而闸 2 丢的行不可追（库里没有就是没有）。
 * 一旦两篇同一件事因为「一家写 6.628 亿、一家四舍五入写 6.63 亿」被判冲突，
 * 库里就**永久**少一行。推送端丢的只是「今天不展示」，明天还在候选里。
 * ——同一个「可逆性不对称」的取舍，见 {@link TITLE_NEAR_MIN_SIM}。
 *
 * ### 边界二：也不要拿去否决**模型判出的簇**（2026-10-05 试过，被回归挡下）
 *
 * 当时的动机是顺手治 az 那种「同一份统计公报的不同数字被模型判成同一件事」。
 * 但这一层与上面**不适用同一条理由**：模型的输入里已经包含了语义判断，
 * 用一个「数字不同就否决」的算术规则去推翻它，是**用算术否定语义**。
 * 立刻被 `scripts/test-dedup.ts` 的端到端用例 ① 挡住：
 * 「启动总额 **75** 亿美元项目」↔「…**76** 亿美元投资项目」——同一件事、
 * 两家媒体四舍五入差 1 亿，否决它就会重新出现用户报的那类重复。
 *
 * ⇒ az 那一类要靠**判组提示词**（把「同一份公报的不同指标」写成反例），
 * 不是靠事后算术。
 */
export function hasConflictingNumbers(ta: string, tb: string): boolean {
  const a = numericTokensOf(ta);
  const b = numericTokensOf(tb);
  if (a.length === 0 || b.length === 0) return false;
  if (isSubsequence(a, b) || isSubsequence(b, a)) return false;
  return true;
}

/** 两条**标题**的数字是否冲突（对象形态）。 */
export function hasConflictingNumbersInTitles(a: StoryLike, b: StoryLike): boolean {
  return hasConflictingNumbers(a.title || '', b.title || '');
}

/**
 * 数字护栏的**版本号** —— 随 `hasConflictingNumbers` 的判据一起加一。
 *
 * 存在的理由是另一个同类缺口：判据改了、线上行为没变，而**没有任何字段能证明
 * 新判据到底上没上**。留一个自增整数，`GET /api/wechat/push` 的 `codeVersion.numericVetoVersion`
 * 就能把「有护栏」和「是哪一代护栏」分开。
 *
 * | 版本 | 判据 |
 * | --- | --- |
 * | 1 | 两条标题都有阿拉伯数字、且任一序列不是另一方的保序子序列 ⇒ 冲突 |
 */
export const NUMERIC_VETO_VERSION = 1;

/**
 * **近同名**的下限（2026-10-05 新增）—— 比 {@link TITLE_IDENTICAL_MIN_SIM}(0.95) 松。
 *
 * ## 为什么需要第二条线（用户报的重复，一半落在这一档）
 *
 * 0.95 那道闸实测**几乎不起作用**：30 天 8468 篇里，同一推送窗口内中译标题
 * `sim ≥ 0.90` 的只有 **1 对**，而 `0.70–0.90` 有 **44 对**。
 * 也就是说「同一件事被两家媒体各写一遍」的绝大多数**不可能**被 0.95 拦到，
 * 全压在 L2 模型身上。
 *
 * ⚠️ **这里原先写着「线上实测模型把 0.7600 那对判成了否」——那句话是错的，
 * 2026-10-05 已更正。** 它的出处是 `GET /api/dedupe-check` 的一处**下标基准错位**
 * 缺陷（详见 `DedupResult.llm.indexTitles` 的说明）：探针拿确定性去重**之前**的
 * 数组去解释模型的下标，报出来的每一对标题都指向不相干的两条，于是把「某一对判否」
 * 安到了「阿曼苏丹 0.76 那对」头上。
 *
 * 修好探针后重测（`?days=1&llm=1&debug=1`）的**真实**结论是：
 *   · 模型看到的阿曼苏丹那一对是 `sim = 0.29` 的**另一对**
 *     （「将对哈萨克斯坦进行国事访问」↔「卡西姆·本·塔里克·阿勒·赛义德对…国事访问」），
 *     模型判**是**；
 *   · 而 `0.76` 那对**根本没被问到** —— 它过了**本函数所属的近同名闸**
 *     （当时的阈值是 0.75；2026-10-05 已降为 {@link TITLE_NEAR_MIN_SIM}）且两条标题都 ≥ 15 字，
 *     所以是在 L2 之前被确定性合并掉的。
 * 也就是说：**这道闸的收益不依赖「模型判错」这个理由**，它自己就是那条兜底。
 * （教训与 AGENTS O-3-1 同类：**仪器也会撒谎**，而且它报出来的错法看着像模型的错。）
 *
 * ## 为什么取 **0.70**（2026-10-05 从 0.75 降下来；量出来的，不是拍的）
 *
 * 原先是 0.75，理由是「0.75 是实测里最低的、每条差异都只落在虚词/拼写/括号/同义动词
 * 那一档的阈值」。**那条推理的地基在 2026-10-05 被重测推翻了**：当时只看了「取哪个数
 * 最保守」，没有把 0.70–0.75 整档**逐条列出来看过**。补做之后：
 *
 * ```
 * pnpm analyze:pair-recall 30     # 2026-09-05 ~ 10-05，5 国，8547 篇 / 228 个推送轮
 *   ≥0.90        1 对
 *   0.70–0.90   44 对   ← 逐条过目：**44/44 全部是同一件事**
 * ```
 *
 * 0.70–0.75 那 17 对（原阈值**全部漏掉**）逐条对照过，一条例外都没有：
 *
 * | sim | 对 | 差异的性质 |
 * | --- | --- | --- |
 * | 0.7500 | 「17.5%降至12%」↔「17.5%下调至12%」 | 同义动词 |
 * | 0.7391 | 「祝贺哈萨克斯坦人劳动节」↔「祝贺国民劳动节」 | 换词 |
 * | 0.7333 | 「矿业冶金」↔「矿产冶金」 | 专名变体 |
 * | 0.7308 | 「在亚洲运动会中」↔「在2026年亚洲运动会中」 | 可选年份 |
 * | 0.7222 | 「战略伙伴关系」↔「战略伙伴关系关系」 | 译文重复字 |
 * | 0.7222 | 「ADEX 展览：访问/参观/视察」 | 同义动词 |
 * | 0.7179 | 「任命 X 为国防部长」↔「Tokayev 任命 X 为新国防部长」 | 可选主体/虚词 |
 * | 0.7143 | 「统一作用」↔「联合作用」 | 同义词 |
 * | 0.7083 | 「防务公司」↔「国防工业公司」 | 同义专名 |
 * | 0.7059 | 「副主席」↔「亚欧地区副主席」 | 加限定语 |
 * | 0.7037 | 「停滞于上个世纪」↔「停滞在20世纪」 | 数字写法 |
 * | 0.7000 | 「向遇难军人家属致慰问电」±「Tokayev」 | 可选主体 |
 *
 * ⇒ 原注释担心的「实体词级别替换属于语义判断、该交给模型」在这个档里**没有实例**，
 * 而模型**已经会看到这些对**（优先档下限 0.35 已覆盖）—— 也就是说原阈值唯一的净效果
 * 是：**在模型漏判时不给兜底**。
 *
 * ## ⚠️ 降它的同时必须加的那条守卫（{@link hasConflictingNumbers}）
 *
 * 纯相似度在「长共同模板 + 极短差异槽」上**必然**失效，且失效方向是**双向**的：
 *
 * ```
 * 「哈萨克斯坦总统任命 X 为国防部长」  ↔「…为紧急情况部长」        0.7714  ← 不同事件，却在闸内
 * 「阿塞拜疆2025年新住宅区占比98%」   ↔「…建筑工作占比82.2%」       0.29    ← 不同事实，模型全判「是」
 * ```
 *
 * 也就是说：**降阈值会把上面第一类也一起放进来**。所以这次不是单独调一个数，
 * 而是「降阈值 + 补一条不依赖阈值的守卫」成对做的：
 * 数字互相矛盾的两条标题一律不合并（判据与实测见 {@link hasConflictingNumbers}）。
 * 那条守卫对第二类同样生效（模型判出的簇在合并前也要过它）。
 *
 * ## 本次实测中**仍然存在、已知未解**的风险（别当成修好了）
 *
 * 上面第一类（长模板 + 极短差异槽 + **不含数字**）没有被任何守卫覆盖。
 * 它在 30 天语料里**一例都没出现**（所以我按实测把它算作可接受风险），
 * 但它是**构造得出**的：同一个人的两个职务、同一场访问的两份不同协议都会长成这样。
 * 哪天真的出现，**先看 `analyze:pair-recall` 有没有实例**，再决定是升降阈值、
 * 还是给「差异槽」单独做判据 —— 不要靠想象调参。
 *
 * ⚠️ **这道闸只在推送端跑，入库端不跑**（见 `dedupeNearTitles`）。理由是**可逆性不对称**：
 * 入库端丢的行事后不可追（`fetch-news` 的闸 2 注释已经写死了这条规矩），
 * 而推送端丢的只是「今天不展示这一条」，行还在库里、明天还在候选里。
 * 两道线的阈值不同**是有意的**，不是「判据分叉」。
 */
export const TITLE_NEAR_MIN_SIM = 0.7;

/**
 * 近同名闸的**最短标题长度**（两标题都要够长才算）。
 *
 * 为什么需要这条：`similarity` 是字符双字组的 Jaccard，**短标题里差一个字就能顶到 0.8**。
 * 算给你看（实测，不是估）——「托卡耶夫会见德国总统」↔「托卡耶夫会见德国总理」：
 * 10 个字里只有末字的双字组 `总统`/`总理` 不同 ⇒ **0.8000 ≥ 0.70**，
 * 而这是**两条不同的会见**（德国总统 vs 德国总理）。光靠阈值挡不住它 ——
 * 阈值降到 0.70 之后这条长度下限**比以前更要紧**（见 {@link TITLE_NEAR_MIN_SIM} 的取舍）。
 *
 * 取 **15**：实测 30 天里 ≥0.70 的那 44 对，**最短的一条是 15 字**
 * （「阿塞拜疆大奖赛第三场练习赛结束」↔「…（更新）」= 0.8750）——
 * 也就是说下限不是拍的，是「不比实测里最短的真重复更短」。
 * 顺带把上面那个 10 字的反例挡住（并把「施泰因迈尔/舒尔茨」那类
 * 带全名的不同会见留在更低分档，实测它们只有 0.39–0.63）。
 */
export const TITLE_NEAR_MIN_CHARS = 15;

/**
 * 近同名判据（文本级）。
 *
 * 守卫与 {@link isSameTitleText} **完全相同**（同一个 `titleDupAt`，空标题 / 占位标题 /
 * 反向极性），只换阈值 —— 三条守卫在松阈值下**更**不能省；另外多一条长度下限
 * （见 {@link TITLE_NEAR_MIN_CHARS}），因为在短标题上相似度会虚高。
 */
export function isNearSameTitleText(ta: string, tb: string): boolean {
  if (!nearTitleShapeOk(ta, tb)) return false;
  // 第四条守卫：数字互相矛盾 ⇒ 不是同一件事（见 {@link hasConflictingNumbers}）。
  // 松阈值下**更**不能省 —— 相似度越高，越可能是「同一个模板 + 一个不同的数字」。
  return !hasConflictingNumbers(ta, tb);
}

/**
 * 近同名闸的**前三条守卫**（阈值 / 占位标题 / 反向极性 / 长度下限），**不含数字护栏**。
 *
 * 单独抽出来是为了让 `dedupeNearTitles` 能回答「**如果没有数字护栏，这一对会不会被合并**」
 * —— 那是把「护栏真的拦下了东西」这件事变成可观测输出的唯一办法
 * （见 {@link DedupResult.numericSpared}）。
 *
 * ⚠️ 两条判据必须**共用**这一份：一旦这里和 `isNearSameTitleText` 各写一遍，
 * 「报出来的 spared 数量」与「实际的合并行为」就会分叉，而分叉不会报错。
 */
function nearTitleShapeOk(ta: string, tb: string): boolean {
  if (!titleDupAt(ta, tb, TITLE_NEAR_MIN_SIM)) return false;
  return Math.min(ta.length, tb.length) >= TITLE_NEAR_MIN_CHARS;
}

/** {@link isNearSameTitleText} 的对象形态。 */
export function isNearSameTitle(a: StoryLike, b: StoryLike): boolean {
  return isNearSameTitleText(a.title || '', b.title || '');
}

/**
 * 推送侧的「近同名」去重（**只在推送端调用**）。
 *
 * 与 `dedupeStoriesDeterministic` 的关系：那是**四条身份判据**（链接 / 原文指纹 /
 * 正文逐字 / 标题逐字 0.95），入库端与推送端共用；这一条是**推送端专属**的第五条，
 * 阈值 {@link TITLE_NEAR_MIN_SIM}（0.70）+ 长度下限 {@link TITLE_NEAR_MIN_CHARS}（15 字）
 * 见那两个常量里为什么这么定、为什么只在这一端跑。
 *
 * （这里原先写的是「长度下限 12 字」—— 那是 {@link TITLE_NEAR_MIN_CHARS} 定稿前的草稿值，
 * 常量改成 15 之后这行注释没跟着改。**注释里的数字也是会撒谎的**，
 * 所以现在改成引用常量名而不是复述数字。）
 *
 * 保序保留**第一条**（与其它确定性闸一致）。不搞「留更长的标题」这类聪明：
 * 那会让「留哪条」依赖长度而非顺序，出问题时无法从输入顺序复现。
 */
export function dedupeNearTitles<T extends StoryLike>(items: T[]): {
  kept: T[];
  drops: DedupDrop<T>[];
  /** 见 {@link DedupResult.numericSpared} —— 够像但被数字护栏拦下的对。 */
  numericSpared: Array<{ kept: string; blocked: string }>;
} {
  const kept: T[] = [];
  const drops: DedupDrop<T>[] = [];
  const numericSpared: Array<{ kept: string; blocked: string }> = [];
  for (const item of items) {
    const hit = kept.find((p) => isNearSameTitle(p, item));
    if (hit) {
      drops.push({ kept: hit, dropped: item, reason: 'same_title_near' });
      continue;
    }
    /**
     * 没被合并的条目里，**有一部分是「够像、但被数字护栏拦下」** ——
     * 这个区别必须报出来：否则「护栏有没有在干活」永远看不出来
     * （它拦下的是一次删除的取消，不会出现在 `drops` 里）。
     *
     * `nearTitleShapeOk` 判的是**刨掉数字护栏之外**的那三条守卫（阈值 / 占位标题 / 极性 / 长度），
     * 也就是「如果没有数字护栏，它会不会被合并」。
     */
    const spared = kept.find((p) => nearTitleShapeOk(p.title || '', item.title || ''));
    if (spared) numericSpared.push({ kept: spared.title || '', blocked: item.title || '' });
    kept.push(item);
  }
  return { kept, drops, numericSpared };
}

/**
 * 确定性的「同一条新闻」判定，按输入顺序保序去重。
 *
 * 复杂度 O(n²)，但这里的 n 是**单国单輪的候选数**（几十条），
 * 而且每条只存两个短字符串 key，实际开销可以忽略 ——
 * 换来的是「不依赖哈希碰撞、判据可逐条打印」的可排查性。
 */
export function dedupeStoriesDeterministic<T extends StoryLike>(items: T[]): {
  kept: T[];
  drops: DedupDrop<T>[];
} {
  const kept: T[] = [];
  const drops: DedupDrop<T>[] = [];
  const seenKeys = new Set<string>();

  for (const item of items) {
    const keys = identityKeys(item);

    // L0 / L1：链接或原文标题撞上已保留的条目 → 同一条新闻
    let hit: string | null = null;
    for (const k of keys) {
      if (seenKeys.has(k)) {
        hit = k;
        break;
      }
    }
    if (hit) {
      drops.push({
        kept: kept.find((p) => identityKeys(p).includes(hit as string)) as T,
        dropped: item,
        reason: hit.startsWith('url:') ? 'same_url' : 'same_original',
      });
      continue;
    }

    // 兜底 1：文本逐字相同的重复（见 isNearIdenticalText 的取舍说明）
    const textDup = kept.find((p) => isNearIdenticalText(p, item));
    if (textDup) {
      drops.push({ kept: textDup, dropped: item, reason: 'same_text' });
      continue;
    }

    // 兜底 2：中译标题逐字相同、正文详略可以差很远（见 isSameTitle 的取舍说明）
    const titleDup = kept.find((p) => isSameTitle(p, item));
    if (titleDup) {
      drops.push({ kept: titleDup, dropped: item, reason: 'same_title' });
      continue;
    }

    for (const k of keys) seenKeys.add(k);
    kept.push(item);
  }

  return { kept, drops };
}

// ----- L2：模型判组（「理解机制」本体）-----

/**
 * L2 的两种任务形态。
 *
 * **`group`（让模型在一长串里找组）实测不可用**，两次都失败：
 *   - 关 thinking：模型把**所有下标**都列进 `groups`（含大量单元素组），
 *     根本没在做判重 —— 看起来像把任务理解成「列出这些条目」。
 *   - 开 thinking：格式修好了（返回干净的 JSON），但**语义仍是错的**：
 *     它按**话题**归并，不按事件 ——
 *     哈萨克把「聚乙烯工厂」与「节水灌溉面积」并成一组，
 *     塔吉克把「独立 35 周年国际会议」与「桑搏世锦赛」并成一组。
 *
 * **`pair`（只让模型对一对标题做二选一）**是据此改的形态。理由：
 *   1. 每个判断对象只有两条，模型不需要维护「跨 20 条的一致性」；
 *   2. 模型的权力被限制成**否决权** —— 候选对由确定性判据（标题相似度）先筛，
 *      模型只能说「这两条不是同一件事」。误判的后果从「误删」变成「漏合并」，
 *      方向是安全的（漏合并只是留下重复，误合并是丢信息）。
 *   3. 输出是一个短数组，解析简单，模型不容易跑偏。
 *
 * **生产链路只用 `pair`**。`group` 形态的功能（`judgeSameEventGroups` / `parseEventGroups`）
 * 仅为 `GET /api/dedupe-check?mode=group` 的对照实验保留 —— 想复核「长串找组为什么不行」时
 * 能原地重现，不必回滚代码。若要清理，删掉这两处 + 体检接口的 `mode` 分支即可。
 */
export type JudgeMode = 'pair' | 'group';

/** 单次交给模型的条目上限。超了就分块，块间不重叠。 */
const LLM_BLOCK_SIZE = 60;

/**
 * 一个分组里最多允许几条。
 *
 * 超过就**整组丢弃**，不是截断、也**不是拆分**。这条护栏是 2026-09-21 实测加上的：
 * 首次上线后体检发现模型把**18 条毫不相关**的新闻（蒙古清洁行动、亚行羊绒贷款、
 * 学校拆除、柔道选举…）并成了一组 —— 那不是「判得不够准」，是坏答案，
 * 而且它会一次性删掉 17 条不同新闻。
 *
 * ## 「整簇丢弃」看着像缺陷，但 2026-10-07 量过之后确认它是对的
 *
 * 「全有全无」这个观察本身没错，`filterOversizedGroups` 确实会连簇里的好合并一起否掉。
 * 于是当时的判断是**改成拆分**（保留一个不超过 `max` 的子图），并已写进
 * `RECALL_FLOOR_2026-10-07.md` 的建议 ①。**同一天把真实数据摊开后这个判断被推翻了。**
 *
 * 证据：`pnpm analyze:guard-clusters`（夹具是线上逐字抓的一份快照，
 * `scripts/fixtures/guard-clusters-2026-10-07.json`）。那一天被整簇丢掉的 4 个簇是：
 *
 * | 国 | 被丢的簇 | **里面其实是几件事** | 改拆分会得到的 真合并 / 误合并 |
 * |---|---|---|---|
 * | uz | 6 条 | **1** | 3 / 1 |
 * | az | 8 条 | **4** | 4 / **10** |
 * | kg | 11 条 | **4** | 6 / 3 |
 * | tj | 11 条 | **8** | 3 / **12** |
 * | 合计 | 36 条 | —— | **16 / 26** |
 *
 * 也就是说：**4 个簇里有 3 个根本不是「同一件事被多家报道」，而是「同一批人名的不同事情」**
 * —— az 那个 8 条簇里同时躺着「制药厂投产 3 条」「接见奥地利大使 2 条」
 * 「接见马来西亚大使 2 条」「授勋 1 条」，它们连成一片只是因为标题都以
 * 「阿塞拜疆总统伊(利)尔哈姆·阿利耶夫」开头；tj 那个 11 条簇里有 8 件事，
 * 全部以「塔吉克斯坦总统埃莫马利·拉赫蒙」开头。
 *
 * ⇒ 链条本身就是**误合并**堆出来的。「拆分」不会把它们变对，只会把误合并从 0 变成 N
 *   （26 处，其中连无歧义口径都有 19 处）。唯一真正对的场景（uz：6 条同一案子）
 *   不足以支撑一个通用改动 —— 而护栏错杀它的代价（5 条真重复）小于拆分在 tj 上的代价（12 处误合并）。
 *
 * 修的对象因此不是这里，而是**相似度本身**：`similarity()` 用的是字符 bigram Jaccard，
 * 一条 15 字的固定前缀（人名 + 头衔）就能把任意两条标题的相似度抬进候选档。
 * 护栏只是症状。见 `RECALL_FLOOR_2026-10-07.md` 发现 4 与 `GUARD_SPLIT_2026-10-07.md`。
 *
 * ## 为什么 4 是安全的
 *
 * 走到 L2 之前，`dedupeStories` 已经跑过 L0/L1 的链接与原文指纹去重，
 * 所以**真正的重复簇早就不在 L2 的输入里了**；L2 只需要处理「不同链接、表述不同」的两三条。
 * 线上实测的真实重复簇最大是 4 条。真出现更大的簇，说明模型在乱合并。
 *
 * ⚠️ 唯一已知会**误伤**的形态：真正被 5 家以上媒体报道的同一件事（uz 那种）会被整簇否掉。
 * 想动它必须先让上表的「误合并」一列降下来，且 `analyze:guard-clusters` 的断言保持通过。
 */
const MAX_GROUP_SIZE = 4;

/**
 * pair 形态：候选对的标题相似度下限。低于它的对不值得问模型。
 *
 * 0.20 是**召回下限**，故意放低 —— 这一步只要「不漏」，判得准不准是模型的职责。
 *
 * ## 2026-10-05：0.35 → 0.20，这是**量出来的**，不是拍的
 *
 * 量法：`pnpm analyze:pair-recall 7`（只读，按**推送窗口**分组 —— 注意不是按日期，
 * 因为用户报的重复是「同一份草稿里两条」，那就必须落在同一个窗口里）。
 *
 * 决定性的那两个数来自 `GET /api/dedupe-check?days=1&llm=1&limit=200`（真实线上数据，
 * 5 个国家各跑一次真实 L2 判定）：
 *
 * | 国家 | 送进 L2 的条目 | `candidatePairs` 召回到 | 结果 |
 * |---|---|---|---|
 * | kz | 30 | **7** | 7 对里 6 对判「是」，合并成 4 组（0.84 / 0.76 / 0.41 / 0.41） |
 * | uz | 28 | **3** | 3 对里 1 对判「是」（0.71） |
 * | az | 39 | **1** | 唯一那对 sim 0.38，判「否」 |
 * | kg | 7 | **0** | —— |
 * | tj | 9 | **0** | —— |
 *
 * 两个结论：
 *
 * 1. **模型判得不差**：它把 0.41 以上的对都合并了，判「否」的全在 0.38–0.45 这条模糊带。
 *    所以「漏合并」的主因**不在模型**，而在**它根本没被问到几对** ——
 *    az 39 条稿子只召回到 1 对，kg/tj 一对都没有。
 * 2. 而下限 0.35 正是卡住召回的那道闸：同一批数据在 0.20 上，候选对数量大约翻一倍。
 *
 * ## 为什么「只降下限」是**错**的（差点就这么干了）
 *
 * 先量了降阈的代价（`scripts/analyze-pair-recall.ts` 第 3 节）：0.35 → 0.20 会
 * **丢掉 82 对**，而且丢掉的恰恰是**最像的那些**：
 *
 *   · `0.8400`「阿塞拜疆**与**乌兹别克斯坦国防部签署双边军事合作计划」
 *     ↔「阿塞拜疆**和**乌兹别克斯坦国防部签署双边军事合作计划」
 *   · `0.7778`「…召开**第三次**人工智能发展委员会会议」↔「…召开人工智能发展委员会**第三次**会议」
 *   · `0.7143`「阿利耶夫：…发挥**统一**作用」↔「**阿里耶夫**：…发挥**联合**作用」
 *
 * 成因在 {@link candidatePairs} 的**覆盖轮顺序**：它按**条目顺序**（= 调用方给的
 * 投资相关性降序）走，名额一满就停 —— 于是「谁被问到」由列表位置决定，
 * 而不是由「有多像」决定。降阈让更多条目有资格抢名额，反而把高分对挤了出去。
 * ⇒ 所以这一版必须**同时**改顺序（见 `candidatePairs`）和上限（见
 * {@link PAIR_MAX_CANDIDATES}），三者是一套。
 *
 * ## 为什么不设得更低
 *
 * 0.20 以下噪声爆炸：同一窗口里 `0.12–0.20` 段有 **7605 对**，模型问不完，
 * 而它们里真正同一件事的极少。0.20 是「再低就只剩噪声」的那一档。
 * 注意：因为上限是**按相似度截断**的，下限设得比「名额能装下的量」更低是**无成本**的
 * —— 多出来的对只会被截掉。所以这个数只影响「最小可信度」，不影响成本。
 */
export const PAIR_CANDIDATE_MIN_SIM = 0.2;

/**
 * 「优先档」下限：**高于它的对必须被问到**，不许被降阈新增的低分对挤掉。
 *
 * ## 为什么上限之外还需要第二根线（2026-10-05 补）
 *
 * 下限从 0.35 降到 0.20 之后，`analyze:pair-recall` 第 3 节量出一个**反直觉的副作用**：
 * 名额（{@link PAIR_MAX_CANDIDATES}）是固定的，降阈把更多低分对放进同一个池子，
 * 于是**高分对被低分对挤掉** —— 实测丢掉 28 对，最高分的是 `0.6786`
 * 「阿塞拜疆 Azeri Light 原油价格**上涨 5.5 美元**」↔「…**接近125美元**」
 * （同批 145 对抢 40 个名额，三条同源报价稿一对都没问到）。
 *
 * **「降低下限」永远不该让「原来会问的对」变得问不到** —— 这是单调性，不是偏好：
 * 0.35 这一档是**旧行为已经承诺过**的范围，降阈只能在它**之外**加，
 * 不能在它**之内**换。所以选对分两档：
 *
 *   1. **优先档**（`sim ≥ PAIR_PRIORITY_SIM`）：**独享**名额，走完整的覆盖轮 + 相似度填充；
 *   2. **补充档**（`PAIR_CANDIDATE_MIN_SIM ≤ sim < PAIR_PRIORITY_SIM`）：
 *      只吃优先档**剩下**的名额。
 *
 * 于是这条恒等式必然成立，并由 `test-dedup` 断言（双向：构造一个「单池实现会违反」的用例）：
 *
 *   `candidatePairs(items, minSim, cap) ⊇ candidatePairs(items, PAIR_PRIORITY_SIM, cap)`
 *
 * 取 **0.35 = 旧下限原值**。理由不是「0.35 有多好」，而是「它是改动前**已经承诺过**
 * 的那条线」：拿旧值当分档线，这一改动对旧行为才是**纯增量**（可证、可测），
 * 而不是拿一件新的直觉去换一件旧的直觉。
 *
 * ⚠️ 它与 `COVER_BORROW_MIN_SIM`、`DUP_SIM_FLOOR` **数值相同但不是同一个东西**：
 * 这里判的是「名额分配」的先后，借图那条判的是「能不能直接采信是同一件事」，
 * `DUP_SIM_FLOOR` 判的是「编辑说的 sameAs 锚点是否可信」。三者不许互相赋值。
 */
export const PAIR_PRIORITY_SIM = 0.35;

/**
 * pair 形态：单轮最多问多少对（控制提示词长度与延迟）。
 *
 * ## 2026-10-05：12 → 40，同样是量出来的
 *
 * 12 这个数在**线上根本用不满**：实测每国每轮召回到的是 7 / 3 / 1 / 0 / 0 对
 * （见 {@link PAIR_CANDIDATE_MIN_SIM} 的表）。所以 12 不是当前的瓶颈 ——
 * 但它**曾经**是（2026-09-24 的 Unibank 三条就是被 12 挤掉的），
 * 而下限一降，候选数就上来了，12 会立刻变成瓶颈。
 *
 * 取 48 的依据（2026-10-05 同日由 40 再上调，见下）：
 *   · 线上单轮候选对数量级在 1–10（0.35 口径），降到 0.20 后约 ×2；
 *   · 实测一周 65 轮（`analyze:pair-recall` 的「每批候选名额压力」表）里
 *     **≥0.35 的对数最大 = 44**（`kz 2026-10-02 早报`）—— 40 会截掉其中 4 对，
 *     而那一批截掉的恰好是同一簇（托卡耶夫 Digital Bridge 系列）里的真重复。
 *     取 48 = 44 加一个批次的正常波动余量，让**实测范围内所有 ≥0.35 的对都问得到**；
 *   · 提示词长度：每行 `编号 | 标题A || 标题B`（标题截断 80 字）≈ 170 字符，
 *     48 行 ≈ 8.2 KB —— 对 200K 上下文的模型不成问题；
 *   · 输出是一个 48 元素以内的短数组，仍然「解析简单、模型不容易跑偏」。
 *
 * ⚠️ **上限不该被当护栏用。** 它的职责只是「控制单次请求的长度」；
 * 「哪些对值得问」由下限 + 优先档 + 排序决定。历史上把 12 当护栏用，
 * 结果就是静默丢掉最像的那几对（用户报的重复）。所以这里同时报
 * `candidatesAboveFloor` / `candidatesAbovePriority`（下限之上 / 优先档之上的总对数）
 * —— 它们**大于**上限时说明还在截断，那时该看的是「被截掉的是不是低分对」，
 * 而不是继续往上调这个数。
 *
 * 补充档（0.20 ≤ sim < 0.35）**只吃优先档剩下的名额**，所以上限调大并不等于
 * 低分对变多：优先档先占满，低分对只在还有余量时进来（见 {@link PAIR_PRIORITY_SIM}）。
 */
export const PAIR_MAX_CANDIDATES = 48;

/*
 * ## 为什么这里**没有**「判是比例过高就熔断」这条护栏
 *
 * 2026-09-21 曾按直觉加过一条：判「是」的比例超过候选数一半就整轮不采信。
 * 随后拿线上 1000 篇真实数据算了一遍接受率，发现它必然误伤：
 *
 * 因为候选是**按相似度降序截断**的（上限见 `PAIR_MAX_CANDIDATES`），
 * 留下来的天然就是最像的那些对，真重复占多数是**正常现象**，不是模型退化。
 * 实测乌兹别克斯坦单轮 12 对里 11 对确实讲同一件事（接受率 0.92）——
 * 按 0.5 熔断会把这一整轮的**正确**判定全部丢掉。
 *
 * 结论：接受率**无法**区分「模型全答是」和「这个国家当天真的重复很多」，
 * 任何基于比例的阈值都会在某一侧失效。因此这条护栏被撤掉，
 * 改为两条**不依赖比例**的护栏：
 *   1. 「反向极性」对的确定性否决（见 `hasOppositePolarity`）——
 *      拦掉「金价下跌 vs 上涨」这类字面极像但语义相反的对，不花 token 也不给模型犯错机会；
 *   2. 「簇过大整簇丢弃」（见 `MAX_GROUP_SIZE`）——
 *      全答是会让所有条目连成一个簇，直接撞上限被丢弃。
 * 另外把接受率**报出来**（`judgeSameEventPairs` 的返回 + 体检接口），
 * 让「模型到底是不是在乱答」由人看着原始对判断，而不是交给一个拍出来的阈值。
 */

/** 摘要截断长度，防止个别超长正文把单次请求撑爆。（标题长度见 `judge-prompts.TITLE_MAX`） */
const SUMMARY_MAX = 60;

/** 只有「方向明确、且不会在无关语境里出现」的词才收。宁可少收，也不要误判。 */
const UP_WORDS = ['上涨', '上升', '增长', '增加', '提高', '提升', '上调', '增至', '攀升', '升值', '创新高', '新高'];
const DOWN_WORDS = ['下跌', '下降', '减少', '降低', '下调', '降至', '下滑', '贬值', '回落', '缩水', '创新低', '新低'];

/** 上行 / 下行 / 无方向。同一标题里同时出现两个方向 → 无方向（太含糊，不参与判定）。 */
function polarityOf(title: string): 'up' | 'down' | 'none' {
  const up = UP_WORDS.some((w) => title.includes(w));
  const down = DOWN_WORDS.some((w) => title.includes(w));
  if (up && down) return 'none';
  if (up) return 'up';
  if (down) return 'down';
  return 'none';
}

/**
 * 「反向极性」对的**确定性**否决 —— 在问模型之前就拦掉。
 *
 * 这类对是字面相似度最高的假阳性：两条标题几乎逐字一样，只有一个方向词相反。
 * 「全球市场黄金和白银价格**下跌**」与「……**上涨**」实测相似度 0.71，
 * 排在候选表最前面，几乎必然会被问给模型；而它们讲的是两条相反的消息。
 *
 * 为什么该由确定性代码判、而不是交给模型：
 *   - 方向词是**封闭集合**，不涉及语义推断，没有理由用概率模型去猜；
 *   - 假阴性（漏拦）的代价是「合并了一条利多和一条利空」= 直接删掉一条相反的事实；
 *   - 拦掉它不花 token，还能把 12 个候选名额留给真正需要判断的对。
 *
 * 判定口径：只有「一条纯上行、另一条纯下行」才算冲突。含糊的一律放行 ——
 * 两条都提到「提升」（同一件事的两种译法）不算冲突；一条不带方向词也不算
 * （如「特许权使用费收入将达92.4亿」vs「销售税收入增至415亿」，
 * 这条该判「否」，但理由是「两种税」而非方向相反，不在本函数的职责内）。
 *
 * **被否决的对必须报出来**（`judgeSameEventPairs` 的 `vetoed`），
 * 否则「否决了什么」会变成新的黑盒。
 */
export function hasOppositePolarity(a: string, b: string): boolean {
  return polarityOf(a) !== 'none' && polarityOf(b) !== 'none' && polarityOf(a) !== polarityOf(b);
}

/**
 * 生成「值得让模型看两眼」的候选对（下标对）。
 *
 * 这一步是**召回**，不是判定：门槛刻意放低（默认 0.20），
 * 宁可多问几对，也不要把真正同一件事的两条漏在候选之外。
 * 判定交给模型（precision），职责分离。
 *
 * ## ⚠️ 选对顺序：**先保覆盖，再按相似度填**（2026-09-24 改）
 *
 * 旧实现是「把所有 ≥ 下限的对按 `sim` 降序 `slice(0, maxPairs)`」——
 * 那等于**按「像的程度」配额**。而同一批里最像的那几对往往集中在**少数几篇模板稿**上
 * （体育赛果、例行通报的标题只差一两个字），于是别的条目**一对都问不到**。
 * 线上实测：kz 一批 53 行 22 对只留 12 对、az 一批 76 行 16 对也只留 12 对。
 *
 * 这个缺陷在 L2 关着时是**休眠**的（`candidatePairs` 根本不被调用），
 * 但一旦打开开关就会静默漏掉本该问到的对。典型受害者就是 2026-09-24 用户截图里
 * 那三条 Unibank（`id` 4638/4663/4673）—— 它们 sim 只有 0.375/0.387/0.400，
 * **过得了下限这条线**，却排不进「最像的 12 对」。
 * 所以这一步必须排在「打开 `SAME_EVENT_JUDGE`」**之前**。
 *
 * 两轮：
 *   1. **覆盖轮** —— 谁还没被任何已选中的对覆盖，就选**它自己最高分的那一对**。
 *      ⇒ 「每个条目至少被问过一次」。
 *   2. **填充轮** —— 还有名额就按 `sim` 降序把其余的对填满，不浪费预算。
 *
 * 结果条数不变（= min(候选对数, maxPairs)），只是**留下哪几对**变了。
 * 排序也变成本函数内部确定性：同分时按 `(a, b)` 兜底，
 * 避免「同样的输入两次给出不同候选集」让判定稳定性实验失去意义。
 *
 * ## ★ 2026-10-05：覆盖轮的**遍历顺序**改成「按该条目最高分的对，降序」
 *
 * 旧实现在覆盖轮里**按条目在数组里的位置**遍历（`i = 0..n-1`）。
 * 那在「名额够覆盖所有条目」时无所谓（选出来的集合一样），
 * 但**名额不够时它就是拿列表位置当优先级** —— 名额被前几个条目吃光，
 * 后面条目里**最像的那几对**（甚至 0.84）一对都问不到。
 *
 * 实测（`analyze:pair-recall` 第 3 节，7 天线上数据）：把下限从 0.35 降到 0.20
 * 会**丢掉 82 对**，其中最高分的是 `0.8400`「阿塞拜疆**与**乌兹别克斯坦国防部签署…」
 * ↔「阿塞拜疆**和**乌兹别克斯坦国防部签署…」。**一对 0.84 的稿子被一对 0.36 的挤掉**，
 * 这个方向是反的。
 *
 * 新顺序：**先把「最高分的对」问掉，再轮到次高分**。它同时保住两件事：
 *   · 名额不够时，被截掉的一定是**最不像**的（旧实现在这一点上完全随机，取决于列表顺序）；
 *   · 名额够时，覆盖轮仍然覆盖到每个条目（这是 2026-09-24 那次修复的目的，不能丢）。
 *
 * ⚠️ 这只是**顺序**变好，**不改变**「名额够不够」这个根本问题 ——
 * 所以 2026-10-05 同时把上限从 12 提到 40（见 {@link PAIR_MAX_CANDIDATES}）。
 * 两者是一套：只改顺序，Unibank 那种「低分对全被高分模板稿挤掉」仍会复发。
 *
 * `aboveFloor` / `abovePriority` 是**截断前的总对数**（下限之上 / 优先档之上）。
 * 它们 > `maxPairs` 时说明这一轮还在截断 —— 报出来是为了让「截断有没有发生」
 * 变成可数的数字，而不是靠调大上限猜。**它们不参与任何判定。**
 *
 * ## ★ 2026-10-05（同日第二次）：分两档选，保证「降阈只做加法」
 *
 * 光改顺序（上一段）**没能**消除「高分对给低分对让路」：`analyze:pair-recall`
 * 第 3 节复量，从 82 对降到 **28 对** —— 仍是最像的那批（最高 0.6786）。
 * 根因不是顺序，是**名额被两个档位共用**。所以按 {@link PAIR_PRIORITY_SIM} 切开：
 *
 *   · 优先档 `sim ≥ PAIR_PRIORITY_SIM` → `pickPairs(high, maxPairs)`，**独享**名额；
 *   · 补充档 `[minSim, PAIR_PRIORITY_SIM)` → `pickPairs(rest, 剩余名额)`，
 *     并**跳过优先档已覆盖的条目**（它已经有一条被问过的对了，
 *     再给它配一个低分对是拿名额换重复信息）。
 *
 * 于是 `candidatePairs(items, minSim, cap) ⊇ candidatePairs(items, PAIR_PRIORITY_SIM, cap)`
 * 成为**构造性**事实（两次调用走的是同一个 `pickPairs(high, cap)`），不是「希望如此」。
 * `test-dedup` 里有断言 + 一个「单池实现会违反它」的对照用例。
 */
export function selectCandidatePairs<T extends StoryLike>(
  items: T[],
  minSim = PAIR_CANDIDATE_MIN_SIM,
  maxPairs = PAIR_MAX_CANDIDATES,
  prioritySim = PAIR_PRIORITY_SIM,
): {
  chosen: Array<{ a: number; b: number; sim: number }>;
  aboveFloor: number;
  abovePriority: number;
} {
  // 优先档不能低于召回下限（调用方可能只想按一个下限选，如分析脚本传 0.35）。
  const priority = Math.max(minSim, prioritySim);
  const all: Array<{ a: number; b: number; sim: number }> = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const sim = similarity(items[i].title || '', items[j].title || '');
      if (sim >= minSim) all.push({ a: i, b: j, sim });
    }
  }
  if (all.length === 0) return { chosen: [], aboveFloor: 0, abovePriority: 0 };
  all.sort((x, y) => y.sim - x.sim || x.a - y.a || x.b - y.b);

  // `all` 已降序 ⇒ 优先档是它的前缀。用 filter 而不是 slice 是为了不依赖这个前提。
  const high = all.filter((p) => p.sim >= priority);
  const tier1 = pickPairs(high, items.length, maxPairs, EMPTY_ITEM_SET);

  // 补充档：优先档之外的那些（`all` 降序，filter 保序）。两档不相交 ⇒ 与 tier1 不重复。
  const rest = all.filter((p) => p.sim < priority);
  const tier2 = pickPairs(rest, items.length, maxPairs - tier1.chosen.length, tier1.covered);

  return {
    chosen: [...tier1.chosen, ...tier2.chosen],
    aboveFloor: all.length,
    abovePriority: high.length,
  };
}

/** 复用的空集合（`pickPairs` 只读它），避免每次调用都建一个。 */
const EMPTY_ITEM_SET: ReadonlySet<number> = new Set<number>();

/**
 * 覆盖轮 + 填充轮的实现 —— {@link selectCandidatePairs} 的两档**共用同一份代码**
 * （这是「降阈只做加法」能成立的原因：优先档走的就是 `minSim = 优先档下限` 时的全部逻辑）。
 *
 * `pool` 必须**已按 `sim` 降序**（调用方保证）：因此「第一次遇到某个条目」
 * 就等于「它最高分的那一对」，不需要第二次比较。
 *
 * 返回 `covered` 给调用方 —— 第二档要跳过第一档已经覆盖过的条目。
 */
function pickPairs(
  pool: Array<{ a: number; b: number; sim: number }>,
  itemCount: number,
  budget: number,
  alreadyCovered: ReadonlySet<number>,
): { chosen: Array<{ a: number; b: number; sim: number }>; covered: Set<number> } {
  const chosen: Array<{ a: number; b: number; sim: number }> = [];
  const covered = new Set<number>();
  if (budget <= 0 || pool.length === 0) return { chosen, covered };

  // 每个条目「自己最高分的那一对」——pool 已降序，第一次遇到它的那一对就是最高分
  const bestOf = new Array<number>(itemCount).fill(-1);
  for (let k = 0; k < pool.length; k++) {
    if (bestOf[pool[k].a] < 0) bestOf[pool[k].a] = k;
    if (bestOf[pool[k].b] < 0) bestOf[pool[k].b] = k;
  }

  /**
   * 覆盖轮的遍历顺序：**按各条目最高分那一对的相似度降序**，同分按条目下标兜底。
   *
   * ⚠️ 只排**有对可选的**条目（`bestOf >= 0`）—— 跟谁都不够像的条目本来
   * 也占不到名额，排进来只会让顺序多一层无意义的抖动。
   * 已被上一档覆盖过的条目同样排除（见 `alreadyCovered`）。
   */
  const coverOrder = Array.from({ length: itemCount }, (_, i) => i)
    .filter((i) => bestOf[i] >= 0 && !alreadyCovered.has(i))
    .sort((i, j) => pool[bestOf[j]].sim - pool[bestOf[i]].sim || i - j);

  const picked = new Set<number>();

  // 轮 1：覆盖（顺序见 `coverOrder`）
  for (const i of coverOrder) {
    if (chosen.length >= budget) break;
    if (covered.has(i)) continue;
    const k = bestOf[i];
    picked.add(k);
    const p = pool[k];
    chosen.push(p);
    covered.add(p.a);
    covered.add(p.b);
  }

  // 轮 2：按相似度填满剩余名额
  for (let k = 0; k < pool.length && chosen.length < budget; k++) {
    if (picked.has(k)) continue;
    picked.add(k);
    chosen.push(pool[k]);
  }

  return { chosen, covered };
}

/** {@link selectCandidatePairs} 的薄壳 —— 只要选出来的对，不要统计量。 */
export function candidatePairs<T extends StoryLike>(
  items: T[],
  minSim = PAIR_CANDIDATE_MIN_SIM,
  maxPairs = PAIR_MAX_CANDIDATES,
  prioritySim = PAIR_PRIORITY_SIM,
): Array<{ a: number; b: number; sim: number }> {
  return selectCandidatePairs(items, minSim, maxPairs, prioritySim).chosen;
}

/**
 * 判组提示词（及其版本号）已移到 `./judge-prompts` —— 那边是**版本注册表**，
 * 冻着 v1 对照组，并支持按 `pv=` 切换版本做 A/B。改动理由与逐版判据见那个文件。
 *
 * 这里只留一条**属于本文件**的实测结论（它解释的是召回层，不是提示词）：
 *
 *   · 「上合组织反垄断机构负责人会议在杜尚别举行」vs「上合组织经贸部长会议在杜尚别举行」
 *     （sim 0.38）是 2026-09-21 pair 形态上线后实测出的**唯一一类系统性误判**：
 *     **同话题、同主办方、不同活动**。group 形态那种「大面积乱合并」已经没有了，
 *     剩下的就是这一类，它同时说明了「话题相同 ≠ 同一件事」为什么必须写进判据。
 */

/**
 * pair 形态的解析。越界编号丢掉，返回去重后的编号数组；
 * 不是合法 JSON 或字段不对 → null（调用方按「一对都不合并」处理）。
 */
export function parsePairVerdict(text: string, total: number): number[] | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const raw = (parsed as { same?: unknown })?.same;
  if (!Array.isArray(raw)) return null;
  return [...new Set(
    raw.filter((v): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < total),
  )].sort((a, b) => a - b);
}

/**
 * 提示词里的判据。**这段是这套机制的核心资产**，改动前先跑
 * `/api/dedupe-check` 的固定语料，别凭感觉调。
 */
function buildJudgePrompt(rows: Array<{ i: number; title: string; summary: string; category: string }>): string {
  const lines = rows.map((r) => `${r.i} | ${r.category} | ${r.title} | ${r.summary}`);
  return [
    '下面是一个国家同一天的多条新闻（已按重要性排序，编号就是行首数字）。',
    '请找出其中「实际报道的是同一件事」的新闻，把它们归到同一组。',
    '',
    '判定为同一件事：同一次会议 / 同一次签约 / 同一份公告 / 同一条政策 /',
    '同一个项目的重复报道。即使来源不同、措辞不同、详略不同、',
    '甚至数字有出入（一处写"八车道"、另一处写"七车道"），也属于同一件事。',
    '',
    '以下情况是**两件不同的事**，绝对不要合并：',
    '  · 不同主体做同类事：「土耳其大使馆祝贺主权日」与「以色列大使馆祝贺主权日」',
    '  · 方向相反：「金价下跌」与「金价上涨」',
    '  · 不同地点/不同项目：「东哈萨克斯坦州建桥」与「阿斯塔纳建桥」',
    '  · 不同人物：「运动员甲夺金」与「运动员乙夺金」',
    '拿不准就不要合并 —— 把两条不同的新闻合成一条会丢信息，比留下重复更糟。',
    '',
    '只输出 JSON，不要任何解释文字。格式：',
    '{"groups": [[0,5],[3,7,9]]}',
    '每个分组至少 2 个编号；没有任何重复时输出 {"groups": []}。',
    '',
    '# | 分类 | 标题 | 摘要',
    ...lines,
  ].join('\n');
}

/**
 * 「大组整组丢弃」护栏的纯函数形式。
 *
 * 单独抽出来 + 导出，是为了能在 `scripts/test-dedup.ts` 里钉一条回归 ——
 * 2026-09-21 首次上线时模型把 18 条无关新闻并成一组，
 * 这类退化必须有一条不依赖模型的断言守着。
 *
 * ## 为什么是「丢弃」而不是「拆分」（2026-10-07 量过，别再来一次）
 *
 * 这个函数把整个超限簇一起否掉，所以簇里的**好合并也一起没了** —— 看上去明显该改成
 * 「拆成几个不超过 `max` 的子簇，至少把好合并留下」。这个想法我实现过、量过、然后**否掉了**：
 *
 * `pnpm analyze:guard-clusters` 在线上真实快照上算过反事实账（细节见 `MAX_GROUP_SIZE`
 * 的表格）：那一天被整簇丢掉的 4 个簇里，**3 个本身就是误合并堆出来的链**
 * （簇里分别有 4 / 4 / 8 件不同的事），改拆分会得到 **16 处真合并 / 26 处误合并**。
 *
 * ⇒ 「全有全无」不是在掩盖缺陷，它是在**拒绝采信一串已经退化的判定**。
 *   要改的是喂进来的相似度（`similarity()` 对固定前缀过敏），不是这里的取舍。
 */
export function filterOversizedGroups(
  groups: number[][],
  max: number = MAX_GROUP_SIZE,
): { kept: number[][]; rejected: number } {
  const kept = groups.filter((g) => g.length <= max);
  return { kept, rejected: groups.length - kept.length };
}

/**
 * 解析模型返回的分组。**只接受合法下标**：
 * 越界、重复、单元素分组一律丢掉，而不是抛错 ——
 * 宁可这次不合并，也不要让一次脏输出掀掉整轮推送。
 *
 * 导出是**故意的**：`scripts/test-dedup.ts` 直接拿它跑固定语料
 * （包括「模型返回 ```json 围栏」「返回越界下标」「返回单元素组」这些脏输出），
 * 这样这层解析逻辑不需要真的调模型就能回归。
 */
export function parseEventGroups(text: string, total: number): number[][] | null {
  // 模型偶尔会给 JSON 套上 ```json 围栏，或前后带一句客套话，所以取第一个 {...} 块。
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const raw = (parsed as { groups?: unknown })?.groups;
  if (!Array.isArray(raw)) return null;

  const groups: number[][] = [];
  for (const g of raw) {
    if (!Array.isArray(g)) continue;
    const nums = [...new Set(
      g.filter((v): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < total),
    )].sort((a, b) => a - b);
    if (nums.length >= 2) groups.push(nums);
  }
  return groups;
}

/**
 * 判组时给模型的额外请求体。
 *
 * **是否打开 thinking 由调用方决定，不要在这里写死**：翻译链路刻意关掉 thinking
 * （GLM-4.7 默认开、会拖慢到超时），但「判组」是推理型任务，关掉 thinking
 * 可能正是判得离谱的原因之一。2026-09-21 实测中这一点是用
 * `GET /api/dedupe-check?judge=think|nothink` 做 A/B 定的，
 * 结论写在本文件头的取舍说明里。
 */
export interface JudgeOptions {
  /** 覆盖通道默认的 extraBody（例如 `{ thinking: { type: 'enabled' } }`）。 */
  extraBody?: Record<string, unknown>;
  /** 每次调用都带上原始返回文本（只给体检接口用，用于看清模型到底吐了什么）。 */
  collectRaw?: boolean;
  /** 任务形态，默认 `pair`。见 {@link JudgeMode}。 */
  mode?: JudgeMode;
  /**
   * 注入模型调用出口。**只给测试用**，不传就走真实降级链（`askLlmJson`）。
   *
   * 为什么必须留这个口子：这套判据是**「删除类」规则** —— 判错了不报错，
   * 只是在成品里少一条新闻。而整条链路有四次「可能悄悄什么都不做」的降级
   * （没候选 / 调用失败 / 返回不合法 / 簇超限），只靠「跑一遍真实模型看看」
   * 是没法把「解析结果如何变成删除动作」钉住的。
   * 有了它，`scripts/test-dedup.ts` 才能在不联网、不配 Key 的情况下断言：
   * 判为「是」的对**确实**删对了条目、被极性拦下的对**确实**一条都没删。
   */
  ask?: AskFn;
  /**
   * 判组提示词的版本（见 `judge-prompts.JUDGE_PROMPTS`）。不传 = 用当前版本。
   *
   * 只有体检接口的 `pv=` 参数会传它 —— 那是**同一批数据上做 A/B 的唯一手段**：
   * 窗口会随日期滑动，两次运行喂给模型的候选对本来就不一样，
   * 不锁住这个变量就分不清「结论变了」是提示词改的还是今天新闻换了。
   * 生产链路（`fetch-news` / `wechat/push`）**不要传**，永远走当前版本。
   */
  promptVersion?: number;
  /**
   * **只走这一个模型通道**（`PROVIDERS[].name`）。不传 = 走完整降级链。
   *
   * 只有体检接口的 `provider=` 参数会传它 —— 和 `promptVersion` 是同一类东西：
   * 都是「把 A/B 里不打算研究的那个变量钉死」。为什么必须能钉：
   * 降级链按 `PROVIDERS` 顺序取第一个不报错的通道，而「谁不报错」取决于
   * **这一刻谁被 429 限流**。2026-09-24 实测同一次 A/B 两臂就落到了不同通道
   * （pv=1→zhipu、pv=3→zhipu-flash），于是「结论不同」多出一种解释：换了通道。
   * 详见 `translate.resolveProviderChain` 的说明。
   *
   * 生产链路（`fetch-news` / `wechat/push`）**不要传** —— 钉住通道等于放弃降级。
   */
  only?: string;
  /**
   * 覆盖召回下限 / 优先档下限 / 单轮上限（见 {@link PAIR_CANDIDATE_MIN_SIM} /
   * {@link PAIR_PRIORITY_SIM} / {@link PAIR_MAX_CANDIDATES}）。
   *
   * 存在的理由和 `promptVersion`、`only` 一样：**让「召回层」也能被单独钉住做对照**。
   * 召回与判定是两级，只钉提示词版本的话，「这次多合并了两条」照样分不清是
   * 提示词更准了还是召回放得更宽了。生产链路**不传**，永远走当前默认值。
   */
  minSim?: number;
  maxPairs?: number;
  prioritySim?: number;
}

/** 模型调用出口的签名：只吃提示词，返回文本或错误（与 `askLlmJson` 的返回同形）。 */
export type AskFn = (
  prompt: string,
) => Promise<{ ok: true; text: string; provider?: string } | { ok: false; error: string }>;

/**
 * L2 判定的采样温度，**必须是 0**。
 *
 * 理由分两层，别把两层混成一层：
 *
 * 1. **设计上就该是 0**（这一层是确定的）：判定是分类任务，下游是**删除动作**，
 *    要的不是「平均判得准」而是「同样输入给出同样的答案」。
 *    `translate.ts` 的默认温度是 0.3 —— 那是给**翻译**留用词变化用的，
 *    判定类调用沿用它就是在给结论注入随机性。
 *
 * 2. **实测确实不稳定。但「原因不是通道」这个结论是错的，已更正**（2026-09-22）：
 *
 *    ⚠️ 本条注释曾写着「**结论：通道不是原因**，不要去改 `PROVIDERS` 的顺序」。
 *    那是**错的**。用 14 天窗口重测（每国 8–12 对），在**同一批候选内**按通道分组：
 *
 *    | 口径 | 通道内标准差（均值/最大） | 通道间差（均值/最大） |
 *    |---|---|---|
 *    | 14 天、修好口径 | **0.09 / 0.44** | **5.07 / 8.22** |
 *    | 14 天、旧口径   | 0.73 / 2.08 | 4.43 / 7.58 |
 *
 *    干净口径下 uz / az 的通道内标准差**恰好是 0**（zhipu 三轮判同 7/7/7；
 *    zhipu-flash 七轮 3/3/…/3），而两条通道差 4 对；tj 差 8.22 对。
 *    ⇒ **型号差异是主因**，比通道内随机大一个量级。
 *
 *    ## 旧结论是怎么来的（这个失误值得记）
 *
 *    旧证据是「2 天窗口连跑 10 轮，两种通道对同一批对结论逐次完全一致（0 分歧）」。
 *    但 2 天窗口**每国只有 1 个候选对** —— 一条候选上「一致」几乎是必然的，
 *    那不是稳定，是**没有检验力**。而本条注释自己下一段就写着「候选对只有 1 个时
 *    『稳定』几乎是必然的」，等于用自己的话否掉了自己的证据，当时没看出来。
 *
 *    同样这批数据现在喂给 `pnpm test:dedup-stability`，脚本会直接拒绝下结论：
 *    「候选只有 1 对 —— 这个规模下『两条通道一致』几乎是必然的，**不能**据此说
 *    『通道不是原因』」。**那道护栏就是为了让这个失误不可能再犯。**
 *
 *    旧证据里真实的那一半是「通道没变、结论也变」：同一条通道内确实会翻，但幅度小
 * （标准差 0.09–0.44），与通道间差 3–8 对不是一个量级。
 *
 *    ## 两条通道错的方向相反，钉哪条都还是错的
 *
 *    逐对看（`test:dedup-stability` 的闸门段会打出来）：
 *      - `zhipu`（首选，`PROVIDERS` 排第一）**在「同主题模板标题」上过度合并**：
 *        tj 的 12 个候选全是「独立 35 周年」相关但事件各不相同（专利信息中心 /
 *        民主党在俄活动 / 驻维也纳使馆 / 驻东京使馆 / 尼亚加拉瀑布亮灯…），
 *        它 **12/12 全判「同」**。其中「驻奥地利使馆在维也纳」vs「驻日本大使馆在东京」
 *        是**没有任何含糊空间的误合并**，后果是整国新闻被折叠成 1 条。
 *      - `zhipu-flash`（降级通道）**对「同一件事的两种写法」漏合并**：az 的 9 个候选里
 *        「音乐日比赛」「航空大奖」「石油工人授勋」等 5 对明显同事件，它**一致判「否」**。
 *        ⚠️ 旧注释把这算成「**模型**的偏置」—— 但 az 那 8/10 轮都是 `zhipu-flash` 答的，
 *        是**这条通道**的偏置。归因错了，修的方向就会跟着错。
 *
 *    ## 所以：钉通道解决**可复现性**，不解决**精度**
 *
 *    旧结论「钉一条通道解决不了这个问题，别动 PROVIDERS」—— 前半句错。
 *    **钉一条通道能消除主要方差源**（差 5.07 vs 标准差 0.09，差 50 倍），
 *    对「同输入同输出」这个目标是**有效的一步**。但它**换不来精度**，
 *    因为两条通道各有各的错 —— 这后半句是对的，保留。
 *
 *    ⇒ 正确组合：**`sim ≥ 阈值` 的确定性加证负责精度，固定通道负责可复现性。**
 *    两者实测互补：加 `sim ≥ 0.5` 后两条通道留下的对**都是对的**，
 *    差别只在「留下几对」（召回）—— 闸门把通道差异从「谁留下错的对」
 *    （危险、不可逆）降级成「谁少留了对」（安全、可事后清理）。
 *
 *    ⚠️ **但闸门的代价比早先文档记的更大**：候选对的 `sim` 几乎全挤在 0.35–0.45
 *    （召回入口下限就是 0.35），所以 `sim ≥ 0.5` 事实上把 L2 快关掉了 ——
 *    14 天窗口上每国只留 1 对（tj 12→1、uz 7→1）。它「精度 100%」是
 *    **几乎不合并**换来的，不是判得准。别把这条阈值直接上线。
 *
 *    温度 0 保留：第 1 层理由成立，但它显然**不足以保证确定性**。
 *    当前结论：`SAME_EVENT_JUDGE` 保持关闭。
 *
 *    复现工具：`pnpm test:dedup-stability <响应目录>`（只读；按通道分组 + 检验力护栏）。
 */
export const JUDGE_TEMPERATURE = 0;

/**
 * 取本次要用的模型调用出口。
 *
 * 真实出口把 `timeoutMs` / `temperature` / `extraBody` 在这里就绑好，
 * 调用点只传提示词 —— 这样注入版本和真实版本在调用点看来完全一样，
 * 不会出现「测试走的路径和生产不同」。
 */
function resolveAsk(options: JudgeOptions): AskFn {
  if (options.ask) return options.ask;
  return (prompt) =>
    askLlmJson(prompt, {
      timeoutMs: 45000,
      temperature: JUDGE_TEMPERATURE,
      ...(options.extraBody ? { extraBody: options.extraBody } : {}),
      // 钉住通道（体检 / A-B 专用，见 `JudgeOptions.only`）。
      // 不传时**不要**写 `only: undefined` —— `askLlmJson` 用 `if (!only)` 判空，
      // 显式 undefined 与不传等价，但显式写会让「这次到底钉没钉」在代码里看不出区别。
      ...(options.only ? { only: options.only } : {}),
    });
}

/** `judgeSameEventPairs` / `judgeExplicitPairs` 共用的返回形状。 */
export interface PairJudgeResult {
  /**
   * 模型判为「同一件事」的对（下标是 `items` 里的下标）。
   *
   * `sim` 与 `vetoed`/`declined` 同口径 —— 三条列表形状一致，
   * 调用方（体检、固定语料对照）可以一视同仁地读，不用为「判是的」
   * 单独再算一遍相似度（那会在两处算出可能不一致的数字）。
   */
  pairs: Array<{ a: number; b: number; sim: number }>;
  /** 这次送进去问了几对（含被极性拦下的；被拦的不占 `pairs`/`declined`） */
  candidateCount: number;
  /**
   * **下限之下限之上的总对数**（`candidatePairs` 截断**之前**）。只有从 `items` 自己召回的
   * {@link judgeSameEventPairs} 才有；照单全收的 {@link judgeExplicitPairs} 恒为 undefined。
   *
   * 为什么必须报出来：它 > `candidateCount` 就说明**这一轮发生了截断** ——
   * 也就是「有一批够像的对没被问到」。2026-10-05 之前这件事是**完全不可见**的
   * （只看 `candidateCount` 分不清「只有 7 对够像」和「有 200 对、只问了 7 对」），
   * 而用户报的重复恰恰全是「够像却没被问到」。
   */
  candidatesAboveFloor?: number;
  /**
   * pair 形态：**优先档之上共有多少对**（{@link PAIR_PRIORITY_SIM} 的口径，截断前）。
   *
   * 它 > `candidateCount` ⇒ 连**优先档**都发生了截断（上限不够装），
   * 那就是「最像的那批里有没被问到的」—— 与 `candidatesAboveFloor` 的区别是：
   * 后者超标只说明「低分对没挤进来」（预期行为，不必处理），
   * 这一条超标才是**真的漏**（2026-10-05 分档后新增，用来把两者分开）。
   */
  candidatesAbovePriority?: number;
  /** 没问模型就被确定性判据（反向极性）拦下的对 */
  vetoed: Array<{ a: number; b: number; sim: number }>;
  /**
   * 问了模型、但模型判「否」的对。
   * **这是「漏合并」的唯一可见窗口** —— 只盯 `pairs`（判是的）会让人误以为
   * 剩下的都判对了，实际上真重复被否掉就永久留成两条，没人会知道。
   */
  declined: Array<{ a: number; b: number; sim: number }>;
  /** 回答这次判定的通道名（见 `DedupResult.llm.provider` 的说明） */
  provider?: string;
  /**
   * 本次**送进模型的提示词的指纹**（{@link textFingerprint}）。**只在 `collectRaw`（即
   * `debug=1`）时出现**，正常链路不带、也不花任何额外成本。
   *
   * ## 它存在的唯一理由：把「答案变了」归因
   *
   * 2026-10-08 实测：同一窗口、同通道、同参数、同 `pv`，重复跑 5 国，
   * **uz / kg / az 的判定会变**（10-07 uz 判是 9/15/9 ⇒ 6 对翻转），
   * 而三次的**题目集合完全相同**。当时归不了因，因为响应按结论分桶、
   * 既不回显提示词也不保留提问顺序。两个候选解释一直分不开：
   * ① 提示词组成/编号漂了（窗口锚点是每次请求现算的 `now-3d`，文章集合差几行就整体改号）；
   * ② 通道在 `temperature=0` 下仍不确定。
   *
   * 有了它就能一刀切开：**两次调用的指纹相同 ⇒ ①不成立，只能赖②**；
   * 指纹不同 ⇒ ①成立，且「同一窗口」这句话本身就该打折扣
   * （参见 `JUDGE_STABILITY_2026-10-08.md` 第二节·补二）。
   */
  promptHash?: string;
  error?: string;
  raw?: string[];
}

/**
 * pair 形态：只让模型对**给定的**这些对做二选一。
 *
 * 与 {@link judgeSameEventPairs} 的唯一区别是**谁决定问哪些对**：那个从 `items`
 * 自己召回（生产链路），这个照单全收（体检用的固定语料，见 `/api/judge-pairs`）。
 * 判定、极性否决、解析、下标映射**共用这一份实现** —— 本项目已经因为
 * 「同一条判据两处各写一份」栽过两次；固定语料的对照要是靠复制一份逻辑来做，
 * 测的就不是生产那条链路了，那对照也就白做。
 *
 * 无配对、调用失败、返回不合法 —— 一律返回空数组（= 不合并），并带上 `error`。
 * **默认不合并**是这条链路的既定方向。
 *
 * `vetoed` 是**没问模型**就被确定性判据拦下的对（当前只有反向极性，见
 * {@link hasOppositePolarity}）。单独报出来有两个作用：一是体检时能确认
 * 「该拦的确实拦住了」，二是它的数量能反映候选里的噪声水平 ——
 * 如果某些国家每轮都否决一堆，说明召回下限可能该往上调。
 *
 * 返回的 `pairs.length / candidateCount` 就是**接受率**。它**不参与任何自动判定**，
 * 只是报出来给人看（见文件里「为什么没有比例熔断」的说明）。
 */
export async function judgeExplicitPairs<T extends StoryLike>(
  pairs: Array<{ a: number; b: number }>,
  items: T[],
  options: JudgeOptions = {},
): Promise<PairJudgeResult> {
  // 相似度按 `candidatePairs` 的同一口径重算（同函数、同入参），
  // 这样「报出来的 sim」在两条入口下含义一致。
  const all = pairs.map((p) => ({
    a: p.a,
    b: p.b,
    sim: similarity(items[p.a]?.title || '', items[p.b]?.title || ''),
  }));

  // 反向极性对在问模型之前就拦掉（确定性判据，不让概率模型碰）
  const asked: typeof all = [];
  const vetoed: typeof all = [];
  for (const c of all) {
    if (hasOppositePolarity(items[c.a]?.title || '', items[c.b]?.title || '')) vetoed.push(c);
    else asked.push(c);
  }
  if (asked.length === 0) return { pairs: [], candidateCount: all.length, vetoed, declined: [] };

  /**
   * 提示词**只构造一次**并留一个变量 —— 指纹必须打在**真正发出去的那一份**上。
   *
   * `options.collectRaw`（= `debug=1`）是唯一的开关：正常链路**不计算、不返回**，
   * 于是这个字段对生产行为的增量是零。见 {@link PairJudgeResult.promptHash}。
   */
  const prompt = buildPairPrompt(asked, items, options.promptVersion);
  const promptHash = options.collectRaw ? textFingerprint(prompt) : undefined;
  const res = await resolveAsk(options)(prompt);
  const raw = options.collectRaw ? [res.ok ? res.text : `调用失败：${'error' in res ? res.error : '未知'}`] : undefined;
  if (!res.ok) {
    return {
      pairs: [],
      candidateCount: all.length,
      vetoed,
      declined: [],
      error: 'error' in res ? res.error : '模型调用失败（无错误详情）',
      ...(promptHash ? { promptHash } : {}),
      raw,
    };
  }

  const verdict = parsePairVerdict(res.text, asked.length);
  if (!verdict) {
    return {
      pairs: [],
      candidateCount: all.length,
      vetoed,
      declined: [],
      error: '模型返回不是合法 JSON（已按「一对都不合并」处理）',
      ...(promptHash ? { promptHash } : {}),
      raw,
    };
  }

  // 注意下标口径：verdict 是相对 `asked` 的，必须映射回原数组下标，
  // 否则被否决的对会让后面每一对的下标都错位一格 —— 那会静默删错新闻。
  const accepted = new Set(verdict);
  return {
    pairs: verdict.map((i) => ({ a: asked[i].a, b: asked[i].b, sim: asked[i].sim })),
    candidateCount: all.length,
    vetoed,
    // 被模型判「否」的对也要报出来：只看「判是的」没法发现**漏合并**，
    // 而漏合并和误合并是这套机制的两个相反方向的失效，必须都能看见。
    declined: asked.filter((_, i) => !accepted.has(i)).map((c) => ({ a: c.a, b: c.b, sim: c.sim })),
    ...(res.provider ? { provider: res.provider } : {}),
    ...(promptHash ? { promptHash } : {}),
    raw,
  };
}

/**
 * pair 形态的**生产入口**：先从 `items` 召回候选对（{@link candidatePairs}），
 * 再交给 {@link judgeExplicitPairs} 判定。
 *
 * 特意只留这一行 —— 召回策略与判定实现分开，是为了让「改成什么形态」
 * （pair / group）、「召回下限多少」、「提示词哪一版」能各自独立地验证，
 * 而不是绞在一起只能整体试。
 */
export async function judgeSameEventPairs<
  T extends StoryLike & { category?: string | null; summary?: string | null },
>(
  items: T[],
  options: JudgeOptions = {},
): Promise<PairJudgeResult> {
  const { chosen, aboveFloor, abovePriority } = selectCandidatePairs(
    items,
    options.minSim,
    options.maxPairs,
    options.prioritySim,
  );
  const res = await judgeExplicitPairs(chosen, items, options);
  // 截断前有多少对够像 —— 见 `PairJudgeResult.candidatesAboveFloor` /
  // `candidatesAbovePriority`（前者超标属预期，后者超标才是真的漏）。
  return { ...res, candidatesAboveFloor: aboveFloor, candidatesAbovePriority: abovePriority };
}

/**
 * 把模型判出的**对**并成**组**（并查集）。
 *
 * 为什么要合并而不是「每对独立丢一条」：三源报道同一次签约时，
 * 模型会答出 `(0,1)` 和 `(0,2)` 两对。若逐对独立处理，两条都会以
 * 「kept = 0」的身份成为各自的 drop —— 结果是对的（都丢掉），
 * 但体检报告里会变成两组、看起来像两个不同的重复，
 * 而且 `(1,2)` 若也被答出来会重复记账。并成 `[0,1,2]` 后语义更干净。
 *
 * **传递性是要防的风险**：`(0,1)` 与 `(1,2)` 都成立时，0 和 2 未必是同一件事
 * （1 可能同时蹭到两个话题）。所以合并结果仍要过 `filterOversizedGroups` 的
 * 大组护栏 —— 链条一旦长起来就整簇丢弃，宁可漏合并。
 *
 * ⚠️ 2026-10-07 补：**「宁可漏合并」这句被量过，确认它是划算的** —— 不是想当然。
 * 改成「拆分」的反事实是 16 处真合并 / 26 处误合并（4 个簇里 3 个本身是误合并链）。
 * 数字与成因见 `MAX_GROUP_SIZE` 与 `filterOversizedGroups` 的注释，
 * 复跑：`pnpm analyze:guard-clusters`。
 *
 * 导出是为了能离线断言（`scripts/test-dedup.ts`）：这层「合并 + 保序」的逻辑
 * 不该只能靠调模型才能验证。
 */
export function clusterPairs(pairs: Array<{ a: number; b: number }>): number[][] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as number;
    // 路径压缩，避免长链退化成 O(n)
    let cur = x;
    while (parent.get(cur) !== r) {
      const next = parent.get(cur) as number;
      parent.set(cur, r);
      cur = next;
    }
    return r;
  };

  for (const { a, b } of pairs) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb)); // 根取小下标，保证保序
  }

  const buckets = new Map<number, number[]>();
  for (const idx of parent.keys()) {
    const r = find(idx);
    const g = buckets.get(r);
    if (g) g.push(idx);
    else buckets.set(r, [idx]);
  }

  return [...buckets.values()].map((g) => g.sort((x, y) => x - y)).sort((x, y) => x[0] - y[0]);
}

/**
 * 让模型判「哪些条目在讲同一件事」。
 *
 * 返回**下标分组**（相对传入数组）。任何一步失败都返回 `{ groups: [], error }`，
 * 由调用方决定降级策略（当前策略：降级为不合并这些条目）。
 */
export async function judgeSameEventGroups<
  T extends StoryLike & { category?: string | null; summary?: string | null },
>(
  items: T[],
  options: JudgeOptions = {},
): Promise<{ groups: number[][]; provider?: string; error?: string; raw?: string[] }> {
  const groups: number[][] = [];
  const raw: string[] = [];
  let rejectedBySize = 0;
  // 本形态按块多次问模型，**最后一位答话的通道**才是「这次判定是谁做的」。
  // 不取第一位：中途换过通道时，结论是混合的，报最后一位比报第一位更贴近
  // 「最终那批组是谁给的」（与 pair 形态单次调用不同，这里天然可能不一致）。
  let provider: string | undefined;

  for (let base = 0; base < items.length; base += LLM_BLOCK_SIZE) {
    const block = items.slice(base, base + LLM_BLOCK_SIZE);
    if (block.length < 2) continue;

    const rows = block.map((a, i) => ({
      i,
      title: (a.title || '').slice(0, TITLE_MAX),
      summary: (a.summary || '').replace(/\s+/g, ' ').slice(0, SUMMARY_MAX),
      category: a.category || '-',
    }));

    const res = await resolveAsk(options)(buildJudgePrompt(rows));
    if (options.collectRaw) raw.push(res.ok ? res.text : `调用失败：${'error' in res ? res.error : '未知'}`);
    // 用 `in` 而不是靠 `!res.ok` 的可辨识联合收窄：这里跨模块取值，
    // 收窄在不同 tsconfig（strict / 非 strict）下表现不一致，
    // 而这条路径**必须**在任何配置下都能编译通过（它是推送链路上的关键分支）。
    if (!res.ok) {
      return { groups: [], error: 'error' in res ? res.error : '模型调用失败（无错误详情）' };
    }
    if (res.provider) provider = res.provider;
    const parsed = parseEventGroups(res.text, block.length);
    if (!parsed) {
      return { groups: [], error: '模型返回不是合法 JSON（已按「不合并」处理）' };
    }
    const { kept, rejected } = filterOversizedGroups(parsed);
    if (rejected > 0) {
      // 整组丢弃（见 MAX_GROUP_SIZE 的说明）。这里必须打日志：
      // 静默丢弃的话，「模型退化成乱合并」这件事就看不出来了。
      rejectedBySize += rejected;
      const oversize = parsed.filter((g) => g.length > MAX_GROUP_SIZE);
      console.warn(
        `[same-event] ${rejected} 个分组超过上限 ${MAX_GROUP_SIZE} 条，整组不采信。示例：${oversize[0]
          .slice(0, 6)
          .map((i) => rows[i]?.title)
          .join(' | ')} …`,
      );
    }
    for (const g of kept) {
      groups.push(g.map((i) => i + base));
    }
  }

  const result: { groups: number[][]; provider?: string; error?: string; raw?: string[] } = { groups };
  if (provider) result.provider = provider;
  if (options.collectRaw) result.raw = raw;
  if (rejectedBySize > 0) {
    result.error = `有 ${rejectedBySize} 个分组因超过 ${MAX_GROUP_SIZE} 条被整组丢弃（模型可能在乱合并）`;
  }
  return result;
}

// ----- 对外的统一入口 -----

export interface DedupOptions {
  /**
   * 是否允许调用模型做 L2 判定。**默认取环境变量 `SAME_EVENT_JUDGE`**：
   * 显式设成 `off` / `0` / `false` 才关闭，其余（含未设置）一律**开启**。
   *
   * ## 2026-09-28 默认值从「关」翻成「开」—— 翻转的理由
   *
   * 关的原始理由（2026-09-21）是：L2 在关闭 thinking 的免费通道上会把 18 条毫不相关的
   * 新闻并成一组，采信它就等于一次性删掉 17 条不同新闻。「误合并」丢信息且不可逆，
   * 所以当时把默认值定成「不合并」。**那条理由本身仍然成立**，翻的是两边的代价对比：
   *
   * ① **只做确定性去重 → 跨源「同一件事」根本无解**。确定性层只认
   *    「链接相同 / 原文标题指纹相同 / 逐字重复 / 中译标题几乎逐字相同」，
   *    而同一件事被 5 家媒体各写一遍时**这四条一条都不命中**。
   *    2026-09-28 用户报「哈萨克还是出现了不少重复新闻」，
   *    同一件「托卡耶夫要求国防部改革」在库里躺了 **38 篇**（kz 窗口内）；
   *    早上那份 kz 草稿 15 篇里就有多组同事件重复。
   * ② **误合并不是没有护栏的**：`hasOppositePolarity` 先拦「一涨一跌」这类反向对，
   *    候选对还要 `sim ≥ PAIR_CANDIDATE_MIN_SIM`，合并出的簇超过
   *    `MAX_GROUP_SIZE` 会**整簇丢弃**（宁可少合，不整簇删）。
   *    2026-09-28 实测 az 就有一个簇因超限被整簇丢掉 —— 护栏是活的。
   *    ⚠️ 2026-10-07 复核：这道护栏**同时也在误伤**（uz 那种「一件事被 6 家报道」会被整簇否掉），
   *    但把它改成「拆分」的代价更大（16 真 / 26 误），所以保留原样。
   *    量法与数字见 `MAX_GROUP_SIZE`；复跑 `pnpm analyze:guard-clusters`。
   * ③ **实测一轮，12 组合并逐组人工看过，全部是真的同一件事**：
   *    kz 6 组（阿斯塔纳公交 4/8 条、「希姆肯特 TikTok 博主」3 篇、
   *    「托卡耶夫任命 Myrzakhmetov 国防部长」3 篇、免去 Qosanov 职务 2 篇…）、
   *    az 4 组、uz 1 组、tj 1 组（把 `Khujand`/`胡占德`/`苦盏` 三种写法合成一条）、
   *    kg 0 组（通道没答）。**没有一例误合并**。
   *    复现：`GET /api/dedupe-check?days=2&llm=1&debug=1`。
   *
   * ⇒ 结论：**「少合」的代价（用户每天看得见重复）已经高于「误合」的风险
   * （有护栏、且可审计）**。翻转后把 `SAME_EVENT_JUDGE=off` 当**紧急刹车**保留 ——
   * 一旦观察到误合并，不用改代码、改环境变量重启即可回到旧行为。
   *
   * ⚠️ 翻转**必须同时保证「合并可审计」**：`push` 的响应里新增了
   * `summary.merges`（谁被合进了谁）与 `summary.judge`（L2 到底跑没跑成）。
   * 一个看不见的删除动作，比一个看得见的重复更难排查。
   *
   * ⚠️ **只对推送端翻**。入库端（`fetch-news/route.ts` 的闸 3）**显式写死 `useLlm: false`**，
   * 不跟这个默认值走 —— 三条理由见那里的注释（省不到翻译、花在最不能花的窗口、
   * 丢在入库端的行事后不可追）。
   */
  useLlm?: boolean;
  /** 透传给判组调用的选项（thinking 开关、原始返回收集）。 */
  judge?: JudgeOptions;
}

/**
 * `SAME_EVENT_JUDGE` 是否把 L2 打开。**默认开**，只有显式 `off` / `0` / `false` 才关。
 * 翻转的理由与护栏见 {@link DedupOptions.useLlm}。
 */
export function isLlmJudgeEnabled(): boolean {
  const v = (process.env.SAME_EVENT_JUDGE || '').trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return false;
  return true;
}

/**
 * 内容级去重的统一入口。调用方只需要传一组同国候选，拿回「保留哪些 + 每一条为什么被丢」。
 *
 * 顺序很关键：**先跑确定性去重，再让模型看剩下的**。
 * 一来省钱（同一条新闻的链接重复在第一层就没了，不用占提示词），
 * 二来更准（模型看到的列表更短、噪声更少）。
 *
 * L2 默认走 **`pair` 形态**（逐对二选一）；`mode: 'group'` 只为体检接口做对照保留，
 * 生产链路不要用 —— 它实测会按话题乱合并，见 {@link JudgeMode} 的说明。
 */
export async function dedupeStories<T extends StoryLike & { category?: string | null }>(
  items: T[],
  options: DedupOptions = {},
): Promise<DedupResult<T>> {
  const { useLlm = isLlmJudgeEnabled(), judge } = options;
  const mode: JudgeMode = judge?.mode ?? 'pair';

  const { kept: keptAfterDeterministic, drops: deterministicDrops } =
    dedupeStoriesDeterministic(items);
  /**
   * 闸 3.5：**推送端专属**的近同名（`sim ≥ TITLE_NEAR_MIN_SIM`）。
   *
   * 放在 L2 **之前**有两个作用：省 token（这些对本来就该合并，不必问模型），
   * 以及**绕开模型的漏判** —— 这一层不依赖模型（判据见 {@link TITLE_NEAR_MIN_SIM}）。
   * 实测效果：kz 一国「入参 40 条 → 模型实看 38 条」，少的那两条就是这个闸拿走的。
   *
   * ⚠️ 只在推送端：入库端丢行不可逆（见 `dedupeNearTitles`）。
   */
  const { kept: keptAfterIdentity, drops: nearTitleDrops, numericSpared } =
    dedupeNearTitles(keptAfterDeterministic);
  const drops: DedupDrop<T>[] = [...deterministicDrops, ...nearTitleDrops];
  const llm: DedupResult<T>['llm'] = { ran: false, ok: false, mode, groups: [] };

  if (numericSpared.length > 0) {
    // 这条日志是「数字护栏在干活」**唯一**的证据 —— 它拦下的是一次删除的取消，
    // 不会出现在 `drops` 里（见 `DedupResult.numericSpared`）。
    console.info(
      `[same-event] 数字护栏留下 ${numericSpared.length} 对未合并（标题数字互相矛盾）。示例：` +
        numericSpared
          .slice(0, 3)
          .map((v) => `「${v.kept.slice(0, 26)}」↔「${v.blocked.slice(0, 26)}」`)
          .join(' / '),
    );
  }

  if (!useLlm || keptAfterIdentity.length < 2) {
    return { kept: keptAfterIdentity, drops, llm, numericSpared };
  }

  llm.ran = true;
  /**
   * ★ 记下**模型实际看到的下标基准**（= `keptAfterIdentity` 的标题）。
   *
   * 必须在**这一行**取：再往下 pair / group 两个分支都只认这个数组的下标，
   * 而调用方手里的 `items` 已经被确定性闸删过行、两套下标**不再对齐**。
   * 漏掉这一行的后果是体检报告把每一对都映射到错的标题上
   * （见 {@link DedupResult.llm.indexTitles} 的说明）—— 它**不报错**，
   * 只是安静地给出一个像模像样的**假结论**。
   */
  llm.indexTitles = keptAfterIdentity.map((x) => x.title || '');

  // ---- 取回模型判定：pair 形态取「对」，group 形态取「组」 ----
  let judgedGroups: number[][] = [];
  let judgedError: string | undefined;
  let raws: string[] | undefined;
  let judgedProvider: string | undefined;

  if (mode === 'pair') {
    const res = await judgeSameEventPairs(keptAfterIdentity, judge);
    raws = res.raw;
    judgedProvider = res.provider;
    llm.pairs = res.pairs;
    llm.candidateCount = res.candidateCount;
    // 提示词指纹（只在 collectRaw 时有值）：判「这次问的是不是同一份提示词」的唯一凭据。
    if (res.promptHash) llm.promptHash = res.promptHash;
    llm.candidatesAboveFloor = res.candidatesAboveFloor;
    llm.candidatesAbovePriority = res.candidatesAbovePriority;
    llm.vetoed = res.vetoed;
    llm.declined = res.declined;
    if (res.vetoed.length > 0) {
      // 被确定性拦下的对要留痕：否则「否决了什么」就成了新的黑盒
      console.info(
        `[same-event] ${res.vetoed.length} 对因「方向相反」被拦下、未问模型。示例：` +
          res.vetoed
            .slice(0, 3)
            .map((c) => `「${keptAfterIdentity[c.a]?.title}」↔「${keptAfterIdentity[c.b]?.title}」`)
            .join(' / '),
      );
    }
    if (res.error) judgedError = res.error;
    if (res.pairs.length > 0) {
      // 对 → 组（并查集），再过一次大组护栏：链条过长说明模型在借相似度传递
      const clustered = clusterPairs(res.pairs);
      const { kept, rejected } = filterOversizedGroups(clustered);
      if (rejected > 0) {
        const oversize = clustered.find((g) => g.length > MAX_GROUP_SIZE) || [];
        console.warn(
          `[same-event] pair 合并出 ${rejected} 个超过 ${MAX_GROUP_SIZE} 条的簇，整簇不采信。示例：${oversize
            .slice(0, 6)
            .map((i) => keptAfterIdentity[i]?.title)
            .join(' | ')} …`,
        );
        judgedError = `有 ${rejected} 个簇因超过 ${MAX_GROUP_SIZE} 条被整簇丢弃（模型的判定在传递）`;
      }
      judgedGroups = kept;
    }
  } else {
    const res = await judgeSameEventGroups(keptAfterIdentity, judge);
    raws = res.raw;
    judgedProvider = res.provider;
    if (res.error) judgedError = res.error;
    judgedGroups = res.groups;
  }

  if (judge?.collectRaw && raws) llm.raw = raws;
  // 通道名无条件带出（不依赖 collectRaw）—— 「这次是谁答的」是判读稳定性的必要输入，
  // 不能只在 debug 模式下才有。
  if (judgedProvider) llm.provider = judgedProvider;
  if (judgedError) {
    llm.error = judgedError;
    console.error(`[same-event] 模型判组未完全生效：${judgedError}`);
  }
  if (judgedGroups.length === 0) {
    // 一组都没有（含调用失败、返回不合法、簇超限被丢）：确定性去重的结果照常返回
    return { kept: keptAfterIdentity, drops, llm, numericSpared };
  }

  llm.ok = true;
  llm.groups = judgedGroups;

  // 组内保序保留第一条（传入前已按重要性排好），其余记为 llm_same_event。
  //
  // ⚠️ **这里刻意不加「数字护栏」** —— 2026-10-05 试过，被回归挡住了。
  //
  // 当时想顺手用它治 az 那种「同一份统计公报的不同数字被模型判成同一件事」
  // （`sim` 0.20–0.26，实测 8 对）。但同一套判据在**这一层**会误伤真实场景：
  // `scripts/test-dedup.ts` 的端到端用例 ① 就是
  // 「乌兹别克斯坦总统启动总额 **75** 亿美元项目」↔「…**76** 亿美元投资项目」
  // —— 同一件事，两家媒体四舍五入差 1 亿。加上护栏这条就不合了，用户会看到重复。
  //
  // 分界线在于**模型已经做过语义判断**：这一层的输入是模型说「是」，
  // 用一个「数字不同就否决」的粗糙规则去推翻它，等于用算术否定语义。
  // 数字护栏该待的地方是**没有语义判断可依赖**的那一层（确定性近同名闸）。
  // az 那类要靠**提示词**解决（判组提示词里要把「同一份公报的不同指标」列为反例），
  // 不是靠事后算术否决。
  const droppedIndexes = new Set<number>();
  for (const g of judgedGroups) {
    const first = g[0];
    for (const idx of g.slice(1)) {
      droppedIndexes.add(idx);
      drops.push({
        kept: keptAfterIdentity[first],
        dropped: keptAfterIdentity[idx],
        reason: 'llm_same_event',
      });
    }
  }

  const kept = keptAfterIdentity.filter((_, i) => !droppedIndexes.has(i));
  return { kept, drops, llm, numericSpared };
}
