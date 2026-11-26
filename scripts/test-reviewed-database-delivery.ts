import assert from 'node:assert/strict';
import { canonicalJson, sha256 } from '../src/lib/plan-b-handoff';
import { databaseApprovalSignature, deliverValidationDraft, deploymentRecoveryRows, processDatabaseDeliveries, reviseTextLayout, reviewedDatabaseRecoveryWindow,
  verifyDatabaseDeliveryRequest } from '../src/lib/reviewed-database-delivery';
import { contentHash, validatePackage } from '../src/lib/reviewed-package';
import type { getSupabaseClient } from '../src/storage/database/supabase-client';
import { database } from './lib/reviewed-test-db';

const key = '1'.repeat(64);
const issue = '2026-11-26';
const opens = Date.parse(`${issue}T09:30:00+08:00`);
const closes = Date.parse('2026-11-27T04:30:00+08:00');
let clock = Date.parse(`${issue}T10:00:00+08:00`);
const now = Date.now;
const firstIssue = process.env.REVIEWED_PLAN_B_FIRST_ISSUE;
const ingest = process.env.INGEST_SECRET;
const planBIngest = process.env.PLAN_B_INGEST_SECRET;
const release = validatePackage({ version: issue, readyCountries: ['kz', 'uz', 'kg'],
  countries: Object.fromEntries(['kz', 'uz', 'kg'].map(code => [code, {
    title: `Draft fixture ${code}`, summary: 'Summary',
    bodyHtml: `<p>${code} body</p><p>Source: <a href="https://example.test/${code}">Fixture News</a></p>`,
    sourceName: 'Fixture News', sourceUrl: '', coverUrl: '',
  }])),
});
const id = 'fixture-approved-command';
const approval = { issue, version: release.version, contentHash: contentHash(release), countries: release.readyCountries,
  issuedBy: 'owner', reason: 'Approved late recovery fixture', approvedAt: new Date(clock - 1000).toISOString(),
  expiresAt: new Date(clock + 60 * 60_000).toISOString() };
const envelope = <T extends object>(payload: T) => ({ payload, content_hash: sha256(canonicalJson(payload)) });
const grant = { ...envelope({ ...approval, signature: databaseApprovalSignature(key, id, approval) }), state: 'available' };
const request = (country: 'kz' | 'uz' | 'kg') => ({
  ...envelope({ authorizationId: id, release }), issue_date: issue, country, record_key: `db-delivery/${id}`,
  kind: 'manual_use', state: 'queued', attempts: 0, lease_until: null as null | string, result: {} as Record<string, unknown>,
});

