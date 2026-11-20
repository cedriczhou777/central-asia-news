import { getSupabaseClient, getSupabaseServiceRoleKey } from '../storage/database/supabase-client';
import { imageHash, validateOriginalImage, MAX_IMAGE_BYTES } from './reviewed-image-bytes';
import type { ReviewedImageAsset } from './reviewed-package';
import { SUPABASE_REQUEST_TIMEOUT_MS } from './deadline-fetch';

export const PRIVATE_IMAGE_BUCKET = 'reviewed-originals';
export const PRIVATE_IMAGE_PROTOCOL = 'private-original-v1';
const objectPath = (sha256: string) => {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('原图SHA-256无效');
  return `images/${sha256}`;
};
const cache=new Map<string,{bytes:Buffer;until:number}>();
let cacheBytes=0;
type StorageFailureKind = 'configuration' | 'authorization' | 'public_bucket' | 'invalid_metadata' |
  'timeout' | 'network' | 'service_unavailable' | 'not_found' | 'rate_limited' | 'unavailable';
class PrivateStorageError extends Error {
  constructor(message:string, readonly failureKind:StorageFailureKind, readonly retryable=false, readonly status?:number) {
    super(message);
  }
}
// SDK transport failures can be wrapped in StorageUnknownError.originalError.
// Classify only known transient causes; unknown failures must not weaken the
// private-bucket gate or turn an authorization/configuration error into a retry.
function storageFailure(error:unknown): PrivateStorageError {
  if(error instanceof PrivateStorageError)return error;
  const chain:Record<string,unknown>[]=[];const seen=new Set<unknown>();const pending=[error];
  while(pending.length&&chain.length<8){
    const value=pending.shift();if(!value||typeof value!=='object'||seen.has(value))continue;
    seen.add(value);const entry=value as Record<string,unknown>;chain.push(entry);
    pending.push(entry.originalError,entry.cause);
  }
  const status=chain.map(entry=>Number(entry.status)).find(value=>Number.isInteger(value)&&value>=400&&value<=599);
  if(status===401||status===403)return new PrivateStorageError('原图私有存储鉴权失败','authorization',false,status);
  if(status===429)return new PrivateStorageError('原图私有存储触发限流','rate_limited',false,status);
  if(status!==undefined&&status>=500)return new PrivateStorageError('原图私有存储暂时不可用','service_unavailable',true,status);
  if(status===408||chain.some(entry=>entry.name==='TimeoutError'||entry.name==='AbortError'))
    return new PrivateStorageError('原图私有存储请求超时','timeout',true,status);
  const networkCodes=new Set(['ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','EHOSTUNREACH','ENETUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);
  if(chain.some(entry=>networkCodes.has(String(entry.code))||
    ((entry.name==='TypeError'||entry.name==='StorageUnknownError')&&typeof entry.message==='string'&&/fetch failed|failed to fetch|network request failed|network error|networkerror/i.test(entry.message))))
    return new PrivateStorageError('原图私有存储网络暂不可用','network',true,status);
  if(status===404)return new PrivateStorageError('原图私有存储桶不存在','not_found',false,status);
  return new PrivateStorageError('原图私有存储尚未就绪','unavailable',false,status);
}
async function bucket(create: boolean) {
  if (!getSupabaseServiceRoleKey()) throw new PrivateStorageError('原图私有存储须配置服务角色','configuration');
  let sb:ReturnType<typeof getSupabaseClient>;
  try { sb=getSupabaseClient(); } catch { throw new PrivateStorageError('原图私有存储配置不完整','configuration'); }
  let result:Awaited<ReturnType<typeof sb.storage.getBucket>>;
  try { result=await sb.storage.getBucket(PRIVATE_IMAGE_BUCKET); } catch(error) { throw storageFailure(error); }
  if (result.error && create && ['404','400'].includes(String(result.error.status))) {
    const created = await sb.storage.createBucket(PRIVATE_IMAGE_BUCKET, { public:false, fileSizeLimit:MAX_IMAGE_BYTES });
    if (created.error && !['409','400'].includes(String(created.error.status))) throw storageFailure(created.error);
    result = await sb.storage.getBucket(PRIVATE_IMAGE_BUCKET);
  }
  if (result.error) throw storageFailure(result.error);
  if (!result.data) throw new PrivateStorageError('原图私有存储尚未就绪','invalid_metadata');
  if (result.data.public === true) throw new PrivateStorageError('原图存储意外公开，已拒绝读写','public_bucket');
  if (result.data.public !== false) throw new PrivateStorageError('无法核实原图存储私有属性，已拒绝读写','invalid_metadata');
  return sb.storage.from(PRIVATE_IMAGE_BUCKET);
}
type PrivateImageHealth = { protocol:string; ready:boolean; private:boolean; retryable:boolean;
  requestTimeoutMs:number; failureKind?:StorageFailureKind; httpStatus?:number; reason?:string };
export async function privateImageHealth():Promise<PrivateImageHealth> {
  try { await bucket(false); return { protocol:PRIVATE_IMAGE_PROTOCOL, ready:true, private:true, retryable:false, requestTimeoutMs:SUPABASE_REQUEST_TIMEOUT_MS }; }
  catch (e) { const error=storageFailure(e);return { protocol:PRIVATE_IMAGE_PROTOCOL, ready:false, private:false,
    retryable:error.retryable,failureKind:error.failureKind,...(error.status===undefined?{}:{httpStatus:error.status}),
    requestTimeoutMs:SUPABASE_REQUEST_TIMEOUT_MS,reason:error.message }; }
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

/** Avoid overwriting an already verified original when reusing a release. */
export async function ensurePrivateImage(bytes: Buffer, sha256: string) {
  const path = objectPath(sha256);
  const store = await bucket(false);
  const existing = await store.download(path);
  if (existing.data && !existing.error) {
    await validateOriginalImage(Buffer.from(await existing.data.arrayBuffer()), { sha256, bytes: bytes.length });
    return 'reused';
  }
  if (!existing.error || Number(existing.error.status) !== 404) throw storageFailure(existing.error);
  await stagePrivateImage(bytes, sha256);
  return 'staged';
}
