// Voz IA con varios proveedores (Fish Audio, ElevenLabs) detrás de la misma interfaz:
// un audio por segmento en projects/audio/<proyecto>/, con caché por contenido + ajustes.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fish from './fish.js';
import * as elevenlabs from './elevenlabs.js';
import { speakNumbers } from './numbers-es.js';
import { readLexicon, applyLexicon } from './lexicon.js';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const AUDIO_DIR = path.join(process.env.PROJECTS_DIR || path.join(ROOT, 'projects'), 'audio');
export const PROVIDERS = { fish, elevenlabs };

export function provider(id) {
  const p = PROVIDERS[id || 'fish'];
  if (!p) throw new Error(`Proveedor de voz desconocido: ${id}`);
  return p;
}

export const statusAll = () => Object.fromEntries(Object.values(PROVIDERS).map((p) => [p.id, { name: p.name, keyHelp: p.keyHelp, ...p.status() }]));

/** Texto de narración → texto para la voz: sin marcas de énfasis, párrafos como pausas y TODAS las cifras en palabras
 *  (red de seguridad determinista: Fish solo normaliza inglés/chino y Claude puede dejarse alguna cifra). */
export const cleanForVoice = (s, lexicon = []) =>
  applyLexicon(speakNumbers(String(s ?? '').replace(/\*/g, '')), lexicon).replace(/\n+/g, ' \n').replace(/[ \t]+/g, ' ').trim();

const hashOf = (o) => createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 10);
const safe = (s) => String(s).replace(/[^a-z0-9_-]/gi, '').slice(0, 80) || 'proyecto';

/** Frase de prueba con una voz (para escucharla antes de elegir). Cacheada por contenido. */
export async function preview({ provider: pid, voiceId, settings, text }) {
  const p = provider(pid);
  if (!voiceId) throw new Error('Elige una voz');
  text = cleanForVoice(text, await readLexicon()).slice(0, 300) || 'Hola, esta es una prueba de voz para el canal.';
  const s = p.normalize(settings);
  const hash = hashOf({ p: p.id, text, voiceId, s });
  const dir = path.join(AUDIO_DIR, '_preview');
  const full = path.join(dir, `${hash}.mp3`);
  if (!existsSync(full)) {
    await mkdir(dir, { recursive: true });
    await writeFile(full, await p.tts({ text, voiceId, settings: s }));
  }
  return { url: `/audio/_preview/${hash}.mp3` };
}

/**
 * Sintetiza cada segmento (segments: [{ index, spoken }]). Devuelve [{ index, url, hash, cached }].
 * La caché no depende del texto vecino: cambiar un segmento solo regenera ese.
 */
export async function synthesize({ provider: pid, projectId, voiceId, settings, segments, force = [] }, onProgress, signal) {
  const p = provider(pid);
  if (!voiceId) throw new Error('Elige una voz');
  const s = p.normalize(settings);
  const dir = path.join(AUDIO_DIR, safe(projectId));
  await mkdir(dir, { recursive: true });
  const lexicon = await readLexicon();
  const texts = segments.map((seg) => cleanForVoice(seg.spoken, lexicon));
  const out = [];
  for (const [k, seg] of segments.entries()) {
    if (signal?.aborted) throw new Error('Cancelado');
    const text = texts[k];
    const hash = hashOf({ p: p.id, text, voiceId, s });
    const file = `${seg.index}-${hash}.mp3`;
    const full = path.join(dir, file);
    const url = `/audio/${safe(projectId)}/${file}`;
    // forzado: se descarta el audio guardado (p. ej. salió roto) y se pide uno nuevo
    if (force.includes(seg.index) && existsSync(full)) { await rm(full, { force: true }); await rm(`${full}.words.json`, { force: true }); }
    if (existsSync(full)) {
      onProgress?.(`♻️  Segmento ${k + 1}/${segments.length} sin cambios (caché)`);
      out.push({ index: seg.index, url, hash, cached: true });
      continue;
    }
    onProgress?.(`🎙️  ${p.name} · segmento ${k + 1}/${segments.length} (${text.length} caracteres)…`);
    const buf = await p.tts({ text, voiceId, settings: s, prevText: texts[k - 1], nextText: texts[k + 1] }, signal);
    await writeFile(full, buf);
    out.push({ index: seg.index, url, hash, cached: false });
  }
  return out;
}

export async function readAudio(rel) {
  const full = path.normalize(path.join(AUDIO_DIR, rel));
  if (!full.startsWith(AUDIO_DIR)) throw new Error('forbidden');
  return readFile(full);
}

// ---- pasada de Claude Code: cifras y siglas → como se pronuncian ----
export const SPOKEN_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: { type: 'object', properties: { index: { type: 'number' }, spoken: { type: 'string' } }, required: ['index', 'spoken'] },
    },
  },
  required: ['segments'],
};

export function spokenPrompt(segments, variant = 'es-ES') {
  return `Vas a preparar la narración de un vídeo para un sintetizador de voz (TTS) en ${variant === 'es-LATAM' ? 'español latinoamericano' : 'español de España'}.
Reescribe cada segmento EXACTAMENTE igual salvo estos cambios, para que la voz lo lea bien:
- Números, precios, porcentajes, fechas, horas y unidades, escritos como se dicen: "1.099 $" → "mil noventa y nueve dólares", "24 GB" → "veinticuatro gigas", "0,23 tokens/s" → "cero coma veintitrés tokens por segundo", "4,3x" → "cuatro coma tres veces", "+50 %" → "un cincuenta por ciento más".
- NO toques siglas, nombres de producto ni palabras en inglés (GPT, API, token, prompt, RTX…): déjalos exactamente como están; los resuelve un diccionario de pronunciación aparte para que siempre suenen igual.
- Símbolos y formatos raros, como se dicen: "16/08" → "dieciséis de agosto", "50-60" → "entre cincuenta y sesenta", "~" → "unos", "→" → "pasa a", "vs" → "contra".
- Quita los asteriscos de énfasis. Conserva "..." como pausa, la puntuación y los saltos de párrafo.
No cambies ni una palabra más: ni estilo, ni orden, ni contenido.

${JSON.stringify(segments.map((s) => ({ index: s.index, texto: s.text })), null, 1)}

Devuelve "segments" con el mismo "index" y el texto listo para la voz en "spoken".`;
}
