// Escenas del episodio exacto (en lugar de tráileres): busca el episodio en nyaa, lo baja con aria2 (sin quedarse
// compartiendo), lee sus subtítulos para encontrar el minuto en que pasa lo que cuenta el narrador, recorta esos tramos
// en 1080p y borra el episodio. Devuelve escenas catalogadas como las de un tráiler + una ráfaga de audio original.
import path from 'node:path';
import { mkdir, writeFile, readFile, readdir, rm, stat, statfs } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { run } from '../../lib/ytdlp.js';
import { claudeStep } from '../../lib/claude.js';
import { scenesOf, catalogScenes } from './montage.js';

const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const pad = (n) => String(n).padStart(2, '0');
const PY = process.env.ALIGN_PYTHON || path.resolve(import.meta.dirname, '../../.tools/venv/bin/python');
// sin capítulos ni pistas de datos: los .mkv traen capítulos que en .mp4 son una pista de texto, y piezas con y sin
// ella rompen el concat final (se quedaba en el primer corte)
const ff = (args, timeout = 600000) => run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args.slice(0, -1), '-map_chapters', '-1', '-dn', args.at(-1)], timeout);
const TRUSTED = /SubsPlease|Erai-raws|EMBER|Judas|ASW|Yameii|ToonsHub|DKB|neoDESU/i;

const TRACKERS = ['http://tracker.opentrackr.org:1337/announce', 'udp://tracker.opentrackr.org:1337/announce', 'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce', 'udp://tracker.torrent.eu.org:451/announce', 'http://open.tracker.cl:1337/announce'].join(',');
// rango de un pack («01-75», «1 ~ 25»); «Part 2 - 05» o «Season 2 - 05» son un episodio suelto, no un rango
const RANGE = /(?<!(?:part|season|cour|\bs)\s*)(?<!\d)(\d{1,4})\s*[-~]\s*(\d{1,4})/i;
const epRe = (ep) => new RegExp(`(?:\\s-\\s|\\bE|\\bEp\\.?\\s?|#|\\s)0*${ep}(?:v\\d)?(?=[\\s\\]\\[(._-]|$)`, 'i');

// temporada que trae el nombre de nyaa («Shingeki no Kyojin S3», «… Season 2», «… 2nd Season»); 0 = sin temporada
const SEASON = /\s*(?:\bS(\d{1,2})|\bSeason\s*(\d{1,2})|\b(\d{1,2})(?:st|nd|rd|th)\s+Season)\s*$/i;
export const seasonOf = (name) => +(String(name).match(SEASON)?.slice(1).find(Boolean) ?? 0);
const baseName = (name) => String(name).replace(SEASON, '').trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pausa (sin fallar) mientras no haya red o queden menos de minGB libres: el trabajo sigue solo cuando se arregla. */
export async function waitReady(dir, log = () => {}, { minGB = 5, signal } = {}) {
  for (let warned = false; ; warned = true) {
    if (signal?.aborted) throw new Error('Cancelado');
    const fs = await statfs(dir).catch(() => null);
    const free = fs ? (fs.bavail * fs.bsize) / 1e9 : Infinity;
    const net = await fetch('https://www.google.com/generate_204', { signal: AbortSignal.timeout(10000) }).then(() => true, () => false);
    if (net && free >= minGB) return;
    if (!warned) log(`⏸ ${net ? `Solo quedan ${free.toFixed(1)} GB libres (hacen falta ${minGB}): libera espacio y sigo solo` : 'Sin red: espero a que vuelva y sigo solo'}…`);
    await sleep(60000);
  }
}

async function rss(q) {
  const url = `https://nyaa.si/?page=rss&c=1_2&s=seeders&o=desc&q=${encodeURIComponent(q)}`;
  const xml = await (await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) })).text();
  const tag = (it, t) => it.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1] ?? '';
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => ({
    title: tag(it, 'title').replace(/&amp;/g, '&').replace(/&#34;/g, '"'),
    link: tag(it, 'link'),
    seeders: +tag(it, 'nyaa:seeders') || 0,
  })).filter((x) => x.link && x.seeders > 0);
}

/** Qué es un resultado de nyaa para el episodio pedido: null (no sirve), suelto o pack (y en qué temporada buscar dentro).
 * own: buscado con el nombre que ya lleva la temporada (o sin temporada); si no, con el nombre general de la serie. */
