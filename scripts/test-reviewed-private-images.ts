import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { GET, POST } from '../src/app/api/reviewed-images/route';
import { POST as ingest } from '../src/app/api/word-package/route';
import { privateImageHealth, readPrivateImage } from '../src/lib/reviewed-private-images';
import { prepareReviewedDraft, probeReviewedImage } from '../src/lib/reviewed-wechat';
import { PACKAGE_COUNTRIES, validatePackage, requirePrivateImages, contentHash } from '../src/lib/reviewed-package';
import { deliverReviewedPackage, readPackage } from '../src/lib/reviewed-delivery';
import { recoverReviewedIssue } from '../src/lib/reviewed-recovery';
import { database } from './lib/reviewed-test-db';
import type { getSupabaseClient } from '../src/storage/database/supabase-client';

process.env.INGEST_SECRET='local-test-only';
process.env.SUPABASE_URL='https://database.invalid';
process.env.SUPABASE_ANON_KEY='local-test-only';
process.env.SUPABASE_SERVICE_ROLE_KEY='local-test-only';
process.env.USE_WECHAT_CLOUD_CALL='true';
const originalFetch=globalThis.fetch, originalNow=Date.now;
const images=new Map<string,Uint8Array>(),packages=new Map<string,unknown>(),drafts=new Map<string,Record<string,string>>();
let bucketExists=false,bucketPublic=false,deniedRequests=0,created=0,originRequests=0;
globalThis.fetch=async(input,init)=>{
  const r=input instanceof Request?input:new Request(input,init),u=new URL(r.url);
  if(u.hostname==='1.1.1.1'){deniedRequests++;return new Response('denied',{status:403});}
  if(u.hostname==='api.weixin.qq.com'){
    if(u.pathname.includes('material/add_material'))return Response.json({media_id:'cover',url:'https://mmbiz.qpic.cn/cover'});
    if(u.pathname.includes('media/uploadimg'))return Response.json({url:'https://mmbiz.qpic.cn/body'});
    const body=await r.json();
    if(u.pathname.endsWith('/draft/add')){const id='fixture-'+(++created);drafts.set(id,body.articles[0]);return Response.json({media_id:id});}
    if(u.pathname.endsWith('/draft/get')){const d=drafts.get(body.media_id)!;return Response.json({news_item:[{...d}]});}
    throw new Error('Unexpected WeChat fixture operation');
  }
  if(u.hostname!=='database.invalid'){originRequests++;throw new Error('Network unavailable at original source');}
  if(u.pathname==='/storage/v1/bucket'&&r.method==='POST'){const b=await r.json();assert.equal(b.public,false);bucketExists=true;return Response.json({name:b.id});}
  if(u.pathname==='/storage/v1/bucket/reviewed-originals')return bucketExists?Response.json({id:'reviewed-originals',name:'reviewed-originals',public:bucketPublic}):Response.json({message:'Not found',error:'Not found',statusCode:'404'},{status:404});
  if(u.pathname.startsWith('/storage/v1/object/')){
    const key=u.pathname.replace('/storage/v1/object/authenticated/','').replace('/storage/v1/object/','');
    if(r.method==='POST'||r.method==='PUT'){images.set(key,new Uint8Array(await r.arrayBuffer()));return Response.json({Key:key,Id:'fixture'});}
    const bytes=images.get(key);return bytes?new Response(new Uint8Array(bytes)):Response.json({message:'not found',error:'not found',statusCode:'404'},{status:404});
  }
  if(u.pathname==='/rest/v1/reviewed_packages'){
    if(r.method==='POST'){const row=await r.json();if(packages.has(row.version))return Response.json({code:'23505'},{status:409});packages.set(row.version,row);return new Response(null,{status:201});}
    const version=u.searchParams.get('version')?.replace('eq.','')||'';return Response.json(packages.get(version)||null);
  }
  throw new Error('Unexpected database fixture operation: '+u.pathname);
};
const request=(method:string,query='',bytes?:Buffer,hash?:string,auth=true)=>new Request('https://local.invalid/api/reviewed-images'+query,{method,headers:{...(auth?{'X-Ingest-Secret':'local-test-only'}:{}),...(hash?{'X-Content-Sha256':hash,'X-Source-Url':encodeURIComponent('https://source.invalid/photo.jpg')}:{}),'Content-Type':'application/octet-stream'},...(bytes?{body:new Uint8Array(bytes)}:{})});
async function main(){
  assert.equal((await GET(request('GET','',undefined,undefined,false))).status,401);
  assert.equal((await POST(request('POST'))).status,400);assert.equal(images.size,0);
  const image=await sharp({create:{width:10,height:10,channels:3,background:'#abc123'}}).png().toBuffer();
  const sha256=createHash('sha256').update(image).digest('hex'),asset={sha256,bytes:image.length};
  assert.equal((await POST(request('POST','',image,'0'.repeat(64)))).status,400);assert.equal(images.size,0,'wrong hash must never persist');
  const fake=Buffer.from('<html>not an image</html>'),fakeHash=createHash('sha256').update(fake).digest('hex');
  assert.equal((await POST(request('POST','',fake,fakeHash))).status,400);assert.equal(images.size,0,'HTML with a correct hash must still be rejected');
  let response=await POST(request('POST','',image,sha256));let receipt=await response.json();
  assert.equal(response.status,200,JSON.stringify(receipt));assert.equal(receipt.ready,true);assert.equal(receipt.private,true);assert.equal(images.size,1);
  assert.equal((await POST(request('POST','',image,sha256))).status,200);assert.equal(images.size,1,'retries use content-addressed identity');
  assert.equal((await privateImageHealth()).private,true);
  assert.deepEqual(await readPrivateImage(asset,true),image,'persistent original bytes must survive independent reads');
  const binary=await GET(request('GET',`?sha256=${sha256}&bytes=${image.length}&download=1`));assert.deepEqual(Buffer.from(await binary.arrayBuffer()),image);assert.match(binary.headers.get('cache-control')!,/private/);
  const source='https://source.invalid/photo.jpg';
  assert.equal((await probeReviewedImage(source,'',asset)).accessible,true);
  const d={title:'test',summary:'摘要',bodyHtml:`<p>事实保持原样</p><img src="${source}">`,sourceName:'来源',sourceUrl:'',coverUrl:source,imageAssets:{[source]:asset}};
  const prepared=await prepareReviewedDraft(d);assert.equal(prepared.images,1);assert.match(prepared.html,/事实保持原样/);assert.equal(prepared.imageProbes[0].sha256,sha256);assert.equal(originRequests,0,'pinned images never request the original source');
  const legacy=await probeReviewedImage('https://1.1.1.1/denied.jpg','');assert.equal(legacy.accessible,false);assert.equal(deniedRequests,1,'403 must not trigger header/proxy retries');
  await assert.rejects(readPrivateImage({...asset,bytes:asset.bytes+1}),/哈希|长度/);
  bucketPublic=true;assert.equal((await privateImageHealth()).ready,false);await assert.rejects(readPrivateImage(asset),/公开/);bucketPublic=false;
  const old={version:'2026-11-09',countries:Object.fromEntries(PACKAGE_COUNTRIES.map(c=>[c,{title:c,summary:'摘要',bodyHtml:'<p>旧包正文</p>',sourceName:'来源',sourceUrl:'',coverUrl:''}]))};assert.equal(contentHash(validatePackage(old)),contentHash(old),'legacy accepted package hashes remain unchanged');
  const input={version:'2026-11-15',countries:Object.fromEntries(PACKAGE_COUNTRIES.map(c=>[c,{...d,title:c}]))};const payload=validatePackage(input);requirePrivateImages(payload);
  const missing=structuredClone(payload);delete missing.countries.kz.imageAssets;assert.throws(()=>requirePrivateImages(missing),/先上传/);
  const mismatch=structuredClone(payload);mismatch.countries.kz.imageAssets={'https://unrelated.invalid/':asset};assert.throws(()=>validatePackage(mismatch),/清单/);
  // End-to-end future issue rehearsal through real ingest, private image reads,
  // normal WeChat preparation/create/readback adapters and durable claim model.
  Date.now=()=>Date.parse('2026-11-15T06:20:00+08:00');
  const accepted=await ingest(new Request('https://local.invalid/api/word-package',{method:'POST',headers:{'X-Ingest-Secret':'local-test-only','Content-Type':'application/json'},body:JSON.stringify(payload)}));assert.equal(accepted.status,200);
  const db=database(),sb=db as unknown as ReturnType<typeof getSupabaseClient>;
  const recovered=await recoverReviewedIssue(payload.version,{packages:async()=>[payload.version],deliveries:async()=>[...db.rows.values()] as never,read:readPackage,probe:probeReviewedImage,deliver:(p,c)=>deliverReviewedPackage(p,sb,undefined,c)});
  assert.equal(recovered.stage,'delivery_attempted');assert.equal(created,5);assert.equal([...db.rows.values()].filter(r=>r.state==='succeeded').length,5);
  await recoverReviewedIssue(payload.version,{packages:async()=>[payload.version],deliveries:async()=>[...db.rows.values()] as never,read:readPackage,probe:probeReviewedImage,deliver:(p,c)=>deliverReviewedPackage(p,sb,undefined,c)});assert.equal(created,5,'repeat recovery must create zero duplicate drafts');assert.equal(originRequests,0);
  console.log('private images + future five-country rehearsal: authenticated staging, exact persistent bytes, corrupt/public rejection, blocked origin, manifest gate, 5 readbacks and zero duplicate drafts passed');
}
main().finally(()=>{globalThis.fetch=originalFetch;Date.now=originalNow;}).catch(e=>{console.error(e);process.exitCode=1;});
