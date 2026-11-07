# 剧集猎人 · 运行镜像
FROM node:20-bookworm-slim

# yt-dlp / ffmpeg / python3-pip（yt-dlp 需要 Python）
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg python3 python3-pip tzdata \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages -U yt-dlp \
    && ln -sf "$(command -v yt-dlp)" /usr/local/bin/yt-dlp

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY web ./web
COPY config ./config
COPY tools ./tools
COPY README.md ./

# 下载目录挂载点（建议挂到宿主机 /data）
ENV DOWNLOAD_DIR=/data/downloads \
    PORT=8787 \
    HOST=0.0.0.0 \
    NODE_ENV=production \
    TZ=Asia/Shanghai

RUN mkdir -p /data/downloads && chown -R node:node /app /data
VOLUME ["/data"]

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

CMD ["node", "server/index.js"]
