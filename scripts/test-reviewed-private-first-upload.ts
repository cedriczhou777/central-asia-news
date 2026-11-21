import assert from 'node:assert/strict';
import sharp from 'sharp';
import { imageHash } from '../src/lib/reviewed-image-bytes';
import { ensurePrivateImage } from '../src/lib/reviewed-private-images';

async function main() {
  const oldFetch = globalThis.fetch;
  const oldEnv = process.env;
  process.env = { ...oldEnv, SUPABASE_URL:'https://db.unit-test.example',
    SUPABASE_ANON_KEY:'fixture-anon', SUPABASE_SERVICE_ROLE_KEY:'fixture-role' };
  const bytes = await sharp({create:{width:120,height:90,channels:3,background:'blue'}}).png().toBuffer();
  const sha = imageHash(bytes);
  let stored: Buffer | null = null;
  let uploads = 0;
  let denied = false;
  let isPublic = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.hostname,'db.unit-test.example');
    if (url.pathname.startsWith('/storage/v1/bucket/')) {
      return Response.json({id:'reviewed-originals',name:'reviewed-originals',public:isPublic});
    }
    assert.equal(url.pathname,`/storage/v1/object/reviewed-originals/images/${sha}`);
    if ((init?.method || 'GET') === 'GET') {
      if (denied) return Response.json({statusCode:'403',message:'fixture denied'}, {status:403});
      return stored ? new Response(new Uint8Array(stored)) : Response.json({statusCode:'404',message:'fixture missing object'}, {status:404});
    }
    uploads++;
    stored = Buffer.from(await new Response(init?.body).arrayBuffer());
    return Response.json({Key:`reviewed-originals/images/${sha}`});
  };
  try {
    assert.equal(await ensurePrivateImage(bytes,sha),'staged','real SDK wrapped 404 must allow first upload');
    assert.equal(uploads,1);
    assert.equal(await ensurePrivateImage(bytes,sha),'reused');
    assert.equal(uploads,1,'verified existing bytes must not upload again');
    denied=true;
    await assert.rejects(()=>ensurePrivateImage(bytes,sha),/鉴权失败/);
    assert.equal(uploads,1,'403 never becomes permission to upload');
    denied=false;isPublic=true;
    await assert.rejects(()=>ensurePrivateImage(bytes,sha),/意外公开/);
    assert.equal(uploads,1,'public bucket never becomes permission to upload');
    console.log('Private first upload: real SDK wrapped 404, readback, reuse, 403 and private-bucket guards passed.');
  } finally {globalThis.fetch=oldFetch;process.env=oldEnv;}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
