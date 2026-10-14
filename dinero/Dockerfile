# Estudio Dinero en contenedor. Se construye desde la raíz del repo (usa lib/, public/js/ y scripts/ compartidos):
#   docker build -f dinero/Dockerfile .   → puerto 4325
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# cifras de YouTube/TikTok (yt-dlp) y alineación de la voz (faster-whisper)
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir faster-whisper yt-dlp
# IA: Claude Code (historias y guion) y, de respaldo, Codex CLI
RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY lib lib
COPY public/js public/js
COPY scripts scripts
COPY dinero dinero
RUN mkdir -p dinero/projects .secrets /home/node/.cache && chown -R node:node dinero/projects .secrets /home/node/.cache

ENV HOST=0.0.0.0 PORT=4325 ALIGN_PYTHON=/opt/venv/bin/python YTDLP_BIN=/opt/venv/bin/yt-dlp
USER node
EXPOSE 4325
CMD ["node", "dinero/server.js"]
