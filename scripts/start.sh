#!/bin/bash
set -Eeuo pipefail

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"

# 端口口径：DEPLOY_RUN_PORT > PORT（平台注入）> 3000
# 3000 与 container.config.json 的 container.port、Dockerfile 的 EXPOSE 保持一致。
# 旧版默认 5000，与配置声明对不上，是一处静默失败隐患。
DEFAULT_PORT=3000
DEPLOY_RUN_PORT="${DEPLOY_RUN_PORT:-${PORT:-$DEFAULT_PORT}}"


start_service() {
    cd "${COZE_WORKSPACE_PATH}"
    # 这一行只在 start_service 里打一次。旧版函数内、函数外各打一遍，日志里看起来像启动了两次。
    echo "Starting HTTP service on port ${DEPLOY_RUN_PORT} for deploy..."
    PORT=${DEPLOY_RUN_PORT} NODE_ENV=production node dist/server.js
}

start_service
