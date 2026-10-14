# Estudio de fútbol en contenedor. Se construye desde la raíz del repo (usa lib/ y public/js/ del estudio principal):
#   docker compose up --build   → http://localhost:4322
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# clips de YouTube (yt-dlp), recorte del jugador para miniaturas (rembg) y alineación de la voz (faster-whisper)
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir faster-whisper numpy yt-dlp "rembg[cpu]"
# motores de IA: Claude Code y, de respaldo, Codex CLI
RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force

WORKDIR /app
# cliente de Postgres (única dependencia npm)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY lib lib
COPY public/js public/js
COPY futbol futbol
# carpetas de datos (volúmenes) con dueño "node" para que el volumen nazca con esos permisos
RUN mkdir -p futbol/projects .secrets /home/node/.cache && chown -R node:node futbol/projects .secrets /home/node/.cache

ENV HOST=0.0.0.0 PORT=4322 IMG_PYTHON=/opt/venv/bin/python ALIGN_PYTHON=/opt/venv/bin/python YTDLP_BIN=/opt/venv/bin/yt-dlp U2NET_HOME=/home/node/.cache/rembg
USER node
EXPOSE 4322
CMD ["node", "futbol/server.js"]
