import assert from 'node:assert/strict';
import { reconcileKnownReviewedDraft } from '../src/lib/reviewed-delivery';
import { contentHash, type ReviewedPackage } from '../src/lib/reviewed-package';

const article = { title: '回读测试', summary: '合成样例', bodyHtml: '<p>签审正文</p>',
  sourceName: '示例编辑部', sourceUrl: '', coverUrl: '' };
const packageFixture: ReviewedPackage = { version: '2026-11-21-r102', countries: { kz: article }, readyCountries:['kz'] };
const readback = { title: article.title, digest: article.summary, content: article.bodyHtml, thumb_media_id:'fixture-thumb' };
type Row = { state: string; media_id: string | null; updated_at: string; detail: Record<string, unknown> };

function database() {
  let row: Row = { state: 'uncertain', media_id: null, updated_at: '2026-11-21T08:58:00+08:00',
    detail: { inputHash: contentHash(article.bodyHtml), imageUrls: [], expectedThumbMediaId: 'fixture-thumb' } };
  let writes = 0;
  return {
    current: () => row, writes: () => writes,
    sb: {
      from(table: string) {
        assert.equal(table, 'reviewed_deliveries');
        const keys: Record<string, unknown> = {};
        let next: Partial<Row> | undefined;
        const query = {
          match(key: object) { Object.assign(keys,key); return query; },
          eq(key: string, value: unknown) { keys[key] = value; return query; },
          is(key: string, value: unknown) { keys[key] = value; return query; },
          maybeSingle() { return Promise.resolve({ data: structuredClone(row), error: null }); },
          update(value: Partial<Row>) { next = value; return query; },
          select() {
            if (!next) return query;
            assert.deepEqual(keys, { version: packageFixture.version, country: 'kz', updated_at: row.updated_at, media_id: row.media_id });
            row = { ...row, ...next };
            writes++;
            return Promise.resolve({ error: null, data: [{ media_id: row.media_id }] });
          },
        };
        return query;
      },
    } as unknown as Parameters<typeof reconcileKnownReviewedDraft>[2],
  };
}

async function main() {
  const fixture = database();
  let reads = 0;
  const checked = async (id: string) => { assert.equal(id, 'existing-draft'); reads++; return readback; };
  assert.equal(await reconcileKnownReviewedDraft(packageFixture, 'kz', fixture.sb, checked,
    async () => ['existing-draft','ambiguous-draft']), null);
  assert.equal(reads, 0);
  assert.equal(fixture.writes(), 0);
  assert.equal(await reconcileKnownReviewedDraft(packageFixture, 'kz', fixture.sb,
    async () => ({ ...readback, thumb_media_id:'different' }), async () => ['existing-draft']), null);
  assert.equal(fixture.current().state, 'uncertain');
  const result = await reconcileKnownReviewedDraft(packageFixture, 'kz', fixture.sb, checked, async () => ['existing-draft']);
  assert.equal(result?.mediaId, 'existing-draft');
  assert.equal(fixture.current().state, 'succeeded');
  assert.equal(fixture.writes(), 1);
  await reconcileKnownReviewedDraft(packageFixture, 'kz', fixture.sb, async () => { throw new Error('must reuse existing proof'); });
  assert.equal(reads, 1);
  assert.equal(fixture.writes(), 1);
  console.log('Uncertain WeChat write: ambiguous/error stays blocked, exact existing draft readback is idempotent.');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
