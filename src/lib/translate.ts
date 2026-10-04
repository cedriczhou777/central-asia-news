import {
  isChineseText,
  mixedScriptTokens,
  mixedScriptTokensLatin,
  latinCyrillicTokens,
  descendingMultiplePhrases,
  stripCyrillicParentheticals,
  MIN_HAN_TITLE,
  MIN_HAN_CONTENT,
} from './utils';
import type { Category } from './data/types';
import {
  checkCurrencyCountryFit,
  checkWrongProperNouns,
  countryCodeByName,
  currencyPromptTable,
  type CurrencyMismatch,
  type WrongNounHit,
} from './proper-nouns';

/**
 * 多模型新闻翻译 + 理解：按顺序尝试多个 OpenAI 兼容的大模型接口，任一成功即返回。
 *
 * 2026-09-19 起这个调用承担的不再只是「翻译」，而是完整的「理解」：
 *   - 中文标题（具体、含人物/机构/事件）
 *   - 100 字摘要（5W1H）
 *   - 约 300 字的事实性综述（时间、人物、地点、数字、因果）
 *   - 分类（大类 + 小类，见 CATEGORY_IDS）
 *   - 面向国际投资者的相关性判断（`investorRelevant` → false 的直接不入库）
 *
 * ## 两条由产品口径决定、**不是模型自由发挥**的规则（2026-09-22 定）
 *
 * 1. **相关性口径 = 政经 / 外资 / 工商税法 / 行业项目 / 社会民生**（见提示词第 5 条）。
 *    这里改过一版，原因是旧口径把「社会民生」整类漏在正向清单之外，
 *    而负向清单里的「日常生活琐事」又很容易把它一起扫掉 ——
 *    结果物价、工资、补贴、税费这类**没有金额但直接决定消费能力与劳动力成本**的稿子
 *    在入库阶段就没了。现在正向清单显式列出这一类。
 *    ⚠️ 口径只在这一处定义。`article-format.ts` 的 `EXCLUDED_CATEGORIES`
 *    只排除 `culture` / `sports`，**没有**排除 `livelihood` —— 两处是一致的，
 *    改这里时记得核对那边。
 *
 * 2. **专有名词写法：人名（不知名的）/ 公司名 / 机构名 / 项目名保留拉丁字母；
 *    国名、州/自治共和国、城市等地名，以及【国家领导人 + 国际知名人物】的姓名用中文**
 *    （见提示词第 6 条）。
 *    理由：中亚/高加索**不知名人名与公司名**的汉字音译各家不统一、常常不准，
 *    投资者按拉丁写法反而检索得到；而**国名、地名、以及知名人物**国内早有通用译名
 *    （哈萨克斯坦、阿斯塔纳、塔什干、托卡耶夫），换成英文反而不好读。
 *
 *    ⚠️ **改过四次口径，别照前几版的记忆改回来**（时间倒序）：
 *    ① 2026-09-28（**现行**）用户看完 `卡赫拉莫恩·库罗诺Boyev` 后明确要求：
 *       「只要不是国名、州名、**总统或名人的名字**、以及国内已明显有约定俗成译名的，
 *       都统一使用英文字母」⇒ **人名拆成两类**：国家领导人 + 国际知名人物 → 中文；
 *       其余所有人名 → 拉丁。同时**明令禁止「一个名字译一半」的混合体**。
 *    ② 2026-09-23：专有名词全部拉丁（含人名），国名/州名收窄回中文。
 *    ③ 更早：只人名拉丁，机构名/公司名/地名照常中文 —— 实测**根本没被执行** ——
 *       7 天 × 5 国 1757 篇里，同一个人的名字**两种写法并存是主流**
 *       （Aliyev 中文 57 篇 / 拉丁 22 篇、Japarov 36/12、Tokayev 23/14），
 *       其中分别有 4 / 3 / 2 篇**同一篇里两种都出现**；另有 **3.2% 的篇目**含
 *       `米尔зиёё夫`／`肯еш` 这种「汉字+西里尔」挤在一个词里的怪写法。
 *       且**不是源的问题**：同一个源（AZERTAC / Kabar / Egemen）同一天两种写法都产出过。
 *
 *    ⚠️ **口径 ① 的验证方法**：`pnpm analyze:nouns` / `pnpm analyze:last-round`。
 *    注意这两条命令里的「人名期望写法」清单**必须跟着口径改** ——
 *    它们原先断言的「口径要求人名用拉丁」现在只对**不知名人名**成立。
 *    2026-09-28 实测：500 篇里 **50 篇（10%）**含「汉字·汉字」的音译人名，
 *    其中一半是国家领导人/国际名人（**按新口径是对的**），另一半是
 *    `阿伊道斯·米尔扎赫梅托夫`、`布尔哈内丁·杜兰`、`扎沃希尔·辛达罗夫` 这类
 *    **必须改成拉丁**的。⇒ 这条口径的达标率不能只看「有没有音译人名」，
 *    要按「是不是知名人物」分开数。
 *
 *    ⚠️⚠️ **这条会拉低标题的汉字占比**，而 `isChineseText` 既是「翻译是否成功」
 *    也是「能不能推送」的判据 —— 所以本条与那次判据改动是**同一个提交**里做的：
 *    判据已从「汉字**占比** ≥ 0.4」改成「汉字**个数** ≥ MIN_HAN_*」。
 *    为什么必须改：实测最贴线的一条是
 *    「乌兹别克斯坦总统 Mirziyoyev 会见 Google 副总裁 Kent Walker 讨论 YouTube 变现」，
 *    占比只有 **0.31**（旧阈值 0.4 会拒），而它**完全正确**。
 *    被判不合格的后果是重试 → 三次不过就**静默丢弃**；另一处下游 `isPushableText`
 *    更隐蔽：稿子入库了却**永远推不出去**。
 *    ⚠️ 改动上线后要复查两件事：① 标题汉字个数分布有没有贴着 MIN_HAN_TITLE 的；
 *    ② `[translate]` 日志里「含汉字+西里尔混排词」和「未通过中文校验」的出现频率。
 *
 *    ⚠️ **「半译专名」这一类错误，提示词管不住、只能上闸** —— 这是已经重复验证过的结论
 *    （用户先报 `霍贾and`、再报 `斯皮塔梅en`、2026-09-28 又报 `库罗诺Boyev`，
 *    而这三个写法**都早就逐字写在提示词的禁止清单里**）。闸门见
 *    `utils.mixedScriptTokensLatin`。**但注意它的判据只覆盖「汉字+小写拉丁」**，
 *    `库罗诺Boyev`（首字母大写）**不在覆盖范围内、且当前不能加** ——
 *    原因写在那个函数里（会误伤「总统 Tokayev」这类合法的「职务中文+人名拉丁」写法）。
 *
 * 设计要点
 * --------
 * - 所有 provider 都走 OpenAI 兼容的 /chat/completions，新增一家只需往 PROVIDERS 里加一条。
 * - 每个 provider 的 Key 与模型名都从环境变量读取，未配置 Key 的 provider 直接跳过。
 * - 模块级统计（providerCounts / errors）供 fetch-news 在每轮结束时读走、写进 lastRun ——
 *   「智谱免费档为什么没生效、全在走 DeepSeek 花钱」这类问题，以后一个 GET 就能看到答案。
 */
export interface TranslateResult {
  titleZh: string;
  summaryZh: string;
  contentZh: string;
  /** LLM 判定的分类（CATEGORY_IDS 之一；解析失败时为 null，由调用方兜底） */
  category: Category | null;
  /** 是否与国际投资者相关（false 的文章调用方应跳过，不入库） */
  investorRelevant: boolean;
  // 翻译是否真正成功（中文验证通过）
  translated: boolean;
  provider: string;
}

interface ChatProvider {
  /** 日志与 provider 字段用的名字 */
  name: string;
  /** 存放 API Key 的环境变量名；未设置则跳过该通道 */
  keyEnv: string;
  /** 覆盖模型名的环境变量名（可选） */
  modelEnv: string;
  defaultModel: string;
  endpoint: string;
  /**
   * 这条通道是不是**免费档**（单价 0 元）。
   *
   * 为什么要显式标出来：`translate-check` 的结论句原来是写死
   * 「usable[0] === 'zhipu' ? 免费 : 付费」的，一旦免费档多了一条
   * （比如智谱的第二个免费型号），只写上「zhipu」这条规则就会把
   * **免费通道误报成付费**，直接误导「这个月要花多少钱」的判断。
   * 判据放在通道定义里，就不会再和结论句脱节。
   */
  free?: boolean;
  /**
   * 合并进请求体的额外参数（跟 model / messages / temperature 平级）。
   *
   * 为什么要按 provider 配而不是全局配：各家对「未知参数」的容忍度不一样 ——
   * 往 DeepSeek 的请求里塞智谱专有的 `thinking` 字段，轻则 400、重则静默忽略，
   * 而两种失败都只会在日志里留一行，很难看出是参数串台导致的。
   */
  extraBody?: Record<string, unknown>;
}

/**
 * 降级链的通道定义。**导出是故意的**：
 * `scripts/test-translate.ts` 直接读它来打印「已配置通道 + 型号」，
 * 这样型号代号只有一处定义，不会出现「代码改了、脚本/文档还写着旧型号」的漂移。
 */
export const PROVIDERS: ChatProvider[] = [
  {
    // 智谱 GLM-4.7-Flash：免费档，200K 上下文，国内直连。
    // 注意免费档限制为「同时 1 个并发」，本项目是顺序翻译，正好不受影响。
    // 若控制台的免费型号代号有变，改 ZHIPU_MODEL 环境变量即可，不必改代码。
    name: 'zhipu',
    keyEnv: 'ZHIPU_API_KEY',
    modelEnv: 'ZHIPU_MODEL',
    defaultModel: 'glm-4.7-flash',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    free: true,
    // ⚠️ 这一行是 2026-09-19 花 3.42 元买来的教训，删之前先读完：
    //
    // GLM-4.7 系列（含 glm-4.7-flash）**默认 thinking.type = "enabled"**，
    // 这跟 GLM-4.6 的「混合 thinking（自动开关）」不一样。翻译这种任务压根不需要推理，
    // 开着 thinking 的后果是每个请求都要先生成一大段思维链：
    //   1. 单篇耗时从几秒涨到几十秒 → 很容易撞上本文件的 60s AbortSignal 超时；
    //   2. 超时 → 判为失败 → 重试 3 次 → 全部失败 → **降级到付费的 DeepSeek**。
    // 结果就是「智谱的 Key 明明配了、型号也是对的免费档，钱却全花在 DeepSeek 上」，
    // 而且从界面上完全看不出异常（只在日志里留几行超时）。
    //
    // 官方文档：https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode
    // 「GLM-4.7 系列默认开启 Thinking…… 如果您想关闭 thinking，请使用
    //   "thinking": { "type": "disabled" }」
    extraBody: { thinking: { type: 'disabled' } },
  },
  {
    // 智谱的**第二个**免费型号。同一个 Key、同一个账号、单价同样是 0 元。
    //
    // 存在的唯一理由（2026-09-20 实测）：报错 `1305 该模型当前访问量过大` 是**按模型**计的，
    // 不是按账号。也就是说 glm-4.7-flash 被挤爆的那一刻，`glm-4-flash-250414`
    // 很可能还是通的 —— 而它同为官方免费档（官方原文称它是「智谱AI首个免费大模型API」）。
    // 把它排在付费通道**之前**，就多了一次「不花钱」的机会：
    // 命中 → 省钱且内容不丢；没命中 → 只是多花几百毫秒，然后照旧降级到付费通道，
    // 属于**行为超集，不会比现在更差**（这是当初敢直接上线、不用灰度验证的理由）。
    //
    // ⚠️ 故意**不配 extraBody**：这个型号不是 thinking 系，塞 `thinking: {type:'disabled'}`
    // 有可能换来一个 400（未知参数），那就是白丢一次机会。智谱对未知字段的容忍度按型号而异，
    // 没必要赌。
    //
    // 型号代号若哪天变了，改 ZHIPU_FALLBACK_MODEL 环境变量即可，不必改代码。
    name: 'zhipu-flash',
    keyEnv: 'ZHIPU_API_KEY',
    modelEnv: 'ZHIPU_FALLBACK_MODEL',
    defaultModel: 'glm-4-flash-250414',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    free: true,
  },
  {
    // DeepSeek：按量付费，作为降级通道。
    //
    // 型号历史（别再改回去）：旧默认值 `deepseek-chat` 已被官方下线。
    // 2026-09 查 https://api-docs.deepseek.com/quick_start/pricing，
    // 当前在售型号只有 `deepseek-flash`（DeepSeek-V4.1-Flash）和 `deepseek-v4-pro`；
    // 文档里明确「仍然接受」的旧名只有 `deepseek-v4-flash`，不含 `deepseek-chat`。
    // 用错型号的表现是：通道一调用就 400，降级链等于没有 —— 而且**不会报错到用户面前**，
    // 只会在日志里留一行 `[deepseek/xxx] 请求失败 400`（现在也会进 translationStats.errors）。
    //
    // 厂商换型号代号是常态，所以代号永远以控制台「模型与价格」页为准，
    // 用 DEEPSEEK_MODEL 覆盖即可，不必改代码。
    name: 'deepseek',
    keyEnv: 'DEEPSEEK_API_KEY',
    modelEnv: 'DEEPSEEK_MODEL',
    defaultModel: 'deepseek-flash',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    free: false,
  },
];

