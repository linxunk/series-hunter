#!/usr/bin/env bash
# =============================================================
#  剧集猎人 · 一键部署到 Linux 服务器（Ubuntu / Debian / CentOS）
#  用法：  bash deploy/deploy.sh [安装目录] [端口]
#  示例：  bash deploy/deploy.sh /opt/series-hunter 8787
#  说明：  自动安装 Node.js / yt-dlp / ffmpeg，注册 systemd 开机自启，
#         并可选配置 nginx 反向代理 + HTTPS（需已解析到本机的域名）。
# =============================================================
set -euo pipefail

APP_DIR="${1:-/opt/series-hunter}"
PORT="${2:-8787}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOMAIN="${DOMAIN:-}"            # 例： hunter.example.com，留空则只监听端口
USE_NGINX="${USE_NGINX:-auto}"  # auto | yes | no
ENABLE_HTTPS="${ENABLE_HTTPS:-no}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*"; }
info() { echo -e "${BLUE}→${NC} $*"; }

[[ $EUID -eq 0 ]] || { err "请用 root 执行：sudo bash deploy/deploy.sh"; exit 1; }

echo "=============================================="
echo "  剧集猎人 · 服务器部署"
echo "  安装目录: $APP_DIR    端口: $PORT"
echo "=============================================="

# ---------- 1. 系统依赖 ----------
info "安装系统依赖 ..."
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates ffmpeg python3 python3-pip nginx >/dev/null 2>&1 || true
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y -q curl ca-certificates ffmpeg python3 python3-pip nginx >/dev/null 2>&1 || true
elif command -v yum >/dev/null 2>&1; then
  yum install -y -q curl ca-certificates ffmpeg python3 python3-pip nginx >/dev/null 2>&1 || true
fi

# ---------- 2. Node.js 20 ----------
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | tr -d 'v' | cut -d. -f1)" -lt 18 ]]; then
  info "安装 Node.js 20 …"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null 2>&1
  else
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    yum install -y -q nodejs >/dev/null 2>&1
  fi
fi
ok "Node.js $(node -v)"

# ---------- 3. yt-dlp ----------
if ! command -v yt-dlp >/dev/null 2>&1; then
  info "安装 yt-dlp …"
  pip3 install -q --upgrade --break-system-packages yt-dlp 2>/dev/null \
    || pip3 install -q --upgrade yt-dlp 2>/dev/null \
    || {
      curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp
      chmod +x /usr/local/bin/yt-dlp
    }
fi
ok "yt-dlp $(yt-dlp --version)"

# ---------- 4. 拷贝应用 ----------
info "部署应用文件到 $APP_DIR …"
mkdir -p "$APP_DIR"
for f in server web config tools package.json README.md Dockerfile docker-compose.yml; do
  [ -e "$SRC_DIR/$f" ] && cp -r "$SRC_DIR/$f" "$APP_DIR/"
done
mkdir -p "$APP_DIR/downloads"
chmod +x "$APP_DIR/tools/install.sh" 2>/dev/null || true
ok "应用文件就位"

# ---------- 5. systemd ----------
info "注册 systemd 服务 …"
cat > /etc/systemd/system/series-hunter.service <<UNIT
[Unit]
Description=SeriesHunter 剧集猎人
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=HOST=0.0.0.0
Environment=DOWNLOAD_DIR=$APP_DIR/downloads
Environment=TZ=Asia/Shanghai
ExecStart=$(command -v node) $APP_DIR/server/index.js
Restart=always
RestartSec=5
StandardOutput=append:/var/log/series-hunter.log
StandardError=append:/var/log/series-hunter.log

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable series-hunter >/dev/null 2>&1
systemctl restart series-hunter
sleep 2
ok "systemd 服务已启动（systemctl status series-hunter）"

# ---------- 6. 防火墙 ----------
if command -v ufw >/dev/null 2>&1; then
  ufw allow "$PORT/tcp" >/dev/null 2>&1 || true
  ok "ufw 已放行 $PORT"
fi

# ---------- 7. nginx 反代 ----------
if [[ "$USE_NGINX" == "yes" || ( "$USE_NGINX" == "auto" && -n "$DOMAIN" ) ]]; then
  if [[ -z "$DOMAIN" ]]; then
    err "启用 nginx 需要提供域名：DOMAIN=hunter.example.com bash deploy/deploy.sh"
  else
    info "配置 nginx 反向代理 → $DOMAIN …"
    cat > /etc/nginx/conf.d/series-hunter.conf <<NGINX
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 0;
    proxy_buffering off;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX
    nginx -t >/dev/null 2>&1 && { systemctl reload nginx || systemctl restart nginx; ok "nginx 已配置"; } || warn "nginx 配置校验失败，请手动检查 /etc/nginx/conf.d/series-hunter.conf"
  fi
fi

# ---------- 8. HTTPS ----------
if [[ "$ENABLE_HTTPS" == "yes" && -n "$DOMAIN" ]]; then
  if command -v certbot >/dev/null 2>&1; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "${EMAIL:-admin@example.com}" --redirect || warn "certbot 签发失败"
  else
    warn "未安装 certbot，跳过 HTTPS；可执行：apt install certbot python3-certbot-nginx"
  fi
fi

# ---------- 9. 健康检查 ----------
sleep 1
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  ok "健康检查通过：http://127.0.0.1:$PORT/api/health"
else
  warn "健康检查未通过，请查看日志：tail -f /var/log/series-hunter.log"
fi

IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
echo
echo "=============================================="
echo "  部署完成 🎬"
echo "  本机访问： http://127.0.0.1:$PORT"
echo "  局域网/公网： http://$IP:$PORT"
[[ -n "$DOMAIN" ]] && echo "  域名访问： http://$DOMAIN"
echo
echo "  常用命令："
echo "    systemctl status series-hunter   # 查看状态"
echo "    systemctl restart series-hunter  # 重启"
echo "    tail -f /var/log/series-hunter.log   # 看日志"
echo "    ls -lh $APP_DIR/downloads         # 已下载文件"
echo "=============================================="
