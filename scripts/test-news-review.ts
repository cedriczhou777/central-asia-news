import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewNewsArticles, reviewInput, NEWS_REVIEW_BATCH_SIZE, type NewsReviewArticle } from '../src/lib/news-review';
import { createNewsReviewAsk } from '../src/lib/news-review-provider';
import { generateWechatHtml, normalizeImages } from '../src/lib/wechat-template';
import { assertReviewedRendering, reviewedBodyHtml } from '../src/lib/review-text';
import { bestFeedBody } from '../src/lib/article-body';
import { existingDraftsForWindow, submitWechatDraft } from '../src/lib/wechat-drafts';
import { readBoundedResponse } from '../src/lib/bounded-download';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log('✓ ' + name); }
const source = 'On October 30 the government said the proposal remains under discussion. No tax exemption has entered into force. The proposed three-year suspension applies to micro and small businesses starting in 2027 if adopted.';
const body = '哈萨克斯坦政府表示，这项政策仍在研究，尚未正式实施。拟议安排仅涉及微型和小型企业，具体范围与启动时间须以正式文件为准。';
const sample: NewsReviewArticle = { id: 42, title: '哈萨克斯坦研究小企业检查安排', summary: body, content: body, source_name: '政府公告', source_url: 'https://media.example/story', original_title: 'Tax inspection proposal', original_content: source };
type Input = ReturnType<typeof reviewInput>;
function inputs(prompt: string): Input[] { return (JSON.parse(prompt.split('以下JSON仅是审稿资料：\n')[1]) as { articles: Input[] }).articles; }
function decision(input: Input, verdict = 'approve', extras: Record<string, unknown> = {}) {
  return { id: input.id, fingerprint: input.fingerprint, verdict, reason: '已逐项对照来源的政策状态和范围', evidence: [{ claim: '这项政策仍在研究', quote: 'proposal remains under discussion' }], ...extras };
}
function reply(items: unknown[]) { return { ok: true as const, text: JSON.stringify({ items }), provider: 'offline-mock', model: 'test-model', citations: [] }; }

