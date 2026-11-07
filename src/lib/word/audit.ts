/**
 * ★ Word 稿的**校核报告**（2026-11-07 新项目）。
 *
 * ## 设计要点：**只报告，不改稿**
 *
 * 原项目的质检是「拦截 → 带修正说明让模型重试 → 再命中就放行」——
 * 那是为**机器写的稿子**设计的（稿子由模型产出，闸有权让它重写）。
 * ⇒ 而新方案的稿子是**ChatGPT 写的、人要过目的** ⇒ ⇒ 闸不该替人做决定。
 * ⇒ 所以这里**只出报告**：每条问题都写清「错在哪 / 建议怎么改」，
 * ⇒ 报告可**直接贴回 ChatGPT** 让它改 ⇒ ⇒ 形成「上传 → 校核 → 回喂 → 重传」闭环。
 *
 * ## 复用了哪些判据（全部来自原项目，**零改动**）
 *
 * | 判据 | 来源 | 需要原文？ |
 * |---|---|---|
 * | 数字顺序颠倒 / 广告痕迹 / 币种换算 / 期间口径 / 标题地名冲突 / 机构名张冠李戴 / 元评语 / 量词歧义 | `content-gate.ts` 的 `findContentIssues` | 部分（机构名的「原文矛盾」子路径要） |
 * | 量级错（`4 млрд` → 「4 亿」） | `magnitude-guard.ts` 的 `findMagnitudeMismatches` | ✅ 要 |
 * | 俄语残留 | `utils.ts` 的 `stripCyrillicRuns` | ❌ |
 * | 标题重复国名 | `utils.ts` 的 `dedupeRepeatedCountry` | ❌ |
 * | 批内疑似重复 | 本文件自带的轻量标题相似度 | ❌ |
 *
 * ⚠️ **量级闸要原文里有俄语量级词**（`млрд` / `млн` / `тыс`）⇒ ⇒ Word 的「原文关键句」
 * **必须保留原文语言**（不要让 ChatGPT 翻译成中文）⇒ 否则这一类校核会失效。
 */
import { findContentIssues } from '@/lib/content-gate';
import { findMagnitudeMismatches, describeMagnitudeMismatch } from '@/lib/magnitude-guard';
import { stripCyrillicRuns, dedupeRepeatedCountry } from '@/lib/utils';
import type { WordArticle, CountryCode } from './ingest';

export type Severity = 'high' | 'medium' | 'low';

export interface AuditFinding {
  country: CountryCode;
  index: number;
  title: string;
  severity: Severity;
  /** 判据名（机器可读） */
  kind: string;
  /** 人类可读：错在哪 + 建议怎么改 */
  message: string;
  /** 命中的原文片段 */
  sample: string;
}

export interface AuditReport {
  total: number;
  byCountry: Record<string, { total: number; findings: number }>;
  findings: AuditFinding[];
  /** 整体层面的提醒（缺原文关键句、缺来源、疑似重复…） */
  notes: string[];
  /** 生成时间 */
  generatedAt: string;
}

/** 判据 → 严重度。⚠️ 「有颠覆性问题才改」⇒ 高严重度才是必须改的。 */
const SEVERITY_BY_KIND: Record<string, Severity> = {
  'numbers-out-of-order': 'high',
  'currency-converted': 'high',
  'period-mismatch': 'high',
  'org-name-mismatch': 'high',
  'magnitude-mismatch': 'high',
  'title-place-conflict': 'medium',
  advertisement: 'medium',
  'meta-comment': 'medium',
  'mixed-script-name': 'medium',
  'ambiguous-quantifier': 'low',
  'kin-unclear': 'low',
};

/** 轻量标题相似度（用于「疑似重复」提示）。⚠️ 只报提示，不删稿。 */
function titleSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.replace(/[\s·、，。,.:：;；"'"''（）()【】\[\]—–\-]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const setB = new Set(Array.from(y));
  let hit = 0;
  for (const ch of new Set(Array.from(x))) if (setB.has(ch)) hit++;
  return hit / Math.max(new Set(Array.from(x)).size, new Set(Array.from(y)).size);
}

/**
 * 对一批 Word 稿做校核，产出报告。
 *
 * @param articles 解析出来的稿件
 */
