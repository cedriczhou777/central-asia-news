/**
 * ★★ **编辑覆盖层**（2026-11-01 新增）。
 *
 * ## 它解决什么
 *
 * 外部审稿（人或模型）会逐条指出「这条要改 / 这条要删」。过去每次审稿落地都要
 * **改代码或手改数据库** ⇒ 每轮都是一次工程 ⇒ 不可持续 ⇒ 于是审稿意见只能停留在建议。
 *
 * ⇒ 这一层把「逐条改稿」变成**一份数据清单**：
 * · 清单在 `src/data/editorial-overrides.ts`（由 `scripts/build-editorial-overrides.ts`
 *   从审稿 md **自动提取**生成 ⇒ 不用手抄 50 多条）；
 * · 推送时按**标题**匹配 ⇒ 命中就覆盖标题/摘要、命中「删除」就跳过该条；
 * · **不动数据库** ⇒ 可随时改清单再重推、可回滚、不丢原始稿件。
 *
 * ⇒ ⇒ **以后每轮审稿只要加一份清单**，不用再动代码。
 *
 * ## 为什么只覆盖 title / summary，**不动 content**
 *
 * · 审稿意见给的是「标题 + 摘要」形态的替换稿 ⇒ 它对应的就是这两个字段；
 * · 正文是长文（含外链图），替换稿没有正文 ⇒ 动了反而会丢图、丢结构；
 * · 「来源：XXX」原本就在正文里 ⇒ 覆盖后仍然在。
 *
 * ## 匹配策略（宽松但有护栏）
 *
 * ⚠️ **匹配的是「审稿人看到的原标题」**（清单里的 `matchTitle`），
 *    **不是替换稿的标题** —— 替换稿的标题是**重写过的**，字面与原标题完全不同。
 *
 * 1. **精确**：归一化后完全相等（去空格与常见标点）；
 * 2. **包含**：一方是另一方的子串，**且较短的一方 ≥ 8 字**（防止短词误配）；
 * 3. 都没命中 ⇒ 记进 `unmatched`（**报告里能看见** ⇒ 下一轮补）。
 *
 * ⚠️ 匹配对象是**总审改写之后**的标题 ⇒ 与审稿人看到的（草稿里的）一致 ⇒ 对得上。
 */
import { EDITORIAL_OVERRIDES } from '@/data/editorial-overrides';

export interface EditorialOverrideOutcome {
  /** 覆盖了几条 */
  applied: number;
  /** 删除了几条 */
  dropped: number;
  /** 清单里没能匹配上的标题（可查 ⇒ 下一轮补） */
  unmatched: string[];
}

export interface EditorialOverrideArticle {
  title?: string;
  summary?: string;
  [k: string]: unknown;
}

/** 归一化：去掉空白与常见标点，只留可比的内容。 */
export function normTitle(s: string): string {
  return (s || '').replace(/[\s·、，。,.:：;；"'“”‘’「」『』（）()【】\[\]—–\-]/g, '');
}

/** 两段文本是否「算同一个标题」。 */
export function sameTitle(a: string, b: string): boolean {
  const x = normTitle(a);
  const y = normTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 8 && long.includes(short);
}

/**
 * 对一国的稿件应用编辑覆盖。
 *
 * @param countryCode 国家代码（kz / uz / kg / tj / az）
 * @param articles 该国的稿件（**总审改写之后**的版本）
 * @returns 留下来的稿件 + 处置统计
 */
export function applyEditorialOverrides<T extends EditorialOverrideArticle>(
  countryCode: string,
  articles: T[],
): { kept: T[]; outcome: EditorialOverrideOutcome } {
  const bucket = EDITORIAL_OVERRIDES.countries[countryCode];
  const outcome: EditorialOverrideOutcome = { applied: 0, dropped: 0, unmatched: [] };
  if (!bucket) return { kept: articles, outcome };

  const used = new Set<number>();

  const findIndex = (target: string): number => {
    for (let i = 0; i < articles.length; i++) {
      if (used.has(i)) continue;
      if (sameTitle(articles[i].title || '', target)) return i;
    }
    return -1;
  };

  // ---- 先处理「删除」----
  const droppedIdx = new Set<number>();
  for (const d of bucket.drop) {
    const i = findIndex(d.matchTitle);
    if (i < 0) {
      outcome.unmatched.push(`[删除] ${d.matchTitle}`);
      continue;
    }
    used.add(i);
    droppedIdx.add(i);
    outcome.dropped++;
  }

  // ---- 再处理「覆盖」（覆盖在删除之后 ⇒ 两边都命中同一篇时以删除为准）----
  const replacedIdx = new Map<number, { title: string; summary: string }>();
  for (const r of bucket.replace) {
    // ⚠️ **用 `matchTitle`（审稿人看到的原标题）匹配**，不是替换稿的标题
    // —— 替换稿的标题是**重写过的**，与稿件原标题字面完全不同 ⇒ 拿它匹配必然匹配不上。
    const i = findIndex(r.matchTitle);
    if (i < 0) {
      outcome.unmatched.push(`[覆盖] ${r.matchTitle}`);
      continue;
    }
    used.add(i);
    replacedIdx.set(i, { title: r.title, summary: r.summary });
    outcome.applied++;
  }

  const kept: T[] = [];
  for (let i = 0; i < articles.length; i++) {
    if (droppedIdx.has(i)) continue;
    const rep = replacedIdx.get(i);
    if (rep) {
      kept.push({ ...articles[i], title: rep.title, summary: rep.summary });
    } else {
      kept.push(articles[i]);
    }
  }
  return { kept, outcome };
}

/** 清单的元信息（报告里用）。 */
export function editorialOverridesMeta(): { generatedAt: string; source: string } {
  return { generatedAt: EDITORIAL_OVERRIDES.generatedAt, source: EDITORIAL_OVERRIDES.source };
}
