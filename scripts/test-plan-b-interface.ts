import assert from 'node:assert/strict';
import { GET } from '../src/app/api/plan-b/route';
import { snapshot, sha256, type Candidate } from '../src/lib/plan-b-handoff';

const issue = '2026-11-21';
const country = 'kg';
const root = 'https://unit-test.example/api/plan-b';
const headers = { 'X-Ingest-Secret': 'fixture-key-only' };
const run = (view: string, phase: string) =>
  GET(new Request(`${root}?issue=${issue}&country=${country}&view=${view}&phase=${phase}`, { headers }));
const at = (time: string) => `${issue}T${time}+08:00`;
const source = (id: string, stamp: string): Candidate => ({
  id, title: id, revision: sha256(id + 'rev'), sourceHash: sha256(id),
  sourceUrl: `https://unit-test.example/${id}`, publishedAt: at(stamp), needsTimeReview: false,
});
const entries = [source('early-cache', '05:20:00'), source('increment', '05:59:59')];
const scope = { country: 'kg' as const, issue, pendingSources: [] };
const preview = snapshot({ ...scope, phase:'preview', observedAt: at('05:25:00'), candidates: entries.slice(0, 1) });
const final = snapshot({ ...scope, phase:'final', observedAt: at('06:02:00'), candidates: entries });
const checkpoint = (state: string, phase: string, value: object) => ({
  state, step: phase, issue_date: issue, country, receipt: value,
});

async function main() {
  // Run the real Next route, using a fake HTTP transport for the Supabase rows.
  // Neither the production database nor WeChat is reachable from this fixture.
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const before = process.env;
  process.env = { ...before, REVIEWED_PLAN_B: '1', PLAN_B_INGEST_SECRET: 'fixture-key-only',
    SUPABASE_URL: 'https://db.unit-test.example', SUPABASE_ANON_KEY: 'fixture-anon', SUPABASE_SERVICE_ROLE_KEY: 'fixture-role' };
  let rows: object[] = [checkpoint('ready','preview',{ snapshot: preview, metrics: {} })];
  let now = Date.parse(at('05:30:00'));
  Date.now = () => now;
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.host, 'db.unit-test.example');
    assert.equal(url.pathname, '/rest/v1/plan_b_daily');
    return Response.json(rows);
  };
  try {
    assert.equal((await GET(new Request(root))).status,401);
    const early = await run('manifest', 'preview');
    assert.equal(early.status, 200);
    assert.deepEqual((await early.json()).snapshot.candidates.map((row: Candidate) => row.id), ['early-cache']);
    now = Date.parse(at('06:01:00'));
    const pending = await run('changes','final');
    assert.equal(pending.status, 202);
    assert.equal((await pending.json()).availablePreviewHash, preview.hash);
    rows.push(checkpoint('retry','final',{ pendingSources: ['503-publisher'] }));
    assert.deepEqual((await (await run('changes','final')).json()).pending, ['503-publisher']);
    now = Date.parse(at('06:02:00'));
    rows[1] = checkpoint('ready','final',{ snapshot: final, metrics: {} });
    const delta = await run('changes','final');
    assert.equal(delta.status, 200);
    const result = await delta.json();
    assert.deepEqual(result.delta.added.map((row: Candidate) => row.id), ['increment']);
    assert.deepEqual(result.delta.retained, ['early-cache']);
    assert.deepEqual(result.frozenIds, ['early-cache', 'increment']);
  } finally {
    process.env = before;
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
  console.log('Plan B endpoint: authenticated preview, pending after freeze, recoverable 503 and exact delta passed.');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
