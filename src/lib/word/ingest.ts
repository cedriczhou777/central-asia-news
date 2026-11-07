/**
 * ★ Word 稿 → 结构化稿件（2026-11-07 新项目）。
 *
 * ## 输入格式约定（给 ChatGPT 的规格，见 `WORD-FORMAT.md`）
 *
 * ```
 * 【哈萨克斯坦】                 ← 国家分节（必需）
 * 1. 哈萨克斯坦农业贷款增至 6457 亿坚戈      ← 编号 + 标题
 *    正文第一段……
 *    正文第二段……
 *    来源：Tengrinews             ← 来源（建议）
 *    原文关键句：……                ← ★ 原文关键句（强烈建议，见下）
 * ```
 *
 * ## ⭐ 为什么「原文关键句」很重要
 *
 * 本项目最有价值的质检判据里，**有一半依赖原文**：
 * · 量级闸（原文 `4 млрд` ↔ 译文「4 亿」）—— 需要原文里的数字
 * · 机构名矛盾（原文 `EDB` ↔ 译文「欧洲复兴开发银行」）—— 需要原文里的缩写
 * ⇒ Word 稿本来没有原文 ⇒ ⇒ **让 ChatGPT 把含数字/机构名的那 1–3 句原文附上**
 * ⇒ ⇒ 这两类判据就能继续用（否则只剩一半能力）。
 *
 * ## 容错设计（ChatGPT 的输出不会 100% 规整）
 *
 * · 国家分节认 4 种写法：`【哈萨克斯坦】` / `## 哈萨克斯坦` / `# 哈萨克斯坦` / 单独一行「哈萨克斯坦」
 * · 稿件起始认 3 种：`1.` / `第1条` / `**1**`；**都没有**时 ⇒ 用「短标题行 + 后跟正文」启发式
 * · 「来源」认 `来源：` / `来源:` / `Source:`
 * · 「原文关键句」认 `原文关键句：` / `原文：` / `原文:`
 * · 末尾的「总计/汇总」类段落不当作稿件
 */
import { parseDocxParagraphs, type DocxParagraph } from './docx';

export type CountryCode = 'kz' | 'uz' | 'kg' | 'tj' | 'az';

export const COUNTRY_CODE_BY_CN: Record<string, CountryCode> = {
  哈萨克斯坦: 'kz',
  乌兹别克斯坦: 'uz',
  吉尔吉斯斯坦: 'kg',
  塔吉克斯坦: 'tj',
  阿塞拜疆: 'az',
};

export interface WordArticle {
  /** 序号（Word 里「第 N 条」；没有则按出现顺序） */
  index: number;
  countryCode: CountryCode;
  title: string;
  /** 正文（段落用 \n\n 分隔；已去掉标题行与来源行） */
  body: string;
  /** 来源（媒体名 / URL 文本） */
  sourceName: string | null;
  /** ★ 原文关键句（用于量级闸、机构名对照；没有就 null ⇒ 那两类判据跳过） */
  originalSnippet: string | null;
  /** 原文标题（如果 ChatGPT 给了） */
  originalTitle: string | null;
  /** 稿子里出现的日期（YYYY-MM-DD），没有就 null */
  publishedAt: string | null;
  /** 解析过程中发现的问题（给人看） */
  warnings: string[];
}

const CN_TO_CODE = COUNTRY_CODE_BY_CN;

