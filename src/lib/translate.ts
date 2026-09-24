import { isChineseText, mixedScriptTokens, mixedScriptTokensLatin, MIN_HAN_TITLE, MIN_HAN_CONTENT } from './utils';
import type { Category } from './data/types';

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
 * 2. **专有名词写法：人名 / 公司名 / 机构名 / 项目名保留拉丁字母；
 *    国名、州/自治共和国、城市等地名继续用中文**（见提示词第 6 条）。
 *    理由：中亚/高加索**人名与公司名**的汉字音译各家不统一、常常不准，投资者按拉丁写法反而检索得到；
 *    而**国名与地名**国内早有通用译名（哈萨克斯坦、阿斯塔纳、塔什干），换成英文反而不好读。
 *
 *    ⚠️ **2026-09-23 改过两次口径，别照前两版的记忆改回来**：
 *    原口径是「只人名拉丁，机构名/公司名/地名照常中文」，实测**根本没被执行** ——
 *    7 天 × 5 国 1757 篇里，同一个人的名字**两种写法并存是主流**
 *    （Aliyev 中文 57 篇 / 拉丁 22 篇、Japarov 36/12、Tokayev 23/14），
 *    其中分别有 4 / 3 / 2 篇**同一篇里两种都出现**；另有 **3.2% 的篇目**含
 *    `米尔зиёё夫`／`肯еш` 这种「汉字+西里尔」挤在一个词里的怪写法。
 *    且**不是源的问题**：同一个源（AZERTAC / Kabar / Egemen）同一天两种写法都产出过。
 *    中途一度定成「专有名词全部拉丁」，用户随即收窄为
 *    「国名和州名这类国内已经通用的专有名词还是用中文」⇒ **现在是第三种口径**。
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
  /** 每个通道遇到的第一个错误（provider + 具体报错），排查「免费档为什么没生效」就靠它 */
  errors: Array<{ provider: string; model: string; error: string }>;
}

let translationStats: TranslationStats = { providerCounts: {}, errors: [] };

export function resetTranslationStats() {
  translationStats = { providerCounts: {}, errors: [] };
}

export function getTranslationStats(): Readonly<TranslationStats> {
  return translationStats;
}

