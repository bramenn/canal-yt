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

## Cómo funciona el motor
- `server.js` lanza `claude -p --output-format stream-json --json-schema …` con un prompt de sistema construido desde `style/estilo.md`. El progreso llega en vivo al panel del motor.
- Al escribir un guion, Claude Code lee transcripciones de `style/referencias/` para calibrar el ritmo, investiga con WebSearch/WebFetch y devuelve JSON validado.
- **Control de originalidad** (`lib/originality.js`): si alguna frase coincide con las referencias (6 palabras seguidas o frases-firma del otro creador), una segunda pasada la reescribe con palabras propias. Se imita el oficio, no las frases.
- `public/js/engine/` dibuja cada fotograma de forma determinista: `scenes.js` (tipos de escena), `timeline.js` (sincroniza escenas con la frase `cue`, ritmo de 180 ppm medido en los vídeos de referencia), `thumbnail.js`.

Las transcripciones de `style/referencias/` son material de estudio privado; no se publican ni se copian en los guiones.