export function classify(title, name, ep, season = 0, own = true) {
  const bare = norm(title.replace(/^(\[[^\]]*\]\s*)+/, ''));
  // «[Grupo] Nombre - 24 (1080p)»: el nombre delante, para no confundir Naruto con Boruto - Naruto…
  if (!bare.startsWith(norm(name))) return null;
  const s = season || 1, batch = /batch|complete/i.test(title);
  // «Attack on Titan S03E19 (56)»: suelto si es justo esa temporada y episodio
  if (/\bS\d{1,2}\s?E\d{1,4}\b/i.test(title)) {
    return !batch && new RegExp(`\\bS0*${s}\\s?E0*${ep}(?!\\d)`, 'i').test(title) ? { pack: false, packSeason: 0 } : null;
  }
  // «(Season 1)» o «S01-S04»: si dice de qué temporadas es y la pedida no está, no sirve
  const marks = [...title.matchAll(/\b(?:S|Season\s*)0*(\d{1,2})(?:\s*[-~]\s*(?:S|Season\s*)?0*(\d{1,2}))?\b(?!\s?E\d)/gi)];
  if (marks.length && !marks.some((m) => s >= +m[1] && s <= +(m[2] ?? m[1]))) return null;
  // «Nombre - 05»: suelto solo con el nombre de la temporada; con el general sería el de la temporada 1
  if ((own || s === 1) && epRe(ep).test(title) && !RANGE.test(title) && !batch
    && [String(ep), pad(ep), String(ep).padStart(3, '0')].some((n) => bare.startsWith(norm(name) + n))) return { pack: false, packSeason: 0 };
  const packSeason = own ? 0 : season; // un pack con el nombre de la temporada ya es de esa temporada
  const r = title.match(RANGE);
  if (r) return +r[1] <= ep && ep <= +r[2] && !/\b(19|20)\d\d\b/.test(r[0]) ? { pack: true, packSeason } : null;
  // «Shingeki no Kyojin S1 (BD 1080p)»: pack de esa temporada
  if (new RegExp(`(?:\\bS|\\bSeason\\s*)0*${s}\\b(?!\\s?E\\d)`, 'i').test(title)) return { pack: true, packSeason: 0 };
  return batch ? { pack: true, packSeason } : null;
}

/** Torrents con ese episodio, de mejor a peor, buscando con todos los nombres de la serie (el primero, el que trae la
 * temporada). Pesan los seeders, 1080p y los grupos fiables; un pack algo menos que un suelto (se baja solo ese archivo). */
export async function findTorrents(names, ep, season = 0) {
  const score = (x) => x.seeders * (/1080p/i.test(x.title) ? 3 : /720p/i.test(x.title) ? 1.5 : 1) * (TRUSTED.test(x.title) ? 2 : 1) * (x.pack ? 0.5 : 1);
  const found = new Map();
  for (const [i, name] of names.entries()) {
    const sx = `S${pad(season || 1)}E${pad(ep)}`;
    for (const q of [`${name} ${pad(ep)} 1080p`, `${name} ${pad(ep)}`, `${name} ${sx}`, `${name} S${season || 1}`, `${name} batch`, `${name} complete`]) {
      const items = await rss(q).catch(async () => { await waitReady('/'); return rss(q).catch(() => []); });
      for (const x of items) {
        const c = !found.has(x.link) && classify(x.title, name, ep, season, i === 0);
        if (c) found.set(x.link, { ...x, ...c });
      }
    }
  }
  return [...found.values()].sort((a, b) => score(b) - score(a));
}

async function videosIn(dir) {
  const out = [];
  for (const f of await readdir(dir, { recursive: true }).catch(() => [])) {
    if (/\.(mkv|mp4)$/i.test(f)) out.push({ file: path.join(dir, f), size: (await stat(path.join(dir, f))).size });
  }
  return out.sort((a, b) => b.size - a.size);
}

