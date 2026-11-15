import assert from 'node:assert/strict';
import { recoverReviewedIssue, queueReviewedRecovery } from '../src/lib/reviewed-recovery';
import { PACKAGE_COUNTRIES, type ReviewedPackage } from '../src/lib/reviewed-package';
import { deliverReviewedPackage, type deliveryAdapters } from '../src/lib/reviewed-delivery';
import { database } from './lib/reviewed-test-db';

const date='2026-11-12';
const payload={version:date,countries:Object.fromEntries(PACKAGE_COUNTRIES.map(c=>[c,{title:c,summary:'test',bodyHtml:'<p>test</p><img src="https://example.com/image.jpg">',sourceName:'test',sourceUrl:'',coverUrl:'https://example.com/image.jpg'}]))} as ReviewedPackage;
async function scenario(rows:Array<{version:string;country:string;state:string;media_id?:string}>, options:{versions?:string[];badImage?:boolean;badUrl?:string}={}) {
  const calls:Array<{version:string;countries:readonly string[]}>=[];
  let probes=0,pendingHooks=0;
  const result=await recoverReviewedIssue(date,{
    packages:async()=>options.versions||[date], deliveries:async()=>rows,
    read:async version=>({...payload,version}),onPending:()=>{pendingHooks++;},
    probe:async(url)=>{probes++;return (options.badImage||url===options.badUrl)?{accessible:false as const,reason:'HTTP 403'}:{accessible:true as const};},
    deliver:async(p,countries)=>{calls.push({version:p.version,countries});return {ok:true};},
  });
  return {result,calls,probes,pendingHooks};
}
async function main(){
  assert.equal(queueReviewedRecovery('2026-11-11',date),false,'Historical ingest must not wake current-day delivery');
  assert.equal(queueReviewedRecovery('2026-11-13',date),false,'Future pre-collection must never be delivered');
  let x=await scenario([],{versions:[]});assert.equal(x.result.stage,'awaiting_package');assert.equal(x.calls.length,0);assert.equal(x.pendingHooks,0);
  x=await scenario([]);assert.equal(x.result.stage,'delivery_attempted');assert.deepEqual(x.calls.flatMap(c=>c.countries),PACKAGE_COUNTRIES);assert.equal(x.pendingHooks,1);
  x=await scenario([],{badImage:true});assert.equal(x.result.stage,'needs_image_revision');assert.equal(x.calls.length,0);assert.equal(x.probes,5,'403 is not retried');
  const rows=PACKAGE_COUNTRIES.map(country=>({country,version:date,state:'succeeded',media_id:'existing'}));
  x=await scenario(rows);assert.equal(x.result.stage,'complete');assert.equal(x.calls.length,0);assert.equal(x.probes,0);assert.equal(x.pendingHooks,0);
  x=await scenario(rows.map(r=>r.country==='uz'?{...r,state:'failed',media_id:undefined}:r));assert.deepEqual(x.calls[0].countries,['uz']);
  for(const state of ['preparing']){
    x=await scenario(rows.map(r=>r.country==='uz'?{...r,state}:r));assert.equal(x.result.stage,'waiting_existing_delivery');assert.equal(x.calls.length,0,`${state} cannot create another draft`);
  }
  for(const state of ['sending','uncertain','updating']){
    x=await scenario(rows.map(r=>r.country==='uz'?{...r,state}:r));assert.deepEqual(x.calls,[{version:date,countries:['uz']}]);assert.equal(x.probes,0,'known media_id recovery does not need origin images');
  }
  x=await scenario(rows.map(r=>r.country==='uz'?{...r,state:'updating',media_id:undefined}:r));
  assert.equal(x.result.stage,'waiting_existing_delivery');assert.equal(x.calls.length,0,'updating without a known media_id must never create a draft');
  // Exercise the planner and real delivery state machine together. An accepted
  // update left in "updating" can close after a matching read, while an edited
  // draft retains its lock and cannot be overwritten or recreated.
  for(const matches of [true,false]){
    const db=database();
    const expectedImage='https://mmbiz.qpic.cn/mmbiz_jpg/recovery-fixture/0';
    const detail={imageUrls:[expectedImage],expectedThumbMediaId:'thumb-fixture'};
    for(const row of rows)db.rows.set(`${date}/${row.country}`,{...row,state:row.country==='kz'?'updating':'succeeded',detail});
    const counts={prepare:0,create:0,update:0,read:0,probe:0};
    const adapters:typeof deliveryAdapters={
      async prepare(){counts.prepare++;throw new Error('Read-only reconciliation must not prepare');},
      async create(){counts.create++;throw new Error('Read-only reconciliation must not create');},
      async update(){counts.update++;throw new Error('Read-only reconciliation must not update');},
      async read(mediaId){
        counts.read++;assert.equal(mediaId,'existing');
        return {title:'kz',digest:'test',thumb_media_id:'thumb-fixture',
          content:payload.countries.kz.bodyHtml.replace('https://example.com/image.jpg',expectedImage)+(matches?'':'<p>User changed this draft</p>')};
      },
    };
    const recovered=await recoverReviewedIssue(date,{
      packages:async()=>[date],deliveries:async()=>rows.map(row=>({...row,state:row.country==='kz'?'updating':'succeeded',detail})),
      read:async()=>payload,probe:async()=>{counts.probe++;return {accessible:true as const};},
      deliver:(p,countries)=>deliverReviewedPackage(p,db as unknown as Parameters<typeof deliverReviewedPackage>[1],adapters,countries),
    });
    assert.equal(recovered.stage,'delivery_attempted');
    assert.deepEqual(counts,{prepare:0,create:0,update:0,read:1,probe:0});
    assert.equal(db.rows.get(`${date}/kz`)?.state,matches?'succeeded':'updating');
    assert.equal((recovered.result as {ok:boolean}).ok,matches);
  }
  x=await scenario(rows.slice(1),{versions:[date,date+'-r2']});assert.equal(x.calls[0].version,date+'-r2','Absent country may use latest accepted revision; other countries stay pinned');assert.deepEqual(x.calls[0].countries,['kz']);
  x=await scenario([...rows,{country:'kz',version:date+'-r2',state:'failed'}],{versions:[date,date+'-r2']});assert.equal(x.result.stage,'complete');assert.equal(x.calls.length,0);
  const mixed=rows.map(r=>({...r,version:r.country==='kz'?date+'-r4':r.country==='kg'?date+'-r2':r.country==='az'?date+'-r3':date}));
  x=await scenario(mixed,{versions:[date,date+'-r2',date+'-r3',date+'-r4']});assert.equal(x.result.stage,'complete');assert.equal(x.probes,0,'mixed successful revisions must not be retried or probed');
  x=await scenario(mixed.map(r=>r.country==='kg'?{...r,state:'failed',media_id:undefined}:r),{versions:[date,date+'-r2',date+'-r3',date+'-r4']});assert.deepEqual(x.calls,[{version:date+'-r4',countries:['kg']}]);
  const countryImages=structuredClone(payload);
  countryImages.countries.az.bodyHtml='<p>test</p><img src="https://example.com/blocked.jpg">';
  const selected:string[][]=[];
  const isolated=await recoverReviewedIssue(date,{packages:async()=>[date],deliveries:async()=>rows.map(r=>['kz','kg','az'].includes(r.country)?{...r,state:'failed',media_id:undefined}:r),read:async()=>countryImages,probe:async url=>url.endsWith('blocked.jpg')?{accessible:false as const,reason:'HTTP 403'}:{accessible:true as const},deliver:async(_p,countries)=>{selected.push([...countries]);return {ok:true};}});
  assert.equal(isolated.stage,'delivery_attempted');assert.deepEqual(selected,[['kz'],['kg']]);assert.equal(isolated.failures?.length,1,'one country image failure must remain visible without blocking other countries');
  const order:string[]=[];
  await recoverReviewedIssue(date,{packages:async()=>[date],deliveries:async()=>[],read:async()=>payload,probe:async()=>{order.push('probe');return {accessible:true as const};},deliver:async(_p,c)=>{order.push('deliver:'+c[0]);return {ok:true};}});
  assert.deepEqual(order.slice(0,4),['probe','deliver:kz','probe','deliver:uz'],'a ready country must deliver before probing the next country');
  console.log('reviewed recovery: missing package, image gate, exact-version continuation, interrupted update read-only reconciliation, selective retry and duplicate guards passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
