# Estudio Anime en contenedor. Se construye desde la raíz del repo (usa lib/, public/js/ y scripts/ compartidos):
#   docker build -f anime/Dockerfile .   → puerto 4324
FROM node:24-bookworm-slim

# aria2: episodios exactos de nyaa (Top 10). Sin Real-ESRGAN: sin GPU tardaba >10 min por imagen; las imágenes se amplían con lanczos
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates aria2 \
 && rm -rf /var/lib/apt/lists/*
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

ENV HOST=0.0.0.0 PORT=4324 ALIGN_PYTHON=/opt/venv/bin/python YTDLP_BIN=/opt/venv/bin/yt-dlp
USER node
EXPOSE 4324
CMD ["node", "anime/server.js"]
