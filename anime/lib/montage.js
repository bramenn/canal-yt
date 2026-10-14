// Montaje del short vertical (1080×1920) con ffmpeg: cortes de 2-3 s sobre escenas del tráiler/PV del anime
// (recortadas a 9:16, sin fundidos a negro, logos ni créditos) o imágenes con desplazamiento, la voz y subtítulos
// ASS de 1-2 palabras (Anton, blanco con borde, palabras clave en amarillo/rojo, «pop» al entrar) + marca del canal.
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { run, ytdlp, search } from '../../lib/ytdlp.js';
import { searchImages, UA } from '../../lib/brave.js';
import { claudeStep } from '../../lib/claude.js';
import { FONTS } from '../../lib/thumbnail.js';
import { makeThumb } from './thumb.js';

export const BRAND = '@notianimes';
const W = 1080, H = 1920, FPS = 30;
const CUT = 2.6;                           // duración objetivo de cada corte
// vídeos de reacción/análisis: salen personas, webcams y anuncios encima del anime
const REACTION = /react|reacci|reaccion|analysis|análisis|analisis|explained|review|resumen|theory|teoría/i;
const ff = (args, timeout = 600000) => run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], timeout);
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]/g, '');

// ---------- fuentes ----------
/** Escenas limpias de los tráileres/PV del anime en YouTube (vídeos hasta tener ~20, máx. 4; una vez por anime y proyecto). */
async function trailer(query, dir, log) {
  const slug = norm(query).slice(0, 40) || 'anime';
  const scenesFile = path.join(dir, `tr-${slug}.json`);
  if (existsSync(scenesFile)) return { scenes: JSON.parse(await readFile(scenesFile, 'utf8')) };
  // primero el PV japonés (sin subtítulos); anuncios nuevos aún no tienen tráiler: opening o cada parte del nombre
  const parts = String(query).split(/\s+(?:x|×|&|y)\s+|:\s*/i).filter((x) => x.trim() && x !== query);
  const tries = [`${query} PV`, `${query} anime trailer`, `${query} anime opening`, ...parts.map((x) => `${x} anime PV`)];
  const scenes = [], seen = new Set();
  let videos = 0, err = null, first = null;
  // YouTube corta a ratos (403): otro formato y, si no, el siguiente vídeo
  find: for (const q of tries) {
    for (const cand of (await search(q, 8).catch(() => [])).filter((x) => x.duration >= 30 && x.duration <= 600 && !seen.has(x.id) && !REACTION.test(x.title)).slice(0, 2)) {
      seen.add(cand.id);
      const file = path.join(dir, `tr-${slug}-${videos}.mp4`);
      for (const fmt of ['bv*[height<=1080][vcodec^=avc1]/bv*[height<=1080]', 'bv*[height<=1080]/b']) {
        try {
          await ytdlp(['-q', '-f', fmt, '--merge-output-format', 'mp4', '-o', file, `https://www.youtube.com/watch?v=${cand.id}`], 300000);
        } catch (e) { err = e; continue; }
        log(`🎞 Tráiler de «${query}»: ${cand.title} (${cand.channel})`);
        videos++;
        first ??= { file, dur: cand.duration };
        scenes.push(...await withoutText(file, await scenesOf(file, cand.duration), dir, log).catch((e) => { log(`⚠️ Sin revisar escenas: ${e.message.slice(0, 120)}`); return []; }));
        break;
      }
      if (scenes.length >= 20 || videos >= 4) break find;
    }
  }
  if (!first) throw new Error(`No encuentro tráiler de «${query}»${err ? ` (${err.message.slice(0, 80)})` : ''}`);
  if (!scenes.length) scenes.push({ file: first.file, s: first.dur * 0.15, e: first.dur * 0.85 });
  // alternando vídeos: más variedad seguida
  scenes.sort((a, b) => a.s - b.s);
  await writeFile(scenesFile, JSON.stringify(scenes));
  return { scenes };
}

