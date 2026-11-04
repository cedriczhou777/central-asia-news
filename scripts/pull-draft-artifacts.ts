/** Read today's delivery artifacts into local files for Codex; no model API or WeChat write required. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { beijingDate } from '../src/lib/utils';
import { DEFAULT_NEWS_SERVICE, pullDraftArtifacts, pullDatabaseReviewSnapshot, pullDraftArtifactsDirect, pullDatabaseReviewSnapshotDirect } from '../src/lib/draft-artifact-client';

config({ path: '.env.local', quiet: true });
async function main() {
  const args = process.argv.slice(2); let date = beijingDate(); let country: string | undefined; let directory: string | undefined; let database = false; let direct = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--database') database = true;
    else if (args[i] === '--direct') direct = true;
    else if (args[i] === '--country' && args[i + 1]) country = args[++i];
    else if (args[i] === '--out' && args[i + 1]) directory = args[++i];
    else if (/^\d{4}-\d{2}-\d{2}$/.test(args[i])) date = args[i];
    else throw new Error('用法：pnpm drafts:pull [YYYY-MM-DD] [--country kz] [--out 目录] [--database] [--direct]');
  }
  const base = process.env.NEWS_SERVICE_BASE_URL || DEFAULT_NEWS_SERVICE;
  const dir = resolve(directory || '.cache/drafts/' + date + (database ? '/database' : '/artifacts'));
  if (direct) {
    // This command only selects rows. Never silently use the server's optional administrative key.
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
  }
  if (database) {
    const snapshot = direct ? await pullDatabaseReviewSnapshotDirect(date, country) : await pullDatabaseReviewSnapshot(base, date, country);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'database-snapshot.json'), JSON.stringify(snapshot, null, 2));
    const unmatched = snapshot.countries.reduce((n, c) => n + c.unmatchedTitles.length, 0);
    console.log('已取回数据库译稿；这是推送前原稿，不能冒充最终成稿。未准确匹配 ' + unmatched + ' 条；输出 ' + dir);
    if (unmatched) process.exitCode = 1;
    return;
  }
  const token = process.env.NEWS_ARTIFACT_READ_TOKEN;
  if (!direct && !token) throw new Error('请在安全环境配置 NEWS_ARTIFACT_READ_TOKEN，或配置数据库访问后使用 --direct；取稿不需要模型API Key');
  const artifacts = direct ? await pullDraftArtifactsDirect(date, country) : await pullDraftArtifacts(base, date, token!, country);
  mkdirSync(dir, { recursive: true });
  for (const artifact of artifacts) {
    const name = artifact.countryCode + '_' + artifact.id.slice(-24);
    writeFileSync(resolve(dir, name + '.html'), artifact.draft.content);
    writeFileSync(resolve(dir, name + '.json'), JSON.stringify(artifact, null, 2));
    writeFileSync(resolve(dir, name + '.batch.json'), JSON.stringify({ country: artifact.countryName, articles: artifact.articles }, null, 2));
  }
  writeFileSync(resolve(dir, 'index.json'), JSON.stringify({ date, fetchedAt: new Date().toISOString(), artifacts: artifacts.map((a) => ({
    id: a.id, country: a.countryCode, status: a.delivery.status, mediaId: a.delivery.mediaId, contentHash: a.contentHash,
  })) }, null, 2));
  console.log('取回 ' + artifacts.length + ' 份成稿归档；输出 ' + dir);
  if (!artifacts.length || artifacts.some((a) => a.delivery.status !== 'submitted')) process.exitCode = 1;
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : '取稿失败'); process.exitCode = 1; });
