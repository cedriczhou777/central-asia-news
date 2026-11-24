// Runs only in the disposable image build stage; the repository retains old routes.
const fs = require('node:fs');
const path = require('node:path');
const {createHash}=require('node:crypto');
if (process.env.REVIEWED_BUILD_ONLY !== '1') throw new Error('This script may run only in the image build stage');
const identityFiles=['src/lib/plan-b-runtime.ts','src/lib/plan-b-exchange.ts','src/lib/plan-b-command.ts',
  'src/lib/plan-b-checkpoint.ts','src/lib/reviewed-manual-authorization.ts','src/app/api/plan-b/route.ts',
  'ops/plan-b/cloud_handoff.py','ops/plan-b/cloud_release.py','ops/plan-b/news_queue_policy.py',
  'ops/plan-b/source_coverage.py','ops/plan-b/discover_work_sources.py',
  'ops/plan-b/work_client.py','ops/plan-b/db_handoff.py','src/lib/plan-b-worker.ts',
  'src/lib/plan-b-release.ts','src/app/api/word-package/route.ts','src/lib/reviewed-push-handler.ts',
  'src/lib/reviewed-package.ts','src/lib/reviewed-wechat.ts','migrations/20261123_plan_b_exchange.sql','scripts/prepare-reviewed-runtime.cjs'];
const hashes=Object.fromEntries(identityFiles.map(file=>[file,createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
fs.writeFileSync('ops/plan-b/build-identity.json',JSON.stringify({files:hashes,
  implementationSha256:createHash('sha256').update(JSON.stringify(hashes)).digest('hex')}));
const api = path.join(process.cwd(), 'src/app/api');
for (const entry of fs.readdirSync(api, { withFileTypes: true })) {
  if (!['plan-b', 'word-package', 'word-ingest', 'reviewed-images', 'wechat'].includes(entry.name)) fs.rmSync(path.join(api, entry.name), { recursive: true, force: true });
}
const wechat = path.join(api, 'wechat');
for (const entry of fs.readdirSync(wechat, { withFileTypes: true })) {
  if (entry.name !== 'push') fs.rmSync(path.join(wechat, entry.name), { recursive: true, force: true });
}
fs.writeFileSync(path.join(wechat, 'push/route.ts'), "import { reviewedPush, reviewedStatus } from '@/lib/reviewed-push-handler';\nexport const POST = reviewedPush;\nexport const GET = reviewedStatus;\n");
