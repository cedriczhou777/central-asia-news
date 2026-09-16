#!/bin/bash
set -Eeuo pipefail

# package.json 锁了 packageManager: pnpm@9.0.0。若本机 pnpm 版本与它不同，
# corepack 会去下载指定版本，并「弹一个交互式确认」——在脚本/容器里没人回答这一问，
# 就会永久卡在 `? Do you want to continue? [Y/n]`。关掉确认，让它直接下载。
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# 关掉 Next.js 匿名遥测。除了少打一段提示，更重要的是：开启遥测时 Next 会往
# ~/Library/Preferences/nextjs-nodejs/config.json 写文件，在受限/只读 HOME 的环境里
# 这一步会以 EPERM 崩掉，且报错发生在启动阶段，看起来像项目本身起不来。
# 需要遥测的话删掉这行即可。
export NEXT_TELEMETRY_DISABLED=1

DEFAULT_PORT=3000
COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"
DEPLOY_RUN_PORT="${DEPLOY_RUN_PORT:-${PORT:-${DEFAULT_PORT}}}"


cd "${COZE_WORKSPACE_PATH}"

kill_port_if_listening() {
    local pids
    pids=$(ss -H -lntp 2>/dev/null | awk -v port="${DEPLOY_RUN_PORT}" '$4 ~ ":"port"$"' | grep -o 'pid=[0-9]*' | cut -d= -f2 | paste -sd' ' - || true)
    if [[ -z "${pids}" ]]; then
      echo "Port ${DEPLOY_RUN_PORT} is free."
      return
    fi
    echo "Port ${DEPLOY_RUN_PORT} in use by PIDs: ${pids} (SIGKILL)"
    echo "${pids}" | xargs -I {} kill -9 {}
    sleep 1
    pids=$(ss -H -lntp 2>/dev/null | awk -v port="${DEPLOY_RUN_PORT}" '$4 ~ ":"port"$"' | grep -o 'pid=[0-9]*' | cut -d= -f2 | paste -sd' ' - || true)
    if [[ -n "${pids}" ]]; then
      echo "Warning: port ${DEPLOY_RUN_PORT} still busy after SIGKILL, PIDs: ${pids}"
    else
      echo "Port ${DEPLOY_RUN_PORT} cleared."
    fi
}

echo "Clearing port ${DEPLOY_RUN_PORT} before start."
kill_port_if_listening
echo "Starting HTTP service on port ${DEPLOY_RUN_PORT} for dev..."

# 预览端口从 .preview 读取，读取不到 fallback 3000
EXPOSE_PORT=$(awk -F '[ =]+' '/^expose_port/ {gsub(/[^0-9]/, "", $2); print $2; exit}' .preview 2>/dev/null || echo 3000)
export DEPLOY_RUN_PORT="${DEPLOY_RUN_PORT:-$EXPOSE_PORT}"

exec pnpm exec next dev --hostname 0.0.0.0 --port "${DEPLOY_RUN_PORT}"