/** Baja solo el archivo del episodio. Deja de compartir al terminar (--seed-time=0) y limita la subida mientras baja. */
async function download(t, ep, dl, log, season = 0) {
  await mkdir(dl, { recursive: true });
  const tfile = path.join(dl, 'ep.torrent');
  if (!existsSync(tfile)) await writeFile(tfile, Buffer.from(await (await fetch(t.link, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) })).arrayBuffer()));
  const args = ['--continue=true', '--seed-time=0', '--max-overall-upload-limit=100K', '--bt-stop-timeout=300', '--file-allocation=none',
    '--console-log-level=warn', '--summary-interval=0', '--follow-torrent=false', `--dir=${dl}`,
    // el tracker de nyaa no responde desde aquí: trackers públicos + DHT para encontrar peers
    `--bt-tracker=${TRACKERS}`, '--dht-entry-point=router.bittorrent.com:6881', '--enable-dht=true'];
  let want = null;
  if (t.pack) {
    // «  12|./Naruto/Naruto - 045 [...].mkv»
    const list = await run('aria2c', ['-S', tfile]);
    const files = [...list.matchAll(/^\s*(\d+)\|(.+)$/gm)].map((m) => ({ idx: m[1], path: m[2].trim(), name: path.basename(m[2].trim()) }))
      .filter((f) => /\.(mkv|mp4)$/i.test(f.name));
    const hit = packFile(files, ep, season);
    if (!hit) throw new Error(`el pack no trae el episodio ${ep}${season ? ` de la temporada ${season}` : ''}`);
    args.push(`--select-file=${hit.idx}`);
    want = hit.name;
  }
  log(`🧲 Bajando de nyaa: ${t.title} (${t.seeders} seeders)`);
  // si se corta la red o el disco se llena, espera y continúa donde quedó (la carpeta a medias no se borra)
  for (let i = 1; ; i++) {
    await waitReady(dl, log);
    try { await run('aria2c', [...args, tfile], 45 * 60000); break; } catch (e) {
      if (i >= 3) throw e;
      log(`🔁 Descarga interrumpida (${String(e.message).slice(0, 80)}): reintento ${i + 1}/3 desde donde quedó…`);
    }
  }
  // en un pack, aria2 deja los episodios vecinos a medias con su tamaño completo: se elige por nombre, no por tamaño
  const v = (await videosIn(dl)).find((x) => !want || path.basename(x.file) === want);
  if (!v) throw new Error('el torrent no dejó ningún vídeo');
  return v.file;
}

/** Archivo del episodio dentro de un pack. Con varias temporadas, el de la pedida (sin temporada: la 1); si no está, ninguno. */
export function packFile(files, ep, season = 0) {
  const sxe = (f) => f.name.match(/\bS(\d{1,2})\s?E(\d{1,4})\b/i);
  if (files.some(sxe)) return files.find((f) => { const m = sxe(f); return +m?.[1] === (season || 1) && +m[2] === ep; });
  const inSeason = (f) => season <= 1 || new RegExp(`\\b(?:Season\\s*|S)0*${season}\\b`, 'i').test(f.path);
  // los packs completos traen OVAs, películas y spin-offs («Junior High - 05»): solo la serie
  const extra = /\b(OVA|OAD|ONA|Movies?|Film|Specials?|Junior High|Picture Drama|Chibi)\b/i;
  return files.find((f) => inSeason(f) && !extra.test(f.path) && epRe(ep).test(f.name.replace(/\.(mkv|mp4)$/i, ' ')));
}

/** Subtítulos en inglés del mkv como [{ s, e, text }]. */
export async function subtitles(file, dir) {
  const streams = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 's', '-show_entries', 'stream=index,codec_name:stream_tags=language,title', '-of', 'json', file])).streams ?? [];
  // los PGS (imagen) no se pueden leer como texto
  const text = streams.filter((s) => !/pgs|dvd_sub|dvb/i.test(s.codec_name ?? ''));
  const eng = text.filter((s) => /^en/i.test(s.tags?.language ?? '') || !s.tags?.language);
  const t = (x) => { const [h, m, s] = x.replace(',', '.').split(':'); return +h * 3600 + +m * 60 + +s; };
  const read = async (st) => {
    let cues;
    if (/ass|ssa/i.test(st.codec_name ?? '')) {
      // ASS tal cual: los carteles animados y el karaoke del opening van fotograma a fotograma (decenas de miles de
      // líneas que llenaban el texto para la IA antes del diálogo); se reconocen por sus marcas de posición o de sílaba
      const ass = path.join(dir, `ep-${st.index}.ass`);
      await ff(['-i', file, '-map', `0:${st.index}`, '-c:s', 'copy', ass]);
      const typeset = /\\(pos|move|org|i?clip)\(|\\p[1-9]|\\[kK][fo]?\d|\\t\(/;
      cues = (await readFile(ass, 'utf8')).split(/\r?\n/).filter((l) => l.startsWith('Dialogue:')).map((l) => {
        const f = l.slice(9).split(',');
        const text = f.slice(9).join(',');
        return !f[8]?.trim() && !typeset.test(text) && { s: t(f[1].trim()), e: t(f[2].trim()), text: text.replace(/\{[^}]*\}/g, '').replace(/\\[Nnh]/g, ' ') };
      });
    } else {
      const srt = path.join(dir, `ep-${st.index}.srt`);
      await ff(['-i', file, '-map', `0:${st.index}`, '-c:s', 'srt', srt]);
      cues = (await readFile(srt, 'utf8')).split(/\r?\n\r?\n/).map((b) => {
        const m = b.match(/(\d+:\d+:\d+[,.]\d+)\s*-->\s*(\d+:\d+:\d+[,.]\d+)\s*\n([\s\S]+)/);
        return m && { s: t(m[1]), e: t(m[2]), text: m[3].replace(/<[^>]+>|\{[^}]+\}/g, '') };
      });
    }
    const seen = new Set();
    return cues.filter(Boolean).map((x) => ({ ...x, text: x.text.replace(/\s+/g, ' ').trim() }))
      .filter((x) => x.text.length > 1 && !seen.has(`${Math.round(x.s)}${x.text}`) && seen.add(`${Math.round(x.s)}${x.text}`))
      .sort((a, b) => a.s - b.s);
  };
  // la pista con más líneas es la de diálogos: las de carteles, letras del opening o «forced» traen unas pocas
  let best = [];
  for (const st of (eng.length ? eng : text).slice(0, 6)) {
    const subs = await read(st).catch(() => []);
    if (subs.length > best.length) best = subs;
  }
  return best;
}

