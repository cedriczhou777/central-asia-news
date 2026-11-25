import { assertHttps, contentHash, imageUrls, replaceImageSources, type ReviewedCountry, type ReviewedImageAsset } from './reviewed-package';
import { lookup } from 'node:dns/promises';
import { FALLBACK_THUMB_JPEG_BASE64 } from './wechat-thumb-fallback';
import { readArchivedImage } from './reviewed-image-archive';
import { readPrivateImage } from './reviewed-private-images';
import { validateOriginalImage } from './reviewed-image-bytes';
import { fetchWechat, globalAgentWechat, inspectWechatNetwork, networkErrors, noAgentWechat, officialStyleWechat,
  WECHAT_API_HOST, type Peer, type WechatRequest } from './reviewed-wechat-transport';

export const REVIEWED_IMAGE_UPLOAD_CONCURRENCY = 2;

let token: { value: string; until: number } | undefined;
let cloudTransport: { protocol: 'http' | 'https'; request: WechatRequest } = {protocol:'http',request:fetchWechat};

async function requestWechat(path: string, options: RequestInit) {
  const cloud = process.env.USE_WECHAT_CLOUD_CALL === 'true' ? cloudTransport : null;
  const target = cloud ? `${cloud.protocol}://${WECHAT_API_HOST}/cgi-bin/${path}` : await apiUrl(path);
  return (cloud?.request ?? fetchWechat)(target,{...options,redirect:'manual'});
}
// Preflight and delivery must use the same verified bytes. A second origin
// fetch used to fail after a successful preflight (and re-download shared images).
const imageCache = new Map<string, { bytes: Buffer; until: number }>();
const IMAGE_CACHE_BYTES = 64 * 1024 * 1024;
let imageCacheBytes = 0;
function cacheImage(key: string, bytes: Buffer) {
  const now = Date.now();
  const previous = imageCache.get(key);
  if (previous) { imageCache.delete(key); imageCacheBytes -= previous.bytes.length; }
  for (const [k, entry] of imageCache) {
    if (entry.until <= now || imageCacheBytes + bytes.length > IMAGE_CACHE_BYTES) {
      imageCache.delete(k); imageCacheBytes -= entry.bytes.length;
    }
  }
  imageCache.set(key, { bytes, until: now + 2 * 60 * 60_000 });
  imageCacheBytes += bytes.length;
}
async function apiUrl(path: string): Promise<string> {
  if (!token || token.until < Date.now()) {
    const appid = process.env.WECHAT_APP_ID;
    const secret = process.env.WECHAT_APP_SECRET;
    if (!appid || !secret) throw new Error('缺少微信应用配置');
    const response = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ grant_type: 'client_credential', appid, secret }),
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) throw new Error(`微信鉴权失败，错误码 ${data.errcode ?? response.status}`);
    token = { value: data.access_token, until: Date.now() + Math.max(60, (data.expires_in || 7200) - 300) * 1000 };
  }
  return `https://api.weixin.qq.com/cgi-bin/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token.value)}`;
}
class WechatResponseError extends Error {
  constructor(readonly kind: 'invalid_json' | 'http_error' | 'wechat_error',
    readonly httpStatus: number, readonly errorCode: string | null) {
    super(`微信接口失败，错误码 ${errorCode ?? httpStatus}`);
  }
}

