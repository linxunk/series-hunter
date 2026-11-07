#!/usr/bin/env bash
# 剧集猎人 · 环境安装脚本
# 安装 yt-dlp（下载引擎）与 ffmpeg（音视频合并），并检查运行环境。
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*"; }
info() { echo -e "${BLUE}→${NC} $*"; }

echo "=============================================="
echo "  剧集猎人 · 环境安装"
echo "=============================================="

# ---------- Node.js ----------
if ! command -v node >/dev/null 2>&1; then
  err "未检测到 Node.js，请先安装 Node.js 18+（https://nodejs.org）"
  exit 1
fi
ok "Node.js $(node -v)"

# ---------- yt-dlp ----------
install_ytdlp() {
  info "正在安装 yt-dlp ..."
  if command -v pip3 >/dev/null 2>&1; then
    pip3 install -q --upgrade yt-dlp || true
  fi
  if ! command -v yt-dlp >/dev/null 2>&1; then
    local arch
    arch="$(uname -m)"
    case "$arch" in
      x86_64|amd64) arch=amd64 ;;
      aarch64|arm64) arch=arm64 ;;
    esac
    local url="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux"
    if [[ "$(uname -s)" == "Darwin" ]]; then
      url="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
    fi
    curl -fsSL "$url" -o /usr/local/bin/yt-dlp || {
      err "yt-dlp 下载失败，请手动安装：https://github.com/yt-dlp/yt-dlp#installation"
      return 1
    }
    chmod +x /usr/local/bin/yt-dlp
  fi
}

if command -v yt-dlp >/dev/null 2>&1; then
  ok "yt-dlp $(yt-dlp --version)"
else
  install_ytdlp && ok "yt-dlp $(yt-dlp --version)" || warn "yt-dlp 安装未完成，可稍后手动安装"
fi

# ---------- ffmpeg ----------
if command -v ffmpeg >/dev/null 2>&1; then
  ok "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3)"
else
  warn "未检测到 ffmpeg，音视频将无法自动合并（可安装：apt install ffmpeg / brew install ffmpeg）"
fi

# ---------- 目录 ----------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/downloads" "$ROOT/config"
ok "下载目录 $ROOT/downloads"

echo
echo "=============================================="
echo "  安装完成，启动服务："
echo "    cd $ROOT && npm start"
echo "  然后浏览器打开： http://localhost:8787"
echo "=============================================="