/** 分类枚举。LLM 只能从这里选一个；DB 的 category 是 varchar(30)，存这些 id。 */
export const CATEGORY_IDS: Category[] = [
  'politics', 'economy', 'policy', 'law', 'society', 'culture', 'sports',
  'healthcare', 'energy', 'oil_gas', 'renewable_energy', 'chemicals',
  'minerals', 'infrastructure', 'housing', 'manufacturing', 'livelihood',
  'security', 'transport',
];

// —— 翻译通道用量统计（模块级，fetch-news 每轮开始 reset、结束读取） ——
interface TranslationStats {
  /** 每个 provider 成功翻译的篇数，如 { zhipu: 40, deepseek: 126 } */
  providerCounts: Record<string, number>;
  /**
   * 每个通道的错误，**按 (provider, kind) 聚合计数**（2026-10-05 改）。
   *
   * 旧版是「每个通道只留**第一条**原文」。代价很具体：用户 2026-10-04 报的
   * 「glm-4.7-flash 超时、glm-4-flash-250414 HTTP 400 contentFilter」，
   * 这两种都是**间歇性**故障 —— 一条样本既证明不了它常发，也证明不了它偶发，
   * 而「常发 / 偶发」决定的处置完全不同（常发 ⇒ 该换通道或改提示词；
   * 偶发 ⇒ 降级链本来就能兜住，不必动）。
   *
   * 现在：`count` = 次数，`kind` = 分类（见 {@link ProviderErrorKind}），
   * `error` 仍然保留**第一条**原文（对照厂商文案用）。
   * ⚠️ `provider` / `model` / `error` 三个键**不许改名**：体检接口与脚本已在读它们，
   * 改名会让「线上到底报了什么」当场查不出来（同类事故本项目已栽过两次）。
   */
  errors: Array<{
    provider: string;
    model: string;
    error: string;
    /** 分类（见 {@link ProviderErrorKind}）。老调用点不传 ⇒ undefined，聚合时归到 `-` 档 */
    kind?: ProviderErrorKind;
    /** 分类的中文名，直接给人看 */
    label?: string;
    /** 同一 (provider, kind) 出现**几次**。≥2 才说明它是常发而不是抖动 */
    count?: number;
  }>;
  /**
   * 术语闸的命中计数（2026-10-05 加）。
   *
   * **为什么必须报出来**：术语闸是硬闸，命中 ⇒ 重试 ⇒ 三次不过就**丢稿**。
   * 而「丢稿」在本项目里是不该发生的事（「宁可留重复，不要丢稿」），
   * 所以只要它开始拦，就得在**第一轮**看得见拦了多少、拦的是什么，
   * 而不是等下个月有人问「这个月吉尔吉斯的稿子怎么少了」。
   */
  termGate: {
    /** 货币与所属国不符：命中**篇次**（同一篇重试两次会记两次） */
    currency: number;
    /** 已知错译写法：命中篇次 */
    wrongNoun: number;
    /**
     * **因为术语闸而最终不入库的篇数**（所有通道 + 所有重试都没过）。
     *
     * ⚠️ 这是三个计数里唯一需要**盯着不为 0** 的：`currency`/`wrongNoun` 变多说明闸在
     * 干活（那些稿子会被重试救回来），而 `dropped` 变多说明**稿子在丢**。
     * 本项目对丢稿的态度是「宁可留重复（看得见），不要丢稿（看不见）」——
     * 它不为 0 时要么是提示词没生效，要么是闸的判据过严，两者都要立刻查。
     */
    dropped: number;
    /** 逐条样本（截断到 20 条），上线首日复核用 */
    samples: Array<{ kind: 'currency' | 'wrong-noun'; detail: string }>;
    /** 丢稿样本（截断到 10 条）—— `dropped` 不为 0 时看这里 */
    dropSamples: string[];
  };
}

const emptyStats = (): TranslationStats => ({
  providerCounts: {},
  errors: [],
  termGate: { currency: 0, wrongNoun: 0, dropped: 0, samples: [], dropSamples: [] },
});

let translationStats: TranslationStats = emptyStats();

export function resetTranslationStats() {
  translationStats = emptyStats();
}

export function getTranslationStats(): Readonly<TranslationStats> {
  return translationStats;
}

/**
 * 记一次通道错误。**按 `(provider, kind)` 聚合**：同一个通道的同一类错误只留一条，
 * 但把出现次数累加到 `count` 上（见 `TranslationStats.errors` 的说明）。
 *
 * 为什么 key 里带 `kind`：同一个通道「有时超时、有时被内容审核拦」是两种病，
 * 合成一条会让人以为只有一种，修哪一个都不对。
 */
function recordProviderError(
  provider: string,
  model: string,
  error: string,
  kind?: ProviderErrorKind,
) {
  const hit = translationStats.errors.find(
    (e) => e.provider === provider && (e.kind ?? '-') === (kind ?? '-'),
  );
  if (hit) {
    hit.count = (hit.count ?? 1) + 1;
    return;
  }
  translationStats.errors.push({
    provider,
    model,
    error,
    ...(kind ? { kind, label: ERROR_KIND_LABEL[kind] } : {}),
    count: 1,
  });
}

const CATEGORY_ENUM_TEXT = CATEGORY_IDS.map((id) => {
  const labels: Record<string, string> = {
    politics: '政治（政府人事、选举、外交、政局变动）',
    economy: '经济（宏观经济、GDP、贸易、金融、汇率、企业经营）',
    policy: '政策（法规、改革、国家战略、监管措施）',
    law: '法律（立法、司法案件、合规）',
    society: '社会（民生事件、教育、人口、事故灾难）',
    culture: '文化（文化、旅游、遗产、生活方式）',
    sports: '体育',
    healthcare: '医疗卫生',
    energy: '能源（综合能源，含电力）',
    oil_gas: '油气（石油、天然气、管道）',
    renewable_energy: '新能源（风、光、氢、储能）',
    chemicals: '化工（石化、化肥、聚合物）',
    minerals: '矿产（采矿、金属、铀、锂、稀土）',
    infrastructure: '基建（大型工程、水利、园区）',
    housing: '房地产（楼市、住宅、商业地产）',
    manufacturing: '制造业（工厂、产能、工业项目）',
    livelihood: '民生（物价、工资、补贴、公共服务）',
    security: '治安与国安（安全事件、军事、反恐）',
    transport: '交通（公路、铁路、航空、物流、口岸）',
  };
  return `${id}=${labels[id]}`;
}).join('\n');

/**
 * 提示词模板。**导出是为了能被离线回归钉住**（`scripts/test-translate-prompt.ts`）。
 *
 * 为什么必须钉：这个字符串里装着**产品口径**（哪些题材算「投资者相关」、人名怎么写法），
 * 它不在类型系统里、也没有任何编译期检查 —— 一次「顺手精简提示词」就能把它改掉，
 * 而症状要等几天后才会以「怎么没有民生新闻了」的形式出现。
 * 导出让断言可以直接检查这些句子还在不在。
 */
