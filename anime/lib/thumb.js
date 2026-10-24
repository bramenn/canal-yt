// Miniatura del short de anime (y su primer fotograma): un personaje en primer plano con una emoción clara y colores
// vivos (naranja, amarillo, turquesa). Codex (image_gen) redibuja el mejor primer plano del tráiler; el texto y el
// 4K los pone lib/thumbnail.js. Si Codex no puede (p. ej. personajes con derechos), se usa el fotograma.
import { copyFile, rename, readdir, readFile, writeFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { run } from '../../lib/ytdlp.js';
import { generateImage } from '../../lib/codeximage.js';
import { composeThumb, composeThumb16x9 } from '../../lib/thumbnail.js';
import { claudeStep } from '../../lib/claude.js';
import { dhash } from '../../lib/editor.js';

const ff = (args) => run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], 600000);

export function hashDistance(a, b) {
  if (!a || !b) return 64;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

/** Excluye tomas ya utilizadas, incluso aunque procedan de otro archivo o tráiler. */
export const freshScenes = (scenes, history) => scenes.filter((s) => s.hash && !history.some((h) => [h.frameHash, ...(h.usedFrameHashes || [])].some((hash) => hash && hashDistance(s.hash, hash) <= 6)));

const fingerprints = new Map();
async function fingerprint(file) {
  const st = await stat(file);
  const key = `${file}:${st.mtimeMs}:${st.size}`;
  if (!fingerprints.has(key)) fingerprints.set(key, await dhash(file));
  return fingerprints.get(key);
}

/** Incluye también la portada actual: «Rehacer» tiene que producir otra composición. */
async function previousCovers(dir) {
  const root = path.dirname(dir), history = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const d = path.join(root, entry.name), frame = path.join(d, 'thumb-frame.png');
    if (!existsSync(frame)) continue;
    let meta = {};
    try { meta = JSON.parse(await readFile(path.join(d, 'thumb-selection.json'), 'utf8')); } catch {}
    const art = ['thumb-art.png', 'thumb-art.webp', 'thumb-art.jpg'].map((f) => path.join(d, f)).find(existsSync);
    history.push({ id: entry.name, ...meta, frameHash: await fingerprint(frame), artHash: meta.artHash || (art ? await fingerprint(art) : null) });
  }
  return history;
}

const prompt = (anime, script, context, direction, history) => `Genera UNA imagen con tu herramienta integrada de generación de imágenes (image_gen). No uses scripts ni pidas OPENAI_API_KEY. No escribas código.

Diseña una MINIATURA NUEVA de un short vertical de YouTube/TikTok, en formato retrato 2:3. La imagen adjunta (${anime}) sirve SOLO para la identidad y el estilo del personaje; NO copies su pose, encuadre ni fondo.
HISTORIA: ${context || script.title}
GUION: ${script.lines?.map((l) => l.text).join(' ') || script.title}
TEXTO QUE PONDREMOS DESPUÉS: ${script.thumb_text || script.title}
IDEA VISUAL: ${direction}
- Representa el dato o acción de ESTA historia con un personaje reconocible y el objeto o situación relevantes. No inventes hechos ni uses un personaje ajeno solo porque sale en el tráiler.
- Conserva el personaje (cara, pelo, ropa, estilo de animación), pero cambia claramente pose, ángulo y composición.
- PLANO MEDIO OBLIGATORIO: Dibuja al personaje en plano medio (de cintura o pecho hacia arriba), con su cabeza situada en los dos tercios inferiores (a partir del 35 % de altura hacia abajo). NUNCA figuras de cuerpo entero de pie que lleguen hasta el borde superior.
- Colores muy vivos y saturados (naranjas, amarillos, turquesas), contraste alto, contorno limpio y nítido, un brillo o halo que lo separe del fondo; fondo simplificado y algo desenfocado.
- ZONA DE TÍTULO OBLIGATORIA: el 35 % SUPERIOR de la imagen (más de un tercio vertical) debe quedar completamente despejado (cielo, techo o fondo oscuro/liso sin cabezas, caras, pelo, manos ni objetos protagonistas), porque ahí se colocará el titular grande sin tapar al personaje.
- Sin NINGÚN texto, letra, número, logo ni marca de agua.
COMPOSICIONES YA USADAS QUE DEBES EVITAR: ${history.map((h) => h.direction).filter(Boolean).slice(-30).join(' · ') || 'retratos genéricos de una cara gritando de frente; diseña una escena específica de esta historia'}.
Cuando la imagen esté generada, responde solo: listo.`;

