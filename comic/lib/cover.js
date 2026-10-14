// Miniatura (y primer fotograma) de un short del cómic: portada de novela gráfica noir con el protagonista en primer
// plano mirando a cámara, dibujada por Codex con una viñeta ya hecha de referencia (el mismo personaje), y 2-4 palabras
// de gancho a 4K (lib/thumbnail.js). Se guarda en la carpeta del episodio: cover-<n>-4k.jpg y cover-<n>.jpg.
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { claudeStep } from '../../lib/claude.js';
import { generateImage } from '../../lib/codeximage.js';
import { composeThumb } from '../../lib/thumbnail.js';
import { STYLE } from './podcast.js';

async function coverText(short, emit, track) {
  const ev = await claudeStep({
    prompt: `Short de TikTok/YouTube con un relato real de crimen contado por su protagonista: «${short.title}».
Gancho del vídeo: «${short.hook}». Texto: ${short.caption ?? ''}

Escribe el texto de su miniatura (primer fotograma): "text" = 2-4 palabras en MAYÚSCULAS que despierten curiosidad o un escalofrío sin contarlo todo y que NO repitan el gancho (ej.: «NADIE LO VIO VENIR», «LA PERDONÓ», «6 DE LA MAÑANA»). Sin palabras explícitas de violencia (nada de «matar», «asesinar», «sangre»). "word" = la palabra de "text" que va resaltada.`,
    schema: { type: 'object', properties: { text: { type: 'string' }, word: { type: 'string' } }, required: ['text', 'word'] },
    system: 'Eres experto en miniaturas de YouTube de true crime.', model: 'sonnet', effort: 'low', tools: [],
  }, emit, track);
  return ev.data;
}

const prompt = (short, hasRef) => `Genera UNA imagen con tu herramienta integrada de generación de imágenes (image_gen). No uses scripts ni pidas OPENAI_API_KEY. No escribas código.

Portada vertical (retrato 2:3) de novela gráfica para la MINIATURA de un short de YouTube/TikTok.
Estilo: ${STYLE}.
Protagonista: ${short.character}.
Lugar: ${short.setting ?? ''}. Relato: «${short.title}».
- El protagonista en primer plano, algo descentrado hacia abajo, mirando a cámara con una emoción intensa y creíble (culpa, miedo, rabia contenida), luz dura que le parte la cara, un elemento clave del relato sugerido detrás.
- Contraste muy alto; el rojo de acento en un solo detalle llamativo.
- El tercio de ARRIBA, oscuro y despejado: ahí irá un texto que se pone después.
- Violencia solo sugerida, nada de sangre ni heridas. Sin NINGÚN texto, letra, número, logo ni marca de agua.
${hasRef ? 'La imagen adjunta es la referencia: mantén IDÉNTICO al protagonista (cara, pelo, ropa) y el estilo de dibujo y entintado.' : ''}
Cuando la imagen esté generada, responde solo: listo.`;

/** short: el short del episodio (con panels[].image.url). refFile: viñeta ya dibujada de referencia (o null). */
export async function makeCover({ short, n, dir, refFile }, emit, track, signal) {
  const log = (text) => emit({ type: 'log', text });
  const { text, word } = await coverText(short, emit, track);
  log(`🖼 Texto de la miniatura: «${text}»`);
  log('🖌 Codex dibuja la portada…');
  const gen = await generateImage({ prompt: prompt(short, !!refFile), ref: refFile }, signal);
  const art = path.join(dir, `cover-${n}-art${path.extname(gen) || '.png'}`);
  await copyFile(gen, art);
  const { full, small } = await composeThumb({ art, text, word, dir, prefix: `cover-${n}`, grade: 'eq=contrast=1.12' }, log);
  const url = (f) => `/media/${path.basename(dir)}/${path.basename(f)}`;
  return { text, word, full: url(full), small: url(small) };
}
