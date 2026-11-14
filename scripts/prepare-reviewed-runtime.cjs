// Runs only in the disposable image build stage; the repository retains old routes.
const fs = require('node:fs');
const path = require('node:path');
if (process.env.REVIEWED_BUILD_ONLY !== '1') throw new Error('This script may run only in the image build stage');
const api = path.join(process.cwd(), 'src/app/api');
for (const entry of fs.readdirSync(api, { withFileTypes: true })) {
  if (!['word-package', 'word-ingest', 'reviewed-images', 'wechat'].includes(entry.name)) fs.rmSync(path.join(api, entry.name), { recursive: true, force: true });
}
const wechat = path.join(api, 'wechat');
for (const entry of fs.readdirSync(wechat, { withFileTypes: true })) {
  if (entry.name !== 'push') fs.rmSync(path.join(wechat, entry.name), { recursive: true, force: true });
}
fs.writeFileSync(path.join(wechat, 'push/route.ts'), "import { reviewedPush, reviewedStatus } from '@/lib/reviewed-push-handler';\nexport const POST = reviewedPush;\nexport const GET = reviewedStatus;\n");
