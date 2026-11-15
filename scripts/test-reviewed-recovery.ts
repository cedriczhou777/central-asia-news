import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
import { recoverReviewedIssue, queueReviewedRecovery, reviewedRecoveryWindow, automaticRecoveryAdapters } from '../src/lib/reviewed-recovery';
import { PACKAGE_COUNTRIES, type ReviewedPackage } from '../src/lib/reviewed-package';
import { deliverReviewedPackage, type deliveryAdapters } from '../src/lib/reviewed-delivery';
import { database } from './lib/reviewed-test-db';

const date='2026-11-12';
const payload={version:date,countries:Object.fromEntries(PACKAGE_COUNTRIES.map(c=>[c,{title:c,summary:'test',bodyHtml:'<p>test</p><img src="https://example.com/image.jpg">',sourceName:'test',sourceUrl:'',coverUrl:'https://example.com/image.jpg'}]))} as ReviewedPackage;
async function checkSeparateBundleState(){
  const compile=(file:string)=>ts.transpileModule(readFileSync(file,'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true},
  }).outputText;
  const stateCode=compile('src/lib/reviewed-recovery-state.ts');
  const recoveryCode=compile('src/lib/reviewed-recovery.ts');
  const sharedGlobal={};let registrations=0,databaseCalls=0;
  function loadCopy(processGlobal:object){
    const stateModule={} as typeof import('../src/lib/reviewed-recovery-state');
    new Script(stateCode,{filename:'independent-state-copy.js'}).runInNewContext({exports:stateModule,globalThis:processGlobal});
    const recoveryModule={} as typeof import('../src/lib/reviewed-recovery');
    const imports:Record<string,unknown>={
      'node-cron':{schedule(){registrations++;}},
      '../storage/database/supabase-client':{getSupabaseClient(){databaseCalls++;throw new Error('VM smoke test must not access a database');}},
      './utils':{beijingDate:()=>date},
      './reviewed-package':{issueCutoffElapsed:()=>false},
      './reviewed-delivery':{},'./reviewed-wechat':{},'./push-run-store':{},
      './reviewed-recovery-state':stateModule,
    };
    new Script(recoveryCode,{filename:'independent-recovery-copy.js'}).runInNewContext({
      exports:recoveryModule,globalThis:processGlobal,console:{log(){}},
      require:(name:string)=>{if(!(name in imports))throw new Error('Unexpected VM import: '+name);return imports[name];},
    });
    return {state:stateModule.getReviewedRecoveryState(),recovery:recoveryModule};
  }
  const instrumentation=loadCopy(sharedGlobal),route=loadCopy(sharedGlobal);
  assert.equal(instrumentation.state,route.state,'separate bundled state modules must use one process object');
  instrumentation.recovery.startReviewedRecovery();route.recovery.startReviewedRecovery();
  assert.equal(registrations,1,'two bundle copies must register only one scheduler');
  assert.equal(route.recovery.reviewedRecoveryStatus().registered,true,'route health must see instrumentation registration');
  instrumentation.state.running=true;
  assert.equal(route.recovery.reviewedRecoveryStatus().running,true);
  assert.equal((await route.recovery.runReviewedRecovery()).stage,'already_running','the other bundle must honor the same execution lock');
  const progress={stage:'fixture_progress',country:'kz'};
  instrumentation.state.lastRecovery=progress;
  assert.equal(route.recovery.reviewedRecoveryStatus().lastRun,progress,'route health must show instrumentation progress');
  route.state.acceptedOrigin='https://example.invalid/';
  assert.equal(instrumentation.state.acceptedOrigin,'https://example.invalid/','accepted origin must survive crossing a bundle boundary');
  route.state.running=false;
  assert.equal(instrumentation.recovery.reviewedRecoveryStatus().running,false);
  const otherProcess=loadCopy({});
  assert.notEqual(otherProcess.state,route.state);
  assert.equal(otherProcess.state.registered,false);assert.equal(otherProcess.state.lastRecovery,null);
  assert.equal(databaseCalls,0,'shared-state tests must not call the database');
}
async function checkAutomaticWindowEntrypoints(){
  const time=(value:string)=>Date.parse('2026-11-12T'+value+'+08:00');
  assert.equal(reviewedRecoveryWindow(time('05:49:59.999')).open,false);
  assert.equal(reviewedRecoveryWindow(time('05:50:00')).open,true);
  assert.equal(reviewedRecoveryWindow(time('09:19:59.999')).newWorkAllowed,true);
  assert.equal(reviewedRecoveryWindow(time('09:20:00')).newWorkAllowed,false);
  assert.equal(reviewedRecoveryWindow(time('09:29:59.999')).open,true);
  assert.equal(reviewedRecoveryWindow(time('09:30:00')).open,false);
  const clock={now:time('23:00:00')},counts={db:0,fetch:0,create:0,timeout:0,interval:0};
  let allowPlan=false,persisted=0;
  class ClockDate extends Date {constructor(value?:string|number){super(value===undefined?clock.now:value);}static now(){return clock.now;}}
  const compile=(file:string)=>ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
  const stateModule={} as typeof import('../src/lib/reviewed-recovery-state');
  const processGlobal={};
  new Script(compile('src/lib/reviewed-recovery-state.ts')).runInNewContext({exports:stateModule,globalThis:processGlobal});
  const entries:Array<{expression:string;run:()=>void}>=[];
  const imports:Record<string,unknown>={
    'node-cron':{schedule(expression:string,run:()=>void){entries.push({expression,run});}},
    '../storage/database/supabase-client':{getSupabaseClient(){counts.db++;if(!allowPlan)throw new Error('No actual database in window test');return {
      from(){return {select(){return {eq:async()=>({data:[{version:date}],error:null}),in:async()=>({data:[],error:null})};}};},
    };}},
    './utils':{beijingDate:()=>date},
    './reviewed-package':{issueDate:(value:string)=>value.slice(0,10),issueCutoffElapsed:()=>true,PACKAGE_COUNTRIES,latestVersion:(versions:string[])=>versions[0]},
    './reviewed-delivery':{deliverReviewedPackage(){counts.create++;},deliveryAdapters:{}},
    './reviewed-wechat':{probeReviewedImage(){counts.fetch++;}},
    './push-run-store':{persistPushRun(){persisted++;}},
    './reviewed-recovery-state':stateModule,
  };
  const recovery={} as typeof import('../src/lib/reviewed-recovery');
  new Script(compile('src/lib/reviewed-recovery.ts')).runInNewContext({
    exports:recovery,globalThis:processGlobal,Date:ClockDate,URL,console:{log(){}},
    require:(name:string)=>{if(!(name in imports))throw new Error('Unexpected import: '+name);return imports[name];},
    setTimeout(){counts.timeout++;},setInterval(){counts.interval++;throw new Error('Automatic recovery must not schedule self-pings');},
    fetch(){counts.fetch++;throw new Error('Automatic recovery must not self-ping');},
  });
  recovery.startReviewedRecovery();
  assert.equal(entries.length,1,'reuse the single existing scheduler');
  assert.equal(entries[0].expression,'*/10 6-9 * * *');
  for(const stamp of ['03:00:00','05:49:59.999','09:30:00','09:40:00','09:50:00','23:00:00']){
    clock.now=time(stamp);
    assert.equal((await recovery.runReviewedRecovery()).stage,'window_closed');
    assert.equal(recovery.queueReviewedRecovery(date,date,'https://example.invalid/accepted'),false);
    entries[0].run();
  }
  assert.deepEqual(counts,{db:0,fetch:0,create:0,timeout:0,interval:0},'outside-window startup/cron/accepted queues do no DB, HTTP, timer or WeChat work');
  assert.equal(recovery.reviewedRecoveryStatus().lastRun?.stage,'window_closed');
  clock.now=time('09:20:00');entries[0].run();await Promise.resolve();
  assert.equal(counts.db,1,'09:20 remains the final allowed status/reconciliation tick');
  assert.equal(counts.fetch,0);assert.equal(counts.interval,0);
  allowPlan=true;
  assert.equal((await recovery.runReviewedRecovery()).stage,'window_closed');
  assert.equal(persisted,0,'a pure 09:20 planning pause must not overwrite a parallel manual push latest status');
}
async function checkBatchAndDeliveryBoundaries(){
  let hardOpen=false,admit=false;
  const calls={packages:0,deliveries:0,read:0,probe:0,deliver:0};
  const dependencies={
    packages:async()=>{calls.packages++;return [date];},deliveries:async()=>{calls.deliveries++;return [];},
    read:async()=>{calls.read++;return payload;},probe:async()=>{calls.probe++;return {accessible:true as const};},
    deliver:async()=>{calls.deliver++;return {ok:true};},canContinue:()=>hardOpen,canStartWork:()=>admit,
  };
  let result=await recoverReviewedIssue(date,dependencies);
  assert.equal(result.stage,'window_closed');assert.deepEqual(calls,{packages:0,deliveries:0,read:0,probe:0,deliver:0});
  hardOpen=true;admit=true;
  result=await recoverReviewedIssue(date,{...dependencies,packages:async()=>{calls.packages++;hardOpen=false;return [date];}});
  assert.equal(result.stage,'window_closed');assert.equal(calls.deliveries,0,'a query finishing after close cannot start another query/country');
  hardOpen=true;admit=false;
  result=await recoverReviewedIssue(date,dependencies);
  assert.equal(result.stage,'window_closed');assert.equal(calls.read,0);assert.equal(calls.probe,0,'09:20 closes new expensive work');
  const four=structuredClone(payload);four.countries.kz.bodyHtml='<p>test</p>'+[1,2,3,4].map(i=>`<img src="https://example.com/${i}.jpg">`).join('');
  let probes=0,deliveries=0;hardOpen=true;admit=true;
  result=await recoverReviewedIssue(date,{...dependencies,read:async()=>four,
    probe:async()=>{probes++;admit=false;return {accessible:false as const,reason:'HTTP 503'};},
    deliver:async()=>{deliveries++;return {ok:true};}});
  assert.equal(result.stage,'window_closed');assert.equal(probes,3,'finish only the admitted three-image batch; no retry or fourth image');assert.equal(deliveries,0);
  const db=database();let mayStart=true,closeAfterImage=true;
  const counts={images:0,create:0,read:0};
  let preparedHtml='';
  const base:typeof deliveryAdapters={
    async prepare(d,progress){
      await progress?.();counts.images++;
      if(closeAfterImage)mayStart=false;
      await progress?.();
      preparedHtml=d.bodyHtml.replace('https://example.com/image.jpg','https://mmbiz.qpic.cn/mmbiz_jpg/window-fixture/0');
      return {article:{title:d.title,digest:d.summary,content:preparedHtml,author:'fixture',thumb_media_id:'thumb',content_source_url:'',need_open_comment:0,only_fans_can_comment:0},images:1,cover:'first_body_image',html:preparedHtml,imageProbes:[]};
    },
    async create(){counts.create++;return 'created-window-fixture';},
    async read(){counts.read++;return {title:'kz',digest:'test',content:preparedHtml,thumb_media_id:'thumb'};},
  };
  let sent=await deliverReviewedPackage(payload,db as unknown as Parameters<typeof deliverReviewedPackage>[1],automaticRecoveryAdapters(()=>mayStart,base),['kz']);
  assert.equal(sent.ok,false);assert.equal(db.rows.get(`${date}/kz`)?.state,'failed');assert.equal(db.rows.get(`${date}/kz`)?.media_id,null);
  assert.match(String(db.rows.get(`${date}/kz`)?.detail?.error),/automatic_recovery_window_closed/);
  assert.deepEqual(counts,{images:1,create:0,read:0},'completed image checkpoint stops before a new send; it must not become uncertain');
  mayStart=true;closeAfterImage=false;
  sent=await deliverReviewedPackage(payload,db as unknown as Parameters<typeof deliverReviewedPackage>[1],automaticRecoveryAdapters(()=>mayStart,base),['kz']);
  assert.equal(sent.ok,true);assert.equal(counts.create,1,'a stopped pre-send preparation can safely continue later');
  const lateDb=database();let open=true;const lateCounts={images:0,create:0,read:0};
  const lateBase:typeof deliveryAdapters={...base,
    async prepare(d,progress){lateCounts.images++;return base.prepare(d,progress);},
    async create(){lateCounts.create++;open=false;return 'late-known-media';},
    async read(){lateCounts.read++;return {title:'kz',digest:'test',content:preparedHtml,thumb_media_id:'thumb'};},
  };
  result=await recoverReviewedIssue(date,{packages:async()=>[date],deliveries:async()=>[],read:async()=>payload,
    probe:async()=>({accessible:true as const}),canContinue:()=>open,canStartWork:()=>open,
    deliver:(p,countries)=>deliverReviewedPackage(p,lateDb as unknown as Parameters<typeof deliverReviewedPackage>[1],automaticRecoveryAdapters(()=>open,lateBase),countries)});
  assert.equal(result.stage,'window_closed');assert.equal(lateDb.rows.get(`${date}/kz`)?.state,'succeeded');
  assert.equal(lateDb.rows.get(`${date}/kz`)?.media_id,'late-known-media');assert.deepEqual(lateCounts,{images:1,create:1,read:1});
  assert.equal(lateDb.rows.size,1,'already-created media/readback may settle after close; the next country must not start');
  const manualDb=database();
  const manual=await deliverReviewedPackage(payload,manualDb as unknown as Parameters<typeof deliverReviewedPackage>[1],base,['kz']);
  assert.equal(manual.ok,true,'direct manual delivery retains existing semantics without automatic adapters');
  let beforePhoto=true,photoStarts=0;
  const heartbeatGuard=automaticRecoveryAdapters(()=>beforePhoto,{...base,async prepare(d,progress){await progress?.();photoStarts++;return base.prepare(d,progress);}});
  await assert.rejects(()=>heartbeatGuard.prepare(payload.countries.kz,async()=>{beforePhoto=false;}),/automatic_recovery_window_closed/);
  assert.equal(photoStarts,0,'a heartbeat await crossing the admission cutoff cannot start an image');
  const readOnlyDb=database();
  const expected='https://mmbiz.qpic.cn/mmbiz_jpg/window-fixture/0';
  const readOnlyRows=PACKAGE_COUNTRIES.map(country=>({version:date,country,state:country==='kz'?'updating':'succeeded',media_id:'known',updated_at:new Date().toISOString(),detail:{imageUrls:[expected],expectedThumbMediaId:'thumb'}}));
  for(const row of readOnlyRows)readOnlyDb.rows.set(`${date}/${row.country}`,row);
  let knownReads=0;
  result=await recoverReviewedIssue(date,{packages:async()=>[date],deliveries:async()=>readOnlyRows,read:async()=>payload,
    canContinue:()=>true,canStartWork:()=>false,probe:async()=>{throw new Error('Late reconciliation cannot probe');},
    deliver:(p,countries)=>deliverReviewedPackage(p,readOnlyDb as unknown as Parameters<typeof deliverReviewedPackage>[1],automaticRecoveryAdapters(()=>false,{...base,
      async prepare(){throw new Error('Late reconciliation cannot prepare');},async create(){throw new Error('Late reconciliation cannot create');},
      async read(){knownReads++;return {title:'kz',digest:'test',content:payload.countries.kz.bodyHtml.replace('https://example.com/image.jpg',expected),thumb_media_id:'thumb'};},
    }),countries)});
  assert.equal(result.stage,'delivery_attempted');assert.equal(knownReads,1);
  assert.equal(readOnlyDb.rows.get(`${date}/kz`)?.state,'succeeded','09:20 tail may finish read-only known-media reconciliation');
}
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
  await checkSeparateBundleState();
  await checkAutomaticWindowEntrypoints();
  await checkBatchAndDeliveryBoundaries();
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
  console.log('reviewed recovery: separate-bundle scheduler state, missing package, image gate, exact-version continuation, interrupted update read-only reconciliation, selective retry and duplicate guards passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
