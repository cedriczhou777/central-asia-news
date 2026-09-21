import { isChineseText } from './utils';
import type { Category } from './data/types';

/**
 * 多模型新闻翻译 + 理解：按顺序尝试多个 OpenAI 兼容的大模型接口，任一成功即返回。
 *
 * 2026-09-19 起这个调用承担的不再只是「翻译」，而是完整的「理解」：
 *   - 中文标题（具体、含人物/机构/事件）
 *   - 100 字摘要（5W1H）
 *   - 约 300 字的事实性综述（时间、人物、地点、数字、因果）
 *   - 分类（大类 + 小类，见 CATEGORY_IDS）
 *   - 面向国际投资者的相关性判断（文体娱乐、社会琐事 → false，直接不入库）
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

const TRANSLATE_PROMPT = `你是一位面向国际投资者的中亚与南高加索新闻编辑。读者是考虑在哈萨克斯坦、乌兹别克斯坦、吉尔吉斯斯坦、塔吉克斯坦、阿塞拜疆投资的人。

请阅读下面这篇{LANG}新闻，输出结构化结果。

原始标题：{TITLE}

原始内容：
{CONTENT}

输出要求：

1. **title（中文标题）**：具体、信息完整，含关键人物/机构、事件、地点、金额或数字。禁止"某事取得进展"这类空泛表述。
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
5. **investorRelevant（投资者相关性）**：判断标准——经济形势、行业发展、能源/矿产/基建/制造业项目、外贸与投资协议、金融与汇率、国家政策法规、政局变动、影响营商环境的社会治安事件 → true；文体娱乐、生活方式、风俗礼节、与健康投资无关的日常琐事 → false。宁可从严。

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

function langLabel(sourceLanguage: string): string {
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

// 把一次成功的 LLM 输出规整为 Result（中文验证）
function normalizeResult(
  parsed: Record<string, unknown>,
  originalTitle: string,
  originalContent: string,
  provider: string
): TranslateResult {
  const titleZh = typeof parsed.title === 'string' ? parsed.title : originalTitle;
  const summaryZh = typeof parsed.summary === 'string' ? parsed.summary : originalContent.substring(0, 100);
  const contentZh = typeof parsed.content === 'string' ? parsed.content : originalContent;
  const ok = isChineseText(titleZh) && isChineseText(contentZh);

  const rawCategory = typeof parsed.category === 'string' ? parsed.category : '';
  const category = (CATEGORY_IDS as string[]).includes(rawCategory)
    ? (rawCategory as Category)
    : null;

  return {
    titleZh: ok ? titleZh : originalTitle,
    summaryZh: ok ? summaryZh : originalContent.substring(0, 100),
    contentZh: ok ? contentZh : originalContent,
    category: ok ? category : null,
    investorRelevant: ok && parsed.investorRelevant === true,
    translated: ok,
    provider,
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
  const { onError, extraOverride, timeoutMs = CALL_TIMEOUT_MS, recordError = true } = options;
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
        temperature: 0.3,
        // provider 专属参数（如智谱的 thinking 开关）在这里展开，
        // 见 ChatProvider.extraBody 的说明 —— 不能全局写死，否则会串到别的厂商。
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
  options: { timeoutMs?: number; extraBody?: Record<string, unknown> } = {},
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
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
      // 传了就是覆盖该通道的默认 extraBody（例如给「判组」这类推理任务打开 thinking）。
      // 不传则沿用通道默认值（翻译链路关掉 thinking 的那个设置）。
      ...(options.extraBody ? { extraOverride: options.extraBody } : {}),
      onError: (err) => failures.push(`${provider.name}：${err}`),
    });
    if (call.text) return { ok: true, text: call.text };
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

  for (const provider of PROVIDERS) {
    if (!process.env[provider.keyEnv]) {
      unconfigured.push(`${provider.name}（缺少 ${provider.keyEnv}）`);
      continue;
    }

    const model = resolveModel(provider);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      console.log(`[translate] ${provider.name}/${model} 第 ${attempt}/${MAX_ATTEMPTS} 次尝试...`);

      const call = await callChatProvider(provider, prompt);
      if (call.text) {
        const parsed = parseLlmJson(call.text);
        if (parsed) {
          const result = normalizeResult(parsed, title, content, provider.name);
          if (result.translated && result.contentZh !== content) {
            translationStats.providerCounts[provider.name] =
              (translationStats.providerCounts[provider.name] || 0) + 1;
            return result;
          }
          console.log(`[translate] ${provider.name} 返回内容未通过中文校验，继续重试`);
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
