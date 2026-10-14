// Texto para publicar en YouTube Shorts y TikTok, común a las apps, con lo que recomiendan para 2026:
// YouTube: título con la palabra clave al principio (≤ 70), descripción con gancho + palabras clave + pregunta para
// comentarios, 3-5 hashtags con los 3 más concretos primero (salen encima del título) y #Shorts.
// TikTok: texto corto con las palabras de búsqueda al principio + pregunta directa, 3-5 hashtags (nicho + general + marca).
import { claudeStep } from './claude.js';

export const COPY_SCHEMA = {
  yt_title: { type: 'string' },
  yt_description: { type: 'string' },
  yt_hashtags: { type: 'array', items: { type: 'string' } },
  tt_caption: { type: 'string' },
  tt_hashtags: { type: 'array', items: { type: 'string' } },
};
export const COPY_FIELDS = Object.keys(COPY_SCHEMA);

/** Instrucciones para la IA (se añaden al prompt que ya describe el vídeo). */
export const copyRules = ({ brand, keywordsHint }) => `
Texto para publicarlo (en español, sin inventar datos; nada de «link en la bio» ni promesas falsas):
- "yt_title": título de YouTube Shorts de ≤ 70 caracteres. Empieza por la palabra clave que la gente busca (${keywordsHint}) y sigue con el gancho de curiosidad. Palabras clave en MAYÚSCULAS como mucho 3. Sin hashtags.
- "yt_description": 2-4 líneas cortas: 1) una frase gancho que repite las palabras clave de forma natural; 2) contexto en 1-2 frases con nombres propios buscables; 3) una PREGUNTA directa para que comenten (que se pueda responder fácil: opinión o «¿qué habrías hecho tú?»). Sin hashtags (van aparte).
- "yt_hashtags": 3-5 hashtags sin '#', de más concreto a más general (los 3 primeros salen encima del título: que sean los más específicos y buscados), y el último "Shorts".
- "tt_caption": texto de TikTok de 1-2 frases (≤ 150 caracteres): empieza con las palabras clave de búsqueda y termina con una pregunta directa que invite a comentar. Sin hashtags.
- "tt_hashtags": 3-5 hashtags sin '#': 2 de nicho, 1-2 generales con mucho público, y "${brand.replace(/^@/, '')}" al final.`;

/** Escribe el texto de publicación. about: de qué va el short (título, historia, guion). Devuelve { yt_title, … }. */
export async function writeCopy({ about, brand, keywordsHint }, emit, track) {
  const ev = await claudeStep({
    prompt: `Short vertical para YouTube Shorts y TikTok.\n${about}\n${copyRules({ brand, keywordsHint })}`,
    schema: { type: 'object', properties: COPY_SCHEMA, required: COPY_FIELDS },
    system: 'Eres experto en crecimiento de canales de Shorts y TikTok en español.', model: 'sonnet', effort: 'low', tools: [],
  }, emit, track);
  return ev.data;
}
