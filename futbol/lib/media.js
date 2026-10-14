// Imágenes de cada plano: búsqueda web (API de Brave, lib/brave.js), descarga por URL o subida propia.
// El almacén de archivos es el común (lib/store.js): <proyectos>/media/<proyecto>/<hash>.<ext>, servido en /media/...
import { fileStore, MAX } from '../../lib/store.js';
import { UA, searchImages } from '../../lib/brave.js';
export { braveUsage, braveStatus, setBraveKey } from '../../lib/brave.js';

export function mediaStore(root) {
  const base = fileStore(root);
  const { save } = base;

  return {
    ...base,
    /** Busca fotos con la API de Brave. Devuelve { engine, items: [{ thumb, url, title, width, height, credit }], errors }. */
    async search(q, retry = true) {
      try {
        const items = await searchImages(q);
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
  };
}
