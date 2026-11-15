import assert from 'node:assert/strict';
import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
import * as packageModule from '../src/lib/reviewed-package';
import { reviewedStatus } from '../src/lib/reviewed-push-handler';
import { PACKAGE_COUNTRIES, contentHash, validatePackage } from '../src/lib/reviewed-package';

process.env.INGEST_SECRET = 'local-test-only';
process.env.SUPABASE_URL = 'https://database.invalid';
process.env.SUPABASE_ANON_KEY = 'local-test-only';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-test-only';
const payload=validatePackage({version:'2026-11-09',countries:Object.fromEntries(PACKAGE_COUNTRIES.map(c=>[c,{
  title:c,summary:'摘要',bodyHtml:'<p>正文</p><img src="https://example.org/image.jpg">',sourceName:'来源',sourceUrl:'https://example.org/article',coverUrl:''
}]))});
const originalFetch=globalThis.fetch;
let conflict=false;
globalThis.fetch=async (input,init)=>{
  const request=input instanceof Request?input:new Request(input,init),url=new URL(request.url);
  assert.equal(url.hostname,'database.invalid','test must not contact a real service');
  if (url.pathname.endsWith('/reviewed_packages')) return url.searchParams.has('issue_date')?Response.json([{version:payload.version},{version:payload.version+'-r2'}]):Response.json({payload,content_hash:contentHash(payload)});
  if (url.pathname.endsWith('/reviewed_deliveries')) {
    if(url.searchParams.get('version')?.startsWith('in.')){
      const rows=PACKAGE_COUNTRIES.map(country=>({country,version:payload.version+(country==='kz'?'-r2':''),state:'succeeded',media_id:'fixture-'+country}));
      return Response.json(conflict?[...rows,{...rows[0],version:payload.version}]:rows);
    }
    return Response.json([]);
  }
  throw new Error('unexpected database operation');
};
const request=(query:string,auth=true)=>new NextRequest('https://local.invalid/api/wechat/push?version=2026-11-09&'+query,{headers:auth?{'X-Ingest-Secret':'local-test-only'}:{}});
async function partialEntryChecks(){
  const date='2026-11-09',next=date+'-r2';
  const partial=validatePackage({version:date,readyCountries:['kz','uz'],countries:{kz:payload.countries.kz,uz:payload.countries.uz}});
  const later=validatePackage({version:next,readyCountries:['kg'],countries:{kg:payload.countries.kg}});
  const packages=new Map([[date,partial],[next,later]]);
  let receiptRows:any[]=[],writes=0,probes=0,draftReads=0;
  const sent:Array<{version:string;countries:readonly string[]}>=[];
  const imports:Record<string,unknown>={
    'next/server':{NextResponse},
    '../storage/database/supabase-client':{getSupabaseClient:()=>({from:(table:string)=>({
      select:()=>({eq:async()=>({data:table==='reviewed_packages'?[...packages.keys()].map(version=>({version})):receiptRows,error:null})}),
      upsert:async()=>{writes++;return {error:null};},
    })})},
    './reviewed-package':packageModule,
    './reviewed-delivery':{readPackage:async(version:string)=>packages.get(version)||null,deliverReviewedPackage:async(p:typeof partial,_sb:unknown,_adapters:unknown,countries:readonly string[])=>{sent.push({version:p.version,countries});return {ok:true};}},
    './push-run-store':{persistPushRun:async()=>{}},
    './utils':{beijingDate:()=>date},
    './reviewed-wechat':{probeReviewedImage:async()=>{probes++;throw new Error('unlisted probe forbidden');},readReviewedDraft:async()=>{draftReads++;throw new Error('unlisted draft read forbidden');}},
    './reviewed-diagnostics':{REVIEWED_DIAGNOSTICS_VERSION:'test'},
    './reviewed-recovery':{reviewedRecoveryStatus:()=>({version:'2026-11-15-v12'})},
    './reviewed-private-images':{privateImageHealth:async()=>({ok:true})},
  };
  const isolated={} as typeof import('../src/lib/reviewed-push-handler');
  const code=ts.transpileModule(readFileSync('src/lib/reviewed-push-handler.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  new Script(code).runInNewContext({exports:isolated,process,Date,console,require:(name:string)=>{if(!(name in imports))throw new Error('Unexpected test import '+name);return imports[name];}});
  const get=(query:string)=>new NextRequest('https://local.invalid/api/wechat/push?'+query,{headers:{'x-ingest-secret':'local-test-only'}});
  const post=(body:unknown)=>new NextRequest('https://local.invalid/api/wechat/push',{method:'POST',headers:{'x-ingest-secret':'local-test-only','content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await isolated.reviewedPush(post({version:date,countries:['kz','az']}))).status,409);
  assert.equal(sent.length,0);assert.equal(writes,0,'unlisted push fails before state writes or background delivery');
  let response=await isolated.reviewedPush(post({version:date}));assert.equal(response.status,202);
  let value=await response.json();assert.deepEqual(value.countries,['kz','uz']);assert.equal(value.partialDelivery,true);assert.deepEqual(value.missingCountries,['kg','tj','az']);
  assert.equal(sent.length,1);assert.deepEqual([...sent[0].countries],['kz','uz']);
  response=await isolated.reviewedPush(post({date,countries:['uz']}));assert.equal(response.status,202);value=await response.json();assert.equal(value.version,date,'requested country finds newest containing package rather than global newest package');
  response=await isolated.reviewedPush(post({date}));assert.equal(response.status,202);value=await response.json();assert.equal(value.version,next);assert.deepEqual(value.countries,['kg']);
  response=await isolated.reviewedPush(post({date,countries:['kz','kg']}));assert.equal(response.status,409);assert.match((await response.json()).error,/逐国投递/,'manual multi-country selection without a version must not silently mix immutable package versions');
  const beforeWrites=writes;assert.equal((await isolated.reviewedPush(post({version:date,countries:['kz','kz']}))).status,400);assert.equal(writes,beforeWrites);
  value=await(await isolated.reviewedStatus(get('health=1'))).json();assert.equal(value.transportVersion,'reviewed-package-v3');assert.equal(value.capabilities.partialCountries,true);
  assert.equal((await isolated.reviewedStatus(get('version='+date+'&probeCountry=az&imageIndex=0'))).status,404);
  receiptRows=[{country:'az',state:'succeeded',media_id:'not-in-this-package'}];
  assert.equal((await isolated.reviewedStatus(get('version='+date+'&diagnose=az'))).status,404);assert.equal(probes,0);assert.equal(draftReads,0);
  receiptRows=['kz','uz'].map(country=>({country,state:'succeeded',media_id:'known-'+country}));
  value=await(await isolated.reviewedStatus(get('version='+date))).json();assert.equal(value.readyDraftsVerified,true);assert.equal(value.draftsVerified,false,'two successful ready countries cannot imply five-country completion');
}
async function main(){
  await partialEntryChecks();
  assert.equal((await reviewedStatus(request('probeCountry=az&imageIndex=0',false))).status,401);
  assert.equal((await reviewedStatus(request('probeCountry=invalid&imageIndex=0'))).status,400);
  assert.equal((await reviewedStatus(request('probeCountry=az'))).status,400);
  assert.equal((await reviewedStatus(request('probeCountry=az&imageIndex=99'))).status,404);
  assert.equal((await reviewedStatus(request('diagnose=kg'))).status,404);
  const issue=()=>new NextRequest('https://local.invalid/api/wechat/push?date='+payload.version,{headers:{'X-Ingest-Secret':'local-test-only'}});
  let status=await(await reviewedStatus(issue())).json();assert.equal(status.draftsVerified,true);assert.equal(status.byCountry[0].receipt.version,payload.version+'-r2');
  conflict=true;status=await(await reviewedStatus(issue())).json();assert.equal(status.draftsVerified,false);assert.equal(status.byCountry[0].conflict,true);
  console.log('reviewed status: authentication and scoped read-only probes passed');
}
main().finally(()=>{globalThis.fetch=originalFetch;}).catch(e=>{console.error(e);process.exitCode=1;});
