import assert from 'node:assert/strict';
import { recoverReviewedIssue } from '../src/lib/reviewed-recovery';
import { PACKAGE_COUNTRIES, type ReviewedPackage } from '../src/lib/reviewed-package';

const date='2026-11-12';
const payload={version:date,countries:Object.fromEntries(PACKAGE_COUNTRIES.map(c=>[c,{title:c,summary:'test',bodyHtml:'<p>test</p><img src="https://example.com/image.jpg">',sourceName:'test',sourceUrl:'',coverUrl:'https://example.com/image.jpg'}]))} as ReviewedPackage;
async function scenario(rows:Array<{version:string;country:string;state:string;media_id?:string}>, options:{versions?:string[];badImage?:boolean}={}) {
  const calls:Array<{version:string;countries:readonly string[]}>=[];
  let probes=0;
  const result=await recoverReviewedIssue(date,{
    packages:async()=>options.versions||[date], deliveries:async()=>rows,
    read:async version=>({...payload,version}),
    probe:async()=>{probes++;return options.badImage?{accessible:false as const,reason:'HTTP 403'}:{accessible:true as const};},
    deliver:async(p,countries)=>{calls.push({version:p.version,countries});return {ok:true};},
  });
  return {result,calls,probes};
}
async function main(){
  let x=await scenario([],{versions:[]});assert.equal(x.result.stage,'awaiting_package');assert.equal(x.calls.length,0);
  x=await scenario([]);assert.equal(x.result.stage,'delivery_attempted');assert.deepEqual(x.calls[0].countries,PACKAGE_COUNTRIES);
  x=await scenario([],{badImage:true});assert.equal(x.result.stage,'needs_image_revision');assert.equal(x.calls.length,0);assert.equal(x.probes,5,'403 is not retried');
  const rows=PACKAGE_COUNTRIES.map(country=>({country,version:date,state:'succeeded',media_id:'existing'}));
  x=await scenario(rows);assert.equal(x.result.stage,'complete');assert.equal(x.calls.length,0);assert.equal(x.probes,0);
  x=await scenario(rows.map(r=>r.country==='uz'?{...r,state:'failed',media_id:undefined}:r));assert.deepEqual(x.calls[0].countries,['uz']);
  for(const state of ['preparing','sending','uncertain','updating']){
    x=await scenario(rows.map(r=>r.country==='uz'?{...r,state}:r));assert.equal(x.result.stage,'waiting_existing_delivery');assert.equal(x.calls.length,0,`${state} cannot create another draft`);
  }
  x=await scenario(rows.slice(1),{versions:[date,date+'-r2']});assert.equal(x.calls[0].version,date,'Started issue must continue its exact version');assert.deepEqual(x.calls[0].countries,['kz']);
  x=await scenario([...rows,{country:'kz',version:date+'-r2',state:'failed'}],{versions:[date,date+'-r2']});assert.equal(x.result.stage,'blocked_multiple_versions');assert.equal(x.calls.length,0);
  console.log('reviewed recovery: missing package, image gate, exact-version continuation, selective retry and duplicate guards passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
