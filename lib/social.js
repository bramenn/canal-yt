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

export const COMMENT_SCHEMA = { type: 'string', minLength: 8, maxLength: 240 };
export const commentRules = `
- "suggested_comment": un comentario listo para copiar y publicar bajo este vídeo: UNA pregunta concreta, natural y fácil de responder, de 8 a 240 caracteres, relacionada con su historia o personajes. Invita a elegir, imaginar o compartir una experiencia; no basta «¿qué opinas?». Debe entenderse sin leer la descripción. No inventes hechos ni polémicas, no pidas likes, etiquetas, compartir ni «comenta sí», no añadas hashtags, enlaces, explicaciones ni comillas alrededor. No modifiques el guion del vídeo.`;

/** Para vídeos antiguos: prepara solo el comentario, sin regenerar el texto ni el vídeo. */
export async function writeComment(about, emit, track) {
  const ev = await claudeStep({
    prompt: `Vídeo de anime en español.\n${about}\n${commentRules}`,
    schema: { type: 'object', properties: { suggested_comment: COMMENT_SCHEMA }, required: ['suggested_comment'] },
    system: 'Propón una pregunta honesta que invite a conversar sobre este vídeo.', effort: 'low', tools: [],
  }, emit, track);
  const comment = typeof ev.data?.suggested_comment === 'string' ? ev.data.suggested_comment.trim() : '';
  if (comment.length < 8 || comment.length > 240) throw new Error('No se obtuvo un comentario válido');
  return comment;
}

/** Instrucciones para la IA (se añaden al prompt que ya describe el vídeo). */
export const copyRules = ({ brand, keywordsHint, long = false }) => `
Texto para publicarlo (en español, sin inventar datos; nada de «link en la bio» ni promesas falsas):
- "yt_title": título de YouTube${long ? '' : ' Shorts'} de ≤ 70 caracteres. Empieza por la palabra clave que la gente busca (${keywordsHint}) y sigue con el gancho de curiosidad. Estilo del canal: cada palabra con inicial mayúscula («Que», «Su», «De») y 2-3 palabras clave en MAYÚSCULAS completas (el nombre famoso + 1-2 de impacto), nunca más de 3 ni el título entero. Ej.: «NARUTO: 6 TRAMPAS Que Vencieron A Enemigos Mucho Más FUERTES». Sin hashtags.
- "yt_description": 2-4 líneas cortas: 1) una frase gancho que repite las palabras clave de forma natural; 2) contexto en 1-2 frases con nombres propios buscables; 3) una PREGUNTA directa para que comenten (que se pueda responder fácil: opinión o «¿qué habrías hecho tú?»). Sin hashtags (van aparte).
- "yt_hashtags": 3-5 hashtags sin '#', de más concreto a más general (los 3 primeros salen encima del título: que sean los más específicos y buscados), ${long ? 'sin "Shorts"' : 'y el último "Shorts"'}.
- "tt_caption": texto de TikTok de 1-2 frases (≤ 150 caracteres): empieza con las palabras clave de búsqueda y termina con una pregunta directa que invite a comentar. Sin hashtags.
- "tt_hashtags": 3-5 hashtags sin '#': 2 de nicho, 1-2 generales con mucho público, y "${brand.replace(/^@/, '')}" al final.`;

/** Escribe el texto de publicación. about: de qué va el short (título, historia, guion). Devuelve { yt_title, … }. */
export async function writeCopy({ about, brand, keywordsHint, includeComment = false, long = false }, emit, track) {
  const ev = await claudeStep({
    prompt: `${long ? 'Vídeo largo de YouTube y Facebook.' : 'Short vertical para YouTube Shorts y TikTok.'}\n${about}\n${copyRules({ brand, keywordsHint, long })}${includeComment ? commentRules : ''}`,
    schema: { type: 'object', properties: { ...COPY_SCHEMA, ...(includeComment ? { suggested_comment: COMMENT_SCHEMA } : {}) }, required: [...COPY_FIELDS, ...(includeComment ? ['suggested_comment'] : [])] },
    system: 'Eres experto en crecimiento de canales de Shorts y TikTok en español.', effort: 'low', tools: [],
  }, emit, track);
  return ev.data;
}
