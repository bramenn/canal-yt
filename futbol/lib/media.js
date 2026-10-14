// Imágenes de cada plano: búsqueda web (API de Brave), descarga por URL o subida propia.
// Todo se guarda en <proyectos>/media/<proyecto>/<hash>.<ext> y se sirve en /media/...
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readKey, keySource, saveKey } from '../../lib/tts/keys.js';
import { getSetting, setSetting } from './db.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'video/mp4': '.mp4', 'audio/wav': '.wav', 'audio/mp4': '.m4a' };
const MAX = 25 * 1024 * 1024;
const safe = (s) => String(s).replace(/[^a-z0-9_-]/gi, '').slice(0, 80) || 'proyecto';
// bancos de imágenes: sus vistas previas llevan marca de agua
const STOCK = /(^|\.)(alamy|gettyimages|shutterstock|istockphoto|dreamstime|depositphotos|123rf|stock\.adobe|alamyimages|imago-images|vecteezy)\./i;
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
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
async function brave(q) {
  const key = readKey('brave', BRAVE_ENV);
  if (!key) throw new Error('sin clave: ponla en ⚙ Ajustes (api.search.brave.com)');
  const run = braveTurn.then(() => braveOnce(key, q));
  braveTurn = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1100)));
  return (await run).map((x) => item({
    image: x.properties?.url, thumbnail: x.thumbnail?.src, width: x.properties?.width, height: x.properties?.height, title: x.title, page: x.url,
  }));
}

export function mediaStore(root) {
  const dir = (projectId) => path.join(root, safe(projectId));

  async function save(projectId, buf, type, credit) {
    const ext = TYPES[String(type).split(';')[0].trim().toLowerCase()];
    if (!ext) throw new Error(`No es una imagen admitida (${type || 'tipo desconocido'})`);
    if (buf.length > MAX * 4) throw new Error('Archivo demasiado grande');
    const file = `${createHash('sha1').update(buf).digest('hex').slice(0, 16)}${ext}`;
    await mkdir(dir(projectId), { recursive: true });
    const full = path.join(dir(projectId), file);
    if (!existsSync(full)) await writeFile(full, buf);
    return { url: `/media/${safe(projectId)}/${file}`, credit: credit ?? null };
  }

  return {
    /** Busca fotos con la API de Brave. Devuelve { engine, items: [{ thumb, url, title, width, height, credit }], errors }. */
    async search(q, retry = true) {
      try {
        const items = (await brave(q)).filter((x) => x.url && !(x.width && x.width < 500) && !STOCK.test(host(x.url)) && !STOCK.test(x.credit.site));
        if (items.length) return { engine: 'Brave', items, errors: [] };
        throw new Error('sin resultados');
      } catch (e) {
        // el plan gratuito de Brave limita a 1 búsqueda por segundo: un segundo intento suele bastar
        if (retry && /429/.test(e.message)) { await new Promise((r) => setTimeout(r, 1500)); return this.search(q, false); }
        throw new Error(`Brave: ${e.message.slice(0, 160)}`);
      }
    },

    /** Descarga una imagen de una URL (resultado de búsqueda o la que pegue el usuario). */
    async fetchUrl(projectId, url, credit) {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) throw new Error('Solo URLs http(s)');
      const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'image/*' }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`La imagen respondió ${r.status}`);
      if (Number(r.headers.get('content-length')) > MAX) throw new Error('Imagen demasiado grande (máx. 25 MB)');
      return save(projectId, Buffer.from(await r.arrayBuffer()), r.headers.get('content-type'), credit ?? { source: url });
    },

    save,
    /** Carpeta de un proyecto dentro del almacén (se crea al guardar). */
    dirOf: dir,
    upload: (projectId, buf, type) => save(projectId, buf, type, null),

    /** /media/<proyecto>/<archivo> → ruta absoluta (solo dentro del almacén). */
    fileOf(url) {
      const full = path.normalize(path.join(root, decodeURIComponent(String(url).replace(/^\/media\//, ''))));
      if (!full.startsWith(root + path.sep) || !existsSync(full)) throw new Error(`No existe ${url}`);
      return full;
    },

    async read(rel) {
      const full = path.normalize(path.join(root, rel));
      if (!full.startsWith(root + path.sep)) throw new Error('forbidden');
      return { buf: await readFile(full), type: Object.entries(TYPES).find(([, e]) => e === path.extname(full))?.[0] ?? 'application/octet-stream' };
    },
  };
}
