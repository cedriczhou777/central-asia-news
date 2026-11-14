import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ReviewedImageAsset } from './reviewed-package';

export const MAX_IMAGE_BYTES = 10_000_000;
export function imageHash(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }
export async function validateOriginalImage(bytes: Buffer, expected?: ReviewedImageAsset) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('图片字节须非空且不超过10MB');
  if (expected && (bytes.length !== expected.bytes || imageHash(bytes) !== expected.sha256)) throw new Error('原图存档哈希或长度不一致');
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000 });
    const meta = await image.metadata();
    if (!meta.width || !meta.height || !['jpeg','png','webp','gif','avif','heif','tiff'].includes(meta.format || '')) throw new Error();
    await image.stats(); // Decode pixels too; a plausible image header is insufficient.
    return { format: meta.format!, width: meta.width, height: meta.height };
  } catch { throw new Error('来源响应不是可解码的图片'); }
}
