#!/bin/bash
set -Eeuo pipefail

# package.json 锁了 packageManager: pnpm@9.0.0。若环境里的 pnpm 版本与它不同，
# corepack 会去下载指定版本，并弹一个交互式确认——构建是非交互的，没人回答就永久卡住。
# 关掉确认，让它直接下载。
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"

cd "${COZE_WORKSPACE_PATH}"

echo "Installing dependencies..."
pnpm install --prefer-frozen-lockfile --prefer-offline --loglevel debug --reporter=append-only

# sharp 必须在「根 node_modules」里可解析 —— next build 的类型检查会对
# src/app/api/wechat/push/route.ts 里的 import('sharp') 做模块解析，
# 解析不到就是 TS2307，整个构建失败（2026-09-18 线上连续 5 个提交没上去的原因）。
# 这里提前打印人话诊断，免得又对着 TS2307 猜半天。
# 刻意不 exit 1：让后面的 next build 去决定成败，这里只负责「把原因说清楚」。
node -e "
try {
  const p = require.resolve('sharp');
  console.log('[ok] sharp 可从根 node_modules 解析：' + p);
} catch (e) {
  console.log('=========================================================');
  console.log('[FATAL] sharp 无法从根 node_modules 解析，next build 会报 TS2307 而失败。');
  console.log('        最常见原因：sharp 不在 package.json 的 dependencies 里。');
  console.log('        sharp 原本只是 next 的 optionalDependency，pnpm 对传递依赖');
  console.log('        只做私有提升（node_modules/.pnpm/node_modules），根目录没有它；');
  console.log('        必须是「直接依赖」才会像 rss-parser 那样在根目录建软链。');
  console.log('=========================================================');
}
"

echo "Building the Next.js project..."
pnpm next build

echo "Bundling server with tsup..."
pnpm tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting --no-minify

echo "Build completed successfully!"
