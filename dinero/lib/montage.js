// Montaje de dinero con editor IA compartido: fotos catalogadas, cortes en pausas, foco en caras/productos,
// revisión visual, punch-in y efectos suaves. Las tarjetas mantienen su animación sobre los cambios de fondo.
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../../lib/ytdlp.js';
import { downloadImages } from '../../lib/brave.js';
import { pickRelevant } from '../../lib/imagepick.js';
import { generateImage } from '../../lib/codeximage.js';
import { cutSlots, planEdit, reviewEdit, enforce, groupTakes, sfxTrack } from '../../lib/editor.js';
import { FONTS, composeThumb } from '../../lib/thumbnail.js';
import { W, H, wordEvents, assDoc } from '../../lib/subs.js';
import { cardEvents, CARD_STYLES, SUB_Y } from './cards.js';
import { catalogPhotos } from './photos.js';

export const BRAND = process.env.DINERO_BRAND || '@historiasdedinero';
const FPS = 30;
const ff = (args, timeout = 600000) => run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], timeout);

/** Frases → con su inicio y fin a partir de las palabras alineadas (por recuento de palabras). */
function lineTimes(lines, words, total) {
  let k = 0;
  return lines.map((l, i) => {
    const n = String(l.text).split(/\s+/).filter(Boolean).length;
    const s = i ? (words[k]?.s ?? total) : 0;
    k += n;
    return { ...l, s };
  }).map((l, i, a) => ({ ...l, e: a[i + 1]?.s ?? total }));
}

/** Rehace una foto como ilustración editorial (para no usar la foto de prensa tal cual). Si Codex no puede, la foto. */
async function restyle(file, about, dir, log, signal) {
  try {
    const gen = await generateImage({
      ref: file,
      prompt: `Genera UNA imagen con tu herramienta integrada de generación de imágenes (image_gen). No uses scripts ni pidas OPENAI_API_KEY. No escribas código.

Redibuja la foto adjunta (${about}) como una ilustración editorial de revista de negocios, vertical 2:3: misma escena y composición, el producto o la persona reconocibles, colores ricos con acentos verdes y dorados, luz dramática, acabado nítido y detallado. Elimina cualquier marca de agua, texto superpuesto o pie de foto.
Cuando la imagen esté generada, responde solo: listo.`,
    }, signal);
    const out = path.join(dir, `ilus-${path.basename(file, path.extname(file))}${path.extname(gen) || '.png'}`);
    await copyFile(gen, out);
    log('🎨 Foto del gancho rehecha como ilustración (Codex)');
    return out;
  } catch (e) { log(`⚠️ Codex no pudo rehacer la foto (${e.message.slice(0, 100)}): uso la original`); return file; }
}

/** Sin ninguna foto buena: Codex dibuja una ilustración editorial de lo que pide la frase. */
async function illustrate(query, about, dir, log, signal) {
  try {
    const gen = await generateImage({ prompt: `Genera UNA imagen con tu herramienta integrada de generación de imágenes (image_gen). No uses scripts ni pidas OPENAI_API_KEY. No escribas código.

Ilustración editorial de revista de negocios, vertical 2:3, sobre: ${query} (historia: ${about}). Escena clara y reconocible, colores ricos con acentos verdes y dorados, luz dramática, acabado nítido. Sin texto, letras, logos inventados ni marca de agua; si sale una persona real, que no se parezca a nadie concreto.
Cuando la imagen esté generada, responde solo: listo.` }, signal);
    const out = path.join(dir, `ilus-${Date.now().toString(36)}${path.extname(gen) || '.png'}`);
    await copyFile(gen, out);
    log(`🎨 Sin fotos de «${query}»: ilustración de Codex`);
    return out;
  } catch (e) { log(`⚠️ Sin fotos ni ilustración de «${query}» (${e.message.slice(0, 80)})`); return null; }
}

/** Clip de una imagen: acercamiento lento y sutil hacia el centro (Ken Burns, +6 %), sin desplazarse de lado
 *  (los barridos laterales rápidos marean y tapan el texto); el ritmo lo dan los cortes. Se trabaja a doble resolución
 *  para que el zoom no tiemble. blur = fondo de tarjeta (desenfocado y oscuro). */
export async function imageClip(img, dur, out, { blur = false, emph = null, focusX = 0.5, focusY = 0.5 } = {}) {
  const frames = Math.max(1, Math.round(dur * FPS));
  const look = blur ? ',boxblur=22:2,eq=brightness=-0.22:saturation=0.85' : '';
  const fx = Number.isFinite(focusX) ? Math.max(0, Math.min(1, focusX)) : 0.5;
  const fy = Number.isFinite(focusY) ? Math.max(0, Math.min(1, focusY)) : 0.5;
  const punchAt = emph == null || blur ? null : Math.max(0, Math.round(emph * FPS));
  const punch = punchAt == null ? '' : `+if(gte(on,${punchAt}),min(0.08,0.08*(on-${punchAt})/5),0)`;
  await ff(['-i', img, '-vf', `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2}:'max(0,min(iw-ow,iw*${fx}-ow/2))':'max(0,min(ih-oh,ih*${fy}-oh/2))',zoompan=z='min(1.14,1+0.06*on/${frames}${punch})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}${look},format=yuv420p`,
    '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', out]);
}

