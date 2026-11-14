import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readArchivedImage } from '../src/lib/reviewed-image-archive';
import { probeReviewedImage, prepareReviewedDraft } from '../src/lib/reviewed-wechat';
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

async function main() {
  const dir=await mkdtemp(join(tmpdir(),'reviewed-archive-'));
  const bytes=Buffer.from('verified-original-source-bytes');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const entry={url:'https://example.org/original.jpg',sha256,bytes:bytes.length};
  const manifest=(images:unknown[])=>writeFile(join(dir,'manifest.json'),JSON.stringify({images}));
  try {
    assert.equal(await readArchivedImage(entry.url,dir),null);
    await manifest([entry]);await writeFile(join(dir,sha256),bytes);
    assert.deepEqual(await readArchivedImage(entry.url,dir),bytes);
    assert.equal(await readArchivedImage(entry.url+'?different-source',dir),null,'lookup is exact, never a host-wide override');
    await writeFile(join(dir,sha256),'corrupt');
    await assert.rejects(readArchivedImage(entry.url,dir),/哈希/);
    await manifest([{...entry,sha256:'../private'}]);
    await assert.rejects(readArchivedImage(entry.url,dir),/记录无效/);
    await manifest([entry,entry]);await assert.rejects(readArchivedImage(entry.url,dir),/冲突/);
    await manifest([{...entry,bytes:10_000_001}]);await assert.rejects(readArchivedImage(entry.url,dir),/记录无效/);
    await manifest([entry]);await rm(join(dir,sha256));await assert.rejects(readArchivedImage(entry.url,dir),/ENOENT/);
    // The actual prepare path must consume the very same archived bytes without
    // an origin request, but still decode images and use normal WeChat uploads.
    const image=await sharp({create:{width:8,height:8,channels:3,background:'#345678'}}).png().toBuffer();
    const imageHash=createHash('sha256').update(image).digest('hex');
    const archive=join(dir,'var/reviewed-image-archive');await mkdir(archive,{recursive:true});
    await writeFile(join(archive,imageHash),image);
    await writeFile(join(archive,'manifest.json'),JSON.stringify({images:[{...entry,sha256:imageHash,bytes:image.length}]}));
    const cwd=process.cwd(),originalFetch=globalThis.fetch,cloud=process.env.USE_WECHAT_CLOUD_CALL;
    let uploads=0;
    try {
      process.chdir(dir);process.env.USE_WECHAT_CLOUD_CALL='true';
      await assert.rejects(readArchivedImage(entry.url,join(dir,'public/reviewed-image-archive')),/公开目录/);
      globalThis.fetch=async input=>{
        const url=String(input);assert.equal(new URL(url).host,'api.weixin.qq.com','origin must not be contacted');uploads++;
        if(url.includes('material/add_material'))return Response.json({media_id:'thumb',url:'https://mmbiz.qpic.cn/cover'});
        assert.ok(url.includes('media/uploadimg'));return Response.json({url:'https://mmbiz.qpic.cn/body'});
      };
      assert.equal((await probeReviewedImage(entry.url,'')).accessible,true);assert.equal(uploads,0);
      const prepared=await prepareReviewedDraft({title:'test',summary:'test',bodyHtml:`<p>same text</p><img src="${entry.url}">`,sourceName:'test',sourceUrl:'',coverUrl:''});
      assert.equal(uploads,2);assert.match(prepared.html,/<p>same text<\/p>/);assert.equal(prepared.images,1);
      await writeFile(join(archive,imageHash),'corrupt');
      assert.equal((await probeReviewedImage(entry.url,'')).accessible,false,'an archive corruption must not fall through to an unchecked origin');
    } finally {process.chdir(cwd);globalThis.fetch=originalFetch;if(cloud===undefined)delete process.env.USE_WECHAT_CLOUD_CALL;else process.env.USE_WECHAT_CLOUD_CALL=cloud;}
  } finally {await rm(dir,{recursive:true,force:true});}
  console.log('reviewed image archive: exact URL, original byte identity, corruption, missing file, duplicate and path/size guards passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