export const TRANSLATE_PROMPT = `你是一位面向国际投资者的中亚与南高加索新闻编辑。读者是考虑在哈萨克斯坦、乌兹别克斯坦、吉尔吉斯斯坦、塔吉克斯坦、阿塞拜疆投资的人。

**这篇稿子来自：{COUNTRY}。这是硬事实，后面第 6、8 条都建立在它上面。**

请阅读下面这篇{LANG}新闻，输出结构化结果。

原始标题：{TITLE}

原始内容：
{CONTENT}

输出要求：

1. **title（中文标题）**：**必须以「原始标题」为底本忠实翻译**，保留原标题的主语、
   动作与关键数字，再按中文标题习惯理顺语序即可。具体、信息完整，含关键人物/机构、事件、地点、金额或数字。
   禁止"某事取得进展"这类空泛表述。
   ⚠️ **不许拿正文里的另一组数字顶替原标题的数字**，也不许把原标题的主语换成正文里的别的主语。
   例：原标题是「**223** iPhone 18 в багаже: таможня остановила пассажиров в Астане」（223 部 iPhone 18 在行李中），
   就应写成「阿斯塔纳海关在行李中查获 223 部 iPhone 18」这类**同一件事**的标题
   （⚠️ 城市名照样写中文「阿斯塔纳」，见第 6 条），
   **不要**改写成「查获 10 起手机走私案，单次查获 50 部」—— 那是把正文细节当标题，
   会让同一件事在成品里看起来像几条不同新闻。
   ⚠️ **标题也必须遵守第 6 条的名词口径，而且要和正文用同一套写法。**
   第 6 条那句「同一个实体，全篇只能有一种写法」**不是只管正文的** —— 标题同样是译文，
   标题里出现的人名、机构名、项目名，写法一律照第 6 条办，并且要和你在 content 里
   对**同一个实体**的写法对齐（同一个人 / 同一家机构，两处不许一边中文一边拉丁）：
     ✗ 标题写〈同一个人的中文名〉，content 里写〈同一人的拉丁名〉
     ✗ 标题写「哈萨克斯坦国家铁路」，content 里写 KTZ —— 同一机构，两处写法不一致
     ✓ 标题与 content 用**同一种**写法（都中文，或都拉丁）
   （反过来一样：正文写拉丁，标题就必须写同一个拉丁写法。）
   标题短，最容易只顾通顺、把这条忘掉 —— 请把它当成硬约束，不是建议。
2. **summary（中文摘要）**：100 字以内，包含谁、做了什么、何时、何地、为什么。
3. **content（中文综述）**：约 300 字的**事实性综述**，必须交代：时间、人物/机构、地点、关键数字（金额、规模、占比）、事件经过与因果关系。要求：
   - 像给投资者写的简报，不像散文。禁止文学化渲染、禁止抒情、禁止空话套话。
   - **最后一句必须是具体事实。禁止在结尾追加评价、展望或投资建议** ——
     凡是「该举措有助于…」「此举将…」「有望…」「为投资者…」「投资者需关注…」「总体而言…」
     这一类句子，一律不要。读者是专业投资者，不需要你替他判断这件事好不好、值不值得投。
   - 必须完整收尾，以句号结束，严禁省略号（...、……）或"等""等等"。
   - 原文若信息量太少（如纯图片配文、生活贴士、广告软文），如实浓缩，不要编造细节。
4. **category（分类）**：从以下枚举里选**最贴切的一个**（只输出 id，不要输出中文）：
{CATEGORIES}
5. **investorRelevant（投资者相关性）**：读者是**国际投资者**。按下面两张清单判定，**命中正向清单一律 true**：

   **正向（→ true）**，共五类，缺一不可：
   - ① **政经**：经济形势与经济数据、国家政策法规、政局与人事变动、央行动向、财政与预算、反腐与营商环境。
   - ② **外资**：外商投资与招商、外资企业动向、双边/多边经贸协议、国际金融机构（世行/亚开行/亚投行/欧开行）项目。
   - ③ **工商税法**：企业经营与公司治理、并购与私有化、招投标、税收与关税、市场监管、破产与追偿。
   - ④ **行业项目**：能源、矿产、基建、交通物流、制造、农业。
   - ⑤ **社会民生**：物价与通胀、工资与就业、社保与补贴、税费与公共服务定价、住房与公用事业。
     这类稿子**往往没有金额**，但它直接决定当地消费能力与劳动力成本，是投资者要看的信号。

   **负向（→ false）**：文体娱乐（赛事、演出、影视、颁奖）、生活方式与健康贴士、风俗礼节、
   纯社会琐事（交通事故、治安案件、天气、灾害过程本身）、与营商环境无关的人情故事。

   ⚠️ **不要因为「看起来不像投资新闻」就把正向清单里的题材判 false。**
   判据是**题材归属**，不是「标题里有没有钱、有没有公司名」。
   一份物价通报、一次税制调整、一笔征地补偿，和一份百亿投资协议同样重要。

6. **专有名词写法（重要，2026-09-28 定稿口径 —— 这是第 4 版，别照前几版的记忆改回来）**：
   **人名（见下面的两类）、公司名、机构名、项目/计划名 → 写出拉丁字母**；
   **国名、州/自治共和国等地名 → 继续用中文**（国内已有通用译名，不要换成英文）。

   - **人名分两类，先判断属于哪一类**：
     ★ **第一类：→ 用中文**（国内有通行译名，读者认得出）。两类都算：
       ① **本条所属国家（{COUNTRY}）的国家元首、政府首脑、外交部长** —— 这三个职务一律写中文；
       ② **全球知名人物**（大国领导人、世界级企业家与名人），例如 Путин → 普京、
          Musk → 马斯克、Gates → 盖茨。
       判断标准是「**中国读者普遍认识这个名字**」。拿不准时**按第二类处理**（写拉丁）。
       ⚠️ **这里刻意不列中亚/高加索人名的对照**：2026-10-01 实测，提示词里当示例写出来的
       外国领导人名字会被**搬去当正文主语** —— 一篇吉尔吉斯斯坦的公路稿标题被写成
       「〈某国总统〉政府完成…」，而原文里根本没有这个人（原文只有交通部）。
       中东/中亚的人名请你自己判断，不要从本提示词里找。
     ★ **第二类：其余所有人名 → 拉丁字母**（该人名的通行英文转写），
       **不要**音译成汉字：部长、副部长、州长、市长、议员、企业家、专家、运动员、
       以及任何一个需要看原文才知道是谁的中亚/高加索人名。
       原文用西里尔字母时，按**通行英文转写**写（俄语 -ov/-ev/-in 体系；
       哈萨克语 -uly/-kyzy 或 -ov 体系，取最常见写法），不要自己按字母硬拼。
       人名不要加引号、括号或「先生/女士」之类称谓。
       ⚠️ 反例（**这几种写法都是错的**）：
         ✗ 「卡赫拉莫恩·库罗诺Boyev」  ← 一半音译、一半拉丁
         ✗ 「阿伊道斯·米尔扎赫梅托夫」  ← 全音译（这类人名没有通行中文译名 ⇒ 必须拉丁）
         ✓ Qahramon Quronboyev、Aidos Myrzakhmetov
     ⚠️ **一个姓名必须整体统一：要么整个用中文（仅限第一类），要么整个用拉丁。**
        绝不允许「姓用拉丁、名用中文」或「前半截音译、后半截留拉丁」这类混合体 ——
        这不算「专有名词写法」，算**译错**。
   - **公司名 / 机构名 / 项目计划名 → 拉丁字母**（该名称通行的拉丁写法或官方英文名）：
     哈萨克铜业 → Kazakhmys；亚洲基础设施投资银行 → AIIB；世界银行 → World Bank；
     欧洲复兴开发银行 → EBRD；伊斯兰开发银行 → IsDB；欧佩克+ → OPEC+。
     原本就以拉丁字母通行的名字原样保留（KEGOC / KTZ / AZAL / SOCAR / KazMunayGas / AzerGold /
     Kazakhtelecom / UzAuto / AiSalyk），不要改写或翻译成中文。
     ⚠️ **原文里已经写成拉丁字母的专名（项目名、计划名、活动名、组织名、品牌名），原样保留，
     一个字都不改，也不要加中文括注**（2026-10-01 用户明确要求的）：
       ✗ 「STEM4Girls（STEM女孩）」  ← 后面那半截翻译是多余的
       ✗ 「UNICEF（联合国儿童基金会）」  ← 同上
       ✓ STEM4Girls、UNICEF
     注意这与本条开头是**同一个口径**：机构名本来就该写拉丁，再加个中文括注等于自相矛盾。
   - **国名 → 中文**：哈萨克斯坦、乌兹别克斯坦、吉尔吉斯斯坦、塔吉克斯坦、阿塞拜疆、土库曼斯坦、
     俄罗斯、中国、美国、土耳其、伊朗、格鲁吉亚、亚美尼亚、白俄罗斯、乌克兰。
     ⚠️ **不要**写成 Kazakhstan / Uzbekistan / Kyrgyzstan / Azerbaijan 这类英文。
     ⚠️ **⚠️ 只许写原文里真的出现过的国名。** 原文通篇没有提到某个国家时，
     译文里就**不许出现**那个国名 —— 包括「这是一篇哈萨克斯坦的新闻」这种推断句。
     稿子属于哪个国家由上面的「这篇稿子来自：{COUNTRY}」决定，**不要自己去猜**。
   - **州 / 自治区 / 州级市等一级行政区 → 中文，且必须用国内约定俗成的译名**（不要自己音译）。
     常见对照（照这张表写）：
       哈萨克斯坦：东哈萨克斯坦州、阿拜州、杰特苏州、乌勒套州、曼格斯套州、卡拉干达州、
         科斯塔奈州、阿克莫拉州、江布尔州、克孜勒奥尔达州、图尔克斯坦州、北哈萨克斯坦州；
       乌兹别克斯坦：苏格德州、吉扎克州、纳曼干州、费尔干纳州、安集延州、布哈拉州、
         撒马尔罕州、塔什干州、卡拉卡尔帕克斯坦共和国；
       吉尔吉斯斯坦：**Чүй облусу → 楚河州**、**Жалал-Абад облусу → 贾拉拉巴德州**、
         Ош облусу → 奥什州、Нарын облусу → 纳伦州、Ысык-Көл облусу → 伊塞克湖州、
         Баткен облусу → 巴特肯州、Талас облусу → 塔拉斯州；
       塔吉克斯坦：哈特隆州、索格特州（苏格德州）、戈尔诺-巴达赫尚自治州；
       阿塞拜疆：纳希切万自治共和国、占贾-哈萨克、阿布歇隆、兰卡兰、舍基-扎卡塔雷。
     ⚠️ 两个**用户点名纠正过**的：**Чүй 是「楚河州」**（不是「丘州」，也不是「楚伊州」）；
     **Манас 是「玛纳斯」**（不是「曼纳斯」；它既是地名也是史诗名，两者都写「玛纳斯」）。
   - **城市与一般地名 → 中文**（国内已有通用译名的，继续用中文）：阿斯塔纳、阿拉木图、塔什干、
     比什凯克、杜尚别、巴库、苦盏（胡占德）、奥什、塞梅伊、阿克托别、杰兹卡兹甘、纳希切万、
     乌奇库尔干（Уч-Курган）、纳伦（Нарын，河名同写「纳伦河」）、乔尔蓬阿塔、卡拉科尔。
     ⚠️ 只有**确实没有通用中文译名**的小地名（小村镇、小河、小行政区）才写拉丁转写，
     而且必须写成一个**完整的拉丁词** —— 绝不允许出现「霍贾and」「斯皮塔梅en」「纳赫ichevan」
     这种「汉字 + 拉丁字母」拼起来的残缺写法。
   - **职务与机构通名 → 中文**：总统、副总理、部长、议会、政府、外交部、内务部、央行、州长、
     市长、法院、委员会、国家税务局、教育部。「市 / 州 / 区 / 县 / 自治共和国」这些通名也是中文。
     ⚠️ **不要**把通名翻成英文单词 —— 译文里不要出现 President / Parliament / Ministry / Company
     这类英文词。正确写法示例：〈国名〉总统 〈该领导人的中文名〉；〈国名〉国防部长 〈该部长的拉丁名〉；
     阿斯塔纳市；AIIB 提供的 60 亿美元贷款；吉尔吉斯斯坦议会。
     （注意第二个示例：**职务用中文、不知名的人名用拉丁**，两种写法在同一个短语里并存是正常的。）
   - **货币、度量衡、语言、民族、宗教 → 中文**：吨、公里、公顷、俄语、哈萨克语、
     乌兹别克族、伊斯兰教。
   - ★ **货币必须与稿子所属国家对应**（下表**由代码生成**，闸门按同一张表判，
     所以别凭记忆改这一行）：{CURRENCIES}；另加**美元**（国际结算通用，任何国家都可用）。
     ⚠️ 这是用户**反复纠正过**的一类错，线上实测 2812 篇里命中 41 篇。典型错法：
       ✗ 阿塞拜疆的工资 / 投资额 / 罚款 / 注册资本写成「坚戈」 ← 那是哈萨克斯坦的货币
       ✗ 吉尔吉斯斯坦的汇率 / 预算 / 罚款写成「坚戈」或「苏姆」
         ← 前者是哈萨克斯坦的，后者是乌兹别克斯坦的
       ✗ 更离谱的：写出「吉尔吉斯斯坦坚戈」这种**不存在的货币名**
     **原文里是什么货币就写什么货币**：原文写索姆就写「索姆」，不要因为另一个货币名
     你更眼熟就把它换上去。同一篇里不许一会儿「索姆」一会儿「苏姆」。
   - ⚠️ **称号不要与国家名混起来**：阿曼、文莱等国的国家元首称号是「**苏丹**」（Sultan），
     它本身就是**一个完整的元首称号** —— 不要写成「苏丹国王」「国王苏丹」
     （那是把称号当成了国名；阿曼在世元首的正确写法：「阿曼苏丹」）。
   - ⚠️ **同一个实体，全篇只能有一种写法**：不许一处写「哈萨克斯坦」、另一处写 Kazakhstan；
     不许一处写「塔什干」，另一处写 Tashkent；也不许同一个人一处写中文名、另一处写拉丁名。
   - ⚠️ **严禁把一个词写成「汉字 + 西里尔/拉丁」拼接**（例如 米尔зиёё夫、肯еш、霍贾and、哈萨克mys、
     **卡赫拉莫恩·库罗诺Boyev**）。这包括**首字母大写的拉丁片段** ——
     最后那个例子就是用户 2026-09-28 报上来的：中间点前面那截是 Quron 的音译、
     后面的 Boyev 是原样残留，属于「一个名字只译了一半」。
     除引用原文标题（放在《》里）外，译文里**不得出现西里尔字母**。

7. **数字、单位、年份与倍数（2026-09-29 起，2026-10-01 大幅扩充 —— 线上实例全是「数字对、话不通」）**：

   数字本身你不会翻错，错的是**数字和它修饰的东西对不上**。
   译文里的每一组数字，都必须能回答「这个数说的是什么、单位是什么」。

   ★ **(a) 「倍」只能用于增长，不能用于下降。**
     俄语/中亚语言的两种表达式最容易直译翻车：
       - снижение / уменьшение **в 1.5 раза**（直译「下降 1.5 倍」）
       - понижающий **коэффициент 1.5**（直译「1.5 倍的下调系数」）
     中文里「下降 N 倍」在逻辑上等于**负数**（1 元降 1.5 倍 = −0.5 元），是病句，读者一眼就看出不对。
     这类表达的真实含义是**除以**那个倍数，必须改写成语义等价的中文说法之一：
       - 「降至原来的 1/1.5（约低 33%）」
       - 「按 1/1.5 的系数下调」／「下调约 33%」
       - 口语化一点也行：「打了约 6.7 折」
     ⚠️ **反例（线上 2026-09-28 实际出过，标题级别）**：
       ✗ 「乌兹别克斯坦大型电力用户白天电价**下调 1.5 倍**」
       ✓ 「乌兹别克斯坦大型电力用户 09:00–17:00 电价**降至原来的 1/1.5（约低 33%）**」
     与之相对，**增长**方向可以直接用「倍」：增长 2 倍 = 是原来的 2 倍（或「翻一番」）；
     「增长到 2 倍」与「增长了 2 倍」差别很大，按原文的 **в 2 раза**（→ 是原来的 2 倍）与
     **на 100%**（→ 增长一倍）分别对待，不要混用。
     同样的道理适用于**系数 / 折算率**：写「系数 1.5」时，必须同时说清它是**乘**还是**除** ——
     只说「1.5 倍系数」，投资者无法判断电价是涨了还是跌了。

   ★ **(b) 量词必须来自「数字实际修饰的名词」，不能来自旁边的名词。**
     做法：**先判定原文那个词是不是一个「单位词 / 计量词」**，再决定中文怎么写。
     下面这些词（各国写法都算）几乎总是单位词，看到就要警觉：
       · 俄语 **мест**（座位 / 名额 / 席位）、**человек**（人）、**домохозяйств**（户）、
         **единиц**（台 / 辆 / 件）；
       · 吉尔吉斯语 **орун / орундуу**（座位 / 名额 —— 对应俄语的 мест）、**адам**（人）、**үй**（户）；
       · 哈萨克语 **орын**（座位 / 名额）、**адам**（人）；
       · 阿塞拜疆语 **yer**（座位 / 名额）、**nəfər**（人）。
     ⚠️ **反例（线上 2026-09-28 实际出过，标题级别）**：
       原标题大意：玛纳斯市 R. Azimov 第 13 中学新增 **500 мест**
       ✗ 「玛纳斯市 R. Azimov №13 中学 **500 座新教学楼**竣工 90%」 ← 500 被安到了「教学楼」头上
       ✓ 「玛纳斯市 R. Azimov 第 13 中学新增 **500 个学生名额**，工程完工 90%」
     ⚠️ **反例二（线上 2026-10-01 实际出过，标题级别）**：
       原文：「Ош шаарында … **1200 орундуу** жаңы мектептин курулушу аяктады」
             （奥什市 … 一座有 **1200 个名额**的新学校竣工）
       ✗ 「奥什市 … **1200 座新学校**竣工」 ← 1200 被安到了「学校」头上，读者以为建了 1200 所学校
       ✓ 「奥什市 … **一座可容纳 1200 名学生**的新学校竣工」
     ⚠️ 为什么这类错特别严重：「座 / 栋 / 间」这类**建筑量词会让读者以为在建楼** ——
     把一条教育新闻读成基建新闻，读者对这件事的判断完全反过来。
     同理：「安置 500 户」不要写成「安置 500 栋」；「装机 100 兆瓦」不要写成「100 座电站」。
     **拿不准时把单位写全** —— 写「1200 个名额（学生）」比写一个语义不清的「1200 座」强得多。

   ★ **(c) 数字的「单位」不许丢，也不许换。**
     金额必须带币种（坚戈 / 苏姆 / 马纳特 / 美元）；面积/重量/电量带单位；
     百分比与「倍」分清（占比 30% ≠ 增长 30%）。数字与单位之间的搭配若原文没写清，写最保守的那一种。

   ★ **(d) 符号规范化：原文的 № 写成「第」。**
     「№13」→「第 13」（「R. Azimov №13 中学」→「R. Azimov 第 13 中学」）；
     「№5 总统令」→「第 5 号总统令」。译文里不要出现 № 这个符号。
     （人名仍按第 6 条办：不是国家领导人或国际知名人物 ⇒ 写拉丁字母，例如 R. Azimov。）

   ★ **(e) 原文里没有的年份、日期，一律不许出现。**（2026-10-01 新增）
     中亚各语里大量时间表述是**相对**的：「по итогам года」（按本年度结果）、「быйыл」／「в этом году」
     （今年）、「кечээ」／「вчера」（昨天）。这类词**要么照原样译成相对表述，要么就不写时间**；
     **绝对不许自己补一个具体年份**。
     ⚠️ **反例（线上 2026-10-01 实际出过，标题级别）**：
       原文标题：「В Узбекистан 661 тыс. человек вернулись из трудовой миграции — 84% из них нашли работу」
       原文正文里只有 「По итогам года…」 与 「в 2026 году」，**通篇没有 2023**：
       ✗ 「乌兹别克斯坦 **2023 年**共有 66.1 万名劳务移民回国，其中 84% 找到工作」
       ✓ 「乌兹别克斯坦 66.1 万名劳务移民回国，其中 84% 找到工作」（不写年份）
     为什么这一条特别致命：读者会以为你在拿**三年前的旧数据**当今天的新闻，
     进而怀疑整份日报的时效性。
     判定方法：**把你要写进译文的每一个年份/日期，回到原文里逐字搜一遍**；搜不到就不写。

   ★ **(f) 数与实必须逐项对齐：量级与序数各自单独对一遍。**（2026-10-01 新增）
     - **量级**：原文的 「миң」 / 「тыс.」 / 「千」 = 千；「млн」 / 「百万」 = 百万；「млрд」 / 「十亿」 = 十亿。
       ⚠️ **反例（同一天）**：「100 миңден ашык кыз」（**10 万**名以上的女孩）
       被写成「**100 万**名女孩」—— 差一个量级，读者对这件事的规模判断完全反过来。
       注意标题和正文**都可能错**：同一条稿子里标题写对了「10 万」、正文写错了「100 万」，
       所以两边都要对一遍。
     - **序数**：「первый / второй / третий」、「биринчи / экинчи / үчүнчү」（第一 / 第二 / 第三）
       这类**阶段、批次、届次、期数**，必须逐个对回原文。
       ⚠️ **反例（同一天）**：「үчүнчү фаза」（**第三**阶段）被写成「**第二**阶段」。
     - 判定方法：**先把原文里的每一组（数字 + 单位 + 序数）单独列出来，再逐个对到译文里**，
       不许凭印象一扫而过。

**关于图片的说明 —— 这是写给你的规则，不是要写进 content 的内容：**

- 只有当**原文里确实存在**以 http:// 或 https:// 开头的图片地址时，才把那张图插进
  content 里对应的位置（用一个 img 标签，src 写那个真实地址，不要加任何属性）。
- **严禁自己编造、猜测或拼凑图片地址** —— 不要写 example.com 之类的示例域名，
  也不要用随机图服务凑一张。宁可整篇没有图，也不要写一个取不到的地址：
  排版程序会照你给的地址去下载，取不到就是一张裂图，比没图更糟。
- **不要给 img 标签加 style 属性**，也不要写任何样式，宽度和圆角由排版程序统一处理。
- 原文没有图片地址时，content 里**不要出现任何与图片有关的文字**。
- ⚠️ 严禁把上面这几行说明本身，或「图片 URL」「HTML」「style」「src」这类字样写进 content。
  content 里只写读者要读的新闻内容。

请严格按以下 JSON 格式输出（不要输出其他内容）：
{
  "title": "中文标题",
  "summary": "100 字以内中文摘要",
  "content": "约 300 字中文事实性综述",
  "category": "上面枚举之一",
  "investorRelevant": true/false
}`;

