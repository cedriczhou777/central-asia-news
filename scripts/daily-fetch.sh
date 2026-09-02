#!/bin/bash
# 每日新闻采集脚本
# 用法：./scripts/daily-fetch.sh [limit] [autoPush]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# 从 .preview 读取端口
EXPOSE_PORT=$(awk -F '[ =]+' '/^expose_port/ {gsub(/[^0-9]/, "", $2); print $2; exit}' .preview 2>/dev/null || echo 5000)

LIMIT=${1:-10}
AUTO_PUSH=${2:-false}

echo "[$(date)] 开始每日新闻采集..."
echo "端口：$EXPOSE_PORT, 限制：$LIMIT, 自动推送：$AUTO_PUSH"

# 调用 pipeline API
RESPONSE=$(curl -s -X POST "http://localhost:${EXPOSE_PORT}/api/pipeline" \
  -H "Content-Type: application/json" \
  -d "{\"limit\": ${LIMIT}, \"autoPush\": ${AUTO_PUSH}}" \
  --max-time 300)

echo "[$(date)] 采集完成："
echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"

# 检查是否有错误
if echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('success') else 1)" 2>/dev/null; then
  echo "[$(date)] ✓ 每日采集成功"
  exit 0
else
  echo "[$(date)] ✗ 每日采集失败"
  exit 1
fi
