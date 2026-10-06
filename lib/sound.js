// Biblioteca de sonidos: efectos y música de fondo desde Freesound (búsqueda + previsualización HQ con API key)
// o importados a mano (p. ej. música de la Biblioteca de audio de YouTube). Solo licencias usables en un canal
// monetizado: CC0 (sin atribución) y CC BY (con atribución, que se genera sola). Nunca NonCommercial.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readKey, keySource, saveKey } from './tts/keys.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SOUND_DIR = process.env.SOUND_DIR || path.join(ROOT, 'sounds');
const LIB = path.join(SOUND_DIR, 'library.json');
const API = process.env.FREESOUND_API_BASE || 'https://freesound.org/apiv2';
const ENV = 'FREESOUND_API_KEY';

/** Huecos del kit: cuándo suena cada uno (lo decide el motor a partir de la línea de tiempo). */
export const CATEGORIES = {
  whoosh: { label: 'Transición', when: 'cambio de escena (barrido diagonal)', query: 'air whoosh short soft', dur: [0.2, 1.0] },
  pop: { label: 'Elemento', when: 'una barra, punto o paso entra al nombrarse', query: 'soft pop ui', dur: [0.03, 0.6] },
  tick: { label: 'Rótulo', when: 'aparece una palabra clave', query: 'subtle click ui', dur: [0.02, 0.35] },
  impact: { label: 'Golpe', when: 'giros («ESPERA…») y veredicto', query: 'cinematic hit low soft', dur: [0.3, 2.5] },
  ding: { label: 'Resultado', when: 'una cifra o el resultado de una cuenta se fija', query: 'soft chime notification', dur: [0.15, 1.5] },
  typing: { label: 'Teclado', when: 'escenas de terminal', query: 'keyboard typing', dur: [1, 10] },
  music: { label: 'Música de fondo', when: 'todo el vídeo, por debajo de la voz', query: 'ambient background calm piano -vocal -voice -choir -moan', dur: [60, 900] },
};

export const status = () => ({ configured: !!readKey('freesound', ENV), source: keySource('freesound', ENV) });