/**
 * 把源语言代码翻成提示词里的语言名。**导出是为了被离线回归钉住** ——
 * 它必须覆盖 `RSS_SOURCES` 里声明过的每一种语言；漏一种，模型就会收到
 * 「其他语言」这种等于没说的提示（原文是塔吉克文时尤其伤）。
 * `scripts/test-translate-prompt.ts` 会拿源清单逐语言核对。
 */
export function langLabel(sourceLanguage: string): string {
  if (sourceLanguage === 'en') return '英文';
  if (sourceLanguage === 'ru') return '俄文';
  // ⚠️ 2026-10-01：这里原来把 ky 与 kk 合成一个标签
  // 「中亚突厥语族语言（吉尔吉斯语/哈萨克语）」。**那个含糊本身就是事故源**：
  // 提示词里同时写着「这篇来自 {COUNTRY}」，而这个标签却说「可能是哈萨克语」——
  // 两句话互相矛盾时，模型倾向于相信语言那一句，于是吉尔吉斯斯坦的稿子里
  // 出现了哈萨克斯坦的州名。源清单是**逐源声明语言**的，不需要打这个折扣。
  if (sourceLanguage === 'ky') return '吉尔吉斯语';
  if (sourceLanguage === 'kk') return '哈萨克语';
  if (sourceLanguage === 'az') return '阿塞拜疆语';
  return '其他语言';
}

/**
 * 把模板渲染成最终提示词。
 *
 * ⚠️ `{COUNTRY}` 这个占位符**不是格式装饰，是两条判据的前置条件**
 * （第 6 条的「国名只许写原文出现过的」与「本条所属国家的元首写中文」）。
 * 它来自**源配置**（`RSS_SOURCES[].country`），原文里读不到 —— 所以必须由这里注入。
 * 缺了它，模型只能靠「这篇像哪国」去猜，而 2026-10-01 的实测就是猜错（见 v4 说明）。
 *
 * ⚠️ 导出只为**离线回归**用（`scripts/test-translate-prompt.ts` 要断言「渲染之后
 * 不留任何 `{...}` 占位符」）。这条断言只能靠渲染结果，靠读模板是测不出来的。
 */
export function buildPrompt(
  title: string,
  content: string,
  sourceLanguage: string,
  countryName: string,
): string {
  return TRANSLATE_PROMPT
    .replace(/\{COUNTRY\}/g, countryName)
    .replace('{LANG}', langLabel(sourceLanguage))
    .replace('{TITLE}', title)
    .replace('{CATEGORIES}', CATEGORY_ENUM_TEXT)
    // ⚠️ **货币表是生成式注入的，不是手写在模板里的** —— 手写的表迟早会与
    // `proper-nouns.ts` 的 `COUNTRY_CURRENCY` 分叉，而分叉的后果是
    // 「提示词说 A、闸门按 B 判」，每一篇都过不了闸（重试三次 → 丢稿）。
    // 详见 `currencyPromptTable` 的注释。
    .replace('{CURRENCIES}', currencyPromptTable())
    .replace('{CONTENT}', content);
}

// 从 LLM 输出中尽力解析 JSON，返回对象或 null
function parseLlmJson(llmContent: string): Record<string, unknown> | null {
  const cleaned = llmContent.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  const strategies: string[] = [
    jsonMatch[0],
    jsonMatch[0].replace(/,(\s*[}\]])/g, '$1').replace(/[\x00-\x1F\x7F]/g, ''),
    jsonMatch[0].replace(/[\u0000-\u001F\u007F-\u009F]/g, '').replace(/\\"/g, '"').replace(/\\'/g, "'"),
  ];
  for (const str of strategies) {
    try {
      return JSON.parse(str);
    } catch {
      /* 尝试下一策略 */
    }
  }
  return null;
}

// LLM 输出的 category 不在枚举里时的兜底：按关键词粗分，总比全部落到默认值好。
// 旧版分类用英文关键词匹配俄文/哈萨克文原文，永远匹配不上 → 全部落到默认的 economy，
// 这就是「推送里所有新闻分类都是经济」的根因，别改回去。
export function fallbackCategory(title: string, content: string): Category {
  const text = `${title} ${content}`.toLowerCase();
  const rules: Array<[Category, string[]]> = [
    ['oil_gas', ['oil', 'gas', 'petroleum', 'pipeline', 'нефть', 'газ', 'нефтепровод', 'мұнай']],
    ['renewable_energy', ['solar', 'wind', 'hydro', 'renewable', 'green energy', 'солнечн', 'ветров', 'гэс', 'возобновляем']],
    ['minerals', ['mining', 'mineral', 'copper', 'gold', 'uranium', 'ore', 'lithium', 'руд', 'горнодоб', 'уран', 'медь', 'золот']],
    ['transport', ['railway', 'highway', 'airport', 'logistics', 'порт', 'таможен', 'железнодорож', 'автодорог', 'логистик']],
    ['housing', ['real estate', 'housing', 'apartment', 'residential', 'недвижим', 'жил', 'квартир']],
    ['politics', ['president', 'parliament', 'election', 'minister', 'government', 'президент', 'парламент', 'выбор', 'министр', 'правительств']],
    ['policy', ['law', 'decree', 'regulation', 'reform', 'закон', 'указ', 'реформ', 'постановлен']],
    ['economy', ['economy', 'gdp', 'inflation', 'trade', 'export', 'bank', 'инфляц', 'экономик', 'экспорт', 'банк', 'торгов']],
  ];
  for (const [cat, kws] of rules) {
    if (kws.some((kw) => text.includes(kw))) return cat;
  }
  return 'economy';
}

/**
 * 质检拒绝的原因。**不是给日志看的花瓶** —— 它会被拼成重试时的修正指令，见 `buildRepairHint`。
 */
export interface GateReject {
  kind:
    | 'mixed-script'
    | 'half-translated'
    | 'impossible-multiple'
    | 'latin-cyrillic'
    | 'currency-mismatch'
    | 'wrong-noun';
  /** 被拦下的词（截断到前几个） */
  tokens: string[];
  /**
   * 命中的「下降 N 倍」说法（如 `下调1.5倍`）。
   *
   * **与 `tokens` 分开存**：两类问题可以**同时**出现在同一份译文里
   * （既有半译人名、又有不可能的倍数），而重试只有一次机会 ——
   * 修正指令必须把**所有**已发现的问题一次说清，否则第二次修好一类、留另一类，
   * 三次用完就丢稿（见 `buildRepairHint` 的说明）。
   */
  impossibleMultiples?: string[];
  /**
   * 命中的「货币与所属国不符」（2026-10-05 加）。
   *
   * **同样与 `tokens` 分开存**，理由与 `impossibleMultiples` 逐字相同：
   * 一篇稿子可以既有半译人名、又有写错的货币，修正指令必须一次说全。
   */
  currency?: CurrencyMismatch;
  /** 命中的已知错译写法（2026-10-05 加）。同上，分开存。 */
  wrongNouns?: WrongNounHit[];
}

/**
 * 把质检拒绝变成一段**修正指令**，附在重试的提示词末尾。
 *
 * 导出只为回归测试（`scripts/test-translate-prompt.ts`）—— 别在别处调用。
 *
 * ## 为什么非有不可
 *
 * 重试用的是**同一个提示词**（只多等 800ms/1600ms 退避），而这两类错误都是
 * **系统性**的 —— `阿克tau市`（id=4512）来自模型对 Aktau 的转写习惯，
 * 不是随机手滑。温度是 0.3（不是 0），所以重采样**有机会**自己修好，
 * 但连错三次就会**丢弃该篇**：`translateNews` 三次不过即返回 `translated:false`，
 * 调用方不入库 ⇒ **静默丢稿**，这正是本项目最忌讳的形态
 * （「宁可留重复（看得见），不要丢稿（看不见）」）。
 *
 * 带上「上一次错在哪、该改成什么」能把第二次的成功率显著抬起来，
 * 代价只是一段提示词。**注意别把这份要求本身写进 content**（提示词里已有同样的禁令）。
 */
