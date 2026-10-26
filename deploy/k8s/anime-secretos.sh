#!/usr/bin/env bash
# Crea (o actualiza) los secretos de Estudio Anime en el clúster sin imprimir su contenido:
#   anime-env  → claves de .env que necesita la app (voz, búsqueda, YouTube, Buffer, Telegram y modelo de Codex)
#   anime-warp → configuración WireGuard de la cuenta Cloudflare WARP (sin la línea Address: `wg setconf` no la acepta)
# Uso (desde la raíz del repo): bash deploy/k8s/anime-secretos.sh /ruta/a/wg0.conf
set -euo pipefail
WG=${1:?Falta la ruta del wg0.conf de WARP}
export KUBECONFIG=${KUBECONFIG:-$HOME/contabo-k3s.yml}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT; chmod 700 "$tmp"

grep -E '^(ELEVENLABS_API_KEY|BRAVE_API_KEY|YOUTUBE_ANALYTICS_CLIENT_ID|YOUTUBE_ANALYTICS_CLIENT_SECRET|YOUTUBE_ANALYTICS_REFRESH_TOKEN|CODEX_MODEL|BUFFER_API_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)=' .env > "$tmp/anime.env"
kubectl -n estudio-futbol create secret generic anime-env --from-env-file="$tmp/anime.env" --dry-run=client -o yaml | kubectl apply -f -

grep -v '^Address' "$WG" > "$tmp/wg0.conf"
kubectl -n estudio-futbol create secret generic anime-warp --from-file=wg0.conf="$tmp/wg0.conf" --dry-run=client -o yaml | kubectl apply -f -

echo "Claves en anime-env: $(cut -d= -f1 "$tmp/anime.env" | tr '\n' ' ')"
