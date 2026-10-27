# Estudio Anime en contenedor. Se construye desde la raíz del repo (usa lib/, public/js/ y scripts/ compartidos):
#   docker build -f anime/Dockerfile .   → puerto 4324
FROM node:24-bookworm-slim

# aria2: episodios exactos de nyaa (Top 10); mesa-vulkan-drivers: Vulkan por CPU para Real-ESRGAN (el servidor no tiene GPU);
# chromium: cifras de los reels de Facebook e Instagram
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates aria2 mesa-vulkan-drivers libgomp1 unzip curl chromium \
 && rm -rf /var/lib/apt/lists/*
# ampliar miniaturas ×4 (misma versión que en el portátil)
RUN curl -fsSL -o /tmp/esrgan.zip https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip \
 && mkdir -p /opt/realesrgan && unzip -q /tmp/esrgan.zip -d /opt/realesrgan && chmod +x /opt/realesrgan/realesrgan-ncnn-vulkan && rm /tmp/esrgan.zip
# tráileres de YouTube (yt-dlp) y alineación de la voz (faster-whisper)
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir faster-whisper yt-dlp
# IA: Codex CLI (predeterminado; Claude Code queda disponible como alternativa)
RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY lib lib
COPY public/js public/js
COPY scripts scripts
COPY anime anime
RUN mkdir -p anime/projects .secrets /home/node/.cache && chown -R node:node anime/projects .secrets /home/node/.cache

ENV HOST=0.0.0.0 PORT=4324 ALIGN_PYTHON=/opt/venv/bin/python YTDLP_BIN=/opt/venv/bin/yt-dlp REALESRGAN_BIN=/opt/realesrgan/realesrgan-ncnn-vulkan CHROMIUM_BIN=/usr/bin/chromium
USER node
EXPOSE 4324
CMD ["node", "anime/server.js"]
