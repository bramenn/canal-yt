// Un short de principio a fin: guion → voz (ElevenLabs) → palabras alineadas (Whisper) → montaje, en dos versiones:
// YouTube Shorts (40-50 s) y TikTok (65-75 s: TikTok solo paga los vídeos de más de 1 minuto).
import path from 'node:path';
import { writeScript } from './story.js';
import { montage } from './montage.js';
import { writeCopy } from '../../lib/social.js';

/** De qué va el short, para el texto de publicación. */
export const copyAbout = (story, script) => `Anime: ${story.anime}. Ángulo: ${story.angle}. Datos: ${story.facts}
Título en pantalla: «${script.title}». Guion: ${script.lines.map((l) => l.text).join(' ')}`;

/** Voz, alineación y montaje de un guion. name: 'short' (YouTube) | 'tiktok'. thumb: miniatura ya hecha (o null). */
async function produce({ id, script, voiceId, name, thumb }, { tts, aligner, mediaDir }, log, signal) {
  const text = script.lines.map((l) => l.text).join(' ');
  const [seg] = await tts.synthesize({ provider: 'elevenlabs', projectId: name === 'short' ? id : `${id}-${name}`, voiceId, settings: {}, segments: [{ index: 0, spoken: text }] }, log, signal);
  const file = path.join(tts.AUDIO_DIR, decodeURIComponent(seg.url.replace(/^\/audio\//, '')));
  log('🎧 Alineando la voz palabra a palabra…');
  const [al] = await aligner.align([{ index: 0, file, prompt: text }], log, signal);
  const words = (al?.words ?? []).map((w) => ({ w: w.w.trim(), s: w.s, e: w.e })).filter((w) => w.w);
  if (!words.length) throw new Error('No se pudo alinear la voz');
  const duration = al.duration ?? words.at(-1).e;
  log(`🎬 Montando la versión ${name === 'short' ? 'YouTube' : 'TikTok'} (${Math.round(duration)} s)…`);
  const out = await montage({ script, voice: file, words, duration, dir: path.join(mediaDir, id), name, thumb }, log, signal);
  return { duration, voice: { voiceId, url: seg.url }, video: `/media/${id}/${name}.mp4`, thumb: out.thumb };
}

/** Versión TikTok (65-75 s, > 1 min para poder monetizar); reutiliza los tráileres y la miniatura de la de YouTube. */
export async function makeTiktok({ id, story, voiceId, thumb, learn = '' }, deps, emit, track, signal) {
  const log = (text) => emit({ type: 'log', text });
  let cost = 0, more = '';
  for (let attempt = 1; ; attempt++) {
    log(`✍️ Guion largo para TikTok${attempt > 1 ? ' (más largo)' : ''}…`);
    const { script, cost: c } = await writeScript(story, emit, track, { platform: 'tiktok', more, learn });
    cost += c;
    const v = await produce({ id, script, voiceId, name: 'tiktok', thumb }, deps, log, signal);
    // TikTok solo paga vídeos de más de 1 minuto: si se queda corto, una vez más pidiendo más contenido
    if (v.duration >= 61 || attempt === 2) {
      if (v.duration < 61) log(`⚠️ La versión TikTok dura ${Math.round(v.duration)} s (menos de 1 min)`);
      return { tiktok: { script, video: v.video, voice: v.voice, duration: Math.round(v.duration) }, cost };
    }
    more = `La versión anterior duró solo ${Math.round(v.duration)} s: escribe al menos 190 palabras con más detalles reales.`;
  }
}

/**
 * deps: { tts, aligner, mediaDir } (tts y aligner = lib/tts y lib/align ya cargados con PROJECTS_DIR).
 * Devuelve el proyecto { id, story, script, voice, video, tiktok, thumb, cost }.
 */
export async function makeShort({ id, story, voiceId, learn = '' }, deps, emit, track, signal) {
  const log = (text) => emit({ type: 'log', text });
  let cost = 0;
  log(`✍️ Guion: ${story.anime} — ${story.angle}`);
  const { script, cost: c1 } = await writeScript(story, emit, track, { learn });
  cost += c1;
  log(`📝 «${script.title}» · ${script.lines.length} frases`);
  script.copy = await writeCopy({ about: copyAbout(story, script), brand: '@notianimes', keywordsHint: 'el nombre del anime o del personaje' }, emit, track);

  const yt = await produce({ id, script, voiceId, name: 'short' }, deps, log, signal);
  // versión TikTok (si falla, el short de YouTube se guarda igual)
  let tiktok = null;
  try { const t = await makeTiktok({ id, story, voiceId, thumb: yt.thumb, learn }, deps, emit, track, signal); tiktok = t.tiktok; cost += t.cost; }
  catch (e) { log(`⚠️ Versión TikTok: ${e.message.slice(0, 160)}`); }
  return { id, story, script, voice: yt.voice, duration: Math.round(yt.duration), video: yt.video, tiktok, thumb: `/media/${id}/thumb-4k.jpg`, thumbSmall: `/media/${id}/thumb.jpg`, cost, created: Date.now() };
}
