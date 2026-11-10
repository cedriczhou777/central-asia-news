import assert from 'node:assert/strict';
import { probeReviewedImage } from '../src/lib/reviewed-wechat';

const original = globalThis.fetch;
async function main() {
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 3100);
      init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once:true });
    });
    return new Response(new Uint8Array([255,216,255,217]), {headers:{'content-type':'image/jpeg'}});
  };
  const result = await probeReviewedImage('https://1.1.1.1/image.jpg', '');
  assert.equal(result.accessible, true, 'A valid slow image must not be rejected at 2.5 seconds');
  assert.equal(calls,1);
  globalThis.fetch = async () => new Response('not an image', {headers:{'content-type':'text/html'}});
  const invalid = await probeReviewedImage('https://1.1.1.1/image.jpg', '');
  assert.equal(invalid.accessible,false,'HTML masquerading as an image must be rejected');
  console.log('reviewed image probe: slow valid image accepted; non-image rejected');
}
main().finally(() => { globalThis.fetch = original; }).catch(e => { console.error(e); process.exitCode=1; });
