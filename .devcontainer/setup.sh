#!/usr/bin/env bash
# Codespaces 容器初始化：装 Node 依赖、yt-dlp、ffmpeg，准备好下载目录
set -euo pipefail

echo "==> 安装系统依赖"
sudo apt-get update -qq
sudo apt-get install -y -qq ffmpeg python3 python3-pip curl >/dev/null

echo "==> 安装 yt-dlp"
pip3 install --quiet --break-system-packages -U yt-dlp 2>/dev/null || pip3 install --quiet -U yt-dlp
command -v yt-dlp >/dev/null 2>&1 || sudo curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp
sudo chmod +x /usr/local/bin/yt-dlp

echo "==> 准备目录"
mkdir -p /workspace/series-hunter/downloads

echo "==> 环境自检"
cd /workspace/series-hunter
node -v
yt-dlp --version
ffmpeg -version | head -1
echo "==> 初始化完成"
