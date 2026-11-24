import { getSupabaseClient } from '../storage/database/supabase-client';
import { PACKAGE_COUNTRIES, packageCountries, reviewedCountry, contentHash, imageUrls, makeSourceUrlsVisible, sourceUrls, validatePackage, type ReviewedPackage, type ReviewedCountry } from './reviewed-package';
import { prepareReviewedDraft, createReviewedDraft, updateReviewedDraft, readReviewedDraft, findRecentReviewedDrafts } from './reviewed-wechat';
import { load } from 'cheerio';
import { randomUUID } from 'node:crypto';
import { compareReviewedCover } from './reviewed-diagnostics';

export function canResumePreparation(row:{state:string;media_id?:string|null;updated_at?:string;detail?:Record<string,unknown>},now=Date.now()) {
  return row.state==='preparing'&&!row.media_id&&row.detail?.preparationProtocol===1&&typeof row.detail.preparationToken==='string'&&
    Number.isFinite(Date.parse(row.updated_at||''))&&now-Date.parse(row.updated_at!)>5*60_000;
}

type DeliveryAdapters = {
  prepare: typeof prepareReviewedDraft;
  create: typeof createReviewedDraft;
  update?: typeof updateReviewedDraft;
  read: typeof readReviewedDraft;
  beforeWrite?: () => void;
};
export const deliveryAdapters: DeliveryAdapters = { prepare: prepareReviewedDraft, create: createReviewedDraft, update: updateReviewedDraft, read: readReviewedDraft };
function verifyReadback(d: ReviewedCountry, readback: Awaited<ReturnType<typeof readReviewedDraft>>, expectedImages: string[], expectedThumbId?:string) {
  const text = (html: string) => load(html, {}, false).text().replace(/\s+/g,'');
  const $ = load(readback.content, {}, false);
  const images = $('img').toArray().map(el => $(el).attr('src') || $(el).attr('data-src') || '');
  const imageKey = (url: string) => { try { const u=new URL(url); const path = u.hostname.endsWith('.qpic.cn') ? u.pathname.replace(/\/(?:0|640)$/, '') : u.pathname; return `${u.hostname}${path}`; } catch { return ''; } };
  const expectedSourceUrls = sourceUrls(d.bodyHtml);
  const actualText = text(readback.content);
  const expectedText = text(d.bodyHtml);
  const imageMatch = images.length === expectedImages.length && images.every((url,i)=>imageKey(url) === imageKey(expectedImages[i]) && !!imageKey(url));
  const legacyTextMatch = actualText === text(makeSourceUrlsVisible(d.bodyHtml));
  const sourceUrlsVisible = expectedSourceUrls.every(url => actualText.includes(text(url)));
  const cover=compareReviewedCover(readback,expectedImages[0],expectedThumbId);
  const passed = readback.title === d.title && readback.digest === d.summary && actualText === expectedText && imageMatch && cover.thumbnailMatchesPrepared !== false;
  return { draftImages:images.length, readbackHash:contentHash(readback.content), sourceUrlsVisible, legacyTextMatch, expectedTextMatch:actualText === expectedText, imageMatch, ...cover, verified:passed };
}

/** Safe settlement with a previously persisted media ID. Does not prepare,
 * upload, add or update a WeChat draft, even if readback does not match. */
