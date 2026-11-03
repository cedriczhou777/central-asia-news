/** Real regressions: rendered body, batch isolation, identity matching and complete conversion. */
import assert from 'node:assert/strict';
import { applyEditorialOverrides, sameTitle } from '../src/lib/editorial-overrides';
import { parseEditorialReview } from '../src/lib/editorial-review-parser';
import { generateWechatHtml } from '../src/lib/wechat-template';
import { assertReviewedRendering } from '../src/lib/review-text';
import { EDITORIAL_OVERRIDES } from '../src/data/editorial-overrides';
let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log('✓ ' + name); }
const report = [
  '# 2026年11月1日五国日报审稿',
  '## 哈萨克斯坦｜最终审稿意见', '### 必须修改',
  '#### 原文第1条｜政策已实施',
  '**意见：** 仍在研究。',
  '> 政府正在研究小企业检查安排', '>',
  '> 政策尚未生效，具体范围与开始时间仍需以正式文件为准。',
  '> 来源：政府原始发布',
  '#### 原文第8条｜伙食招标重复报道',
  '**意见：** 删除本条，保留并修正第9条。',
  '#### 原文第9条｜国防部采购公告',
  '**意见：** 不建议删除，正文可保留。',
  '### 可以不改', '#### 原文第10条｜另一项正常新闻',
].join('\n');
const review = parseEditorialReview(report, 'review.md', '2026-11-04T00:00:00Z');
const article = { id: 42, title: '政策已实施', summary: '旧摘要', content: '<img src="https://media.example/photo.jpg" onclick="bad()" />政策已经全面实施。', source_name: '旧来源', source_url: 'https://media.example/story', category: 'policy' };
test('删除本条被识别，否定删除不误认；未识别处置必须列出', () => {
  assert.equal(review.countries.kz.drop.length, 1);
  assert.equal(review.countries.kz.drop[0].no, 8);
  assert.equal(review.unparsed.length, 1);
  assert.equal(review.unparsed[0].no, 9);
});
test('解析保留完整正文和来源，不能把正文只当摘要', () => {
  assert.equal(review.reviewDate, '2026-11-01');
  assert.match(review.countries.kz.replace[0].content, /尚未生效/);
  assert.equal(review.countries.kz.replace[0].source, '政府原始发布');
});
test('未提供批次时不应用任何历史编辑', () => {
  const r = applyEditorialOverrides('kz', [article]);
  assert.equal(r.outcome.applied, 0);
  assert.equal(r.kept[0].content, article.content);
});
test('同标题在不同日期也不能应用旧清单', () => {
  const r = applyEditorialOverrides('kz', [article], { reviewDate: '2026-11-04', review });
  assert.equal(r.outcome.skipped, 'different_batch');
  assert.equal(r.kept[0].content, article.content);
});
test('批次内唯一准确标题命中后，最终HTML确实显示新正文和新来源', () => {
  const r = applyEditorialOverrides('kz', [article], { reviewDate: review.reviewDate, review });
  assert.equal(r.outcome.applied, 1);
  assert.match(r.kept[0].content, /尚未生效/);
  assert.doesNotMatch(r.kept[0].content, /已经全面实施/);
  assert.match(r.kept[0].content, /https:\/\/media.example\/photo.jpg/);
  assert.doesNotMatch(r.kept[0].content, /onclick/);
  const html = generateWechatHtml('哈萨克斯坦', '🇰🇿', review.reviewDate, r.kept);
  assertReviewedRendering(html, r.kept);
  assert.match(html, /尚未生效/);
  assert.match(html, /政府原始发布/);
  assert.doesNotMatch(html, /已经全面实施/);
});
test('同批次同主题但不同事实，不能凭4个共同字或序号认领', () => {
  const r = applyEditorialOverrides('kz', [{ ...article, title: '政策拟延长至下一年度' }], { reviewDate: review.reviewDate, review });
  assert.equal(r.outcome.applied, 0);
  assert.equal(r.kept[0].title, '政策拟延长至下一年度');
});
test('显式稳定ID与URL可匹配改写后的标题，但不能应用到另一文章', () => {
  const bound = structuredClone(review);
  Object.assign(bound.countries.kz.replace[0], { articleId: 42, sourceUrl: article.source_url });
  assert.equal(applyEditorialOverrides('kz', [{ ...article, title: '后来调整的标题' }], { reviewDate: review.reviewDate, review: bound }).outcome.applied, 1);
  assert.equal(applyEditorialOverrides('kz', [{ ...article, id: 43 }], { reviewDate: review.reviewDate, review: bound }).outcome.applied, 0);
  assert.equal(applyEditorialOverrides('kz', [{ ...article, source_url: 'https://different.example/story' }], { reviewDate: review.reviewDate, review: bound }).outcome.applied, 0);
});
test('无法唯一确定的同名文章不改；传入对象保持原样', () => {
  assert.equal(applyEditorialOverrides('kz', [article, { ...article, id: 43 }], { reviewDate: review.reviewDate, review }).outcome.applied, 0);
  assert.equal(article.summary, '旧摘要');
});
test('不再将包含关系当作同一标题', () => {
  assert(!sameTitle('政府宣布贷款安排', '政府宣布贷款安排但仅适用于一家银行'));
});
test('真实清单完整转换为51项全文替换、20项删除，共71项', () => {
  assert.equal(Object.values(EDITORIAL_OVERRIDES.countries).reduce((n, b) => n + b.replace.length, 0), 51);
  assert.equal(Object.values(EDITORIAL_OVERRIDES.countries).reduce((n, b) => n + b.drop.length, 0), 20);
  assert.equal(EDITORIAL_OVERRIDES.unparsed.length, 0);
  assert(EDITORIAL_OVERRIDES.countries.kz.drop.some((d) => d.no === 8));
  assert(Object.values(EDITORIAL_OVERRIDES.countries).every((b) => b.replace.every((r) => r.content && r.source)));
});
test('没有日期的审稿文件拒绝生成', () => {
  assert.throws(() => parseEditorialReview('## 哈萨克斯坦｜审稿', 'unknown.md', ''), /日期/);
  assert.throws(() => parseEditorialReview('# 审稿报告\n正文事件发生在2026年11月1日', 'unknown.md', ''), /日期/);
  assert.throws(() => parseEditorialReview('# 2026年13月1日审稿报告', 'unknown.md', ''), /日期/);
});
console.log('全部通过：' + passed + ' 项回归场景');