export function buildRepairHint(reject: GateReject): string {
  const blocks: string[] = [];

  // 块 1：专名写法（汉字 + 拉丁/西里尔 拼在一起）
  if (reject.tokens.length > 0) {
    const isLatinCyr = reject.kind === 'latin-cyrillic';
    const what =
      reject.kind === 'half-translated'
        ? '专有名词被译了一半 —— 汉字后面残留了一段拉丁字母'
        : isLatinCyr
          ? '同一个词里同时混了拉丁字母和西里尔字母'
          : '汉字与西里尔字母挤在同一个词里';
    // ⚠️ 示例必须**按类**给：`latin-cyrillic` 命中的词里**一个汉字都没有**
    // （`Kaрабалиева`／`Мырзахметov`／`MЧС`），拿「汉字+拉丁」的示例去教它
    // 等于答非所问 —— 而重试只有一次机会。
    const fix = isLatinCyr
      ? [
          '请把上面这些词改成**要么是完整的中文译名、要么是完整的拉丁写法** ——',
          '**一个词里不许混两种字母**。正确示例：',
          '  「Kaрабалиева」→「Qarabaliyeva」',
          '  「Мырзахметov」→「Myrzakhmetov」',
          '  「MЧС」→「MChS」或直接写中文「哈萨克斯坦紧急情况部」',
          '  「TОО」→「TOO」或直接写中文「有限责任合伙」',
        ]
      : [
          '请把上面这些专有名词改成**要么是完整的中文译名、要么是完整的拉丁写法**，',
          '绝对不要再出现「汉字 + 字母」拼起来的残缺写法。正确示例：',
          '  「斯皮塔梅en区」→「Spitamen 区」（该地名无通用中文译名 ⇒ 用完整拉丁写法）',
          '  「阿克tau市」→「阿克套市」',
          '  「霍贾and市」→「苦盏市」或「Khujand 市」',
        ];
    blocks.push(
      [
        '⚠️ 你上一次的输出**没有通过质检**，原因：' + what + '。',
        '被拦下的词：' + reject.tokens.slice(0, 8).join('、'),
        ...fix,
      ].join('\n'),
    );
  }

  // 块 2：中文里逻辑不成立的「下降 N 倍」。
  //
  // 为什么必须由修正指令来讲清「该改成什么」：模型不是随机手滑，是**把原文的
  // `в N раза` / `понижающий коэффициент N` 直译**了 —— 只叫它「重写一遍」
  // 大概率还是同样的直译。必须把「除以」这层语义当场讲白。
  if (reject.impossibleMultiples && reject.impossibleMultiples.length > 0) {
    blocks.push(
      [
        '⚠️ 另有一类问题：**「下降 N 倍」在中文里逻辑不成立**。',
        '被拦下的说法：' + reject.impossibleMultiples.slice(0, 5).join('、'),
        '「下调 1.5 倍」按字面算是 1 − 1×1.5 = −0.5，成了负数。原文那种写法',
        '（俄语 `снижение в 1.5 раза` 或 `понижающий коэффициент 1.5`）的意思是**除以**那个倍数。',
        '必须改写成下面这类说法之一：',
        '  「降至原来的 1/1.5（约低 33%）」「按 1/1.5 的系数下调」「下调约 33%」',
        '⚠️ 注意方向：**增长**方向可以直接用「倍」（增长 2 倍 = 是原来的 2 倍），',
        '只有**下降**方向不能用「倍」。另外凡出现「系数」，必须说清是**乘**还是**除**。',
      ].join('\n'),
    );
  }

  // 块 3：货币与所属国不符（2026-10-05 加）。
  //
  // ⚠️ 这一块的写法与上面两块**刻意不同**：它不是「描写问题」，而是给出
  // **机械的替换指令**（把哪个词换成哪个词）。理由：货币错是**系统性**的
  // （模型只见过一个货币名就到处用，见 `proper-nouns.ts` 开头的说明），
  // 「请重写一遍」这种泛泛的话对它无效 —— 必须把「就是你写的那个词，换成这个词」
  // 说到字面上。实测线上 kg 频道 7 天里有 21 篇把索姆写成「苏姆」，
  // 这不是手滑，是它真的不知道吉尔吉斯斯坦用什么货币。
  if (reject.currency) {
    const c = reject.currency;
    const wrongWords = c.foreign.map((f) => f.word);
    blocks.push(
      [
        '⚠️ 另有一类问题：**货币写成了别国的**。',
        `本条稿子的所属国家是**${c.own}**（货币就是「${c.own}」，代码 ${c.ownCode}），`,
        `但你的译文里**一次都没有出现「${c.own}」**，出现的全是 ${wrongWords.join('、')}。`,
        `请把译文里**每一处** ${wrongWords.join('、')} 都替换成「${c.own}」——`,
        '包括标题、摘要、正文里的所有金额。',
        '⚠️ 不要因为原文的货币名字你不熟悉就换成别的：原文写什么货币就是什么货币。',
        `⚠️ 顺带检查：不要写出「${c.own}」与别国货币名字**拼起来**的词（例如「吉尔吉斯斯坦坚戈」这类并不存在的货币）。`,
      ].join('\n'),
    );
  }

  // 块 4：已知错译写法（2026-10-05 加）。
  //
  // 与块 3 同理：给的是 wrong → right 的字面映射，而不是「请检查专名」。
  // 每条的 `why` 也带上 —— 说明「为什么」能让模型在别处也不犯同一个错。
  if (reject.wrongNouns && reject.wrongNouns.length > 0) {
    blocks.push(
      [
        '⚠️ 另有一类问题：**已知的错误译名**。',
        '被拦下的写法（左边错、右边对）：',
        ...reject.wrongNouns.slice(0, 5).map((h) => `  「${h.wrong}」→「${h.right}」（${h.why}）`),
        '请把这些写法全部改成右边那种，并检查译文里还有没有同类的错译。',
      ].join('\n'),
    );
  }

  if (blocks.length === 0) return '';
  return ['', ...blocks, '以上要求本身不要写进 content —— content 里只写读者要读的新闻内容。'].join(
    '\n',
  );
}

// 把一次成功的 LLM 输出规整为 Result（中文验证）
function normalizeResult(
  parsed: Record<string, unknown>,
  originalTitle: string,
  originalContent: string,
  provider: string,
  countryName: string,
): { result: TranslateResult; reject?: GateReject } {
  // ---- 交付前的确定性清理（**先清理、再过闸** —— 顺序是量出来的，别改）----
  //
  // 删掉「含西里尔、且一个汉字都没有」的括注：`增值税（НДС）`、`议会（Жогорку Кенеш）`、
  // `紧急情况部（MЧС）`。判据、边界、为什么不做成闸，写在
  // `utils.stripCyrillicParentheticals` 的注释里。这里是**两条使用纪律**：
  //
  // 1. **只清理，不判合格**：它不参与 `ok`，也就不可能造成丢稿。
  // 2. **`!ok` 的返回值不清理**：那时返回的是 `originalTitle` / `originalContent`
  //    （原文回退），它们本来就该带西里尔。
  //
  // ## 为什么是「先清理、再过闸」而不是反过来
  //
  // 闸管的是「**要发出去的那份文字**合不合格」。而括注里藏着的缺陷**根本发不出去**
  // （它会被删掉），拿它去触发重试没有意义 —— 而且是有害的：重试对这类错误无效
  // （模型是系统性再犯，见 `buildRepairHint` 注释），三次用完就是**静默丢稿**。
  //
  // 实测（3528 篇线上语料，`pnpm analyze:cyrillic-note` 第 4 节）：
  // **18 篇本来会被闸拦下、走「重试 ×3 → 可能丢稿」，清理后直接合格** ——
  // 它们的命中**全部**长在冗余括注里，最典型的是「拉丁+西里尔」那一类：
  // `白俄罗斯统一商品交易所（BUТБ）`（`BUТБ` 里 `U/Б/Т` 混排）、
  // `紧急情况部（MЧС）`、`国家医疗基金（FOМС）`。删掉括注后读者看到的是完整中文名，
  // 比「重试三次然后可能什么都没有」严格更好。
  // 剩下的命中一篇不少地仍然触发重试 —— 清理没有让任何**真缺陷**漏过去。
  const stripNote = (s: string) => stripCyrillicParentheticals(s);
  const titleZh = stripNote(typeof parsed.title === 'string' ? parsed.title : originalTitle);
  const summaryZh = stripNote(
    typeof parsed.summary === 'string' ? parsed.summary : originalContent.substring(0, 100),
  );
  const contentZh = stripNote(typeof parsed.content === 'string' ? parsed.content : originalContent);

  // 语言闸：汉字个数够（见 utils.isChineseText 的说明，**不是**占比）
  const zhOk = isChineseText(titleZh, MIN_HAN_TITLE) && isChineseText(contentZh, MIN_HAN_CONTENT);

  // 书写系统闸。两条判据都是**结构性**的（不是「像不像」的阈值），
  // 且都在真实语料上量过误报率为 0，所以敢当硬判据用：
  //   a) 「汉字 + 西里尔」挤在同一个词里 —— 结构上不可能正确（`米尔зиёё夫`／`肯еш`）。
  //   b) 「汉字 + 小写拉丁片段」= **专名被译了一半**（`斯皮塔梅en`／`霍贾and`／`阿克tau市`／
  //      `哈萨克mys`／`沙霍比丁hon`）。判据的构造、放行/命中的边界、以及
  //      1977 篇语料上 12 处命中 0 误报的实测记录，都写在 `utils.mixedScriptTokensLatin` 的注释里。
  //
  // ⚠️ 2026-09-24 才加 (b)，原因值得记下来：提示词第 6 条**早就逐字写着**
  // `斯皮塔梅en`／`霍贾and` 作为禁止反例（`translate.ts` 的「绝不允许出现…」那一行），
  // 而口径改完之后的新产出里 `阿克tau市`（id=4512）、`霍贾and`（id=4556）**照样出现**。
  // ⇒ 对这类错误，**提示词是无效的承载体**，只有闸门能兜住。别再往提示词里加例子了。
  //
  // ⚠️ 查**三段**（标题/摘要/正文）：草稿里三段都会显示给读者，
  // 而 `斯皮塔梅en` 恰恰标题和摘要里都有（id=4492）。原来只查标题+正文是漏的。
  const fields = [titleZh, summaryZh, contentZh];
  const mixed = fields.flatMap((f) => mixedScriptTokens(f));
  const halfTranslated = fields.flatMap((f) => mixedScriptTokensLatin(f));

  // (c) 「拉丁 + 西里尔」挤在同一个词里（2026-09-29 加）—— 上面两条的**盲区补丁**。
  //
  // ⚠️ 为什么前两条抓不到：它们的锚点都是**汉字**（「汉字+西里尔」「汉字+拉丁」），
  // 而这一类的命中词里**一个汉字都没有**：`Kaрабалиева`、`Natалья`、`KTЖ`、
  // `Aйдос Мырзахметов`、`Kosанов`、`MЧС`、`Akorда`、`Kazselezащиты`。
  // 1152 篇抽样里现有两条闸抓到 **0** 篇，本判据抓到 22 篇 —— 完全是增量。
  //
  // 实测依据（进闸门槛与 `mixedScriptTokens` 当年相同，详见 `utils.latinCyrillicTokens` 注释）：
  // 线上 6 天 **2837 篇**，命中 53 篇（1.87%），60 个词种**逐条人工判读全部是真缺陷、误报 0**。
  // 两条结构排除（`@` 邮箱、`.<2-4 拉丁字母>` 文件扩展名）来自同一批实测 ——
  // 样本里 2445 个 `<img src>` 有 6 个文件名含西里尔，这次侥幸没误杀（连字符把它切开了），
  // 换个命名就会误杀一篇好稿。
  const latinCyr = fields.flatMap((f) => latinCyrillicTokens(f));

  // 第三类闸（2026-09-29 加）：「下降 N 倍」在中文里逻辑不成立。
  //
  // 与上面两类并列而不是替代 —— 它的性质更硬：不是「写法习惯」问题，
  // 而是**语义上不可能成立**（1 元下调 1.5 倍 = −0.5 元）。构造、刻意不跨过
  // 「至/到」的理由、以及 500 篇真实语料上 2 篇 4 处命中 **0 误报**的实测记录，
  // 都写在 `descendingMultiplePhrases` 的注释里。
  //
  // 为什么敢当闸：误报的代价是「重试 → 三次不过丢稿」，而这个判据在中文里
  // 不存在合法反例，所以误报率的结构性上限就是 0（实测也是 0）。
  // 对比之下 `mixedScriptTokensLatinCapitalized` 只做体检 —— 因为它实测 5% 误伤。
  // **两者待遇不同的唯一依据是实测误报率**，不是「哪个看起来更准」。
  const impossible = fields.flatMap((f) => descendingMultiplePhrases(f));

  // 第四类闸（2026-10-05 加）：**术语**——货币与所属国不符、已知错译写法。
  //
  // ## 为什么这一类单独成立
  //
  // 前三类闸管的是「书写系统」与「数量语义」，它们都**不认国家**。
  // 而用户反复报的这一批错（阿塞拜疆写坚戈、吉尔吉斯写苏姆、Almaty→阿利穆特）
  // 的共同点是：**要判对就必须知道「这篇稿子属于哪个国家」**。
  // 判据本体在 `proper-nouns.ts`，与提示词共用同一张货币表。
  //
  // ## 为什么敢当硬闸（实测依据，不是「看起来更准」）
  //
  // `pnpm analyze:currency` 在线上 **2812 篇**上跑：命中 41 篇，**逐条人工判读
  // 41/41 全是真缺陷、误报 0**；另测 3 篇错译写法也是 3/3 真缺陷。
  // 参照 `mixedScriptTokens` 当年进闸的门槛（1757 篇、156 种词、误报 0），
  // 这一条同样够格。
  //
  // ⚠️ 值得记下来的是**第一版判据有 2 处误报**（也是实测抓到的，不是想出来的）：
  //   · 阿塞拜疆城市「苏姆盖**蒂**」被当成乌兹别克货币「苏姆」（假朋友只写了
  //     「苏姆盖特」，换了个尾字就绕过了）；
  //   · 塔吉克斯坦的异写「苏姆**尼**」被当成乌兹别克货币。
  //   ⇒ 教训：**这类「货币名是别的词的子串」的判据，必须逐条把命中上下文打出来读**，
  //     光看计数会以为全对。
  //
  // ⚠️ 还有一处是**判据设计**上的修正（不是 bug）：闸门要求文本里先有
  // 「它确实是这个国家」的证据（`ownCountryMentioned`）。没这一条时 68 篇命中里
  // 有 27 篇其实是「稿子被归错了国」（如 uz 栏目里的哈萨克斯坦太阳能补贴稿），
  // 那类稿子的货币**本来就是对的**，拿它去重试会把「国别放错」升级成「正文也编了」。
  // 详细理由写在 `proper-nouns.ts` 的 `ownCountryMentioned` 注释里。
  const countryCode = countryCodeByName(countryName);
  const combined = `${titleZh} ${summaryZh} ${contentZh}`;
  const currencyIssue = countryCode ? checkCurrencyCountryFit(countryCode, combined) : null;
  const wrongNouns = countryCode ? checkWrongProperNouns(countryCode, combined) : [];

  const ok =
    zhOk &&
    mixed.length === 0 &&
    halfTranslated.length === 0 &&
    latinCyr.length === 0 &&
    impossible.length === 0 &&
    !currencyIssue &&
    wrongNouns.length === 0;
  if (zhOk && mixed.length > 0) {
    console.log(`[translate] 译文含「汉字+西里尔」混排词 ${mixed.slice(0, 6).join('/')}，判不合格并重试`);
  }
  if (zhOk && halfTranslated.length > 0) {
    console.log(
      `[translate] 译文含「汉字+拉丁」半译专名 ${halfTranslated.slice(0, 6).join('/')}，判不合格并重试`,
    );
  }
  if (zhOk && latinCyr.length > 0) {
    console.log(
      `[translate] 译文含「拉丁+西里尔」混排词 ${[...new Set(latinCyr)].slice(0, 6).join('/')}，判不合格并重试`,
    );
  }
  if (zhOk && impossible.length > 0) {
    console.log(
      `[translate] 译文含「下降 N 倍」这种中文里不成立的说法 ${[...new Set(impossible)].slice(0, 4).join('/')}，判不合格并重试`,
    );
  }
  if (currencyIssue) {
    translationStats.termGate.currency++;
    if (translationStats.termGate.samples.length < 20) {
      translationStats.termGate.samples.push({
        kind: 'currency',
        detail: `[${countryName}] ${currencyIssue.reason}`,
      });
    }
    console.log(`[translate] 质检拦下（术语·货币）：${currencyIssue.reason} ⇒ 重试带修正指令`);
  }
  if (wrongNouns.length > 0) {
    translationStats.termGate.wrongNoun++;
    if (translationStats.termGate.samples.length < 20) {
      translationStats.termGate.samples.push({
        kind: 'wrong-noun',
        detail: `[${countryName}] ${wrongNouns.map((h) => `${h.wrong}→${h.right}`).join('、')}`,
      });
    }
    console.log(
      `[translate] 质检拦下（术语·错译写法）：${wrongNouns
        .map((h) => `${h.wrong}→${h.right}`)
        .join('/')} ⇒ 重试带修正指令`,
    );
  }

  const rawCategory = typeof parsed.category === 'string' ? parsed.category : '';
  const category = (CATEGORY_IDS as string[]).includes(rawCategory)
    ? (rawCategory as Category)
    : null;

  // 拒绝原因 —— 决定重试时要不要带修正指令（见 buildRepairHint）。
  // 语言闸不过（模型把原文回显了）**不带**修正指令：那不是「专名写法」的问题，
  // 让它按原样重译即可。
  //
  // ⚠️ 名字类与倍数类**可以同时出现**，所以这里不是「三选一」：
  // `tokens` 装名字类、`impossibleMultiples` 装倍数类，两块都带给重试
  // （见 `GateReject.impossibleMultiples` 的说明 —— 重试只有一次机会，
  // 只说清一类，另一类就会撑到三次用完然后丢稿）。
  const nameKind: GateReject['kind'] | undefined =
    halfTranslated.length > 0
      ? 'half-translated'
      : mixed.length > 0
        ? 'mixed-script'
        : latinCyr.length > 0
          ? 'latin-cyrillic'
          : undefined;
  // ⚠️ **术语类与写法类是并列的，不是二选一**（同 `impossibleMultiples` 的理由）：
  // 一篇稿子完全可以「人名被译了一半 + 货币写成别国的」，一次重试必须把两类都说清。
  // `kind` 只是给日志一个主标签，真正的载荷在各字段里。
  const termKind: GateReject['kind'] | undefined =
    currencyIssue ? 'currency-mismatch' : wrongNouns.length > 0 ? 'wrong-noun' : undefined;
  const reject: GateReject | undefined = !zhOk
    ? undefined
    : nameKind || impossible.length > 0 || termKind
      ? {
          kind: nameKind ?? termKind ?? 'impossible-multiple',
          tokens: [...new Set([...halfTranslated, ...mixed, ...latinCyr])],
          ...(impossible.length > 0 ? { impossibleMultiples: [...new Set(impossible)] } : {}),
          ...(currencyIssue ? { currency: currencyIssue } : {}),
          ...(wrongNouns.length > 0 ? { wrongNouns } : {}),
        }
      : undefined;

  return {
    result: {
      titleZh: ok ? titleZh : originalTitle,
      summaryZh: ok ? summaryZh : originalContent.substring(0, 100),
      contentZh: ok ? contentZh : originalContent,
      category: ok ? category : null,
      investorRelevant: ok && parsed.investorRelevant === true,
      translated: ok,
      provider,
    },
    ...(reject ? { reject } : {}),
  };
}

