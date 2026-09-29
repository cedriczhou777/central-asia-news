/**
 * 整体总审（终审编辑）—— 2026-09-29 新增。
 *
 * ## 用户要的是什么
 *
 * 用户 2026-09-28/29 连报两类问题（阿塞拜疆同一场会谈出两条、`500 座教学楼`、
 * `电价下调1.5倍`），然后提出：
 *
 * > 你每天 5 个国家的草稿准备好之后，交由 AI 再统一审稿，新建一个单独的整体
 * > 审阅机制，真正思考和理解，由 AI 来审阅，以一个专业的新闻人身份，
 * > 真正以一个投资者来阅读的角度，审阅重复性、新闻的真实性和翻译的准确性等等，
 * > 并且要考虑排序（最重要最相关最有料的放在前面）、重要新闻要配图。
 *
 * 这一层的定位是**终审**：它跑在「选稿完成」之后、「建微信草稿」之前，
 * 所以它改的东西会直接进成品，不需要事后返工。
 *
 * ## 为什么必须是一个**独立的新阶段**（而不是把要求继续塞进翻译提示词）
 *
 * 两个理由，都在本项目已经付过代价：
 *
 * 1. **翻译提示词看不到全局。** 它一篇一篇翻，任何一条都不知道「同一件事
 *    还有另外四家在写」。跨源同事件是**集合性质**的问题，逐篇翻译在结构上无解
 *    （这正是 L2 判组和本层的价值）。
 * 2. **提示词管不住一整类错误。** 2026-09-24 的记录已经写明：`斯皮塔梅en`/`霍贾and`
 *    作为反例**逐字写在提示词里**，新产出里照样出现 ⇒ 对这类错误
 *    「提示词是无效的承载体」（见 `translate.ts` 的书写系统闸注释）。
 *    ⇒ 终审的价值不在「再说一遍要求」，而在**看得见整批、并且能动手改**。
 *
 * ## 安全模型：模型只**提议**，代码**带护栏地执行**
 *
 * 这是本项目对「删除类」判据一贯的做法（对照 `same-event.ts`）。
 * 本层比判组更危险 —— 它不但能删，还能**改写正文**。所以：
 *
 * | 模型能做什么 | 代码的护栏 | 违反时 |
 * |---|---|---|
 * | 重排序 | `order` 必须是 `0..N-1` 的**完整排列** | 整个 order 作废，保持原序 |
 * | 合并/删除 | 每个 drops 必须有 `kind` + 具体 `reason`；条数上限 `MAX_DROPS`、比例上限 `MAX_DROP_RATIO`、保留下限 `MIN_KEEP` | 逐条拒绝，只采信合规的那些 |
 * | 改 title/summary | `before` 必须与当前文本**逐字相同**；`after` 非空、长度有界、无换行/标签；**且必须通过翻译层的书写系统闸与倍数闸** | 逐条拒绝 |
 * | 指出缺图 | 只记录，不动内容 | — |
 *
 * ⚠️ **最后一条护栏值得单独讲**：终审写出的中文，必须**和翻译层受同一套闸约束**
 * （`mixedScriptTokens` / `mixedScriptTokensLatin` / `mixedScriptTokensLatinCapitalized` /
 * `descendingMultiplePhrases`）。否则会出现荒谬的循环：翻译层刚拦下 `下调1.5倍`，终审又把它写回来。
 * 代码里就是 `fixRejectReason()` 那一个函数，别把它当成可选的。
 *
 * 唯一一处**有意放宽**：半译专名在终审用的是 `…Capitalized` 变体（连首字母大写也拦），
 * 而它在翻译层只能当 reporter —— 因为两边误报代价不对称（终审误报只是丢一条改写提议）。
 * 详细论证见 `fixRejectReason` 的注释。
 *
 * ## 失败必须**无损**
 *
 * 模型超时、返回不是 JSON、解析失败、字段缺失 —— **任何**异常都走
 * 「一条都不改」并记进 `audit.error`。理由与判组一致：一个看不见的、
 * 因为「模型今天不太行」而少掉三条稿子的行为，比看得见的重复更难排查。
 * ⇒ `EDITOR_REVIEW=off` 是**不用发版的紧急刹车**（与 `SAME_EVENT_JUDGE` 同款）。
 *
 * ## 覆盖不到的部分（先写清楚，免得误判疗效）
 *
 * - **不联网核查**：无法核对「这条新闻是否属实」，只能做**内部一致性**检查
 *   （数字前后矛盾、与同批稿件冲突、明显不可能的表述）—— 这就是提示词第五件事。
 *   真正的假新闻防线仍然是入库前的源可靠性 + 翻译层。
 * - **不重译**：只能改 title/summary 的**个别表述**；若整篇翻译质量差，
 *   它只能删（`kind: 'unreliable'`）或不动，不能重写全文。
 * - **不动正文 content**：正文里有整段错误时它只能给出 `unreliable` 判断。
 *   正文改写属于另一个量级的工作（见 AGENTS.md 的待办）。
 */

