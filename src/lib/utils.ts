import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// 从含图片的 content 中提取第一张图片 URL（支持 <img src> 标签）
export function extractFirstImage(content: string): string | null {
  const m = content.match(/<img[^>]*?\ssrc=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

// 提取首图 URL，并从剩余正文中剥离图片标签
export function splitContentImage(content: string): { coverImage: string | null; textContent: string } {
  const coverImage = extractFirstImage(content);
  const textContent = coverImage
    ? content.replace(/<img[^>]*?>/gi, '').trim()
    : content.trim();
  return { coverImage, textContent };
}

// 检测文本是否为中文：中文字符占比达到阈值（默认 40%）即视为已翻译为中文
export function isChineseText(text: string, threshold = 0.4): boolean {
  const cleaned = (text || '').replace(/<[^>]+>/g, ' ').replace(/[\s，。、；：,.!?…\-"'“”‘’()·%$]+/g, '');
  if (!cleaned) return false;
  const han = cleaned.match(/[\u4e00-\u9fa5]/g)?.length || 0;
  return han / cleaned.length >= threshold;
}
