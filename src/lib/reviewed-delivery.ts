import { getSupabaseClient } from '../storage/database/supabase-client';
import { PACKAGE_COUNTRIES, contentHash, imageUrls, makeSourceUrlsVisible, sourceUrls, validatePackage, type ReviewedPackage } from './reviewed-package';
import { prepareReviewedDraft, createReviewedDraft, updateReviewedDraft, readReviewedDraft } from './reviewed-wechat';
import { load } from 'cheerio';

type DeliveryAdapters = {
  prepare: typeof prepareReviewedDraft;
  create: typeof createReviewedDraft;
  update?: typeof updateReviewedDraft;
  read: typeof readReviewedDraft;
};
export const deliveryAdapters: DeliveryAdapters = { prepare: prepareReviewedDraft, create: createReviewedDraft, update: updateReviewedDraft, read: readReviewedDraft };
function verifyReadback(d: ReviewedPackage['countries']['kz'], readback: Awaited<ReturnType<typeof readReviewedDraft>>, expectedImages: string[]) {
  const text = (html: string) => load(html, {}, false).text().replace(/\s+/g,'');
  const images = imageUrls(readback.content);
  const imageKey = (url: string) => { try { const u=new URL(url); return `${u.hostname}${u.pathname}`; } catch { return ''; } };
  const expectedSourceUrls = sourceUrls(d.bodyHtml);
  const actualText = text(readback.content);
  const expectedText = text(makeSourceUrlsVisible(d.bodyHtml));
  const imageMatch = images.length === expectedImages.length && images.every((url,i)=>imageKey(url) === imageKey(expectedImages[i]) && !!imageKey(url));
  const legacyTextMatch = actualText === text(d.bodyHtml);
  const sourceUrlsVisible = expectedSourceUrls.every(url => actualText.includes(text(url)));
  const passed = readback.title === d.title && readback.digest === d.summary && actualText === expectedText && sourceUrlsVisible && imageMatch;
  return { draftImages:images.length, readbackHash:contentHash(readback.content), sourceUrlsVisible, legacyTextMatch, expectedTextMatch:actualText === expectedText, imageMatch, verified:passed };
}
export async function deliverReviewedPackage(
  payload: ReviewedPackage,
  sb = getSupabaseClient(),
  adapters = deliveryAdapters,
  onlyCountries: readonly (typeof PACKAGE_COUNTRIES)[number][] = PACKAGE_COUNTRIES,
) {
  const drafts: object[] = []; const failures: object[] = [];
  for (const country of onlyCountries) {
    const key = { version: payload.version, country };
    // The unique PK is the cross-process lock. A sending/uncertain row is never retried automatically.
    const claim = await sb.from('reviewed_deliveries').insert({ ...key, state: 'preparing' });
    if (claim.error) {
      if (claim.error.code !== '23505') throw new Error('无法取得持久化投递锁');
      const existing = await sb.from('reviewed_deliveries').select('*').match(key).single();
      if (existing.error) throw new Error('无法读取投递状态');
      if (existing.data.state === 'succeeded') { drafts.push({ country_code:country, media_id:existing.data.media_id, ...existing.data.detail }); continue; }
      // Read-only recovery: never call draft/add again when a media_id is known.
      if (['uncertain','sending','updating'].includes(existing.data.state) && existing.data.media_id) {
        let updateLockAcquired = false;
        try {
          const current = await adapters.read(existing.data.media_id);
          let verified = verifyReadback(payload.countries[country], current, existing.data.detail?.imageUrls || []);
          if (!verified.verified) {
            const d = payload.countries[country];
            const updateDraft = adapters.update;
            const staleUpdate = existing.data.state === 'updating' && Date.now() - Date.parse(existing.data.updated_at || '') > 5 * 60_000;
            const safelyRepairable = !!updateDraft && (existing.data.state === 'uncertain' || staleUpdate) && current.title === d.title && current.digest === d.summary &&
              ((verified.legacyTextMatch && verified.imageMatch && !verified.sourceUrlsVisible && sourceUrls(d.bodyHtml).length > 0) ||
               (verified.expectedTextMatch && verified.sourceUrlsVisible && verified.draftImages === 0 && (existing.data.detail?.imageUrls || []).length > 0));
            if (!safelyRepairable) throw new Error('已有草稿复核未通过；未重复创建');
            const prepared = await adapters.prepare(d);
            const lock = await sb.from('reviewed_deliveries').update({ state:'updating', updated_at:new Date().toISOString() })
              .match(key).eq('state',existing.data.state).eq('media_id',existing.data.media_id).select('country');
            if (lock.error || lock.data?.length !== 1) throw new Error('未取得原草稿更新锁');
            updateLockAcquired = true;
            await updateDraft(existing.data.media_id, prepared.article);
            const updated = await adapters.read(existing.data.media_id);
            verified = verifyReadback(d, updated, imageUrls(prepared.html));
            if (!verified.verified) throw new Error('原草稿更新后仍未通过审定稿核验');
          }
          const detail = {...existing.data.detail, ...verified, error:null};
          const saved = await sb.from('reviewed_deliveries').update({state:'succeeded', detail, updated_at:new Date().toISOString()}).match(key).eq('media_id',existing.data.media_id);
          if (saved.error) throw new Error('复核回执保存失败');
          drafts.push({country_code:country, media_id:existing.data.media_id,...detail});
        } catch (error) {
          if (updateLockAcquired) await sb.from('reviewed_deliveries').update({state:'uncertain',detail:{...existing.data.detail,error:error instanceof Error?error.message:String(error)},updated_at:new Date().toISOString()}).match(key).eq('state','updating');
          failures.push({country,state:existing.data.state,media_id:existing.data.media_id,error:'已有草稿复核未通过；未重复创建'});
        }
        continue;
      }
      if (existing.data.state !== 'failed') { failures.push({ country, state: existing.data.state, error: '投递进行中或结果待核实，禁止重复创建' }); continue; }
      const retry = await sb.from('reviewed_deliveries').update({ state: 'preparing', updated_at: new Date().toISOString() }).match(key).eq('state','failed').select('country');
      if (retry.error || retry.data?.length !== 1) { failures.push({ country, error: '未取得重试锁' }); continue; }
    }
    let sending = false;
    let mediaId: string | null = null;
    let detail: Record<string,unknown> = {};
    try {
      const d = payload.countries[country];
      const prepared = await adapters.prepare(d);
      detail = { inputHash: contentHash(d.bodyHtml), transportedHash: contentHash(prepared.html),
        inputImages: prepared.images, transferredImages: prepared.images, imageUrls:imageUrls(prepared.html), cover: prepared.cover };
      const armed = await sb.from('reviewed_deliveries').update({ state:'sending', detail, updated_at: new Date().toISOString() }).match(key).eq('state','preparing').select('country');
      if (armed.error || armed.data?.length !== 1) throw new Error('发送前持久化失败');
      sending = true;
      mediaId = await adapters.create(prepared.article);
      // Save the returned media_id BEFORE readback; a readback error must never create a second draft.
      const saved = await sb.from('reviewed_deliveries').update({ media_id:mediaId, detail, updated_at:new Date().toISOString() }).match(key).select('country');
      if (saved.error || saved.data?.length !== 1) throw new Error('草稿已创建但回执保存失败，须人工核对');
      const readback = await adapters.read(mediaId);
      const verified = verifyReadback(d, readback, imageUrls(prepared.html));
      const passed = verified.verified;
      detail = { ...detail, ...verified };
      if (!passed) throw new Error('草稿回读与审定稿不一致，保留现有草稿待检查');
      const done = await sb.from('reviewed_deliveries').update({ state:'succeeded', media_id:mediaId, detail, updated_at:new Date().toISOString() }).match(key).select('country');
      if (done.error || done.data?.length !== 1) throw new Error('成功状态保存失败');
      drafts.push({ country_code:country, media_id:mediaId, ...detail });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = sending ? 'uncertain' : 'failed';
      await sb.from('reviewed_deliveries').update({ state, media_id:mediaId, detail:{ ...detail, error:message }, updated_at:new Date().toISOString() }).match(key);
      failures.push({ country, state, media_id:mediaId, error:message });
    }
  }
  return { ok:failures.length === 0 && drafts.length === onlyCountries.length, version:payload.version, drafts, failures };
}
export async function readPackage(version: string) {
  const result = await getSupabaseClient().from('reviewed_packages').select('payload,content_hash').eq('version',version).maybeSingle();
  if (result.error) throw new Error('稿包数据库未就绪或读取失败');
  if (!result.data) return null;
  const payload = validatePackage(result.data.payload);
  if (payload.version !== version || contentHash(payload) !== result.data.content_hash) throw new Error('稿包哈希核验失败');
  return payload;
}
