#!/usr/bin/env bash
# 剧集猎人 · 容器内自检与自愈（在 Codespaces 容器内执行）
#   1) 拉取最新代码
#   2) 确保 yt-dlp 可用（pip 装到 ~/.local/bin 时补软链到 /usr/local/bin）
#   3) 代码有变化就重启应用进程
#   4) 应用不在就拉起来
# 输出为纯文本，便于 Actions 收集诊断。

APP_DIR="${APP_DIR:-/workspaces/series-hunter}"
PORT="${PORT:-8787}"
cd "$APP_DIR" || exit 1

echo "=== 时间 ==="; date -u '+%Y-%m-%dT%H:%M:%SZ'

# ---- 0) 开机自启（cron @reboot），保证容器一起来应用就监听端口 ----
if ! command -v cron >/dev/null 2>&1; then
  (sudo apt-get update -qq >/dev/null 2>&1 && sudo apt-get install -y -qq cron >/dev/null 2>&1) || true
fi
if command -v crontab >/dev/null 2>&1; then
  (crontab -l 2>/dev/null | grep -v 'series-hunter-autostart'; echo "@reboot /bin/bash /workspaces/series-hunter/deploy/autostart.sh # series-hunter-autostart") | crontab - 2>/dev/null || true
  pgrep -x cron >/dev/null 2>&1 || (sudo cron >/dev/null 2>&1 || sudo /usr/sbin/cron >/dev/null 2>&1 || true)
  echo "=== 开机自启 ==="; crontab -l 2>/dev/null | grep series-hunter-autostart || echo "未写入 crontab"
fi
echo "=== node ==="; command -v node || echo "NO_NODE_BIN"; node -v 2>&1 || true

need_restart=0

# ---- 0.5) 保证 VS Code Server 在跑（GitHub 的端口检测依赖它）----
if ! pgrep -f "vscode-server|server-main" >/dev/null 2>&1; then
  if command -v code >/dev/null 2>&1; then
    echo "=== 动作：启动 VS Code Server（端口转发依赖它）==="
    setsid nohup code --server --host 0.0.0.0 --port 3000 --without-connection-token \
      > /tmp/vscode-server.log 2>&1 < /dev/null &
    sleep 10
    pgrep -af "server-main|vscode-server" | head -3 | cut -c1-100 || echo "启动未成功"
  else
    echo "=== 容器内没有 code CLI，无法自启 VS Code Server ==="
  fi
fi

# ---- 0.6) 容器自建公网隧道（绕开 GitHub 端口中继）----
tunnel_up() {
  [ -f /tmp/tunnel-url ] || return 1
  local u; u="$(cat /tmp/tunnel-url 2>/dev/null)"
  [ -n "$u" ] || return 1
  curl -fsS -o /dev/null -m 12 "${u}/api/health" 2>/dev/null
}
if ! tunnel_up; then
  if command -v ssh >/dev/null 2>&1; then
    echo "=== 动作：建立容器公网隧道 ==="
    pkill -f "serveo.net" 2>/dev/null || true
    sleep 2
    : > /tmp/tunnel.log
    setsid nohup ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=20 -o ExitOnForwardFailure=no \
      -R 80:localhost:"${PORT}" serveo.net > /tmp/tunnel.log 2>&1 < /dev/null &
    for i in $(seq 1 25); do
      sleep 2
      u="$(tr -d '\r' < /tmp/tunnel.log 2>/dev/null | grep -oE 'https://[a-z0-9.-]*serveousercontent\.com' | tail -1)"
      if [ -n "$u" ]; then
        echo "$u" > /tmp/tunnel-url
        echo "隧道就绪：$u"
        break
      fi
    done
    [ -f /tmp/tunnel-url ] || echo "隧道建立失败（稍后重试）"
  fi
else
  echo "=== 隧道已在运行：$(cat /tmp/tunnel-url 2>/dev/null) ==="
fi

# ---- 1) 拉取最新代码 ----
before="$(git rev-parse HEAD 2>/dev/null)"
# 强制同步到远端最新（pull 在 Codespaces 里不一定生效）
git fetch origin main >/tmp/git-fetch.log 2>&1
if git reset --hard origin/main >/dev/null 2>&1; then
  after="$(git rev-parse HEAD 2>/dev/null)"
  echo "=== git sync === ${after:0:7} $(git log -1 --pretty=%s 2>/dev/null)"
else
  after="$before"
  echo "=== git sync 失败 ==="; tail -2 /tmp/git-fetch.log
fi
if [ "$before" != "$after" ]; then
  echo ">>> 代码有更新（${before:0:7} → ${after:0:7}）"
fi
# 进程启动时的版本（缺失说明进程由别的方式拉起，一律按需重启）
app_head="$(cat /tmp/app-commit 2>/dev/null || echo none)"
if [ "$after" != "$app_head" ]; then
  echo ">>> 运行中的版本是 ${app_head:0:7}，磁盘上是 ${after:0:7} → 需要重启应用"
  need_restart=1
