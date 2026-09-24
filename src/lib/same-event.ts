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
import { canonicalUrl, similarity, originalTitleKey } from './utils';
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

export type DedupReason = 'same_url' | 'same_original' | 'same_text' | 'same_title' | 'llm_same_event';

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
     * pair 形态：模型判为「同一件事」的下标对（原样保留，未做合并）。
     *
     * `sim` 与 `vetoed`/`declined` 同口径（三条列表形状一致），这样体检报告与
     * `POST /api/judge-pairs` 的输出可以一视同仁地读，不必为「判是的」单独再算一遍
     * 相似度（两处各算一次，迟早会算出不一致的数字 —— 本项目栽过同类跟头）。
     */
    pairs?: Array<{ a: number; b: number; sim: number }>;
    /** pair 形态：本轮问了多少个候选对 */
    candidateCount?: number;
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
 * 归 L2 模型判（而 L2 当前默认关闭，见 `DedupOptions.useLlm`）。
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
  if (!ta || !tb) return false;
  if (ta === '无标题' || tb === '无标题') return false;
  if (hasOppositePolarity(ta, tb)) return false;
  return similarity(ta, tb) >= TITLE_IDENTICAL_MIN_SIM;
}

/** 中译标题近似相同 ⇒ 同一条新闻（见 {@link TITLE_IDENTICAL_MIN_SIM} 的取舍说明）。 */
export function isSameTitle(a: StoryLike, b: StoryLike): boolean {
  return isSameTitleText(a.title || '', b.title || '');
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
 * 超过就**整组丢弃**，不是截断。这条护栏是 2026-09-21 实测加上的：
 * 首次上线后体检发现模型把**18 条毫不相关**的新闻（蒙古清洁行动、亚行羊绒贷款、
 * 学校拆除、柔道选举…）并成了一组 —— 那不是「判得不够准」，是坏答案，
 * 而且它会一次性删掉 17 条不同新闻。
 *
 * 为什么 4 是安全的：走到 L2 之前，`dedupeStories` 已经跑过 L0/L1 的链接与原文指纹去重，
 * 所以**真正的重复簇早就不在 L2 的输入里了**；L2 只需要处理「不同链接、表述不同」的两三条。
 * 线上实测的真实重复簇最大是 4 条。真出现更大的簇，说明模型在乱合并。
 */
const MAX_GROUP_SIZE = 4;

/**
 * pair 形态：候选对的标题相似度下限。低于它的对不值得问模型。
 *
 * 0.35 是**召回下限**，故意放低 —— 这一步只要「不漏」，判得准不准是模型的职责。
 * 用线上 1000 篇真实数据核过（`pnpm tsx scripts/peek-pairs.ts`）：
 * 下限上面的候选对里，真正同一件事的都在，包括几类最难的 ——
 * 人名音译差异（「奥伦巴耶夫」/「奥里姆巴耶夫」0.37）、
 * 数字有出入（「75亿美元」/「76亿美元」0.43）、
 * 同一政策的两种译法（「17.5%降至12%」/「17.5%下调至12%」0.75）、
 * 以及提示词里那对「团结的力量」/「团结之力」0.71。
 */
export const PAIR_CANDIDATE_MIN_SIM = 0.35;

/** pair 形态：单轮最多问多少对（控制提示词长度与延迟）。 */
export const PAIR_MAX_CANDIDATES = 12;

/*
 * ## 为什么这里**没有**「判是比例过高就熔断」这条护栏
 *
 * 2026-09-21 曾按直觉加过一条：判「是」的比例超过候选数一半就整轮不采信。
 * 随后拿线上 1000 篇真实数据算了一遍接受率，发现它必然误伤：
 *
 * 因为候选是**按相似度降序截断**的（`PAIR_MAX_CANDIDATES = 12`），
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
 * 这一步是**召回**，不是判定：门槛刻意放低（默认 0.35），
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
 * **过得了 0.35 这条线**，却排不进「最像的 12 对」。
 * 所以这一步必须排在「打开 `SAME_EVENT_JUDGE`」**之前**。
 *
 * 两轮：
 *   1. **覆盖轮** —— 按 `items` 的顺序逐条检查（调用方已按重要性排好：push 端传进来的
 *      是投资相关性降序），谁还没被任何已选中的对覆盖，就选**它自己最高分的那一对**。
 *      ⇒ 「重要的条目至少被问过一次」。
 *   2. **填充轮** —— 还有名额就按 `sim` 降序把其余的对填满，不浪费预算。
 *
 * 结果条数不变（= min(候选对数, maxPairs)），只是**留下哪几对**变了。
 * 排序也变成本函数内部确定性：同分时按 `(a, b)` 兜底，
 * 避免「同样的输入两次给出不同候选集」让判定稳定性实验失去意义。
 */
export function candidatePairs<T extends StoryLike>(
  items: T[],
  minSim = PAIR_CANDIDATE_MIN_SIM,
  maxPairs = PAIR_MAX_CANDIDATES,
): Array<{ a: number; b: number; sim: number }> {
  const all: Array<{ a: number; b: number; sim: number }> = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const sim = similarity(items[i].title || '', items[j].title || '');
      if (sim >= minSim) all.push({ a: i, b: j, sim });
    }
  }
  if (all.length === 0) return [];
  all.sort((x, y) => y.sim - x.sim || x.a - y.a || x.b - y.b);

  // 每个条目「自己最高分的那一对」——all 已降序，所以第一次遇到它的那一对就是最高分
  const bestOf = new Array<number>(items.length).fill(-1);
  for (let k = 0; k < all.length; k++) {
    if (bestOf[all[k].a] < 0) bestOf[all[k].a] = k;
    if (bestOf[all[k].b] < 0) bestOf[all[k].b] = k;
  }

  const chosen: Array<{ a: number; b: number; sim: number }> = [];
  const picked = new Set<number>();
  const covered = new Set<number>();

  // 轮 1：覆盖
  for (let i = 0; i < items.length && chosen.length < maxPairs; i++) {
    if (covered.has(i)) continue;
    const k = bestOf[i];
    if (k < 0) continue; // 这条跟谁都不够像，覆盖不了，交给别的条目占名额
    picked.add(k);
    const p = all[k];
    chosen.push(p);
    covered.add(p.a);
    covered.add(p.b);
  }

  // 轮 2：按相似度填满剩余名额
  for (let k = 0; k < all.length && chosen.length < maxPairs; k++) {
    if (picked.has(k)) continue;
    picked.add(k);
    chosen.push(all[k]);
  }

  return chosen;
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

  const res = await resolveAsk(options)(buildPairPrompt(asked, items, options.promptVersion));
  const raw = options.collectRaw ? [res.ok ? res.text : `调用失败：${'error' in res ? res.error : '未知'}`] : undefined;
  if (!res.ok) {
    return {
      pairs: [],
      candidateCount: all.length,
      vetoed,
      declined: [],
      error: 'error' in res ? res.error : '模型调用失败（无错误详情）',
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
  return judgeExplicitPairs(candidatePairs(items), items, options);
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
   * 只有显式设成 `on` / `1` / `true` 才启用，其余（含未设置）一律关闭。
   *
   * 为什么默认**关**：2026-09-21 首次上线实测，L2 在关闭 thinking 的免费通道上
   * 会把 18 条毫不相关的新闻并成一组 —— 采信它就等于一次性删掉 17 条不同新闻。
   * 「误合并」是**丢信息且不可逆**的，所以这条链路的默认值必须是「不合并」，
   * 等有把握了再显式打开。判断依据在 `GET /api/dedupe-check?llm=1&judge=think|nothink&debug=1`。
   */
  useLlm?: boolean;
  /** 透传给判组调用的选项（thinking 开关、原始返回收集）。 */
  judge?: JudgeOptions;
}

/** `SAME_EVENT_JUDGE` 是否把 L2 打开。默认关，见 `DedupOptions.useLlm` 的说明。 */
export function isLlmJudgeEnabled(): boolean {
  const v = (process.env.SAME_EVENT_JUDGE || '').trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true';
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

  const { kept: keptAfterIdentity, drops: identityDrops } = dedupeStoriesDeterministic(items);
  const drops: DedupDrop<T>[] = [...identityDrops];
  const llm: DedupResult<T>['llm'] = { ran: false, ok: false, mode, groups: [] };

  if (!useLlm || keptAfterIdentity.length < 2) {
    return { kept: keptAfterIdentity, drops, llm };
  }

  llm.ran = true;

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
    return { kept: keptAfterIdentity, drops, llm };
  }

  llm.ok = true;
  llm.groups = judgedGroups;

  // 组内保序保留第一条（传入前已按重要性排好），其余记为 llm_same_event
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
  return { kept, drops, llm };
}
