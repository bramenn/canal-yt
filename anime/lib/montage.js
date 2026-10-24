// Montaje del short vertical (1080×1920) con ffmpeg, editado como un profesional (lib/editor.js): las escenas de los
// tráileres/PV del anime se catalogan (qué se ve, quién sale, plano, acción) y un editor IA decide qué escena va en cada
// corte según lo que dice la voz (cortes de 1,5-3 s en las pausas, sin repetir toma, el gancho con el plano más potente);
// acercamiento rápido en las palabras resaltadas, whoosh y golpe en el clímax, revisión final del montaje; subtítulos
// ASS de 1-2 palabras y la marca del canal.
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { run, ytdlp, search } from '../../lib/ytdlp.js';
import { downloadImages as images } from '../../lib/brave.js';
import { claudeStep } from '../../lib/claude.js';
import { pickRelevant } from '../../lib/imagepick.js';
import { cutSlots, planEdit, reviewEdit, planTransitions, applyPairTransitions, sfxTrack, dhash, groupTakes, enforce, finalReview, fmtQa } from '../../lib/editor.js';
import { FONTS } from '../../lib/thumbnail.js';
import { W, H, wordEvents, assDoc } from '../../lib/subs.js';
import { makeThumb } from './thumb.js';
import { computeSmartFraming } from '../../lib/animeface.js';
import { upscaleImage } from '../../lib/upscale.js';
import { episodeScenes } from './episodes.js';

export const BRAND = '@notianimes';
const FPS = 30;
// vídeos de reacción/análisis, fan-edits y AMVs: evitar para tener animación oficial limpia
const REACTION = /react|reacci|reaccion|analysis|análisis|analisis|explained|review|resumen|theory|teoría|tier\s*list|parodia|roast|amv|fancam|meme|tiktok|cover|netflix|live.?action|imagen real/i;
// gameplay con la interfaz del juego (Naruto Storm, etc.): no sirve como escena del anime salvo que se pida ese clip exacto
const GAME = /gameplay|walkthrough|\bstorm\s*\d|ultimate ninja|\bps[45]\b|xbox|\bpc\b.*\bgame\b|video ?game|videojuego/i;
// Canales oficiales con metraje en máxima resolución y sin marcas de agua de terceros
const OFFICIAL_CHANNELS = /crunchyroll|viz|toho\s*animation|tms|aniplex|muse\s*asia|ani-one|bandai\s*namco|tv\s*tokyo|netflix|warner\s*bros|kadokawa|shueisha|toei/i;
const ff = (args, timeout = 600000) => run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], timeout);
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]/g, '');

const clamp = (v, lo, hi, def) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def);

// ---------- fuentes ----------
/** Escenas limpias de los tráileres/PV o escenas clave del anime en YouTube (vídeos hasta tener ~20, máx. 4; una vez por anime y proyecto). */
export async function trailer(query, dir, log, context = '', exact = false) {
  const slug = norm(query).slice(0, 40) || 'anime';
  // Cambia el nombre cuando cambia el criterio visual: v4 añade focusX/focusY y layout ('full'|'card').
  const scenesFile = path.join(dir, `tr-${slug}-cat-v4.json`);
  const legacyFile = path.join(dir, `tr-${slug}-cat-v3.json`);
  const hasRealDesc = (arr) => Array.isArray(arr) && arr.some((x) => x.desc && x.desc !== 'escena del anime');
  if (existsSync(scenesFile)) {
    const cached = JSON.parse(await readFile(scenesFile, 'utf8'));
    if (hasRealDesc(cached)) return { scenes: cached };
  }
  const scenes = [];
  // Si ya hay vídeos descargados en la carpeta (p. ej. al re-montar un short existente), los catalogamos con v4 sin volver a descargar de YouTube
  if (existsSync(path.join(dir, `tr-${slug}-0.mp4`))) {
    for (let i = 0; i < 4; i++) {
      const file = path.join(dir, `tr-${slug}-${i}.mp4`);
      if (!existsSync(file)) break;
      const dur = +(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).catch(() => '0')).trim() || 90;
      log(`🎞 Catalogando escenas (v4) de «${query}» (${path.basename(file)})…`);
      scenes.push(...await catalogScenes(file, await scenesOf(file, dur), dir, log, `${query}. ${context}`, exact).catch((e) => { log(`⚠️ Sin revisar escenas: ${e.message.slice(0, 120)}`); return []; }));
    }
    if (scenes.length >= (exact ? 2 : 5) && hasRealDesc(scenes)) {
      await writeFile(scenesFile, JSON.stringify(scenes));
      return { scenes };
    }
    if (existsSync(legacyFile)) return { scenes: JSON.parse(await readFile(legacyFile, 'utf8')) };
  }
  // primero el PV japonés o clip oficial de Crunchyroll/Viz; anuncios nuevos aún no tienen tráiler: opening o cada parte del nombre
  const parts = String(query).split(/\s+(?:x|×|&|y)\s+|:\s*/i).filter((x) => x.trim() && x !== query);
  const tries = exact
    ? [query, `${query} official clip`, `${query} Crunchyroll`, `${query} scene HD`]
    : [`${query} official anime trailer`, `${query} PV`, `${query} anime opening`, ...parts.map((x) => `${x} anime PV`)];
  const minDur = exact ? 15 : 30;
  const maxDur = exact ? 360 : 600;
  const seen = new Set();
  let videos = 0, err = null, first = null;
  // YouTube corta a ratos (403): otro formato y, si no, el siguiente vídeo
  find: for (const q of tries) {
    const rawCands = await search(q, 10).catch(() => []);
    // Priorizar canales oficiales (Crunchyroll, Viz, Toho, etc.) y filtrar AMVs/reacciones
    const cands = rawCands
      .filter((x) => x.duration >= minDur && x.duration <= maxDur && !seen.has(x.id) && !REACTION.test(x.title) && (exact || !GAME.test(x.title)))
      .sort((a, b) => (OFFICIAL_CHANNELS.test(b.channel) ? 1 : 0) - (OFFICIAL_CHANNELS.test(a.channel) ? 1 : 0));
    for (const cand of cands.slice(0, 2)) {
      seen.add(cand.id);
      const file = path.join(dir, `tr-${slug}-${videos}.mp4`);
      for (const fmt of ['bv*[height<=1080][vcodec^=avc1]/bv*[height<=1080]', 'bv*[height<=1080]/b']) {
        try {
          await ytdlp(['-q', '-f', fmt, '--merge-output-format', 'mp4', '-o', file, `https://www.youtube.com/watch?v=${cand.id}`], 300000);
        } catch (e) { err = e; continue; }
        log(`🎞 ${exact ? 'Clip' : 'Tráiler'} de «${query}»: ${cand.title} (${cand.channel})`);
        videos++;
        first ??= { file, dur: cand.duration };
        scenes.push(...await catalogScenes(file, await scenesOf(file, cand.duration), dir, log, `${query}. ${context}`, exact).catch((e) => { log(`⚠️ Sin revisar escenas: ${e.message.slice(0, 120)}`); return []; }));
        break;
      }
      if (scenes.length >= (exact ? 12 : 20) || videos >= (exact ? 2 : 4)) break find;
    }
  }
  if (!first) throw new Error(`No encuentro ${exact ? 'vídeo' : 'tráiler'} de «${query}»${err ? ` (${err.message.slice(0, 80)})` : ''}`);
  // Un PV lleno de overlays, manga o planos descartados no es una fuente útil: las imágenes limpias son mejor respaldo.
  if (scenes.length < (exact ? 2 : 5)) throw new Error(`El ${exact ? 'vídeo' : 'tráiler'} de «${query}» no tiene suficientes escenas limpias`);
  await writeFile(scenesFile, JSON.stringify(scenes));
  return { scenes };
}

