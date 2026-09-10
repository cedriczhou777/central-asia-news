import { isChineseText } from './utils';

/**
 * 多模型新闻翻译：优先智谱，失败自动降级到平台豆包等模型，
 * 从根上减少“翻译失败导致原文入库/推送英文”的概率。
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

// ---- Provider 1：智谱（ZHIPU_API_KEY） ----
async function translateWithZhipu(title: string, content: string, sourceLanguage: string): Promise<TranslateResult | null> {
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) return null;

  const prompt = buildPrompt(title, content, sourceLanguage);
  try {
    const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'glm-4',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      }),
    });
    if (!response.ok) {
      console.error('智谱 AI 请求失败:', response.status, (await response.text()).substring(0, 200));
      return null;
    }
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const llmContent = data.choices?.[0]?.message?.content || '';
    if (!llmContent) return null;
    const parsed = parseLlmJson(llmContent);
    if (!parsed) return null;
    return normalizeResult(parsed, title, content, 'zhipu');
  } catch (err) {
    console.error('智谱 AI 调用异常:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ---- Provider 2：平台豆包（coze-coding-dev-sdk） ----
async function translateWithDoubao(title: string, content: string, sourceLanguage: string): Promise<TranslateResult | null> {
  try {
    const { LLMClient, Config } = await import('coze-coding-dev-sdk');
    const client = new LLMClient(new Config());
    const prompt = buildPrompt(title, content, sourceLanguage);
    const response = await client.invoke(
      [{ role: 'user', content: prompt }],
      { model: 'doubao-seed-2-0-lite-260215', temperature: 0.3 }
    );
    const llmContent = response.content || '';
    if (!llmContent) return null;
    const parsed = parseLlmJson(llmContent);
    if (!parsed) return null;
    return normalizeResult(parsed, title, content, 'doubao');
  } catch (err) {
    console.error('豆包翻译失败:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * 多模型翻译主入口：依次尝试智谱 → 豆包，中途成功即返回。
 * 若全部失败，返回 translated=false（内容保持原文但不入库，由调用方处理）。
 */
export async function translateNews(
  title: string,
  content: string,
  sourceLanguage: string
): Promise<TranslateResult> {
  const providers: Array<[string, () => Promise<TranslateResult | null>]> = [
    ['zhipu', () => translateWithZhipu(title, content, sourceLanguage)],
    ['doubao', () => translateWithDoubao(title, content, sourceLanguage)],
  ];

  for (const [name, fn] of providers) {
    for (let retry = 1; retry <= 3; retry++) {
      console.log(`开始调用 ${name} 翻译（第 ${retry}/3 次尝试）...`);
      try {
        const result = await fn();
        if (result && result.translated && result.contentZh !== content) {
          return result;
        }
        if (result && !result.translated) {
          console.log(`${name} 返回非有效中文，继续下次`);
          continue;
        }
      } catch (err) {
        console.error(`${name} 调用失败（第 ${retry} 次）:`, err instanceof Error ? err.message : err);
      }
      if (retry < 3) await new Promise((r) => setTimeout(r, 800));
    }
  }

  return {
    titleZh: title,
    summaryZh: content.substring(0, 100),
    contentZh: content,
    isInvestmentRelated: false,
    translated: false,
    provider: 'none',
  };
}