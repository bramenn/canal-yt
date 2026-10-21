# Bramenn Studio

Estudio local para el canal: descubre temas, escribe guiones con **Claude Code** en el estilo estudiado del canal de referencia,
los anima en un motor propio (canvas) y te da un **teleprompter** que graba tu voz y el vídeo sincronizados.

```bash
npm start          # → http://localhost:4321
```

Requisitos: Node 20+ y Claude Code (`claude`) con sesión iniciada. Sin dependencias npm.
Opcional: `yt-dlp` para estudiar más canales (ya hay uno en `.tools/venv`).

## Flujo
1. **Descubrir** · Claude Code busca en la web qué ha pasado esta semana y propone temas con título, gancho, datos, fuentes y miniatura.
2. **Estudio** · genera el guion completo (narración + escenas sincronizadas por frase). Lo editas, cambias escenas (16 tipos) o pides reescrituras a la IA. Estilos visuales: *Infografía* o *Pizarra*.
3. **Teleprompter** · cuenta atrás, texto que avanza palabra a palabra al ritmo de lectura, y grabación de **vídeo animado + tu micro** (MP4/WebM) y voz aparte. `Espacio` pausa, `←/→` segmento, `↑/↓` velocidad.
4. **Miniatura** · 3 composiciones del canal, editables, exporta PNG 1280×720.
**Voz IA (opcional)** · en el Estudio, botón **Voz IA**: elige **Fish Audio** o **ElevenLabs**, pega tu API key, escucha las voces (muestra gratis o «Probar» con tu frase) y genera. Se crea un audio por segmento y las escenas se sincronizan con su duración real. Claude Code puede adaptar antes cifras y siglas para que se lean bien. **Exportar vídeo** incluye la voz, y puedes bajarla sola en WAV. Las claves se guardan en `.secrets/<proveedor>.json` (o usa `FISH_API_KEY` / `ELEVENLABS_API_KEY`). Código en `lib/tts/` (un módulo por proveedor).
**Sonido (opcional)** · botón **Sonido** en el Estudio: efectos sincronizados con la imagen (transición, elemento, rótulo, golpe, resultado, teclado) y música de fondo con ducking, desde Freesound (CC0 por defecto; CC BY con créditos automáticos) o archivos propios. Reglas y fuentes en `style/sonido.md`. Exporta la mezcla o las pistas por separado en WAV.
**Sincronía guion · voz · animación** · cada segmento muestra si está sincronizado. «Sincronizar segmento» / «Sincronizar todo» recoloca las anclas que movió una edición, regenera la voz desactualizada y la **alinea palabra a palabra** con Whisper local (`lib/align/`, faster-whisper en `.tools/venv`), así que escenas, elementos y rótulos caen en el instante real en que se dicen. También avisa de palabras que la voz pudo pronunciar mal.
**Publicar** · pestaña 07: Claude Code propone 5 títulos que complementan la miniatura (se comprueba que no repitan sus palabras y se avisa si pasan de ~65 caracteres), descripción con capítulos calculados con los tiempos reales (reglas de YouTube: 00:00, ≥3, ≥10 s), fuentes, créditos de sonido, etiquetas (≤500), hashtags y comentario fijado. Todo con botones de copiar.
**Shorts** · en Publicar: Claude Code elige 3-5 momentos de 20-55 s que se entienden solos (gancho al inicio, remate al final) y la app los exporta en 9:16 (1080×1920) con la escena, subtítulos grandes palabra a palabra, gancho en pantalla y «vídeo completo» al final; cada uno con título, descripción y hashtags para copiar.
5. **Estilo** · la biblia de estilo (`style/estilo.md`) y las transcripciones de referencia. Puedes descargar más y pedir a Claude Code que reanalice.

