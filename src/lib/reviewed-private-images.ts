import { getSupabaseClient, getSupabaseServiceRoleKey } from '../storage/database/supabase-client';
import { imageHash, validateOriginalImage, MAX_IMAGE_BYTES } from './reviewed-image-bytes';
import type { ReviewedImageAsset } from './reviewed-package';

export const PRIVATE_IMAGE_BUCKET = 'reviewed-originals';
export const PRIVATE_IMAGE_PROTOCOL = 'private-original-v1';
const objectPath = (sha256: string) => {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('原图SHA-256无效');
  return `images/${sha256}`;
};
const cache=new Map<string,{bytes:Buffer;until:number}>();
let cacheBytes=0;
async function bucket(create: boolean) {
  if (!getSupabaseServiceRoleKey()) throw new Error('原图私有存储须配置服务角色');
  const sb = getSupabaseClient();
  let result = await sb.storage.getBucket(PRIVATE_IMAGE_BUCKET);
  if (result.error && create && ['404','400'].includes(String(result.error.status))) {
    const created = await sb.storage.createBucket(PRIVATE_IMAGE_BUCKET, { public:false, fileSizeLimit:MAX_IMAGE_BYTES });
    if (created.error && !['409','400'].includes(String(created.error.status))) throw new Error('无法建立原图私有存储');
    result = await sb.storage.getBucket(PRIVATE_IMAGE_BUCKET);
  }
  if (result.error || !result.data) throw new Error('原图私有存储尚未就绪');
  if (result.data.public !== false) throw new Error('原图存储意外公开，已拒绝读写');
  return sb.storage.from(PRIVATE_IMAGE_BUCKET);
}
export async function privateImageHealth() {
  try { await bucket(false); return { protocol:PRIVATE_IMAGE_PROTOCOL, ready:true, private:true }; }
  catch (e) { return { protocol:PRIVATE_IMAGE_PROTOCOL, ready:false, private:false, reason:e instanceof Error?e.message:'原图存储不可用' }; }
}
export async function readPrivateImage(asset: ReviewedImageAsset, fresh=false) {
  objectPath(asset.sha256);
  const store = await bucket(false);
  const cached=cache.get(asset.sha256);
  if(!fresh&&cached&&cached.until>Date.now()){
    await validateOriginalImage(cached.bytes,asset);return cached.bytes;
  }
  const result = await store.download(objectPath(asset.sha256));
  if (result.error || !result.data) throw new Error('原图私有存档缺失；须补传同一审定原图');
  const bytes = Buffer.from(await result.data.arrayBuffer());
  await validateOriginalImage(bytes, asset);
  for(const [key,value] of cache){if(value.until<=Date.now()||cacheBytes+bytes.length>64*1024*1024||key===asset.sha256){cache.delete(key);cacheBytes-=value.bytes.length;}}
  cache.set(asset.sha256,{bytes,until:Date.now()+2*60*60_000});cacheBytes+=bytes.length;
  return bytes;
}
export async function stagePrivateImage(bytes: Buffer, sha256: string) {
  objectPath(sha256);
  const asset = { sha256, bytes:bytes.length };
  const meta = await validateOriginalImage(bytes, asset);
  const store = await bucket(true);
  const result = await store.upload(objectPath(sha256), bytes, { contentType:`image/${meta.format}`, upsert:true, cacheControl:'0' });
  if (result.error) throw new Error('原图私有转存失败');
  // A successful upload alone is not readiness: read persistent bytes back and
  // verify identity, including across independent server instances.
  const persisted = await readPrivateImage(asset,true);
  if (imageHash(persisted) !== sha256) throw new Error('原图转存回读不一致');
  return { ...asset, format:meta.format, width:meta.width, height:meta.height, ready:true, private:true, protocol:PRIVATE_IMAGE_PROTOCOL };
}
