#!/usr/bin/env bash
# Codespaces 启动脚本：拉起剧集猎人后端（后台运行），并尝试把 8787 端口设为 Public
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

export PORT="${PORT:-8787}"
export HOST=0.0.0.0
export DOWNLOAD_DIR="${DOWNLOAD_DIR:-$PWD/downloads}"
export CORS_ORIGIN="${CORS_ORIGIN:-*}"
export TZ=Asia/Shanghai

mkdir -p "$DOWNLOAD_DIR"

# ---- 把 8787 端口设为 Public（Codespaces 内置 gh / GITHUB_TOKEN 已认证） ----
publish_port() {
  local name="${CODESPACE_NAME:-}"
  [[ -z "$name" ]] && return 0
  sleep 20
  if command -v gh >/dev/null 2>&1; then
    gh codespace ports visibility 8787:public -c "$name" >> /tmp/port-visibility.log 2>&1 && \
      echo "==> 已通过 gh 将端口设为 Public"
  fi
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    curl -s -X PATCH \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      -H "Content-Type: application/json" \
      -d '{"visibility":"public"}' \
      "https://api.github.com/user/codespaces/${name}/ports/${PORT}" >> /tmp/port-visibility.log 2>&1
  fi
}
publish_port &

echo "==> 剧集猎人启动：http://0.0.0.0:${PORT}"
echo "    公网地址形如 https://${CODESPACE_NAME:-<codespace>}-${PORT}.app.github.dev"
exec node server/index.js
