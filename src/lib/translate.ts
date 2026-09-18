import { isChineseText } from './utils';

/**
 * 多模型新闻翻译：按顺序尝试多个 OpenAI 兼容的大模型接口，任一成功即返回。
 *
 * 设计要点
 * --------
 * - 所有 provider 都走 OpenAI 兼容的 /chat/completions，新增一家只需往 PROVIDERS 里加一条。
 * - 每个 provider 的 Key 与模型名都从环境变量读取，未配置 Key 的 provider 直接跳过，
 *   不做无意义的重试（旧版会把没配 Key 的模型硬重试 3 次，白等 2.4 秒）。
 * - 已移除对扣子专属 SDK（coze-coding-dev-sdk）的依赖，备用通道不再绑定扣子平台。
 */
export interface TranslateResult {
  titleZh: string;
  summaryZh: string;
  contentZh: string;
  isInvestmentRelated: boolean;
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
    // 智谱 GLM-4.7-Flash：当前免费档，200K 上下文，国内直连。
    // 注意免费档限制为「同时 1 个并发」，本项目是顺序翻译，正好不受影响。
    // 若控制台的免费型号代号有变，改 ZHIPU_MODEL 环境变量即可，不必改代码。
    name: 'zhipu',
    keyEnv: 'ZHIPU_API_KEY',
    modelEnv: 'ZHIPU_MODEL',
    defaultModel: 'glm-4.7-flash',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  },
  {
    // DeepSeek：按量付费，价格极低，作为降级通道。
    //
    // 型号历史（别再改回去）：旧默认值 `deepseek-chat` 已被官方下线。
    // 2026-09 查 https://api-docs.deepseek.com/quick_start/pricing，
    // 当前在售型号只有 `deepseek-flash`（DeepSeek-V4.1-Flash）和 `deepseek-v4-pro`；
    // 文档里明确「仍然接受」的旧名只有 `deepseek-v4-flash`，不含 `deepseek-chat`。
    // 用错型号的表现是：通道一调用就 400，降级链等于没有 —— 而且**不会报错到用户面前**，
    // 只会在日志里留一行 `[deepseek/xxx] 请求失败 400`。
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

const TRANSLATE_PROMPT = `你是一位专业的中亚地区新闻翻译编辑，专注于为中国投资者提供高质量的中亚投资资讯。

请将以下{LANG}新闻翻译为中文。

原始标题：{TITLE}

原始内容：
{CONTENT}

翻译要求：
1. **标题**：必须准确反映新闻核心内容，包含关键人物/机构、事件、地点。避免笼统表述（如"比赛进入激烈阶段"），要具体（如"乌兹别克斯坦与塞尔维亚签署 5 亿美元能源合作协议"）。
2. **摘要**：100 字以内，必须包含 5W1H（谁、做了什么、何时、何地、为什么、如何）。让读者一眼了解新闻要点。
3. **正文**：
   - 语法正确，逻辑清晰，人物时间地点明确
   - 保持原文段落结构
   - 如果原文中有图片 URL，直接保留为 HTML img 标签：<img src='图片 URL' style='width:100%; border-radius:8px; margin:15px 0;' />
   - 尽量控制在 300 字以内，用简洁但完整的语言概述原新闻的核心事实，不要泛泛而谈
   - **必须完整收尾，结尾以句号结束，严禁出现省略号（...、……）或"等""等等"等截断性表述**
4. **投资相关性判断**：只有真正与投资环境、政策、项目、经贸合作相关的新闻才标记为投资相关。不要只要有"投资"两个字就认为是投资新闻。家庭、教育、体育等社会新闻除非直接影响投资环境，否则不算投资新闻。

请严格按以下 JSON 格式输出（不要输出其他内容）：
{
  "title": "翻译后的中文标题（准确、具体）",
  "summary": "100 字以内的中文摘要（包含 5W1H）",
  "content": "完整的中文翻译（语法正确，逻辑清晰，250 字以内）",
  "isInvestmentRelated": true/false（是否真正与投资相关）
}`;

function langLabel(sourceLanguage: string): string {
  if (sourceLanguage === 'en') return '英文';
  if (sourceLanguage === 'ru') return '俄文';
  return '其他语言';
}

function buildPrompt(title: string, content: string, sourceLanguage: string): string {
  return TRANSLATE_PROMPT
    .replace('{LANG}', langLabel(sourceLanguage))
    .replace('{TITLE}', title)
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
  return {
    titleZh: ok ? titleZh : originalTitle,
    summaryZh: ok ? summaryZh : originalContent.substring(0, 100),
    contentZh: ok ? contentZh : originalContent,
    isInvestmentRelated: ok && parsed.isInvestmentRelated === true,
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
      console.error(`[${provider.name}/${model}] 请求失败 ${response.status}: ${body.substring(0, 200)}`);
      return null;
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const llmContent = data.choices?.[0]?.message?.content || '';
    if (!llmContent) {
      console.error(`[${provider.name}/${model}] 返回内容为空`);
      return null;
    }
    return llmContent;
  } catch (err) {
    console.error(`[${provider.name}/${model}] 调用异常:`, err instanceof Error ? err.message : err);
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
  }
  console.error('[translate] 所有翻译通道均失败，本篇将不入库（保持中文优先策略）');

  return {
    titleZh: title,
    summaryZh: content.substring(0, 100),
    contentZh: content,
    isInvestmentRelated: false,
    translated: false,
    provider: 'none',
  };
}
