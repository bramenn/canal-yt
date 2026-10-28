// Escenas del episodio exacto (en lugar de tráileres): busca el episodio en nyaa, lo baja con aria2 (sin quedarse
// compartiendo), lee sus subtítulos para encontrar el minuto en que pasa lo que cuenta el narrador, recorta esos tramos
// en 1080p y borra el episodio. Devuelve escenas catalogadas como las de un tráiler + una ráfaga de audio original.
import path from 'node:path';
import { mkdir, writeFile, readFile, readdir, rm, stat, statfs } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { run } from '../../lib/ytdlp.js';
import { claudeStep } from '../../lib/claude.js';
import { scenesOf, catalogScenes } from './montage.js';

const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const pad = (n) => String(n).padStart(2, '0');
const PY = process.env.ALIGN_PYTHON || path.resolve(import.meta.dirname, '../../.tools/venv/bin/python');
const ff = (args, timeout = 600000) => run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], timeout);
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

/** El mejor torrent con ese episodio: suelto si existe; si no, un pack que lo incluya (se baja solo ese archivo).
 * packsOnly: buscando por el nombre sin temporada, un episodio suelto sería el de la temporada 1. */
export async function findTorrent(name, ep, { packsOnly = false } = {}) {
  const one = epRe(ep);
  const score = (x) => x.seeders * (/1080p/i.test(x.title) ? 3 : /720p/i.test(x.title) ? 1.5 : 1) * (TRUSTED.test(x.title) ? 2 : 1);
  for (const q of [`${name} ${pad(ep)} 1080p`, `${name} ${pad(ep)}`, `${name} batch`, `${name} complete`]) {
    const items = await rss(q).catch(async () => { await waitReady('/'); return rss(q).catch(() => []); });
    // «[Grupo] Nombre - 24 (1080p)»: el nombre seguido del número, para no confundir Naruto con Boruto - Naruto… ni una temporada con otra
    const bare = (x) => norm(x.title.replace(/^(\[[^\]]*\]\s*)+/, ''));
    const fit = items.filter((x) => bare(x).startsWith(norm(name)));
    const single = fit.filter((x) => one.test(x.title) && !RANGE.test(x.title) && !/batch|complete/i.test(x.title)
      && [String(ep), pad(ep), String(ep).padStart(3, '0')].some((n) => bare(x).startsWith(norm(name) + n)));
    const packs = fit.filter((x) => {
      const r = x.title.match(RANGE);
      return r ? +r[1] <= ep && ep <= +r[2] && !/\b(19|20)\d\d\b/.test(r[0]) : /batch|complete/i.test(x.title);
    });
    const best = (arr) => arr.sort((a, b) => score(b) - score(a))[0];
    if (single.length && !packsOnly) return { ...best(single), pack: false };
    if (packs.length) return { ...best(packs), pack: true };
  }
  return null;
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
  return files.find((f) => inSeason(f) && epRe(ep).test(f.name.replace(/\.(mkv|mp4)$/i, ' ')));
}

/** Subtítulos en inglés del mkv como [{ s, e, text }]. */
async function subtitles(file, dir) {
  const streams = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 's', '-show_entries', 'stream=index:stream_tags=language,title', '-of', 'json', file])).streams ?? [];
  const eng = streams.filter((s) => /^en/i.test(s.tags?.language ?? '') || !s.tags?.language);
  const pick = eng.find((s) => !/sign|song/i.test(s.tags?.title ?? '')) ?? eng[0] ?? streams[0];
  if (!pick) return [];
  const srt = path.join(dir, 'ep.srt');
  await ff(['-i', file, '-map', `0:${pick.index}`, '-c:s', 'srt', srt]);
  const t = (x) => { const [h, m, s] = x.replace(',', '.').split(':'); return +h * 3600 + +m * 60 + +s; };
  const seen = new Set();
  return (await readFile(srt, 'utf8')).split(/\r?\n\r?\n/).map((b) => {
    const m = b.match(/(\d+:\d+:\d+[,.]\d+)\s*-->\s*(\d+:\d+:\d+[,.]\d+)\s*\n([\s\S]+)/);
    return m && { s: t(m[1]), e: t(m[2]), text: m[3].replace(/<[^>]+>|\{[^}]+\}/g, '').replace(/\s+/g, ' ').trim() };
  }).filter((x) => x && x.text.length > 1 && !seen.has(`${Math.round(x.s)}${x.text}`) && seen.add(`${Math.round(x.s)}${x.text}`))
    .sort((a, b) => a.s - b.s);
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
  // un release con la temporada en el nombre ya es de esa temporada; en un pack general hay que buscarla dentro
  let t = await findTorrent(name, ep), packSeason = 0;
  for (const alt of [...new Set([baseName(name), entry.anime])].filter((x) => x && x !== name)) {
    if (t) break;
    t = await findTorrent(alt, ep, { packsOnly: season > 1 });
    packSeason = season;
  }
  if (!t) throw new Error(`no está en nyaa (${name} ${ep})`);
  const dl = path.join(dir, `${slug}-dl`);
  let file;
  try { file = await download(t, ep, dl, log, packSeason); } catch (e) { throw new Error(`descarga a medias, se retoma al reanudar: ${e.message}`); }
  try {
    const dur = +(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])).trim();
    let subs = await subtitles(file, dl).catch(() => []);
    if (subs.length < 20) subs = await whisperSubs(file, dl, log).catch((e) => { log(`⚠️ Whisper: ${e.message.slice(0, 120)}`); return []; });
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
