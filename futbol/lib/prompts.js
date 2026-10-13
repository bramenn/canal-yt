// Prompts + JSON Schema del guion de fútbol (biografía narrada sobre fotos). Biblia de estilo: futbol/style/estilo.md
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STYLE_FILE = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'style', 'estilo.md');
const loadStyle = () => (existsSync(STYLE_FILE) ? readFileSync(STYLE_FILE, 'utf8') : '');
export const WPM = 150; // ritmo medido en el vídeo de referencia (≈ 950 palabras en 6:20)

const SHOTS = `
## PLANOS (fotos a pantalla completa con zoom lento y fundido)
El vídeo es una sucesión de fotos reales que ilustran literalmente lo que dice la voz. No hay rótulos ni gráficos.
- Cambia de plano cada 2-5 s de narración (≈ 6-12 palabras). Un segmento de 40 s lleva 9-14 planos. Nunca más de 6 s sin cambiar.
- "cue" = las primeras 2-5 palabras EXACTAS (copiadas literal) de la frase donde entra el plano. El primer plano de cada segmento puede tener cue vacío.
- "desc" = qué se ve, concreto y comprobable: jugador + club/selección + momento ("Endrick celebrando con Palmeiras, 2023", "Ancelotti dando instrucciones en la banda", "Florentino Pérez firmando un contrato").
- "query" = búsqueda corta de imágenes en internet: nombre completo + club o evento + año, sin artículos ni verbos ("Endrick Palmeiras 2023", "Carlo Ancelotti Real Madrid", "Estadio Santiago Bernabéu"). Si el momento exacto no tendrá foto libre, busca la persona o el lugar.
- Varía: primer plano del protagonista, la persona de la que se habla (entrenador, presidente, rival), el estadio, el trofeo, la afición. No repitas la misma query dos planos seguidos.`;

const VERACITY = `
## VERACIDAD
Cada cifra, fecha, traspaso, gol y declaración debe estar verificado en la web (WebSearch/WebFetch) y en "sources". Si un dato es dudoso, no lo uses o dilo como "según la prensa española". Nunca inventes declaraciones textuales.`;

export function systemPrompt() {
  return `Eres el guionista de un canal de YouTube de fútbol en español latinoamericano neutro: vídeos-explicación de 5-8 minutos sobre un jugador, un fichaje o una decisión de un club, narrados por una voz en off sobre fotos.
Esta es la biblia de estilo, estudiada de los vídeos del canal:

${loadStyle()}
${SHOTS}
${VERACITY}`;
}

const shot = {
  type: 'object',
  properties: { cue: { type: 'string' }, desc: { type: 'string' }, query: { type: 'string' } },
  required: ['cue', 'desc', 'query'],
};

export const SEGMENT_SCHEMA = {
  type: 'object',
  properties: {
    section: { type: 'string', description: 'GANCHO, ORIGEN, ASCENSO, FICHAJE, PROBLEMA, GIRO, ACTUALIDAD, CIERRE…' },
    narration: { type: 'string' },
    shots: { type: 'array', items: shot, minItems: 3 },
  },
  required: ['section', 'narration', 'shots'],
};

export const VIDEO_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    alt_titles: { type: 'array', items: { type: 'string' } },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    segments: { type: 'array', items: SEGMENT_SCHEMA, minItems: 3 },
    sources: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['title', 'url'] } },
  },
  required: ['title', 'alt_titles', 'description', 'tags', 'segments', 'sources'],
};