import { askLlmJson } from './translate';
import { similarity, mixedScriptTokens, mixedScriptTokensLatin, mixedScriptTokensLatinCapitalized, descendingMultiplePhrases } from './utils';

/**
 * `EDITOR_REVIEW` 是否打开总审。**默认开**，只有显式 `off` / `0` / `false` 才关。
 *
 * 与 `SAME_EVENT_JUDGE` 保持同一套约定（见 `same-event.isLlmJudgeEnabled`）：
 * 「默认开」是因为**它的收益是用户每天看得见的**（重复、病句、排序），
 * 而它的风险有护栏兜着（上面那张表）+ 全程可审计（`audit`）。
 * 一旦观察到它乱删/乱改，改环境变量重启即可回到旧行为，不用发版。
 */
export function isEditorReviewEnabled(): boolean {
  const v = (process.env.EDITOR_REVIEW || '').trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return false;
  return true;
}

/**
 * 提示词版本。改了提示词就改它 —— 否则「两次结论不同」分不清是改了提示词还是换了模型。
 *
 * - `v1`（2026-09-29 上午）：四件事（合并 / 数字话不通 / 排序 / 缺图）。
 * - `v2`（2026-09-29 下午）：**两处修正**，两处都是「提示词在撒谎」：
 *   1. 第四件原写「这些会由排版环节优先补图」——**从来没有补图环节**，
 *      模型被诱导去凑一个不会兑现的清单（见 route.ts 里 `needsImage` 的注释）。
 *      改成实话：只给人工看。
 *   2. 新增第五件「明显不成立」—— 用户明确要求审**真实性**，而 v1 里
 *      四个 job 没有一个管这件事，`DROP_KINDS` 里的 `unreliable`
 *      甚至从未被定义过（模型只能自己猜）。现在给了三条**看得见**的判据，
 *      并明说「无法联网、不要试图核实是否属实」（外部核查不是这一层能做的）。
 */
export const EDITOR_PROMPT_VERSION = 'v2';

// ----- 护栏常量（导出是为了被回归脚本断言，别内联）-----

/** 单国最多删几条。删得多不是本事 —— 多半是判据跑歪了。 */
export const MAX_DROPS = 4;
/** 最多删掉这一国稿件的这**个比例**（防止「15 篇删 4 篇」变成「3 篇删 1 篇」时比例失真） */
export const MAX_DROP_RATIO = 1 / 3;
/** 无论模型怎么判，至少保留这么多条。低于它干脆一条都不删。 */
export const MIN_KEEP = 5;
/** 单国最多改几处文字（防止它把整份稿子重写一遍） */
export const MAX_FIXES = 6;
/** 标题长度上限（微信标题超过这个长度会被截断，改长了等于没改） */
export const MAX_TITLE_LEN = 64;
/** 允许的删除类型 */
export const DROP_KINDS = ['duplicate', 'not_news', 'unreliable'] as const;
export type DropKind = (typeof DROP_KINDS)[number];

/** 喂给总审的一条稿件。**刻意不含 content 全文** —— 见 `buildEditorPrompt` 的说明。 */
export interface ReviewItem {
  title: string;
  summary: string;
  category: string;
  source: string;
  time: string;
  hasImage: boolean;
  /** 投资相关性得分（排序的确定性基线，喂给模型当参考） */
  relevance: number;
  /** 正文摘要（截断），给模型判断「数字/逻辑是否自洽」用 */
  contentPeek: string;
}

/** 模型**提议**的处置。所有字段都可能越界，必须逐条过闸（见 `applyVerdict`）。 */
export interface RawVerdict {
  order?: unknown;
  drops?: unknown;
  fixes?: unknown;
  needsImage?: unknown;
  verdict?: unknown;
}

