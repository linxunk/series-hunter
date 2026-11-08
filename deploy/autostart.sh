#!/usr/bin/env bash
# 容器开机自启剧集猎人后端（由 cron @reboot 调用）
APP_DIR="${APP_DIR:-/workspaces/series-hunter}"
PORT="${PORT:-8787}"
cd "$APP_DIR" || exit 1
if pgrep -f "server/index.js" >/dev/null 2>&1; then exit 0; fi
mkdir -p ./downloads
PORT="$PORT" HOST=0.0.0.0 DOWNLOAD_DIR="$APP_DIR/downloads" CORS_ORIGIN="${CORS_ORIGIN:-*}" \
  setsid nohup bash .devcontainer/run.sh > /tmp/series-hunter.log 2>&1 < /dev/null &
sleep 3
exit 0
