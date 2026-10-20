// Un short de dinero de principio a fin: guion → voz (ElevenLabs) → palabras alineadas (Whisper) → montaje, en dos
// versiones: YouTube Shorts (35-45 s) y TikTok (65-75 s: TikTok solo paga los vídeos de más de 1 minuto).
import path from 'node:path';
import { writeScript } from './story.js';
import { montage, BRAND } from './montage.js';
import { writeCopy } from '../../lib/social.js';

/** De qué va el short, para el texto de publicación. */
export const copyAbout = (story, script) => `Historia de dinero y negocios: ${story.subject}. Ángulo: ${story.angle}. Datos: ${story.facts}
Título en pantalla: «${script.title}». Guion: ${script.lines.map((l) => l.text).join(' ')}`;

/** Voz, alineación y montaje de un guion. name: 'short' (YouTube) | 'tiktok'. */
async function produce({ id, story, script, voiceId, name, thumb }, { tts, aligner, mediaDir }, log, signal) {
  const context = `${story.subject}: ${story.angle}. Datos: ${story.facts}`.slice(0, 2000);
  const text = script.lines.map((l) => l.text).join(' ');
  const [seg] = await tts.synthesize({ provider: 'elevenlabs', projectId: name === 'short' ? id : `${id}-${name}`, voiceId, settings: {}, segments: [{ index: 0, spoken: text }] }, log, signal);
  const file = path.join(tts.AUDIO_DIR, decodeURIComponent(seg.url.replace(/^\/audio\//, '')));
  log('🎧 Alineando la voz palabra a palabra…');
  const [al] = await aligner.align([{ index: 0, file, prompt: text }], log, signal);
  const words = (al?.words ?? []).map((w) => ({ w: w.w.trim(), s: w.s, e: w.e })).filter((w) => w.w);
  if (!words.length) throw new Error('No se pudo alinear la voz');
  const duration = al.duration ?? words.at(-1).e;
  log(`🎬 Montando la versión ${name === 'short' ? 'YouTube' : 'TikTok'} (${Math.round(duration)} s)…`);
  const out = await montage({ script, about: story.subject, context, voice: file, words, duration, dir: path.join(mediaDir, id), name, thumb }, log, signal);
  return { duration, voice: { voiceId, url: seg.url }, video: `/media/${id}/${name}.mp4`, thumb: out.thumb };
}

/** Versión TikTok (> 1 min para poder monetizar); reutiliza imágenes y miniatura de la de YouTube. */
export async function makeTiktok({ id, story, voiceId, thumb, learn = '' }, deps, emit, track, signal) {
  const log = (text) => emit({ type: 'log', text });
  let cost = 0, more = '';
  for (let attempt = 1; ; attempt++) {
    log(`✍️ Guion largo para TikTok${attempt > 1 ? ' (más largo)' : ''}…`);
    const { script, cost: c } = await writeScript(story, emit, track, { platform: 'tiktok', more, learn });
    cost += c;
    const v = await produce({ id, story, script, voiceId, name: 'tiktok', thumb }, deps, log, signal);
    if (v.duration >= 61 || attempt === 2) {
      if (v.duration < 61) log(`⚠️ La versión TikTok dura ${Math.round(v.duration)} s (menos de 1 min)`);
      return { tiktok: { script, video: v.video, voice: v.voice, duration: Math.round(v.duration) }, cost };
    }
    more = `La versión anterior duró solo ${Math.round(v.duration)} s: escribe al menos 190 palabras con más datos reales.`;
  }
}

export async function makeShort({ id, story, voiceId, learn = '' }, deps, emit, track, signal) {
  const log = (text) => emit({ type: 'log', text });
  let cost = 0;
  log(`✍️ Guion: ${story.subject} — ${story.angle}`);
  const { script, cost: c1 } = await writeScript(story, emit, track, { learn });
  cost += c1;
  log(`📝 «${script.title}» · ${script.lines.length} frases · ${script.lines.filter((l) => l.show !== 'foto').map((l) => l.show).join(', ') || 'solo fotos'}`);
  script.copy = await writeCopy({ about: copyAbout(story, script), brand: BRAND, keywordsHint: 'el nombre de la empresa o la persona + dinero/negocio (cómo se hizo rico, quiebra, historia de la marca)' }, emit, track);

  const yt = await produce({ id, story, script, voiceId, name: 'short' }, deps, log, signal);
  let tiktok = null;
  try { const t = await makeTiktok({ id, story, voiceId, thumb: yt.thumb, learn }, deps, emit, track, signal); tiktok = t.tiktok; cost += t.cost; }
  catch (e) { log(`⚠️ Versión TikTok: ${e.message.slice(0, 160)}`); }
  return { id, story, script, voice: yt.voice, duration: Math.round(yt.duration), video: yt.video, tiktok, thumb: `/media/${id}/thumb-4k.jpg`, thumbSmall: `/media/${id}/thumb.jpg`, cost, created: Date.now() };
}