/** La imagen principal (og:image) de cada noticia de la historia: suele ser justo lo que se cuenta (el post, la foto, el anuncio). */
export async function newsImages(urls = [], dir) {
  const out = [];
  for (const [k, u] of urls.slice(0, 4).entries()) {
    try {
      const html = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) })).text();
      const meta = (p) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']+)`, 'i'))?.[1]
        ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${p}["']`, 'i'))?.[1];
      const img = meta('og:image') ?? meta('twitter:image');
      if (!img) continue;
      const res = await fetch(new URL(img.replace(/&amp;/g, '&'), u), { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const file = path.join(dir, `news-${k}.img`);
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      const [w, h] = (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])).trim().split(',').map(Number);
      if (w >= 400 && h >= 300) out.push({ file, title: (meta('og:title') ?? '').replace(/&[#\w]+;/g, ' ').slice(0, 120) });
    } catch { /* noticia sin imagen o caída: no pasa nada */ }
  }
  return out;
}

/** Planos del vídeo (cambios de escena) enteros, sin el principio (logos), el final (créditos) ni negros. */
export async function scenesOf(file, dur) {
  const out = await new Promise((resolve) => execFile('ffmpeg', ['-nostdin', '-i', file, '-an', '-vf', "scale=320:-2,blackdetect=d=0.1:pix_th=0.1,select='gt(scene,0.22)',showinfo", '-f', 'null', '-'],
    { maxBuffer: 64 << 20, timeout: 300000 }, (_e, _o, err) => resolve(String(err))));
  const cuts = [...out.matchAll(/pts_time:([\d.]+)/g)].map((m) => +m[1]);
  const blacks = [...out.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  const edges = [0, ...cuts, dur].sort((a, b) => a - b);
  return edges.slice(0, -1).map((s, i) => ({ file, s: s + 0.08, e: edges[i + 1] - 0.08 }))
    .filter((x) => x.e - x.s >= 1.0 && x.s > dur * 0.05 && x.e < dur * 0.92 && !blacks.some(([a, b]) => a < x.e && b > x.s));
}

/**
 * Catálogo de escenas: la IA mira una rejilla con un fotograma de cada una y describe qué se ve, quién sale (si se le
 * reconoce), el plano, la acción, la emoción, el punto focal (focusX, focusY) para el recorte vertical 9:16 y si
 * necesita encuadre completo (layout: 'card'); quita las que no sirven y marca las mejores para miniatura.
 */
export async function catalogScenes(file, scenes, dir, log, context, real = false) {
  const all = scenes.slice(0, 64);
  if (!all.length) { log('👀 Escenas del tráiler: ninguna útil'); return []; }
  const bad = new Set();
  // de 16 en 16: con rejillas grandes la IA se deja escenas sin describir
  for (let b = 0; b < all.length; b += 16) {
    const pick = all.slice(b, b + 16);
    const tag = path.join(dir, `grid-${path.basename(file, '.mp4')}-${b}`);
    for (const [i, x] of pick.entries()) {
      await ff(['-ss', String((x.s + x.e) / 2), '-i', file, '-frames:v', '1', '-vf', `scale=320:180:force_original_aspect_ratio=increase,crop=320:180,drawtext=text='${i + 1}':x=6:y=4:fontsize=34:fontcolor=yellow:box=1:boxcolor=black@0.75:boxborderw=4,format=yuvj420p`, `${tag}-${String(i).padStart(2, '0')}.jpg`]);
    }
    await ff(['-framerate', '1', '-i', `${tag}-%02d.jpg`, '-vf', `tile=4x${Math.ceil(pick.length / 4)}:padding=4:color=white`, '-frames:v', '1', `${tag}.jpg`]);
    const ev = await claudeStep({
      prompt: `Lee la imagen ${path.basename(tag)}.jpg: es una rejilla numerada (1-${pick.length}) con un fotograma 16:9 de cada escena de ${real ? 'un vídeo real del que habla la noticia' : 'un tráiler o escena de anime'} (${context}).
Para CADA una de las ${pick.length} escenas devuelve en "scenes":
- "n" (número),
- "desc" (qué se ve exactamente, ≤ 14 palabras, concreto),
- "who" (qué personaje o persona sale, por su nombre si lo reconoces por el anime y la historia, o una descripción breve: «chica pelirroja con delantal»; vacío si no sale nadie),
- "shot" (primer plano | plano medio | plano general | detalle),
- "action" (0 quieto … 3 mucha acción),
- "emotion" (una palabra),
- "focusX" (0.0 a 1.0: posición horizontal de la cara, personaje o acción principal en el fotograma 16:9: 0.25 izquierda, 0.5 centro, 0.75 derecha; donde debe apuntar la cámara al recortar a vertical 9:16),
- "focusY" (0.0 a 1.0: posición vertical de la cara o sujeto principal: 0.3 arriba, 0.5 centro, 0.7 abajo),
- "layout" ("full" | "card": usa "full" casi siempre para que la escena llene la pantalla vertical centrada en focusX; usa "card" SOLO si hay dos personajes separados en los extremos izquierdo y derecho interactuando o si es un vídeo real/comparativa donde recortar los lados rompería lo que se muestra).
En "thumb" hasta 2 números de escenas que serían una buena miniatura (primer plano con emoción clara, nítido).
En "bad" las que NO sirven: texto grande o en el centro (títulos, créditos, fechas, logos, carteles, portadas de manga o títulos japoneses), retículas/miras/interfaz gráfica que cubran la imagen, viñetas o páginas de manga, dibujos en blanco y negro, imágenes estáticas promocionales con texto, ${real ? '' : 'personas reales, webcams o anuncios, '}pantallas negras o casi vacías, muy borrosas. Acepta solo fotogramas ${real ? 'nítidos del vídeo (personas, lugares y objetos reales valen)' : 'de animación a color'}, sin texto dominante; los subtítulos pequeños abajo no importan (se recortan).`,
      schema: {
        type: 'object',
        properties: {
          scenes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                n: { type: 'number' }, desc: { type: 'string' }, who: { type: 'string' }, shot: { type: 'string' },
                action: { type: 'number' }, emotion: { type: 'string' },
                focusX: { type: 'number' }, focusY: { type: 'number' }, layout: { type: 'string', enum: ['full', 'card'] },
              },
              required: ['n', 'desc', 'who', 'shot', 'action', 'emotion', 'focusX', 'focusY', 'layout'],
            },
          },
          thumb: { type: 'array', items: { type: 'number' } }, bad: { type: 'array', items: { type: 'number' } },
        },
        required: ['scenes', 'thumb', 'bad'],
      },
      system: 'Eres editor de vídeo y experto en anime. Miras imágenes con la herramienta Read.', effort: 'low', tools: ['Read'], cwd: dir,
    }, () => {}, () => {}).catch(() => ({ data: {} }));
    for (const n of ev.data.bad ?? []) bad.add(b + Number(n) - 1);
    // «ninguno», «nadie», «-»… = no sale nadie
    for (const d of ev.data.scenes ?? []) {
      const x = pick[d.n - 1];
      if (x) {
        Object.assign(x, {
          desc: d.desc,
          who: /^(ningun[oa]?|nadie|none|n\/a|-|—|sin personajes?)$/i.test(String(d.who ?? '').trim()) ? '' : d.who,
          shot: d.shot,
          action: d.action,
          emotion: d.emotion,
          focusX: clamp(d.focusX, 0, 1, 0.5),
          focusY: clamp(d.focusY, 0, 1, 0.38),
          layout: d.layout === 'card' ? 'card' : 'full',
        });
      }
    }
    (ev.data.thumb ?? []).forEach((n, r) => { if (pick[n - 1]) pick[n - 1].thumb = r + 1 + b; });
  }
  const good = all.filter((x, i) => !bad.has(i));
  for (const x of good) { x.desc ||= 'escena del anime'; x.hash = await dhash(file, (x.s + x.e) / 2); }
  log(`👀 Escenas del tráiler: ${good.length} útiles de ${all.length} (${good.filter((x) => x.desc !== 'escena del anime').length} descritas)`);
  return good;
}

