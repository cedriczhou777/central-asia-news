import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRuntimeChecks } from '../src/lib/plan-b-runtime-checks';
import { contentHash } from '../src/lib/reviewed-package';
import { createReviewedDraft, findRecentReviewedDrafts, probeReviewedDraftReadiness } from '../src/lib/reviewed-wechat';
import { globalAgentWechat, noAgentWechat, officialStyleWechat, type WechatRequest } from '../src/lib/reviewed-wechat-transport';

const stored = {mediaId:'fixture-id',version:'2026-11-23',country:'az',title:'approved',summary:'abstract',readbackHash:contentHash('<p>approved</p>')};
const headers = {'x-openapi-seqid':'fixture-private-marker'};
const cloudFailure:WechatRequest=async()=>{throw new TypeError('fixture-private-message',{cause:
  Object.assign(new Error('private'),{code:'ECONNREFUSED',address:'127.0.0.1',port:80,syscall:'connect'})});};

async function checkReadiness() {
  const calls:string[]=[];
  const verified:WechatRequest=async (url,options)=>{
    const path=new URL(url).pathname;
    calls.push(path);
    assert.equal(options.redirect,'manual');
    if (path.endsWith('/get')) {
      assert.equal(JSON.parse(String(options.body)).media_id,stored.mediaId);
      return Response.json({news_item:[{title:stored.title,digest:stored.summary,content:'<p>approved</p>'}]},{headers});
    }
    if (path.endsWith('/batchget')) return Response.json({total_count:0,item_count:0},{headers});
    assert.equal(path,'/cgi-bin/draft/add');
    throw new TypeError('lost response');
  };
  const tested=await probeReviewedDraftReadiness(stored,{clients:[
    {id:'node_fetch',protocol:'http',request:cloudFailure},
    {id:'node_no_agent',protocol:'http',request:verified,compareOnly:true},
    {id:'node_global_agent',protocol:'http',request:verified},
  ]});
  assert.equal(tested.client,'node_global_agent');
  assert.equal(tested.ready,true);
  assert.equal(tested.observed[0].get.stage,'tcp');
  assert.deepEqual(tested.observed[0].get.errors,[{code:'ECONNREFUSED',address:'127.0.0.1',port:80,syscall:'connect'}]);
  assert.equal(tested.observed[2].get.bodyMatches,true);
  assert.equal(JSON.stringify(tested).includes(stored.mediaId),false);
  assert.equal(JSON.stringify(tested).includes('fixture-private'),false);
  assert.ok(calls.every(path=>path.endsWith('/get')||path.endsWith('/batchget')));
  await assert.rejects(createReviewedDraft({title:'fixture'}),/lost response/);
  assert.equal(calls.filter(path=>path.endsWith('/add')).length,1);
  assert.deepEqual(await findRecentReviewedDrafts('fixture','fixture',0),[]);

  const publicTokenError:WechatRequest=async()=>Response.json({errcode:41001});
  const wrongBody:WechatRequest=async (url)=>url.endsWith('/get')
    ? Response.json({news_item:[{title:stored.title,digest:stored.summary,content:'<p>changed</p>'}]},{headers})
    : Response.json({item:[]},{headers});
  const failed=await probeReviewedDraftReadiness(stored,{clients:[
    {id:'public_https',protocol:'https',request:publicTokenError},
    {id:'historical_draft_changed',protocol:'http',request:wrongBody},
    {id:'no_cloud_marker',protocol:'http',request:async (url,init)=>{
      const response=await verified(url,init);
      return Response.json(await response.json());
    }},
  ]});
  assert.equal(failed.ready,false);
  assert.equal(failed.observed[0].get.stage,'authorization');
  assert.equal(failed.observed[0].get.errcode,'41001');
  assert.equal(failed.observed[1].get.stage,'stored_version_mismatch');
  assert.equal(failed.observed[2].get.ok,true);
  assert.equal(failed.observed[2].get.openApiSeqid,false);

  const readIds:string[]=[];
  const currentArticle={title:'current draft fixture',digest:'live summary',content:'<p>exact current body</p>'};
  const live:WechatRequest=async(url,init)=>{
    if (url.endsWith('/batchget')) return Response.json({item:[{media_id:'temporary-live-id',update_time:1_795_581_315,
      content:{news_item:[currentArticle]}}]},{headers});
    const id=JSON.parse(String(init.body)).media_id;
    readIds.push(id);
    return id===stored.mediaId ? Response.json({errcode:40007},{headers}) : Response.json({news_item:[currentArticle]},{headers});
  };
  const recovered=await probeReviewedDraftReadiness(stored,{clients:[{id:'wxapi_request',protocol:'http',request:live}]});
  assert.deepEqual(readIds,[stored.mediaId,'temporary-live-id']);
  assert.equal(recovered.ready,true);
  assert.equal(recovered.reference?.source,'wechat_batch_snapshot');
  assert.equal(recovered.observed[0].historicalGet?.errcode,'40007');
  assert.equal(recovered.observed[0].get.bodyMatches,true);
  assert.match(recovered.reference!.version,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(recovered).includes('temporary-live-id'),false);
}