// Serializa la selección y generación: dos tareas simultáneas también ven la portada recién terminada.
let queue = Promise.resolve();
export async function makeThumb(options, log = () => {}, signal) {
  const previous = queue;
  let release;
  queue = new Promise((resolve) => { release = resolve; });
  await previous;
  try { signal?.throwIfAborted(); return await createThumb(options, log, signal); }
  finally { release(); }
}

/**
 * Miniatura de un short. scenes: escenas del tráiler (con .thumb = puesto si la IA la eligió para miniatura).
 * Devuelve { full: 4K (2160×3840), small: 1080×1920 (< 2 MB, para subir a YouTube) }.
 */
async function createThumb({ script, anime, scenes, dir, context = '' }, log, signal) {
  const history = await previousCovers(dir);
  const candidates = await Promise.all(scenes.map(async (s) => ({ ...s, hash: s.hash || await dhash(s.file, (s.s + s.e) / 2) })));
  const fresh = freshScenes(candidates, history);
  if (!fresh.length) throw new Error('No hay una toma diferente a las portadas anteriores. Hace falta material nuevo para esta miniatura.');
  const ranked = fresh.sort((a, b) => (a.thumb ?? 99) - (b.thumb ?? 99));
  let best = ranked[0];
  if (!best) throw new Error('Sin escenas para la miniatura');
  let direction = `Escena nueva que ilustre ${context || script.title}; ${script.thumb_text || ''}. Cambia el encuadre y muestra la acción u objeto concreto.`;
  const choices = ranked.slice(0, 24);
  const ev = await claudeStep({
    prompt: `Elige una referencia de personaje para la portada de ESTA historia: ${context || script.title}.\nGuion: ${script.lines?.map((l) => l.text).join(' ')}\nTexto: ${script.thumb_text}.\nReferencias disponibles (ya excluimos tomas usadas): ${JSON.stringify(choices.map((s, i) => ({ n: i, who: s.who, desc: s.desc, shot: s.shot })))}\nComposiciones anteriores que no debes repetir: ${JSON.stringify(history.map((h) => h.direction).filter(Boolean))}.\nDevuelve index (índice de referencia pertinente) y direction (una composición nueva, concreta, con personajes/objeto/acción de la historia, sin texto, respetando lo narrado). NUNCA propongas figuras de cuerpo entero que lleguen al borde superior; propone plano medio de cintura hacia arriba situado del 35 % hacia abajo para que el tercio superior quede completamente libre para el titular.`,
    schema: { type: 'object', properties: { index: { type: 'integer', minimum: 0, maximum: choices.length - 1 }, direction: { type: 'string' } }, required: ['index', 'direction'] },
    system: 'Eres director de arte de portadas de anime; cada portada cuenta una historia distinta.', effort: 'low', tools: [],
  }, () => {}, () => {}).catch((e) => { log(`⚠️ Dirección de portada: ${e.message.slice(0, 100)}`); return null; });
  if (ev && choices[ev.data?.index]) { best = choices[ev.data.index]; direction = ev.data.direction || direction; }
  signal?.throwIfAborted();
  // Trabajar aparte: un fallo o una cancelación no debe dejar media portada nueva sobre la anterior.
  const work = await mkdtemp(path.join(dir, '.thumb-next-'));
  try {
    const frame = path.join(work, 'thumb-frame.png');
    await ff(['-ss', String((best.s + best.e) / 2), '-i', best.file, '-frames:v', '1', frame]);
    let art = frame;
    log(`🖼 Miniatura: composición propia de la historia (${candidates.length - fresh.length} tomas repetidas excluidas)…`);
    try {
      const gen = await generateImage({ prompt: prompt(anime, script, context, direction, history), ref: frame }, signal);
      const hash = await fingerprint(gen);
      if (!hash || history.some((h) => h.artHash && hashDistance(hash, h.artHash) <= 4)) throw new Error('El dibujo se parece demasiado a una portada anterior');
      art = path.join(work, `thumb-art${path.extname(gen) || '.png'}`);
      await copyFile(gen, art);
    } catch (e) { signal?.throwIfAborted(); log(`⚠️ Codex no pudo (${e.message.slice(0, 120)}): uso la toma nueva del tráiler`); }
    await composeThumb({ art, text: script.thumb_text || script.title, word: script.thumb_word, dir: work }, log);
    signal?.throwIfAborted();
    const own = history.find((h) => h.id === path.basename(dir));
    const usedFrameHashes = [...new Set([...(own?.usedFrameHashes || []), own?.frameHash, best.hash].filter(Boolean))];
    await writeFile(path.join(work, 'thumb-selection.json'), JSON.stringify({ title: script.title, direction, frameHash: best.hash, usedFrameHashes, artHash: await fingerprint(art), at: Date.now() }, null, 2));
    for (const file of await readdir(work)) await rename(path.join(work, file), path.join(dir, file));
    return { full: path.join(dir, 'thumb-4k.jpg'), small: path.join(dir, 'thumb.jpg') };
  } finally { await rm(work, { recursive: true, force: true }); }
}

