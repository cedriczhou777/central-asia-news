import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
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
async function main(){
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