async function api(path: string, body: object, timeoutMs = 60_000) {
  const response = await requestWechat(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => {
    throw new WechatResponseError('invalid_json', response.status, null);
  });
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new WechatResponseError('invalid_json', response.status, null);
  const errorCode = /^-?\d{1,9}$/.test(String(data.errcode)) && Number(data.errcode) !== 0 ? String(data.errcode) : null;
  if (!response.ok || (data.errcode && Number(data.errcode) !== 0)) {
    throw new WechatResponseError(response.ok ? 'wechat_error' : 'http_error', response.status, errorCode);
  }
  return data;
}
async function normalizedJpeg(buffer: Buffer, edge?: number) {
  const { default: sharp } = await import('sharp');
  if (edge) {
    sharp.concurrency(1);
    sharp.cache({ memory: 8, files: 0, items: 8 });
  }
  const image = sharp(buffer, { limitInputPixels: 40000000 }).rotate().flatten({ background: '#fff' });
  if (edge) image.resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });
  return image.jpeg({ quality: 88 }).toBuffer();
}
async function material(buffer: Buffer, alreadyNormalized = false) {
  const bytes = alreadyNormalized ? buffer : await normalizedJpeg(buffer);
  const form = new FormData();
  form.append('media', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), 'news.jpg');
  const response = await requestWechat('material/add_material?type=image', {
    method: 'POST', body: form, signal: AbortSignal.timeout(60000),
  });
  const data = await response.json();
  if (!response.ok || data.errcode || !data.media_id || !data.url) throw new Error(`图片上传失败，错误码 ${data.errcode ?? response.status}`);
  const url = new URL(data.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('微信图片返回地址无效');
  return { mediaId: String(data.media_id), url: String(data.url) };
}
async function articleImage(buffer: Buffer, alreadyNormalized = false) {
  const bytes = alreadyNormalized ? buffer : await normalizedJpeg(buffer);
  const form = new FormData();
  form.append('media', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), 'news.jpg');
  const response = await requestWechat('media/uploadimg', { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
  const data = await response.json();
  if (!response.ok || data.errcode || !data.url) throw new Error(`正文图片上传失败，错误码 ${data.errcode ?? response.status}`);
  const url = new URL(data.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('微信正文图片地址无效');
  return String(data.url);
}
function publicAddress(address: string): boolean {
  if (address.includes(':')) return /^[23][0-9a-f]{3}:/i.test(address); // globally routed IPv6 only
  const p=address.split('.').map(Number);
  return p.length===4 && p.every(n=>Number.isInteger(n)&&n>=0&&n<=255) &&
    ![0,10,127].includes(p[0]) && p[0]<224 && !(p[0]===169&&p[1]===254) &&
    !(p[0]===172&&p[1]>=16&&p[1]<=31) && !(p[0]===192&&p[1]===168) &&
    !(p[0]===100&&p[1]>=64&&p[1]<=127) && !(p[0]===198&&[18,19].includes(p[1]));
}
async function download(url: string, referer: string, limits?: { deadline: number; requestMs: number }, asset?: ReviewedImageAsset) {
  assertHttps(url);
  // A pinned private original is authoritative. Missing/corrupt storage must not
  // silently fall back to a changed image or retry a denied source through a proxy.
  if (asset) return readPrivateImage(asset);
  const archived = await readArchivedImage(url);
  if (archived) {
    await validateImage(archived);
    return archived;
  }
  const cacheKey = JSON.stringify([url, referer]);
  const cached = imageCache.get(cacheKey);
  if (cached && cached.until > Date.now()) return cached.bytes;
  if (cached) { imageCache.delete(cacheKey); imageCacheBytes -= cached.bytes.length; }
  let response: Response | undefined;
  for (let redirects=0;redirects<=5;redirects++) {
    if (limits && Date.now() >= limits.deadline) throw new Error('图片探测超时');
    assertHttps(url);
    const parsed=new URL(url);
    const addresses=await lookup(parsed.hostname.replace(/^\[|\]$/g,''),{all:true});
    if (!addresses.length || addresses.some(a=>!publicAddress(a.address))) throw new Error('图片地址不是公网地址');
    if (limits && Date.now() >= limits.deadline) throw new Error('图片探测超时');
    // Keep one request identity. Retry transient errors only; never change
    // headers or routes after an authentication/access/rate-limit rejection.
    const headers = { 'User-Agent':'CentralAsiaNews/1.0', 'Accept':'image/*', ...(referer ? { Referer:referer } : {}) };
    let lastError: unknown;
    for (let attempt=0; attempt<3; attempt++) {
      try {
        const requestMs = limits ? Math.max(1, Math.min(limits.requestMs, limits.deadline-Date.now())) : 20000;
        response=await fetch(url,{headers,signal:AbortSignal.timeout(requestMs),redirect:'manual'});
      } catch (error) {
        lastError=error;
        response=undefined;
        continue;
      }
      if (response.ok || ![500,502,503,504].includes(response.status)) break;
      await response.body?.cancel();
    }
    if (!response && lastError) throw new Error(`图片请求失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
    if (!response) throw new Error('图片请求失败');
    if (![301,302,303,307,308].includes(response.status)) break;
    const location=response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects===5) throw new Error('图片重定向异常');
    url=new URL(location,url).href;
  }
  if (!response) throw new Error('图片请求失败');
  if (!response.ok) throw new Error(`来源图片无法读取，HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > 10000000) throw new Error('图片超过10MB');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('图片内容为空');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > 10000000) { await reader.cancel(); throw new Error('图片超过10MB'); }
    chunks.push(next.value);
  }
  const bytes = Buffer.concat(chunks);
  // NBKR's official servlet returns genuine JPEGs without Content-Type.
  // Decode rather than trusting either a missing MIME header or image/* on HTML.
  await validateImage(bytes);
  cacheImage(cacheKey, bytes);
  return bytes;
}
async function validateImage(bytes: Buffer) {
  await validateOriginalImage(bytes);
}
/** Probe the exact image download path without uploading media or creating a draft. */
export async function probeReviewedImage(url: string, referer: string, asset?: ReviewedImageAsset) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = Date.now() + 55000;
    await Promise.race([
      download(url, referer, { deadline, requestMs: 20000 }, asset),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('图片探测超时')), 55000); }),
    ]);
    return { accessible:true as const };
  } catch (error) {
    const reason = (error instanceof Error ? error.message : '图片读取失败').replace(/https?:\/\/\S+/gi, '[链接]').slice(0, 160);
    return { accessible:false as const, reason };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function prepareReviewedDraft(d: ReviewedCountry, onProgress?:()=>Promise<void>, smallContainer = false) {
  const images = imageUrls(d.bodyHtml);
  const uniqueImages = [...new Set(images)];
  const uploadedUrls: string[] = [];
  const imageProbes: Array<{url:string;accessible:true;sha256?:string;bytes?:number;transport:string}> = [];
  const failures: Array<{index:number;error:unknown}> = [];
  let thumb = '';
  let nextIndex = 0;
  let heartbeat = Promise.resolve();
  const reportProgress = () => {
    // Keep the receipt's CAS heartbeats ordered even when images finish out of order.
    if (onProgress) heartbeat = heartbeat.then(onProgress);
    return heartbeat;
  };
  async function prepareImages() {
    while (!failures.length && nextIndex < uniqueImages.length) {
      const index = nextIndex++;
      const url = uniqueImages[index];
      try {
        await reportProgress();
        if (failures.length) return;
        const asset = d.imageAssets?.[url];
        let bytes: Buffer;
        try { bytes = await download(url, d.sourceUrl, undefined, asset); }
        catch(e) { throw new Error(`正文第${images.indexOf(url)+1}张图片：${e instanceof Error?e.message:'读取失败'}`); }
        if (failures.length) return;
        imageProbes[index] = {url,accessible:true,...asset,transport:asset?'private-original':'legacy-https'};
        const image = smallContainer ? await normalizedJpeg(bytes, 1600) : bytes;
        if (index === 0) thumb = (await material(image, smallContainer)).mediaId;
        if (failures.length) return;
        uploadedUrls[index] = await articleImage(image, smallContainer);
        await reportProgress();
      } catch (error) {
        failures.push({index,error});
      }
    }
  }
  // Let both lanes stop before returning an error, with no orphan image tasks.
  const workerCount = Math.min(smallContainer ? 1 : REVIEWED_IMAGE_UPLOAD_CONCURRENCY,uniqueImages.length);
  await Promise.all(Array.from({length:workerCount},()=>prepareImages()));
  if (failures.length) throw failures.sort((a,b)=>a.index-b.index)[0].error;
  const replacements = new Map(uniqueImages.map((url,index)=>[url,uploadedUrls[index]] as const));
  if (!thumb) thumb = (await material(Buffer.from(FALLBACK_THUMB_JPEG_BASE64, 'base64'))).mediaId;
  const html = replaceImageSources(d.bodyHtml, replacements);
  if (imageUrls(html).some(url => ![...replacements.values()].includes(url))) throw new Error('正文图片替换不完整');
  return {
    article: { title: d.title, digest: d.summary, content: html, author: '中亚动态–INVEST',
      thumb_media_id: thumb, content_source_url: '', need_open_comment: 0, only_fans_can_comment: 0 },
    images: images.length, cover: images.length ? 'first_body_image' : 'brand', html, imageProbes,
  };
}
export async function createReviewedDraft(article: object): Promise<string> {
  const data = await api('draft/add', { articles: [article] });
  if (!data.media_id) throw new Error('微信未返回草稿 media_id，禁止盲目重试');
  return String(data.media_id);
}
export async function updateReviewedDraft(mediaId: string, article: object): Promise<void> {
  await api('draft/update', { media_id: mediaId, index: 0, articles: article });
}
export async function readReviewedDraft(mediaId: string, timeoutMs?: number) {
  const data = await api('draft/get', { media_id: mediaId }, timeoutMs);
  const article = data.news_item?.[0];
  if (!article || data.news_item.length !== 1) throw new Error('草稿回读结构异常');
  return article as { title: string; digest: string; content: string; content_source_url?:string; thumb_media_id?:string; thumb_url?:string };
}

function draftListRows(data: {item?: unknown; item_count?: number; total_count?: number}) {
  if (Array.isArray(data.item)) return data.item;
  if (data.item == null && data.item_count === 0 && data.total_count === 0) return [];
  throw new Error('reviewed_draft_list_unavailable');
}

export type VerifiedWechatDraft = {
  mediaId:string; version:string; country:string; title:string; summary:string; readbackHash:string;
};

type LiveDraftSnapshot = Omit<VerifiedWechatDraft,'country'> & {source:'wechat_batch_snapshot';updatedAt?:string};
type DraftReference = VerifiedWechatDraft|LiveDraftSnapshot;

type ProbeClient = {
  id:string; protocol:'http'|'https'; request:WechatRequest; compareOnly?:boolean;
};
const PRIMARY_CLIENTS: ProbeClient[] = [
  {id:'wxapi_request',protocol:'http',request:officialStyleWechat},
  {id:'node_global_agent',protocol:'http',request:globalAgentWechat},
  {id:'node_fetch',protocol:'http',request:fetchWechat},
  {id:'node_no_agent',protocol:'http',request:noAgentWechat,compareOnly:true},
  {id:'node_https_global_agent',protocol:'https',request:globalAgentWechat},
];
type DraftEndpoint = 'draft/get'|'draft/batchget';
type ReadProof = {
  ok:boolean; stage:string; startedAt:string; durationMs:number; httpStatus:number|null; errcode:string|null;
  openApiSeqid:boolean; peer?:Peer; errors?:ReturnType<typeof networkErrors>;
  titleMatches?:boolean; summaryMatches?:boolean; bodyMatches?:boolean;
};

async function probeDraft(client: ProbeClient, endpoint: DraftEndpoint, known: DraftReference | null, useToken: boolean,
    capture?: (snapshot:LiveDraftSnapshot)=>void): Promise<ReadProof> {
  const started = Date.now();
  const timing = () => ({startedAt:new Date(started).toISOString(),durationMs:Date.now()-started});
  const base = {ok:false,httpStatus:null,errcode:null,openApiSeqid:false};
  if (endpoint === 'draft/get' && !known) return {...base,...timing(),stage:'stored_reference_missing'};
  let peer:Peer|undefined;
  let response:Response;
  try {
    const url = useToken ? await apiUrl(endpoint) : `${client.protocol}://${WECHAT_API_HOST}/cgi-bin/${endpoint}`;
    const body = endpoint === 'draft/get' ? {media_id:known!.mediaId} : {offset:0,count:5,no_content:0};
    response = await client.request(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
      redirect:'manual',signal:AbortSignal.timeout(6_000)},value=>{peer=value;});
  } catch (error) {
    const errors = networkErrors(error);
    const stage = errors.some(e=>e.syscall==='getaddrinfo'||['ENOTFOUND','EAI_AGAIN'].includes(e.code)) ? 'dns'
      : errors.some(e=>e.syscall==='connect'||['ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','UND_ERR_CONNECT_TIMEOUT'].includes(e.code)) ? 'tcp'
      : errors.some(e=>/TLS|CERT|SSL/.test(e.code)) ? 'tls'
      : error instanceof Error && ['TimeoutError','AbortError'].includes(error.name) ? 'timeout' : 'before_http';
    return {...base,...timing(),stage,peer,errors};
  }
  const details = {...base,httpStatus:response.status,openApiSeqid:!!response.headers.get('x-openapi-seqid')?.trim(),peer};
  const data = await response.json().catch(()=>null);
  const deniedStatus = [401,403,407].includes(response.status);
  if (!data || typeof data!=='object' || Array.isArray(data)) {
    return {...details,...timing(),stage:deniedStatus?'authorization':'invalid_json'};
  }
  const errcode = /^-?\d{1,9}$/.test(String(data.errcode)) ? String(data.errcode) : null;
  if (!response.ok || data.errcode && Number(data.errcode)!==0) {
    const authorization = deniedStatus || ['40001','40014','40164','41001','42001','48001','50001'].includes(errcode ?? '');
    return {...details,...timing(),errcode,stage:authorization?'authorization':'wechat_response'};
  }
  if (endpoint === 'draft/batchget') {
    let rows:ReturnType<typeof draftListRows>;
    try { rows=draftListRows(data); }
    catch { return {...details,...timing(),errcode,stage:'unexpected_shape'}; }
    for (const row of rows.slice(0,5)) {
      const items=row?.content?.news_item;
      const draft=items?.[0];
      if (typeof row?.media_id!=='string' || !row.media_id || !Array.isArray(items) || items.length!==1
          || typeof draft?.title!=='string' || !draft.title.trim() || typeof draft.content!=='string' || !draft.content.trim()) continue;
      const title=draft.title;
      const summary=typeof draft.digest==='string' ? draft.digest : '';
      const readbackHash=contentHash(draft.content);
      const epoch=row.update_time;
      const updatedAt=Number.isInteger(epoch)&&epoch>0&&epoch<4_102_444_800 ? new Date(epoch*1000).toISOString() : undefined;
      capture?.({source:'wechat_batch_snapshot',mediaId:row.media_id,
        version:contentHash({title,summary,readbackHash}),title,summary,readbackHash,updatedAt});
      break;
    }
    return {...details,...timing(),errcode,ok:true,stage:'verified'};
  }
  const entry = data.news_item?.[0];
  if (!Array.isArray(data.news_item) || data.news_item.length!==1 || !entry || typeof entry.content!=='string' || !known) {
    return {...details,...timing(),errcode,stage:'unexpected_shape'};
  }
  const titleMatches = entry.title===known.title;
  const summaryMatches = (entry.digest ?? '')===known.summary;
  const bodyMatches = contentHash(entry.content)===known.readbackHash;
  const ok = titleMatches && summaryMatches && bodyMatches;
  return {...details,...timing(),errcode,ok,stage:ok?'verified':'stored_version_mismatch',titleMatches,summaryMatches,bodyMatches};
}

