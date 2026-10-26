// YouTube con yt-dlp, común a las apps: buscar vídeos y descargar un trozo. Usa .tools/venv/bin/yt-dlp o YTDLP_BIN.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.tools/venv/bin/yt-dlp');
const YTDLP = process.env.YTDLP_BIN || (existsSync(LOCAL) ? LOCAL : 'yt-dlp');
export const validId = (id) => /^[\w-]{11}$/.test(String(id));

export function run(bin, args, timeout = 120000) {
  return new Promise((resolve, reject) => execFile(bin, args, { timeout, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
    if (err) return reject(new Error(String(stderr).trim().split('\n').filter((l) => !/^WARNING/.test(l)).pop() || err.message));
    resolve(stdout);
  }));
}
// Node ya está instalado: sirve de motor JavaScript para YouTube
// en el clúster YouTube bloquea todas las IPs (Contabo y Cloudflare WARP: «Sign in to confirm you're not a bot»): sin intentarlo,
// quien llama pasa directo a sus alternativas (episodios de nyaa, imágenes). TikTok y Facebook siguen por yt-dlp.
const YOUTUBE_OFF = process.env.YOUTUBE_OFF === '1';
export const ytdlp = (args, timeout) => (YOUTUBE_OFF && args.some((a) => /youtube\.com|youtu\.be|^ytsearch/.test(String(a)))
  ? Promise.reject(new Error('YouTube no disponible desde el servidor'))
  : run(YTDLP, ['--js-runtimes', 'node', '--no-warnings', ...args], timeout));

/** Búsqueda en YouTube: [{ id, title, channel, duration }]. */
export async function search(q, n = 10) {
  const d = JSON.parse(await ytdlp([`ytsearch${n}:${q}`, '--flat-playlist', '-J'], 60000));
  return (d.entries ?? []).filter((e) => validId(e.id)).map((e) => ({ id: e.id, title: e.title ?? '', channel: e.channel ?? e.uploader ?? '', duration: e.duration ?? 0 }));
}

/** Descarga [start, start+dur] del vídeo (sin audio, ≤ 1080p) en `outBase`.<ext>; devuelve la ruta. */
export async function section(id, start, dur, outBase) {
  if (!validId(id)) throw new Error('Vídeo no válido');
  await ytdlp(['-q', '-f', 'bv*[height<=1080][vcodec^=avc1]/bv*[height<=1080]', '--download-sections', `*${start}-${start + dur}`,
    '-o', `${outBase}.%(ext)s`, `https://www.youtube.com/watch?v=${id}`], 180000);
  const dir = path.dirname(outBase);
  const name = (await readdir(dir)).find((x) => x.startsWith(`${path.basename(outBase)}.`));
  if (!name) throw new Error('YouTube no entregó el vídeo');
  return path.join(dir, name);
}