export function auditWordArticles(articles: WordArticle[]): AuditReport {
  const findings: AuditFinding[] = [];
  const notes: string[] = [];
  const byCountry: Record<string, { total: number; findings: number }> = {};

  for (const a of articles) {
    const bucket = (byCountry[a.countryCode] ||= { total: 0, findings: 0 });
    bucket.total++;
    const full = `${a.title}\n${a.body}`;
    const original = a.originalSnippet ?? '';

    // ① 内容层判据
    const issues = findContentIssues(`${a.title}\n`, full, original ? { originalText: original } : undefined);
    for (const i of issues) {
      findings.push({
        country: a.countryCode,
        index: a.index,
        title: a.title,
        severity: SEVERITY_BY_KIND[i.kind] ?? 'low',
        kind: i.kind,
        message: i.detail,
        sample: i.sample,
      });
    }

    // ② 量级闸（要原文；且原文要有俄语量级词才有效）
    if (original) {
      const mm = findMagnitudeMismatches(original, full);
      for (const m of mm) {
        findings.push({
          country: a.countryCode,
          index: a.index,
          title: a.title,
          severity: 'high',
          kind: 'magnitude-mismatch',
          message: describeMagnitudeMismatch(m),
          sample: a.title,
        });
      }
      if (!/[млнрдтыс]\b|\d\s*(?:млн|млрд|тыс)/i.test(original) && !/\d/.test(original)) {
        notes.push(`第 ${a.index} 条的「原文关键句」里没有数字 ⇒ 量级闸对这条无效`);
      }
    } else {
      notes.push(`第 ${a.index} 条没有「原文关键句」⇒ 量级闸与机构名「原文矛盾」对这条**无效**`);
    }

    // ③ 俄语残留（中文稿里出现西里尔 ⇒ 多半是没译干净的原文片段）
    const cyr = stripCyrillicRuns(full);
    if (cyr.removed.length > 0) {
      findings.push({
        country: a.countryCode,
        index: a.index,
        title: a.title,
        severity: 'medium',
        kind: 'cyrillic-leftover',
        message:
          `正文里还有 ${cyr.removed.length} 处没译干净的西里尔文（${cyr.removed.map((x) => `「${x.slice(0, 20)}」`).join('、')}）` +
          `⇒ 请让 ChatGPT 把这些片段完整译成中文。`,
        sample: cyr.removed[0] ?? '',
      });
    }

    // ④ 标题重复国名
    const dedup = dedupeRepeatedCountry(a.title);
    if (dedup.changed) {
      findings.push({
        country: a.countryCode,
        index: a.index,
        title: a.title,
        severity: 'low',
        kind: 'repeated-country-in-title',
        message: `标题里国名重复了（「${a.title}」）⇒ 建议写成「${dedup.title}」。`,
        sample: a.title,
      });
    }

    // ⑤ 缺来源 / 缺正文
    if (!a.sourceName) {
      findings.push({
        country: a.countryCode,
        index: a.index,
        title: a.title,
        severity: 'medium',
        kind: 'missing-source',
        message: '这条没有「来源：」⇒ 日报里没有出处，读者无法核实。',
        sample: a.title,
      });
    }
    if (!a.body) {
      findings.push({
        country: a.countryCode,
        index: a.index,
        title: a.title,
        severity: 'high',
        kind: 'empty-body',
        message: '这条没有正文。',
        sample: a.title,
      });
    }
  }

  // ⑥ 批内疑似重复（同一国里标题高度相似的两条）
  for (const code of Object.keys(byCountry)) {
    const group = articles.filter((a) => a.countryCode === code);
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const sim = titleSimilarity(group[i].title, group[j].title);
        if (sim >= 0.75 && sim < 1) {
          findings.push({
            country: group[i].countryCode,
            index: group[i].index,
            title: group[i].title,
            severity: 'medium',
            kind: 'possible-duplicate',
            message:
              `第 ${group[i].index} 条与第 ${group[j].index} 条标题相似度 ${(sim * 100).toFixed(0)}%` +
              `（「${group[j].title}」）⇒ 疑似同一件事的重复报道，建议合并或只留一条。`,
            sample: group[j].title,
          });
        }
      }
    }
  }

  for (const code of Object.keys(byCountry)) byCountry[code].findings = findings.filter((f) => f.country === code).length;

  const notes2 = [...new Set(notes)];
  return {
    total: articles.length,
    byCountry,
    findings,
    notes: notes2,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 把报告导出成**可直接贴回 ChatGPT 的修正清单**（Markdown）。
 *
 * ⭐ 这是闭环的关键：报告不是给人看的，是**回喂给模型的指令**。
 */
export function renderFixList(report: AuditReport): string {
  const lines: string[] = [];
  lines.push('# 五国日报稿件校核报告');
  lines.push('');
  lines.push(`共 ${report.total} 条稿件，发现 ${report.findings.length} 处问题。`);
  lines.push('');
  const high = report.findings.filter((f) => f.severity === 'high');
  const mid = report.findings.filter((f) => f.severity === 'medium');
  const low = report.findings.filter((f) => f.severity === 'low');

  for (const [label, arr] of [
    ['必须修改（事实/数字类）', high],
    ['建议修改（可读性/一致性）', mid],
    ['可选修改（措辞）', low],
  ] as const) {
    if (!arr.length) continue;
    lines.push(`## ${label}（${arr.length}）`);
    lines.push('');
    for (const f of arr) {
      lines.push(`### 第 ${f.index} 条｜${f.title}`);
      lines.push(`- 国别：${f.country}`);
      lines.push(`- 问题：${f.message}`);
      if (f.sample) lines.push(`- 片段：${f.sample}`);
      lines.push('');
    }
  }
  if (report.notes.length) {
    lines.push('## 全局提醒');
    lines.push('');
    for (const n of report.notes) lines.push(`- ${n}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('请按上述清单逐条修改后，重新输出完整 Word 稿（保持同样的分节与编号格式）。');
  return lines.join('\n');
}