/** 判断一行是不是「国家分节」 */
export function detectCountrySection(line: string): CountryCode | null {
  const s = line.trim();
  if (!s) return null;
  // 去掉 markdown 记号与方括号
  const bare = s.replace(/^[#>\s]+/, '').replace(/[【】\[\]（）()]/g, '').trim();
  if (Object.prototype.hasOwnProperty.call(CN_TO_CODE, bare)) return CN_TO_CODE[bare];
  // 「哈萨克斯坦投资资讯日报」这种带后缀的
  for (const [cn, code] of Object.entries(CN_TO_CODE)) {
    if (bare.startsWith(cn) && bare.length <= cn.length + 6) return code;
  }
  return null;
}

/** 判断一行是不是「稿件起始」（带编号） */
export function detectItemStart(line: string): { index: number | null; title: string } | null {
  const s = line.trim();
  if (!s) return null;
  const m = s.match(/^\*{0,2}(?:第\s*)?(\d{1,2})\s*(?:条|、|\.|．|）|\))?\*{0,2}\s*[｜|：:]?\s*(.+)$/);
  if (m) {
    const idx = Number(m[1]);
    const title = m[2].replace(/\*{2,}/g, '').replace(/^[｜|：:]\s*/, '').trim();
    if (title && title.length <= 120) return { index: idx, title };
  }
  return null;
}

function extractAfter(line: string, labels: string[]): string | null {
  for (const lb of labels) {
    const re = new RegExp(`^\\s*${lb}\\s*[:：]\\s*(.+)$`, 'i');
    const m = line.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

const SOURCE_LABELS = ['来源', '消息来源', 'Source', '出处'];
const ORIGINAL_LABELS = ['原文关键句', '原文', '原文中'];
const DATE_RE = /(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/;

/**
 * 解析 Word 稿 → 稿件数组。
 *
 * @param buf .docx 字节
 * @param fallbackDate 没有日期时用它（默认今天）
 */
export function parseWordDraft(
  buf: Buffer,
  fallbackDate?: string,
): { articles: WordArticle[]; warnings: string[] } {
  const paras: DocxParagraph[] = parseDocxParagraphs(buf);
  const warnings: string[] = [];

  const articles: WordArticle[] = [];
  let country: CountryCode | null = null;
  let current: WordArticle | null = null;
  let bodyParts: string[] = [];
  let autoIndex = 0;

  const flush = () => {
    if (!current) return;
    current.body = bodyParts.join('\n\n').trim();
    articles.push(current);
    current = null;
    bodyParts = [];
  };

  for (const p of paras) {
    const line = p.text.trim();

    // ① 国家分节
    const cc = detectCountrySection(line);
    if (cc) {
      flush();
      country = cc;
      continue;
    }
    if (!line) continue;

    // ② 来源行 / 原文关键句 / 日期 ⇒ 归给当前稿件
    const src = extractAfter(line, SOURCE_LABELS);
    const orig = extractAfter(line, ORIGINAL_LABELS);
    if (src !== null || orig !== null) {
      if (!current) {
        warnings.push(`发现「${line.slice(0, 30)}」但当前没有稿件上下文，已忽略`);
        continue;
      }
      if (src !== null) current.sourceName = src;
      if (orig !== null) current.originalSnippet = orig;
      const dm = line.match(DATE_RE);
      if (dm && !current.publishedAt) {
        current.publishedAt = `${dm[1]}-${String(Number(dm[2])).padStart(2, '0')}-${String(Number(dm[3])).padStart(2, '0')}`;
      }
      continue;
    }

    // ③ 新稿件起始
    const item = detectItemStart(line);
    if (item) {
      flush();
      autoIndex++;
      current = {
        index: item.index ?? autoIndex,
        countryCode: country ?? 'kz',
        title: item.title,
        body: '',
        sourceName: null,
        originalSnippet: null,
        originalTitle: null,
        publishedAt: null,
        warnings: [],
      };
      continue;
    }

    // ④ 无编号 ⇒ 启发式：短行（≤60 字）且不在国家分节后 ⇒ 当作标题
    if (!current) {
      if (line.length <= 60 && country) {
        autoIndex++;
        current = {
          index: autoIndex,
          countryCode: country,
          title: line,
          body: '',
          sourceName: null,
          originalSnippet: null,
          originalTitle: null,
          publishedAt: null,
          warnings: [],
        };
        continue;
      }
      warnings.push(`跳过了无法归属的段落：「${line.slice(0, 30)}」`);
      continue;
    }

    // ⑤ 正文
    bodyParts.push(line);
    // ⭐ 日期常出现在**正文**里（「截至2026年10月1日」）⇒ 正文也要扫
    if (current && !current.publishedAt) {
      const dm = line.match(DATE_RE);
      if (dm) {
        current.publishedAt = `${dm[1]}-${String(Number(dm[2])).padStart(2, '0')}-${String(Number(dm[3])).padStart(2, '0')}`;
      }
    }
  }
  flush();

  // ⑥ 收尾检查
  // ⚠️ 稿件级 warnings 汇总到**顶层**（不留在 article 上 ⇒ 避免下游拿到 undefined）
  for (const a of articles) {
    if (!a.body) warnings.push(`第 ${a.index} 条没有正文`);
    if (!a.sourceName) warnings.push(`第 ${a.index} 条没有来源`);
    if (!a.originalSnippet) warnings.push(`第 ${a.index} 条没有「原文关键句」⇒ 量级闸与机构名对照会跳过它`);
    if (!a.publishedAt) a.publishedAt = fallbackDate ?? null;
  }

  return { articles, warnings };
}
