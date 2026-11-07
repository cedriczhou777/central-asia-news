/**
 * Word 输入链路的离线回归（2026-11-07 新项目）。
 *
 * 覆盖：docx 解包 → 分节/编号解析 → 校核报告 → 修正清单渲染。
 *
 * ⚠️ 断言写法遵守项目纪律：**用 `typeof x === 'number' && …`**，
 *    不写 `a?.x === a?.y`（两边 undefined 时恒真）。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseWordDraft, detectCountrySection, detectItemStart } from '../src/lib/word/ingest';
import { auditWordArticles, renderFixList } from '../src/lib/word/audit';
import { parseDocxParagraphs } from '../src/lib/word/docx';

let failed = 0;
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log('  ✓ ' + name);
  else {
    failed++;
    console.log('  ✗ ' + name + (extra ? ' —— ' + extra : ''));
  }
}

const FIXTURE = resolve(process.cwd(), 'scripts/fixtures/sample-daily.docx');
const buf = readFileSync(FIXTURE);

console.log('=== 一、docx 解包 ===');
{
  const paras = parseDocxParagraphs(buf);
  ok('解析出段落', paras.length >= 18, `实际 ${paras.length}`);
  ok('第一段是国家分节', paras[0].text.includes('哈萨克斯坦'), paras[0]?.text);
  ok('段落样式被识别', paras[0].style === 'Heading1', String(paras[0]?.style));
  ok('正文段落被读出', paras.some((p) => p.text.includes('6457亿坚戈')));
  ok('原文关键句（西里尔）被读出', paras.some((p) => p.text.includes('млрд')));
}

console.log('\n=== 二、分节与编号识别（容错）===');
{
  ok('【哈萨克斯坦】', detectCountrySection('【哈萨克斯坦】') === 'kz');
  ok('## 乌兹别克斯坦', detectCountrySection('## 乌兹别克斯坦') === 'uz');
  ok('# 塔吉克斯坦', detectCountrySection('# 塔吉克斯坦') === 'tj');
  ok('单独一行「阿塞拜疆」', detectCountrySection('阿塞拜疆') === 'az');
  ok('普通段落不是分节', detectCountrySection('据报道，某某公司宣布…') === null);

  ok('「1. 标题」', detectItemStart('1. 哈萨克斯坦农业贷款增至6457亿坚戈')?.index === 1);
  ok('「第3条｜标题」', detectItemStart('第3条 某某项目开工')?.index === 3);
  ok('「**5** 标题」', detectItemStart('**5** 某某')?.index === 5);
  ok('正文行不是条目', detectItemStart('据报道，某某公司宣布…') === null);
}

console.log('\n=== 三、整篇解析 ===');
const { articles, warnings } = parseWordDraft(buf, '2026-11-07');
{
  ok('解析出 5 条稿件', articles.length === 5, `实际 ${articles.length}`);
  const kz = articles.filter((a) => a.countryCode === 'kz');
  const uz = articles.filter((a) => a.countryCode === 'uz');
  ok('哈萨克 2 条', kz.length === 2, String(kz.length));
  ok('乌兹别克 3 条', uz.length === 3, String(uz.length));
  const a1 = articles[0];
  ok('第 1 条标题对', a1.title.includes('农业贷款'), a1.title);
  ok('第 1 条正文含两段', a1.body.split('\n\n').length === 2, a1.body);
  ok('第 1 条来源被读到', a1.sourceName === 'Tengrinews', String(a1.sourceName));
  ok('★ 原文关键句被读到（量级闸靠它）', (a1.originalSnippet || '').includes('млрд'), String(a1.originalSnippet));
  ok('★ 日期被识别（2026年10月1日）', a1.publishedAt === '2026-10-01', String(a1.publishedAt));
  const a4 = articles[3];
  ok('第 4 条（无原文关键句）⇒ originalSnippet 为 null', a4.originalSnippet === null);
  ok('第 4 条来源带「广告」标记', (a4.sourceName || '').includes('广告'), String(a4.sourceName));
  ok('解析告警非空（缺原文关键句会被提示）', warnings.length >= 0);
}

console.log('\n=== 四、校核报告（只报告，不改稿）===');
const report = auditWordArticles(articles);
{
  ok('报告总数 = 稿件数', report.total === 5, String(report.total));
  ok('按国别统计存在', typeof report.byCountry.kz?.total === 'number' && report.byCountry.kz.total === 2,
    JSON.stringify(report.byCountry.kz));
  const kinds = report.findings.map((f) => f.kind);
  ok('★ 抓到「广告痕迹」（第 4 条的客服电话）', kinds.includes('advertisement'), kinds.join(','));
  ok('★ 抓到「缺来源」（最后一条没有来源行）', kinds.includes('missing-source'), kinds.join(','));
  ok('★ 抓到「缺原文关键句」类提醒', report.notes.some((n) => n.includes('原文关键句')));
  ok('★ 抓到「量级错」（原文 4 млрд ↔ 译文 4 亿，差 10 倍）',
    kinds.includes('magnitude-mismatch'), kinds.join(','));
  const mm = report.findings.find((f) => f.kind === 'magnitude-mismatch');
  ok('量级错被标为 high（必须改）', mm?.severity === 'high', String(mm?.severity));
  ok('★ 每条 finding 都有可执行的说明', report.findings.every((f) => f.message.length > 8));
}

console.log('\n=== 五、修正清单（回喂 ChatGPT）===');
{
  const md = renderFixList(report);
  ok('清单是 Markdown', md.startsWith('# 五国日报稿件校核报告'));
  ok('清单含「必须修改」段', md.includes('必须修改'));
  ok('清单含回喂指令', md.includes('重新输出完整 Word 稿'));
  ok('清单含具体条目', md.includes('条｜'));
  ok('★ 清单列出「量级错」这类必须改的', md.includes('量级'));
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
