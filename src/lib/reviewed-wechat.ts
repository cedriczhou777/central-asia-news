import { assertHttps, imageUrls, replaceImageSources, type ReviewedCountry, type ReviewedImageAsset } from './reviewed-package';
import { lookup } from 'node:dns/promises';
import { FALLBACK_THUMB_JPEG_BASE64 } from './wechat-thumb-fallback';
import { readArchivedImage } from './reviewed-image-archive';
import { readPrivateImage } from './reviewed-private-images';
import { validateOriginalImage } from './reviewed-image-bytes';

let token: { value: string; until: number } | undefined;
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
  if (process.env.USE_WECHAT_CLOUD_CALL === 'true') return `http://api.weixin.qq.com/cgi-bin/${path}`;
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
async function api(path: string, body: object) {
  const response = await fetch(await apiUrl(path), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  const data = await response.json();
  if (!response.ok || data.errcode) throw new Error(`微信接口失败，错误码 ${data.errcode ?? response.status}`);
  return data;
}
async function material(buffer: Buffer) {
  const { default: sharp } = await import('sharp');
  const bytes = await sharp(buffer, { limitInputPixels: 40000000 }).rotate().flatten({ background: '#fff' }).jpeg({ quality: 88 }).toBuffer();
  const form = new FormData();
  form.append('media', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), 'news.jpg');
  const response = await fetch(await apiUrl('material/add_material?type=image'), {
    method: 'POST', body: form, signal: AbortSignal.timeout(60000),
  });
  const data = await response.json();
  if (!response.ok || data.errcode || !data.media_id || !data.url) throw new Error(`图片上传失败，错误码 ${data.errcode ?? response.status}`);
  const url = new URL(data.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('微信图片返回地址无效');
  return { mediaId: String(data.media_id), url: String(data.url) };
}
async function articleImage(buffer: Buffer) {
  const { default: sharp } = await import('sharp');
  const bytes = await sharp(buffer, { limitInputPixels: 40000000 }).rotate().flatten({ background: '#fff' }).jpeg({ quality: 88 }).toBuffer();
  const form = new FormData();
  form.append('media', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), 'news.jpg');
  const response = await fetch(await apiUrl('media/uploadimg'), { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
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
export async function prepareReviewedDraft(d: ReviewedCountry, onProgress?:()=>Promise<void>) {
  const images = imageUrls(d.bodyHtml);
  const replacements = new Map<string,string>();
  const imageProbes: Array<{url:string;accessible:true;sha256?:string;bytes?:number;transport:string}> = [];
  let thumb = '';
  for (const url of [...new Set(images)]) {
    await onProgress?.();
    const asset = d.imageAssets?.[url];
    let bytes: Buffer;
    try { bytes = await download(url, d.sourceUrl, undefined, asset); }
    catch(e) { throw new Error(`正文第${images.indexOf(url)+1}张图片：${e instanceof Error?e.message:'读取失败'}`); }
    imageProbes.push({url,accessible:true,...asset,transport:asset?'private-original':'legacy-https'});
    if (!thumb) thumb = (await material(bytes)).mediaId;
    replacements.set(url, await articleImage(bytes));
    await onProgress?.();
  }
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
export async function readReviewedDraft(mediaId: string) {
  const data = await api('draft/get', { media_id: mediaId });
  const article = data.news_item?.[0];
  if (!article || data.news_item.length !== 1) throw new Error('草稿回读结构异常');
  return article as { title: string; digest: string; content: string };
}
