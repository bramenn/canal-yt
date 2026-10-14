# Estudio Fútbol y Estudio Cómic en el k3s de Contabo

https://ft.bramen.org (fútbol) y https://comic.bramen.org (cómic) · namespace `estudio-futbol` · `export KUBECONFIG=~/contabo-k3s.yml`

Dos apps separadas (`futbol/` y `comic/`) con lo común en `lib/`: comparten Postgres (mismos usuarios; tablas `projects` y `comics`) y el disco `estudio-data` (cada una su carpeta de proyectos; misma sesión de ChatGPT/Codex y claves).

- **Imágenes**: la acción «Imagen» (`.github/workflows/imagen.yml`) construye `ghcr.io/bramenn/estudio-futbol` y `ghcr.io/bramenn/estudio-comic` con la etiqueta `<commit>` (SHA **completo**) y `:latest`.
- **Ingress** nginx sin TLS: Cloudflare (registros `ft` y `comic` CNAME → `bramen.org`, proxied) pone el https.
- **Datos**: Postgres (`db-0`, PVC 5Gi) y un PVC `estudio-data` (40Gi) con fotos/clips/voz/MP4, claves de Ajustes, modelos (Whisper, rembg) y las sesiones de Codex y Claude Code.

## Primera vez (ya hecho)

```bash
kubectl create namespace estudio-futbol
PW=$(openssl rand -hex 24)
kubectl -n estudio-futbol create secret generic futbol-db \
  --from-literal=POSTGRES_PASSWORD="$PW" \
  --from-literal=DATABASE_URL="postgres://futbol:$PW@db.estudio-futbol.svc.cluster.local:5432/futbol"
# credencial de GHCR (copiada de otro namespace) para descargar la imagen
kubectl -n contraste get secret ghcr-pull -o json | jq '{apiVersion,kind,type,data,metadata:{name:"ghcr-pull",namespace:"estudio-futbol"}}' | kubectl apply -f -
kubectl apply -f deploy/k8s/estudio-futbol.yaml
kubectl apply -f deploy/k8s/estudio-comic.yaml
```

## Usuarios

```bash
kubectl -n estudio-futbol exec -it deploy/estudio-futbol -c app -- node scripts/user.js add <usuario> --admin
kubectl -n estudio-futbol exec -it deploy/estudio-futbol -c app -- node scripts/user.js list   # passwd / del
```

## Actualizar a la última imagen

```bash
# <commit> = SHA completo (git rev-parse HEAD); esperar a que termine la acción «Imagen»
kubectl -n estudio-futbol set image deploy/estudio-futbol app=ghcr.io/bramenn/estudio-futbol:<commit>
kubectl -n estudio-futbol set image deploy/estudio-comic app=ghcr.io/bramenn/estudio-comic:<commit>
kubectl -n estudio-futbol rollout status deploy/estudio-futbol deploy/estudio-comic
```

## Copia de seguridad de la base de datos

```bash
kubectl -n estudio-futbol exec db-0 -- pg_dump -U futbol futbol | gzip > estudio-futbol-$(date +%F).sql.gz
```
