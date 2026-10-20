// Reaplica el montaje a un proyecto guardado conservando el guion, la voz, la miniatura y los MP4 anteriores.
// node --env-file=.env scripts/reedit-dinero.js <id> [youtube|tiktok|both]
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getProject, saveProject, pool } from '../lib/db.js';
import { setEngine } from '../lib/claude.js';
import { run } from '../lib/ytdlp.js';
import { montage } from '../dinero/lib/montage.js';

const [id, platform = 'both'] = process.argv.slice(2);
if (!id || !/^[\w-]+$/.test(id) || !['youtube', 'tiktok', 'both'].includes(platform)) {
  console.error('Uso: node --env-file=.env scripts/reedit-dinero.js <id> [youtube|tiktok|both]');
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dinero', 'projects');
const projects = process.env.PROJECTS_DIR ? path.resolve(process.env.PROJECTS_DIR) : root;
const dir = path.join(projects, 'media', id);
const thumb = { small: path.join(dir, 'thumb.jpg'), full: path.join(dir, 'thumb-4k.jpg') };
if (!process.env.AI_ENGINE) setEngine('codex');
try {
  const initial = await getProject(id, 'dineros');
  if (!initial) throw new Error(`No existe el proyecto ${id}`);
  for (const target of platform === 'both' ? ['youtube', 'tiktok'] : [platform]) {
    const source = target === 'youtube' ? initial : initial.tiktok;
    if (!source?.script || !source.voice?.url) throw new Error(`No hay guion y voz de ${target} para ${id}`);
    const rel = decodeURIComponent(source.voice.url.replace(/^\/audio\//, ''));
    const voice = path.resolve(projects, 'audio', rel);
    if (!voice.startsWith(path.join(projects, 'audio') + path.sep)) throw new Error('Ruta de audio inválida');
    const alignment = JSON.parse(await readFile(`${voice}.words.json`, 'utf8'));
    const words = alignment.words.map(w => ({ w: w.w.trim(), s: w.s, e: w.e })).filter(w => w.w);
    if (!words.length) throw new Error('Sin palabras alineadas');
    const duration = Number(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', voice]));
    if (!(duration > 0)) throw new Error('Duración de audio inválida');
    const context = `${initial.story.subject}: ${initial.story.angle}. Datos: ${initial.story.facts}`.slice(0, 2000);
    const name = `edited-${target === 'youtube' ? 'short' : 'tiktok'}`;
    console.log(`━━ Reedición ${target}: ${source.script.title}`);
    const result = await montage({ script: source.script, about: initial.story.subject, context, voice, words, duration, dir, name, thumb }, console.log);
    const metadata = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', result.video]));
    if (!metadata.streams.some(s => s.codec_type === 'audio') || !metadata.streams.some(s => s.codec_type === 'video' && s.width === 1080 && s.height === 1920)
      || Math.abs(Number(metadata.format.duration) - duration - 0.3) > 0.2) throw new Error('El vídeo no supera la validación');
    // Leer de nuevo evita sobrescribir las cifras que haya actualizado la web durante el montaje.
    const current = await getProject(id, 'dineros');
    const active = target === 'youtube' ? current : current?.tiktok;
    if (JSON.stringify(active?.script) !== JSON.stringify(source.script) || active?.voice?.url !== source.voice.url) throw new Error('El guion o la voz cambiaron durante el montaje; no se reemplaza su enlace');
    const video = `/media/${id}/${name}.mp4`;
    active.video = video;
    active.videoLabel = 'Edición mejorada';
    await saveProject(current, null, 'dineros');
    console.log(`✅ ${target} verificado y disponible en la web: ${video}`);
  }
} finally { await pool.end(); }
