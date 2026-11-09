import { assertHttps, imageUrls, replaceImageSources, type ReviewedCountry } from './reviewed-package';
import { lookup } from 'node:dns/promises';
import { FALLBACK_THUMB_JPEG_BASE64 } from './wechat-thumb-fallback';

let token: { value: string; until: number } | undefined;
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
function publicAddress(address: string): boolean {
  if (address.includes(':')) return /^[23][0-9a-f]{3}:/i.test(address); // globally routed IPv6 only
  const p=address.split('.').map(Number);
  return p.length===4 && p.every(n=>Number.isInteger(n)&&n>=0&&n<=255) &&
    ![0,10,127].includes(p[0]) && p[0]<224 && !(p[0]===169&&p[1]===254) &&
    !(p[0]===172&&p[1]>=16&&p[1]<=31) && !(p[0]===192&&p[1]===168) &&
    !(p[0]===100&&p[1]>=64&&p[1]<=127) && !(p[0]===198&&[18,19].includes(p[1]));
}
async function download(url: string) {
  let response: Response | undefined;
  for (let redirects=0;redirects<=5;redirects++) {
    assertHttps(url);
    const parsed=new URL(url);
    const addresses=await lookup(parsed.hostname.replace(/^\[|\]$/g,''),{all:true});
    if (!addresses.length || addresses.some(a=>!publicAddress(a.address))) throw new Error('图片地址不是公网地址');
    response=await fetch(url,{signal:AbortSignal.timeout(30000),redirect:'manual'});
    if (![301,302,303,307,308].includes(response.status)) break;
    const location=response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects===5) throw new Error('图片重定向异常');
    url=new URL(location,url).href;
  }
  if (!response) throw new Error('图片请求失败');
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error(`来源图片无法读取，HTTP ${response.status}`);
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
  return Buffer.concat(chunks);
}
export async function prepareReviewedDraft(d: ReviewedCountry) {
  const images = imageUrls(d.bodyHtml);
  const replacements = new Map<string,string>();
  let thumb = '';
  for (const url of [...new Set(images)]) {
    const uploaded = await material(await download(url));
    replacements.set(url, uploaded.url);
    if (!thumb) thumb = uploaded.mediaId;
  }
  if (!thumb) thumb = (await material(Buffer.from(FALLBACK_THUMB_JPEG_BASE64, 'base64'))).mediaId;
  const html = replaceImageSources(d.bodyHtml, replacements);
  if (imageUrls(html).some(url => ![...replacements.values()].includes(url))) throw new Error('正文图片替换不完整');
  return {
    article: { title: d.title, digest: d.summary, content: html, author: '中亚动态–INVEST',
      thumb_media_id: thumb, content_source_url: d.sourceUrl, need_open_comment: 0, only_fans_can_comment: 0 },
    images: images.length, cover: images.length ? 'first_body_image' : 'brand', html,
  };
}
export async function createReviewedDraft(article: object): Promise<string> {
  const data = await api('draft/add', { articles: [article] });
  if (!data.media_id) throw new Error('微信未返回草稿 media_id，禁止盲目重试');
  return String(data.media_id);
}
export async function readReviewedDraft(mediaId: string) {
  const data = await api('draft/get', { media_id: mediaId });
  const article = data.news_item?.[0];
  if (!article || data.news_item.length !== 1) throw new Error('草稿回读结构异常');
  return article as { title: string; digest: string; content: string };
}