/** "Creative Commons 0" / URL .../zero/... → cc0 · Attribution / .../by/... → by · NonCommercial → nc */
export function licenseKind(l = '') {
  if (/noncommercial|\/by-nc/i.test(l)) return 'nc';
  if (/creative commons 0|publicdomain\/zero|cc0/i.test(l)) return 'cc0';
  if (/sampling/i.test(l)) return 'other';
  if (/attribution|\/by\//i.test(l)) return 'by';
  return 'other';
}

async function api(pathname, params = {}, key = readKey('freesound', ENV)) {
  if (!key) throw new Error('Falta la API key de Freesound');
  const qs = new URLSearchParams({ ...params, token: key });
  const res = await fetch(`${API}${pathname}?${qs}`);
  if (!res.ok) {
    const why = { 401: 'API key no válida', 429: 'límite de peticiones alcanzado (prueba en un rato)' }[res.status] || `error ${res.status}`;
    const err = new Error(`Freesound: ${why}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function setKey(key) {
  await searchRaw({ query: 'click', filter: 'duration:[0 TO 1]', page_size: '1', fields: 'id' }, key);
  await saveKey('freesound', key);
}

const FIELDS = 'id,name,username,license,duration,previews,url,avg_rating,num_downloads,tags';

// /apiv2/search/ es el endpoint actual; /apiv2/search/text/ se mantiene como alternativa
async function searchRaw(params, key) {
  try { return await api('/search/', params, key); }
  catch (e) { if (e.status === 404 || e.status === 405) return api('/search/text/', params, key); throw e; }
}

const mapSound = (s) => ({
  id: s.id, name: s.name, author: s.username, url: s.url, duration: s.duration,
  license: licenseKind(s.license), licenseRaw: s.license, rating: s.avg_rating, downloads: s.num_downloads,
  preview: s.previews?.['preview-hq-mp3'] || s.previews?.['preview-lq-mp3'] || '',
  tags: (s.tags ?? []).slice(0, 5),
});

/** licenses: 'cc0' (por defecto, sin atribución) o 'cc0+by'. */
export async function search({ q = '', category = 'whoosh', licenses = 'cc0', page = 1, sort = 'rating_desc' } = {}) {
  const cat = CATEGORIES[category] ?? CATEGORIES.whoosh;
  const lic = licenses === 'cc0+by' ? 'license:("Creative Commons 0" OR "Attribution")' : 'license:"Creative Commons 0"';
  const data = await searchRaw({
    query: q || cat.query,
    filter: `${lic} duration:[${cat.dur[0]} TO ${cat.dur[1]}]`,
    sort, fields: FIELDS, page_size: '18', page: String(page),
  });
  // doble comprobación de licencia: nunca NonCommercial ni Sampling+
  const allowed = licenses === 'cc0+by' ? ['cc0', 'by'] : ['cc0'];
  return { count: data.count, hasMore: !!data.next, items: (data.results ?? []).map(mapSound).filter((s) => allowed.includes(s.license) && s.preview) };
}

// ---------- biblioteca local ----------
async function readLib() {
  try { return JSON.parse(await readFile(LIB, 'utf8')); } catch { return { sounds: [], kit: {} }; }
}
async function writeLib(lib) {
  await mkdir(SOUND_DIR, { recursive: true });
  await writeFile(LIB, JSON.stringify(lib, null, 2));
}

export async function library() {
  const lib = await readLib();
  return { ...lib, categories: CATEGORIES };
}

/** Descarga la previsualización HQ (mp3 ~128 kbps) de un sonido de Freesound y lo asigna al kit. */
export async function addFromFreesound({ id, category }) {
  if (!CATEGORIES[category]) throw new Error('Categoría desconocida');
  const s = mapSound(await api(`/sounds/${Number(id)}/`, { fields: FIELDS }));
  if (!['cc0', 'by'].includes(s.license)) throw new Error('Licencia no apta para un canal monetizado (NonCommercial / Sampling+)');
  const res = await fetch(s.preview);
  if (!res.ok) throw new Error(`No se pudo descargar la previsualización (${res.status})`);
  const dir = path.join(SOUND_DIR, category);
  await mkdir(dir, { recursive: true });
  const file = `${category}/fs-${s.id}.mp3`;
  await writeFile(path.join(SOUND_DIR, file), Buffer.from(await res.arrayBuffer()));
  return addToLib({ key: `fs-${s.id}`, source: 'freesound', category, file, name: s.name, author: s.author, url: s.url, license: s.license, duration: s.duration });
}

/** Archivo propio (música de la Biblioteca de audio de YouTube, etc.). */
export async function addUpload({ category, filename, data, license = 'propia', author = '' }) {
  if (!CATEGORIES[category]) throw new Error('Categoría desconocida');
  const ext = (path.extname(filename || '').toLowerCase().match(/^\.(mp3|wav|ogg|m4a|flac|webm)$/) || [null, 'mp3'])[1];
  const key = `up-${Date.now().toString(36)}`;
  const file = `${category}/${key}.${ext}`;
  await mkdir(path.join(SOUND_DIR, category), { recursive: true });
  await writeFile(path.join(SOUND_DIR, file), data);
  return addToLib({ key, source: 'upload', category, file, name: path.basename(filename || key), author, url: '', license, duration: null });
}

async function addToLib(entry) {
  const lib = await readLib();
  lib.sounds = lib.sounds.filter((x) => x.key !== entry.key);
  lib.sounds.push({ ...entry, added: Date.now() });
  // en el kit caben hasta 3 variantes por hueco (se alternan para no repetir siempre el mismo sonido)
  const slot = (lib.kit[entry.category] ?? []).filter((k) => k !== entry.key);
  lib.kit[entry.category] = [entry.key, ...slot].slice(0, entry.category === 'music' ? 1 : 3);
  await writeLib(lib);
  return library();
}

export async function removeSound(key) {
  const lib = await readLib();
  const s = lib.sounds.find((x) => x.key === key);
  if (s) await rm(path.join(SOUND_DIR, s.file), { force: true });
  lib.sounds = lib.sounds.filter((x) => x.key !== key);
  for (const c of Object.keys(lib.kit)) lib.kit[c] = lib.kit[c].filter((k) => k !== key);
  await writeLib(lib);
  return library();
}

/** Texto de créditos para la descripción de YouTube (obligatorio para CC BY; cortesía para CC0). */
export async function credits(cats = null) {
  const lib = await readLib();
  const used = new Set(Object.entries(lib.kit).filter(([c]) => !cats || cats.includes(c)).flatMap(([, keys]) => keys));
  const by = lib.sounds.filter((s) => used.has(s.key) && s.license === 'by');
  const cc0 = lib.sounds.filter((s) => used.has(s.key) && s.license === 'cc0');
  const lines = [];
  if (by.length) {
    lines.push('Sonidos (Freesound.org, licencia CC BY 4.0):');
    for (const s of by) lines.push(`• "${s.name}" de ${s.author} — ${s.url} — https://creativecommons.org/licenses/by/4.0/`);
  }
  if (cc0.length) lines.push(`${by.length ? '\n' : ''}Efectos CC0 de Freesound.org: ${cc0.map((s) => `${s.author}`).filter((v, i, a) => a.indexOf(v) === i).join(', ')}. ¡Gracias!`);
  return { text: lines.join('\n'), required: by.length > 0 };
}

export async function readSound(rel) {
  const full = path.normalize(path.join(SOUND_DIR, rel));
  if (!full.startsWith(SOUND_DIR) || !existsSync(full)) throw new Error('not found');
  return readFile(full);
}