/** Reemplaza solo los dos primeros fotogramas; conserva duración y copia el audio. */
export async function firstFrame(video, thumb) {
  const tmp = video.replace(/\.mp4$/, '.tmp.mp4');
  await ff(['-i', video, '-loop', '1', '-t', '1', '-i', thumb, '-filter_complex', "[1:v]scale=1080:1920[t];[0:v][t]overlay=enable='lt(t,0.066)':eof_action=pass[o]",
    '-map', '[o]', '-map', '0:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', tmp]);
  await rename(tmp, video);
}

const prompt16x9 = (anime, script, context, direction, history) => `Genera UNA imagen con tu herramienta integrada de generación de imágenes (image_gen) en formato HORIZONTAL panorámico 3:2 (1536×1024). No uses scripts ni pidas OPENAI_API_KEY. No escribas código.

Diseña una MINIATURA HORIZONTAL 16:9 de YouTube para un vídeo largo de anime. La imagen adjunta (${anime}) sirve SOLO para la identidad y el estilo del personaje; NO copies su pose, encuadre ni fondo.
HISTORIA: ${context || script.title}
TEXTO QUE PONDREMOS DESPUÉS A LA IZQUIERDA: ${script.thumb_text || script.title}
IDEA VISUAL: ${direction}
- Sitúa al personaje o personajes protagonistas y la acción principal en los DOS TERCIOS DERECHOS de la imagen (x entre el 38 % y el 96 % del ancho), con expresión intensa, nítida y reconocible.
- ZONA DE TÍTULO OBLIGATORIA A LA IZQUIERDA: el TERCIO IZQUIERDO (el 36 % izquierdo del ancho) debe quedar como fondo oscuro, atmosférico y despejado (cielo nocturno, energía oscura o desenfoque profundo, sin caras, cabezas ni manos), porque ahí se superpondrá el titular gigante.
- Colores muy vivos y saturados (naranjas, amarillos, turquesas), alto contraste, contorno limpio y halo de luz que separe al personaje del fondo.
- Sin NINGÚN texto, letra, número, logo ni marca de agua.
COMPOSICIONES YA USADAS QUE DEBES EVITAR: ${history.map((h) => h.direction).filter(Boolean).slice(-20).join(' · ') || 'retratos genéricos centrados'}.
Cuando la imagen esté generada, responde solo: listo.`;