/**
 * Analiza las imágenes descargadas viendo cada foto entera sin recortar (con sus proporciones reales):
 * obtiene dimensiones (w, h), describe qué se ve realmente, sitúa el punto focal (focusX, focusY) y decide si
 * debe mostrarse a pantalla completa ('full', recortada en focusX/focusY) o en encuadre completo ('card', sobre
 * fondo desenfocado para no amputar los lados cuando es una foto horizontal de una persona, entrevista, grupo o noticia).
 */
export async function catalogImages(items, context, dir, log) {
  if (!items.length) return [];
  const valid = [];
  for (const it of items) {
    try {
      const [w, h] = (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', it.file])).trim().split(',').map(Number);
      if (w >= 250 && h >= 250) valid.push({ ...it, w, h });
    } catch {}
  }
  if (!valid.length) return [];
  const out = [];
  for (let b = 0; b < valid.length; b += 12) {
    const batch = valid.slice(b, b + 12);
    const tag = path.join(dir, `imgcat-v1-${b}-${path.basename(batch[0].file, path.extname(batch[0].file))}`);
    for (const [i, x] of batch.entries()) {
      await ff(['-i', x.file, '-frames:v', '1', '-vf', `scale=320:220:force_original_aspect_ratio=decrease,pad=320:220:(ow-iw)/2:(oh-ih)/2:color=black,drawtext=text='${i + 1}':x=6:y=4:fontsize=30:fontcolor=yellow:box=1:boxcolor=black@0.75:boxborderw=4,format=yuvj420p`, `${tag}-${String(i).padStart(2, '0')}.jpg`]);
    }
    await ff(['-framerate', '1', '-i', `${tag}-%02d.jpg`, '-vf', `tile=4x${Math.ceil(batch.length / 4)}:padding=4:color=white`, '-frames:v', '1', `${tag}.jpg`]);
    const ev = await claudeStep({
      prompt: `Lee la imagen ${path.basename(tag)}.jpg: son ${batch.length} imágenes numeradas (vistas enteras con sus bordes reales) para un short sobre: ${context}.
Búsqueda o rol de cada una: ${batch.map((x, i) => `${i + 1}: ${x.hint || x.desc || 'imagen'}`).join(' · ')}.
Para CADA imagen (1-${batch.length}) devuelve en "photos":
- "n" (número),
- "desc" (qué se ve de verdad en la imagen, ≤ 14 palabras),
- "who" (quién o qué personaje/persona real aparece; vacío si no hay),
- "shot" (primer plano | plano medio | plano general | detalle | foto),
- "focusX" (0.0 a 1.0: posición horizontal de la cara o elemento principal),
- "focusY" (0.0 a 1.0: posición vertical de la cara o elemento principal),
- "layout" ("full" | "card": usa "card" si la imagen es horizontal/apaisada y muestra a una persona real, entrevista, varios personajes a lo ancho, un post/noticia o un objeto ancho que se cortaría mal al pasar a vertical 9:16; usa "full" si es vertical o si un recorte vertical centrado en focusX muestra al personaje principal limpio y completo),
- "bad" (true si es solo un logo genérico de una web, imagen rota/borrosa, página de manga en blanco y negro o no tiene relación con la historia).`,
      schema: {
        type: 'object',
        properties: {
          photos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                n: { type: 'number' }, desc: { type: 'string' }, who: { type: 'string' }, shot: { type: 'string' },
                focusX: { type: 'number' }, focusY: { type: 'number' }, layout: { type: 'string', enum: ['full', 'card'] }, bad: { type: 'boolean' },
              },
              required: ['n', 'desc', 'who', 'shot', 'focusX', 'focusY', 'layout', 'bad'],
            },
          },
        },
        required: ['photos'],
      },
      system: 'Eres director de fotografía y editor de shorts verticales. Miras imágenes con la herramienta Read.', effort: 'low', tools: ['Read'], cwd: dir,
    }, () => {}, () => {}).catch(() => ({ data: {} }));
    for (const [i, x] of batch.entries()) {
      const d = (ev.data.photos ?? []).find((p) => Number(p.n) === i + 1);
      if (d?.bad) continue;
      const isWideSpecific = (x.line != null || x.news) && x.w > x.h * 1.15;
      out.push({
        ...x,
        desc: d?.desc || x.desc || 'imagen de apoyo',
        who: /^(ningun[oa]?|nadie|none|n\/a|-|—)$/i.test(String(d?.who ?? '').trim()) ? (x.who ?? '') : (d?.who || x.who || ''),
        shot: d?.shot || x.shot || 'foto',
        focusX: clamp(d?.focusX, 0, 1, 0.5),
        focusY: clamp(d?.focusY, 0, 1, 0.4),
        layout: d?.layout === 'card' || isWideSpecific ? 'card' : 'full',
      });
    }
  }
  return out;
}

