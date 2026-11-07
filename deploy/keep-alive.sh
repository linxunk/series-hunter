#!/usr/bin/env bash
# =============================================================
#  剧集猎人 · 保活守护
#  作用：持续保证「后端进程」与「公网隧道」在线，并在隧道换地址后
#        自动把最新后端地址写回 web/config.js（前端重新发布后即生效）。
#  用法：
#    bash deploy/keep-alive.sh [--provider serveo|localhost.run|none] [--port 8787]
#  说明：
#    - 正式部署到自己的服务器时，系统dIY systemd 负责保活，本脚本只针对
#      「本地跑 + SSH 隧道暴露」这种演示形态。
#    - 隧道地址每次重连都会变，这是免费隧道服务的设计；脚本会自动同步。
# =============================================================
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=8787
PROVIDER=serveo
INTERVAL=45

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider) PROVIDER="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

LOG="${APP_DIR}/deploy/keep-alive.log"
TUNNEL_LOG=/tmp/series-hunter-tunnel.log

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

backend_up() { curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; }

tunnel_up() {
  [[ -f /tmp/series-hunter-tunnel.url ]] || return 1
  local u; u="$(cat /tmp/series-hunter-tunnel.url)"
  [[ -n "$u" ]] || return 1
  curl -fsS --max-time 12 "${u}/api/health" >/dev/null 2>&1
}

write_config() {
  local u="$1"
  [[ -n "$u" ]] || return 0
  python3 - "$APP_DIR/web/config.js" "$u" <<'PY'
import re, sys
path, url = sys.argv[1], sys.argv[2]
s = open(path, encoding='utf-8').read()
s = re.sub(r"apiBase: '[^']*'", f"apiBase: '{url}'", s)
open(path, 'w', encoding='utf-8').write(s)
PY
  log "已同步前端后端地址 → $u"
}

start_backend() {
  log "启动后端…"
  cd "$APP_DIR" || return 1
  PORT="$PORT" HOST=0.0.0.0 DOWNLOAD_DIR="${DOWNLOAD_DIR:-$APP_DIR/downloads}" \
    CORS_ORIGIN="${CORS_ORIGIN:-*}" \
    setsid nohup node server/index.js >>"$LOG" 2>&1 < /dev/null &
  sleep 3
  backend_up && log "后端已就绪" || log "后端启动失败"
}

start_tunnel() {
  case "$PROVIDER" in
    none) log "未启用隧道（provider=none）"; return 0 ;;
    serveo) REMOTE="${TUNNEL_NAME:-80:localhost:${PORT}}"; HOST=serveo.net ;;
    localhost.run) REMOTE="${TUNNEL_NAME:-80:localhost:${PORT}}"; HOST=localhost.run ;;
    *) log "未知 provider: $PROVIDER"; return 1 ;;
  esac
  log "建立隧道 ($PROVIDER)…"
  setsid nohup ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=20 \
      -o ServerAliveCountMax=10000 -o ExitOnForwardFailure=yes \
      -R "$REMOTE" "$HOST" > "$TUNNEL_LOG" 2>&1 < /dev/null &
  for _ in $(seq 1 20); do
    sleep 2
    local u
    u="$(tr -d '\r' < "$TUNNEL_LOG" 2>/dev/null | grep -o 'https://[a-z0-9.-]*serveousercontent\.com' | head -1)"
    [[ -z "$u" ]] && u="$(tr -d '\r' < "$TUNNEL_LOG" 2>/dev/null | grep -o 'https://[a-z0-9]*\.lhr\.life' | head -1)"
    if [[ -n "$u" ]]; then
      echo "$u" > /tmp/series-hunter-tunnel.url
      write_config "$u"
      log "隧道就绪：$u"
      return 0
    fi
  done
  log "隧道建立超时"
  return 1
}

log "保活守护启动（provider=$PROVIDER port=$PORT interval=${INTERVAL}s）"
while true; do
  backend_up || start_backend
  if [[ "$PROVIDER" != "none" ]]; then
    tunnel_up || start_tunnel
  fi
  sleep "$INTERVAL"
done
