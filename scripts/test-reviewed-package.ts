import assert from 'node:assert/strict';
import { PACKAGE_COUNTRIES, validatePackage, latestVersion, replaceImageSources, contentHash, makeSourceUrlsVisible, sourceUrls } from '../src/lib/reviewed-package';
import { deliverReviewedPackage, deliveryAdapters } from '../src/lib/reviewed-delivery';
import type { getSupabaseClient } from '../src/storage/database/supabase-client';
import { summarizeDraftReadback } from '../src/lib/reviewed-diagnostics';
import { probeReviewedImage, prepareReviewedDraft } from '../src/lib/reviewed-wechat';

const input = { version:'2026-11-09', countries:Object.fromEntries(PACKAGE_COUNTRIES.map(c=>[c, {
 title:c, summary:'审定摘要', bodyHtml:'<section style="color:#112233"><p>审定正文 &amp; 来源</p></section>', sourceName:'原始公告', sourceUrl:'https://example.org/news', coverUrl:''
}])) };
const payload = validatePackage(input);
assert.equal(latestVersion(['2026-11-08-r99','2026-11-09-r2','2026-11-09-r10'], '2026-11-09'),'2026-11-09-r10');
assert.equal(latestVersion(['2026-11-08'], '2026-11-09'), undefined);
assert.throws(()=>validatePackage({...input, countries:{kz:input.countries.kz}}));
assert.throws(()=>validatePackage({...input,version:'2026-02-30'}));
assert.throws(()=>validatePackage({...input,version:'2026-99-99'}));
assert.notEqual(contentHash(payload),contentHash({...payload,version:'2026-11-09-r2'}));
assert.equal(replaceImageSources('<img data-src="unused" src="https://example.org/x">',new Map([['https://example.org/x','https://mmbiz.qpic.cn/x']])), '<img data-src="unused" src="https://mmbiz.qpic.cn/x">');
const html = '<section style="color:gold"><img src="https://example.org/a?a=1&amp;b=2"><p>图注、来源</p></section>';
assert.equal(replaceImageSources(html,new Map([['https://example.org/a?a=1&b=2','https://mmbiz.qpic.cn/pic']])),html.replace('https://example.org/a?a=1&amp;b=2','https://mmbiz.qpic.cn/pic'));
const linked='<p>来源：<a href="https://example.org/news?a=1&amp;b=2">Example</a> · 日期</p>';
assert.deepEqual(sourceUrls(linked),['https://example.org/news?a=1&b=2']);
assert.equal(makeSourceUrlsVisible(linked),'<p>来源：Example（https://example.org/news?a=1&b=2） · 日期</p>');
const diagnostic=summarizeDraftReadback({...payload.countries.kg,bodyHtml:linked}, {title:'kg',digest:'审定摘要',content:makeSourceUrlsVisible(linked)+'<img data-src="https://mmbiz.qpic.cn/x">'}, ['https://mmbiz.qpic.cn/x']);
assert.equal(diagnostic.legacyTextMatch,true);assert.equal(diagnostic.expectedTextMatch,false);assert.equal(diagnostic.actualImageTags,1);assert.equal(diagnostic.imageAttributes[0].dataSrc,true);

