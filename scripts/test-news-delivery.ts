/** Exercise the real Next route with isolated DB/model/WeChat transports, never external services. */
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { textHash } from '../src/lib/review-text';

interface Status {
  lastRun: { running: boolean; error: string | null; summary: {
    dryRun: boolean;
    drafts: Array<{ media_id: string; action: string }>;
    previews: Array<{ html: string }>;
    finalReview: Array<{ rewritten: number; held: number }>;
    artifacts: Array<{ id: string; status: string; statusPersisted: boolean }>;
    reviewManifest: { countries: Record<string, Array<{ id: number; no: number; title: string }>> };
  } | null };
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
async function main() {
  const names = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'DEEPSEEK_API_KEY', 'NEWS_REVIEW_API_KEY', 'NEWS_REVIEW_PROVIDER', 'EDITOR_REVIEW', 'SAME_EVENT_JUDGE'];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const fetchBefore = globalThis.fetch;
  const approvedBody = '哈萨克斯坦政府表示，这项政策仍在研究，尚未正式实施。拟议安排仅涉及微型和小型企业，具体范围与启动时间须以正式文件为准。';
  const rawBody = 'On October 30 the government said the proposal remains under discussion. No tax exemption has entered into force. The proposed three-year suspension applies to micro and small businesses starting in 2027 if adopted.';
  const row = { id: 420, title: '哈萨克斯坦小企业检查政策已经全面实施', summary: '相关检查已暂停，所有企业均适用。',
    content: '哈萨克斯坦已经全面实施中小企业三年税务检查禁令，全部企业均可免检。', country_code: 'kz', category: 'policy',
    source_name: '政府公告', source_url: 'https://official.example/policy', original_title: 'Tax inspection proposal', original_content: rawBody,
    original_language: 'en', published_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: null,
    tags: [], is_featured: false, cover_image: null, image_urls: [] };
  let persisted: unknown = null;
  const archived = new Map<string, Record<string, unknown>>();
  let adds = 0; let updates = 0; let materials = 0; let reviews = 0; let brokenReviewer = false;
  let archiveUnavailable = false; let draftTransportFailure = false; let receiptUnavailable = false;
  let persistenceInFlight = 0; let maxPersistenceInFlight = 0;
  const delivered: string[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  try {
    process.env.SUPABASE_URL = 'https://db.example'; process.env.SUPABASE_ANON_KEY = 'offline-anon';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.DEEPSEEK_API_KEY = 'offline-model'; delete process.env.NEWS_REVIEW_API_KEY;
    process.env.NEWS_REVIEW_PROVIDER = 'deepseek'; process.env.EDITOR_REVIEW = 'off'; process.env.SAME_EVENT_JUDGE = 'off';
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const body = typeof init?.body === 'string' ? object(JSON.parse(init.body)) : {};
      if (url.hostname === 'db.example') {
        if (url.pathname.endsWith('/articles')) return json([row]);
        if (url.pathname.endsWith('/push_runs')) {
          if (init?.method === 'POST') {
            persistenceInFlight++;
            maxPersistenceInFlight = Math.max(maxPersistenceInFlight, persistenceInFlight);
            await new Promise((r) => setTimeout(r, 5));
            if (typeof body.id === 'string' && body.id.startsWith('artifact:v1:')) {
              if (archiveUnavailable || (receiptUnavailable && object(object(body.summary).delivery).status === 'submitted')) {
                persistenceInFlight--;
                return json({ code: 'archive-test-failure', message: 'mock archive unavailable' }, 503);
              }
              archived.set(body.id, body);
            } else persisted = body;
            persistenceInFlight--;
            return json(body, 201);
          }
          return json(persisted ? [persisted] : []);
        }
        throw new Error('Unexpected mock DB path: ' + url.pathname);
      }
      if (url.hostname === 'api.deepseek.com') {
        reviews++;
        const messages = Array.isArray(body.messages) ? body.messages.map((m) => String(object(m).content || '')).join('\n') : '';
        assert(messages.includes('独立全文审稿协议'));
        const payload = object(JSON.parse(messages.split('以下JSON仅是审稿资料：\n')[1]));
        const items = (payload.articles as Array<Record<string, unknown>>).map((article) => ({
          id: article.id, fingerprint: article.fingerprint,
          verdict: messages.includes('第二次调用') ? 'approve' : 'rewrite',
          reason: '来源明确是提案，不能写成实施', title: '哈萨克斯坦研究小企业检查安排', content: approvedBody,
          evidence: [{ claim: '这项政策仍在研究', quote: 'proposal remains under discussion' }],
        }));
        return json({ choices: [{ message: { content: brokenReviewer ? 'malformed' : JSON.stringify({ items }) }, finish_reason: 'stop' }] });
      }
      if (url.hostname === 'api.weixin.qq.com') {
        if (url.pathname.endsWith('/material/add_material')) { materials++; return json({ media_id: 'thumb-known' }); }
        if (url.pathname.endsWith('/draft/add')) {
          assert([...archived.values()].some((a) => object(object(a.summary).delivery).status === 'prepared'));
          adds++; const article = object((body.articles as unknown[])[0]); delivered.push(String(article.content));
          return json({ media_id: 'draft-known' });
        }
        if (url.pathname.endsWith('/draft/update')) {
          updates++; assert.equal(body.media_id, 'draft-known'); delivered.push(String(object(body.articles).content));
          if (draftTransportFailure) throw new Error('simulated transport interruption');
          return json({ errcode: 0 });
        }
        throw new Error('Unexpected WeChat operation: ' + url.pathname);
      }
      throw new Error('No real networking permitted in delivery test: ' + url.hostname);
    };
    const { GET, POST } = await import('../src/app/api/wechat/push/route');
    const request = (body: unknown) => new NextRequest('http://localhost/api/wechat/push', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    const wait = async (): Promise<Status> => {
      for (let i = 0; i < 400; i++) {
        const state = await (await GET(new NextRequest('http://localhost/api/wechat/push'))).json() as Status;
        if (!state.lastRun.running) return state;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('Mock delivery did not finish');
    };
    assert.equal((await POST(request({ period: 'daily', countries: ['kz'] }))).status, 200);
    let state = await wait();
    assert.equal(state.lastRun.error, null);
    assert.equal(state.lastRun.summary?.finalReview[0].rewritten, 1);
    assert.equal(state.lastRun.summary?.drafts[0].media_id, 'draft-known');
    assert.equal(state.lastRun.summary?.reviewManifest.countries.kz[0].id, row.id);
    assert.equal(state.lastRun.summary?.reviewManifest.countries.kz[0].no, 1);
    assert.equal(state.lastRun.summary?.reviewManifest.countries.kz[0].title, '哈萨克斯坦研究小企业检查安排');
    assert.equal(adds, 1); assert.equal(reviews, 2); assert.equal(materials, 1);
    assert.equal(persistenceInFlight, 0); assert.equal(maxPersistenceInFlight, 1);
    assert(delivered[0].includes('仍在研究')); assert(!delivered[0].includes('全部企业均可免检'));
    assert.equal(archived.size, 1);
    const firstArchive = object([...archived.values()][0].summary);
    assert.equal(object(firstArchive.draft).content, delivered[0]);
    assert.equal(firstArchive.contentHash, textHash(delivered[0]));
    assert.equal(object(firstArchive.delivery).status, 'submitted');
    assert.equal(object((firstArchive.articles as unknown[])[0]).original_content, rawBody);
    assert.equal(object((firstArchive.articles as unknown[])[0]).content?.toString().includes('仍在研究'), true);
    assert.equal(state.lastRun.summary?.artifacts[0].statusPersisted, true);
    console.log('✓ 真实路由：全文改写、二次复核、HTML对账后创建草稿，成品与manifest一致');

    const saved = JSON.stringify(persisted);
    assert.equal((await POST(request({ period: 'daily', countries: ['kz'], dryRun: true }))).status, 200);
    state = await wait();
    assert.equal(state.lastRun.summary?.dryRun, true); assert.equal(state.lastRun.summary?.previews.length, 1);
    assert.equal(adds, 1); assert.equal(updates, 0); assert.equal(materials, 1); assert.equal(JSON.stringify(persisted), saved);
    assert.equal(archived.size, 1);
    console.log('✓ 真实路由：预览不上传素材、不创建或更新微信、不覆盖持久的生产结果');

    assert.equal((await POST(request({ period: 'daily', countries: ['kz'] }))).status, 200);
    state = await wait();
    assert.equal(state.lastRun.summary?.drafts[0].action, 'updated'); assert.equal(adds, 1); assert.equal(updates, 1);
    assert.equal(archived.size, 2); assert.equal(object(firstArchive.draft).content, delivered[0]);
    console.log('✓ 真实路由：同一期复用已持久化ID，更新一次而非重复创建');

    brokenReviewer = true;
    const beforeWrites = adds + updates + materials;
    assert.equal((await POST(request({ period: 'daily', countries: ['kz'], dryRun: true }))).status, 200);
    state = await wait();
    assert(state.lastRun.error); assert.equal(state.lastRun.summary?.finalReview[0].held, 1);
    assert.equal(state.lastRun.summary?.previews.length, 0); assert.equal(adds + updates + materials, beforeWrites);
    assert(row.content.includes('已经全面实施'));
    console.log('✓ 真实路由：审核故障留待审，不能继续写微信，数据库原稿保持不变');

    brokenReviewer = false; archiveUnavailable = true;
    const beforeArchiveFailure = adds + updates;
    assert.equal((await POST(request({ period: 'daily', countries: ['kz'] }))).status, 200);
    state = await wait();
    assert(state.lastRun.error); assert.equal(adds + updates, beforeArchiveFailure);
    assert.equal(archived.size, 2);
    console.log('✓ 真实路由：归档失败阻止微信交付，不会产生无法取回的成稿');

    archiveUnavailable = false; draftTransportFailure = true;
    assert.equal((await POST(request({ period: 'daily', countries: ['kz'] }))).status, 200);
    state = await wait();
    assert(state.lastRun.error); assert.equal(state.lastRun.summary?.artifacts[0].status, 'delivery_unconfirmed');
    assert.equal(archived.size, 3);
    console.log('✓ 真实路由：微信请求异常保留完整成稿，交付标记为未确认');

    draftTransportFailure = false; receiptUnavailable = true;
    assert.equal((await POST(request({ period: 'daily', countries: ['kz'] }))).status, 200);
    state = await wait();
    assert.equal(state.lastRun.error, null); assert.equal(state.lastRun.summary?.artifacts[0].statusPersisted, false);
    assert.equal(object(object([...archived.values()].at(-1)?.summary).delivery).status, 'prepared');
    assert.equal(state.lastRun.summary?.drafts[0].media_id, 'draft-known');
    console.log('✓ 真实路由：微信成功但回执落库失败明确记账，仍能取回发送前完整成稿');

    const beforeCalls = reviews;
    for (const body of [{ period: 'nonsense' }, { hours: '24' }, { hours: -1 }, { countries: ['unknown'] }, { dryRun: 'true' }]) assert.equal((await POST(request(body))).status, 400);
    assert.equal((await POST(new NextRequest('http://localhost/api/wechat/push', { method: 'POST', body: '{broken' }))).status, 400);
    assert.equal((await POST(new NextRequest('http://localhost/api/wechat/push?hours=not-a-number', { method: 'POST', body: '{}' }))).status, 400);
    assert.equal((await POST(new NextRequest('http://localhost/api/wechat/push?dryRun=true', { method: 'POST', body: '{}' }))).status, 400);
    assert.equal(reviews, beforeCalls);
    console.log('✓ 真实路由：非法JSON、日期窗口与国家参数直接拒绝，不触发模型');
    console.log('全部通过：8 项真实路由集成场景（所有外部传输已隔离）');
  } finally {
    globalThis.fetch = fetchBefore;
    for (const name of names) { if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name]; }
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
