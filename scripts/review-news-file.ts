/** Review a local batch and produce audited HTML without touching WeChat or the database. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { reviewNewsArticles, type NewsReviewArticle } from '../src/lib/news-review';
import { generateWechatHtml } from '../src/lib/wechat-template';
import { assertReviewedRendering } from '../src/lib/review-text';
import { beijingDate } from '../src/lib/utils';

config({ path: '.env.local', quiet: true });
async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('用法：pnpm review:file <batch.json> [输出目录]；此命令会调用已配置的审稿API');
  const data = JSON.parse(readFileSync(file, 'utf8')) as { country: string; articles: NewsReviewArticle[] };
  if (!data.country || !Array.isArray(data.articles) || data.articles.some((a) => !a || typeof a.title !== 'string' || typeof a.content !== 'string' || typeof a.source_name !== 'string')) throw new Error('批次需要country、articles及每篇的title/content/source_name/original_content/source_url');
  const result = await reviewNewsArticles(data.country, data.articles);
  const html = result.kept.length ? generateWechatHtml(data.country, '', beijingDate(), result.kept.map((a) => ({ ...a, category: 'economy' }))) : '';
  if (html) assertReviewedRendering(html, result.kept);
  const dir = resolve(process.argv[3] || '.cache/news-review');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'review.json'), JSON.stringify({ audit: result.audit, articles: result.kept }, null, 2));
  writeFileSync(resolve(dir, 'review.html'), html);
  console.log('审稿通过 ' + result.kept.length + ' / 待审 ' + result.audit.held + '；输出 ' + dir);
  if (!result.kept.length || result.audit.held) process.exitCode = 1;
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
