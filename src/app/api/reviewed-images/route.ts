import { NextResponse } from 'next/server';
import { assertHttps } from '@/lib/reviewed-package';
import { stagePrivateImage, privateImageHealth, readPrivateImage } from '@/lib/reviewed-private-images';
import { MAX_IMAGE_BYTES, validateOriginalImage } from '@/lib/reviewed-image-bytes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const authorized = (req: Request) => !!process.env.INGEST_SECRET && req.headers.get('x-ingest-secret') === process.env.INGEST_SECRET;
export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ok:false,error:'鉴权失败'},{status:401});
  const query = new URL(req.url).searchParams;
  if (!query.has('sha256')) return NextResponse.json(await privateImageHealth());
  try {
    const sha256=query.get('sha256') || '', size=Number(query.get('bytes'));
    if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size<1 || size>MAX_IMAGE_BYTES) return NextResponse.json({ok:false,error:'原图参数无效'},{status:400});
    const bytes=await readPrivateImage({sha256,bytes:size});
    const meta=await validateOriginalImage(bytes);
    if (query.get('download') === '1') return new Response(new Uint8Array(bytes),{headers:{'Content-Type':`image/${meta.format}`,'Cache-Control':'private, no-store'}});
    return NextResponse.json({ok:true,ready:true,private:true,sha256,bytes:bytes.length});
  } catch { return NextResponse.json({ok:false,error:'原图私有存档缺失或未通过核验'},{status:503}); }
}
export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ok:false,error:'鉴权失败'},{status:401});
  try {
    const sha256=req.headers.get('x-content-sha256') || '';
    if (!/^[a-f0-9]{64}$/.test(sha256)) return NextResponse.json({ok:false,error:'须提供有效X-Content-Sha256'},{status:400});
    const source=req.headers.get('x-source-url');
    if (!source) return NextResponse.json({ok:false,error:'须提供原始图片地址'},{status:400});
    assertHttps(decodeURIComponent(source));
    if (Number(req.headers.get('content-length'))>MAX_IMAGE_BYTES) return NextResponse.json({ok:false,error:'图片超过10MB'},{status:413});
    const reader=req.body?.getReader();
    if (!reader) return NextResponse.json({ok:false,error:'缺少原始图片字节'},{status:400});
    const chunks:Uint8Array[]=[];let size=0;
    while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>MAX_IMAGE_BYTES){await reader.cancel();return NextResponse.json({ok:false,error:'图片超过10MB'},{status:413});}chunks.push(next.value);}
    const result=await stagePrivateImage(Buffer.concat(chunks),sha256);
    return NextResponse.json({ok:true,sourceUrl:decodeURIComponent(source),...result});
  } catch(e) {
    const message=e instanceof Error?e.message:'原图转存失败';
    return NextResponse.json({ok:false,error:message},{status:/哈希|长度|解码|图片须|HTTPS|Invalid URL/.test(message)?400:503});
  }
}
