// Clips de vídeo para los planos: buscar en YouTube, ver los «momentos más vistos» (heatmap) y recortar un trozo.
// El trozo se recodifica sin audio, a 1080p/30 y con todos los fotogramas clave (-g 1): así el exportador
// puede saltar a cualquier fotograma al instante. Usa yt-dlp (.tools/venv) y ffmpeg.
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCAL = path.join(REPO, '.tools/venv/bin/yt-dlp');
const YTDLP = process.env.YTDLP_BIN || (existsSync(LOCAL) ? LOCAL : 'yt-dlp');
const MAX_CLIP = 12;
const validId = (id) => /^[\w-]{11}$/.test(String(id));

function run(bin, args, timeout = 120000) {
  return new Promise((resolve, reject) => execFile(bin, args, { timeout, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
    if (err) return reject(new Error(String(stderr).trim().split('\n').filter((l) => !/^WARNING/.test(l)).pop() || err.message));
    resolve(stdout);
  }));
}
// Node ya está instalado: sirve de motor JavaScript para YouTube
const ytdlp = (args, timeout) => run(YTDLP, ['--js-runtimes', 'node', '--no-warnings', ...args], timeout);

export async function search(q) {
  const data = JSON.parse(await ytdlp([`ytsearch15:${q}`, '--flat-playlist', '-J'], 60000));
  return (data.entries ?? []).filter((e) => validId(e.id) && e.duration).map((e) => ({
    id: e.id, title: e.title, channel: e.channel ?? e.uploader ?? '', duration: e.duration,
    thumb: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
  }));
}

export const rawInfo = async (id) => {
  if (!validId(id)) throw new Error('Vídeo no válido');
  return JSON.parse(await ytdlp(['-J', '--skip-download', `https://www.youtube.com/watch?v=${id}`], 60000));
};

/** Picos del «más visto»: separados ≥ 8 s y sin la intro. */
export function peaksOf(d, max = 6) {
  const peaks = [];
  for (const h of [...(d.heatmap ?? [])].sort((a, b) => b.value - a.value)) {
    if (h.start_time < d.duration * 0.03 || peaks.some((p) => Math.abs(p.t - h.start_time) < 8)) continue;
    peaks.push({ t: Math.round(h.start_time), value: Math.round(h.value * 100) });
    if (peaks.length === max) break;
  }
  return peaks.sort((a, b) => a.t - b.t);
}

/** Storyboard: miniaturas que YouTube publica cada pocos segundos (láminas de cols×rows); sirven aunque el vídeo no se deje incrustar. */
export function tilesOf(d, maxW = 160) {
  const sb = (d.formats ?? []).filter((f) => f.format_note === 'storyboard' && f.fragments?.length && f.width <= maxW).sort((a, b) => b.width - a.width)[0];
  if (!sb) return null;
  const heat = d.heatmap ?? [];
  const tiles = [];
  let start = 0;
  for (const f of sb.fragments) {
    const n = Math.min(sb.columns * sb.rows, Math.ceil(f.duration * sb.fps));
    for (let k = 0; k < n; k++) {
      const t = start + k / sb.fps;
      if (t >= d.duration) break;
      const h = heat.find((x) => t >= x.start_time && t < x.end_time);
      tiles.push({ t: Math.round(t * 10) / 10, url: f.url, x: (k % sb.columns) * sb.width, y: Math.floor(k / sb.columns) * sb.height, heat: Math.round((h?.value ?? 0) * 100) });
    }
    start += f.duration;
  }
  return { w: sb.width, h: sb.height, tiles };
}

/** Duración, capítulos, picos del «más visto» y storyboard para elegir a mano. */
export async function info(id) {
  const d = await rawInfo(id);
  const peaks = peaksOf(d);
  const sb = tilesOf(d, 160);
  const tiles = sb?.tiles.map((x) => ({ ...x, t: Math.round(x.t) })) ?? [];
  return {
    id, title: d.title, duration: d.duration,
    storyboard: sb ? { w: sb.w, h: sb.h, tiles } : null,
    peaks: peaks.sort((a, b) => a.t - b.t),
    chapters: (d.chapters ?? []).map((c) => ({ t: Math.round(c.start_time), title: c.title })),
  };
}

/** Recorta [start, start+dur] y lo guarda en la carpeta del proyecto. Devuelve el media del plano. */
export async function cut(store, projectId, { id, start, dur }) {
  if (!validId(id)) throw new Error('Vídeo no válido');
  start = Math.max(0, Number(start) || 0);
  dur = Math.min(MAX_CLIP, Math.max(1, Number(dur) || 5));
  const dir = await mkdtemp(path.join(tmpdir(), 'clip-'));
  try {
    await ytdlp(['-q', '-f', 'bv*[height<=1080][vcodec^=avc1]/bv*[height<=1080]', '--download-sections', `*${start}-${start + dur}`, '-o', path.join(dir, 'src.%(ext)s'), `https://www.youtube.com/watch?v=${id}`], 180000);
    const src = (await readdir(dir)).find((f) => f.startsWith('src.'));
    if (!src) throw new Error('YouTube no entregó el vídeo');
    const out = path.join(dir, 'clip.mp4');
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', path.join(dir, src), '-an', '-t', String(dur),
      '-vf', 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', '1', '-movflags', '+faststart', out]);
    const media = await store.save(projectId, await readFile(out), 'video/mp4', { site: 'youtube.com', source: `https://www.youtube.com/watch?v=${id}&t=${Math.floor(start)}` });
    return { ...media, type: 'video', dur, thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
