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
- **MP4 vertical** · 1080×1920 con marco de cómic, gancho arriba y subtítulos palabra a palabra (`comic/public/comic.js`), exportado en el navegador.
- **Común en `lib/`** · `db.js` (Postgres; los episodios van en la tabla `comics`), `auth.js` y `web.js` (login, sesión, usuarios, estáticos), `store.js` (archivos), `claude.js`/`codex.js` (IA), `export.js`. Usuarios: `npm run user -- add <usuario> [--admin]` (`scripts/user.js`).

## Estudio Anime (`anime/`)

App aparte: shorts verticales de curiosidades y noticias de anime al estilo de AniDosis, en automático y en español, con la marca @notianimes.

```bash
npm run anime      # → http://localhost:4324 (mismos usuarios y Postgres; tabla `animes`)
```

- **Historias** · la IA busca en la web las noticias y curiosidades de anime con más gancho de los últimos días, sin repetir las ya hechas (`anime/lib/story.js`).
- **Guion** · fórmula AniDosis: gancho, «el problema es que…», datos y remate; título con MAYÚSCULAS, palabras a resaltar en amarillo/rojo y qué se ve en cada frase.
- **Voz** · a elegir entre las dos voces del canal (hombre o mujer, de la biblioteca de ElevenLabs), alineada palabra a palabra (Whisper).
- **Montaje** · ffmpeg en el servidor (`anime/lib/montage.js`): cortes de ~2,6 s sobre escenas del tráiler/PV oficial (sin negros, logos ni créditos), recorte 9:16, imágenes de Brave con desplazamiento, subtítulos ASS de 1-2 palabras en Anton (`anime/fonts`, OFL) y la marca del canal.
## Cómo funciona el motor
- `server.js` lanza `claude -p --output-format stream-json --json-schema …` con un prompt de sistema construido desde `style/estilo.md`. El progreso llega en vivo al panel del motor.
- Al escribir un guion, Claude Code lee transcripciones de `style/referencias/` para calibrar el ritmo, investiga con WebSearch/WebFetch y devuelve JSON validado.
- **Control de originalidad** (`lib/originality.js`): si alguna frase coincide con las referencias (6 palabras seguidas o frases-firma del otro creador), una segunda pasada la reescribe con palabras propias. Se imita el oficio, no las frases.
- `public/js/engine/` dibuja cada fotograma de forma determinista: `scenes.js` (tipos de escena), `timeline.js` (sincroniza escenas con la frase `cue`, ritmo de 180 ppm medido en los vídeos de referencia), `thumbnail.js`.

Las transcripciones de `style/referencias/` son material de estudio privado; no se publican ni se copian en los guiones.