function recordProviderError(provider: string, model: string, error: string) {
  // 每个通道只记第一个错误，够定位就行，不刷屏
  if (!translationStats.errors.some((e) => e.provider === provider)) {
    translationStats.errors.push({ provider, model, error });
  }
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

6. **专有名词写法（重要，2026-09-23 定稿口径）**：
   **人名、公司名、机构名、项目/计划名 → 写出拉丁字母**；
   **国名、州/自治共和国等地名 → 继续用中文**（国内已有通用译名，不要换成英文）。

   - **人名 → 拉丁字母**（该人名的通行英文转写），**不要**音译成汉字：
     Токаев → Tokayev；Мирзиёев → Mirziyoyev；Жапаров → Japarov；Әлиев → Aliyev；Раҳмон → Rahmon。
     原文用西里尔字母时，按**通行英文转写**写（俄语 -ov/-ev/-in 体系；哈萨克语 -uly/-kyzy 或 -ov 体系，
     取最常见写法），不要自己按字母硬拼。人名不要加引号、括号或「先生/女士」之类称谓。
   - **公司名 / 机构名 / 项目计划名 → 拉丁字母**（该名称通行的拉丁写法或官方英文名）：
     哈萨克铜业 → Kazakhmys；亚洲基础设施投资银行 → AIIB；世界银行 → World Bank；
     欧洲复兴开发银行 → EBRD；伊斯兰开发银行 → IsDB；欧佩克+ → OPEC+。
     原本就以拉丁字母通行的名字原样保留（KEGOC / KTZ / AZAL / SOCAR / KazMunayGas / AzerGold /
     Kazakhtelecom / UzAuto / AiSalyk），不要改写或翻译成中文。
   - **国名 → 中文**：哈萨克斯坦、乌兹别克斯坦、吉尔吉斯斯坦、塔吉克斯坦、阿塞拜疆、土库曼斯坦、
     俄罗斯、中国、美国、土耳其、伊朗、格鲁吉亚、亚美尼亚、白俄罗斯、乌克兰。
     ⚠️ **不要**写成 Kazakhstan / Uzbekistan / Kyrgyzstan / Azerbaijan 这类英文。
   - **州 / 自治共和国等一级行政区 → 中文**：东哈萨克斯坦州、曼格斯套州、卡拉干达州、科斯塔奈州、
     苏格德州、哈特隆州、纳希切万自治共和国、卡拉卡尔帕克斯坦共和国。
   - **城市与一般地名 → 中文**（国内已有通用译名的，继续用中文）：阿斯塔纳、阿拉木图、塔什干、
     比什凯克、杜尚别、巴库、苦盏（胡占德）、奥什、塞梅伊、阿克托别、杰兹卡兹甘、纳希切万。
     ⚠️ 只有**确实没有通用中文译名**的小地名（小村镇、小河、小行政区）才写拉丁转写，
     而且必须写成一个**完整的拉丁词** —— 绝不允许出现「霍贾and」「斯皮塔梅en」「纳赫ichevan」
     这种「汉字 + 拉丁字母」拼起来的残缺写法。
   - **职务与机构通名 → 中文**：总统、副总理、部长、议会、政府、外交部、内务部、央行、州长、
     市长、法院、委员会、国家税务局、教育部。「市 / 州 / 区 / 县 / 自治共和国」这些通名也是中文。
     ⚠️ **不要**把通名翻成英文单词 —— 译文里不要出现 President / Parliament / Ministry / Company
     这类英文词。正确写法示例：哈萨克斯坦总统 Tokayev；阿斯塔纳市；AIIB 提供的 60 亿美元贷款；
     吉尔吉斯斯坦议会。
   - **货币、度量衡、语言、民族、宗教 → 中文**：坚戈、马纳特、苏姆、美元、吨、公里、公顷、
     俄语、哈萨克语、乌兹别克族、伊斯兰教。
   - ⚠️ **同一个实体，全篇只能有一种写法**：不许一处写「哈萨克斯坦」、另一处写 Kazakhstan；
     不许一处写「塔什干」、另一处写 Tashkent；不许一处写「托卡耶夫」、另一处写 Tokayev。
   - ⚠️ **严禁把一个词写成「汉字 + 西里尔/拉丁」拼接**（例如 米尔зиёё夫、肯еш、霍贾and、哈萨克mys）。
     除引用原文标题（放在《》里）外，译文里**不得出现西里尔字母**。

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
  if (sourceLanguage === 'ky' || sourceLanguage === 'kk') return '中亚突厥语族语言（吉尔吉斯语/哈萨克语）';
  if (sourceLanguage === 'az') return '阿塞拜疆语';
  return '其他语言';
}

function buildPrompt(title: string, content: string, sourceLanguage: string): string {
  return TRANSLATE_PROMPT
    .replace('{LANG}', langLabel(sourceLanguage))
    .replace('{TITLE}', title)
    .replace('{CATEGORIES}', CATEGORY_ENUM_TEXT)
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
  kind: 'mixed-script' | 'half-translated';
  /** 被拦下的词（截断到前几个） */
  tokens: string[];
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
  const what =
    reject.kind === 'half-translated'
      ? '专有名词被译了一半 —— 汉字后面残留了一段拉丁字母'
      : '汉字与西里尔字母挤在同一个词里';
  return [
    '',
    '⚠️ 你上一次的输出**没有通过质检**，原因：' + what + '。',
    '被拦下的词：' + reject.tokens.slice(0, 8).join('、'),
    '请**重新**输出完整 JSON，并把上面这些专有名词改成**要么是完整的中文译名、要么是完整的拉丁写法**，',
    '绝对不要再出现「汉字 + 字母」拼起来的残缺写法。正确示例：',
    '  「斯皮塔梅en区」→「Spitamen 区」（该地名无通用中文译名 ⇒ 用完整拉丁写法）',
    '  「阿克tau市」→「阿克套市」',
    '  「霍贾and市」→「苦盏市」或「Khujand 市」',
    '以上要求本身不要写进 content —— content 里只写读者要读的新闻内容。',
  ].join('\n');
}