export async function reconcileKnownReviewedDraft(payload: ReviewedPackage, country: import('./reviewed-package').PackageCountry,
    sb = getSupabaseClient(), read = readReviewedDraft, find: typeof findRecentReviewedDrafts = findRecentReviewedDrafts,
    verifyStoredSuccess = false) {
  const key = { version: payload.version, country };
  const receipt = await sb.from('reviewed_deliveries').select('media_id,state,detail,updated_at').match(key).maybeSingle();
  if (receipt.error) throw new Error('reviewed_receipt_read_failed');
  const row = receipt.data;
  if (!row || !['sending','updating','uncertain','succeeded'].includes(row.state)) return null;
  if (row.state === 'succeeded' && !verifyStoredSuccess) return row.media_id ? { mediaId: row.media_id, readbackAt: row.updated_at, ...row.detail } : null;
  const draft = reviewedCountry(payload,country);
  const proof = row.detail || {};
  if (verifyStoredSuccess && (!Array.isArray(proof.imageUrls) || !proof.expectedThumbMediaId
      || proof.inputHash !== contentHash(draft.bodyHtml) || (row.state === 'succeeded' && !row.media_id))) return null;
  let mediaId: string | null = row.media_id;
  if (!mediaId) {
    const at = Date.parse(row.updated_at);
    if (row.state === 'updating' || !Number.isFinite(at) || !Array.isArray(proof.imageUrls)
        || !proof.expectedThumbMediaId || proof.inputHash !== contentHash(draft.bodyHtml)) return null;
    const candidates = await find(draft.title, draft.summary, at - 120_000);
    // Avoid any mutation when multiple drafts fit. Only a unique recent item
    // with title, summary, full text, exact image order and thumbnail can bind.
    if (candidates.length !== 1) return null;
    mediaId = candidates[0];
  }
  const verified = verifyReadback(draft, await read(mediaId), proof.imageUrls || [], proof.expectedThumbMediaId);
  if (!verified.verified) return null;
  const detail = { ...row.detail, ...verified, error: null, readbackAt: new Date().toISOString() };
  let update = sb.from('reviewed_deliveries').update({ state: 'succeeded', media_id: mediaId, detail, updated_at: new Date().toISOString() })
    .match(key).eq('updated_at', row.updated_at);
  update = row.media_id ? update.eq('media_id', row.media_id) : update.is('media_id', null);
  const saved = await update.select('media_id');
  if (saved.error || saved.data?.length !== 1) throw new Error('reviewed_receipt_changed');
  return { mediaId, ...detail };
}
export async function deliverReviewedPackage(
  payload: ReviewedPackage,
  sb = getSupabaseClient(),
  adapters = deliveryAdapters,
  onlyCountries: readonly import('./reviewed-package').PackageCountry[] = packageCountries(payload),
) {
  payload=validatePackage(payload);
  if(!onlyCountries.length||new Set(onlyCountries).size!==onlyCountries.length)throw new Error('投递国家须为非空无重复子集');
  // Validate the whole requested scope before claiming any country, including
  // callers which invoke the delivery layer without passing through HTTP.
  for(const country of onlyCountries)reviewedCountry(payload,country);
  const drafts: object[] = []; const failures: object[] = [];
  for (const country of onlyCountries) {
    const key = { version: payload.version, country };
    const preparationToken=randomUUID();
    const ownership={preparationToken,preparationProtocol:1};
    // The unique PK is the cross-process lock. A sending/uncertain row is never retried automatically.
    const claim = await sb.from('reviewed_deliveries').insert({ ...key, state: 'preparing',detail:ownership,updated_at:new Date().toISOString() });
    if (claim.error) {
      if (claim.error.code !== '23505') throw new Error('无法取得持久化投递锁');
      const existing = await sb.from('reviewed_deliveries').select('*').match(key).maybeSingle();
      if (existing.error) throw new Error('无法读取投递状态');
      if (!existing.data) { failures.push({ country, state:'blocked', error:'同刊期其他版本已有投递记录，禁止重复创建' }); continue; }
      if (existing.data.state === 'succeeded') { drafts.push({ country_code:country, media_id:existing.data.media_id, ...existing.data.detail }); continue; }
      // Never call draft/add again when a media_id is known. A narrowly verified
      // repair may update that same draft, under a compare-and-swap receipt lock.
      if (['uncertain','sending','updating'].includes(existing.data.state) && existing.data.media_id) {
        let updateLockAcquired = false;
        try {
          const current = await adapters.read(existing.data.media_id);
          let verified = verifyReadback(reviewedCountry(payload,country), current, existing.data.detail?.imageUrls || [], existing.data.detail?.expectedThumbMediaId);
          if (!verified.verified) {
            const d = reviewedCountry(payload,country);
            const updateDraft = adapters.update;
            // Elapsed time cannot prove another worker stopped updating WeChat.
            const candidates=[{check:verified,images:existing.data.detail?.imageUrls || []}];
            const repairFrom=existing.data.detail?.repairFrom;
            if(Array.isArray(repairFrom?.imageUrls))candidates.push({
              check:verifyReadback(d,current,repairFrom.imageUrls,repairFrom.expectedThumbMediaId),images:repairFrom.imageUrls});
            const repairable=candidates.find(({check,images})=>
              (check.legacyTextMatch && check.imageMatch && sourceUrls(d.bodyHtml).length>0) ||
              ((check.expectedTextMatch || check.legacyTextMatch) && check.draftImages===0 && images.length>0) ||
              (check.expectedTextMatch && check.imageMatch && check.thumbnailMatchesPrepared===false));
            if (!updateDraft || existing.data.state!=='uncertain' || current.title!==d.title || current.digest!==d.summary || !repairable)
              throw new Error('已有草稿复核未通过；未重复创建');
            const prepared = await adapters.prepare(d);
            // Persist both the planned outcome and the observed safe input
            // before the external update. An accepted update with a lost
            // readback can then be reconciled without uploading again.
            const plannedDetail={...existing.data.detail,imageUrls:imageUrls(prepared.html),transportedHash:contentHash(prepared.html),
              expectedThumbMediaId:prepared.article.thumb_media_id,
              repairFrom:{imageUrls:repairable.images,expectedThumbMediaId:current.thumb_media_id}};
            adapters.beforeWrite?.();
            const lock = await sb.from('reviewed_deliveries').update({ state:'updating', detail:plannedDetail, updated_at:new Date().toISOString() })
              .match(key).eq('state',existing.data.state).eq('media_id',existing.data.media_id)
              .eq('updated_at',existing.data.updated_at).select('country');
            if (lock.error || lock.data?.length !== 1) throw new Error('未取得原草稿更新锁');
            updateLockAcquired = true;
            existing.data.detail=plannedDetail;
            await updateDraft(existing.data.media_id, prepared.article);
            const updated = await adapters.read(existing.data.media_id);
            verified = verifyReadback(d, updated, imageUrls(prepared.html), prepared.article.thumb_media_id);
            if (!verified.verified) throw new Error('原草稿更新后仍未通过审定稿核验');
          }
          const detail = {...existing.data.detail, ...verified, error:null};
          const saved = await sb.from('reviewed_deliveries').update({state:'succeeded', detail, updated_at:new Date().toISOString()}).match(key).eq('media_id',existing.data.media_id);
          if (saved.error) throw new Error('复核回执保存失败');
          drafts.push({country_code:country, media_id:existing.data.media_id,...detail});
        } catch (error) {
          if (updateLockAcquired) await sb.from('reviewed_deliveries').update({state:'uncertain',detail:{...existing.data.detail,error:error instanceof Error?error.message:String(error)},updated_at:new Date().toISOString()}).match(key).eq('state','updating');
          const reason = (error instanceof Error ? error.message : '未知错误').replace(/https?:\/\/\S+/gi, '[链接]').slice(0, 180);
          failures.push({country,state:existing.data.state,media_id:existing.data.media_id,error:'已有草稿复核未通过；未重复创建',reason});
        }
        continue;
      }
      const resume=canResumePreparation(existing.data);
      if (!resume&&(existing.data.state !== 'failed' || existing.data.media_id)) { failures.push({ country, state: existing.data.state, error: '投递进行中或结果待核实，禁止重复创建' }); continue; }
      let reclaim=sb.from('reviewed_deliveries').update({ state:'preparing',detail:ownership,updated_at:new Date().toISOString() }).match(key).eq('state',resume?'preparing':'failed').is('media_id',null);
      if(resume)reclaim=reclaim.eq('updated_at',existing.data.updated_at).contains('detail',{preparationToken:existing.data.detail.preparationToken});
      const retry = await reclaim.select('country');
      if (retry.error || retry.data?.length !== 1) { failures.push({ country, error: '未取得重试锁；同刊期可能已有其他版本投递' }); continue; }
    }
    let sending = false;
    let mediaId: string | null = null;
    let detail: Record<string,unknown> = {...ownership};
    try {
      const d = reviewedCountry(payload,country);
      const heartbeat=async()=>{
        const kept=await sb.from('reviewed_deliveries').update({updated_at:new Date().toISOString()}).match(key).eq('state','preparing').contains('detail',{preparationToken}).select('country');
        if(kept.error||kept.data?.length!==1)throw new Error('准备工作已由其他执行者接续，停止旧执行');
      };
      const prepared = await adapters.prepare(d,heartbeat);
      detail = { ...ownership,inputHash: contentHash(d.bodyHtml), transportedHash: contentHash(prepared.html),
        inputImages: prepared.images, transferredImages: prepared.images, imageUrls:imageUrls(prepared.html), cover: prepared.cover,
        imageProbes: prepared.imageProbes, expectedThumbMediaId:prepared.article.thumb_media_id };
      adapters.beforeWrite?.();
      const armed = await sb.from('reviewed_deliveries').update({ state:'sending', detail, updated_at: new Date().toISOString() }).match(key).eq('state','preparing').contains('detail',{preparationToken}).select('country');
      if (armed.error || armed.data?.length !== 1) throw new Error('发送前持久化失败');
      sending = true;
      mediaId = await adapters.create(prepared.article);
      // Save the returned media_id BEFORE readback; a readback error must never create a second draft.
      const saved = await sb.from('reviewed_deliveries').update({ media_id:mediaId, detail, updated_at:new Date().toISOString() }).match(key).contains('detail',{preparationToken}).select('country');
      if (saved.error || saved.data?.length !== 1) throw new Error('草稿已创建但回执保存失败，须人工核对');
      const readback = await adapters.read(mediaId);
      const verified = verifyReadback(d, readback, imageUrls(prepared.html), prepared.article.thumb_media_id);
      const passed = verified.verified;
      detail = { ...detail, ...verified, ...(adapters.beforeWrite ? { readbackAt: new Date().toISOString() } : {}) };
      if (!passed) throw new Error('草稿回读与审定稿不一致，保留现有草稿待检查');
      const done = await sb.from('reviewed_deliveries').update({ state:'succeeded', media_id:mediaId, detail, updated_at:new Date().toISOString() }).match(key).contains('detail',{preparationToken}).select('country');
      if (done.error || done.data?.length !== 1) throw new Error('成功状态保存失败');
      drafts.push({ country_code:country, media_id:mediaId, ...detail });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = sending ? 'uncertain' : 'failed';
      await sb.from('reviewed_deliveries').update({ state, media_id:mediaId, detail:{ ...detail, error:message }, updated_at:new Date().toISOString() }).match(key).contains('detail',{preparationToken});
      failures.push({ country, state, media_id:mediaId, error:message });
    }
  }
  return { ok:failures.length === 0 && drafts.length === onlyCountries.length, version:payload.version, drafts, failures,
    countries:[...onlyCountries],readyCountries:packageCountries(payload),partialDelivery:onlyCountries.length<5,
    missingCountries:PACKAGE_COUNTRIES.filter(country=>!onlyCountries.includes(country)) };
}
export async function readPackage(version: string) {
  const result = await getSupabaseClient().from('reviewed_packages').select('payload,content_hash').eq('version',version).maybeSingle();
  if (result.error) throw new Error('稿包数据库未就绪或读取失败');
  if (!result.data) return null;
  const payload = validatePackage(result.data.payload);
  if (payload.version !== version || contentHash(payload) !== result.data.content_hash) throw new Error('稿包哈希核验失败');
  return payload;
}
