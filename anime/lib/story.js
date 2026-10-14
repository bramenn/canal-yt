// Historias y guiones de los shorts de anime, al estilo de AniDosis (curiosidades contadas con gancho y humor).
// 1) findStories: la IA busca en la web noticias y curiosidades de anime recientes y elige las de más gancho.
// 2) writeScript: guion de ~50 s (gancho, «el problema es que…», explicación, remate), palabras a resaltar
//    y qué se ve en cada frase (escenas del anime o una imagen).
import { claudeStep } from '../../lib/claude.js';

const STORIES_SCHEMA = {
  type: 'object',
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          anime: { type: 'string' }, angle: { type: 'string' }, facts: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } },
        },
        required: ['anime', 'angle', 'facts', 'sources'],
      },
    },
  },
  required: ['stories'],
};

export async function findStories({ count = 3, avoid = [] }, emit, track) {
  const today = new Date().toISOString().slice(0, 10);
  const ev = await claudeStep({
    prompt: `Hoy es ${today}. Busca en la web (noticias de anime de los últimos 7-10 días: Anime News Network, Crunchyroll News, X/Twitter de estudios, Reddit r/anime, ComicBook, CBR, medios japoneses) y elige las ${count} historias de anime con MÁS gancho para un short de TikTok/YouTube en español al estilo del canal AniDosis.

Lo que funciona en ese estilo (de sus shorts con más de 500.000 vistas): una curiosidad o polémica con un giro gracioso o sorprendente, no una noticia seca.
- «Este anime inventó un ataque tan largo que ningún villano lo soporta»
- «Este nuevo anime te advierte de algo antes de empezar»
- «Esta actriz de voz recibió un personaje MUY extraño»
- «Los fans de Dragon Ball están demasiado rotos»
Valen: anuncios con un detalle insólito, récords raros, polémicas de fans, decisiones absurdas de estudios, escenas virales, datos curiosos de un anime nuevo de esta temporada.
Evita: rumores sin fuente, noticias muy de nicho, spoilers enormes sin aviso${avoid.length ? `, y estas historias ya hechas: ${avoid.slice(0, 40).join(' · ')}` : ''}.

Para cada una: "anime" (nombre del anime tal como se busca su tráiler en YouTube, en romaji o inglés), "angle" (el giro gracioso o sorprendente en una frase), "facts" (los datos concretos y verificados: nombres, cifras, fechas, qué pasó exactamente) y "sources" (URLs).`,
    schema: STORIES_SCHEMA, system: 'Eres guionista de un canal de shorts de anime en español. Verificas los datos antes de contarlos.',
    model: 'sonnet', effort: 'medium', tools: ['WebSearch', 'WebFetch'],
  }, emit, track);
  return { stories: (ev.data.stories ?? []).slice(0, count), cost: ev.cost ?? 0 };
}

const SCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
    thumb_text: { type: 'string' },
    thumb_word: { type: 'string' },
    yellow: { type: 'array', items: { type: 'string' } },
    red: { type: 'array', items: { type: 'string' } },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, show: { type: 'string', enum: ['anime', 'imagen'] }, query: { type: 'string' } },
        required: ['text', 'show', 'query'],
      },
    },
  },
  required: ['title', 'description', 'hashtags', 'thumb_text', 'thumb_word', 'yellow', 'red', 'lines'],
};

export async function writeScript(story, emit, track) {
  const ev = await claudeStep({
    prompt: `Escribe el guion de un short vertical de anime (voz en off en español latino, 45-55 segundos: 120-140 palabras, ni una más) al estilo de AniDosis.

Historia: ${story.anime} — ${story.angle}
Datos (no inventes nada más): ${story.facts}

Fórmula de AniDosis:
1. Gancho en la primera frase, que se entiende sin contexto y crea curiosidad («Este anime inventó un ataque que puede vencer a cualquier villano de cualquier anime.»).
2. Giro: «El problema es que…» / «Pero hay un detalle…».
3. Explicación con los datos concretos, con un tono cercano y con humor (habla al espectador: «Mira», «Verás», «Y es que…»).
4. Remate gracioso o sorprendente al final, sin despedidas ni «suscríbete». La última frase puede enlazar con la primera para que el vídeo se vea en bucle.
Frases cortas y naturales para leer en voz alta; los números escritos en palabras; nombres japoneses tal cual.

Devuelve:
- "title": título al estilo AniDosis, palabras clave en MAYÚSCULAS, ≤ 70 caracteres, sin el nombre del canal (p. ej. «Este ANIME Se DESPIDIÓ De La MEJOR Manera POSIBLE!»).
- "thumb_text": el texto de la miniatura (primer fotograma): 2-4 palabras en MAYÚSCULAS que despierten curiosidad o emoción sin contarlo todo y que NO repitan el título (juegan juntos: el título da contexto, la miniatura el gancho). Ej.: «NADIE LO SOPORTA», «¿CANCELADO?», «12 MINUTOS GRITANDO». "thumb_word": la palabra de "thumb_text" que va en amarillo.
- "description": 1-2 frases para la descripción del short. "hashtags": 5-8 sin '#'.
- "lines": el guion frase a frase (cada "text" de 4 a 18 palabras, en orden; juntas forman el guion completo). Para cada frase, qué se ve: "show" = "anime" (escenas del tráiler del anime; "query" = nombre del anime para buscar su tráiler/PV en YouTube, normalmente "${story.anime}") o "imagen" (una foto de algo real: un estudio, una persona, un cartel, un récord; "query" = búsqueda de imágenes concreta). Casi siempre "anime".
- "yellow": 6-12 palabras sueltas del guion que se resaltan en amarillo (nombres, cifras, lo importante). "red": 2-5 palabras que se resaltan en rojo (lo impactante o negativo). Palabras exactas tal como aparecen en el guion.`,
    schema: SCRIPT_SCHEMA, system: 'Eres guionista de shorts virales de anime en español latino.', model: 'sonnet', effort: 'medium', tools: [],
  }, emit, track);
  return { script: ev.data, cost: ev.cost ?? 0 };
}
