/** End-to-end artifact storage/read/export contracts with isolated transports. */
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { artifactReadAuthorized, createDraftArtifact, isEditionDate, parseDraftArtifact, saveDraftArtifact } from '../src/lib/draft-artifacts';
import { object, pullDatabaseReviewSnapshot, pullDraftArtifacts, pullDraftArtifactsDirect, pullDatabaseReviewSnapshotDirect } from '../src/lib/draft-artifact-client';
import type { DraftArtifact } from '../src/lib/draft-artifacts';
import { GET } from '../src/app/api/wechat/artifacts/route';

async function main() {
  const names = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'NEWS_ARTIFACT_READ_TOKEN'];
  const before = Object.fromEntries(names.map((n) => [n, process.env[n]])); const originalFetch = globalThis.fetch;
  const token = 'offline-read-token'; let reads = 0; let writes = 0; let rejectWrites = false;
  const rows = new Map<string, Record<string, unknown>>();
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const artifact = (countryCode = 'kz', editionDate = '2026-11-04') => createDraftArtifact({
    countryCode, editionDate, countryName: countryCode === 'kz' ? '哈萨克斯坦' : '乌兹别克斯坦', runStartedAt: '2026-11-04T02:00:00.000Z',
    window: { start: '2026-11-02T20:00:00.000Z', end: '2026-11-03T20:00:00.000Z' },
    draft: { title: '测试日报', content: '<p>这项政策仍在研究，尚未正式实施。</p>', author: '编辑部', digest: '精选资讯', thumbMediaId: 'image-known', needOpenComment: 0, onlyFansCanComment: 0 },
    articles: [{ id: 42, title: '测试政策', summary: '仍在研究', content: '<p>这项政策仍在研究，尚未正式实施。</p>', source_name: '政府公告', source_url: 'https://official.example/policy', original_title: 'Proposal', original_content: 'The proposal remains under discussion.', category: 'policy' }],
    review: { version: 1, country: countryCode, editionDate, calls: 2, approved: 0, rewritten: 1, held: 0, items: [] }, build: { sourceDigest: null, builtAt: null },
  });
  const request = (query = '', key: string | null = token) => new NextRequest('https://service.example/api/wechat/artifacts' + query, { headers: key === null ? {} : { Authorization: 'Bearer ' + key } });
  let count = 0;
  const test = async (name: string, fn: () => void | Promise<void>) => { await fn(); count++; console.log('✓ ' + name); };
  try {
    process.env.SUPABASE_URL = 'https://db.example'; process.env.SUPABASE_ANON_KEY = 'offline-anon'; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEWS_ARTIFACT_READ_TOKEN = token;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.hostname, 'db.example', 'No networking outside mock database');
      assert(url.pathname.endsWith('/push_runs'));
      if (init?.method === 'POST') {
        writes++;
        if (rejectWrites) return json({ message: 'storage rejected', code: 'TEST' }, 503);
        const row = object(JSON.parse(String(init.body))); rows.set(String(row.id), row); return json(row, 201);
      }
      reads++;
      const filter = url.searchParams.get('id') || ''; assert(filter.startsWith('like.artifact:v1:'));
      const prefix = filter.slice(5).replace(/%$/, '');
      const values = [...rows.values()].filter((r) => String(r.id).startsWith(prefix)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const offset = Number(url.searchParams.get('offset') || 0); const limit = Number(url.searchParams.get('limit') || values.length);
      return json(values.slice(offset, offset + limit));
    };
    await test('无凭据和错误凭据不读数据库；query凭据无效；未配置入口关闭', async () => {
      for (const req of [request('', null), request('', 'incorrect'), request('?token=' + token, null)]) assert.equal((await GET(req)).status, 401);
      delete process.env.NEWS_ARTIFACT_READ_TOKEN; assert.equal((await GET(request())).status, 503);
      assert.equal(artifactReadAuthorized('Bearer ' + token), false); process.env.NEWS_ARTIFACT_READ_TOKEN = token;
      assert.equal(reads, 0); assert.equal(writes, 0);
    });
    await test('日期、国家及分页非法时拒绝，不触发数据库', async () => {
      for (const q of ['?date=2026-02-30', '?date=2026-1-1', '?country=bad', '?limit=0', '?limit=21', '?offset=-1', '?offset=0.5']) assert.equal((await GET(request(q))).status, 400);
      assert.equal(reads, 0); assert(isEditionDate('2024-02-29')); assert(!isEditionDate('2026-02-29'));
    });
    const first = artifact(); const second = artifact(); const otherCountry = artifact('uz'); const old = artifact('kz', '2026-11-03');
    await test('同毫秒相同国家的不同尝试仍有独立身份，不覆盖历史', async () => {
      assert.notEqual(first.id, second.id);
      for (const a of [first, second, otherCountry, old]) await saveDraftArtifact(a);
      rows.set('latest', { id: 'latest', summary: { today: '2026-11-05' } });
      assert.equal(rows.size, 5);
    });
    await test('真实API按日期和国家取回完整成稿、原文，持久记录不依赖lastRun', async () => {
      const response = await GET(request('?date=2026-11-04&country=kz'));
      assert.equal(response.status, 200); assert.match(response.headers.get('cache-control') || '', /private.*no-store/);
      assert.equal(response.headers.get('vary'), 'Authorization');
      const data = await response.json() as { artifacts: DraftArtifact[] };
      assert.equal(data.artifacts.length, 2); assert.equal(data.artifacts[0].draft.content, first.draft.content);
      assert.equal(data.artifacts[0].articles[0].original_content, first.articles[0].original_content);
      assert(data.artifacts.every((a) => a.editionDate === '2026-11-04' && a.countryCode === 'kz'));
    });
    await test('分页保留完整清单，空日期404不会冒充今日已交付', async () => {
      const page = await (await GET(request('?date=2026-11-04&country=kz&limit=1'))).json() as { nextOffset: number };
      assert.equal(page.nextOffset, 1);
      assert.equal((await GET(request('?date=2026-11-02'))).status, 404);
    });
    await test('正文被改或身份被替换时拒绝导出，损坏记录不会静默漏掉', async () => {
      const saved = rows.get(first.id)!; const bad = JSON.parse(JSON.stringify(first)) as DraftArtifact; bad.draft.content += '被修改';
      rows.set(first.id, { ...saved, summary: bad }); assert.equal((await GET(request('?date=2026-11-04&country=kz'))).status, 503);
      assert.throws(() => parseDraftArtifact({ ...first, id: '../unsafe' })); rows.set(first.id, saved);
    });
    await test('存储故障抛错，不把写入失败报告成已留存', async () => {
      rejectWrites = true; await assert.rejects(saveDraftArtifact(first), /归档写入失败/); rejectWrites = false;
    });
    await test('归档状态区分prepared、submitted及未确认，成功状态必须有草稿ID', async () => {
      assert.equal(parseDraftArtifact(first).delivery.status, 'prepared');
      first.delivery = { status: 'submitted', mediaId: 'draft-known', updatedAt: new Date().toISOString() };
      await saveDraftArtifact(first); assert.equal(object(object(rows.get(first.id)?.summary).delivery).mediaId, 'draft-known');
      assert.throws(() => parseDraftArtifact({ ...first, delivery: { status: 'submitted' } }));
    });
    await test('取稿客户端通过真实只读路由拿到完整归档，不触发写入或模型', async () => {
      const beforeWrites = writes;
      const fetcher: typeof fetch = async (input, init) => {
        assert.equal(init?.method, undefined); assert.equal(init?.redirect, 'error');
        assert.equal(object(init?.headers).Authorization, 'Bearer ' + token);
        return GET(new NextRequest(String(input), { headers: init?.headers }));
      };
      const list = await pullDraftArtifacts('https://service.example', '2026-11-04', token, 'kz', fetcher);
      assert.equal(list.length, 2); assert.equal(writes, beforeWrites);
      await assert.rejects(pullDraftArtifacts('http://untrusted.example', '2026-11-04', token, undefined, fetcher), /HTTPS/);
    });
    await test('直接数据库取稿无需微信、模型或只读HTTP Token，仍只执行SELECT', async () => {
      const beforeWrites = writes;
      delete process.env.NEWS_ARTIFACT_READ_TOKEN;
      const list = await pullDraftArtifactsDirect('2026-11-04', 'kz');
      assert.equal(list.length, 2); assert.equal(writes, beforeWrites);
      const transport = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input)); assert.equal(init?.method, 'GET');
        if (url.pathname.endsWith('/articles')) {
          assert.equal(url.searchParams.get('country_code'), 'eq.kz');
          assert.deepEqual(url.searchParams.getAll('published_at'), ['gte.' + first.window.start, 'lte.' + first.window.end]);
          return json([{ id: 9, title: '唯一标题', content: '原始译稿', source_name: '政府公告', source_url: 'https://official.example/policy',
            original_title: 'Proposal', original_content: 'Original source text', country_code: 'kz', published_at: '2026-11-03T01:00:00Z' }]);
        }
        if (url.searchParams.get('id') === 'eq.latest') return json([{ summary: { today: '2026-11-04', window: first.window,
          draftTitles: [{ country_code: 'kz', titles: ['唯一标题'] }] } }]);
        return transport(input, init);
      };
      try {
        const snapshot = await pullDatabaseReviewSnapshotDirect('2026-11-04');
        assert.equal(snapshot.countries[0].articles[0].originalContent, 'Original source text'); assert.equal(writes, beforeWrites);
      } finally { globalThis.fetch = transport; process.env.NEWS_ARTIFACT_READ_TOKEN = token; }
    });
    await test('取稿分页重复、错日期或无进展时失败，不交付部分结果', async () => {
      const fake: typeof fetch = async () => json({ date: '2026-11-04', artifacts: [first], nextOffset: 0 });
      await assert.rejects(pullDraftArtifacts('https://service.example', '2026-11-04', token, undefined, fake), /无进展/);
      const wrong: typeof fetch = async () => json({ date: '2026-11-03', artifacts: [], nextOffset: null });
      await assert.rejects(pullDraftArtifacts('https://service.example', '2026-11-04', token, undefined, wrong), /日期/);
    });
    await test('历史恢复依据当天推送清单和窗口，歧义/已改标题不模糊认领', async () => {
      const fake: typeof fetch = async (input, init) => {
        const url = new URL(String(input)); assert.equal(object(init?.headers).Authorization, undefined);
        if (url.pathname.endsWith('/push')) return json({ lastRunPersisted: { summary: { today: '2026-11-04', window: first.window,
          draftTitles: [{ country_code: 'kz', titles: ['唯一标题', '歧义标题', '清洗后的标题'] }] } } });
        const row = { country: 'kz', publishedAt: '2026-11-03T02:00:00Z', content: '数据库译稿', originalContent: 'original body' };
        return json({ articles: [{ ...row, id: 1, title: '唯一标题' }, { ...row, id: 2, title: '歧义标题' }, { ...row, id: 3, title: '歧义标题' }, { ...row, id: 4, title: '清洗之前的标题' }] });
      };
      const data = await pullDatabaseReviewSnapshot('https://service.example', '2026-11-04', undefined, fake);
      assert.equal(data.representation, 'database_translation_before_final_push_edits');
      assert.equal(data.countries[0].articles.length, 1); assert.deepEqual(data.countries[0].unmatchedTitles, ['歧义标题', '清洗后的标题']);
      await assert.rejects(pullDatabaseReviewSnapshot('https://service.example', '2026-11-03', undefined, fake), /没有该日期/);
    });
    console.log('全部通过：' + count + ' 项成稿归档与取稿场景（所有传输隔离）');
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; }
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