const thumbPrompt = (about) => `Genera UNA imagen con tu herramienta integrada de generación de imágenes (image_gen). No uses scripts ni pidas OPENAI_API_KEY. No escribas código.

A partir de la imagen adjunta (${about}), crea la MINIATURA de un short vertical de YouTube/TikTok sobre una historia de dinero, en retrato 2:3:
- El protagonista (la persona, el producto o el logo de la historia) grande y reconocible, algo descentrado hacia abajo; si es una persona, con una expresión intensa y mirando a cámara.
- Ambiente de dinero y tensión: billetes, gráficas que suben o se desploman, brillo dorado o rojo según si la historia es de éxito o de caída; colores vivos, contraste alto, contorno nítido.
- El tercio de ARRIBA, oscuro y despejado: ahí irá un texto que se pone después.
- Sin NINGÚN texto, letra, número, logo inventado ni marca de agua.
Cuando la imagen esté generada, responde solo: listo.`;

/**
 * script: { lines: [{ text, show, query, … }], yellow, red, title, thumb_text, thumb_word }, voice: mp3, words: [{ w, s, e }].
 * name: 'short' (YouTube) | 'tiktok'. thumb: miniatura ya hecha (la versión TikTok reutiliza la de YouTube) o null.
 */
export async function montage({ script, about, context = about, voice, words, duration, dir, name = 'short', thumb = null }, log, signal) {
  await mkdir(dir, { recursive: true });
  const total = duration + 0.3;
  const lines = lineTimes(script.lines, words, total);
  const pools = new Map();
  // fotos de cada búsqueda que la IA confirma que encajan; si ninguna, con el nombre a secas; si tampoco, Codex la dibuja
  const pool = async (q) => {
    if (pools.has(q)) return pools.get(q);
    let imgs = await pickRelevant(await downloadImages(q, dir, 8), q, context, dir, { business: true });
    if (!imgs.length && q !== about) imgs = await pickRelevant(await downloadImages(about, dir, 8), about, context, dir, { business: true });
    if (!imgs.length) imgs = [await illustrate(q, about, dir, log, signal)].filter(Boolean);
    log(`🖼 «${q}»: ${imgs.length} foto${imgs.length === 1 ? '' : 's'} que encajan`);
    pools.set(q, imgs);
    return imgs;
  };
  const requests = new Map(), lineFiles = [];
  for (const [li, l] of lines.entries()) {
    signal?.throwIfAborted();
    const files = await pool(l.query || about);
    if (!files.length) throw new Error(`Sin imágenes verificadas para «${l.query || about}»`);
    lineFiles[li] = files;
    for (const file of files) if (!requests.has(file)) requests.set(file, { file, query: l.query || about });
  }
  const photos = await catalogPhotos([...requests.values()], context, dir, log, signal);
  const catalog = [];
  for (const [line, files] of lineFiles.entries()) {
    // Cada foto se limita a las frases para las que se verificó. El editor nunca cambia un empresario por otro
    // para evitar una repetición; con poco material se reutiliza una foto correcta con otro acercamiento.
    for (const photo of photos.filter((p) => files.includes(p.file))) catalog.push({ ...photo, line, id: `F${catalog.length + 1}` });
    if (!catalog.some((p) => p.line === line)) throw new Error(`Todas las fotos de la frase ${line + 1} fueron descartadas; prueba otra búsqueda`);
  }
  const takes = groupTakes(catalog);
  const slots = cutSlots(lines, words, script);
  const editContext = `${context}\nEs una historia de negocios, no anime. Cada foto indica la única frase donde puede usarse. Prioriza identidad y relación con la voz por encima de variar. Las frases ${lines.map((l, i) => l.show !== 'foto' ? `F${i + 1} (${l.show})` : '').filter(Boolean).join(', ') || '(ninguna)'} llevan tarjetas animadas propias; su fondo se oscurece y desenfoca intencionadamente. No marques estos fondos como mala calidad. Los movimientos son acercamientos de fotos, no acción de vídeo.`;
  log(`🎬 Editor IA: ${slots.length} cortes de ~2,3 s con ${photos.length} fotos (${takes} tomas distintas)…`);
  const { plan, climax, motion } = await planEdit({ slots, lines, catalog, context: editContext }, log);
  const byId = new Map(catalog.map((p) => [p.id, p]));
  if (lines[0].show === 'foto') {
    const hook = byId.get(plan[0]);
    hook.file = await restyle(hook.file, about, dir, log, signal);
  }
  // Una tarjeta por frase, no por corte: el contador o la gráfica no se reinician al cambiar la foto de fondo.
  const cards = lines.flatMap((l) => cardEvents(l, l.s, l.e));
  const ass = path.join(dir, `subs-${name}.ass`);
  await writeFile(ass, assDoc({ events: [...cards, ...wordEvents(words, script, total, SUB_Y)], brand: BRAND, total, styles: CARD_STYLES, subSize: 150 }));
  const parts = [];
  const render = async (i) => {
    signal?.throwIfAborted();
    const slot = slots[i], item = byId.get(plan[i]);
    if (!item) throw new Error(`Sin foto para el corte ${i + 1}`);
    const out = path.join(dir, `cut-${name}-${String(i).padStart(3, '0')}.mp4`);
    await imageClip(item.file, +(slot.e - slot.s).toFixed(3), out, { ...item, emph: slot.emph, blur: lines[slot.line].show !== 'foto' });
    parts[i] = out;
  };
  for (let i = 0; i < slots.length; i++) await render(i);
  const frames = [];
  for (const [i, file] of parts.entries()) {
    signal?.throwIfAborted();
    const mid = (slots[i].e - slots[i].s) / 2;
    const frame = `${file}.jpg`;
    // La revisión ve la composición real con cifra/titular/gráfica y subtítulos, no solo un fondo borroso.
    await ff(['-ss', String(mid), '-i', file, '-vf', `setpts=PTS+${slots[i].s + mid}/TB,subtitles=${ass}:fontsdir=${FONTS},scale=270:480`, '-frames:v', '1', '-fps_mode', 'vfr', frame]);
    frames.push(frame);
  }
  log('👀 Revisando encuadres, repeticiones y relación con la voz…');
  const fixes = await reviewEdit({ frames, slots, plan, catalog, context: editContext, dir });
  const before = [...plan];
  for (const [i, fix] of Object.entries(fixes)) plan[i] = fix.id;
  const fixed = enforce(plan, catalog, { slotLines: slots.map((s) => s.line) });
  plan.splice(0, plan.length, ...fixed.plan);
  let changed = 0;
  for (let i = 0; i < plan.length; i++) if (plan[i] !== before[i]) { await render(i); changed++; }
  await writeFile(path.join(dir, `edit-${name}.json`), JSON.stringify({ slots, plan, climax, motion, catalog }, null, 2));
  log(`✂️ ${parts.length} cortes montados con tarjetas continuas · revisión: ${changed} rehechos`);
  const list = path.join(dir, `cuts-${name}.txt`);
  await writeFile(list, parts.map((p) => `file '${p}'`).join('\n'));
  // miniatura: Codex la compone a partir de la ilustración del gancho; el texto va a 4K
  if (!thumb) {
    let art = byId.get(plan[0]).file;
    log('🖼 Miniatura: Codex compone la portada…');
    try {
      const gen = await generateImage({ prompt: thumbPrompt(about), ref: art }, signal);
      art = path.join(dir, `thumb-art${path.extname(gen) || '.png'}`);
      await copyFile(gen, art);
    } catch (e) { log(`⚠️ Codex no pudo (${e.message.slice(0, 100)}): uso la ilustración del gancho`); }
    thumb = await composeThumb({ art, text: script.thumb_text || script.title, word: script.thumb_word, dir }, log);
  }
  let lastWhoosh = -9;
  const whooshAt = [...new Set(motion)].sort((a, b) => a - b).map((i) => slots[i]?.s)
    .filter((t) => t != null && t > 0.5 && t - lastWhoosh >= 3 && (lastWhoosh = t));
  const sfx = await sfxTrack({ whooshAt, impactAt: slots[climax]?.s ?? null, total, dir })
    .catch((e) => { log(`⚠️ Sin efectos: ${e.message.slice(0, 100)}`); return null; });
  signal?.throwIfAborted();
  const final = path.join(dir, `${name}.mp4`);
  // el primer fotograma es la miniatura (0,3 s)
  await ff(['-f', 'concat', '-safe', '0', '-i', list, '-i', voice, '-loop', '1', '-t', String(total), '-i', thumb.small, ...(sfx ? ['-i', sfx] : []),
    '-filter_complex', `[0:v]subtitles=${ass}:fontsdir=${FONTS}[v];[2:v]scale=${W}:${H}[t];[v][t]overlay=enable='lt(t,0.3)'[o]${sfx ? ';[1:a]apad=pad_dur=0.3[voice];[3:a]volume=0.45[s];[voice][s]amix=inputs=2:normalize=0:duration=first[a]' : ';[1:a]apad=pad_dur=0.3[a]'}`, '-map', '[o]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-t', String(total), '-movflags', '+faststart', final]);
  return { video: final, thumb };
}