import { database } from './lib/reviewed-test-db';
async function main(){
 const savedFetch=globalThis.fetch, savedCloud=process.env.USE_WECHAT_CLOUD_CALL;
 process.env.USE_WECHAT_CLOUD_CALL='true';
 try {
  globalThis.fetch=async () => Response.json({media_id:'test-cover',url:'https://mmbiz.qpic.cn/test'});
  const prepared=await prepareReviewedDraft(payload.countries.kz);
  assert.equal(prepared.article.content_source_url,'','external source must never appear in the article-level original link');
  const sharp=(await import('sharp')).default;
  const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#ff9900'}}).png().toBuffer();
  globalThis.fetch=async (input) => {
    const url=String(input);
    if(url.startsWith('https://1.1.1.1/'))return new Response(new Uint8Array(bytes),{headers:{'content-type':'image/png'}});
    if(url.includes('material/add_material'))return Response.json({media_id:'later-news-cover',url:'https://mmbiz.qpic.cn/cover'});
    if(url.includes('media/uploadimg'))return Response.json({url:'https://mmbiz.qpic.cn/body'});
    throw new Error('unexpected test fetch');
  };
  const laterImage=await prepareReviewedDraft({...payload.countries.kz,bodyHtml:'<p>First news has no image</p><p>Second news</p><img src=\"https://1.1.1.1/photo.png\">'});
  assert.equal(laterImage.article.thumb_media_id,'later-news-cover','first available later news image must become the article cover');
  assert.equal(laterImage.cover,'first_body_image');
  assert.match(laterImage.html,/mmbiz.qpic.cn\/body/);
 } finally { globalThis.fetch=savedFetch; if(savedCloud===undefined)delete process.env.USE_WECHAT_CLOUD_CALL;else process.env.USE_WECHAT_CLOUD_CALL=savedCloud; }
 const unsafeImage=await probeReviewedImage('http://127.0.0.1/private','');
 assert.equal(unsafeImage.accessible,false,'image probes must reject non-HTTPS and internal destinations');
 const db=database();let creates=0;let failedRead=true;let failedPrepare=true;
 const adapters:typeof deliveryAdapters={
  async prepare(d){if(d.title==='uz'&&failedPrepare){failedPrepare=false;throw new Error('图片403');}
   return {article:{title:d.title,digest:d.summary,content:d.bodyHtml,author:'',thumb_media_id:'thumb',content_source_url:'',need_open_comment:0,only_fans_can_comment:0},html:d.bodyHtml,images:0,cover:'brand',imageProbes:[]};},
  async create(article:any){creates++;return article.title;},
  async read(id){if(id==='kg'&&failedRead){throw new Error('回读超时');}return {title:id,digest:'审定摘要',content:payload.countries.kz.bodyHtml};}
 };
 const sb=db as unknown as ReturnType<typeof getSupabaseClient>;
 const first=await deliverReviewedPackage(payload,sb,adapters);
 assert.equal(first.ok,false);assert.equal(creates,4);
 assert.equal(db.rows.get('2026-11-09/kg')?.state,'uncertain');
 const second=await deliverReviewedPackage(payload,sb,adapters);
 assert.equal(second.ok,false);assert.equal(creates,5,'only pre-send failure can create on retry');
 assert.equal(db.rows.get('2026-11-09/uz')?.state,'succeeded');
 failedRead=false;
 const recovered=await deliverReviewedPackage(payload,sb,adapters);
 assert.equal(recovered.ok,true);assert.equal(creates,5,'read-only recovery must not recreate existing drafts');
 const concurrentDb=database();creates=0;
 const concurrent=await Promise.all([deliverReviewedPackage(payload,concurrentDb as any,adapters),deliverReviewedPackage(payload,concurrentDb as any,adapters)]);
 assert.equal(creates,5,'concurrent workers must create once per country');
 assert.equal([...concurrentDb.rows.values()].filter(r=>r.state==='succeeded').length,5);
 await deliverReviewedPackage(payload,concurrentDb as any,adapters);
 assert.equal(creates,5,'completed delivery is idempotent');
 // A dead preparation can be reclaimed only with fencing support. The old
 // worker may wake later, but must neither create nor overwrite the new receipt.
 const leaseDb=database();let releaseLease!:()=>void,leaseEntered!:()=>void;
 const leasePaused=new Promise<void>(r=>{releaseLease=r;}),leaseStarted=new Promise<void>(r=>{leaseEntered=r;});
 const leaseBefore=creates;
 const oldWorker=deliverReviewedPackage(payload,leaseDb as any,{...adapters,async prepare(d){leaseEntered();await leasePaused;return adapters.prepare(d);}},['kz']);
 await leaseStarted;leaseDb.rows.get('2026-11-09/kz')!.updated_at='2026-01-01T00:00:00Z';
 const resumed=await deliverReviewedPackage(payload,leaseDb as any,adapters,['kz']);assert.equal(resumed.ok,true);
 releaseLease();const fenced=await oldWorker;assert.equal(fenced.ok,false);assert.equal(creates,leaseBefore+1);assert.equal(leaseDb.rows.get('2026-11-09/kz')?.state,'succeeded','late old worker cannot clobber the successful receipt');
 creates=5;
 const newRevision=validatePackage({...input,version:'2026-11-09-r2'});
 const duplicate=await deliverReviewedPackage(newRevision,concurrentDb as any,adapters);
 assert.equal(duplicate.ok,false);assert.equal(creates,5,'a second version of the same country must not create another draft');
 assert.equal(duplicate.failures.length,5,'each blocked country must be reported');
 const retryDb=database();retryDb.rows.set('2026-11-09/kz',{version:'2026-11-09',country:'kz',state:'failed',media_id:null});
 retryDb.rows.set('2026-11-09-r2/kz',{version:'2026-11-09-r2',country:'kz',state:'sending',media_id:null});
 const beforeRetryCreates=creates;const retryOld=await deliverReviewedPackage(payload,retryDb as any,adapters,['kz']);
 assert.equal(retryOld.ok,false);assert.equal(creates,beforeRetryCreates,'failed version cannot be retried while another revision is sending');

 // The incident's five-country input must leave successful original drafts untouched.
 const subsetDb=database();
 for(const c of PACKAGE_COUNTRIES)subsetDb.rows.set(`2026-11-09/${c}`,{version:'2026-11-09',country:c,state:['uz','tj'].includes(c)?'succeeded':'failed',media_id:['uz','tj'].includes(c)?`preserved-${c}`:null,detail:{}});
 const originalReceipts=JSON.stringify([...subsetDb.rows.values()]);
 const subset=await deliverReviewedPackage(newRevision,subsetDb as any,adapters,['kz','kg','az']);
 assert.equal(subset.ok,true);
 assert.equal(JSON.stringify([...subsetDb.rows.values()].filter(r=>r.version===payload.version)),originalReceipts);
 // Actual claim ordering, not just pre-seeded conflicts: exercise both winners.
 for(const oldFirst of [true,false]){
  const raceDb=database();raceDb.rows.set('2026-11-09/kz',{version:'2026-11-09',country:'kz',state:'failed',media_id:null});
  let release!:()=>void,entered!:()=>void,raceCreates=0;
  const blocked=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const fast={...adapters,async create(a:any){raceCreates++;return a.title;}};
  const slow={...fast,async prepare(d:any){entered();await blocked;return adapters.prepare(d);}};
  const first=deliverReviewedPackage(oldFirst?payload:newRevision,raceDb as any,slow,['kz']);await started;
  const second=await deliverReviewedPackage(oldFirst?newRevision:payload,raceDb as any,fast,['kz']);
  assert.equal(second.ok,false);release();await first;assert.equal(raceCreates,1);
 }
 const mediaDb=database();mediaDb.rows.set('2026-11-09/kz',{version:'2026-11-09',country:'kz',state:'failed',media_id:'already-created'});
 const mediaCreates=creates;const mediaRetry=await deliverReviewedPackage(payload,mediaDb as any,adapters,['kz']);
 assert.equal(mediaRetry.ok,false);assert.equal(creates,mediaCreates,'any known media_id prevents re-creation even in an inconsistent failed state');

 const sourcePayload=validatePackage({version:'2026-11-09',countries:Object.fromEntries(PACKAGE_COUNTRIES.map(c=>[c,{
  title:String(c),summary:'审定摘要',bodyHtml:'<p>原文内容</p><p>来源：<a href="https://example.org/news">Example</a></p>',sourceName:'Example',sourceUrl:'https://example.org/news',coverUrl:''
 }]))});
 const repairDb=database();let repairedContent=makeSourceUrlsVisible(sourcePayload.countries.kz.bodyHtml);let repairCreates=0;let repairUpdates=0;
 repairDb.rows.set('2026-11-09/kz',{version:'2026-11-09',country:'kz',state:'uncertain',media_id:'existing-kz',detail:{imageUrls:[]}});
 for(const c of PACKAGE_COUNTRIES.filter(c=>c!=='kz'))repairDb.rows.set(`2026-11-09/${c}`,{version:'2026-11-09',country:c,state:'succeeded',media_id:`existing-${c}`,detail:{}});
 const repairAdapters:typeof deliveryAdapters={
  async prepare(d){const html=d.bodyHtml;return {article:{title:d.title,digest:d.summary,content:html,author:'',thumb_media_id:'thumb',content_source_url:'',need_open_comment:0,only_fans_can_comment:0},html,images:0,cover:'brand',imageProbes:[]};},
  async create(){repairCreates++;return 'unexpected-new-draft';},
  async update(_mediaId,article:any){repairUpdates++;repairedContent=article.content;},
  async read(mediaId){return {title:'kz',digest:'审定摘要',content:mediaId==='existing-kz'?repairedContent:sourcePayload.countries.kz.bodyHtml};}
 };
 const repaired=await deliverReviewedPackage(sourcePayload,repairDb as any,repairAdapters);
 assert.equal(repaired.ok,true);assert.equal(repairUpdates,1,'only the known existing draft should be updated');assert.equal(repairCreates,0,'source-link repair must not create duplicates');
 assert.equal(repairDb.rows.get('2026-11-09/kz')?.media_id,'existing-kz');assert.equal(repairDb.rows.get('2026-11-09/kz')?.detail.verified,true);
 const reasonDb=database();
 reasonDb.rows.set('2026-11-09/kz',{version:'2026-11-09',country:'kz',state:'uncertain',media_id:'existing-kz',detail:{imageUrls:[]}});
 const reasonAdapters:typeof deliveryAdapters={...repairAdapters,async read(){return {title:'kz',digest:'审定摘要',content:makeSourceUrlsVisible(sourcePayload.countries.kz.bodyHtml)};},async prepare(){throw new Error('图片读取失败 https://example.org/private?token=secret');}};
 const reasonResult=await deliverReviewedPackage(sourcePayload,reasonDb as any,reasonAdapters,['kz']);
 assert.equal(reasonResult.ok,false);assert.equal((reasonResult.failures[0] as any).reason,'图片读取失败 [链接]');assert.equal(reasonDb.rows.get('2026-11-09/kz')?.state,'uncertain');
 const missingImagePayload=validatePackage({version:'2026-11-09-r2',countries:Object.fromEntries(PACKAGE_COUNTRIES.map(c=>[c,{
  title:String(c),summary:'审定摘要',bodyHtml:'<p>原文内容</p><img src="https://example.org/a.jpg"><p>来源：<a href="https://example.org/news">Example</a></p>',sourceName:'Example',sourceUrl:'https://example.org/news',coverUrl:''
 }]))});
 const imageDb=database();let imageContent=makeSourceUrlsVisible(missingImagePayload.countries.kg.bodyHtml).replace('<img src="https://example.org/a.jpg">','');let imageUpdates=0;
 imageDb.rows.set('2026-11-09-r2/kg',{version:'2026-11-09-r2',country:'kg',state:'uncertain',media_id:'existing-kg',detail:{imageUrls:['https://mmbiz.qpic.cn/old.jpg']}});
 const imageAdapters:typeof deliveryAdapters={
  async prepare(d){const html=d.bodyHtml.replace('https://example.org/a.jpg','https://mmbiz.qpic.cn/new.jpg');return {article:{title:d.title,digest:d.summary,content:html,author:'',thumb_media_id:'thumb',content_source_url:'',need_open_comment:0,only_fans_can_comment:0},html,images:1,cover:'first_body_image',imageProbes:[]};},
  async create(){throw new Error('must not create another draft');},
  async update(_id,article:any){imageUpdates++;imageContent=article.content;},
  async read(){return {title:'kg',digest:'审定摘要',content:imageContent};}
 };
 const fixedImage=await deliverReviewedPackage(missingImagePayload,imageDb as any,imageAdapters,['kg']);
 assert.equal(fixedImage.ok,true);assert.equal(imageUpdates,1);assert.equal(imageDb.rows.get('2026-11-09-r2/kg')?.media_id,'existing-kg');
 const staleDb=database();let staleUpdates=0;
 staleDb.rows.set('2026-11-09-r2/kg',{version:'2026-11-09-r2',country:'kg',state:'updating',media_id:'existing-kg',updated_at:'2026-01-01T00:00:00Z',detail:{imageUrls:['https://mmbiz.qpic.cn/old.jpg']}});
 const stale=await deliverReviewedPackage(missingImagePayload,staleDb as any,{...imageAdapters,async update(){staleUpdates++;},async read(){return {title:'kg',digest:'审定摘要',content:'<p>原文内容</p><p>来源：Example</p>'};}},['kg']);
 assert.equal(stale.ok,false);assert.equal(staleUpdates,0,'elapsed time never permits stealing an updating lock');
 const lazyDb=database();let lazyUpdates=0;
 lazyDb.rows.set('2026-11-09-r2/kg',{version:'2026-11-09-r2',country:'kg',state:'uncertain',media_id:'existing-kg',detail:{imageUrls:['https://mmbiz.qpic.cn/mmbiz_jpg/abc/0?wx_fmt=jpeg']}});
 const lazyAdapters:typeof deliveryAdapters={...imageAdapters,async update(){lazyUpdates++;},async read(){return {title:'kg',digest:'审定摘要',content:missingImagePayload.countries.kg.bodyHtml.replace('src="https://example.org/a.jpg"','data-src="https://mmbiz.qpic.cn/mmbiz_jpg/abc/640?wx_fmt=jpeg"')};}};
 const lazy=await deliverReviewedPackage(missingImagePayload,lazyDb as any,lazyAdapters,['kg']);
 assert.equal(lazy.ok,true);assert.equal(lazyUpdates,0,'lazy-loaded image must not trigger a draft update');
 console.log('reviewed-package: validation, exact HTML replacement, version isolation, pre-send retry, uncertain outcome and concurrent duplicate prevention passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