export async function makeThumb16x9(options, log = () => {}, signal) {
  const previous = queue;
  let release;
  queue = new Promise((resolve) => { release = resolve; });
  await previous;
  try { signal?.throwIfAborted(); return await createThumb16x9(options, log, signal); }
  finally { release(); }
}

async function createThumb16x9({ script, anime, scenes, dir, context = '' }, log, signal) {
  const history = await previousCovers(dir);
  const candidates = await Promise.all(scenes.map(async (s) => ({ ...s, hash: s.hash || await dhash(s.file, (s.s + s.e) / 2) })));
  const fresh = freshScenes(candidates, history);
  const pool = fresh.length ? fresh : candidates;
  const ranked = pool.sort((a, b) => (a.thumb ?? 99) - (b.thumb ?? 99));
  let best = ranked[0];
  if (!best) throw new Error('Sin escenas para la miniatura 16:9');
  let direction = `Composición horizontal 16:9 con el protagonista de ${anime} en el lado derecho mostrando ${context || script.title} y el tercio izquierdo oscuro y despejado para el titular.`;
  const choices = ranked.slice(0, 24);
  const ev = await claudeStep({
    prompt: `Elige una referencia de personaje para la miniatura horizontal 16:9 de YouTube de ESTE vídeo largo: ${context || script.title}.\nTexto en portada: ${script.thumb_text}.\nReferencias disponibles: ${JSON.stringify(choices.map((s, i) => ({ n: i, who: s.who, desc: s.desc, shot: s.shot })))}\nDevuelve index (índice de referencia) y direction (composición horizontal 16:9 concreta con el personaje/acción en los dos tercios derechos y el tercio izquierdo oscuro y despejado, sin texto).`,
    schema: { type: 'object', properties: { index: { type: 'integer', minimum: 0, maximum: choices.length - 1 }, direction: { type: 'string' } }, required: ['index', 'direction'] },
    system: 'Eres director de arte de miniaturas horizontales de YouTube de anime.', effort: 'low', tools: [],
  }, () => {}, () => {}).catch(() => null);
  if (ev && choices[ev.data?.index]) { best = choices[ev.data.index]; direction = ev.data.direction || direction; }
  signal?.throwIfAborted();
  const work = await mkdtemp(path.join(dir, '.thumb16x9-next-'));
  try {
    const frame = path.join(work, 'thumb-frame.png');
    await ff(['-ss', String((best.s + best.e) / 2), '-i', best.file, '-frames:v', '1', frame]);
    let art = frame;
    log('🖼 Miniatura 16:9: generando arte panorámico con Codex…');
    try {
      const gen = await generateImage({ prompt: prompt16x9(anime, script, context, direction, history), ref: frame }, signal);
      art = path.join(work, `thumb-art${path.extname(gen) || '.png'}`);
      await copyFile(gen, art);
    } catch (e) { signal?.throwIfAborted(); log(`⚠️ Codex no pudo (${e.message.slice(0, 120)}): uso fotograma del tráiler`); }
    await composeThumb16x9({ art, text: script.thumb_text || script.title, word: script.thumb_word, dir: work }, log);
    signal?.throwIfAborted();
    const own = history.find((h) => h.id === path.basename(dir));
    const usedFrameHashes = [...new Set([...(own?.usedFrameHashes || []), own?.frameHash, best.hash].filter(Boolean))];
    await writeFile(path.join(work, 'thumb-selection.json'), JSON.stringify({ title: script.title, direction, frameHash: best.hash, usedFrameHashes, artHash: await fingerprint(art), at: Date.now() }, null, 2));
    for (const file of await readdir(work)) await rename(path.join(work, file), path.join(dir, file));
    return { full: path.join(dir, 'thumb-4k.jpg'), small: path.join(dir, 'thumb.jpg') };
  } finally { await rm(work, { recursive: true, force: true }); }
}