## Estudio de fútbol (`futbol/`)
App aparte para vídeos tipo «La Garza»: biografías narradas (5-8 min) sobre fotos reales con zoom lento y fundido, sin rótulos.
```bash
npm run futbol     # → http://localhost:4322 (carga .env: DATABASE_URL y claves)
```
- **Guion** · Claude Code investiga y escribe en el estilo de `futbol/style/estilo.md` (estudiado de las transcripciones de `futbol/style/referencias/`). Cada segmento lleva sus **planos**: `cue` (palabras donde entra), qué se ve y una búsqueda.
- **Fotos** · «Buscar fotos que faltan» rellena cada plano con el primer resultado descargable (API de Brave; se descartan bancos con marca de agua). En cada plano puedes buscar y elegir otra, pegar una URL o subir un archivo. Los créditos de cada sitio van a la descripción.
- **Clips** · botón «Clip» en cada plano: busca en YouTube, enseña los momentos más vistos (🔥) y una tira de miniaturas del vídeo (sirve aunque el vídeo no se deje ver incrustado) y recorta el trozo elegido a 1080p sin sonido (`futbol/lib/clips.js`, yt-dlp + ffmpeg).
- **Transiciones** · por plano o automáticas: fundido, paso a negro al cambiar de sección, zoom con desenfoque, barrido con desenfoque de movimiento, destello o corte. Viñeta y grano de película suaves en todo el vídeo.
- **Voz y MP4** · reutiliza `lib/tts`, `lib/align` y `lib/export`: un audio por segmento alineado con Whisper, así cada foto cambia en la palabra exacta.
- Requisitos extra: `pip install yt-dlp` en `.tools/venv` (o `IMG_PYTHON=/ruta/python`). Para las fotos hace falta la clave de api.search.brave.com en la app o `BRAVE_API_KEY`.
- **Login y Postgres** · la app pide usuario y contraseña (scrypt, sesiones en cookie HttpOnly, bloqueo tras 5 fallos, comprobación de origen). Usuarios, sesiones, proyectos y ajustes viven en Postgres (`DATABASE_URL`, contenedor `futbol-db` en 127.0.0.1:5433); fotos, clips y audio siguen en disco. No hay registro público: `npm run user -- add <usuario> [--admin]` (también `passwd`, `list`, `del`), o el administrador desde ⚙ Ajustes. Los vídeos son compartidos; solo el administrador cambia claves y motor de IA.
- **Guion propio** · en el inicio, «📝 Ya tengo el guion»: el texto se divide en partes sin IA y se usa tal cual; la IA solo elige las imágenes de cada frase, la miniatura y los títulos.
- **Abrir en CapCut** · paso «Publicar»: crea un proyecto de CapCut (CapCutAPI) con las imágenes, los clips, las transiciones, la voz y subtítulos opcionales. En Windows se escribe directamente en la carpeta de proyectos de CapCut; en Linux se importa en el CapCut de Wine con `import-draft.sh`. Siempre queda además un ZIP.
- **Credenciales** · en ⚙ Ajustes: Claude (token de `claude setup-token` o API key), OpenAI/Codex, ElevenLabs, Brave y la carpeta de CapCut. Se guardan en `.secrets/` de ese ordenador.
- **Motor de IA** · Claude Code o Codex CLI (`lib/codex.js`). En ⚙ Ajustes: «Automático» (por defecto) usa Claude Code y, si falla —límite de uso, sesión caducada…—, repite la tarea con Codex; o fija uno. Codex necesita `codex login` (o `CODEX_API_KEY`). También con `AI_ENGINE=auto|claude|codex`.
- **Con Docker**: `cp .env.example .env`, pon `CLAUDE_CODE_OAUTH_TOKEN` (sale de `claude setup-token`) o `ANTHROPIC_API_KEY`, y `docker compose up --build` (o `podman-compose up --build`). La imagen trae Node, ffmpeg, Claude Code y faster-whisper; proyectos, claves y el modelo de Whisper viven en volúmenes. Los MP4 se descargan desde el navegador al exportar.
- Proyectos, audio, fotos y exportaciones en `futbol/projects/` (fuera de git). Las claves de voz se comparten con el estudio principal (`.secrets/`).


## Estudio Cómic (`comic/`)

App aparte (no comparte código con fútbol salvo `lib/`): de un episodio de podcast de YouTube (relatos, entrevistas, true crime) salen shorts verticales para TikTok con la voz original y el relato dibujado como novela gráfica noir.

```bash
npm run comic      # → http://localhost:4323 (mismos usuarios y Postgres que fútbol)
```

- **Preparar** · descarga el audio (yt-dlp), transcribe con Whisper (tiempo de cada palabra), la IA elige 3-6 relatos de 25-75 s con su gancho y texto para TikTok, y escribe el guion de viñetas de cada uno con un reparto fijo para todo el episodio (`comic/lib/podcast.js`).
- **Dibujar** · cada viñeta con la herramienta de imágenes de Codex y la cuenta de ChatGPT (hace falta plan de pago, p. ej. Plus; ~1 min por viñeta). La primera viñeta sirve de referencia para que el protagonista sea el mismo en todas (`comic/lib/comicart.js`).
- **Miniatura** · «🖼 Hacer miniatura» en cada short: Codex dibuja una portada noir con el protagonista (una viñeta de referencia) y el texto de gancho se pone a 4K (`comic/lib/cover.js`, `lib/thumbnail.js`). Es también el primer fotograma (0,3 s) del MP4; se descarga en 4K y en 1080×1920 para YouTube.
- **MP4 vertical** · 1080×1920 con marco de cómic, gancho arriba y subtítulos palabra a palabra (`comic/public/comic.js`), exportado en el navegador.
- **Común en `lib/`** · `db.js` (Postgres; los episodios van en la tabla `comics`), `auth.js` y `web.js` (login, sesión, usuarios, estáticos), `store.js` (archivos), `claude.js`/`codex.js` (IA), `export.js`. Usuarios: `npm run user -- add <usuario> [--admin]` (`scripts/user.js`).

