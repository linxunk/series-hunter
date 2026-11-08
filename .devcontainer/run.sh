#!/usr/bin/env bash
# Codespaces 启动脚本：拉起剧集猎人后端，并尝试保持 Codespaces 永不休眠
set -uo pipefail

cd "$(dirname "$0")/.."

export PORT="${PORT:-8787}"
export HOST=0.0.0.0
export DOWNLOAD_DIR="${DOWNLOAD_DIR:-$PWD/downloads}"
export CORS_ORIGIN="${CORS_ORIGIN:-*}"
export TZ=Asia/Shanghai

mkdir -p "$DOWNLOAD_DIR"

# ---------------------------------------------------------------------------
# 保活：Codespaces 空闲 30 分钟会自动停机（端口随即 404）。
# 规律调用 start 接口可刷新空闲计时器；这里同时把结果心跳回主控，
# 便于确认容器内的令牌是否有权限自行保活。
# ---------------------------------------------------------------------------
keep_codespace_awake() {
  local name="${CODESPACE_NAME:-}"
  local token="${GITHUB_TOKEN:-}"
  [ -z "$name" ] && return 0

  # 主控地址：从本项目的 web/config.js 里读 apiBase（隧道地址会变，故不写死）
  local peer_api=""
  peer_api="$(grep -o "apiBase: '[^']*'" web/config.js 2>/dev/null | head -1 | sed "s/apiBase: '//; s/'$//")"

  while true; do
    sleep 480   # 8 分钟
    local resp="" code=""
    if [ -n "$token" ]; then
      resp="$(curl -s -m 25 -X POST \
        -H "Authorization: Bearer ${token}" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/user/codespaces/${name}/start" 2>/dev/null)"
      code="$(echo "$resp" | head -c 120)"
    fi
    if [ -n "$peer_api" ]; then
      curl -s -m 15 -X POST -H "Content-Type: application/json" \
        -d "{\"from\":\"codespace:${name}\",\"at\":$(date +%s),\"resp\":\"${code}\"}" \
        "${peer_api}/api/heartbeat" >/dev/null 2>&1 || true
    fi
  done
}
keep_codespace_awake &

# 记录启动时的代码版本，供巡检判断是否需要重启
git rev-parse HEAD > /tmp/app-commit 2>/dev/null || true

echo "==> 剧集猎人启动：http://0.0.0.0:${PORT}"
echo "    Codespace: ${CODESPACE_NAME:-<未设置>}"
exec node server/index.js
