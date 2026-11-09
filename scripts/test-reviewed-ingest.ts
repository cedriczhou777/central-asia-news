import assert from 'node:assert/strict';
import { POST } from '../src/app/api/word-package/route';
import { PACKAGE_COUNTRIES } from '../src/lib/reviewed-package';
process.env.INGEST_SECRET='local-test-only';
process.env.SUPABASE_URL='https://database.invalid';
process.env.SUPABASE_ANON_KEY='local-test-only';
process.env.SUPABASE_SERVICE_ROLE_KEY='local-test-only';
const rows=new Map<string,any>();
const originalFetch=globalThis.fetch;
globalThis.fetch=async (input, init)=>{
 const req=input instanceof Request?input:new Request(input,init);
 assert.equal(new URL(req.url).hostname,'database.invalid','test must not reach an external service');
 if(req.method==='POST') {
  const row=await req.json();
  if(rows.has(row.version))return Response.json({code:'23505',message:'duplicate'},{status:409});
  rows.set(row.version,row);return new Response(null,{status:201});
 }
 const version=new URL(req.url).searchParams.get('version')?.replace(/^eq\./,'');
 return Response.json(rows.get(version||'')||null);
};
const payload={version:'2026-11-09',countries:Object.fromEntries(PACKAGE_COUNTRIES.map(c=>[c,{title:String(c),summary:'摘要',bodyHtml:'<p>审定正文</p>',sourceName:'公告',sourceUrl:'https://example.org',coverUrl:''}]))};
const request=(body:unknown,auth=true)=>new Request('https://localhost/api/word-package',{method:'POST',headers:{'content-type':'application/json',...(auth?{'x-ingest-secret':'local-test-only'}:{})},body:JSON.stringify(body)});
async function main(){
 assert.equal((await POST(request({},false))).status,401);
 assert.equal((await POST(request({}))).status,400);
 assert.equal((await POST(request({...payload,countries:{kz:payload.countries.kz}}))).status,409);
 assert.equal(rows.size,0);
 const first=await (await POST(request(payload))).json();assert.equal(first.ok,true);assert.equal(first.inserted,5);assert.equal(rows.size,1);
 const repeat=await (await POST(request(payload))).json();assert.equal(repeat.duplicate,true);assert.equal(repeat.skipped,5);assert.equal(rows.size,1);
 const changed=structuredClone(payload);changed.countries.kz.title='修订';
 assert.equal((await POST(request(changed))).status,409);assert.equal(rows.size,1);
 changed.version+='-r2';assert.equal((await POST(request(changed))).status,200);assert.equal(rows.size,2);
 console.log('reviewed-ingest: authentication, readiness probe, atomic five-country acceptance, identical retry and revision collision passed');
}
main().finally(()=>{globalThis.fetch=originalFetch;}).catch(e=>{console.error(e);process.exitCode=1;});