/** Subtítulos en imagen (PGS de los Blu-ray) no se leen como texto: Whisper traduce el audio japonés con sus tiempos. */
async function whisperSubs(file, dir, log) {
  const auds = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index:stream_tags=language', '-of', 'json', file])).streams ?? [];
  const jpn = auds.find((a) => /^ja/i.test(a.tags?.language ?? '')) ?? auds[0];
  const wav = path.join(dir, 'ep.wav');
  await ff(['-i', file, '-map', `0:${jpn.index}`, '-ac', '1', '-ar', '16000', wav]);
  log('👂 El episodio trae subtítulos en imagen: transcribo el audio japonés con Whisper…');
  return JSON.parse(await run(PY, [path.resolve(import.meta.dirname, '../../lib/align/translate.py'), wav], 40 * 60000));
}

const LOCATE_SCHEMA = {
  type: 'object',
  properties: {
    windows: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', properties: { s: { type: 'number' }, e: { type: 'number' }, what: { type: 'string' } }, required: ['s', 'e', 'what'] } },
    burst: { type: 'object', properties: { s: { type: 'number' }, e: { type: 'number' }, es: { type: 'string' } }, required: ['s', 'e', 'es'] },
  },
  required: ['windows', 'burst'],
};

/** La IA lee el diálogo con tiempos y devuelve los tramos donde pasa el momento y la frase/golpe más icónico. */
async function locate(subs, { anime, episode, moment, facts }, dur, span) {
  const mmss = (x) => `${Math.floor(x / 60)}:${pad(Math.floor(x % 60))}`;
  const ev = await claudeStep({
    prompt: `Este es el diálogo con tiempos (min:seg) del episodio ${episode} de ${anime} (dura ${mmss(dur)}).
Necesito los tramos donde ocurre este momento para mostrarlos mientras el narrador lo cuenta:
MOMENTO: ${moment}
DATOS: ${facts}

Devuelve:
- "windows": 2-6 tramos en SEGUNDOS ("s", "e") que juntos sumen ${span} s: el momento en sí, lo que lleva a él y su desenlace (sin opening, ending ni avance). Hace falta material de sobra para no repetir planos mientras el narrador habla. "what": qué pasa en ese tramo.
- "burst": 2-3,5 s ("s", "e" en segundos) del grito, golpe o frase más icónica del momento, para dejar oír el audio original; "es": esa frase traducida al español (o la onomatopeya/nombre del ataque).

DIÁLOGO:
${subs.map((x) => `[${mmss(x.s)}] ${x.text}`).join('\n').slice(0, 60000)}`,
    schema: LOCATE_SCHEMA,
    system: 'Eres editor de vídeo experto en anime. Ubicas momentos exactos en episodios a partir de su diálogo.',
    effort: 'low',
    tools: [],
  }, () => {}, () => {});
  return ev.data;
}

/**
 * entry: { anime, nyaa, episode, moment, facts }. Devuelve { scenes, burst: { file, dur, es } | null } o lanza error
 * (el llamador vuelve a los tráileres).
 */
export function episodeScenes(entry, dir, ...rest) {
  // la descarga anticipada y el montaje piden el mismo episodio: una sola descarga para los dos
  const key = `${dir}|${entry.nyaa || entry.anime}|${Math.round(+entry.episode)}`;
  if (!inflight.has(key)) inflight.set(key, scenesFor(entry, dir, ...rest).finally(() => inflight.delete(key)));
  return inflight.get(key);
}
const inflight = new Map();

