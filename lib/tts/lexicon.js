// Diccionario de pronunciación del canal: "cómo se escribe" → "cómo debe decirlo la voz".
// Se aplica igual en todos los segmentos (determinista), después de pasar las cifras a palabras.
// Vive en style/pronunciacion.json y se edita desde la app (Voz IA → Pronunciación).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const FILE = process.env.LEXICON_FILE || path.join(ROOT, 'style', 'pronunciacion.json');

// Punto de partida: anglicismos y siglas frecuentes del canal escritos como se dicen en español.
export const DEFAULT_LEXICON = [
  { from: 'tokens', to: 'tóquens' },
  { from: 'token', to: 'tóquen' },
  { from: 'prompts', to: 'prómpts' },
  { from: 'prompt', to: 'prómpt' },
  { from: 'ChatGPT', to: 'chat ge pe te' },
  { from: 'GPT', to: 'ge pe te' },
  { from: 'OpenAI', to: 'Open ei ái' },
  { from: 'OpenRouter', to: 'Open ráuter' },
  { from: 'API', to: 'a pe i' },
  { from: 'GPU', to: 'ge pe u' },
  { from: 'GPUs', to: 'ge pe us' },
  { from: 'CPU', to: 'ce pe u' },
  { from: 'VRAM', to: 'uve ram' },
  { from: 'LLM', to: 'ele ele eme' },
  { from: 'MTP', to: 'eme te pe' },
  { from: 'MLX', to: 'eme ele equis' },
  { from: 'llama.cpp', to: 'llama ce pe pe' },
  { from: 'benchmark', to: 'bénchmark' },
  { from: 'benchmarks', to: 'bénchmarks' },
  { from: 'Claude', to: 'Clod' },
];

export async function readLexicon() {
  try {
    const data = JSON.parse(await readFile(FILE, 'utf8'));
    return Array.isArray(data) ? data : DEFAULT_LEXICON;
  } catch { return DEFAULT_LEXICON; }
}

export async function saveLexicon(list) {
  const clean = (Array.isArray(list) ? list : [])
    .map((e) => ({ from: String(e.from ?? '').trim(), to: String(e.to ?? '').trim() }))
    .filter((e) => e.from && e.to);
  await writeFile(FILE, JSON.stringify(clean, null, 2));
  return clean;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Aplica el diccionario. Las siglas (todo mayúsculas) distinguen mayúsculas; el resto no.
 * Se aplican primero las entradas más largas ("ChatGPT" antes que "GPT").
 */
export function applyLexicon(text, lexicon) {
  let t = String(text);
  const entries = [...lexicon].sort((a, b) => b.from.length - a.from.length);
  for (const { from, to } of entries) {
    const acronym = from === from.toUpperCase() && /[A-Z]/.test(from);
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(from)}(?![\\p{L}\\p{N}])`, acronym ? 'gu' : 'giu');
    t = t.replace(re, to);
  }
  return t;
}
