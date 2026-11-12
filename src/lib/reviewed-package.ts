import { createHash } from 'node:crypto';
import { load } from 'cheerio';

export const PACKAGE_COUNTRIES = ['kz', 'uz', 'kg', 'tj', 'az'] as const;
export type PackageCountry = typeof PACKAGE_COUNTRIES[number];
export interface ReviewedCountry {
  title: string; summary: string; bodyHtml: string;
  sourceName: string; sourceUrl: string; coverUrl: string;
}
export interface ReviewedPackage {
  version: string;
  countries: Record<PackageCountry, ReviewedCountry>;
}
export function issueDate(version: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:-r([2-9]|[1-9]\d+))?$/.exec(version);
  const date = match ? new Date(`${match[1]}T00:00:00Z`) : null;
  if (!match || !date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) {
    throw new Error('version 必须为真实刊期 YYYY-MM-DD，修订用 YYYY-MM-DD-r2 等');
  }
  return match[1];
}
export function issueCutoffElapsed(version:string,now=Date.now()):boolean {
  return Date.parse(`${issueDate(version)}T06:00:00+08:00`)<=now;
}
export function imageUrls(html: string): string[] {
  const $ = load(html, {}, false);
  return $('img').toArray().map(el => $(el).attr('src') || '');
}
/** WeChat draft readback may discard anchor attributes. Keep source URLs readable in the article itself. */
export function makeSourceUrlsVisible(html: string): string {
  return html.replace(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_tag, _quote: string, rawUrl: string, label: string) => {
    const url = load(`<span>${rawUrl}</span>`, {}, false)('span').text();
    return `${label}（${url}）`;
  });
}
export function sourceUrls(html: string): string[] {
  const $ = load(html, {}, false);
  return $('a[href]').toArray().map(el => $(el).attr('href') || '').filter(Boolean);
}
export function validatePackage(input: unknown): ReviewedPackage {
  if (!input || typeof input !== 'object') throw new Error('请求体必须为 JSON 对象');
  const body = input as Record<string, unknown>;
  if (typeof body.version !== 'string' || !body.version) throw new Error('缺少 version');
  issueDate(body.version);
  const entries = body.countries as Record<string, unknown> | undefined;
  const countries = {} as ReviewedPackage['countries'];
  for (const code of PACKAGE_COUNTRIES) {
    const item = entries?.[code];
    if (!item || typeof item !== 'object') throw new Error(`五国未齐，缺 ${code}`);
    const d = item as Record<string, unknown>;
    for (const key of ['title', 'summary', 'bodyHtml', 'sourceName', 'sourceUrl', 'coverUrl']) {
      if (typeof d[key] !== 'string') throw new Error(`${code}.${key} 必须为字符串`);
    }
    if (!(d.title as string).trim() || [...d.title as string].length > 60) throw new Error(`${code} 标题须为1至60字`);
    if (!(d.summary as string).trim() || !load(d.bodyHtml as string).text().trim()) throw new Error(`${code} 摘要或正文为空`);
    const $ = load(d.bodyHtml as string, {}, false);
    if ($('script,iframe,object,embed,form').length || /\son\w+\s*=/i.test(d.bodyHtml as string)) throw new Error(`${code} 正文含不允许的活动内容`);
    const imgs = imageUrls(d.bodyHtml as string);
    const tags = (d.bodyHtml as string).match(/<img\b[^>]*>/gi) || [];
    if (tags.some(tag => !/\ssrc\s*=\s*(["']).*?\1/i.test(tag))) throw new Error(`${code} 图片 src 须使用引号`);
    for (const url of imgs) assertHttps(url);
    if (d.sourceUrl) assertHttps(d.sourceUrl as string);
    if (d.coverUrl && d.coverUrl !== imgs[0]) throw new Error(`${code} 封面必须为正文第一张图；无图请留空`);
    // Explicit fields make hashing independent of input JSON key order. Preserve exact editorial text.
    countries[code] = {
      title: d.title as string, summary: d.summary as string, bodyHtml: d.bodyHtml as string,
      sourceName: d.sourceName as string, sourceUrl: d.sourceUrl as string, coverUrl: d.coverUrl as string,
    };
  }
  return { version: body.version, countries };
}
export function assertHttps(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('图片和来源须使用公网 HTTPS 地址');
}
export function contentHash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}
/** Replace only img src attribute values, preserving all surrounding submitted HTML bytes. */
export function replaceImageSources(html: string, urls: Map<string, string>): string {
  return html.replace(/<img\b[^>]*>/gi, tag => tag.replace(/(\ssrc\s*=\s*)(["'])(.*?)\2/i, (all, prefix, quote, raw) => {
    const decoded = load(`<img src=${quote}${raw}${quote}>`)('img').attr('src') || '';
    const replacement = urls.get(decoded);
    if (!replacement) throw new Error('图片转存结果缺失');
    return `${prefix}${quote}${replacement.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')}${quote}`;
  }));
}
export function latestVersion(versions: string[], date: string): string | undefined {
  return versions.filter(v => issueDate(v) === date).sort((a,b) => Number(b.split('-r')[1] || 1) - Number(a.split('-r')[1] || 1))[0];
}
