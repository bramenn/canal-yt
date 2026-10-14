// Miniatura del short de anime (y su primer fotograma): un personaje en primer plano con una emoción clara y colores
// vivos (naranja, amarillo, turquesa). Codex (image_gen) redibuja el mejor primer plano del tráiler; el texto y el
// 4K los pone lib/thumbnail.js. Si Codex no puede (p. ej. personajes con derechos), se usa el fotograma.
import { copyFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../../lib/ytdlp.js';
import { generateImage } from '../../lib/codeximage.js';
import { composeThumb } from '../../lib/thumbnail.js';

const ff = (args) => run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], 600000);

const prompt = (anime) => `Genera UNA imagen con tu herramienta integrada de generación de imágenes (image_gen). No uses scripts ni pidas OPENAI_API_KEY. No escribas código.

Redibuja la escena de anime de la imagen adjunta (${anime}) como la MINIATURA de un short vertical de YouTube/TikTok, en formato retrato 2:3:
- El mismo personaje, reconocible (cara, pelo, ropa, estilo de animación), en primer plano y algo descentrado hacia abajo, con su emoción exagerada un punto (sorpresa, miedo, rabia o risa) y mirando a cámara si encaja.
- Colores muy vivos y saturados (naranjas, amarillos, turquesas), contraste alto, contorno limpio y nítido, un brillo o halo que lo separe del fondo; fondo simplificado y algo desenfocado.
- El tercio de ARRIBA, despejado y más oscuro o liso: ahí irá un texto que se pone después.
- Sin NINGÚN texto, letra, número, logo ni marca de agua.
Cuando la imagen esté generada, responde solo: listo.`;

/**
 * Miniatura de un short. scenes: escenas del tráiler (con .thumb = puesto si la IA la eligió para miniatura).
 * Devuelve { full: 4K (2160×3840), small: 1080×1920 (< 2 MB, para subir a YouTube) }.
 */
export async function makeThumb({ script, anime, scenes, dir }, log, signal) {
  const best = [...scenes].sort((a, b) => (a.thumb ?? 99) - (b.thumb ?? 99))[0];
  if (!best) throw new Error('Sin escenas para la miniatura');
  const frame = path.join(dir, 'thumb-frame.png');
  await ff(['-ss', String((best.s + best.e) / 2), '-i', best.file, '-frames:v', '1', frame]);
  let art = frame;
  log('🖼 Miniatura: Codex redibuja el mejor primer plano…');
  try {
    const gen = await generateImage({ prompt: prompt(anime), ref: frame }, signal);
    art = path.join(dir, `thumb-art${path.extname(gen) || '.png'}`);
    await copyFile(gen, art);
  } catch (e) { log(`⚠️ Codex no pudo (${e.message.slice(0, 120)}): uso el fotograma del tráiler`); }
  return composeThumb({ art, text: script.thumb_text || script.title, word: script.thumb_word, dir }, log);
}

/** Pone la miniatura como primer fotograma (0,3 s) de un vídeo ya montado: recodifica la imagen, copia el audio. */
export async function firstFrame(video, thumb) {
  const tmp = video.replace(/\.mp4$/, '.tmp.mp4');
  await ff(['-i', video, '-loop', '1', '-t', '1', '-i', thumb, '-filter_complex', "[1:v]scale=1080:1920[t];[0:v][t]overlay=enable='lt(t,0.3)':eof_action=pass[o]",
    '-map', '[o]', '-map', '0:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', tmp]);
  await rename(tmp, video);
}