/** 过完护栏、可以执行的处置。 */
export interface ReviewDecision {
  /** 最终顺序（**原索引**）。没有合规 order 时就是 `0..N-1`。 */
  finalIndices: number[];
  /**
   * 被删掉的原索引 + 模型给的类型与理由。
   *
   * ⚠️ 必须把 `kind` / `reason` 一起带出来：总审的删除是**不可见**的
   * （删掉的稿子既不在草稿里、也不在 `skipped` 里），唯一能事后回答
   * 「这条为什么被删了」的就是这里。只返回索引数组等于把理由丢了，
   * 审计就退化成「知道删了，不知道凭什么」。
   */
  drops: Array<{ index: number; kind: string; reason: string }>;
  /** 采纳的文字修正（`index` 是**原索引**） */
  fixes: Array<{ index: number; field: 'title' | 'summary'; before: string; after: string; why: string }>;
  /** 模型指出「重要但缺图」的原索引 */
  needsImage: number[];
  /** 总评（一句话） */
  verdict: string;
}

/** 每一条被拒绝的处置都要留痕 —— 否则「模型提了但没生效」完全不可见。 */
export interface ReviewAudit {
  promptVersion: string;
  ran: boolean;
  ok: boolean;
  provider?: string;
  error?: string;
  /** 喂进去几条 */
  itemCount?: number;
  /** 模型提议删几条 / 实际删几条 */
  proposedDrops?: number;
  appliedDrops?: number;
  /** 模型提议改几处 / 实际改几处 */
  proposedFixes?: number;
  appliedFixes?: number;
  /** order 是否被采纳（不是完整排列时会被整条作废） */
  orderAccepted?: boolean;
  /** 逐条被拒的原因，如「order 不是完整排列（缺 3 个/多了 1 个）」 */
  rejections: string[];
  /** 命中的跨国重复（只报不改，见 `crossCountryOverlaps`） */
  crossCountryOverlaps?: Array<{ withCountry: string; title: string; otherTitle: string; sim: number }>;
}

// ----- 提示词 -----

/**
 * 总审提示词。
 *
 * ## 为什么把「你的身份」写得那么重
 *
 * 用户的原话是「真正思考和理解…以一个专业的新闻人身份…以一个投资者来阅读的角度」。
 * 「你是编辑」这种身份设定不是为了文采 —— 它直接决定模型怎么处理那五件事：
 *   - **编辑**会问「这条为什么值得读者花时间」⇒ 排序；
 *   - **编辑**会问「这两条是不是同一件事」⇒ 合并；
 *   - **投资者**会问「这个数字是什么单位、涨了还是跌了」⇒ 抓出 `下调1.5倍`、
 *     `500 座教学楼` 这类**逻辑不成立**的表述（而不是「翻译得像不像」）；
 *   - **投资者**会问「这条消息本身可信吗」⇒ 第五件事（内部一致性 / 明显不可信）；
 *   - **终审**会问「我改错了谁负责」⇒ 「不确定就不要改」。
 *
 * ## 为什么只喂 summary + 正文前 200 字，不喂全文
 *
 * 5 国 × 15 篇 × 300 字全文 ≈ 2.2 万字/轮，而**判断这五件事并不需要全文**：
 * 重复看标题+摘要就够，逻辑/数字问题在摘要和正文开头就暴露（`500 座教学楼`
 * 和 `下调1.5倍` 两条都是**标题级**错误）。真要全文，得为它单独设计一次调用。
 * ⚠️ 这个取舍的后果是：**正文中后段的错误抓不到** —— 已知的覆盖缺口，别当成没 bug。
 */