## Estudio Dinero (`dinero/`)

App aparte: shorts de historias de dinero y negocios en automático (fórmula de Emprende Aprendiendo / MagnatesMedia / Logically Answered), solo shorts, en dos versiones (YouTube 35-45 s y TikTok > 1 min).

```bash
npm run dinero     # → http://localhost:4325 (mismos usuarios y Postgres; tabla `dineros`)
```

- **Historias** · reales y verificadas: fracasos y caídas, cómo alguien se hizo rico, decisiones de negocio sorprendentes, actualidad con historia detrás (`dinero/lib/story.js`).
- **Guion** · gancho con el dato de dinero más sorprendente, quién y el problema, cifras, giro, resultado y final en bucle; cada frase dice qué se ve: foto, cifra, titular o gráfica.
- **Motor** · Codex CLI por defecto (sesión de ChatGPT o API key); `AI_ENGINE` permite elegir otro motor y `CODEX_MODEL` fijar un modelo compatible. La cabecera muestra el motor activo.
- **Montaje** · editor IA compartido con Anime: catálogo visual de fotos verificadas, foco del recorte en caras/productos, cortes de ~1,5-3 s en pausas, control de tomas repetidas, revisión visual, acercamientos y efectos suaves (`lib/editor.js`, `dinero/lib/photos.js`, `dinero/lib/montage.js`). Conserva las tarjetas animadas de cifra, titular y gráfica durante los cambios de fondo (`dinero/lib/cards.js`). Miniatura de Codex + texto a 4K como primer fotograma; YouTube y TikTok se guardan en la web para descargar.
- **Cifras, viralidad y aprendizaje** · como en anime (`lib/stats.js`, `lib/virality.js`): las cuentas del canal van en `DINERO_YOUTUBE`, `DINERO_TIKTOK` (secUid) y `DINERO_FACEBOOK`; la marca en `DINERO_BRAND`.

## Estudio Anime (`anime/`)

App aparte: shorts verticales de curiosidades y noticias de anime al estilo de AniDosis, en automático y en español, con la marca @notianimes.

```bash
npm run anime      # → http://localhost:4324 (mismos usuarios y Postgres; tabla `animes`)
```

