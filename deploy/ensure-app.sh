#!/usr/bin/env bash
# 剧集猎人 · 容器内自检与自愈
# 在 Codespaces 容器内执行：确认应用进程存在、端口在听；不在就拉起来。
# 输出为纯文本，便于 Actions 回传到主控做诊断。

APP_DIR="${APP_DIR:-/workspaces/series-hunter}"
PORT="${PORT:-8787}"
echo "=== 时间 ==="; date -u '+%Y-%m-%dT%H:%M:%SZ'
echo "=== 工作目录 ==="; pwd
echo "=== node ==="; command -v node || echo "NO_NODE_BIN"; node -v 2>&1 || true
echo "=== 应用进程 ==="
pgrep -af "server/index.js" || echo "NO_APP_PROCESS"
echo "=== 监听端口 ==="
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E "8787|Local" | head -8 || echo "NO_SS"
echo "=== /tmp 日志 ==="
ls -la /tmp/*.log 2>/dev/null | head -6 || echo "NO_TMP_LOG"
echo "=== devcontainer 生命周期 ==="
grep -E "postCreateCommand|postStartCommand" "$APP_DIR/.devcontainer/devcontainer.json" 2>/dev/null || echo "NO_DC_FILE"
echo "=== 本机自检 ==="
printf "root="; curl -s -o /dev/null -m 8 -w "%{http_code}" "http://127.0.0.1:${PORT}/" 2>/dev/null; echo
printf "appjs="; curl -s -o /dev/null -m 8 -w "%{http_code}" "http://127.0.0.1:${PORT}/app.js" 2>/dev/null; echo
printf "health="; curl -s -m 8 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | head -c 160; echo

# ---- 自愈：yt-dlp 不在就装 ----
if ! command -v yt-dlp >/dev/null 2>&1 && ! python3 -c "import yt_dlp" >/dev/null 2>&1; then
  echo "=== 动作：安装 yt-dlp ==="
  (pip3 install --quiet --break-system-packages -U yt-dlp 2>/dev/null \
    || pip3 install --quiet -U yt-dlp 2>/dev/null \
    || curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp && sudo chmod +x /usr/local/bin/yt-dlp) || true
  echo "yt-dlp: $(yt-dlp --version 2>&1 | head -1 || echo 仍不可用)"
fi

# ---- 自愈：进程不在就启动 ----
if ! pgrep -f "server/index.js" >/dev/null 2>&1; then
  echo "=== 动作：应用未运行，正在启动 ==="
  cd "$APP_DIR" || exit 1
  mkdir -p ./downloads
  PORT="$PORT" HOST=0.0.0.0 DOWNLOAD_DIR="$APP_DIR/downloads" CORS_ORIGIN="${CORS_ORIGIN:-*}" \
    setsid nohup bash .devcontainer/run.sh > /tmp/series-hunter.log 2>&1 < /dev/null &
  sleep 6
  echo "=== 启动后 ==="
  pgrep -af "server/index.js" || echo "STILL_NOT_RUNNING"
  tail -n 12 /tmp/series-hunter.log 2>/dev/null || echo "NO_LOG"
  printf "health="; curl -s -m 8 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | head -c 160; echo
else
  echo "=== 动作：应用已在运行，无需干预 ==="
fi
