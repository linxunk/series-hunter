#!/usr/bin/env bash
# Codespaces 启动脚本：拉起剧集猎人后端（前台运行，日志直接进 Codespaces 终端）
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

export PORT="${PORT:-8787}"
export HOST=0.0.0.0
export DOWNLOAD_DIR="${DOWNLOAD_DIR:-/workspace/series-hunter/downloads}"
export CORS_ORIGIN="${CORS_ORIGIN:-*}"
export TZ=Asia/Shanghai

mkdir -p "$DOWNLOAD_DIR"

echo "==> 剧集猎人启动：http://0.0.0.0:${PORT}"
echo "    端口 8787 需要在 PORTS 面板设为 Public 才会生成公网地址"
exec node server/index.js