async function main() {
  process.env.REVIEWED_PLAN_B_FIRST_ISSUE = '2026-11-25';
  Date.now = () => clock;
  const kz = request('kz');
  assert.equal(verifyDatabaseDeliveryRequest(kz, grant, key, clock).payload.version, issue);
  assert.throws(() => verifyDatabaseDeliveryRequest(kz, null, key, clock), /approval_missing/);
  assert.throws(() => verifyDatabaseDeliveryRequest(kz, grant, '2'.repeat(64), clock), /approval_mismatch/);
  assert.throws(() => verifyDatabaseDeliveryRequest(kz, grant, key, clock + 61 * 60_000), /approval_mismatch/);
  assert.throws(() => verifyDatabaseDeliveryRequest(kz, grant, key, Date.parse(`${issue}T09:15:00+08:00`)), /outside_window/);
  assert.throws(() => verifyDatabaseDeliveryRequest(kz, grant, key, Date.parse('2026-11-24T10:00:00+08:00')), /outside_window/);
  assert.throws(() => verifyDatabaseDeliveryRequest(kz, grant, key, closes), /outside_window/);
  assert.equal(reviewedDatabaseRecoveryWindow(opens - 1), null);
  assert.deepEqual(reviewedDatabaseRecoveryWindow(opens), { issue, opensAt: opens, closesAt: closes });
  assert.equal(reviewedDatabaseRecoveryWindow(closes - 1)?.issue, issue);
  assert.equal(reviewedDatabaseRecoveryWindow(closes), null);
  assert.equal(reviewedDatabaseRecoveryWindow(Date.parse('2026-11-25T19:00:00+08:00')), null);
  assert.equal(reviewedDatabaseRecoveryWindow(Date.parse('2026-11-27T10:00:00+08:00'))?.issue, '2026-11-27');
  const tooEarly = { ...approval, approvedAt: new Date(opens - 1000).toISOString() };
  assert.throws(() => verifyDatabaseDeliveryRequest(kz, { ...envelope({ ...tooEarly,
    signature:databaseApprovalSignature(key,id,tooEarly) }), state:'available' },key,clock), /approval_mismatch/);
  const beyondClosure = { ...approval, expiresAt:new Date(closes+60_000).toISOString() };
  assert.throws(() => verifyDatabaseDeliveryRequest(kz,{ ...envelope({ ...beyondClosure,
    signature:databaseApprovalSignature(key,id,beyondClosure) }), state:'available' },key,clock), /approval_mismatch/);
  assert.throws(() => verifyDatabaseDeliveryRequest({ ...kz, country: 'az' }, grant, key, clock), /invalid_reviewed_package/);
  const neighboringIssue = '2026-11-27';
  const neighboring = { ...kz, issue_date: neighboringIssue, ...envelope({ authorizationId: id, release: { ...release, version: neighboringIssue } }) };
  assert.throws(() => verifyDatabaseDeliveryRequest(neighboring, grant, key, clock), /outside_window/);
  const yesterday = { ...kz,issue_date:'2026-11-25',...envelope({authorizationId:id,release:{ ...release,version:'2026-11-25' }}) };
  assert.throws(() => verifyDatabaseDeliveryRequest(yesterday,grant,key,clock), /outside_window/);
  process.env.INGEST_SECRET = key;
  assert.throws(() => verifyDatabaseDeliveryRequest(kz, grant, key, clock), /invalid_manual_approval_key/);
  process.env.INGEST_SECRET = 'fixture-unrelated-ingest';
  process.env.PLAN_B_INGEST_SECRET = key;
  assert.throws(() => verifyDatabaseDeliveryRequest(kz, grant, key, clock), /invalid_manual_approval_key/);
  process.env.PLAN_B_INGEST_SECRET = 'fixture-unrelated-plan-b-ingest';
  const changed = { ...release, countries: { ...release.countries, kz: { ...release.countries.kz!, bodyHtml: '<p>Tampered</p>' } } };
  const deployment = { issue, version: release.version, authorizationId: 'fixture-deployment-approved',
    contentHash: contentHash(release), countries: ['kz','uz','kg'] as const, expiresAt: clock + 30 * 60_000 };
  const staged = { ...envelope({ release }), state: 'available' };
  const [signed, ...deployCommands] = deploymentRecoveryRows(deployment, staged, key, clock);
  assert.equal(signed.record_key, 'db-approval/' + deployment.authorizationId);
  assert.deepEqual(deployCommands.map(row=>row.country), ['kz','uz','kg']);
  assert.equal(verifyDatabaseDeliveryRequest({ ...deployCommands[0], country:'kz', attempts:0 }, signed, key, clock).payload.version, issue);
  assert.throws(() => deploymentRecoveryRows(deployment, staged, key, deployment.expiresAt), /not_admitted/);
  assert.throws(() => deploymentRecoveryRows(deployment, { ...envelope({ release:changed }), state:'available' }, key, clock), /package_mismatch/);
  assert.throws(() => deploymentRecoveryRows({ ...deployment, countries:['kz'] }, staged,key,clock), /package_mismatch/);
  assert.throws(() => deploymentRecoveryRows(deployment,{...staged,content_hash:'0'.repeat(64)},key,clock), /not_admitted/);
  assert.throws(() => deploymentRecoveryRows(deployment,{...staged,state:'rejected'},key,clock), /not_admitted/);
  const uz = { ...request('uz'), ...envelope({ authorizationId: id, release: changed }) };
  const kg = request('kg');
  const queue = [kz, uz, kg];
  const deliveryDb = database();
  let storedHash: string | undefined;

  const sb = { from(table: string) {
    if (table === 'reviewed_deliveries') return deliveryDb.from();
    const filters: Record<string, unknown> = {};
    let patch: Partial<typeof kz> | undefined;
    let returning = false;
    let insert: { content_hash: string } | undefined;
    const query = {
      eq(field: string, value: unknown) { filters[field] = value; return this; },
      match(where: Record<string, unknown>) { Object.assign(filters, where); return this; },
      like() { return this; }, gte() { return this; }, lt() { return this; }, lte() { return this; },
      or() { return this; }, order() { return this; }, limit() { return this; },
      select() { returning = true; return this; },
      update(value: Partial<typeof kz>) { patch = value; return this; },
      insert(value: {content_hash: string}) { insert = value; return this; },
      maybeSingle() { return Promise.resolve({ data: grant, error: null }); },
      single() { return Promise.resolve({ data: { content_hash: storedHash }, error: null }); },
      then(resolve: (value: unknown) => void) {
        if (insert) {
          if (storedHash) return resolve({ error: { code: '23505' } });
          storedHash = insert.content_hash;
          return resolve({ error: null });
        }
        if (patch) {
          const matches = queue.filter(row => Object.entries(filters).every(([field, value]) => Object.entries(row).some(([k, v]) => field === k && value === v)));
          for (const row of matches) Object.assign(row, patch);
          return resolve({ data: returning ? matches : null, error: null });
        }
        assert.equal(filters.issue_date, issue, 'look up only the recovery issue');
        return resolve({ data: queue.filter(row => row.state === 'queued' || row.state === 'working' && Date.parse(row.lease_until!) < clock), error: null });
      },
    };
    return query;
  } } as unknown as ReturnType<typeof getSupabaseClient>;

  const created: string[] = [];
  const reads: string[] = [];
  let reconciliationCandidates: string[] = [];
  let dropSourceLabel = false;
  const adapters: NonNullable<Parameters<typeof processDatabaseDeliveries>[2]> = {
    async prepare(draft) {
      return { html: draft.bodyHtml, images: 0, imageProbes: [], cover: 'fallback',
        article: { title: draft.title, content: draft.bodyHtml, digest: draft.summary, thumb_media_id: 'fixture-thumb',
          author: '', content_source_url: '', need_open_comment: 0, only_fans_can_comment: 0 } } as Awaited<ReturnType<NonNullable<Parameters<typeof processDatabaseDeliveries>[2]>['prepare']>>;
    },
    async create(article) {
      const { title } = article as { title: string };
      created.push(title);
      if (title === release.countries.kz!.title) throw new Error('simulated reply lost after accepted create');
      return 'media-kg';
    },
    async find(title) { return title === release.countries.kz!.title ? reconciliationCandidates : []; },
    async read(mediaId) {
      reads.push(mediaId);
      const country = mediaId === 'media-kz' ? 'kz' : 'kg';
      const draft = release.countries[country]!;
      const visibleHtml = draft.bodyHtml.replace(/<a\b[^>]*>([^<]+)<\/a>/g, '$1');
      const content = dropSourceLabel ? visibleHtml.replace('<p>Source: Fixture News</p>', '') : visibleHtml;
      return { title: draft.title, content, digest: draft.summary, thumb_media_id: 'fixture-thumb' };
    },
  };
  await processDatabaseDeliveries(key, sb, adapters);
  assert.deepEqual(queue.map(row => row.state), ['working', 'rejected', 'accepted']);
  assert.equal(uz.result.reason, 'manual_approval_mismatch');
  assert.equal(kg.result.mediaId, 'media-kg');
  assert.equal(kg.result.sourceUrlsVisible, false, 'external link targets are separate from source label readback');
  assert.deepEqual(created, [release.countries.kz!.title, release.countries.kg!.title]);
  reconciliationCandidates = ['media-kz', 'ambiguous-match'];
  clock += 6 * 60_000;
  await processDatabaseDeliveries(key, sb, adapters);
  assert.equal(kz.state, 'working');
  assert.equal(created.length, 2, 'ambiguous matches must not trigger another create');
  reconciliationCandidates = ['media-kz'];
  clock += 6 * 60_000;
  await processDatabaseDeliveries(key, sb, adapters);
  assert.equal(kz.state, 'accepted');
  assert.equal(kz.result.mediaId, 'media-kz');
  assert.equal(kz.result.coverMatch, true);
  assert.deepEqual(reads, ['media-kg', 'media-kz']);
  assert.equal(created.length, 2, 'a lost receipt is reconciled without another draft creation');
  await processDatabaseDeliveries(key, sb, adapters);
  assert.equal(created.length, 2, 'accepted requests are not re-claimed');
  Object.assign(kg, { state: 'working', lease_until: new Date(clock - 1).toISOString() });
  dropSourceLabel = true;
  await processDatabaseDeliveries(key, sb, adapters);
  assert.equal(kg.state, 'working');
  assert.equal(kg.result.reason, 'delivery_not_verified', 'a missing source label must fail exact text verification');
  dropSourceLabel = false;
  clock += 6 * 60_000;
  await processDatabaseDeliveries(key, sb, adapters);
  assert.equal(kg.state, 'accepted');
  assert.equal(kg.result.mediaId, 'media-kg');
  assert.equal(created.length, 2, 'confirm the existing draft without recreating it');
  const nextHtml = '<section style="padding:0 10px 20px"><section style="padding:20px 12px">'
    + '<p style="font-size:16px;line-height:1.9;text-align:justify;text-align-last:left">kg body</p><p>Source: Fixture News</p>'
    + '</section><section style="background:#f7f5ef;text-align:center">'
    + '<p style="color:#929292;text-align:center;font-size:12px">中亚投资资讯 | Central Asia Investment Daily</p>'
    + '<p style="color:#929292;text-align:center;font-size:12px">数据来源：各国主流媒体</p></section></section>';
  const revision = { ...release, version: issue + '-r2', countries: { ...release.countries,
    kg: { ...release.countries.kg!, bodyHtml: nextHtml } } };
  const originalProof = { media_id: 'media-kg', detail: {
    inputHash: contentHash(release.countries.kg!.bodyHtml), expectedThumbMediaId: 'fixture-thumb', imageUrls: [],
  } };
  let updateStarted = false;
  let updateCalls = 0;
  let updatedHtml: string | undefined;
  const updateAdapters = { async read(mediaId: string) {
    const existing = await adapters.read(mediaId);
    return { ...existing, content: updatedHtml ?? existing.content };
  }, async update(mediaId: string, article: object) {
    assert.equal(mediaId, originalProof.media_id);
    assert.equal(updateStarted, true, 'persist intent before touching WeChat');
    assert.equal((article as {thumb_media_id: string}).thumb_media_id, 'fixture-thumb');
    updateCalls++;
    updatedHtml = (article as {content: string}).content;
    throw new Error('update reply lost');
  } };
  const markUpdate = async () => { updateStarted = true; };
  await assert.rejects(reviseTextLayout(release, revision, 'kg', originalProof, updateAdapters,
    updateStarted, markUpdate, () => {}), /update reply lost/);
  const reformatted = await reviseTextLayout(release, revision, 'kg', originalProof, updateAdapters,
    updateStarted, markUpdate, () => {});
  assert.equal(reformatted?.mediaId, originalProof.media_id);
  assert.equal(reformatted?.layoutVerified, true);
  assert.equal(updateCalls, 1, 'recover a lost update solely by reading the same ID');
  updatedHtml = nextHtml.replace('text-align:justify', 'text-align:left');
  assert.equal(await reviseTextLayout(release, revision, 'kg', originalProof, updateAdapters,
    updateStarted, markUpdate, () => {}), null);
  assert.equal(updateCalls, 1, 'layout mismatch does not issue another write');
  const acceptance = { ...revision, version: issue + '-r3', countries: { ...revision.countries,
    kg: { ...revision.countries.kg!, title: '【实跑验收】' + revision.countries.kg!.title } } };
  let checkpoint: Parameters<typeof deliverValidationDraft>[2];
  const saveCheckpoint = async (value: NonNullable<typeof checkpoint>) => { checkpoint = value; };
  let validationCreates = 0;
  let validationMatches = ['validation-new-id'];
  const validationAdapters = {
    ...adapters,
    async create() {
      assert.ok(checkpoint && !checkpoint.mediaId, 'persist the intention before the API call');
      validationCreates++;
      throw new Error('validation create reply lost');
    },
    async find(title: string) {
      assert.equal(title, acceptance.countries.kg!.title);
      return validationMatches;
    },
    async read(mediaId: string) {
      assert.equal(mediaId, 'validation-new-id');
      return { title: acceptance.countries.kg!.title, digest: acceptance.countries.kg!.summary,
        content: nextHtml, thumb_media_id: 'fixture-thumb' };
    },
  };
  const checkValidation = (payload = acceptance) => deliverValidationDraft(
    payload, 'kg', checkpoint, validationAdapters, saveCheckpoint, () => {});
  await assert.rejects(checkValidation(revision as typeof acceptance), /invalid_validation_title/);
  await assert.rejects(checkValidation(), /validation create reply lost/);
  validationMatches = ['validation-new-id', 'ambiguous-id'];
  assert.equal(await checkValidation(), null);
  validationMatches = ['validation-new-id'];
  const acceptedCopy = await checkValidation();
  assert.equal(acceptedCopy?.mediaId, 'validation-new-id');
  assert.equal(acceptedCopy?.layoutVerified, true);
  assert.equal((await checkValidation())?.mediaId, 'validation-new-id');
  assert.equal(validationCreates, 1, 'validation retries only read back, and do not touch the normal daily receipt');
  console.log('Database delivery: grant scope, deadline, tamper rejection, independent progress, lost reply readback and dedupe passed; real writes=0.');
}

void main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  Date.now = now;
  if (firstIssue === undefined) delete process.env.REVIEWED_PLAN_B_FIRST_ISSUE;
  else process.env.REVIEWED_PLAN_B_FIRST_ISSUE = firstIssue;
  if (ingest === undefined) delete process.env.INGEST_SECRET;
  else process.env.INGEST_SECRET = ingest;
  if (planBIngest === undefined) delete process.env.PLAN_B_INGEST_SECRET;
  else process.env.PLAN_B_INGEST_SECRET = planBIngest;
});