/** Test only reads on the same authorized endpoint. Never log returned articles, media IDs or credentials. */
export async function probeReviewedDraftReadiness(known: VerifiedWechatDraft | null,
    {inspect=false,clients=PRIMARY_CLIENTS}: {inspect?:boolean;clients?:ProbeClient[]} = {}) {
  const useToken = process.env.USE_WECHAT_CLOUD_CALL !== 'true';
  const candidates:ProbeClient[] = useToken ? [{id:'standard_https',protocol:'https',request:fetchWechat}] : clients;
  const [network,observed] = await Promise.all([inspect ? inspectWechatNetwork() : null,
    Promise.all(candidates.map(async client=>{
      let snapshot:LiveDraftSnapshot|undefined;
      const batchget=await probeDraft(client,'draft/batchget',known,useToken,value=>{snapshot=value;});
      const historical=await probeDraft(client,'draft/get',known,useToken);
      const useSnapshot=snapshot && (!known || historical.errcode==='40007' || historical.stage==='stored_version_mismatch');
      const reference=useSnapshot && snapshot ? {source:snapshot.source,version:snapshot.version,updatedAt:snapshot.updatedAt}
        : known ? {source:'stored_receipt',version:known.version,country:known.country} : null;
      return {client:client.id,protocol:client.protocol,compareOnly:client.compareOnly ?? false,batchget,reference,
        get:useSnapshot && snapshot ? await probeDraft(client,'draft/get',snapshot,useToken) : historical,
        ...(useSnapshot && known?{historicalGet:historical}:{})};
    }))]);
  const usable = observed.find(row=>!row.compareOnly && row.get.ok && row.batchget.ok
    && (useToken || row.get.openApiSeqid || row.batchget.openApiSeqid));
  if (!useToken && usable) {
    const client = clients.find(entry=>entry.id===usable.client)!;
    cloudTransport = {protocol:client.protocol,request:client.request};
  }
  return {transport:useToken?'access_token':'cloud_call',ready:!!usable,client:usable?.client ?? null,
    get:usable?.get.ok ?? observed.some(row=>row.get.ok),
    batchget:usable?.batchget.ok ?? observed.some(row=>row.batchget.ok),
    openApiSeqid:observed.some(row=>row.get.openApiSeqid || row.batchget.openApiSeqid),
    reference:usable?.reference ?? (known?{source:'stored_receipt',version:known.version,country:known.country}:null),network,observed};
}

/** Read one page only when draft/add had an unknown result with no media ID. */
export async function findRecentReviewedDrafts(title: string, digest: string, since: number) {
  const rows = draftListRows(await api('draft/batchget', { offset: 0, count: 20, no_content: 0 }));
  return [...new Set<string>(rows.flatMap((row: {
    media_id?: unknown; update_time?: number; content?: { news_item?: { title?: string; digest?: string }[] };
  }) => {
    const articles = row?.content?.news_item;
    return typeof row?.media_id === 'string' && row.media_id && typeof row.update_time === 'number'
      && row.update_time * 1_000 >= since && articles?.length === 1
      && articles[0].title === title && articles[0].digest === digest ? [row.media_id] : [];
  }))];
}
