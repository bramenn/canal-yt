# Estudio Cómic en contenedor. Se construye desde la raíz del repo (usa lib/, public/js/ y scripts/ compartidos):
#   docker build -f comic/Dockerfile .   → puerto 4323
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# audio del episodio (yt-dlp) y transcripción con el tiempo de cada palabra (faster-whisper)
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir faster-whisper yt-dlp
# IA: Claude Code (relatos y guion) y Codex CLI (viñetas con la cuenta de ChatGPT)
RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY lib lib
COPY public/js public/js
COPY scripts scripts
COPY comic comic
RUN mkdir -p comic/projects .secrets /home/node/.cache && chown -R node:node comic/projects .secrets /home/node/.cache

ENV HOST=0.0.0.0 PORT=4323 ALIGN_PYTHON=/opt/venv/bin/python YTDLP_BIN=/opt/venv/bin/yt-dlp
USER node
EXPOSE 4323
CMD ["node", "comic/server.js"]
