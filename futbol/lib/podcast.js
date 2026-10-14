// Podcast → shorts en cómic: de un episodio de YouTube (entrevistas, relatos) salen shorts verticales para TikTok
// con la voz original y viñetas dibujadas que siguen lo que se cuenta.
// 1) audio + transcripción con el tiempo de cada palabra (Whisper)  2) la IA elige los mejores relatos
// 3) guion del cómic de cada relato (personaje fijo + una viñeta cada 3-5 s)  4) audio recortado de cada short.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeStep } from '../../lib/claude.js';
import * as clips from './clips.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const LOCAL_PY = path.join(REPO, '.tools/venv/bin/python');
const PY = process.env.ALIGN_PYTHON || (existsSync(LOCAL_PY) ? LOCAL_PY : 'python3');
const LOCAL_YTDLP = path.join(REPO, '.tools/venv/bin/yt-dlp');
const YTDLP = process.env.YTDLP_BIN || (existsSync(LOCAL_YTDLP) ? LOCAL_YTDLP : 'yt-dlp');
const WHISPER = process.env.PODCAST_WHISPER_MODEL || 'small';

export const STYLE = 'novela gráfica noir: tinta negra sobre papel blanco, plumilla y manchas de tinta, sombras duras y alto contraste, '
  + 'un único color de acento rojo intenso usado con moderación (una prenda, una luz, un objeto clave)';

const run = (bin, args, timeout = 1800000) => new Promise((resolve, reject) => execFile(bin, args, { timeout, maxBuffer: 64 << 20 }, (e, out, err) => (e ? reject(new Error(String(err).trim().split('\n').filter((l) => !/^WARNING/.test(l)).pop() || e.message)) : resolve(out))));
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
export const videoIdOf = (url) => String(url).match(/(?:v=|youtu\.be\/|shorts\/|live\/|embed\/)([\w-]{11})/)?.[1] ?? (/^[\w-]{11}$/.test(url) ? url : null);

// ---------- 1) audio y transcripción ----------
async function download(id, dir, log) {
  const have = (await readdir(dir).catch(() => [])).find((f) => f.startsWith('episode.'));
  if (have) return path.join(dir, have);
  log('⬇️ Descargando el audio del episodio…');
  await run(YTDLP, ['--js-runtimes', 'node', '--no-warnings', '-q', '-f', 'ba[ext=m4a]/ba', '-o', path.join(dir, 'episode.%(ext)s'), `https://www.youtube.com/watch?v=${id}`]);
  return path.join(dir, (await readdir(dir)).find((f) => f.startsWith('episode.')));
}