export const EDITOR_PROMPT = `你是一位资深中文财经媒体的**终审编辑**，负责一份面向**国际投资者**的
「中亚与高加索投资资讯日报」的最后一关。这份日报按国家分成若干篇，你审的是**其中一国的那一篇**。

你的读者是专业投资者。他们只关心一件事：**这条信息会不会影响我在这个国家的判断与决策**。
他们时间很少，而且一眼能看出「这条其实是别处已经说过的」「这个数字明显不对」。

【待审稿件】（共 {N} 篇，序号从 0 开始）
{ITEMS}

{OTHER_COUNTRIES}
【你要做的五件事，按优先级】

**一、合并「同一件事」（最重要）**
不同媒体各写一遍同一件事时，**只保留信息最完整的那一条**，其余进 drops（kind: "duplicate"）。
判定「同一件事」看**事件**而不是措辞：同一场会谈、同一次任命、同一份文件、同一起事故，
即使一家写成「讨论绿色经济转型」、另一家写成「讨论基础设施合作」，**也是同一件事**。
⚠️ 但**不要**把「同一主题下的不同事件」当重复：不同时间的两场会议、不同地点的两个项目、
同一项政策的不同阶段，都是**不同**的新闻，必须都留。
⚠️ 跨国重复**不归你管** —— 同一件事出现在两个国家的日报里是**预期行为**，不要为此建议删除。

**二、抓出「数字对、话不通」的表述**
你是投资者视角，最刺眼的是**单位与方向**：
- 下降方向的「倍」在中文里不成立（「下调 1.5 倍」按字面是负数）。原意是**除以**那个倍数。
- 量词与数字必须对得上（「500 座教学楼」可能其实是「500 个座位/名额」）。
- 金额缺币种、面积/重量缺单位、占比与增长倍数混用。
- 前后自相矛盾的数字（摘要说 90% 完工、正文说 900 万已投）。
发现这类问题时，用 fixes 给出**改正后**的整段文本（只改 title 或 summary），
并在 why 里说清错在哪。**没有把握就宁可不动** —— 你改错一个数字，比留一个别扭的表述严重得多。

**三、排序**
按「**对投资者的重要性 + 信息量**」从高到低重排，最重要、最相关、最有料的放最前面。
判断依据：政策/人事/央行 > 具体项目与金额 > 行业数据 > 社会民生；有明确金额、
明确主体、明确时间的信息 > 空泛表态。**已经给你的 relevance 分数只是一个参考基线**，
你可以推翻它 —— 你比它更懂「什么才算有料」。

**四、指出重要但缺图的条目**
用 needsImage 列出序号，只列你判断「值得读者点开看」的条目。
⚠️ 这个清单**不会自动补图** —— 本链路没有取图能力，它只是给人工编辑的提示。
所以**不要为了「让它有图」就把不重要的条目也塞进来**，那只会让这份清单失去意义。

**五、指出「明显不成立」的条目（真实性只能做内部核查）**
你**无法联网**，**不要**试图核实「这条新闻是否属实」—— 那是入库前的源头防线，不是你的活。
但下面三类在你看得见的材料里就能判断，用 drops 处理，并选对 kind：
- **与同批稿件互相矛盾**：同一件事、关键事实（数字、主体、结论）冲突，且无法判断哪个对 ⇒ kind: "unreliable"。
- **数字/量级明显不可能**：人口、金额、比例、面积与常识差出量级 ⇒ kind: "unreliable"。
- **形态根本不是新闻**：广告、招生/招商软文、纯情绪表态，通篇没有可核实的事实 ⇒ kind: "not_news"。

⚠️ 这一类必须**最保守**：只要还存在一种合理解释，就**留着**。
你删掉的那条，读者永远看不到，而且没人会回来告诉你删错了。

【硬约束，违反会被直接丢弃】
1. order 必须是 **0 到 {LAST} 之间全部序号的一个完整排列**，不重不漏。
   如果你不想改顺序，就原样输出 [{ORDER_EXAMPLE}]。
2. drops 的每一条必须有 kind（duplicate / not_news / unreliable）和**具体的** reason
   （说清「和哪一条重复」「错在哪」）。写不出具体理由就别删。
3. fixes 的 before 必须与你看到的原文**逐字完全相同**（用来确认你改的是你以为的那条）。
4. **不确定就不要动。** 你的职责是**审**，不是**写**：不许新增原文没有的事实，
   不许把一条新闻改写成另一条新闻，不许补全你没看到的数字。
   宁可留下一份平庸但准确的稿子，也不要删掉一条真实的消息。

只输出下面这个 JSON，不要任何其他文字：
{
  "order": [{ORDER_EXAMPLE}],
  "drops": [{"index": 5, "kind": "duplicate", "reason": "与第 2 条同为 9 月 27 日阿塞拜疆政府与 AIIB 的那场会谈"}],
  "fixes": [{"index": 1, "field": "title", "before": "（逐字抄这里）", "after": "（改正后）", "why": "下降方向不能用倍，原意是除以 1.5"}],
  "needsImage": [0, 3],
  "verdict": "一句话总评（20 字内）"
}`;

/** 把待审清单渲染成提示词里的文本。 */
function renderItems(items: ReviewItem[]): string {
  return items
    .map((it, i) => {
      const img = it.hasImage ? '有图' : '无图';
      const peek = it.contentPeek ? `\n   正文开头：${it.contentPeek}` : '';
      return `${i}. [${it.category}] ${it.title}\n   摘要：${it.summary}\n   来源：${it.source}｜时间：${it.time}｜${img}｜相关性分：${it.relevance}${peek}`;
    })
    .join('\n');
}

