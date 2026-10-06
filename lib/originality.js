// Control de originalidad: detecta frases del guion demasiado parecidas a las transcripciones
// de referencia (secuencias de 6 palabras idénticas o frases-firma) para reescribirlas.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REFS = path.join(ROOT, 'style', 'referencias');
const N = 6;

// frases-firma del canal de referencia (normalizadas)
export const SIGNATURE = [
  'codicia muy concreta', 'la vocecita', 'una vocecita', 'pregunta del impulso', 'la de tu dinero', 'esto es para vosotros',
  'cabe en una servilleta', 'correcta y a la vez engaña', 'te haya ahorrado una compra', 'te haya ahorrado',
  'para tus tataranietos', 'es un ejemplo tonto', 'lo de verdad funciona así', 'a un clic de',
];

const toks = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-zñ0-9]+/g) ?? [];
const norm = (s) => toks(s).join(' ');

let cache = { key: '', grams: new Set() };
function refGrams() {
  if (!existsSync(REFS)) return cache.grams;
  const files = readdirSync(REFS).filter((f) => f.endsWith('.txt'));
  const key = files.map((f) => `${f}:${statSync(path.join(REFS, f)).mtimeMs}`).join('|');
  if (key === cache.key) return cache.grams;
  const grams = new Set();
  for (const f of files) {
    const t = toks(readFileSync(path.join(REFS, f), 'utf8').replace(/\[\d\d:\d\d\]/g, ''));
    for (let i = 0; i + N <= t.length; i++) grams.add(t.slice(i, i + N).join(' '));
  }
  cache = { key, grams };
  return grams;
}

/** Devuelve [{ seg, sentence, reason }] con las frases a reescribir. */
export function findOverlaps(video) {
  const grams = refGrams();
  const out = [];
  (video?.segments ?? []).forEach((seg, si) => {
    const sentences = String(seg.narration ?? '').split(/(?<=[.?!…])\s+(?=[¿¡*\p{Lu}])|\n+/u).map((s) => s.trim()).filter(Boolean);
    for (const sentence of sentences) {
      const n = norm(sentence.replace(/\*/g, ''));
      const sig = SIGNATURE.find((p) => n.includes(norm(p)));
      if (sig) { out.push({ seg: si, sentence, reason: `frase-firma "${sig}"` }); continue; }
      const t = n.split(' ');
      for (let i = 0; i + N <= t.length; i++) {
        const g = t.slice(i, i + N);
        if (g.filter((w) => /\d/.test(w)).length >= 2) continue; // cifras: coincidencia factual, no estilo
        if (grams.has(g.join(' '))) { out.push({ seg: si, sentence, reason: `copia "${g.join(' ')}"` }); break; }
      }
    }
  });
  return out;
}

export const FIX_SCHEMA = {
  type: 'object',
  properties: {
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { original: { type: 'string' }, nueva: { type: 'string' } },
        required: ['original', 'nueva'],
      },
    },
  },
  required: ['fixes'],
};

export function fixPrompt(overlaps) {
  return `Estas frases de un guion se parecen demasiado a frases de OTRO creador (copia textual o frase-firma suya).
Reescribe cada una con palabras propias: mismo sentido, mismo dato, mismo ritmo hablado y la misma marca de *énfasis* si la tenía,
pero sin repetir 5 palabras seguidas del original ni usar ninguna de estas expresiones: ${SIGNATURE.map((s) => `"${s}"`).join(', ')}.

${overlaps.map((o, i) => `${i + 1}. ${o.sentence}`).join('\n')}

Devuelve "fixes" con "original" copiado EXACTAMENTE como aparece arriba y "nueva" con la versión reescrita.`;
}

export function applyFixes(video, overlaps, fixes) {
  let applied = 0;
  for (const f of fixes ?? []) {
    const hit = overlaps.find((o) => o.sentence === f.original) ?? overlaps.find((o) => norm(o.sentence) === norm(f.original));
    if (!hit || !f.nueva) continue;
    const seg = video.segments[hit.seg];
    if (seg.narration.includes(hit.sentence)) { seg.narration = seg.narration.replace(hit.sentence, f.nueva.trim()); applied++; }
  }
  return applied;
}
