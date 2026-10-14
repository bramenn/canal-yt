// Búsqueda de imágenes con la API de Brave, común a las apps: en fila (una por segundo, misma conexión), con
// reintentos y contador de gasto en Postgres (Brave no informa de lo gastado). La clave va en .secrets/brave.json.
import { readKey, keySource, saveKey } from './tts/keys.js';
import { getSetting, setSetting } from './db.js';
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { run } from './ytdlp.js';

export const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// bancos de imágenes: sus vistas previas llevan marca de agua
export const STOCK = /(^|\.)(alamy|gettyimages|shutterstock|istockphoto|dreamstime|depositphotos|123rf|stock\.adobe|alamyimages|imago-images|vecteezy)\./i;
export const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const item = ({ image, thumbnail, width, height, title, page }) =>
  ({ url: image, thumb: thumbnail || image, width: Number(width) || 0, height: Number(height) || 0, title: title || '', credit: { source: page || image, site: host(page || image) } });

export const BRAVE_ENV = 'BRAVE_API_KEY';
// ponytail: tarifa fija del plan de pago por uso de Brave (5 $ / 1000 búsquedas); cambiarla aquí si cambia el plan
export const BRAVE_PRICE = 5 / 1000;
// Brave no informa del gasto: cada búsqueda cobrada se cuenta aquí (total y por mes). Las llamadas van en fila: sin carreras.
async function countBrave() {
  const month = new Date().toISOString().slice(0, 7);
  const u = (await getSetting('braveUsage')) ?? { total: 0, months: {} };
  u.total++; u.months[month] = (u.months[month] ?? 0) + 1;
  await setSetting('braveUsage', u).catch(() => {});
}
export async function braveUsage() {
  const u = (await getSetting('braveUsage')) ?? { total: 0, months: {} };
  const month = u.months[new Date().toISOString().slice(0, 7)] ?? 0;
  return { month, total: u.total, monthCost: month * BRAVE_PRICE, totalCost: u.total * BRAVE_PRICE };
}
export const braveStatus = () => ({ configured: !!readKey('brave', BRAVE_ENV), source: keySource('brave', BRAVE_ENV) });
export const setBraveKey = (key) => saveKey('brave', key);

// ponytail: de una en una para todo el servidor (límite del plan gratuito de Brave: 1/s); subir el ritmo si se paga un plan mayor.
// En fila también se reutiliza la misma conexión: desde el clúster, abrir conexiones nuevas a Brave a veces caduca.
let braveTurn = Promise.resolve();
async function braveOnce(key, q) {
  const u = new URL('https://api.search.brave.com/res/v1/images/search');
  u.searchParams.set('q', q); u.searchParams.set('count', '30'); u.searchParams.set('safesearch', 'strict');
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(u, { headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw Object.assign(new Error(`respondió ${r.status}`), { http: true });
      await countBrave();
      return (await r.json()).results ?? [];
    } catch (e) {
      if (e.http || i === 3) throw new Error(e.http ? e.message : `sin conexión (${e.cause?.code ?? e.message})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
export async function brave(q) {
  const key = readKey('brave', BRAVE_ENV);
  if (!key) throw new Error('sin clave: ponla en ⚙ Ajustes (api.search.brave.com)');
  const run = braveTurn.then(() => braveOnce(key, q));
  braveTurn = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1100)));
  return (await run).map((x) => item({
    image: x.properties?.url, thumbnail: x.thumbnail?.src, width: x.properties?.width, height: x.properties?.height, title: x.title, page: x.url,
  }));
}

/** Fotos para una búsqueda: sin bancos de imágenes (marca de agua) ni fotos pequeñas. */
export async function searchImages(q, minWidth = 500) {
  return (await brave(q)).filter((x) => x.url && !(x.width && x.width < minWidth) && !STOCK.test(host(x.url)) && !STOCK.test(x.credit.site));
}

/** Hasta `max` imágenes descargables de Brave para la búsqueda (en caché por proyecto). */
/** Imágenes de Wikimedia Commons (licencias libres, sin clave): respaldo cuando Brave no da nada. */
export async function commonsImages(q, max = 12) {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  Object.entries({ action: 'query', format: 'json', generator: 'search', gsrsearch: `${q} filetype:bitmap`, gsrnamespace: '6', gsrlimit: String(max), prop: 'imageinfo', iiprop: 'url|size', iiurlwidth: '1600' })
    .forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { headers: { 'User-Agent': 'EstudioShorts/1.0 (contacto: bramendev@gmail.com)' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) return [];
  const pages = Object.values((await r.json()).query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return pages.map((p) => p.imageinfo?.[0]).filter((i) => i && i.width >= 600).map((i) => ({ url: i.thumburl ?? i.url, credit: { source: i.descriptionurl, site: 'commons.wikimedia.org' } }));
}

export async function downloadImages(query, dir, max = 6) {
  const base = path.join(dir, `img-${String(query).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '').slice(0, 40)}`);
  const listFile = `${base}.json`;
  if (existsSync(listFile)) return JSON.parse(await readFile(listFile, 'utf8'));
  const files = [];
  let found = await searchImages(query, 600).catch(() => []);
  if (!found.length) found = await commonsImages(query).catch(() => []); // sin Brave (o sin resultados): Wikimedia Commons
  if (!found.length) found = await commonsImages(String(query).split(/\s+/).slice(0, 2).join(' ')).catch(() => []);
  for (const it of found.slice(0, max * 2)) {
    if (files.length >= max) break;
    try {
      const r = await fetch(it.url, { headers: { 'User-Agent': UA, Accept: 'image/*' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok || !/^image\/(jpeg|png|webp)/.test(r.headers.get('content-type') ?? '')) continue;
      const raw = `${base}-src`;
      await writeFile(raw, Buffer.from(await r.arrayBuffer()));
      const file = `${base}-${files.length}.jpg`;
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', raw, '-frames:v', '1', '-q:v', '2', file]);
      files.push(file);
    } catch {}
  }
  await writeFile(listFile, JSON.stringify(files));
  return files;
}