async function scenesFor(entry, dir, log, context = '', span = '200-320') {
  const ep = Math.round(+entry.episode);
  if (!(ep > 0)) throw new Error('sin número de episodio');
  const slug = `ep-${norm(entry.nyaa || entry.anime).slice(0, 30)}-${ep}`;
  const cache = path.join(dir, `${slug}.json`);
  if (existsSync(cache)) return JSON.parse(await readFile(cache, 'utf8'));
  const name = entry.nyaa || entry.anime, season = seasonOf(name);
  // sin releases con ese nombre: el nombre general (sin temporada) o el de la serie; desde la temporada 2, solo packs
  const cands = await findTorrents([...new Set([name, baseName(name), entry.anime])].filter(Boolean), ep, season);
  if (!cands.length) throw new Error(`no está en nyaa (${name} ${ep})`);
  // de mejor a peor: si uno no baja (pocos seeders) o el pack no trae el episodio, el siguiente; cada uno en su carpeta para retomarlo
  let file, dl, last;
  for (const t of cands.slice(0, 3)) {
    dl = path.join(dir, `${slug}-${createHash('md5').update(t.link).digest('hex').slice(0, 6)}-dl`);
    try { file = await download(t, ep, dl, log, t.packSeason); break; } catch (e) { last = e; log(`⚠️ ${t.title.slice(0, 90)}: ${String(e.message).slice(0, 100)}`); }
  }
  if (!file) throw new Error(`descarga a medias, se retoma al reanudar: ${last.message}`);
  try {
    const dur = +(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])).trim();
    let subs = await subtitles(file, dl).catch(() => []);
    // los BD traen el diálogo en imagen (PGS) y en texto solo opening y ending: un diálogo tiene una línea cada pocos
    // segundos y las canciones unas decenas en todo el episodio; con menos de una cada 15 s, Whisper
    if (subs.length < Math.max(20, dur / 15)) subs = await whisperSubs(file, dl, log).catch((e) => { log(`⚠️ Whisper: ${e.message.slice(0, 120)}`); return []; });
    if (subs.length < 20) throw new Error('el episodio no trae subtítulos para ubicar el momento');
    const loc = await locate(subs, entry, dur, span);
    log(`🎯 ${entry.anime} ep. ${ep}: ${loc.windows.map((w) => `${Math.round(w.s)}-${Math.round(w.e)} s (${w.what})`).join(' · ')}`);
    const scenes = [];
    for (const [i, w] of loc.windows.entries()) {
      // scenesOf descarta el 5 % inicial y el 8 % final (logos de tráiler): margen para no perder planos del tramo
      const pad = (w.e - w.s) * 0.1 + 2;
      const s = Math.max(0, w.s - pad), e = Math.min(dur, w.e + pad);
      if (e - s < 4) continue;
      const clip = path.join(dir, `${slug}-w${i}.mp4`);
      // el audio japonés se queda solo para la ráfaga; aquí basta el vídeo
      await ff(['-ss', String(s), '-to', String(e), '-i', file, '-map', '0:v:0', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', clip]);
      scenes.push(...await catalogScenes(clip, await scenesOf(clip, e - s), dir, log, `${entry.anime} ep. ${ep}: ${w.what}. ${context}`)
        .then((arr) => arr.map((x) => ({ ...x, desc: `ep. ${ep} (${w.what}): ${x.desc}` }))));
    }
    let burst = null;
    const bs = Math.max(0, loc.burst.s - 0.2), bd = Math.min(4, Math.max(1.5, loc.burst.e - loc.burst.s + 0.4));
    if (bs + bd <= dur) {
      const bfile = path.join(dir, `${slug}-burst.mp4`);
      // packs «Dual Audio»: la primera pista suele ser el doblaje en inglés
      const auds = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index:stream_tags=language', '-of', 'json', file])).streams ?? [];
      const jpn = auds.find((a) => /^ja/i.test(a.tags?.language ?? '')) ?? auds[0];
      await ff(['-ss', String(bs), '-t', String(bd), '-i', file, '-map', '0:v:0', '-map', `0:${jpn.index}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-c:a', 'aac', '-b:a', '192k', bfile]);
      burst = { file: bfile, dur: bd, es: loc.burst.es };
    }
    // el guion se escribe con esto: lo que de verdad se verá y el diálogo original de esos tramos
    const inWin = (x) => loc.windows.some((w) => x.s >= w.s - 5 && x.s <= w.e + 5);
    const out = { scenes, burst, windows: loc.windows, dialog: subs.filter(inWin).map((x) => x.text).join(' / ').slice(0, 4000) };
    await writeFile(cache, JSON.stringify(out));
    return out;
  } finally {
    await rm(dl, { recursive: true, force: true });
  }
}
