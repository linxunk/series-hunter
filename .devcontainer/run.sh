#!/usr/bin/env bash
# Codespaces 启动脚本：拉起剧集猎人后端，并保持 Codespaces 永不休眠
set -uo pipefail

cd "$(dirname "$0")/.."

export PORT="${PORT:-8787}"
export HOST=0.0.0.0
export DOWNLOAD_DIR="${DOWNLOAD_DIR:-$PWD/downloads}"
export CORS_ORIGIN="${CORS_ORIGIN:-*}"
export TZ=Asia/Shanghai

mkdir -p "$DOWNLOAD_DIR"

# ---- 保持 Codespaces 不被空闲回收 ----
# Codespaces 空闲 30 分钟会自动停机（端口随即 404）。
# 规律调用一次 start 接口即可刷新空闲计时器，让云主机一直在线。
keep_codespace_awake() {
  local name="${CODESPACE_NAME:-}"
  local token="${GITHUB_TOKEN:-}"
  [ -z "$name" ] && return 0
  while true; do
    sleep 480   # 8 分钟一次
    if [ -n "$token" ]; then
      curl -s -X POST \
        -H "Authorization: Bearer ${token}" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/user/codespaces/${name}/start" >/dev/null 2>&1 || true
    fi
    # 备用：访问自己的公网端口也会刷新计时器
    curl -s -o /dev/null -m 10 "https://${name}-${PORT}.app.github.dev/" >/dev/null 2>&1 || true
  done
}
keep_codespace_awake &

echo "==> 剧集猎人启动：http://0.0.0.0:${PORT}"
echo "    Codespace: ${CODESPACE_NAME:-<未设置>}"
exec node server/index.js