/** Planos del vídeo (cambios de escena), sin el principio (logos), el final (créditos) ni negros; los largos, en trozos. */
async function scenesOf(file, dur) {
  const out = await new Promise((resolve) => execFile('ffmpeg', ['-nostdin', '-i', file, '-an', '-vf', "scale=320:-2,blackdetect=d=0.1:pix_th=0.1,select='gt(scene,0.22)',showinfo", '-f', 'null', '-'],
    { maxBuffer: 64 << 20, timeout: 300000 }, (_e, _o, err) => resolve(String(err))));
  const cuts = [...out.matchAll(/pts_time:([\d.]+)/g)].map((m) => +m[1]);
  const blacks = [...out.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  const edges = [0, ...cuts, dur].sort((a, b) => a - b);
  return edges.slice(0, -1).map((s, i) => ({ file, s: s + 0.08, e: edges[i + 1] - 0.08 }))
    .filter((x) => x.e - x.s >= 1.2 && x.s > dur * 0.05 && x.e < dur * 0.92 && !blacks.some(([a, b]) => a < x.e && b > x.s))
    .flatMap((x) => { const n = Math.max(1, Math.floor((x.e - x.s) / (CUT * 1.2))); return Array.from({ length: n }, (_, k) => ({ file, s: x.s + ((x.e - x.s) * k) / n, e: x.s + ((x.e - x.s) * (k + 1)) / n })); });
}

/** La IA mira una rejilla con un fotograma de cada escena y quita las que tienen texto, subtítulos, créditos, logos o negro. */
async function withoutText(file, scenes, dir, log) {
  const pick = scenes.slice(0, 64);
  const tag = path.join(dir, `grid-${path.basename(file, '.mp4')}`);
  if (!pick.length) { log('👀 Escenas del tráiler: ninguna útil'); return []; }
  for (const [i, x] of pick.entries()) {
    await ff(['-ss', String((x.s + x.e) / 2), '-i', file, '-frames:v', '1', '-vf', `scale=240:135:force_original_aspect_ratio=increase,crop=240:135,drawtext=text='${i + 1}':x=6:y=4:fontsize=30:fontcolor=yellow:box=1:boxcolor=black@0.75:boxborderw=4,format=yuvj420p`, `${tag}-${String(i).padStart(2, '0')}.jpg`]);
  }
  await ff(['-framerate', '1', '-i', `${tag}-%02d.jpg`, '-vf', `tile=8x${Math.ceil(pick.length / 8)}:padding=4:color=white`, '-frames:v', '1', `${tag}.jpg`]);
  const ev = await claudeStep({
    prompt: `Lee la imagen ${path.basename(tag)}.jpg: es una rejilla numerada con un fotograma de cada escena de un tráiler de anime. Van a usarse como fondo de un short vertical con subtítulos propios. Devuelve en "thumb" hasta 3 números de escenas que serían la mejor miniatura de YouTube (primer plano de un personaje con una emoción clara —sorpresa, miedo, rabia, risa—, mirando hacia la cámara si es posible, nítido y con buena luz), de mejor a peor. Y en "bad" los números de las escenas que NO sirven: con cualquier texto superpuesto (títulos, créditos, fechas, logos, letreros del estudio, subtítulos quemados de cualquier tamaño), personas reales, webcams, anuncios o marcos de otro canal, pantallas negras o casi vacías, o muy borrosas. Sirven las escenas de animación limpias (personajes, acción, paisajes).`,
    schema: { type: 'object', properties: { thumb: { type: 'array', items: { type: 'number' } }, bad: { type: 'array', items: { type: 'number' } } }, required: ['thumb', 'bad'] },
    system: 'Eres editor de vídeo. Miras imágenes con la herramienta Read.', model: 'sonnet', effort: 'low', tools: ['Read'], cwd: dir,
  }, () => {}, () => {});
  const bad = new Set((ev.data.bad ?? []).map(Number));
  log(`👀 Escenas del tráiler: ${pick.length - bad.size} útiles de ${pick.length}`);
  // las mejores para miniatura llevan su puesto (1 = la mejor)
  (ev.data.thumb ?? []).forEach((n, r) => { if (pick[n - 1]) pick[n - 1].thumb = r + 1; });
  return pick.filter((_, i) => !bad.has(i + 1));
}

/** Hasta `max` imágenes descargables de Brave para la búsqueda (en caché por proyecto). */
async function images(query, dir, max = 6) {
  const base = path.join(dir, `img-${norm(query).slice(0, 40)}`);
  const listFile = `${base}.json`;
  if (existsSync(listFile)) return JSON.parse(await readFile(listFile, 'utf8'));
  const files = [];
  for (const it of (await searchImages(query, 600).catch(() => [])).slice(0, max * 2)) {
    if (files.length >= max) break;
    try {
      const r = await fetch(it.url, { headers: { 'User-Agent': UA, Accept: 'image/*' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok || !/^image\/(jpeg|png|webp)/.test(r.headers.get('content-type') ?? '')) continue;
      const raw = `${base}-src`;
      await writeFile(raw, Buffer.from(await r.arrayBuffer()));
      const file = `${base}-${files.length}.jpg`;
      await ff(['-i', raw, '-frames:v', '1', '-q:v', '2', file]);
      files.push(file);
    } catch {}
  }
  await writeFile(listFile, JSON.stringify(files));
  return files;
}

// ---------- tiempos ----------
/** Inicio y fin de cada frase del guion a partir de las palabras alineadas (por recuento de palabras). */
function lineTimes(lines, words, total) {
  let k = 0;
  return lines.map((l, i) => {
    const n = String(l.text).split(/\s+/).filter(Boolean).length;
    const s = i ? (words[k]?.s ?? total) : 0;
    k += n;
    return { ...l, s };
  }).map((l, i, a) => ({ ...l, e: a[i + 1]?.s ?? total }));
}

// ---------- subtítulos ----------
const assTime = (t) => { const cs = Math.max(0, Math.round(t * 100)); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; };
const assEsc = (s) => String(s).replace(/[{}\\]/g, '');

function subtitles(words, { yellow = [], red = [] }, total) {
  const Y = new Set(yellow.map(norm)), R = new Set(red.map(norm));
  // grupos de 1-2 palabras (corta en signos de puntuación y en palabras largas)
  const groups = [];
  for (let i = 0; i < words.length;) {
    const g = [words[i]];
    const a = words[i].w, b = words[i + 1]?.w;
    if (b && !/[.,;:!?…]$/.test(a) && (a + b).length <= 11 && !R.has(norm(a)) && !Y.has(norm(a))) g.push(words[i + 1]);
    groups.push(g); i += g.length;
  }
  const ev = groups.map((g, i) => {
    const s = g[0].s, e = Math.min(groups[i + 1]?.[0].s ?? total, g.at(-1).e + 0.5);
    const text = g.map((w) => {
      const c = R.has(norm(w.w)) ? '&H002D2DFF&' : Y.has(norm(w.w)) ? '&H001FD2FF&' : '&H00FFFFFF&';
      return `{\\c${c}}${assEsc(w.w.toUpperCase().replace(/[.,;:]+$/, ''))}`;
    }).join(' ');
    return `Dialogue: 0,${assTime(s)},${assTime(e)},Sub,,0,0,0,,{\\pos(540,1150)\\fscx70\\fscy70\\t(0,90,\\fscx100\\fscy100)}${text}`;
  });
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Anton,190,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,1,0,1,13,5,5,50,50,0,1
Style: Brand,Anton,76,&H40FFFFFF,&H40FFFFFF,&H60000000,&H00000000,0,0,0,0,100,100,1,0,1,5,0,7,46,46,70,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${ev.join('\n')}
Dialogue: 1,${assTime(0)},${assTime(total)},Brand,,0,0,0,,${BRAND}
`;
}

// ---------- montaje ----------
/**
 * script: { lines: [{ text, show, query }], yellow, red }, voice: ruta del mp3, words: [{ w, s, e }] (alineadas).
 * Devuelve la ruta del MP4 (en `dir`).
 */
export async function montage({ script, voice, words, duration, dir }, log, signal) {
  await mkdir(dir, { recursive: true });
  const total = duration + 0.3;
  const lines = lineTimes(script.lines, words, total);
  // cortes: cada frase en trozos de ~2,6 s
  const cuts = lines.flatMap((l) => {
    const n = Math.max(1, Math.round((l.e - l.s) / CUT));
    return Array.from({ length: n }, (_, k) => ({ ...l, s: l.s + ((l.e - l.s) * k) / n, e: l.s + ((l.e - l.s) * (k + 1)) / n }));
  });
  const sources = new Map();
  const used = new Map();
  const parts = [];
  for (const [i, c] of cuts.entries()) {
    if (signal?.aborted) throw new Error('Cancelado');
    const dur = +(c.e - c.s).toFixed(3);
    const out = path.join(dir, `cut-${String(i).padStart(3, '0')}.mp4`);
    const q = c.show === 'anime' ? c.query : script.lines.find((l) => l.show === 'anime')?.query ?? c.query;
    // el tráiler del anime; si no lo hay, imágenes del anime (distintas en cada corte)
    if (c.show !== 'imagen' && !sources.has(q)) sources.set(q, await trailer(q, dir, log).catch((e) => { log(`⚠️ ${e.message}: uso imágenes`); return null; }));
    const pool = c.show === 'imagen' ? await images(c.query, dir) : sources.get(q) ? [] : await images(`${q} anime`, dir);
    const k = used.get(c.show === 'imagen' ? c.query : q) ?? 0;
    const img = pool.length ? pool[k % pool.length] : null;
    if (c.show === 'imagen' || !sources.get(q)) used.set(c.show === 'imagen' ? c.query : q, k + 1);
    if (img) {
      // la imagen se desplaza despacio (alterna dirección)
      const dx = i % 2 ? '(iw-ow)*t/' + dur : '(iw-ow)*(1-t/' + dur + ')';
      await ff(['-loop', '1', '-t', String(dur), '-i', img, '-vf', `scale=${Math.round(W * 1.15)}:${Math.round(H * 1.15)}:force_original_aspect_ratio=increase,crop=${W}:${H}:x='${dx}':y='(ih-oh)/2',fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', out]);
    } else {
      if (!sources.has(q)) sources.set(q, await trailer(q, dir, log));
      const t = sources.get(q);
      if (!t) throw new Error(`Sin tráiler ni imágenes para «${q}»`);
      // la siguiente escena sin usar que dure lo suficiente (si se acaban, se repiten)
      const k = used.get(q) ?? 0;
      const fit = t.scenes.filter((x) => x.e - x.s >= Math.min(dur, 1.2));
      const sc = fit[k % fit.length] ?? t.scenes[k % t.scenes.length];
      used.set(q, k + 1);
      const start = sc.s + Math.max(0, (sc.e - sc.s - dur) / 2);
      // si la escena es más corta que el corte, se ralentiza un poco para cubrirlo
      const slow = Math.max(1, dur / Math.max(0.5, sc.e - sc.s));
      await ff(['-ss', String(start), '-t', String(dur / slow + 0.05), '-i', sc.file, '-an', '-vf', `setpts=${slow.toFixed(3)}*PTS,scale=${Math.round(W * 1.12)}:${Math.round(H * 1.12)}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-ow)/2:(ih-oh)*0.3,fps=${FPS},format=yuv420p`, '-t', String(dur), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out]);
    }
    parts.push(out);
  }
  log(`✂️ ${parts.length} cortes montados`);
  const list = path.join(dir, 'cuts.txt');
  await writeFile(list, parts.map((p) => `file '${p}'`).join('\n'));
  const ass = path.join(dir, 'subs.ass');
  await writeFile(ass, subtitles(words, script, total));
  // miniatura: del mejor primer plano del anime principal (o del primer corte si solo hubo imágenes)
  const main = script.lines.find((l) => l.show === 'anime')?.query ?? script.lines[0].query;
  const scenes = sources.get(main)?.scenes ?? [...sources.values()].find(Boolean)?.scenes ?? [{ file: parts[0], s: 0, e: 1 }];
  const thumb = await makeThumb({ script, anime: main, scenes, dir }, log, signal);
  const final = path.join(dir, 'short.mp4');
  // el primer fotograma es la miniatura (0,3 s: lo que se ve en búsquedas y en el perfil sin frenar el gancho)
  await ff(['-f', 'concat', '-safe', '0', '-i', list, '-i', voice, '-loop', '1', '-t', String(total), '-i', thumb.small,
    '-filter_complex', `[0:v]subtitles=${ass}:fontsdir=${FONTS}[v];[2:v]scale=${W}:${H}[t];[v][t]overlay=enable='lt(t,0.3)'[o]`, '-map', '[o]', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-t', String(total), '-movflags', '+faststart', final]);
  return { video: final, thumb };
}