function transcribe(audio, out, emit, signal) {
  if (existsSync(out)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const child = spawn(PY, [path.join(HERE, 'transcribe.py'), audio, out, WHISPER]);
    signal?.addEventListener('abort', () => child.kill('SIGTERM'));
    let err = '', last = 0;
    child.stderr.on('data', (c) => {
      err += c;
      for (const m of String(c).matchAll(/avance (\d+) (\d+)/g)) {
        const p = Number(m[1]) / Math.max(1, Number(m[2]));
        if (p - last >= 0.05 || p >= 1) { last = p; emit({ type: 'progress', p, text: `🎧 Transcribiendo: ${Math.round(p * 100)} % (${fmt(Number(m[1]))} de ${fmt(Number(m[2]))})` }); }
      }
    });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Whisper falló: ${err.trim().split('\n').pop()}`))));
  });
}

// ---------- 2) los mejores relatos ----------
const MOMENTS_SCHEMA = {
  type: 'object',
  properties: {
    shorts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number' }, end: { type: 'number' }, title: { type: 'string' }, hook: { type: 'string' },
          why: { type: 'string' }, caption: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' } },
        },
        required: ['start', 'end', 'title', 'hook', 'why', 'caption', 'hashtags'],
      },
    },
  },
  required: ['shorts'],
};

const momentsPrompt = (meta, lines) => `Este es un episodio del podcast «${meta.channel}»: «${meta.title}». Es una entrevista en la que alguien cuenta su historia (a veces un delito que cometió o sufrió).
Elige los 3-6 MEJORES fragmentos para hacer shorts virales de TikTok, narrados con la voz original y dibujados como un cómic.

Un buen fragmento:
- Dura entre 25 y 75 segundos y se entiende SOLO, sin haber visto el resto: quien lo ve en el feed sabe de qué va desde la primera frase.
- Empieza fuerte (una frase que engancha en los primeros 2 segundos) y termina con un remate, un giro o una frase que deja con ganas.
- Es un relato concreto, con acciones que se puedan dibujar, contado por el entrevistado en primera persona (evita tramos donde solo habla el entrevistador).
- Es coherente: no corta una idea a la mitad. "start" es el inicio de una frase y "end" el final de otra (usa los tiempos de las líneas).
- No se solapan entre sí. Evita fragmentos que den el nombre completo de víctimas o menores.

Para cada uno: "title" (corto, para identificarlo), "hook" (texto en pantalla los primeros segundos, máx. 8 palabras, que intrigue sin destripar), "why" (por qué engancha), "caption" (descripción para TikTok, 1-2 frases) y "hashtags" (4-6, sin #).

Transcripción (tiempo de inicio de cada frase):
${lines}`;

// ---------- 3) guion del cómic ----------
const PANELS_SCHEMA = {
  type: 'object',
  properties: {
    character: { type: 'string' },
    setting: { type: 'string' },
    panels: {
      type: 'array',
      items: { type: 'object', properties: { t: { type: 'number' }, shot: { type: 'string' }, desc: { type: 'string' } }, required: ['t', 'shot', 'desc'] },
    },
  },
  required: ['character', 'setting', 'panels'],
};

const panelsPrompt = (meta, short, lines) => `Vas a guionizar un cómic vertical que acompaña, viñeta a viñeta, este fragmento de un podcast («${meta.channel}»). Se oye la voz original; las viñetas tienen que ilustrar EXACTAMENTE lo que se cuenta en cada momento, como un storyboard fiel.

Estilo de dibujo: ${STYLE}.

- "character": cómo se ve el protagonista (quien narra) en TODAS las viñetas: edad aparente, complexión, pelo, ropa característica, un rasgo reconocible. Inventado y genérico: NUNCA el parecido de una persona real.
- "setting": época y lugar donde pasa la historia (ciudad, barrio, tipo de sitio), para que el fondo sea coherente.
- "panels": una viñeta cada 3-5 segundos (para ${Math.round(short.end - short.start)} s, unas ${Math.round((short.end - short.start) / 4)}). "t" = segundo en que aparece (usa los tiempos de las líneas; la primera en 0). "shot": plano general, plano medio, primer plano, detalle o picado/contrapicado (varíalos como en un cómic). "desc": qué se ve, concreto y dibujable (quién, dónde, qué hace, gesto, luz); si sale el protagonista, nómbralo como "el protagonista".
- Sin texto, letreros ni bocadillos en las viñetas. La violencia se SUGIERE (sombras, siluetas, reacciones, objetos), nunca sangre ni heridas explícitas.

Fragmento (segundos desde el inicio del short):
${lines}`;

/** Palabras de [start, end] con tiempos relativos al inicio del short. */
function wordsIn(transcript, start, end) {
  return transcript.flatMap((s) => s.w).filter(([, s]) => s >= start - 0.05 && s < end).map(([w, s, e]) => [w, +(s - start).toFixed(2), +(e - start).toFixed(2)]);
}

/** Ajusta el inicio y el fin a los límites de frase más cercanos de la transcripción. */
function snap(transcript, start, end) {
  const s = transcript.reduce((a, b) => (Math.abs(b.s - start) < Math.abs(a.s - start) ? b : a)).s;
  const e = transcript.reduce((a, b) => (Math.abs(b.e - end) < Math.abs(a.e - end) ? b : a)).e;
  return [s, Math.max(e, s + 5)];
}

async function cutAudio(src, dir, n, start, end) {
  const file = `short-${n}-${Math.round(start * 10)}-${Math.round(end * 10)}.wav`;
  const out = path.join(dir, file);
  // un poco de margen al final: la última palabra no se corta en seco
  if (!existsSync(out)) await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', String(start), '-to', String(end + 0.35), '-i', src, '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', out]);
  return file;
}

/** Guion del cómic + audio de un short. Modifica `short`. */
export async function scriptShort(short, meta, transcript, mediaDir, mediaUrl, n, emit, track) {
  const lines = transcript.filter((s) => s.e > short.start && s.s < short.end).map((s) => `[${Math.max(0, s.s - short.start).toFixed(1)}] ${s.t}`).join('\n');
  const ev = await claudeStep({ prompt: panelsPrompt(meta, short, lines), schema: PANELS_SCHEMA, system: 'Eres guionista y storyboarder de cómic.', model: 'sonnet', effort: 'medium', tools: [], cwd: mediaDir }, emit, track);
  const len = short.end - short.start;
  short.character = ev.data.character;
  short.setting = ev.data.setting;
  short.panels = ev.data.panels.filter((p) => p.t < len - 1).sort((a, b) => a.t - b.t).map((p, i) => ({ ...p, t: i ? +p.t : 0 }));
  short.words = wordsIn(transcript, short.start, short.end);
  short.audio = `${mediaUrl}/${await cutAudio(meta.audioFile, mediaDir, n, short.start, short.end)}`;
  return ev.cost ?? 0;
}

/**
 * De la URL a los shorts con su guion de cómic (sin dibujar todavía).
 * body: { url, projectId }. Devuelve { source, shorts }.
 */
export async function ingest(body, store, emit, track, signal) {
  const log = (text) => emit({ type: 'log', text });
  const id = videoIdOf(body.url);
  if (!id) throw new Error('No reconozco esa URL de YouTube');
  log('🔎 Leyendo el episodio…');
  const info = await clips.rawInfo(id);
  const meta = { id, url: `https://www.youtube.com/watch?v=${id}`, title: info.title, channel: info.channel ?? info.uploader ?? '', duration: info.duration };
  log(`🎙 «${meta.title}» · ${meta.channel} · ${fmt(meta.duration)}`);

  const dir = store.dirOf(body.projectId);
  await mkdir(dir, { recursive: true });
  const mediaUrl = `/media/${path.basename(dir)}`;
  meta.audioFile = await download(id, dir, log);
  const tFile = path.join(dir, 'transcript.json');
  log(`🎧 Transcribiendo con Whisper (${WHISPER}): en este ordenador tarda bastante con episodios largos…`);
  await transcribe(meta.audioFile, tFile, emit, signal);
  const transcript = JSON.parse(await readFile(tFile, 'utf8'));
  if (!transcript.length) throw new Error('No se entendió nada en el audio');

  log('🧠 Buscando los mejores relatos para shorts…');
  const lines = transcript.map((s) => `[${s.s.toFixed(0)}] ${s.t}`).join('\n');
  let cost = 0;
  const ev = await claudeStep({ prompt: momentsPrompt(meta, lines), schema: MOMENTS_SCHEMA, system: 'Eres editor de vídeos cortos virales (TikTok, Reels, Shorts) especializado en true crime.', model: 'sonnet', effort: 'medium', tools: [], cwd: dir }, emit, track);
  cost += ev.cost ?? 0;
  const shorts = (ev.data.shorts ?? []).map((s) => { const [start, end] = snap(transcript, s.start, s.end); return { ...s, start, end }; })
    .filter((s) => s.end - s.start >= 15 && s.end - s.start <= 95);
  log(`✂️ ${shorts.length} relatos: ${shorts.map((s) => `«${s.title}» (${Math.round(s.end - s.start)} s)`).join(' · ')}`);

  for (const [n, sh] of shorts.entries()) {
    if (signal?.aborted) break;
    log(`🖋 Guion del cómic ${n + 1}/${shorts.length}: «${sh.title}»…`);
    cost += await scriptShort(sh, meta, transcript, dir, mediaUrl, n, (e) => { if (!(e.type === 'log' && /^(⚙️|✍️)/.test(e.text))) emit(e); }, track);
    log(`   ${sh.panels.length} viñetas`);
  }
  delete meta.audioFile;
  return { source: { ...meta, audio: `${mediaUrl}/${path.basename((await readdir(dir)).find((f) => f.startsWith('episode.')))}` }, shorts, cost };
}
