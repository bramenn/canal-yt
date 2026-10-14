// Miniaturas 4K (2160×3840) comunes a las apps, con lo que funciona en YouTube/TikTok: 2-4 palabras grandes en
// Anton con borde grueso y una resaltada, en la zona segura de arriba (lejos de los botones de abajo y la derecha).
// El dibujo (de Codex, un fotograma…) se amplía con IA (Real-ESRGAN para anime/ilustración, necesita Vulkan/GPU)
// o, si no está, con lanczos; el texto se pone aquí a 4K (los modelos de imagen aún escriben mal).
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './ytdlp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FONTS = path.join(HERE, 'fonts');
const ESRGAN = process.env.REALESRGAN_BIN || path.join(HERE, '..', '.tools/realesrgan/realesrgan-ncnn-vulkan');
const W4 = 2160, H4 = 3840;
const ff = (args) => run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], 600000);
// brillo medio (0-255) de una imagen: la reduce a 1 píxel gris
const brightness = (file) => new Promise((resolve) => execFile('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=1:1:flags=area,format=gray', '-f', 'rawvideo', '-'],
  { encoding: 'buffer' }, (_e, out) => resolve(out?.[0] ?? 0)));
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]/g, '');

function ass(text, word, color) {
  const Y = norm(word);
  const words = String(text).toUpperCase().split(/\s+/).filter(Boolean);
  // 2 líneas lo más iguales posible (si son 3+ palabras)
  const len = (k) => Math.max(words.slice(0, k).join(' ').length, words.slice(k).join(' ').length);
  let cut = words.length;
  if (words.length > 2) for (let k = 1; k < words.length; k++) if (len(k) < len(cut)) cut = k;
  // tamaño: que la línea más larga ocupe ~88% del ancho (Anton: ~0,27 em por letra), sin pasarse de 720 px
  const size = Math.round(Math.min(720, (W4 * 0.88) / (0.27 * len(cut))));
  const paint = (ws) => ws.map((w) => `{\\c${norm(w) === Y ? color : '&H00FFFFFF&'}}${w.replace(/[{}\\]/g, '')}`).join(' ');
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
 * art: imagen de fondo (vertical). text/word: texto de la miniatura y la palabra resaltada (color ASS, amarillo por
 * defecto). grade: retoque de color de ffmpeg. Escribe <prefix>-4k.jpg (2160×3840) y <prefix>.jpg (1080×1920, < 2 MB).
 */
export async function composeThumb({ art, text, word, dir, prefix = 'thumb', color = '&H0000D2FF&', grade = 'eq=saturation=1.25:contrast=1.08' }, log = () => {}) {
  if (existsSync(ESRGAN)) {
    const up = path.join(dir, `${prefix}-art-x4.png`);
    const want = await brightness(art);
    // con gráficas integradas a veces sale en negro: se comprueba y se reintenta en trozos más pequeños
    for (const tile of [[], ['-t', '256']]) {
      try { await run(ESRGAN, ['-i', art, '-o', up, '-n', 'realesrgan-x4plus-anime', ...tile], 600000); } catch (e) { log(`⚠️ Real-ESRGAN: ${e.message.slice(0, 80)}`); continue; }
      if (await brightness(up) >= want * 0.6) { art = up; log('🔍 Miniatura ampliada ×4 con Real-ESRGAN'); break; }
      log('⚠️ Real-ESRGAN devolvió una imagen en negro: reintento');
    }
    if (art !== up) log('↪️ Amplío con lanczos');
  }
  // fondo a 4K: cubrir 9:16, retoque de color, enfoque y bordes oscuros que llevan la vista al centro
  const bg = path.join(dir, `${prefix}-bg.png`);
  await ff(['-i', art, '-vf', `scale=${W4}:${H4}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W4}:${H4},${grade},unsharp=5:5:${art.endsWith('-x4.png') ? 0.3 : 0.8},vignette=PI/5`, '-frames:v', '1', bg]);
  const assFile = path.join(dir, `${prefix}.ass`);
  await writeFile(assFile, ass(text, word, color));
  const full = path.join(dir, `${prefix}-4k.jpg`);
  // máxima calidad JPEG (q 1) y sin submuestreo de color (4:4:4): bordes del texto limpios
  await ff(['-loop', '1', '-t', '1', '-i', bg, '-vf', `subtitles=${assFile}:fontsdir=${FONTS},format=yuvj444p`, '-frames:v', '1', '-q:v', '1', full]);
  const small = path.join(dir, `${prefix}.jpg`);
  await ff(['-i', full, '-vf', 'scale=1080:1920:flags=lanczos', '-q:v', '3', small]);
  return { full, small };
}