/** 把「别的国家里出现过的相近标题」渲染成上下文块。 */
function renderOtherCountries(
  overlaps: Array<{ withCountry: string; title: string; otherTitle: string; sim: number }>,
): string {
  if (overlaps.length === 0) return '';
  const lines = overlaps
    .slice(0, 10)
    .map(
      (o) =>
        `- 本篇「${o.title}」 ←→ ${o.withCountry} 篇的「${o.otherTitle}」（相似度 ${o.sim.toFixed(2)}）`,
    )
    .join('\n');
  return `【其他国家的日报里出现的相近标题】**仅供知情，不要据此删任何一条** ——
同一件事出现在两个国家的日报里是预期行为：
${lines}

`;
}

export function buildEditorPrompt(args: {
  countryName: string;
  items: ReviewItem[];
  overlaps?: Array<{ withCountry: string; title: string; otherTitle: string; sim: number }>;
}): string {
  const n = args.items.length;
  // JSON 示例里的 order 用**恒等排列**（[0,1,2,...,n-1]）。
  // ⚠️ 别改成「一个打乱的示例」：模型会照着示例的长度/形状抄，给一个短示例
  // 等于教它输出不完整的排列（而「不完整」在下游是整条作废 + 留痕一堆噪音）。
  const identityOrder = `[${Array.from({ length: n }, (_, i) => i).join(', ')}]`;
  return EDITOR_PROMPT.replace(/\{N\}/g, String(n))
    .replace(/\{LAST\}/g, String(n - 1))
    .replace(/\{ORDER_EXAMPLE\}/g, identityOrder)
    .replace('{ITEMS}', `${args.countryName}（${n} 篇）\n${renderItems(args.items)}`)
    .replace('{OTHER_COUNTRIES}', renderOtherCountries(args.overlaps ?? []));
}

// ----- 护栏 -----

/**
 * 终审写出的中文必须**通过翻译层的那几道闸**。
 *
 * 为什么必须有这一条：翻译层刚把 `下调1.5倍` 判为不合格并重试掉，
 * 如果终审又把它写回来，前面那道闸就白设了 —— 而且更糟：**这次没人再拦**。
 * 两类书写系统闸同理（终审完全可能写一个「米рзиёё夫」出来）。
 *
 * ## 半译专名这一条，终审用的是**更宽**的判据（`…Capitalized`）
 *
 * `mixedScriptTokensLatin` 只认「汉字 + **全小写**拉丁」，所以用户报的
 * `库罗诺Boyev`（大写开头）恰好漏网 —— 这正是它在翻译层只能当 reporter 的原因
 * （放宽后 500 篇真实语料误报 25 篇，而「职务中文 + 人名拉丁」是**规定写法**，见 utils.ts）。
 *
 * 终审这里**仍然用放宽版**，理由是两边失败代价**不对称**：
 *   - 翻译层误报 ⇒ `translated:false` ⇒ **静默丢稿**（重试 ×3 后整条不入库）；
 *   - 终审误报 ⇒ 只是**丢掉一条改写提议**，原稿一字不动 —— 不产生任何新缺陷。
 * 一侧是丢消息，一侧是少改一个字，所以同一个判据在两个位置可以有不同结论。
 *
 * 另：这个护栏**不会**挡住「把半译专名改对」这条正路 ——
 * `库罗诺Boyev` → `库罗诺博耶夫` 是全汉字，任何一个判据都不命中。
 *
 * 返回 null = 通过；返回字符串 = 不通过的原因（会记进 audit.rejections）。
 */
export function fixRejectReason(text: string, field: 'title' | 'summary', beforeLen: number): string | null {
  const t = (text || '').trim();
  if (t.length === 0) return 'after 是空的';
  if (t === text && text.length === 0) return 'after 是空的';
  if (/[\r\n]/.test(t)) return 'after 里有换行';
  if (/<[a-z/][^>]*>/i.test(t)) return 'after 里有 HTML 标签';
  if (mixedScriptTokens(t).length > 0) return `after 含「汉字+西里尔」混排：${mixedScriptTokens(t).slice(0, 3).join('/')}`;
  const half = mixedScriptTokensLatin(t);
  if (half.length > 0) return `after 含半译专名：${half.slice(0, 3).join('/')}`;
  const halfCap = mixedScriptTokensLatinCapitalized(t);
  if (halfCap.length > 0) return `after 含半译专名（含首字母大写）：${halfCap.slice(0, 3).join('/')}`;
  const mult = descendingMultiplePhrases(t);
  if (mult.length > 0) return `after 含中文里不成立的倍数说法：${mult.join('/')}`;
  // 长度有界：别把一句改成一段，也别改到面目全非。
  // 下限 2 是「不能缩成一个字」，上限取 before 的两倍与字段硬上限的较大值。
  if (t.length < 2) return 'after 太短（<2 字）';
  if (field === 'title') {
    if (t.length > MAX_TITLE_LEN) return `after 作为标题太长（${t.length} > ${MAX_TITLE_LEN}）`;
  } else if (t.length > Math.max(beforeLen * 2, 40)) {
    return `after 比原文长太多（${t.length} vs 原文 ${beforeLen}）`;
  }
  return null;
}

