// Miniatura del short (y su primer fotograma), siguiendo lo que funciona en YouTube/TikTok: un personaje en primer
// plano con una emoción clara, 2-4 palabras grandes con borde grueso y una en amarillo, colores vivos (naranja,
// amarillo, turquesa) y el texto en la zona segura (tercio superior, lejos de los botones de abajo y de la derecha).
// El dibujo lo rehace Codex (image_gen) a partir del mejor primer plano del tráiler; el texto se pone aquí a 4K
// (los modelos de imagen aún escriben mal). Si Codex no puede (p. ej. personajes con derechos), se usa el fotograma.
import { writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../lib/ytdlp.js';
import { generateImage } from '../../lib/codeximage.js';

const FONTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fonts');
const W4 = 2160, H4 = 3840;
const ff = (args) => run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], 600000);
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]/g, '');

const prompt = (anime) => `Genera UNA imagen con tu herramienta integrada de generación de imágenes (image_gen). No uses scripts ni pidas OPENAI_API_KEY. No escribas código.

Redibuja la escena de anime de la imagen adjunta (${anime}) como la MINIATURA de un short vertical de YouTube/TikTok, en formato retrato 2:3:
- El mismo personaje, reconocible (cara, pelo, ropa, estilo de animación), en primer plano y algo descentrado hacia abajo, con su emoción exagerada un punto (sorpresa, miedo, rabia o risa) y mirando a cámara si encaja.
- Colores muy vivos y saturados (naranjas, amarillos, turquesas), contraste alto, contorno limpio y nítido, un brillo o halo que lo separe del fondo; fondo simplificado y algo desenfocado.
- El tercio de ARRIBA, despejado y más oscuro o liso: ahí irá un texto que se pone después.
- Sin NINGÚN texto, letra, número, logo ni marca de agua.
Cuando la imagen esté generada, responde solo: listo.`;

function ass(text, word) {
  const Y = norm(word);
  // 2 líneas como mucho, partidas por la mitad de las palabras
  const words = String(text).toUpperCase().split(/\s+/).filter(Boolean);
  // 2 líneas lo más iguales posible (si son 3+ palabras)
  const len = (k) => Math.max(words.slice(0, k).join(' ').length, words.slice(k).join(' ').length);
  let cut = words.length;
  if (words.length > 2) for (let k = 1; k < words.length; k++) if (len(k) < len(cut)) cut = k;
  // tamaño: que la línea más larga ocupe ~88% del ancho (Anton: ~0,27 em por letra), sin pasarse de 720 px
  const size = Math.round(Math.min(720, (W4 * 0.88) / (0.27 * len(cut))));
  const paint = (ws) => ws.map((w) => `{\\c${norm(w) === Y ? '&H0000D2FF&' : '&H00FFFFFF&'}}${w.replace(/[{}\\]/g, '')}`).join(' ');
  const body = [paint(words.slice(0, cut)), words.length > cut ? paint(words.slice(cut)) : ''].filter(Boolean).join('\\N');
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W4}
PlayResY: ${H4}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: T,Anton,${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,2,0,1,${Math.round(size / 13)},${Math.round(size / 30)},8,120,120,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,T,,0,0,0,,{\\pos(${W4 / 2},420)\\frz-3}${body}
`;
}

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
  // fondo a 4K: cubrir 9:16, más color y contraste, enfoque y bordes oscuros que llevan la vista al centro
  const bg = path.join(dir, 'thumb-bg.png');
  await ff(['-i', art, '-vf', `scale=${W4}:${H4}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W4}:${H4},eq=saturation=1.25:contrast=1.08,unsharp=5:5:0.8,vignette=PI/5`, '-frames:v', '1', bg]);
  const assFile = path.join(dir, 'thumb.ass');
  await writeFile(assFile, ass(script.thumb_text || script.title, script.thumb_word));
  const full = path.join(dir, 'thumb-4k.jpg');
  await ff(['-loop', '1', '-t', '1', '-i', bg, '-vf', `subtitles=${assFile}:fontsdir=${FONTS}`, '-frames:v', '1', '-q:v', '2', full]);
  const small = path.join(dir, 'thumb.jpg');
  await ff(['-i', full, '-vf', 'scale=1080:1920:flags=lanczos', '-q:v', '3', small]);
  return { full, small };
}