// ---------- tiempos ----------
/** Inicio y fin de cada frase del guion a partir de las palabras alineadas (con re-sincronización si Whisper parte o une una palabra). */
export function lineTimes(lines, words, total) {
  let k = 0;
  return lines.map((l, i) => {
    const tokens = String(l.text).split(/\s+/).map(norm).filter(Boolean);
    if (i > 0 && tokens.length && k < words.length) {
      const first = tokens[0];
      let best = k;
      for (let off = 0; off <= 8; off++) {
        for (const cand of [k + off, k - off]) {
          if (cand <= 0 || cand >= words.length) continue;
          const wClean = norm(words[cand].w);
          if (wClean === first || (first.length >= 4 && (wClean.startsWith(first.slice(0, 4)) || first.startsWith(wClean.slice(0, 4))))) {
            best = cand;
            off = 99;
            break;
          }
        }
      }
      k = best;
    }
    const s = i ? (words[k]?.s ?? total) : 0;
    k += tokens.length;
    return { ...l, s };
  }).map((l, i, a) => ({ ...l, e: a[i + 1]?.s ?? total }));
}

// ---------- subtítulos (lib/subs.js) ----------
const subtitles = (words, script, total) => assDoc({ events: wordEvents(words, script, total), brand: BRAND, total });

