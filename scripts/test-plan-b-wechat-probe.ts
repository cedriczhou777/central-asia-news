import assert from 'node:assert/strict';
import { findRecentReviewedDrafts, probeReviewedDraftReadiness } from '../src/lib/reviewed-wechat';

async function main() {
  const originalFetch = globalThis.fetch;
  const originalMode = process.env.USE_WECHAT_CLOUD_CALL;
  process.env.USE_WECHAT_CLOUD_CALL = 'true';
  try {
    const calls: string[] = [];
    globalThis.fetch = async (uri, options) => {
      const path = new URL(String(uri)).pathname;
      calls.push(path);
      if (path.endsWith('batchget')) return new Response('<html>upstream unavailable</html>', {status:502});
      assert.equal(path, '/cgi-bin/draft/get');
      assert.equal(JSON.parse(String(options?.body)).media_id, 'known-test-id');
      return Response.json({news_item:[{}]});
    };
    const probe = await probeReviewedDraftReadiness(async () => 'known-test-id');
    assert.equal(probe.get,true);
    assert.equal(probe.batchget,false);
    assert.deepEqual(probe.batchgetFailure,{kind:'invalid_json',httpStatus:502,errorCode:null});
    assert.deepEqual(calls,['/cgi-bin/draft/batchget','/cgi-bin/draft/get']);

    globalThis.fetch = async () => Response.json({total_count:0,item_count:0});
    const empty = await probeReviewedDraftReadiness();
    assert.equal(empty.batchget,true);
    assert.equal(empty.get,null);
    assert.deepEqual(await findRecentReviewedDrafts('title','digest',0),[]);

    globalThis.fetch = async () => Response.json({errcode:48001,errmsg:'forbidden'});
    const denied = await probeReviewedDraftReadiness();
    assert.equal(denied.batchget,false);
    assert.equal(denied.batchgetFailure?.errorCode,'48001');

    globalThis.fetch = async () => Response.json({total_count:1,item_count:1});
    await assert.rejects(findRecentReviewedDrafts('title','digest',0),/reviewed_draft_list_unavailable/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalMode === undefined) delete process.env.USE_WECHAT_CLOUD_CALL;
    else process.env.USE_WECHAT_CLOUD_CALL = originalMode;
  }
  console.log('WeChat readonly probes: independent get, error metadata, empty and malformed lists passed');
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