/**
 * 把模型的原始返回**过闸**成可执行的处置。
 *
 * ⚠️ 这个函数是纯函数（不调模型、不碰 IO），**必须保持纯** ——
 * 它是整个总审里唯一能被离线回归钉死的部分，`scripts/test-editor-review.ts`
 * 全靠它。任何「顺手调一次模型」的改动都会让那套回归失去意义。
 */
export function applyVerdict(
  items: ReviewItem[],
  raw: RawVerdict,
  promptVersion: string = EDITOR_PROMPT_VERSION,
): { decision: ReviewDecision; audit: ReviewAudit } {
  const n = items.length;
  const rejections: string[] = [];
  const audit: ReviewAudit = { promptVersion, ran: true, ok: true, itemCount: n, rejections };

  // ---- drops ----
  const rawDrops = Array.isArray(raw.drops) ? raw.drops : [];
  audit.proposedDrops = rawDrops.length;
  const dropSet = new Set<number>();
  const dropRecords: Array<{ index: number; kind: string; reason: string }> = [];
  const dropCap = Math.min(MAX_DROPS, Math.floor(n * MAX_DROP_RATIO));
  for (const d of rawDrops) {
    const o = (d ?? {}) as Record<string, unknown>;
    const idx = typeof o.index === 'number' ? o.index : NaN;
    if (!Number.isInteger(idx) || idx < 0 || idx >= n) {
      rejections.push(`drops 里的 index 越界：${String(o.index)}`);
      continue;
    }
    const kind = String(o.kind ?? '');
    if (!(DROP_KINDS as readonly string[]).includes(kind)) {
      rejections.push(`drops[${idx}] 的 kind 非法：${kind || '(空)'}（只认 ${DROP_KINDS.join('/')}）`);
      continue;
    }
    const reason = String(o.reason ?? '').trim();
    if (reason.length < 4) {
      rejections.push(`drops[${idx}] 没有给出具体理由（「${reason}」）`);
      continue;
    }
    if (dropSet.has(idx)) continue;
    dropSet.add(idx);
    dropRecords.push({ index: idx, kind, reason: reason.slice(0, 160) });
  }
  // 比例/条数上限 + 保留下限，**三个条件同时**满足才允许删。
  // 注意：这里不是在「取前 K 条」—— 而是整体作废。理由：模型给的理由是按它自己的
  // 优先级排的，我们无从知道该留哪几条；而按顺序取前 K 条等于**替它做了取舍**，
  // 那正是「静默多删」的来源。
  const dropOk = dropSet.size <= dropCap && n - dropSet.size >= MIN_KEEP;
  if (dropSet.size > 0 && !dropOk) {
    const why =
      dropSet.size > dropCap
        ? `想删 ${dropSet.size} 条 > 上限 ${dropCap} 条（${MAX_DROPS} 条 且 ≤${Math.round(MAX_DROP_RATIO * 100)}%）`
        : `删完只剩 ${n - dropSet.size} 条 < 保留下限 ${MIN_KEEP} 条`;
    rejections.push(`drops 整组作废：${why}`);
    dropSet.clear();
    dropRecords.length = 0;
  }
  audit.appliedDrops = dropSet.size;

  // ---- 存活的索引 ----
  const survivors: number[] = [];
  for (let i = 0; i < n; i++) if (!dropSet.has(i)) survivors.push(i);

  // ---- order ----
  const rawOrder = Array.isArray(raw.order) ? raw.order : null;
  let finalIndices: number[] = survivors;
  let orderAccepted = false;
  if (rawOrder) {
    const nums = rawOrder.filter((x): x is number => typeof x === 'number' && Number.isInteger(x));
    const asSet = new Set(nums);
    if (nums.length !== n || asSet.size !== n) {
      // 必须是**全量**（含被删的那些）的一个完整排列：模型看到的就是全部 n 条，
      // 让它按全量给序，我们再剔除被删的 —— 这样「order 少了几个」就能被当场发现。
      rejections.push(
        `order 不是 0..${n - 1} 的完整排列（给了 ${nums.length} 个、去重后 ${asSet.size} 个）⇒ 整条作废，保持原序`,
      );
    } else if (nums.some((x) => x < 0 || x >= n)) {
      rejections.push('order 里有越界序号 ⇒ 整条作废，保持原序');
    } else {
      finalIndices = nums.filter((x) => !dropSet.has(x));
      orderAccepted = true;
    }
  } else {
    rejections.push('order 缺失或不是数组 ⇒ 保持原序');
  }
  audit.orderAccepted = orderAccepted;

  // ---- fixes ----
  const rawFixes = Array.isArray(raw.fixes) ? raw.fixes : [];
  audit.proposedFixes = rawFixes.length;
  const fixes: ReviewDecision['fixes'] = [];
  const touched = new Set<string>();
  for (const f of rawFixes) {
    const o = (f ?? {}) as Record<string, unknown>;
    const idx = typeof o.index === 'number' ? o.index : NaN;
    if (!Number.isInteger(idx) || idx < 0 || idx >= n) {
      rejections.push(`fixes 里的 index 越界：${String(o.index)}`);
      continue;
    }
    const field = String(o.field ?? '');
    if (field !== 'title' && field !== 'summary') {
      rejections.push(`fixes[${idx}] 的 field 非法：${field || '(空)'}（只认 title/summary）`);
      continue;
    }
    // 同一条稿子的同一个字段只改一次
    const key = `${idx}:${field}`;
    if (touched.has(key)) {
      rejections.push(`fixes[${idx}].${field} 重复给出 ⇒ 只取第一条`);
      continue;
    }
    const current = field === 'title' ? items[idx].title : items[idx].summary;
    const before = typeof o.before === 'string' ? o.before : '';
    // ⚠️ 必须逐字匹配。这一条是防「模型对错条目」的主要手段：
    // 它抄的 before 如果对不上，说明它心里的那条和我们以为的那条不是同一条。
    if (before.trim() !== (current || '').trim()) {
      rejections.push(
        `fixes[${idx}].${field} 的 before 与原文不符（模型抄的是「${before.slice(0, 24)}」，实际是「${(current || '').slice(0, 24)}」）`,
      );
      continue;
    }
    const after = typeof o.after === 'string' ? o.after.trim() : '';
    const bad = fixRejectReason(after, field, (current || '').length);
    if (bad) {
      rejections.push(`fixes[${idx}].${field} 被拒：${bad}`);
      continue;
    }
    touched.add(key);
    fixes.push({ index: idx, field, before: current || '', after, why: String(o.why ?? '').slice(0, 120) });
    if (fixes.length >= MAX_FIXES) {
      if (rawFixes.length > MAX_FIXES) rejections.push(`fixes 超过上限 ${MAX_FIXES} 条 ⇒ 只采纳前 ${MAX_FIXES} 条`);
      break;
    }
  }
  audit.appliedFixes = fixes.length;

  // ---- needsImage ----
  const needsImage = (Array.isArray(raw.needsImage) ? raw.needsImage : [])
    .filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < n)
    .filter((x) => !dropSet.has(x))
    .slice(0, 5);

  return {
    decision: {
      finalIndices,
      drops: [...dropRecords].sort((a, b) => a.index - b.index),
      fixes,
      needsImage: [...new Set(needsImage)],
      verdict: typeof raw.verdict === 'string' ? raw.verdict.slice(0, 40) : '',
    },
    audit,
  };
}

