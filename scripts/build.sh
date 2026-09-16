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

echo "Building the Next.js project..."
pnpm next build

echo "Bundling server with tsup..."
pnpm tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting --no-minify

echo "Build completed successfully!"