async function checkRetryWindows() {
  let clock=Date.UTC(2026,10,25);
  const pending:Array<{action:()=>void;delay:number}>=[];
  const attempts:Array<{phase:string;attempt:number;inspectNetwork:boolean}>=[];
  let willPass=false;
  const check=createRuntimeChecks(async attempt=>{
    attempts.push(attempt);
    return willPass;
  },()=>clock,(action,delay)=>pending.push({action,delay}));
  const issue='2026-11-25';
  const first=check(issue,'startup');
  assert.equal(first,check(issue,'collection'));
  await first;
  for (const delay of [30_000,60_000,120_000]) {
    assert.equal(check(issue,'before_signoff'),undefined);
    const timer=pending.shift()!;
    assert.equal(timer.delay,delay);
    clock+=delay;
    willPass=delay===120_000;
    timer.action();
    await check(issue,'collection');
  }
  assert.deepEqual(attempts.map(a=>a.phase),['startup','retry','retry','retry']);
  assert.deepEqual(attempts.map(a=>a.inspectNetwork),[true,false,false,false]);
  assert.equal(pending.length,0);
  assert.equal(check(issue,'before_delivery'),undefined);
  clock+=301_000;
  await check(issue,'before_signoff');
  assert.equal(attempts.at(-1)?.phase,'before_signoff');
  clock+=301_000;
  await check(issue,'before_delivery');
  assert.equal(attempts.at(-1)?.phase,'before_delivery');
  clock+=301_000;
  assert.equal(check(issue,'before_delivery'),undefined);
  await check('2026-11-26','collection');
  assert.equal(attempts.at(-1)?.attempt,1);
}

async function checkHttpClients() {
  const loopback=createServer(async (request,response)=>{
    const chunks:Buffer[]=[];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body=Buffer.concat(chunks).toString();
    if (request.url==='/multipart') {
      assert.match(request.headers['content-type']!,/multipart\/form-data; boundary=/);
      assert.match(body,/name="media"; filename="probe.jpg"/);
    } else assert.deepEqual(JSON.parse(body),{readOnly:true});
    response.setHeader('x-openapi-seqid','loopback-only');
    response.end(JSON.stringify({ok:true}));
  });
  loopback.listen(0,'127.0.0.1');
  await once(loopback,'listening');
  const address=loopback.address();
  assert.ok(address && typeof address==='object');
  const endpoint='http://127.0.0.1:'+address.port;
  const prior=process.env.no_proxy;
  process.env.no_proxy='127.0.0.1';
  try {
    for (const request of [globalAgentWechat,noAgentWechat,officialStyleWechat]) {
      const result=await request(endpoint,{method:'POST',body:'{"readOnly":true}',signal:AbortSignal.timeout(3000)});
      assert.deepEqual(await result.json(),{ok:true});
      assert.equal(result.headers.has('x-openapi-seqid'),true);
      const form=new FormData();
      form.append('media',new Blob(['fixture bytes']),'probe.jpg');
      const upload=await request(endpoint+'/multipart',{method:'POST',body:form,signal:AbortSignal.timeout(3000)});
      assert.deepEqual(await upload.json(),{ok:true});
    }
  } finally {
    if (prior===undefined) delete process.env.no_proxy;
    else process.env.no_proxy=prior;
    loopback.closeAllConnections();
    loopback.close();
  }
}

async function main() {
  const original=process.env.USE_WECHAT_CLOUD_CALL;
  process.env.USE_WECHAT_CLOUD_CALL='true';
  try {
    await checkReadiness();
    await checkRetryWindows();
    await checkHttpClients();
  } finally {
    if (original===undefined) delete process.env.USE_WECHAT_CLOUD_CALL;
    else process.env.USE_WECHAT_CLOUD_CALL=original;
  }
  console.log('WeChat readonly A/B/C selection, sanitized TCP probes, exact historical draft, bounded retries, multipart, and no duplicate add passed.');
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