function resolveModel(provider: ChatProvider): string {
  const override = process.env[provider.modelEnv];
  return (override && override.trim()) || provider.defaultModel;
}

/**
 * 单次调用模型的结果。`retryable` 决定调用方要不要再试一次。
 *
 * 为什么要区分「值不值得重试」：旧版对所有失败一律重试 3 次。对于「Key 配错了」
 * 这种失败，重试不可能变好，只是把同一份错误报 3 遍、把整个批次拖慢，最后照样
 * 降级到付费通道 —— 这正是 2026-09-19 那 3.42 元的成因之一。
 */
interface ChatCallResult {
  text: string | null;
  /** 失败是否值得重试：429 / 5xx / 空响应 = 值得；鉴权、型号、参数类错误和超时 = 不值得 */
  retryable: boolean;
  /**
   * 本次响应里 `reasoning_content` 的字符数（0 表示没有）。
   *
   * 这是判断「thinking 到底关掉了没有」的**直接证据**：
   * 请求里带了 `thinking: {type:'disabled'}` 却依然返回一大段 reasoning_content，
   * 就说明那个参数没被受理（型号变了 / 字段名变了），
   * 而症状只是「慢」（单篇从几秒涨到十几秒），不看这个字段根本发现不了。
   */
  reasoningChars?: number;
}

/** 单次模型调用的超时上限。 */
const CALL_TIMEOUT_MS = 60000;

/**
 * 默认采样温度。
 *
 * 为什么是 0.3 而不是 0：**翻译**是生成任务，完全贪心会让同一批原文
 * 反复产出逐字相同的译文，读起来像模板；0.3 保留一点用词变化。
 *
 * ⚠️ 但这个默认值**不适用于分类/判定类任务**。判「是不是同一件事」要求
 * 同样的输入给出同样的答案，用 0.3 会直接导致结论不稳定 ——
 * 2026-09-21 实测：同一份 15 个候选对跑两遍，模型第一遍判 4 对是同一件事、
 * 第二遍判 10 对（某国从 2 对涨到 7 对）。判定本身不稳定，这条链路就没法上线。
 * 所以判定类调用必须显式传 `temperature: 0`（见 `same-event.ts` 的 `JUDGE_TEMPERATURE`）。
 */
export const DEFAULT_TEMPERATURE = 0.3;

/** `callChatProvider` 的可选开关（翻译主链路只用默认值，体检接口会用到全部三个）。 */
interface ChatCallOptions {
  /** 把原始错误交给调用方（体检接口用它把报错原样返回，不依赖全局统计） */
  onError?: (err: string) => void;
  /**
   * 体检用：覆盖 provider.extraBody。
   * 传 `{}` 就是「不关 thinking」的对照组 —— 只有和它比过，才能证明
   * `thinking: {type:'disabled'}` 是真的起了作用，而不是「本来就这么慢」。
   */
  extraOverride?: Record<string, unknown>;
  /** 覆盖超时。体检要连打两次，必须比主链路短，否则两次加起来会超过网关 65 秒上限。 */
  timeoutMs?: number;
  /**
   * 覆盖采样温度，默认 {@link DEFAULT_TEMPERATURE}。
   * **判定类任务必须传 0**，理由见 `DEFAULT_TEMPERATURE` 的说明。
   */
  temperature?: number;
  /**
   * 是否把失败计入 `translationStats.errors`。默认 true。
   *
   * 为什么要有这个开关：`translationStats` 的用途是**翻译成本体检**
   * （「免费档到底用上了没有、钱花在哪」）。去重判组这类**非翻译**调用
   * 如果也往里写，`providerCounts` 就会混进不属于翻译的数字，
   * 以后再拿它算单价就会被带偏。非翻译调用方传 `recordError: false`，
   * 自己收错误信息。
   */
  recordError?: boolean;
}

/**
 * 通道失败的**类别**。
 *
 * ## 为什么要有它（2026-10-05）
 *
 * 在那之前，`translationStats.errors` 里只有一行**自由文本**，而且
 * `recordProviderError` **每个通道只留第一条** —— 于是「这一轮失败了几次、为什么失败」
 * 在报告里根本不存在。用户报的两个通道报错（`glm-4.7-flash` 超时、
 * `glm-4-flash-250414` HTTP 400 contentFilter）就是这么变成悬案的：
 * **只知道「报过一次」，不知道报了多少次、更不知道该怎么处置。**
 *
 * 分类直接决定**要不要重试**，这是它最主要的作用：
 *   · 限流（429 / code 1305）：重试有意义（服务端会恢复）；
 *   · **内容审核拒绝：重试毫无意义** —— 同一段文字再打一次还是被拒，
 *     3 次重试纯属白等 2.4 秒并把「内容问题」伪装成「通道故障」；
 *   · 超时：说明这个通道此刻**不可用**，不是「再试一次就好」（旧注释已写明）。
 */
export type ProviderErrorKind =
  /** 没配环境变量 → 通道整条跳过（不是故障，是配置缺失） */
  | 'no-key'
  /** 单次调用超时：平台侧排队/拥堵 */
  | 'timeout'
  /** 限流：429 / 智谱 code 1305「该模型当前访问量过大」 */
  | 'rate-limit'
  /** **内容审核拒绝**：与通道健康无关，换通道才有用 */
  | 'content-filter'
  /** 认证失败：Key 无效/被截断 */
  | 'auth'
  /** 型号不存在（厂商下线了代号） */
  | 'model-missing'
  /** 其它 400：参数非法（例如往不支持 thinking 的型号塞了它） */
  | 'bad-request'
  /** 5xx：服务端抖动 */
  | 'server'
  /** 200 但内容为空（含「只有 reasoning_content」） */
  | 'empty'
  /** 网络/DNS/连接异常 */
  | 'network';

/** 类别 → 中文标签。日志和接口都用它，避免同义不同词。 */
const ERROR_KIND_LABEL: Record<ProviderErrorKind, string> = {
  'no-key': '未配置 Key',
  timeout: '超时',
  'rate-limit': '限流',
  'content-filter': '内容审核拒绝',
  auth: '认证失败',
  'model-missing': '型号不存在',
  'bad-request': '请求非法',
  server: '服务端错误',
  empty: '返回内容为空',
  network: '网络异常',
};

/**
 * 判定一个失败属于哪一类，以及**要不要重试**。
 *
 * 抽成纯函数是为了能被离线回归直接钉住 —— 这套判据是「删除类/花钱类」规则的邻居：
 * 判错不会抛异常，只会让钱和时间悄悄花掉（重试无意义的错误），
 * 或者让**内容问题**长期伪装成**通道故障**（用户报的那条 contentFilter 就是后者）。
 *
 * 匹配顺序有意为之：**先看异常（没有 HTTP 状态）→ 再看状态码 → 最后才猜内容**。
 * 反过来「先猜内容」会把 429 里恰好提到敏感词的那种响应误判成内容审核。
 */