fi

# ---- 2) 确保 yt-dlp 可用 ----
ytdlp_ok() { /usr/local/bin/yt-dlp --version >/dev/null 2>&1; }
if ! ytdlp_ok; then
  if [ -x "$HOME/.local/bin/yt-dlp" ]; then
    sudo ln -sf "$HOME/.local/bin/yt-dlp" /usr/local/bin/yt-dlp 2>/dev/null || true
  elif command -v yt-dlp >/dev/null 2>&1; then
    sudo ln -sf "$(command -v yt-dlp)" /usr/local/bin/yt-dlp 2>/dev/null || true
  else
    echo ">>> 安装 yt-dlp …"
    pip3 install --quiet --break-system-packages -U yt-dlp 2>/dev/null \
      || pip3 install --quiet -U yt-dlp 2>/dev/null \
      || curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp 2>/dev/null \
      || true
    [ -x "$HOME/.local/bin/yt-dlp" ] && sudo ln -sf "$HOME/.local/bin/yt-dlp" /usr/local/bin/yt-dlp 2>/dev/null || true
  fi
  ytdlp_ok || python3 -c "import yt_dlp" >/dev/null 2>&1
  echo "yt-dlp: $(/usr/local/bin/yt-dlp --version 2>/dev/null | head -1 || echo '走 python3 -m yt_dlp 兜底')"
  need_restart=1
fi

# ---- 3) 需要时重启应用 ----
if [ "$need_restart" = "1" ] && pgrep -f "server/index.js" >/dev/null 2>&1; then
  echo "=== 动作：重启应用进程 ==="
  pkill -f "server/index.js" || true
  sleep 3
fi

# ---- 4) 应用不在就启动（PROBE_ONLY=1 时只观察不启动） ----
if [ "${PROBE_ONLY:-0}" = "1" ]; then
  echo "=== 探针模式：不启动，只报告 ==="
elif ! pgrep -f "server/index.js" >/dev/null 2>&1; then
  echo "=== 动作：启动应用 ==="
  mkdir -p ./downloads
  PORT="$PORT" HOST=0.0.0.0 DOWNLOAD_DIR="$APP_DIR/downloads" CORS_ORIGIN="${CORS_ORIGIN:-*}" \
    setsid nohup bash .devcontainer/run.sh > /tmp/series-hunter.log 2>&1 < /dev/null &
  sleep 6
fi
git rev-parse HEAD > /tmp/app-commit 2>/dev/null || true

echo "=== yt-dlp 现状 ==="
ls -la /usr/local/bin/yt-dlp /usr/bin/yt-dlp "$HOME/.local/bin/yt-dlp" 2>&1 | head -4
echo -n "wrapper版本: "; head -3 "$APP_DIR/tools/yt-dlp" 2>&1 | tr '\n' ' '; echo
echo -n "直接执行wrapper: "; bash "$APP_DIR/tools/yt-dlp" --version 2>&1 | head -1
echo -n "python导入: "; python3 -c "import yt_dlp; print('OK', yt_dlp.version.__version__)" 2>&1 | head -1
echo -n "pip路径: "; python3 -m pip --version 2>&1 | head -1
echo "=== 容器内是否有 vscode-server（端口检测靠它）==="
ps aux | grep -E "[v]scode-server|[c]ode-server|[n]ode .*server-main|[s]shd" | head -5 | cut -c1-120 || true
echo "--- vscode-server 安装位置 ---"
ls -d "$HOME"/.vscode-server/bin/*/ 2>/dev/null | head -3
ls "$HOME"/.vscode-server/bin/*/bin/ 2>/dev/null | head -8
which code code-server 2>/dev/null
ls /usr/local/bin 2>/dev/null | head -12
ls -d /usr/local/share/codespaces /opt/codespaces 2>/dev/null
ls /usr/local/share 2>/dev/null | head -8
echo "--- 全部监听端口 ---"; (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | head -12
echo "=== 隧道地址 ==="; cat /tmp/tunnel-url 2>/dev/null || echo "NO_TUNNEL"
echo "=== 应用进程 ==="; pgrep -af "server/index.js" || echo "NO_APP_PROCESS"
echo "=== 监听端口 ==="; (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E "8787|Local" | head -6 || echo "NO_SS"
echo "=== 本机自检 ==="
printf "root="; curl -s -o /dev/null -m 8 -w "%{http_code}" "http://127.0.0.1:${PORT}/" 2>/dev/null; echo
printf "appjs="; curl -s -o /dev/null -m 8 -w "%{http_code}" "http://127.0.0.1:${PORT}/app.js" 2>/dev/null; echo
printf "health="; curl -s -m 8 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | head -c 200; echo
echo "=== 日志尾部 ==="; tail -n 8 /tmp/series-hunter.log 2>/dev/null || echo "NO_LOG"