- **Historias** · la IA busca en la web las noticias y curiosidades de anime con más gancho de los últimos días, sin repetir las ya hechas (`anime/lib/story.js`).
- **Viralidad y aprendizaje** · cada short se compara con la mediana del canal a la misma edad (🔥 despegando, 📈 por encima, 😴 atascado). La IA recibe siempre las señales públicas de los últimos 12 Shorts disponibles, con edad, fuente, fecha y variación entre lecturas reales. Además, con al menos tres vídeos con tres días reportados y 100 engaged views cada uno, compara Analytics: duración y porcentaje visto, interacciones, suscriptores y curva de retención aproximada por frase. Las cifras públicas son provisionales y no se suman a Analytics ni sustituyen métricas privadas ausentes (`lib/virality.js`, `anime/lib/youtube-learning.js`).
- **Cifras** · la lista pública de YouTube (yt-dlp) descubre los IDs; YouTube Data API v3 completa por lotes las vistas, likes, comentarios y fecha de publicación, incluidos los vídeos recientes sin Analytics. Si falla, se mantienen las lecturas públicas disponibles. TikTok usa yt-dlp y Facebook/Instagram Playwright opcional. Cada 30 min se refrescan cifras públicas; las métricas privadas de los Shorts con ID se consultan como máximo cada 12 h mediante YouTube Analytics API v2 (`lib/stats.js`, `lib/youtube-data.js`, `lib/youtube-analytics.js`).
- **Conectar YouTube** · habilita YouTube Analytics API y YouTube Data API v3 en el mismo proyecto de Google Cloud, crea un cliente OAuth de escritorio y añade `YOUTUBE_ANALYTICS_CLIENT_ID` y `YOUTUBE_ANALYTICS_CLIENT_SECRET` a `.env`. Ejecuta `npm run youtube-auth` y autoriza con la cuenta propietaria del canal; el refresh token se guarda en `.env`. El asistente solicita `youtube.readonly` y `yt-analytics.readonly`; ambos servicios reutilizan esa autorización. En una app OAuth externa que sigue en modo Testing, Google caduca los refresh tokens con estos permisos a los 7 días; para mantener una autorización continua, publica la app en Production y completa los pasos de verificación que Google solicite. Más detalles: [YouTube Analytics API](https://developers.google.com/youtube/analytics), [videos.list](https://developers.google.com/youtube/data/reference/rest/v3/videos/list), [reports.query](https://developers.google.com/youtube/analytics/reference/reports/query) y [caducidad de refresh tokens](https://support.google.com/cloud/answer/15549945?hl=es).
- **Dos versiones** · YouTube Shorts (40-50 s, más % visto) y TikTok (61-66 s: TikTok solo paga los vídeos de más de 1 minuto). Comparten historia, tráileres y miniatura; la de TikTok tiene su guion largo, voz y montaje (si sale de menos de 61 s se rehace una vez). En shorts ya hechos: «🎵 Hacer versión TikTok».
- **Guion** · fórmula AniDosis: gancho, «el problema es que…», datos y remate; título con MAYÚSCULAS, palabras a resaltar en amarillo/rojo y qué se ve en cada frase.
- **Voz** · a elegir entre las dos voces del canal (hombre o mujer, de la biblioteca de ElevenLabs), alineada palabra a palabra (Whisper).
- **Miniatura** · ocupa los dos primeros fotogramas (~0,066 s). La IA diseña una composición sobre la historia y elige una referencia del catálogo después de excluir tomas iguales o casi iguales a las portadas anteriores. Codex (image_gen, ChatGPT Plus) conserva la identidad del personaje, con pose y composición nuevas; se comprueba que el dibujo no duplique uno anterior. El texto (2-4 palabras, una en amarillo, en la zona segura de arriba) se pone a 4K (`anime/lib/thumb.js`). Se descarga en 4K (2160×3840) y en 1080×1920 (< 2 MB, para YouTube). Si Codex falla se usa una toma distinta; si no queda ninguna, se avisa en vez de repetirla. «Rehacer miniatura» actualiza YouTube y TikTok y conserva voz y duración.
- **Montaje** · ffmpeg en el servidor (`anime/lib/montage.js`, `lib/editor.js`): un catálogo de escenas del tráiler/PV oficial (sin negros, logos ni créditos) se describe y se asigna con IA a cada frase del guion; corta en pausas cada ~1,5-3 s, evita repetir toma, prioriza el gancho, revisa el montaje y añade punch-in, whoosh y golpe de clímax. Incluye recorte 9:16, imágenes de Brave con desplazamiento, subtítulos ASS de 1-2 palabras en Anton (`lib/fonts`, OFL) y la marca del canal.
En la instalación local con `anime.service` y el contenedor `futbol-db` existente, la base se supervisa por separado con `canal-yt-db.service`. Anime espera hasta 60 s a una consulta SQL mediante `DATABASE_URL`, incluido el puerto publicado del host. Esto evita que una comprobación por el socket interno del contenedor dé por lista una conexión externa que todavía falla. Ambos servicios quedan habilitados para arrancar automáticamente.

Para configurar por primera vez esta supervisión sobre una instalación que ya tiene `anime.service`:

```bash
node scripts/configure-anime-database.js
systemctl --user stop anime.service
podman update --restart=no futbol-db
podman stop --time 10 futbol-db
systemctl --user enable --now canal-yt-db.service
systemctl --user restart anime.service
```

El instalador genera la unidad desde el contenedor existente y guarda el ajuste de Anime en `anime.service.d/20-database.conf`; conserva el volumen de PostgreSQL. Systemd se encarga del reinicio de la base, por lo que el contenedor deja de depender de `podman-restart.service`. Para reinicios habituales basta `systemctl --user restart anime.service`.

## Cómo funciona el motor
- `server.js` lanza `claude -p --output-format stream-json --json-schema …` con un prompt de sistema construido desde `style/estilo.md`. El progreso llega en vivo al panel del motor.
- Al escribir un guion, Claude Code lee transcripciones de `style/referencias/` para calibrar el ritmo, investiga con WebSearch/WebFetch y devuelve JSON validado.
- **Control de originalidad** (`lib/originality.js`): si alguna frase coincide con las referencias (6 palabras seguidas o frases-firma del otro creador), una segunda pasada la reescribe con palabras propias. Se imita el oficio, no las frases.
- `public/js/engine/` dibuja cada fotograma de forma determinista: `scenes.js` (tipos de escena), `timeline.js` (sincroniza escenas con la frase `cue`, ritmo de 180 ppm medido en los vídeos de referencia), `thumbnail.js`.

Las transcripciones de `style/referencias/` son material de estudio privado; no se publican ni se copian en los guiones.