/** 从模型返回文本里抽出 JSON（模型经常包一层 ```json）。 */
export function parseVerdict(text: string): RawVerdict | null {
  const cleaned = (text || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? (parsed as RawVerdict) : null;
  } catch {
    return null;
  }
}

/**
 * 跨国「同一件事」的**确定性**观测（只报不改）。
 *
 * 为什么不据此删：`AGENTS.md` 已经写明「跨国出现同一件事是**预期行为**，不是重复」——
 * 同一个事件在哈萨克斯塔篇和乌兹别克斯坦篇里各出现一次，是两国读者各自需要的。
 * 所以这里只做两件事：喂给模型当**知情上下文**（并要求它不要据此删），
 * 以及写进本轮审计（用户若想知道「这条是不是两个国家都推了」，有地方可查）。
 *
 * 阈值 0.4：远低于 `isSameTitle` 的 0.95 —— 这是**观测**不是判据，
 * 宁可多报几条让人看，也不要漏掉。
 *
 * ⚠️ 这个 0.4 是**量出来的**，不是拍的。真实的阿塞拜疆重复对
 * （`APA`「阿塞拜疆与亚洲基础设施投资银行就基础设施项目合作进行讨论」
 * ←→ `Trend.az`「阿塞拜疆与亚洲基础设施投资银行讨论扩大在绿色经济转型方面的合作」）
 * 实测 `similarity = 0.4595`。我最初把阈值定在 0.5，结果**这对真实锚点直接被漏掉** ——
 * 也就是说这个「观测」在最该起作用的那条上恰好是瞎的。
 *
 * 代价可控：上游 `renderOtherCountries` 已经 `slice(0, 10)` 截断，
 * 所以调低阈值最多多出几行提示词，不会灌爆。漏报的代价则是「用户问『这条是不是两国都推了』时查不到」。
 */
