import assert from 'node:assert/strict';
import { probeReviewedImage } from '../src/lib/reviewed-wechat';
import sharp from 'sharp';

const original = globalThis.fetch;
async function main() {
  let calls = 0;
  const jpeg = await sharp({create:{width:8,height:8,channels:3,background:'#123456'}}).jpeg().toBuffer();
  globalThis.fetch = async (_input, init) => {
    calls++;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 3100);
      init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once:true });
    });
    return new Response(new Uint8Array(jpeg), {headers:{'content-type':'image/jpeg'}});
  };
  const result = await probeReviewedImage('https://1.1.1.1/image.jpg', '');
  assert.equal(result.accessible, true, 'A valid slow image must not be rejected at 2.5 seconds');
  assert.equal(calls,1);
  globalThis.fetch = async () => { throw new Error('Origin now unavailable'); };
  assert.equal((await probeReviewedImage('https://1.1.1.1/image.jpg', '')).accessible,true,'A passed preflight must reuse verified bytes during a transient origin failure');
  globalThis.fetch = async () => new Response(new Uint8Array(jpeg));
  assert.equal((await probeReviewedImage('https://1.1.1.1/no-mime.jpg', '')).accessible,true,'Valid official JPEG without Content-Type must work');
  globalThis.fetch = async () => new Response('not an image', {headers:{'content-type':'image/jpeg'}});
  const invalid = await probeReviewedImage('https://1.1.1.1/invalid.jpg', '');
  assert.equal(invalid.accessible,false,'HTML masquerading as an image must be rejected');
  console.log('reviewed image probe: slow image, cached reuse and missing MIME accepted; fake image rejected');
}
main().finally(() => { globalThis.fetch = original; }).catch(e => { console.error(e); process.exitCode=1; });
