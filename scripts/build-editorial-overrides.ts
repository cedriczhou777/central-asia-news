/**
 * 一次性脚本（2026-11-01）：把 ChatGPT 的《五国日报最终审稿意见》md
 * **解析成一份编辑覆盖清单**（JSON）。
 *
 * ## 为什么要有这个脚本
 *
 * 逐条改稿如果靠「人手改代码/手敲数据库」⇒ 每次审核都是一次工程 ⇒ 不可持续。
 * ⇒ 而这份意见的结构是**固定的**（每条一个 `#### 原文第N条｜标题`，
 * 后面跟着 `> ` 开头的完整替换稿）⇒ ⇒ **可以机器提取** ⇒
 * ⇒ 提取成一份**数据清单** ⇒ 推送时读它 ⇒ **以后每轮审核只要加一份清单**。
 *
 * ## 产出：`src/data/editorial-overrides.json`
 *
 * 形状：
 * ```json
 * {
 *   "generatedAt": "...",
 *   "source": "20261101_五国日报最终审稿意见.md",
 *   "countries": {
 *     "kz": {
 *       "replace": [{ "no": 1, "title": "…", "summary": "…", "source": "…" }],
 *       "drop":   [{ "no": 7, "title": "…" }]
 *     }
 *   }
 * }
 * ```
 *
 * ⚠️ **只做提取，不做判断**：ChatGPT 说的「建议删除」我们照做（它是逐条核验过的），
 * 但「顺手修改/可以不改」里它给了替换稿的 ⇒ 也照做（替换稿本身是它重写过的正文）。
 * ⚠️ **没有替换稿、只说删除的** ⇒ 进 `drop`。
 * ⚠️ **只说「删除，并入第X条」的** ⇒ 进 `drop`（X 条本身有替换稿的会覆盖）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const SRC = process.argv[2] || resolve(process.cwd(), '../../Downloads/20261101_五国日报最终审稿意见.md');
const OUT = resolve(process.cwd(), 'src/data/editorial-overrides.json');

const CN_TO_CODE: Record<string, string> = {
  哈萨克斯坦: 'kz',
  乌兹别克斯坦: 'uz',
  吉尔吉斯斯坦: 'kg',
  塔吉克斯坦: 'tj',
  阿塞拜疆: 'az',
};

interface ReplaceItem {
  no: number;
  /** ★ 审稿 md 里「原文第N条｜标题」的**原标题** ⇒ 用来**匹配**（= 审稿人看到的草稿标题）。 */
  matchTitle: string;
  /** 替换稿的标题 ⇒ 用来**写入**。 */
  title: string;
  summary: string;
  source: string;
}
interface DropItem {
  no: number;
  /** ★ 同上：审稿人看到的原标题（用于匹配）。 */
  matchTitle: string;
}

function main(): void {
  const raw = readFileSync(SRC, 'utf8');
  const lines = raw.split('\n');

  const countries: Record<string, { replace: ReplaceItem[]; drop: DropItem[] }> = {};
  let curCode: string | null = null;
  let cur: { no: number; title: string; quote: string[]; opinion: string[] } | null = null;

  const flush = () => {
    if (!cur || !curCode) return;
    const bucket = (countries[curCode] ||= { replace: [], drop: [] });
    const quote = cur.quote.map((l) => l.replace(/^>\s?/, '').trim()).filter(Boolean);
    const opinion = cur.opinion.join('\n');
    const wantsDelete = /建议删除|删除(，|。|并入|，并入)/.test(opinion);
    if (quote.length >= 2) {
      // 完整替换稿：第 1 行 = 标题，末行 = 「来源：xxx」，中间 = 摘要
      const title = quote[0];
      let source = '';
      let body = quote.slice(1);
      if (/^来源[:：]/.test(body[body.length - 1] || '')) {
        source = body[body.length - 1].replace(/^来源[:：]\s*/, '').trim();
        body = body.slice(0, -1);
      }
      bucket.replace.push({ no: cur.no, matchTitle: cur.title, title, summary: body.join('\n').trim(), source });
    } else if (wantsDelete) {
      bucket.drop.push({ no: cur.no, matchTitle: cur.title });
    }
    cur = null;
  };

  for (const line of lines) {
    // 国家分段
    const h2 = line.match(/^##\s+(.+?)｜/);
    if (h2) {
      flush();
      curCode = CN_TO_CODE[h2[1].trim()] || null;
      continue;
    }
    // 条目
    const h4 = line.match(/^####\s+原文第\s*(\d+)\s*条[｜|]\s*(.+)$/);
    if (h4) {
      flush();
      cur = { no: Number(h4[1]), title: h4[2].trim(), quote: [], opinion: [] };
      continue;
    }
    if (!cur) continue;
    if (/^>\s?/.test(line)) cur.quote.push(line);
    else if (line.trim() === '') {
      // 空行：若已经收集到替换稿，后面就是「意见」段
      continue;
    } else if (!/^\*\*(核查状态|意见|核查来源)/.test(line) && !/^核查来源/.test(line)) {
      cur.opinion.push(line);
    } else {
      cur.opinion.push(line);
    }
  }
  flush();

  // 去掉正文里被 markdown 强调的标记残留（`**核查状态：** …` 这类不进 opinion 也没关系）
  const out = {
    generatedAt: new Date().toISOString(),
    source: SRC.split('/').pop(),
    countries,
  };
  mkdirSync(resolve(process.cwd(), 'src/data'), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');

  // ★ 同时产出一个 **TS 模块**（代码里 import 它）。
  // 为什么不直接 import JSON：`resolveJsonModule` 依赖 tsconfig，且打包时 JSON 的处理
  // 在 Next standalone 下容易出岔子 ⇒ ⇒ 一律走 TS 模块（打包器一定带上）。
  const ts = [
    '/* eslint-disable */',
    '// ★ 自动生成，**不要手改**（改法：改 md 源文件后重跑 scripts/build-editorial-overrides.ts）。',
    '//',
    '// 来源：' + out.source,
    '// 生成时间：' + out.generatedAt,
    '',
    'export type EditorialReplace = { no: number; matchTitle: string; title: string; summary: string; source: string };',
    'export type EditorialDrop = { no: number; matchTitle: string };',
    'export type EditorialCountry = { replace: EditorialReplace[]; drop: EditorialDrop[] };',
    '',
    'export const EDITORIAL_OVERRIDES: {',
    '  generatedAt: string;',
    '  source: string;',
    '  countries: Record<string, EditorialCountry>;',
    '} = ' + JSON.stringify(out, null, 2) + ';',
    '',
    'export default EDITORIAL_OVERRIDES;',
    '',
  ].join('\n');
  writeFileSync(resolve(process.cwd(), 'src/data/editorial-overrides.ts'), ts, 'utf8');

  let totalR = 0;
  let totalD = 0;
  for (const [cc, b] of Object.entries(countries)) {
    totalR += b.replace.length;
    totalD += b.drop.length;
    console.log(`${cc}: 覆盖 ${b.replace.length} 条 / 删除 ${b.drop.length} 条`);
  }
  console.log(`合计：覆盖 ${totalR} / 删除 ${totalD} → ${OUT}`);
}

main();