export function crossCountryOverlaps(
  current: ReviewItem[],
  others: Array<{ country: string; items: ReviewItem[] }>,
  minSim = 0.4,
): Array<{ withCountry: string; title: string; otherTitle: string; sim: number }> {
  const out: Array<{ withCountry: string; title: string; otherTitle: string; sim: number }> = [];
  for (const other of others) {
    for (const a of current) {
      for (const b of other.items) {
        const s = similarity(a.title, b.title);
        if (s >= minSim) {
          out.push({ withCountry: other.country, title: a.title, otherTitle: b.title, sim: s });
        }
      }
    }
  }
  return out.sort((a, b) => b.sim - a.sim);
}

/** 模型调用出口（与 `same-event.AskFn` 同形）。注入只为测试。 */
export type ReviewAskFn = (
  prompt: string,
) => Promise<{ ok: true; text: string; provider?: string } | { ok: false; error: string }>;

/**
 * 审一国的一篇草稿。**失败一律无损**（不改任何东西，只记 audit）。
 *
 * `temperature` 用 0：这是判定类任务，同一份输入两次跑出不同顺序/删法的话，
 * 这些「合并」「改字」的动作就没法信任（同 `JUDGE_TEMPERATURE` 的理由）。
 */
export async function reviewDraft(args: {
  countryName: string;
  items: ReviewItem[];
  overlaps?: Array<{ withCountry: string; title: string; otherTitle: string; sim: number }>;
  ask?: ReviewAskFn;
}): Promise<{ decision: ReviewDecision; audit: ReviewAudit }> {
  const n = args.items.length;
  const identity = (): ReviewDecision => ({
    finalIndices: Array.from({ length: n }, (_, i) => i),
    drops: [],
    fixes: [],
    needsImage: [],
    verdict: '',
  });

  if (n < 2) {
    return {
      decision: identity(),
      audit: {
        promptVersion: EDITOR_PROMPT_VERSION,
        ran: false,
        ok: true,
        itemCount: n,
        rejections: ['稿件少于 2 条，没有可审的内容'],
      },
    };
  }

  const prompt = buildEditorPrompt({
    countryName: args.countryName,
    items: args.items,
    ...(args.overlaps ? { overlaps: args.overlaps } : {}),
  });
  const ask: ReviewAskFn = args.ask ?? ((p) => askLlmJson(p, { temperature: 0 }));
  const res = await ask(prompt);

  if (!res.ok) {
    return {
      decision: identity(),
      audit: {
        promptVersion: EDITOR_PROMPT_VERSION,
        ran: true,
        ok: false,
        error: res.error,
        itemCount: n,
        rejections: ['模型调用失败 ⇒ 一条都没改'],
      },
    };
  }

  const parsed = parseVerdict(res.text);
  if (!parsed) {
    return {
      decision: identity(),
      audit: {
        promptVersion: EDITOR_PROMPT_VERSION,
        ran: true,
        ok: false,
        ...(res.provider ? { provider: res.provider } : {}),
        error: '返回不是合法 JSON',
        itemCount: n,
        rejections: ['返回不是合法 JSON ⇒ 一条都没改'],
      },
    };
  }

  const { decision, audit } = applyVerdict(args.items, parsed);
  if (res.provider) audit.provider = res.provider;
  return { decision, audit };
}
