import assert from 'node:assert/strict';
import { PACKAGE_COUNTRIES, validatePackage, latestVersion, replaceImageSources, contentHash } from '../src/lib/reviewed-package';
import { deliverReviewedPackage, deliveryAdapters } from '../src/lib/reviewed-delivery';
import type { getSupabaseClient } from '../src/storage/database/supabase-client';

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

type Row = Record<string, any>;
// Atomic in-memory store models database unique keys and conditional updates, not external calls.
function database() {
 const rows = new Map<string,Row>();
 return { rows, from() {
  let operation='read', values:Row={}, filter:Row={}, selected=false;
  const query:any={
   insert(v:Row){operation='insert';values=v;return query;},
   update(v:Row){operation='update';values=v;return query;},
   select(){selected=true;return query;}, match(v:Row){Object.assign(filter,v);return query;},
   eq(k:string,v:unknown){filter[k]=v;return query;},single(){return query;},
   then(resolve:any,reject:any){return Promise.resolve().then(()=>{
    const key=(r:Row)=>`${r.version}/${r.country}`;
    if(operation==='insert') {if(rows.has(key(values)))return {error:{code:'23505'}};rows.set(key(values),{...values});return {error:null};}
    const matches=[...rows.values()].filter(r=>Object.entries(filter).every(([k,v])=>r[k]===v));
    if(operation==='update'){for(const r of matches)Object.assign(r,values);return {error:null,data:selected?matches:null};}
    return {error:null,data:matches[0]};
   }).then(resolve,reject);}
  };return query;
 }};
}
async function main(){
 const db=database();let creates=0;let failedRead=true;let failedPrepare=true;
 const adapters:typeof deliveryAdapters={
  async prepare(d){if(d.title==='uz'&&failedPrepare){failedPrepare=false;throw new Error('图片403');}
   return {article:{title:d.title,digest:d.summary,content:d.bodyHtml,author:'',thumb_media_id:'thumb',content_source_url:'',need_open_comment:0,only_fans_can_comment:0},html:d.bodyHtml,images:0,cover:'brand'};},
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
 console.log('reviewed-package: validation, exact HTML replacement, version isolation, pre-send retry, uncertain outcome and concurrent duplicate prevention passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
