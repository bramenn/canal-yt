// Montaje del short de dinero (1080×1920) con ffmpeg: fotos de Brave con movimiento lento (cortes de ~2,6 s), y en las
// frases con cifra, titular o gráfica la tarjeta animada sobre la foto desenfocada; subtítulos abajo, marca del canal
// y la miniatura como primer fotograma. La foto del gancho la rehace Codex como ilustración (no es la foto de prensa).
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../../lib/ytdlp.js';
import { downloadImages } from '../../lib/brave.js';
import { pickRelevant } from '../../lib/imagepick.js';
import { generateImage } from '../../lib/codeximage.js';
import { FONTS, composeThumb } from '../../lib/thumbnail.js';
import { W, H, wordEvents, assDoc } from '../../lib/subs.js';
import { cardEvents, CARD_STYLES, SUB_Y } from './cards.js';

export const BRAND = process.env.DINERO_BRAND || '@historiasdedinero';
const FPS = 30, CUT = 2.6;
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
async function imageClip(img, dur, out, i, blur) {
  const frames = Math.max(1, Math.round(dur * FPS));
  const look = blur ? ',boxblur=22:2,eq=brightness=-0.22:saturation=0.85' : '';
  await ff(['-i', img, '-vf', `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='1+0.06*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}${look},format=yuv420p`,
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
export async function montage({ script, about, voice, words, duration, dir, name = 'short', thumb = null }, log, signal) {
  await mkdir(dir, { recursive: true });
  const total = duration + 0.3;
  const lines = lineTimes(script.lines, words, total);
  const pools = new Map(), used = new Map();
  // fotos de cada búsqueda que la IA confirma que encajan; si ninguna, con el nombre a secas; si tampoco, Codex la dibuja
  const pool = async (q) => {
    if (pools.has(q)) return pools.get(q);
    let imgs = await pickRelevant(await downloadImages(q, dir, 8), q, about, dir);
    if (!imgs.length && q !== about) imgs = await pickRelevant(await downloadImages(about, dir, 8), about, about, dir);
    if (!imgs.length) imgs = [await illustrate(q, about, dir, log, signal)].filter(Boolean);
    log(`🖼 «${q}»: ${imgs.length} foto${imgs.length === 1 ? '' : 's'} que encajan`);
    pools.set(q, imgs);
    return imgs;
  };
  const fallback = async () => (await pool(script.lines.find((l) => l.show === 'foto')?.query ?? about))[0];
  let hookArt = null;
  const parts = [], cards = [];
  let i = 0;
  for (const [li, l] of lines.entries()) {
    if (signal?.aborted) throw new Error('Cancelado');
    const card = l.show !== 'foto';
    // las frases con tarjeta son un solo corte (la tarjeta no se parte); las de foto, cortes de ~2,6 s con fotos distintas
    const n = card ? 1 : Math.max(1, Math.round((l.e - l.s) / CUT));
    for (let k = 0; k < n; k++) {
      const s = l.s + ((l.e - l.s) * k) / n, e = l.s + ((l.e - l.s) * (k + 1)) / n;
      const imgs = await pool(l.query || about);
      const u = used.get(l.query) ?? 0;
      used.set(l.query, u + 1);
      let img = imgs.length ? imgs[u % imgs.length] : await fallback();
      if (!img) throw new Error(`Sin imágenes para «${l.query}»`);
      // el gancho (primer corte) va como ilustración de Codex; se reutiliza para la miniatura
      if (li === 0 && k === 0 && !card) { hookArt ??= await restyle(img, about, dir, log, signal); img = hookArt; }
      const out = path.join(dir, `cut-${name}-${String(i).padStart(3, '0')}.mp4`);
      await imageClip(img, +(e - s).toFixed(3), out, i++, card);
      parts.push(out);
    }
    if (card) cards.push(...cardEvents(l, l.s, l.e));
  }
  log(`✂️ ${parts.length} cortes montados (${cards.length ? 'con tarjetas de cifras, titulares o gráficas' : 'solo fotos'})`);
  const list = path.join(dir, `cuts-${name}.txt`);
  await writeFile(list, parts.map((p) => `file '${p}'`).join('\n'));
  const ass = path.join(dir, `subs-${name}.ass`);
  await writeFile(ass, assDoc({ events: [...cards, ...wordEvents(words, script, total, SUB_Y)], brand: BRAND, total, styles: CARD_STYLES, subSize: 150 }));
  // miniatura: Codex la compone a partir de la ilustración del gancho; el texto va a 4K
  if (!thumb) {
    let art = hookArt ?? (await fallback());
    log('🖼 Miniatura: Codex compone la portada…');
    try {
      const gen = await generateImage({ prompt: thumbPrompt(about), ref: art }, signal);
      art = path.join(dir, `thumb-art${path.extname(gen) || '.png'}`);
      await copyFile(gen, art);
    } catch (e) { log(`⚠️ Codex no pudo (${e.message.slice(0, 100)}): uso la ilustración del gancho`); }
    thumb = await composeThumb({ art, text: script.thumb_text || script.title, word: script.thumb_word, dir }, log);
  }
  const final = path.join(dir, `${name}.mp4`);
  // el primer fotograma es la miniatura (0,3 s)
  await ff(['-f', 'concat', '-safe', '0', '-i', list, '-i', voice, '-loop', '1', '-t', String(total), '-i', thumb.small,
    '-filter_complex', `[0:v]subtitles=${ass}:fontsdir=${FONTS}[v];[2:v]scale=${W}:${H}[t];[v][t]overlay=enable='lt(t,0.3)'[o]`, '-map', '[o]', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-t', String(total), '-movflags', '+faststart', final]);
  return { video: final, thumb };
}