export function classifyProviderError(args: {
  /** HTTP 状态码。调用抛异常时没有 */
  status?: number;
  /** 响应体片段（已截断） */
  body?: string;
  /** 抛出的异常消息。有它就是「没拿到 HTTP 响应」 */
  thrown?: string;
}): { kind: ProviderErrorKind; label: string; retryable: boolean } {
  const { status, body = '', thrown } = args;

  if (thrown !== undefined) {
    const isTimeout = /timeout|abort/i.test(thrown);
    const kind: ProviderErrorKind = isTimeout ? 'timeout' : 'network';
    return { kind, label: ERROR_KIND_LABEL[kind], retryable: false };
  }

  if (status === 429) {
    return { kind: 'rate-limit', label: ERROR_KIND_LABEL['rate-limit'], retryable: true };
  }
  if (status === 401 || status === 403) {
    return { kind: 'auth', label: ERROR_KIND_LABEL.auth, retryable: false };
  }
  if (status === 404) {
    return { kind: 'model-missing', label: ERROR_KIND_LABEL['model-missing'], retryable: false };
  }
  if (status !== undefined && status >= 500) {
    return { kind: 'server', label: ERROR_KIND_LABEL.server, retryable: true };
  }

  // 到这里只剩 4xx（含 400）。**先判内容审核**，再落到「请求非法」。
  if (looksLikeContentFilter(body)) {
    return {
      kind: 'content-filter',
      label: ERROR_KIND_LABEL['content-filter'],
      retryable: false,
    };
  }
  return { kind: 'bad-request', label: ERROR_KIND_LABEL['bad-request'], retryable: false };
}

/**
 * 响应体/`finish_reason` 里有没有**内容审核**的痕迹。
 *
 * 三种实测形态都要认（写死一个词就会漏）：
 *   1. `finish_reason: "content_filter"`（HTTP 200、content 为空）—— 最阴的一种，
 *      它长得像「返回内容为空」；
 *   2. 智谱的审核错误码 `1301` / `1302`（内容安全）；
 *   3. 中文文案里的「敏感」「内容安全」。
 */
export function looksLikeContentFilter(text: string): boolean {
  return (
    /content_?filter/i.test(text) ||
    /"code"\s*:\s*"?(1301|1302)"?/.test(text) ||
    /敏感|内容安全/.test(text)
  );
}

/**
 * 调用一个 OpenAI 兼容的 chat/completions 接口。
 * 失败时返回 `{ text: null, retryable }`，由调用方决定重试还是换通道。
 */
async function callChatProvider(
  provider: ChatProvider,
  prompt: string,
  options: ChatCallOptions = {},
): Promise<ChatCallResult> {
  const {
    onError,
    extraOverride,
    timeoutMs = CALL_TIMEOUT_MS,
    temperature = DEFAULT_TEMPERATURE,
    recordError = true,
  } = options;
  const apiKey = process.env[provider.keyEnv];
  if (!apiKey) return { text: null, retryable: false };

  const model = resolveModel(provider);

  /**
   * 统一的失败出口：分类 + 记日志 + 记统计 + 通知调用方，四处都别漏。
   *
   * `kind`/`label` 由 {@link classifyProviderError} 给出（或由调用点直接指定）。
   * 分类不只是「好看」：它决定 `retryable`，而 `retryable` 决定是重试 3 次
   * 还是**立刻换通道** —— 见下面 `content_filter` 那条的说明。
   */
  const fail = (
    err: string,
    retryable: boolean,
    kind?: ProviderErrorKind,
    label?: string,
  ): ChatCallResult => {
    console.error(`[${provider.name}/${model}] ${label ? `${label}：` : ''}${err}`);
    if (recordError) recordProviderError(provider.name, model, err, kind);
    onError?.(err);
    return { text: null, retryable };
  };

  try {
    const response = await fetch(provider.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        // provider 专属参数（如智谱的 thinking 开关）在这里展开，
        // 见 ChatProvider.extraBody 的说明 —— 不能全局写死，否则会串到别的厂商。
        // ⚠️ 展开在 `temperature` **之后**，所以 extraBody 里写了 temperature 会覆盖它 ——
        // 这个顺序是故意的（判定类调用想强制贪心时，可以通过 extraBody 兜底）。
        ...(extraOverride ?? provider.extraBody ?? {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text();
      /**
       * 非 2xx 的分类**全部交给 `classifyProviderError`**，不再在这里手写
       * 「429/5xx 才重试」那条判断。
       *
       * 2026-10-05 换掉的理由是用户报的那两条错：`glm-4-flash-250414` 的
       * 「HTTP 400 contentFilter」，和 `glm-4.7-flash` 的「超时」。
       * 旧写法下这两者**都只能报出一句 `HTTP 400: <前200字>` / 调用异常**，
       * 既分不出「限流（等一会儿就好）」与「内容审核（等多久都一样）」，
       * 也分不出「超时（这个通道现在不可用）」与「网络抖动」。
       * 现在返回体里带 `code`/`sensitive` 之类字样会被认成 `content-filter`（不可重试），
       * 429 认成 `rate-limit`（可重试），500+ 认成 `server`（可重试）。
       */
      const cls = classifyProviderError({ status: response.status, body });
      return fail(`HTTP ${response.status}: ${body.substring(0, 200)}`, cls.retryable, cls.kind, cls.label);
    }

    const data = (await response.json()) as {
      choices?: Array<{
        /** `stop` / `length` / `content_filter` … —— 200 也会带着它说明为什么停 */
        finish_reason?: string;
        message?: { content?: string; reasoning_content?: string };
      }>;
    };
    const choice = data.choices?.[0];
    const message = choice?.message;
    const llmContent = message?.content || '';
    const reasoningChars = (message?.reasoning_content || '').length;
    if (!llmContent) {
      /**
       * 空内容有**两种完全不同的成因**，不能混着报（2026-10-05 补）。
       *
       * `finish_reason: content_filter` 是最阴的一种：**HTTP 200、content 为空**，
       * 所以上面那条 `!response.ok` 抓不到，而它和「模型抽风返回空」长得一模一样。
       * 旧版把它归到「返回内容为空，可重试」⇒ `translateNews` 会**原样重试 3 次**，
       * 每次都被同一个审核器拒掉（同一段文本、同一个厂商），最后只留下
       * 一句含糊的「返回内容为空」—— 真实原因（被内容审核拦了）就这么丢了。
       * 这正是用户 2026-10-04 报的那类错：**看起来像抖动，实际重试无用**。
       *
       * 所以：认成 `content-filter` ⇒ **不可重试**，`translateNews` 会立刻换通道
       * （换厂商的审核器有可能放行，重试同一个没有意义）。
       * 另一支「思考型模型把内容全写进 reasoning_content」仍然可重试。
       */
      if (choice?.finish_reason === 'content_filter' || looksLikeContentFilter(JSON.stringify(data))) {
        return fail(
          `返回内容为空：finish_reason=${choice?.finish_reason ?? '未知'}（内容审核拒绝，重试无用）`,
          false,
          'content-filter',
          ERROR_KIND_LABEL['content-filter'],
        );
      }
      return fail(
        reasoningChars > 0 ? '返回内容为空（只有 reasoning_content）' : '返回内容为空',
        true,
        'empty',
        ERROR_KIND_LABEL.empty,
      );
    }
    return { text: llmContent, retryable: false, reasoningChars };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 超时 / 网络异常一律不重试：说明这个通道**当前不可用**，不是「再试一次就好」。
    // 旧版在这里硬重试 3 次（最坏 3 分钟/篇），166 篇就是几个小时，而且最后照样
    // 降级到付费通道。直接换下一个通道，让降级链干它该干的事。
    //
    // 2026-10-05：超时与网络异常**分开报**（`classifyProviderError` 里按
    // `AbortError`/`TimeoutError` 判）。用户报的「glm-4.7-flash 超时」与
    // 「网络抖动」处置不同：前者说明这个通道在这个时段不可用（该换通道或调超时），
    // 后者是偶发（降级链兜住即可）。两者混成一句「调用异常」时，只能靠猜。
    const cls = classifyProviderError({ thrown: message });
    return fail(`调用异常: ${message}`, cls.retryable, cls.kind, cls.label);
  }
}

const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 800;

/**
 * 「问一次模型、要一段文本」的通用出口，复用翻译那条降级链
 * （免费通道优先 → 免费备用 → 付费兜底，且沿用各通道的 thinking 开关）。
 *
 * 与 `translateNews` 的区别，别混用：
 *   - **不重试**。调用方是非翻译任务（当前只有「同一件事」判组），
 *     它们对延迟敏感、且失败有降级路径；在这个场景下重试 3 次只会把整轮流水线拖慢。
 *   - **不写 `translationStats`**（`recordError: false`）。那份统计是翻译成本体检的口径，
 *     混进别的调用会让「免费档有没有生效」这个判断失真。
 *
 * 全部通道都失败时返回 `{ ok: false, error }`，错误信息聚合了每个通道的原因，
 * 便于一眼看出是「没配 Key」还是「Key 无效」还是「全被限流」。
 */
/**
 * 按名字把降级链**收窄成单通道**。
 *
 * ## 为什么必须有这个（2026-09-24 实测的仪器缺陷）
 *
 * 判组的 A/B 要比较的是**提示词版本**。但 `askLlmJson` 会按 `PROVIDERS` 顺序取
 * 第一个不报错的通道 —— 而「哪个通道不报错」取决于**这一刻谁被 429 限流**。
 * 实测同一次 A/B 的两臂就落到了不同通道上：
 *
 *   pv=1 → provider=zhipu      （当时 glm-4.7-flash 恰好没被限流）
 *   pv=3 → provider=zhipu-flash（跑第二臂时 zhipu 已 429）
 *
 * 「两臂结论不同」于是有两种解释：**提示词改了** 或 **换了通道**。
 * 这和「窗口滑动」是同一类污染，只是藏在更下游。不钉住通道，A/B 的 ★结论不可采信。
 *
 * ## 为什么未知名字**返回错误而不是回退全链**
 *
 * 与 `pv=`、`promptBuilderFor` 同一条规矩：手误的 `provider=zhipu-flash2` 若静默跑
 * 全链，会产出一个**看起来正常**的结果，而它恰恰不是被钉住的那一档 ——
 * 又一次「分不清跑的是哪个配置」。宁可当场失败。
 */
export function resolveProviderChain(
  only?: string,
): { ok: true; providers: ChatProvider[] } | { ok: false; error: string } {
  if (!only) return { ok: true, providers: PROVIDERS };
  const hit = PROVIDERS.filter((p) => p.name === only);
  if (hit.length === 0) {
    return {
      ok: false,
      error: `未知的模型通道 provider=${only}；可用：${availableProviderNames().join(', ')}`,
    };
  }
  return { ok: true, providers: hit };
}

/** 可用通道名清单。给体检接口校验入参、给脚本打印用，保证只有一处真值。 */
export function availableProviderNames(): string[] {
  return PROVIDERS.map((p) => p.name);
}

export async function askLlmJson(
  prompt: string,
  options: {
    timeoutMs?: number;
    extraBody?: Record<string, unknown>;
    /**
     * 采样温度。**判定类任务必须传 0** —— 用默认的 0.3 会让同一份输入
     * 两次得到不同答案（2026-09-21 实测：同一批候选对，两次分别判出 4 对 / 10 对）。
     */
    temperature?: number;
    /**
     * **只走这一个通道**（名字取自 `PROVIDERS[].name`）。不传 = 走完整降级链。
     *
     * 只给体检 / A/B 用。**生产链路不要传** —— 钉住通道等于放弃降级，
     * 一旦该通道被限流，整轮就没了兜底。详见 `resolveProviderChain` 的说明。
     */
    only?: string;
  } = {},
): Promise<{ ok: true; text: string; provider: string } | { ok: false; error: string }> {
  const { timeoutMs = CALL_TIMEOUT_MS } = options;
  const failures: string[] = [];

  const chain = resolveProviderChain(options.only);
  if (!chain.ok) return { ok: false, error: chain.error };

  for (const provider of chain.providers) {
    if (!process.env[provider.keyEnv]) {
      failures.push(`${provider.name}：未配置 ${provider.keyEnv}`);
      continue;
    }
    const call = await callChatProvider(provider, prompt, {
      timeoutMs,
      recordError: false,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      // 传了就是覆盖该通道的默认 extraBody（例如给「判组」这类推理任务打开 thinking）。
      // 不传则沿用通道默认值（翻译链路关掉 thinking 的那个设置）。
      ...(options.extraBody ? { extraOverride: options.extraBody } : {}),
      onError: (err) => failures.push(`${provider.name}：${err}`),
    });
    // ⚠️ 成功时**必须带出通道名**：降级链会在通道间切换，
    // 而不同型号对同一份输入可以给出不同答案 —— 调用方要判「两次结论不同」
    // 是「换了通道」还是「模型本身不稳」，就靠这个字段。别把它丢掉。
    if (call.text) return { ok: true, text: call.text, provider: provider.name };
  }

  return { ok: false, error: failures.join('；') || '没有任何可用的模型通道' };
}

/**
 * 多模型翻译主入口：按 PROVIDERS 顺序依次尝试，中途成功即返回。
 * 若全部失败，返回 translated=false（内容保持原文但不入库，由调用方处理）。
 *
 * `countryName`（中文国名，如「吉尔吉斯斯坦」）**必须传**：它进提示词当硬事实用
 * （见 `buildPrompt` 的注释）。调用方从源配置里拿，不要从内容里猜。
 */
export async function translateNews(
  title: string,
  content: string,
  sourceLanguage: string,
  countryName: string,
): Promise<TranslateResult> {
  const prompt = buildPrompt(title, content, sourceLanguage, countryName);
  const unconfigured: string[] = [];
  /**
   * 质检失败后的修正指令（见 `buildRepairHint`）。
   * **跨通道保留**：一个通道三次都不过、切到下一个通道时，下一个通道也该知道
   * 「上一家错在哪」，而不是从零再错三遍 —— 那样只会把丢稿概率乘起来。
   */
  let repairHint = '';
  /**
   * 最后一次质检拒绝的**类别**（2026-10-05 加）。
   *
   * 存在的唯一目的：所有通道都失败、这篇稿子要**丢掉**时，回答「它是因为什么丢的」。
   * 术语闸是硬闸，命中 ⇒ 三次不过 ⇒ 丢稿 —— 本项目最忌讳的「看不见的丢失」。
   * 靠这个变量把「因为货币写错而丢」这一类**变成可数的数字**（`termGate.dropped`），
   * 而不是等人下个月问「吉尔吉斯的稿子怎么少了」。
   *
   * ⚠️ 记的是**最后一个通道的最后一次**拒绝，不是「跨通道汇总」。理由：
   * 判断依据只能是「最后那次为什么没通过」，跨通道合并会把「A 家写错货币、
   * B 家写错人名」这种情况误记成「两种都有」。刻度写在字段名里（`lastReject`）。
   */
  let lastReject: GateReject | undefined;

  for (const provider of PROVIDERS) {
    if (!process.env[provider.keyEnv]) {
      unconfigured.push(`${provider.name}（缺少 ${provider.keyEnv}）`);
      continue;
    }

    const model = resolveModel(provider);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      console.log(
        `[translate] ${provider.name}/${model} 第 ${attempt}/${MAX_ATTEMPTS} 次尝试...` +
          (repairHint ? '（带修正指令）' : ''),
      );

      const call = await callChatProvider(provider, repairHint ? `${prompt}\n${repairHint}` : prompt);
      if (call.text) {
        const parsed = parseLlmJson(call.text);
        if (parsed) {
          const { result, reject } = normalizeResult(parsed, title, content, provider.name, countryName);
          if (result.translated && result.contentZh !== content) {
            translationStats.providerCounts[provider.name] =
              (translationStats.providerCounts[provider.name] || 0) + 1;
            return result;
          }
          if (reject) {
            // 质检拦下 ⇒ 下一次重试带上「错在哪、该改成什么」
            lastReject = reject;
            repairHint = buildRepairHint(reject);
            // 两类问题都可能出现，日志要**分别**打 —— 只打 tokens 的话，
            // 「纯倍数问题」（tokens 为空）会打出一行看不懂的空日志。
            const bits: string[] = [];
            if (reject.tokens.length > 0) bits.push(`专名 ${reject.tokens.slice(0, 6).join('/')}`);
            if (reject.impossibleMultiples?.length) {
              bits.push(`不成立的倍数 ${reject.impossibleMultiples.slice(0, 4).join('/')}`);
            }
            if (reject.currency) bits.push(`货币 ${reject.currency.foreign.map((f) => f.word).join('/')}`);
            if (reject.wrongNouns?.length) {
              bits.push(`错译写法 ${reject.wrongNouns.map((h) => h.wrong).join('/')}`);
            }
            console.log(`[translate] 质检拦下（${reject.kind}）：${bits.join(' + ')} ⇒ 重试带修正指令`);
          } else {
            console.log(`[translate] ${provider.name} 返回内容未通过中文校验，继续重试`);
          }
        } else {
          console.log(`[translate] ${provider.name} 返回内容不是合法 JSON，继续重试`);
        }
      } else if (!call.retryable) {
        // 不可重试的失败（Key 无效 / 型号不存在 / 超时 / 网络异常）：
        // 立刻换下一个通道，不再浪费 2 次重试和退避等待。理由见 callChatProvider。
        console.log(`[translate] ${provider.name} 的失败不可重试，直接切换下一个通道`);
        break;
      }

      // 指数退避：800ms / 1600ms。限流（429）时给服务端一点恢复时间。
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * attempt));
      }
    }

    console.log(`[translate] ${provider.name} 通道失败，切换到下一个通道`);
  }

  if (unconfigured.length > 0) {
    console.error(`[translate] 以下翻译通道未启用：${unconfigured.join('、')}`);
    for (const u of unconfigured) {
      const name = u.split('（')[0];
      recordProviderError(name, '-', u);
    }
  }
  console.error('[translate] 所有翻译通道均失败，本篇将不入库（保持中文优先策略）');

  // 把「因为术语闸而丢」单独记账（见 `lastReject` 的说明）。
  // ⚠️ 只统计**术语类**：写法类（半译专名等）丢稿是老现象，混在一起会让这个数字
  // 失去意义 —— 它的用途是回答「新加的那道硬闸到底吃掉了多少稿子」。
  if (lastReject?.currency || lastReject?.wrongNouns?.length) {
    translationStats.termGate.dropped++;
    if (translationStats.termGate.dropSamples.length < 10) {
      translationStats.termGate.dropSamples.push(
        `[${countryName}] ${title.slice(0, 40)}｜${
          lastReject.currency ? lastReject.currency.reason : ''
        }${lastReject.wrongNouns?.length ? lastReject.wrongNouns.map((h) => h.wrong).join('/') : ''}`,
      );
    }
    console.error(
      `[translate] ⚠️ 这一篇是因为**术语闸**丢的（不是网络/额度失败）：` +
        `${lastReject.currency?.reason || ''}${lastReject.wrongNouns?.map((h) => h.wrong).join('/') || ''}`,
    );
  }

  return {
    titleZh: title,
    summaryZh: content.substring(0, 100),
    contentZh: content,
    category: null,
    investorRelevant: false,
    translated: false,
    provider: 'none',
  };
}