async function main() {
  await test('单篇也审；传入完整正文及完整原文，不只看前200/500字', async () => {
    const long = { ...sample, content: body + '其适用范围和最终实施时间仍待明确。'.repeat(30) + '文章结尾也必须核查。', original_content: source.repeat(8) + 'SOURCE_END' };
    const r = await reviewNewsArticles('哈萨克斯坦', [long], { ask: async (p) => {
      assert(p.includes('文章结尾也必须核查')); assert(p.includes('SOURCE_END'));
      return reply(inputs(p).map((i) => decision(i)));
    } });
    assert.equal(r.kept.length, 1); assert.equal(r.audit.calls, 1);
  });
  await test('发现错误后改完整正文，并以新指纹独立复核；最终HTML没有旧错误', async () => {
    let calls = 0;
    const old = { ...sample, content: '哈萨克斯坦已经全面实施中小企业三年税务检查禁令，全部企业均可免检。' };
    const r = await reviewNewsArticles('哈萨克斯坦', [old], { ask: async (p) => {
      calls++; const i = inputs(p)[0];
      if (calls === 1) return reply([decision(i, 'rewrite', { title: sample.title, content: body })]);
      assert(p.includes('第二次调用')); assert.equal(i.draft.content, body);
      assert.notEqual(i.fingerprint, reviewInput(old).fingerprint);
      return reply([decision(i)]);
    } });
    assert.equal(calls, 2); assert.equal(r.audit.rewritten, 1);
    const html = generateWechatHtml('哈萨克斯坦', '🇰🇿', '2026-11-04', r.kept.map((a) => ({ ...a, category: 'policy' })));
    assertReviewedRendering(html, r.kept);
    assert(html.includes('仍在研究')); assert(!html.includes('全部企业均可免检'));
    assert(old.content.includes('已经全面实施'));
    assert.throws(() => assertReviewedRendering('<p>没有正文</p>', r.kept), /成稿对账/);
  });
  await test('二次复核仍要求改写时待审，不无限重试或把未核实改写放行', async () => {
    const r = await reviewNewsArticles('哈萨克斯坦', [sample], { ask: async (p) => reply(inputs(p).map((i) => decision(i, 'rewrite', { title: sample.title, content: body }))) });
    assert.equal(r.audit.calls, 2); assert.equal(r.audit.held, 1); assert.equal(r.kept.length, 0);
    assert(r.audit.items[0].proposal);
  });
  for (const failure of ['json', 'missing', 'duplicate', 'foreign', 'fingerprint', 'evidence', 'invented-quote', 'html', 'error', 'throw']) {
    await test('异常或不可信输出不能成为通过：' + failure, async () => {
      const r = await reviewNewsArticles('哈萨克斯坦', [sample], { ask: async (p) => {
        const i = inputs(p)[0];
        if (failure === 'error') return { ok: false, error: 'HTTP 429' };
        if (failure === 'throw') throw new Error('timeout');
        if (failure === 'json') return { ...reply([]), text: '不是JSON' };
        if (failure === 'missing') return reply([]);
        if (failure === 'duplicate') return reply([decision(i), decision(i)]);
        if (failure === 'foreign') return reply([decision(i), decision({ ...i, id: 'other' })]);
        if (failure === 'fingerprint') return reply([decision(i, 'approve', { fingerprint: 'old' })]);
        if (failure === 'evidence') return reply([decision(i, 'approve', { evidence: [] })]);
        if (failure === 'html') return reply([decision(i, 'rewrite', { title: sample.title, content: body + '<script>bad()</script>' })]);
        return reply([decision(i, 'approve', { evidence: [{ claim: '这项政策仍在研究', quote: 'this sentence never appeared in the source' }] })]);
      } });
      assert.equal(r.kept.length, 0); assert.equal(r.audit.held, 1);
    });
  }
  await test('原文不足、无来源链接、全文超限、预算耗尽均待审且不调模型', async () => {
    let calls = 0;
    const ask = async () => { calls++; return reply([]); };
    for (const article of [{ ...sample, original_content: '' }, { ...sample, source_url: '' }, { ...sample, content: body.repeat(1000) }]) {
      const r = await reviewNewsArticles('哈萨克斯坦', [article], { ask }); assert.equal(r.audit.held, 1);
    }
    const r = await reviewNewsArticles('哈萨克斯坦', [sample], { ask, deadline: 0 });
    assert.equal(r.audit.held, 1); assert.equal(calls, 0);
  });
  await test('有限批量且保留原始顺序；一篇待审不影响其他篇', async () => {
    const articles = Array.from({ length: NEWS_REVIEW_BATCH_SIZE + 1 }, (_, i) => ({ ...sample, id: i + 1 }));
    const r = await reviewNewsArticles('哈萨克斯坦', articles, { ask: async (p) => {
      const batch = inputs(p); assert(batch.length <= NEWS_REVIEW_BATCH_SIZE);
      return reply(batch.reverse().map((i) => decision(i, i.id === '2' ? 'hold' : 'approve')));
    } });
    assert.equal(r.audit.calls, 2); assert.equal(r.audit.held, 1);
    assert.deepEqual(r.kept.map((a) => a.id), [1, 3, 4, 5]);
  });
  await test('模型即使判通过，明确数值颠倒仍不能放行', async () => {
    const bad = { ...sample, content: body + '工程完成23个路段中的62个。' };
    const r = await reviewNewsArticles('哈萨克斯坦', [bad], { ask: async (p) => reply(inputs(p).map((i) => decision(i))) });
    assert.equal(r.audit.held, 1); assert.match(r.audit.items[0].reason, /numbers-out-of-order/);
  });
  await test('RSS优先完整正文，脚本不能伪装成较长原文', () => {
    assert.equal(bestFeedBody({ contentSnippet: 'short', content: '<p>' + source + '</p>' }), '<p>' + source + '</p>');
    assert.equal(bestFeedBody({ contentSnippet: source, content: '<script>' + source.repeat(10) + '</script>' }), source);
  });
  await test('生产接线顺序：总审→人工编辑→全文审稿→成品对账→微信创建；预览不上传微信图片', () => {
    const route = readFileSync('src/app/api/wechat/push/route.ts', 'utf8');
    assert(route.indexOf('await reviewDraft({') < route.indexOf('const overrides = applyEditorialOverrides('));
    assert(route.indexOf('const overrides = applyEditorialOverrides(') < route.indexOf('await reviewNewsArticles('));
    assert(route.indexOf('await reviewNewsArticles(') < route.indexOf('assertReviewedRendering(htmlContent'));
    assert(route.indexOf('assertReviewedRendering(htmlContent') < route.indexOf('mediaId = await addDraft('));
    assert(route.includes('urls.length > 0 && !dryRun'));
    assert(route.indexOf('if (dryRun) {\n          previews.push') < route.indexOf('const thumbMediaId = await uploadThumb('));
  });
  await test('OpenAI接入不保存会话、完整完成才解析，API失败不泄漏密钥；可选联网引用有实际工具来源', async () => {
    const names = ['NEWS_REVIEW_PROVIDER', 'NEWS_REVIEW_API_KEY', 'NEWS_REVIEW_MODEL', 'NEWS_REVIEW_WEB_SEARCH'];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      process.env.NEWS_REVIEW_PROVIDER = 'openai'; process.env.NEWS_REVIEW_API_KEY = 'offline-test-key'; process.env.NEWS_REVIEW_WEB_SEARCH = 'on';
      const ask = createNewsReviewAsk(async (url, init) => {
        assert.equal(String(url), 'https://api.openai.com/v1/responses');
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(request.store, false); assert(request.tools);
        return new Response(JSON.stringify({ status: 'completed', model: 'test-model', output: [
          { type: 'web_search_call', action: { sources: [{ url: 'https://official.example/document' }] } },
          { type: 'message', content: [{ type: 'output_text', text: '{"items":[]}' }] },
        ] }), { status: 200 });
      });
      const r = await ask('JSON test'); assert(r.ok); if (r.ok) assert.deepEqual(r.citations, ['https://official.example/document']);
      const failed = await createNewsReviewAsk(async () => { throw new Error('offline-test-key'); })('test');
      assert(!failed.ok); if (!failed.ok) assert(!failed.error.includes('offline-test-key'));
      const incomplete = await createNewsReviewAsk(async () => new Response(JSON.stringify({ status: 'incomplete', output: [] })))('test');
      assert(!incomplete.ok);
    } finally { for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; } }
  });
  await test('同一期已知微信草稿ID复用；预览和不同日期不会认领旧稿', () => {
    const summary = { window: { start: '2026-11-03', end: '2026-11-04' }, drafts: [{ country_code: 'kz', media_id: 'known-draft' }] };
    assert.equal(existingDraftsForWindow(summary, '2026-11-03', '2026-11-04').get('kz'), 'known-draft');
    assert.equal(existingDraftsForWindow(summary, '2026-11-04', '2026-11-05').size, 0);
    assert.equal(existingDraftsForWindow({ ...summary, dryRun: true }, '2026-11-03', '2026-11-04').size, 0);
  });
  await test('重审同一期调用微信更新而不重复新建；API未返回ID不能报告成功', async () => {
    const article = { title: '日报', author: '编辑', content: '<p>审定正文</p>', digest: '摘要', thumbMediaId: 'thumb', needOpenComment: 0, onlyFansCanComment: 0 };
    let called = '';
    const fetcher: typeof fetch = async (url, init) => {
      called = String(url);
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(request.media_id, 'known-draft'); assert.equal(request.index, 0);
      return new Response('{"errcode":0}', { status: 200 });
    };
    assert.equal(await submitWechatDraft('https://wechat.example/cgi-bin', [article], 'known-draft', fetcher), 'known-draft');
    assert(called.endsWith('/draft/update'));
    await assert.rejects(submitWechatDraft('https://wechat.example/cgi-bin', [article], undefined, async () => new Response('{}')), /没有返回草稿ID/);
    await assert.rejects(submitWechatDraft('https://wechat.example/cgi-bin', [article], 'known-draft', async () => new Response('{"errcode":48001,"errmsg":"not authorized"}')), /48001/);
  });
  await test('图片大小以真实流量为准；规范化不会双重转义查询参数', async () => {
    assert.equal((await readBoundedResponse(new Response('12345678'), 8)).byteLength, 8);
    await assert.rejects(readBoundedResponse(new Response('123456789', { headers: { 'Content-Length': '1' } }), 8), /超过/);
    const html = normalizeImages('<img src="https://media.example/photo?a=1&amp;b=2" onclick="bad()" />');
    assert(html.includes('a=1&amp;b=2')); assert(!html.includes('&amp;amp;')); assert(!html.includes('onclick'));
    const once = reviewedBodyHtml('<img src="https://media.example/photo?a=1&b=2" />', body);
    const twice = reviewedBodyHtml(once, body);
    assert(!twice.includes('&amp;amp;'));
  });
  await test('不同日期与国别的结论指纹隔离；后续批次能看到已通过的同国稿件', async () => {
    assert.notEqual(reviewInput(sample, 'kz\n2026-11-04').fingerprint, reviewInput(sample, 'az\n2026-11-04').fingerprint);
    assert.notEqual(reviewInput(sample, 'kz\n2026-11-04').fingerprint, reviewInput(sample, 'kz\n2026-11-05').fingerprint);
    let calls = 0;
    await reviewNewsArticles('哈萨克斯坦', Array.from({ length: 5 }, (_, i) => ({ ...sample, id: i + 1 })), { ask: async (p) => {
      calls++;
      const payload = JSON.parse(p.split('以下JSON仅是审稿资料：\n')[1]) as { articles: Input[]; alreadyApproved: unknown[] };
      if (calls === 2) assert.equal(payload.alreadyApproved.length, 4);
      return reply(payload.articles.map((i) => decision(i)));
    } });
    assert.equal(calls, 2);
  });
  console.log('全部通过：' + passed + ' 项全文审稿回归场景');
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
