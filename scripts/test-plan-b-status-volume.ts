import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { GET } from '../src/app/api/plan-b/route';
import type { StateRow } from '../src/lib/plan-b-store';

// No live keys or endpoints. Pass the incident's read-only rows only for a
// one-off replay; the default fixture deliberately exceeds the Work wire limit.
async function main() {
  const original = { env:process.env, fetch:globalThis.fetch, now:Date.now };
  process.env = { NODE_ENV:'test', PATH:original.env.PATH, REVIEWED_PLAN_B:'1', REVIEWED_PLAN_B_FIRST_ISSUE:'2026-11-22',
    INGEST_SECRET:'offline-status-only', SUPABASE_URL:'https://db.status-fixture.invalid',
    SUPABASE_SERVICE_ROLE_KEY:'offline-role', SUPABASE_ANON_KEY:'offline-anon' };
  Date.now = () => Date.parse('2026-11-22T06:50:00+08:00');
  const countries = ['kz','uz','kg','tj','az'] as const;
  const actual = process.argv[2];
  const rows: StateRow[] = actual ? JSON.parse(await readFile(actual, 'utf8')) : countries.map(country => {
    const coverage = { version:'plan-b-coverage-1',state:'blocked',country,
      pendingWork:Array.from({length:2500}, (_,i)=>({sourceId:`${country}-fixture`,kind:'article',
        url:`https://publisher.invalid/news/${i}/` + 'x'.repeat(180),reason:'article_body_pending'})),
      reviewWork:[],gaps:[],readableSources:[],closedQueueWork:[],queues:{article:2500,listing:0,lead:0} };
    return { issue_date:'2026-11-22',country,step:'final',state:'blocked',attempt:2,lease_until:null,retry_after:null,
      updated_at:'2026-11-21T22:49:00Z',receipt:{reason:'freeze_incomplete',metrics:{coverage},
        snapshot:{hash:'a'.repeat(64),coverage,candidates:[]}} };
  });
  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin,'https://db.status-fixture.invalid','live network forbidden');
    assert.equal(url.pathname,'/rest/v1/plan_b_daily');
    return Response.json(rows);
  };
  try {
    const response = await GET(new Request('https://work.fixture.invalid/api/plan-b?view=status&issue=2026-11-22',
      {headers:{'X-Ingest-Secret':'offline-status-only'}}));
    assert.equal(response.status,200);
    const raw = await response.text();
    const data = JSON.parse(raw);
    const bytes = Buffer.byteLength(raw);
    const result = { fixture:actual ? 'production-read-only-replay':'synthetic-volume', bytes,
      workClientLimit:4*1024*1024, businessSucceeded:data.business.businessSucceeded,
      allFinalRowsBlocked:data.rows.filter((r:StateRow)=>r.step==='final').every((r:StateRow)=>r.state==='blocked'),
      rows:data.rows.length,realNetworkWrites:0,realAiCalls:0 };
    console.log(JSON.stringify(result));
    if (process.argv[3]) await writeFile(process.argv[3],JSON.stringify(result,null,2));
    assert.ok(bytes < 64*1024,'status must fit a small bounded progress response');
    assert.equal(data.business.businessSucceeded,false,'projection must not turn blocked work into success');
    for (const row of rows.filter(r=>r.step==='final')) {
      const got = data.rows.find((r:StateRow)=>r.country===row.country&&r.step==='final');
      const source = (row.receipt!.snapshot as {coverage:{pendingWork:unknown[]}}).coverage;
      assert.equal(got.coverage.pendingWorkCount,source.pendingWork.length,'pending work retained as exact count');
      assert.equal(got.reason,'freeze_incomplete');
      assert.equal(got.coverage.detailsComplete,false);
    }
    console.log('Plan B status volume: bounded response, exact pending counts, unchanged blocks, and no live transport passed.');
  } finally { process.env=original.env;globalThis.fetch=original.fetch;Date.now=original.now; }
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
