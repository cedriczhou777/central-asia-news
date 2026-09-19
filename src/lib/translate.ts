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
   - 原文中的图片 URL 保留为 HTML：<img src='图片 URL' style='width:100%; border-radius:8px; margin:15px 0;' />
   - 必须完整收尾，以句号结束，严禁省略号（...、……）或"等""等等"。
   - 原文若信息量太少（如纯图片配文、生活贴士、广告软文），如实浓缩，不要编造细节。
4. **category（分类）**：从以下枚举里选**最贴切的一个**（只输出 id，不要输出中文）：
{CATEGORIES}
5. **investorRelevant（投资者相关性）**：判断标准——经济形势、行业发展、能源/矿产/基建/制造业项目、外贸与投资协议、金融与汇率、国家政策法规、政局变动、影响营商环境的社会治安事件 → true；文体娱乐、生活方式、风俗礼节、与健康投资无关的日常琐事 → false。宁可从严。

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
 * 调用一个 OpenAI 兼容的 chat/completions 接口，返回模型输出的原始文本。
 * 任何失败（未配置 Key / 网络错误 / 非 2xx / 空响应）都返回 null，由调用方决定是否重试。
 */
async function callChatProvider(provider: ChatProvider, prompt: string): Promise<string | null> {
  const apiKey = process.env[provider.keyEnv];
  if (!apiKey) return null;

  const model = resolveModel(provider);

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
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const body = await response.text();
      const err = `HTTP ${response.status}: ${body.substring(0, 200)}`;
      console.error(`[${provider.name}/${model}] 请求失败 ${err}`);
      recordProviderError(provider.name, model, err);
      return null;
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const llmContent = data.choices?.[0]?.message?.content || '';
    if (!llmContent) {
      console.error(`[${provider.name}/${model}] 返回内容为空`);
      recordProviderError(provider.name, model, '返回内容为空');
      return null;
    }
    return llmContent;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${provider.name}/${model}] 调用异常:`, message);
    recordProviderError(provider.name, model, message);
    return null;
  }
}

const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 800;

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

      const raw = await callChatProvider(provider, prompt);
      if (raw) {
        const parsed = parseLlmJson(raw);
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
