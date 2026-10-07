// Exportación de vídeo sin tiempo real: el navegador envía el vídeo ya codificado (H.264 Annex B, WebCodecs)
// y el audio mezclado offline (WAV); aquí ffmpeg los une en un MP4 listo para YouTube.
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm, rename, stat, readdir, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORK = path.join(ROOT, '.work', 'export');
export const OUT_DIR = path.join(process.env.PROJECTS_DIR || path.join(ROOT, 'projects'), 'exports');

const safe = (s) => String(s).replace(/[^a-z0-9_-]/gi, '').slice(0, 90) || 'video';
const dirOf = (id) => path.join(WORK, safe(id));

export async function start() {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await mkdir(dirOf(id), { recursive: true });
  return { id };
}

/** Añade datos al archivo de la sesión (vídeo por trozos o audio completo), en streaming. */
export async function append(id, kind, req) {
  const dir = dirOf(id);
  if (!existsSync(dir)) throw new Error('Sesión de exportación no encontrada');
  const file = path.join(dir, kind === 'audio' ? 'audio.wav' : 'video.h264');
  await pipeline(req, createWriteStream(file, { flags: kind === 'audio' ? 'w' : 'a' }));
  return { bytes: (await stat(file)).size };
}

export async function finish(id, { fps = 30, filename = 'video' } = {}) {
  const dir = dirOf(id);
  const video = path.join(dir, 'video.h264');
  const audio = path.join(dir, 'audio.wav');
  if (!existsSync(video)) throw new Error('No llegó el vídeo');
  await mkdir(OUT_DIR, { recursive: true });
  const name = `${safe(filename)}.mp4`;
  const tmp = path.join(dir, 'out.mp4');
  const args = ['-nostdin', '-v', 'error', '-y', '-f', 'h264', '-i', video];
  const hasAudio = existsSync(audio) && (await stat(audio)).size > 1000;
  if (hasAudio) args.push('-i', audio, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-shortest');
  // el H.264 "crudo" no trae tiempos fiables: fotograma n → n/fps segundos
  args.push('-c:v', 'copy', '-bsf:v', `setts=pts=N/(${fps}*TB):dts=N/(${fps}*TB)`, '-video_track_timescale', String(fps * 1000), '-movflags', '+faststart', tmp);
  await new Promise((resolve, reject) => execFile('ffmpeg', args, (err, _o, stderr) => (err ? reject(new Error(`ffmpeg: ${stderr || err.message}`)) : resolve())));
  // rename falla entre discos distintos (EXDEV): en ese caso, copiar
  try { await rename(tmp, path.join(OUT_DIR, name)); } catch (e) { if (e.code !== 'EXDEV') throw e; await copyFile(tmp, path.join(OUT_DIR, name)); }
  await rm(dir, { recursive: true, force: true });
  const info = await stat(path.join(OUT_DIR, name));
  return { url: `/exports/${encodeURIComponent(name)}`, file: name, bytes: info.size, audio: hasAudio };
}

export async function cancel(id) { await rm(dirOf(id), { recursive: true, force: true }); }

export async function list() {
  if (!existsSync(OUT_DIR)) return [];
  return (await readdir(OUT_DIR)).filter((f) => f.endsWith('.mp4'));
}
