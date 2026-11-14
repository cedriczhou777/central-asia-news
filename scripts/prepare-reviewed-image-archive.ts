// Offline build helper. Input manifest: {images:[{url,sha256,bytes}]}; source
// directory contains original files named by SHA-256. Never downloads or writes
// production. Validate every file before installing the destination manifest.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { assertHttps } from '../src/lib/reviewed-package';

async function main() {
  const [input,source,output]=process.argv.slice(2);
  if(!input||!source||!output)throw new Error('Usage: prepare-reviewed-image-archive.ts MANIFEST SOURCE_DIRECTORY OUTPUT_DIRECTORY');
  const manifest=JSON.parse(await readFile(resolve(input),'utf8')) as {images:Array<{url:string;sha256:string;bytes:number}>};
  if(!Array.isArray(manifest.images)||manifest.images.length===0)throw new Error('Missing images');
  const seen=new Set<string>();
  for(const entry of manifest.images){
    assertHttps(entry.url);
    if(seen.has(entry.url)||!/^[a-f0-9]{64}$/.test(entry.sha256)||!Number.isSafeInteger(entry.bytes)||entry.bytes<1||entry.bytes>10_000_000)throw new Error('Invalid or duplicate manifest entry');
    seen.add(entry.url);
    const bytes=await readFile(join(resolve(source),entry.sha256));
    if(bytes.length!==entry.bytes||createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new Error('Original image hash mismatch');
    const metadata=await sharp(bytes,{limitInputPixels:40_000_000}).metadata();
    if(!metadata.width||!metadata.height)throw new Error('Invalid image');
  }
  const destination=resolve(output);await mkdir(destination,{recursive:true});
  for(const entry of manifest.images)await copyFile(join(resolve(source),entry.sha256),join(destination,entry.sha256));
  await writeFile(join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  console.log(`Validated and staged ${manifest.images.length} original images; no production writes`);
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Archive preparation failed');process.exitCode=1;});