/** 单个翻译通道的体检结果。 */
export interface ProviderProbe {
  provider: string;
  model: string;
  /** 免费档还是付费档。结论句靠它判断「这次翻译到底花不花钱」，不再写死通道名。 */
  cost: 'free' | 'paid';
  /** Key 对应的环境变量有没有值 */
  keyConfigured: boolean;
  ok: boolean;
  /** 成功时是模型回显；失败时是**原始报错**（HTTP 状态码 + 响应体片段） */
  detail: string;
  latencyMs: number;
  /** 这次请求实际带的 provider 专属参数（证明 extraBody 真发出去了，而不是被漏掉） */
  requestExtra?: Record<string, unknown>;
  /** 响应里 reasoning_content 的字符数。>0 = 这次调用真的「思考」了（哪怕传了 disabled） */
  reasoningChars?: number;
  /**
   * 对照组：把 extraBody 去掉再打一次（只对有 extraBody 的通道做）。
   *
   * 为什么必须比：只看 `latencyMs` 无法区分两种完全不同的情况 ——
   *   ① 「thinking 关掉了，但这家通道本身就慢」；
   *   ② 「thinking 没关掉，参数被无视了」。
   * 两者的处置完全不同（前者忍、后者要改参数或换型号），
   * 所以体检必须给出「关掉 vs 不关」的实测差值。
   */
  control?: {
    latencyMs: number;
    reasoningChars: number;
    ok: boolean;
    detail: string;
  } | null;
}

/** 体检用的极短提示词：只求「这条链路通不通」，不关心内容质量。 */
const PROBE_PROMPT = '只回复两个字：正常';

/**
 * 体检单次调用的超时。必须明显小于网关的 65 秒：
 * 体检要连打两次（正测 + 去掉 thinking 的对照），留足余量才不会出现
 * 「体检本身 504、什么结论都拿不到」（那才是最尴尬的失败）。
 */
const PROBE_TIMEOUT_MS = 25_000;

/**
 * 整次体检的**总预算**。必须明显小于网关的 65 秒。
 *
 * 为什么要有它：单次 25 秒 × 通道数（还要算对照组）就是最坏耗时 ——
 * 3 条通道时已经是 75 秒，**本身就超了网关**，等于体检自己 504、什么结论都拿不到。
 * 通道只会越加越多，所以不能靠「数一数够不够」来保平安，
 * 改成每打一次就从剩余预算里扣。预算耗尽时剩余通道标为「跳过」而不是假装成功，
 * 这样结论句不会把「没测」误读成「不可用」。
 */
const PROBE_DEADLINE_MS = 55_000;

/**
 * 逐通道体检：对每个配置了 Key 的通道真实打一次极小的请求，把「通不通、通了多快、
 * 不通是为什么」原样返回。
 *
 * 存在的理由（血泪）：翻译通道挂了时，线上只有两个症状 —— 「文章不入库」或
 * 「钱全花在付费通道上」，而且**都不报错到界面**。原来要定位得跑完一整轮抓取
 * （实测 40–60 分钟）才在 `lastRun.summary.translation` 里看到一行报错。
 * 这个函数把同样的信息压成一次 GET，2026-09-19 就是这么发现
 * 「GLM-4.7 默认开 thinking → 单篇超时 → 降级到 DeepSeek」的。
 *
 * `latencyMs` 能看出「慢不慢」，但**判不出慢在谁身上** ——
 * 所以对配了 `extraBody` 的通道会再打一次**对照组**（去掉 extraBody），
 * 并结合响应里的 `reasoningChars` 给出结论：是 thinking 没关掉，还是通道本身排队。
 *
 * 注意它**不污染也不读取**全局统计（错误走 onError 回调），所以可以在抓取跑着的时候调。
 */

export async function probeTranslationProviders(): Promise<ProviderProbe[]> {
  const results: ProviderProbe[] = [];
  const probeStart = Date.now();
  /** 打完这一发还剩多少预算（至少留 PROBE_TIMEOUT_MS，否则说明该收手了） */
  const budgetLeft = () => PROBE_DEADLINE_MS - (Date.now() - probeStart);

  for (const provider of PROVIDERS) {
    const model = resolveModel(provider);
    const cost: ProviderProbe['cost'] = provider.free ? 'free' : 'paid';
    const keyConfigured = Boolean(process.env[provider.keyEnv]);

    if (!keyConfigured) {
      results.push({
        provider: provider.name,
        model,
        cost,
        keyConfigured: false,
        ok: false,
        detail: `未配置环境变量 ${provider.keyEnv}，该通道会被整条跳过`,
        latencyMs: 0,
      });
      continue;
    }

    // 预算见底就跳过，别让体检自己撞网关 65 秒。ok 保持 false，
    // detail 写明是「没测」而不是「测了不行」—— 两者结论完全不同。
    if (budgetLeft() < 3_000) {
      results.push({
        provider: provider.name,
        model,
        cost,
        keyConfigured: true,
        ok: false,
        detail: `总预算 ${PROBE_DEADLINE_MS}ms 已耗尽，本次未体检（前面的通道太慢，不代表这条不通）`,
        latencyMs: 0,
      });
      continue;
    }

    let firstError = '';
    const startedAt = Date.now();
    const call = await callChatProvider(provider, PROBE_PROMPT, {
      onError: (e) => {
        if (!firstError) firstError = e;
      },
      timeoutMs: Math.min(PROBE_TIMEOUT_MS, budgetLeft()),
    });
    const latencyMs = Date.now() - startedAt;

    // 对照组：只有配了 extraBody 的通道（本项目是智谱的 thinking 开关）才需要，
    // 用同一个极短提示词、去掉 extraBody 再打一次，把两次的耗时和 reasoning 长度摆在一起。
    let control: ProviderProbe['control'] = null;
    if (provider.extraBody && budgetLeft() > 3_000) {
      let controlError = '';
      const controlStart = Date.now();
      const controlCall = await callChatProvider(provider, PROBE_PROMPT, {
        extraOverride: {},
        onError: (e) => {
          if (!controlError) controlError = e;
        },
        timeoutMs: Math.min(PROBE_TIMEOUT_MS, budgetLeft()),
      });
      control = {
        latencyMs: Date.now() - controlStart,
        reasoningChars: controlCall.reasoningChars ?? 0,
        ok: Boolean(controlCall.text),
        detail: controlCall.text ? '正常' : controlError || '失败',
      };
    }

    results.push({
      provider: provider.name,
      model,
      cost,
      keyConfigured: true,
      ok: Boolean(call.text),
      detail: call.text
        ? `正常，模型回显：${call.text.slice(0, 60)}`
        : firstError || '失败，但没有拿到具体报错',
      latencyMs,
      requestExtra: provider.extraBody ?? {},
      reasoningChars: call.reasoningChars ?? 0,
      control,
    });
  }

  return results;
}
