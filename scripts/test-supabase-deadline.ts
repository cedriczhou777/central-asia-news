import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient } from '@supabase/supabase-js';
import { createDeadlineFetch } from '../src/lib/deadline-fetch';
import { getSupabaseClient } from '../src/storage/database/supabase-client';

// Loopback fixtures exercise native fetch cancellation, not a Promise.race.
// No production credentials, database, storage bucket or network are used.
async function main() {
  let bucketRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/never-headers' || request.url === '/storage/v1/bucket/hang') {
      if (request.url.includes('/bucket/')) bucketRequests++;
      return;
    }
    if (request.url === '/slow-body' || request.url?.includes('/object/')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.write('partial');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, method: request.method, custom: request.headers['x-fixture'] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bounded = createDeadlineFetch(fetch, 100);
  const withinDeadline = async (action: () => Promise<unknown>) => {
    const started = Date.now();
    await assert.rejects(action);
    assert.ok(Date.now() - started < 2_000, 'a stalled request must abort promptly');
  };
  try {
    await withinDeadline(() => bounded(base + '/never-headers'));
    const body = await bounded(base + '/slow-body');
    await withinDeadline(() => body.arrayBuffer());

    const successful = await bounded(base + '/ok', { method: 'POST', headers: { 'x-fixture': 'preserved' }, body: 'fixture' });
    assert.deepEqual(await successful.json(), { ok: true, method: 'POST', custom: 'preserved' });

    // Preserve either caller cancellation source, including a pre-aborted
    // Request even when a separate init.signal is also supplied.
    for (const source of ['init', 'request'] as const) {
      const requestController = new AbortController(), initController = new AbortController();
      const input = new Request(base + '/never-headers', { signal: requestController.signal });
      const reason = new Error(`cancel-${source}`);
      const pending = createDeadlineFetch(fetch, 2_000)(input, { signal: initController.signal });
      (source === 'init' ? initController : requestController).abort(reason);
      await assert.rejects(pending, error => error === reason);
    }
    for (const source of ['init', 'request'] as const) {
      let calls = 0;
      const shouldNotFetch: typeof fetch = async () => { calls++; return new Response('unexpected'); };
      const controller = new AbortController(), reason = new Error(`pre-aborted-${source}`);
      controller.abort(reason);
      const input = source === 'request' ? new Request(base + '/ok', { signal: controller.signal }) : base + '/ok';
      await assert.rejects(createDeadlineFetch(shouldNotFetch)(input, source === 'init' ? { signal: controller.signal } : undefined), error => error === reason);
      assert.equal(calls, 0, 'a pre-aborted caller must not start an operation');
    }

    // Actual SDK storage metadata and response-body paths receive the custom
    // fetch. Neither is covered by Supabase's PostgREST-only db.timeout.
    const sdk = createClient(base, 'fixture-anon', {
      global: { fetch: bounded },
      db: { timeout: 10_000 },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const metadataStarted = Date.now();
    const metadata = await sdk.storage.getBucket('hang');
    assert.ok(metadata.error); assert.equal(bucketRequests, 1);
    assert.ok(Date.now() - metadataStarted < 2_000);
    const downloadStarted = Date.now();
    await assert.rejects(async () => { await sdk.storage.from('fixture').download('slow-body'); },
      error => error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name));
    assert.ok(Date.now() - downloadStarted < 2_000);
    const uploadStarted = Date.now();
    const upload = await sdk.storage.from('fixture').upload('slow-upload', new Uint8Array([1, 2, 3]));
    assert.ok(upload.error, 'an upload acknowledgement with a stalled body must fail within the deadline');
    assert.ok(Date.now() - uploadStarted < 2_000);

    // Exercise production client wiring with a fake transport. Do not read or
    // retain existing environment values: this test sets isolated fixture values.
    const savedFetch = globalThis.fetch;
    const names = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
    let productionSignal: AbortSignal | null | undefined;
    try {
      process.env.SUPABASE_URL = 'https://fixture.example.invalid';
      process.env.SUPABASE_ANON_KEY = 'fixture-anon';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-service';
      globalThis.fetch = async (_input, init) => {
        productionSignal = init?.signal;
        return Response.json({ id: 'fixture', name: 'fixture', public: false });
      };
      const wired = await getSupabaseClient().storage.getBucket('fixture');
      assert.equal(wired.error, null);
      assert.ok(productionSignal instanceof AbortSignal, 'production storage requests need the global deadline signal');
    } finally {
      globalThis.fetch = savedFetch;
      for (const name of names) delete process.env[name];
    }
    console.log('supabase deadline: headers/body stalls, caller and Request cancellation, pre-abort, success, real SDK metadata/download/upload and production wiring passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