// 把一次成功的 LLM 输出规整为 Result（中文验证）
function normalizeResult(
  parsed: Record<string, unknown>,
  originalTitle: string,
  originalContent: string,
  provider: string
): { result: TranslateResult; reject?: GateReject } {
  const titleZh = typeof parsed.title === 'string' ? parsed.title : originalTitle;
  const summaryZh = typeof parsed.summary === 'string' ? parsed.summary : originalContent.substring(0, 100);
  const contentZh = typeof parsed.content === 'string' ? parsed.content : originalContent;

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
  const ok = zhOk && mixed.length === 0 && halfTranslated.length === 0;
  if (zhOk && mixed.length > 0) {
    console.log(`[translate] 译文含「汉字+西里尔」混排词 ${mixed.slice(0, 6).join('/')}，判不合格并重试`);
  }
  if (zhOk && halfTranslated.length > 0) {
    console.log(
      `[translate] 译文含「汉字+拉丁」半译专名 ${halfTranslated.slice(0, 6).join('/')}，判不合格并重试`,
    );
  }

  const rawCategory = typeof parsed.category === 'string' ? parsed.category : '';
  const category = (CATEGORY_IDS as string[]).includes(rawCategory)
    ? (rawCategory as Category)
    : null;

  // 拒绝原因 —— 决定重试时要不要带修正指令（见 buildRepairHint）。
  // 语言闸不过（模型把原文回显了）**不带**修正指令：那不是「专名写法」的问题，
  // 让它按原样重译即可。
  const reject: GateReject | undefined = !zhOk
    ? undefined
    : halfTranslated.length > 0 || mixed.length > 0
      ? {
          kind: halfTranslated.length > 0 ? 'half-translated' : 'mixed-script',
          tokens: [...new Set([...halfTranslated, ...mixed])],
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

  /** 统一的失败出口：记日志 + 记统计 + 通知调用方，三处都别漏 */
  const fail = (err: string, retryable: boolean): ChatCallResult => {
    console.error(`[${provider.name}/${model}] ${err}`);
    if (recordError) recordProviderError(provider.name, model, err);
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
      // 429（限流）和 5xx（服务端抖动）值得重试；
      // 其余 4xx（401 Key 无效 / 404 型号不存在 / 400 参数非法）是配置问题，重试无意义。
      return fail(
        `HTTP ${response.status}: ${body.substring(0, 200)}`,
        response.status === 429 || response.status >= 500,
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    };
    const message = data.choices?.[0]?.message;
    const llmContent = message?.content || '';
    const reasoningChars = (message?.reasoning_content || '').length;
    if (!llmContent) {
      // 兼容「思考型模型把内容全放进 reasoning_content、content 为空」的情况，
      // 报错时把这点写清楚，省得对着空响应猜。
      return fail(reasoningChars > 0 ? '返回内容为空（只有 reasoning_content）' : '返回内容为空', true);
    }
    return { text: llmContent, retryable: false, reasoningChars };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 超时 / 网络异常一律不重试：说明这个通道**当前不可用**，不是「再试一次就好」。
    // 旧版在这里硬重试 3 次（最坏 3 分钟/篇），166 篇就是几个小时，而且最后照样
    // 降级到付费通道。直接换下一个通道，让降级链干它该干的事。
    return fail(`调用异常: ${message}`, false);
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
  } = {},
): Promise<{ ok: true; text: string; provider: string } | { ok: false; error: string }> {
  const { timeoutMs = CALL_TIMEOUT_MS } = options;
  const failures: string[] = [];

  for (const provider of PROVIDERS) {
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
 */
export async function translateNews(
  title: string,
  content: string,
  sourceLanguage: string
): Promise<TranslateResult> {
  const prompt = buildPrompt(title, content, sourceLanguage);
  const unconfigured: string[] = [];
  /**
   * 质检失败后的修正指令（见 `buildRepairHint`）。
   * **跨通道保留**：一个通道三次都不过、切到下一个通道时，下一个通道也该知道
   * 「上一家错在哪」，而不是从零再错三遍 —— 那样只会把丢稿概率乘起来。
   */
  let repairHint = '';

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
          const { result, reject } = normalizeResult(parsed, title, content, provider.name);
          if (result.translated && result.contentZh !== content) {
            translationStats.providerCounts[provider.name] =
              (translationStats.providerCounts[provider.name] || 0) + 1;
            return result;
          }
          if (reject) {
            // 质检拦下专名写法 ⇒ 下一次重试带上「错在哪、该改成什么」
            repairHint = buildRepairHint(reject);
            console.log(
              `[translate] 质检拦下（${reject.kind}）：${reject.tokens.slice(0, 6).join('/')} ⇒ 重试带修正指令`,
            );
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
