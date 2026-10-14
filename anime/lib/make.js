// Un short de principio a fin: guion → voz (ElevenLabs, tu voz favorita) → palabras alineadas (Whisper) → montaje.
import path from 'node:path';
import { writeScript } from './story.js';
import { montage } from './montage.js';

/**
 * deps: { tts, aligner, mediaDir } (tts y aligner = lib/tts y lib/align ya cargados con PROJECTS_DIR).
 * Devuelve el proyecto { id, story, script, voice, video, cost }.
 */
export async function makeShort({ id, story, voiceId }, { tts, aligner, mediaDir }, emit, track, signal) {
  const log = (text) => emit({ type: 'log', text });
  let cost = 0;
  log(`✍️ Guion: ${story.anime} — ${story.angle}`);
  const { script, cost: c1 } = await writeScript(story, emit, track);
  cost += c1;
  log(`📝 «${script.title}» · ${script.lines.length} frases`);

  const text = script.lines.map((l) => l.text).join(' ');
  const [seg] = await tts.synthesize({ provider: 'elevenlabs', projectId: id, voiceId, settings: {}, segments: [{ index: 0, spoken: text }] }, log, signal);
  const file = path.join(tts.AUDIO_DIR, decodeURIComponent(seg.url.replace(/^\/audio\//, '')));
  log('🎧 Alineando la voz palabra a palabra…');
  const [al] = await aligner.align([{ index: 0, file, prompt: text }], log, signal);
  const words = (al?.words ?? []).map((w) => ({ w: w.w.trim(), s: w.s, e: w.e })).filter((w) => w.w);
  if (!words.length) throw new Error('No se pudo alinear la voz');

  log('🎬 Montando el vídeo (tráileres, cortes y subtítulos)…');
  const dir = path.join(mediaDir, id);
  await montage({ script, voice: file, words, duration: al.duration ?? words.at(-1).e, dir }, log, signal);
  return { id, story, script, voice: { voiceId, url: seg.url }, video: `/media/${id}/short.mp4`, thumb: `/media/${id}/thumb-4k.jpg`, thumbSmall: `/media/${id}/thumb.jpg`, cost, created: Date.now() };
}