// ---------- montaje ----------
/** Clip de un corte.
 *  - Modo 'full': encuadre vertical 9:16 apuntando directamente al punto focal (focusX, focusY) y situando las caras en
 *    el tercio medio-superior (42 % de la altura) para que los subtítulos (y = 1150) nunca las tapen.
 *  - Modo 'card' (Cinema Card): para fotos horizontales, pruebas, noticias o planos donde importa todo el ancho; muestra
 *    el 100 % de la imagen/escena enmarcada con borde y sombra en y = 600 sobre un fondo en movimiento desenfocado.
 *  - emph: segundo del corte en que suena una palabra resaltada → acercamiento rápido («punch-in») desde ahí. */
export async function renderCut(c, item, uses, out) {
  const dur = +(c.e - c.s).toFixed(3);
  const frames = Math.max(1, Math.round(dur * FPS));
  if (!item) throw new Error(`El editor no asignó material al corte ${c.i + 1}`);

  const len = item.kind === 'video' ? item.e - item.s : 0;
  const lo = item.kind === 'video' ? item.s + Math.min(0.2, len / 6) : 0;
  const room = item.kind === 'video' ? Math.max(0, item.e - Math.min(0.2, len / 6) - lo - dur) : 0;
  const mid = item.kind === 'video' ? Math.min(Math.max(lo, (item.s + item.e) / 2 - dur / 2), lo + room) : 0;
  const start = len > dur ? (uses ? lo + ((uses * 0.618) % 1) * room : mid) : (item.s || 0);

  // 1) Encuadre inteligente automático con detección de caras de anime
  const framing = await computeSmartFraming(item, start, dur);
  const fx = framing.focusX;
  const fy = framing.focusY;
  const layout = framing.layout;

  // En zoompan: sobre una imagen fija (`d=frames`) el contador de fotograma es `on`; sobre vídeo (`d=1`) es `in`.
  const punchAt = c.emph == null ? null : Math.max(0, Math.round(c.emph * FPS));
  const punchDur = Math.max(1, Math.round(FPS * 0.12));

  if (item.kind === 'image') {
    // 2) Escalado neuronal Real-ESRGAN para imágenes (manga, arte, noticias)
    const sharpFile = await upscaleImage(item.file, path.dirname(out), 2);
    const punchImg = punchAt == null ? '' : `if(gte(on,${punchAt}),0.10*(1-pow(max(0,1-(on-${punchAt})/${punchDur}),3)),0)`;

    if (layout === 'card') {
      const ratio = item.w && item.h ? item.w / item.h : 16 / 9;
      const cardW = ratio < 1.08 ? 840 : 996;
      const cardH = Math.min(840, Math.max(460, Math.round(cardW / ratio / 2) * 2));
      const zFg = punchImg ? `min(1.15,1+0.05*on/${frames}+${punchImg})` : `1+0.05*on/${frames}`;
      const vf = [
        `split[bg0][fg0]`,
        `[bg0]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos+accurate_rnd,crop=${W}:${H}:'max(0,min(iw-ow,iw*${fx}-ow/2))':'max(0,min(ih-oh,ih*${fy}-oh/2))',zoompan=z='1+0.04*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS},boxblur=28:3,eq=brightness=-0.28:saturation=0.85[bg]`,
        `[fg0]scale=${cardW * 2}:${cardH * 2}:force_original_aspect_ratio=increase:flags=lanczos+accurate_rnd,crop=${cardW * 2}:${cardH * 2}:'max(0,min(iw-ow,iw*${fx}-ow/2))':'max(0,min(ih-oh,ih*${fy}-oh/2))',cas=0.42,zoompan=z='${zFg}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${cardW}x${cardH}:fps=${FPS},pad=iw+8:ih+8:4:4:color=white@0.88,pad=iw+28:ih+28:14:14:color=black@0.45[fg]`,
        `[bg][fg]overlay=(W-w)/2:600-(h/2),format=yuv420p`,
      ].join(';');
      await ff(['-i', sharpFile, '-vf', vf, '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', out]);
      return;
    }
    const z = punchImg ? `min(1.16,1+0.05*on/${frames}+${punchImg})` : `1+0.05*on/${frames}`;
    await ff(['-i', sharpFile, '-vf', `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase:flags=lanczos+accurate_rnd,crop=${W * 2}:${H * 2}:'max(0,min(iw-ow,iw*${fx}-ow/2))':'max(0,min(ih-oh,ih*${fy}-oh*0.38))',cas=0.42,zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS},format=yuv420p`, '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', out]);
    return;
  }

  const slow = Math.max(1, dur / Math.max(0.5, len));
  const punchVid = punchAt == null ? '' : `if(gte(in,${punchAt}),0.10*(1-pow(max(0,1-(in-${punchAt})/${punchDur}),3)),0)`;

  if (layout === 'card') {
    const cardW = 996, cardH = 560;
    const zoomFg = punchVid ? `,zoompan=z='min(1.10,1+${punchVid})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${cardW}x${cardH}:fps=${FPS}` : '';
    const vf = [
      `setpts=${slow.toFixed(3)}*(PTS-STARTPTS),fps=${FPS},split[bg0][fg0]`,
      `[bg0]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos+accurate_rnd,crop=${W}:${H}:'max(0,min(iw-ow,iw*${fx}-ow/2))':'max(0,min(ih-oh,ih*${fy}-oh/2))',boxblur=28:3,eq=brightness=-0.28:saturation=0.85[bg]`,
      `[fg0]scale=${cardW}:${cardH}:flags=lanczos+accurate_rnd,cas=0.42${zoomFg},pad=iw+8:ih+8:4:4:color=white@0.88,pad=iw+28:ih+28:14:14:color=black@0.45[fg]`,
      `[bg][fg]overlay=(W-w)/2:600-(h/2),format=yuv420p`,
    ].join(';');
    await ff(['-ss', String(start), '-t', String(dur / slow + 0.05), '-i', item.file, '-an', '-vf', vf, '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out]);
    return;
  }

  // 3) En vídeo 9:16: encuadre inteligente sobre la cara, escala ajustada sin exceso de zoom + nitidez CAS
  const shiftX = uses ? clamp(fx + ((uses % 2 ? 1 : -1) * 0.06), 0.15, 0.85, fx) : fx;
  const zoom = punchVid ? `,zoompan=z='min(1.10,1+${punchVid})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}` : '';
  const vf = [
    `setpts=${slow.toFixed(3)}*(PTS-STARTPTS),fps=${FPS}`,
    `scale=-2:${H}:force_original_aspect_ratio=increase:flags=lanczos+accurate_rnd`,
    `crop=${W}:${H}:'max(0,min(iw-ow,iw*${shiftX.toFixed(3)}-ow/2))':'max(0,min(ih-oh,ih*${fy.toFixed(3)}-oh*0.38))'`,
    `cas=0.42${zoom}`,
    `format=yuv420p`,
  ].join(',');
  await ff(['-ss', String(start), '-t', String(dur / slow + 0.05), '-i', item.file, '-an', '-vf', vf, '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out]);
}

/**
 * script: { lines: [{ text, show, query, visual }], scene_query, yellow, red }, voice: mp3, words: [{ w, s, e }] (alineadas);
 * context: de qué va (historia y personajes). Devuelve { video, thumb }.
 */
export async function montage({ script, voice, words, duration, dir, name = 'short', thumb = null, context = '', sources: news = [], episode = null }, log, signal) {
  await mkdir(dir, { recursive: true });
  const total = duration + 0.3;
  const lines = lineTimes(script.lines, words, total);
  // catálogo: escenas de los tráileres de cada anime del guion, escena clave (scene_query) y fotos verificadas con encuadre
  const catalog = [];
  const rawImages = [];
  // historia atemporal sobre un momento concreto: las escenas del propio episodio en vez del tráiler genérico
  const ep = episode?.episode > 0 ? await episodeScenes(episode, dir, log, context, '90-160')
    .catch((e) => { log(`⚠️ Sin episodio (${e.message.slice(0, 120)}): uso tráileres`); return null; }) : null;
  ep?.scenes.forEach((x) => catalog.push({ ...x, kind: 'video', anime: episode.anime, id: `V${catalog.length + 1}` }));
  const enough = (ep?.scenes.length ?? 0) >= 12;
  const animes = enough ? [] : [...new Set(script.lines.filter((l) => l.show === 'anime').map((l) => l.query))];
  // un guion solo con «video»/«imagen» se quedaba sin material si esas búsquedas fallaban: el tráiler de la franquicia es la base
  if (!enough && !animes.length && script.franchise?.trim()) animes.push(script.franchise.trim());
  const sources = new Map();
  for (const q of animes) {
    const t = await trailer(q, dir, log, context).catch((e) => { log(`⚠️ ${e.message}: uso imágenes`); return null; });
    sources.set(q, t);
    if (t) t.scenes.forEach((x) => catalog.push({ ...x, kind: 'video', anime: q, id: `V${catalog.length + 1}` }));
    else {
      const clean = `${q} anime official artwork clean no text`;
      (await pickRelevant(await images(clean, dir), clean, context, dir)).forEach((f) => rawImages.push({ kind: 'image', file: f, anime: q, desc: `imagen de ${q}`, hint: `arte oficial de ${q}`, who: 'personajes del anime', shot: 'plano medio', action: 1 }));
    }
    // Más variedad: arte promocional limpio.
    for (const extra of [`${q} anime official key visual clean no text`]) {
      for (const f of (await pickRelevant(await images(extra, dir), extra, context, dir)).slice(0, 3)) rawImages.push({ kind: 'image', file: f, anime: q, desc: `arte oficial de ${q}`, hint: `arte oficial de ${q}`, who: 'personajes del anime', shot: 'plano medio', action: 1 });
    }
  }
  // Si el guion gira en torno a una escena, pelea o final concreto del anime (scene_query), buscamos también ese clip exacto
  if (!enough && script.scene_query?.trim() && !animes.some((a) => norm(a) === norm(script.scene_query))) {
    const sq = script.scene_query.trim();
    const st = await trailer(sq, dir, log, context, true).catch((e) => { log(`ℹ️ Escena específica «${sq}»: ${e.message.slice(0, 90)}`); return null; });
    if (st) st.scenes.forEach((x) => catalog.push({ ...x, kind: 'video', anime: animes[0] ?? sq, id: `V${catalog.length + 1}`, desc: `escena clave (${sq}): ${x.desc ?? ''}` }));
  }
  for (const [line, l] of script.lines.entries()) if (l.show === 'imagen') {
    const isMangaCover = /manga\s*(cover|portada)|portada\s*(del|de)?\s*manga/i.test(l.query);
    const query = isMangaCover
      ? `${animes[0] ?? l.query} anime official key visual clean no text`
      : l.query;
    const picked = await pickRelevant(await images(query, dir), query, `${context}. Frase: ${l.text}. Visual buscado: ${l.visual || l.query}`, dir, { specific: !isMangaCover });
    picked.slice(0, 3).forEach((f) => rawImages.push({ kind: 'image', file: f, line, desc: l.visual || l.query, hint: `${l.query} (${l.visual || l.text})`, shot: 'foto', action: 0 }));
  }
  // lo que se cuenta, tal cual: el vídeo concreto de las frases «video» y la foto de cada noticia
  const videoLines = [...script.lines.entries()].filter(([, l]) => l.show === 'video');
  for (const [line, l] of videoLines.filter(([, l], k) => videoLines.findIndex(([, m]) => norm(m.query) === norm(l.query)) === k).slice(0, 2)) {
    const t = await trailer(l.query, dir, log, `${context}. Mostrar: ${l.visual || l.text}`, true).catch((e) => { log(`⚠️ Vídeo «${l.query}»: ${e.message.slice(0, 100)}`); return null; });
    if (t) t.scenes.forEach((x) => catalog.push({ ...x, kind: 'video', line, id: `V${catalog.length + 1}`, desc: `vídeo «${l.query}»: ${x.desc ?? ''}` }));
    else {
      const picked = await pickRelevant(await images(l.query, dir), l.query, `${context}. Mostrar: ${l.visual || l.text}`, dir, { specific: true });
      picked.slice(0, 3).forEach((f) => rawImages.push({ kind: 'image', file: f, line, desc: l.visual || l.query, hint: `${l.query} (${l.visual || l.text})`, shot: 'foto', action: 0 }));
    }
  }
  const newsPics = await newsImages(news, dir);
  if (newsPics.length) log(`📰 ${newsPics.length} foto${newsPics.length === 1 ? '' : 's'} de las noticias: ${newsPics.map((n) => n.title.slice(0, 50)).join(' · ')}`);
  for (const n of newsPics) rawImages.push({ kind: 'image', file: n.file, news: true, desc: `foto de la noticia: ${n.title}`, hint: `noticia: ${n.title}`, who: '', shot: 'foto', action: 0 });

  // Catalogar todas las imágenes viendo su proporción real para fijar focusX, focusY y layout ('full' vs 'card')
  const checkedImages = await catalogImages(rawImages, context, dir, log);
  for (const img of checkedImages) catalog.push({ ...img, id: `F${catalog.length + 1}`, hash: img.hash || await dhash(img.file) });

  if (!catalog.length) throw new Error('Sin escenas ni imágenes para montar');
  let takes = groupTakes(catalog);
  const target = 1.9;
  const slots = cutSlots(lines, words, script, { min: 1.3, target, max: 2.6, hook: 2 });

  // Si hay menos tomas que cortes, enriquecemos inmediatamente con viñetas del manga y arte oficial
  // para GARANTIZAR que cada corte tenga contenido fresco y coherente sin repetir escenas
  // poco material propio (un juego, una colaboración): escenas del tráiler de la franquicia antes que repetir
  const franchise = script.franchise?.trim();
  if (takes < slots.length && franchise && !animes.some((a) => norm(a) === norm(franchise))) {
    const t = await trailer(franchise, dir, log, context).catch((e) => { log(`⚠️ ${e.message}`); return null; });
    if (t) { t.scenes.forEach((x) => catalog.push({ ...x, kind: 'video', anime: franchise, id: `V${catalog.length + 1}` })); takes = groupTakes(catalog); }
  }
  if (takes < slots.length) {
    log(`📚 Enriqueciendo catálogo visual con escenas del manga y arte oficial (${takes} tomas para ${slots.length} cortes)…`);
    const extraImgs = [];
    for (const [i, line] of script.lines.entries()) {
      const qManga = `${animes[0] ?? ''} manga panel ${line.query || line.text.slice(0, 30)} clean`;
      const qArt = `${animes[0] ?? ''} anime official character art ${line.query || ''} clean`;
      for (const q of [qManga, qArt]) {
        const found = await images(q, dir).catch(() => []);
        const picked = await pickRelevant(found, q, `${context}. Frase: ${line.text}`, dir, { specific: true }).catch(() => []);
        picked.slice(0, 1).forEach((f) => extraImgs.push({ kind: 'image', file: f, line: i, desc: `manga/arte: ${line.text.slice(0, 35)}`, hint: `${q}`, shot: 'foto', action: 1 }));
      }
      if (catalog.length + extraImgs.length >= slots.length * 1.5) break;
    }
    const checkedExtra = await catalogImages(extraImgs, context, dir, log);
    for (const img of checkedExtra) catalog.push({ ...img, id: `F${catalog.length + 1}`, hash: img.hash || await dhash(img.file) });
    takes = groupTakes(catalog);
  }

  log(`🎬 Editor IA: ${slots.length} cortes de ~${target.toFixed(1)} s con ${catalog.length} planos (${takes} tomas distintas)…`);
  const { plan, climax, motion } = await planEdit({ slots, lines, catalog, context }, log);
  const byId = new Map(catalog.map((c) => [c.id, c]));
  // el gancho (2 primeros s): si el editor dejó algún corte del arranque sin personaje ni material específico de la frase,
  // lo cubrimos con primeros planos potentes de personajes distintos
  const faces = catalog.filter((c) => c.kind !== 'image' && c.who && /primer/i.test(c.shot ?? '')).sort((a, b) => (b.action ?? 0) - (a.action ?? 0));
  slots.forEach((x, i) => {
    const cur = byId.get(plan[i]);
    if (x.s < 2 && faces[i] && cur?.line == null && !cur?.who) plan[i] = faces[i].id;
  });
  const uses = new Map();
  const parts = [];
  const render = async (i) => {
    const id = plan[i];
    const k = uses.get(id) ?? 0;
    uses.set(id, k + 1);
    const out = path.join(dir, `cut-${name}-${String(i).padStart(3, '0')}.mp4`);
    await renderCut(slots[i], byId.get(id), k, out);
    parts[i] = out;
  };
  for (let i = 0; i < slots.length; i++) { if (signal?.aborted) throw new Error('Cancelado'); await render(i); }
  // revisión final: la IA mira el montaje y rehace los cortes que fallan
  const frames = [];
  for (const [i, p] of parts.entries()) { const f = `${p}.jpg`; await ff(['-ss', String((slots[i].e - slots[i].s) / 2), '-i', p, '-frames:v', '1', f]); frames.push(f); }
  const fixes = await reviewEdit({ frames, slots, lines, plan, catalog, context, dir });
  for (const [i, f] of Object.entries(fixes)) plan[i] = f.id;
  // los reemplazos tampoco pueden repetir toma cerca: se vuelven a aplicar las reglas y se rehace lo que cambie
  const before = [...plan];
  enforce(plan, catalog, { slotLines: slots.map((x) => x.line) }).plan.forEach((id, i) => { plan[i] = id; });
  for (let i = 0; i < plan.length; i++) if (fixes[i] || plan[i] !== before[i]) await render(i);
  const tx = planTransitions({ slots, lines, plan, byId, motion, climax });
  await applyPairTransitions(parts, slots, tx.transitions, { fps: FPS, w: W, h: H });
  log(`✂️ ${parts.length} cortes montados${Object.keys(fixes).length ? ` · revisión: ${Object.keys(fixes).length} rehecho${Object.keys(fixes).length === 1 ? '' : 's'} (${Object.values(fixes).map((f) => f.why).join('; ').slice(0, 160)})` : ' · revisión: todo bien'}`);
  const list = path.join(dir, `cuts-${name}.txt`);
  await writeFile(list, parts.map((p) => `file '${p}'`).join('\n'));
  const ass = path.join(dir, `subs-${name}.ass`);
  await writeFile(ass, subtitles(words, script, total));
  // miniatura: del mejor primer plano del anime principal (o del primer corte si solo hubo imágenes)
  const main = animes[0] ?? script.lines[0].query;
  const scenes = sources.get(main)?.scenes ?? [{ file: parts[0], s: 0, e: 1 }];
  thumb ??= await makeThumb({ script, anime: main, scenes, dir, context }, log, signal); // la versión TikTok reutiliza la de YouTube
  // sonido: ding en gancho/remate, pop en acercamientos, shutter en imágenes, whoosh en barridos/zoom y riser+golpe en el clímax
  const sfx = await sfxTrack({ whooshAt: tx.whooshAt, flashAt: tx.flashAt, impactAt: tx.impactAt, slots, lines, total, dir }).catch(() => null);
  const final = path.join(dir, `${name}.mp4`);
  // el primer fotograma es la miniatura: solo 2 fotogramas, para poder elegirla de portada sin que se vea una tarjeta
  // fija al empezar (medido en TikTok: la gente se va en el segundo 0:01-0:02)
  await ff(['-f', 'concat', '-safe', '0', '-i', list, '-i', voice, '-loop', '1', '-t', String(total), '-i', thumb.small, ...(sfx ? ['-i', sfx] : []),
    '-filter_complex', `[0:v]subtitles=${ass}:fontsdir=${FONTS}[v];[2:v]scale=${W}:${H}[t];[v][t]overlay=enable='lt(t,0.066)'[o]${sfx ? ';[3:a]volume=0.45[s];[1:a][s]amix=inputs=2:normalize=0:duration=first[a]' : ''}`,
    '-map', '[o]', '-map', sfx ? '[a]' : '1:a',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-t', String(total), '-movflags', '+faststart', final]);
  const qa = await finalReview(final, total).catch(() => null);
  if (qa) log(fmtQa(qa));
  return { video: final, thumb, qa };
}
