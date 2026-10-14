// Almacén de archivos de un proyecto (fotos, clips, audio, viñetas), común a las apps.
// Cada archivo va en <raíz>/<proyecto>/<hash>.<ext> (sin duplicados) y se sirve en /media/<proyecto>/<archivo>.
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'video/mp4': '.mp4', 'audio/wav': '.wav', 'audio/mp4': '.m4a' };
export const MAX = 25 * 1024 * 1024;
const safe = (s) => String(s).replace(/[^a-z0-9_-]/gi, '').slice(0, 80) || 'proyecto';

export function fileStore(root) {
  const dir = (projectId) => path.join(root, safe(projectId));

  async function save(projectId, buf, type, credit) {
    const ext = TYPES[String(type).split(';')[0].trim().toLowerCase()];
    if (!ext) throw new Error(`No es un archivo admitido (${type || 'tipo desconocido'})`);
    if (buf.length > MAX * 4) throw new Error('Archivo demasiado grande');
    const file = `${createHash('sha1').update(buf).digest('hex').slice(0, 16)}${ext}`;
    await mkdir(dir(projectId), { recursive: true });
    const full = path.join(dir(projectId), file);
    if (!existsSync(full)) await writeFile(full, buf);
    return { url: `/media/${safe(projectId)}/${file}`, credit: credit ?? null };
  }

  return {
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