export function scriptPrompt({ topic, minutes = 6, notes = '' }) {
  minutes = Math.min(20, Math.max(1, Number(minutes) || 6));
  const words = Math.round(minutes * WPM);
  // partes según la duración: ~40-50 s cada una (1 min ≈ 3 partes, 6 min ≈ 8, 10 min ≈ 12)
  const segs = Math.min(16, Math.max(3, Math.round(minutes * 1.25)));
  return `Fecha de hoy: ${new Date().toISOString().slice(0, 10)}.
Tema del vídeo: ${topic}
Duración objetivo: ${minutes} min ≈ ${words} palabras de narración en total (±10 %).
${notes ? `Indicaciones del creador: ${notes}\n` : ''}
Proceso:
1. Lee referencias/ (Glob + Read) para calibrar el ritmo y la estructura del canal. No copies frases.
2. Investiga con WebSearch/WebFetch (al menos 6 búsquedas): trayectoria, cifras (goles, partidos, minutos, traspasos), fechas, declaraciones de entrenadores, la situación actual a fecha de hoy.
3. Escribe el guion en ${Math.max(3, segs - 1)}-${segs + 1} segmentos siguiendo la estructura de la biblia: gancho con la paradoja → "para entenderlo hay que volver al principio" → historia cronológica con giros → la explicación de fondo → situación actual y cierre.
4. Diseña los planos de cada segmento (ver PLANOS).
5. title: el título en el formato del canal (MAYÚSCULAS en las palabras clave, ≤ 100 caracteres). alt_titles: 4 alternativas. description: 2-3 frases que no destripen el final + 3 hashtags. tags: 10-15.`;
}

// ---------- guion propio: el texto del usuario NO pasa por la IA ----------
const countWords = (t) => t.split(/\s+/).filter(Boolean).length;

/** Divide un guion en partes de ~30-45 s sin cambiar ni una letra: por párrafos y, si son largos, por frases. */
export function splitScript(text) {
  const paras = String(text).replace(/\r/g, '').split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  const parts = [];
  for (const p of paras) {
    if (countWords(p) <= 130) { parts.push(p); continue; }
    let cur = '';
    for (const sent of p.split(/(?<=[.?!…])\s+/)) {
      if (cur && countWords(`${cur} ${sent}`) > 100) { parts.push(cur); cur = sent; } else cur = cur ? `${cur} ${sent}` : sent;
    }
    if (cur) parts.push(cur);
  }
  // partes muy cortas (un título, una frase suelta) se unen a la siguiente
  const out = [];
  for (const p of parts) {
    if (out.length && countWords(out.at(-1)) < 25) out[out.length - 1] = `${out.at(-1)} ${p}`;
    else out.push(p);
  }
  return out;
}

const importShot = { type: 'object', properties: { cue: { type: 'string' }, desc: { type: 'string' }, query: { type: 'string' } }, required: ['cue', 'desc', 'query'] };
export const IMPORT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    alt_titles: { type: 'array', items: { type: 'string' } },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    segments: {
      type: 'array',
      items: { type: 'object', properties: { index: { type: 'number' }, section: { type: 'string' }, shots: { type: 'array', items: importShot, minItems: 1 } }, required: ['index', 'section', 'shots'] },
    },
  },
  required: ['title', 'alt_titles', 'description', 'tags', 'segments'],
};

export const importSystem = () => `Eres el editor visual de un canal de YouTube de fútbol narrado sobre fotos. Te dan un guion YA ESCRITO por el creador: no lo reescribes, no lo corriges y no lo resumes; solo decides qué se ve en cada momento.
${SHOTS}`;

export function importPrompt(parts, title = '') {
  return `Guion del creador${title ? ` para el vídeo «${title}»` : ''}, dividido en partes numeradas. NO cambies el texto.
Para cada parte: "section" (etiqueta corta en mayúsculas: GANCHO, ORIGEN, ASCENSO, PROBLEMA, GIRO, ACTUALIDAD, CIERRE…) y sus planos (ver PLANOS). El "cue" de cada plano tiene que ser una secuencia de 2-5 palabras copiada LITERALMENTE de esa parte, en el orden en que aparecen.
Además: "title" ${title ? `(usa exactamente «${title}»)` : '(en el formato del canal: MAYÚSCULAS en las palabras clave, ≤ 100 caracteres)'}, "alt_titles" (4), "description" (2-3 frases sin destripar el final + 3 hashtags) y "tags" (10-15).

${parts.map((p, i) => `[PARTE ${i}]\n${p}`).join('\n\n')}

Devuelve "segments" con "index" = el número de la parte (0, 1, 2…), una por parte y en orden.`;
}
