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
import { detectFaces } from './animeface.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FONTS = path.join(HERE, 'fonts');
const ESRGAN = process.env.REALESRGAN_BIN || path.join(HERE, '..', '.tools/realesrgan/realesrgan-ncnn-vulkan');
const W4 = 2160, H4 = 3840;
const ff = (args) => run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], 600000);
// brillo medio (0-255) de una imagen: la reduce a 1 píxel gris
const brightness = (file) => new Promise((resolve) => execFile('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=1:1:flags=area,format=gray', '-f', 'rawvideo', '-'],
  { encoding: 'buffer' }, (_e, out) => resolve(out?.[0] ?? 0)));
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]/g, '');

function ass(text, word, color, faceTopRel = null, faceBottomRel = null) {
  const Y = norm(word);
  const words = String(text).toUpperCase().split(/\s+/).filter(Boolean);
  // 2 líneas lo más equilibradas posible (si son 3+ palabras, o 2 palabras que sumen ≥ 11 letras)
  const len = (k) => Math.max(words.slice(0, k).join(' ').length, words.slice(k).join(' ').length);
  let cut = words.length;
  if (words.length > 2 || (words.length === 2 && words.join(' ').length >= 11)) {
    for (let k = 1; k < words.length; k++) if (len(k) < len(cut)) cut = k;
  }
  const hasLine2 = words.length > cut;
  let size = Math.round(Math.min(560, (W4 * 0.86) / (0.28 * len(cut))));

  // Anti-colisión: si se detectó una cara de anime en la zona superior, ajustar para que el texto NUNCA la tape
  const faceTopPx = faceTopRel != null ? Math.round(faceTopRel * H4) : null;
  const faceBottomPx = faceBottomRel != null ? Math.round(faceBottomRel * H4) : null;

  let y1 = hasLine2 ? 80 : 160;
  let y2 = Math.round(y1 + size * 0.76);

  if (faceTopPx != null && faceTopPx < 1450) {
    const roomAbove = faceTopPx - 70;
    const needed = hasLine2 ? 1.62 : 1.0;
    const maxSafeSize = Math.floor(roomAbove / needed);

    if (maxSafeSize >= 280) {
      // Cabe holgado arriba: se reduce la tipografía para no rozar la frente ni los ojos
      size = Math.min(size, maxSafeSize);
      y1 = hasLine2 ? 60 : 120;
      y2 = Math.round(y1 + size * 0.76);
    } else if (faceBottomPx != null && faceBottomPx < 2800) {
      // La cara está pegada al borde superior: se ubica el titular debajo de la cara
      y1 = Math.round(faceBottomPx + 80);
      y2 = Math.round(y1 + size * 0.76);
      size = Math.min(size, 480);
    }
  }

  const paint = (ws) => ws.map((w) => `{\\c${norm(w) === Y ? color : '&H00FFFFFF&'}}${w.replace(/[{}\\]/g, '')}`).join(' ');
  const line1 = paint(words.slice(0, cut));
  const line2 = hasLine2 ? paint(words.slice(cut)) : '';

  const events = [
    `Dialogue: 0,0:00:00.00,0:00:05.00,T,,0,0,0,,{\\pos(${W4 / 2},${y1})\\frz-3}${line1}`,
    ...(line2 ? [`Dialogue: 0,0:00:00.00,0:00:05.00,T,,0,0,0,,{\\pos(${W4 / 2},${y2})\\frz-3}${line2}`] : []),
  ].join('\n');
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W4}
PlayResY: ${H4}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: T,Anton,${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,2,0,1,${Math.round(size / 13)},${Math.round(size / 28)},8,100,100,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;
}

/**
 * art: imagen de fondo (vertical). text/word: texto de la miniatura y la palabra resaltada (color ASS, amarillo por
 * defecto). grade: retoque de color de ffmpeg. Escribe <prefix>-4k.jpg (2160×3840) y <prefix>.jpg (1080×1920, < 2 MB).
 */
export async function composeThumb({ art, text, word, dir, prefix = 'thumb', color = '&H0000D2FF&', grade = 'eq=saturation=1.25:contrast=1.08' }, log = () => {}) {
  // Proporción original para detectar si es un fotograma horizontal de tráiler (16:9)
  const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', art]).catch(() => '');
  const [inW, inH] = probe.trim().split(',').map(Number);
  const ratio = (inW && inH) ? inW / inH : 9 / 16;
  const isWide = ratio > 1.15;

  // Detección automática de caras para encuadre inteligente y anti-colisión con el texto
  let faceTopRel = null, faceBottomRel = null, faceCx = 0.5, faceCy = 0.42;
  try {
    const fd = await detectFaces(art);
    const faces = fd?.samples?.[0]?.faces || [];
    if (faces.length) {
      const sorted = [...faces].sort((a, b) => b[2] - a[2]);
      const mainFace = sorted[0];
      faceCx = mainFace[0];
      faceCy = mainFace[1];
      faceTopRel = Math.min(...faces.map((f) => f[1] - f[2] * 0.55));
      faceBottomRel = Math.max(...faces.map((f) => f[1] + f[2] * 0.55));
    }
  } catch {}

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

  // fondo a 4K: si es horizontal 16:9, encuadre sobre la cara con margen superior para no decapitar
  let cropVf = `scale=${W4}:${H4}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W4}:${H4}`;
  if (isWide) {
    const fx = Math.max(0.18, Math.min(0.82, faceCx));
    const fy = Math.max(0.20, Math.min(0.80, faceCy));
    cropVf = `scale=${W4}:${H4}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W4}:${H4}:'max(0,min(iw-ow,iw*${fx.toFixed(3)}-ow/2))':'max(0,min(ih-oh,ih*${fy.toFixed(3)}-oh*0.36))'`;
  }

  const bg = path.join(dir, `${prefix}-bg.png`);
  await ff(['-i', art, '-vf', `${cropVf},${grade},unsharp=5:5:${art.endsWith('-x4.png') ? 0.3 : 0.8},vignette=PI/5`, '-frames:v', '1', bg]);
  const assFile = path.join(dir, `${prefix}.ass`);
  await writeFile(assFile, ass(text, word, color, faceTopRel, faceBottomRel));
  const full = path.join(dir, `${prefix}-4k.jpg`);
  // máxima calidad JPEG (q 1) y sin submuestreo de color (4:4:4): bordes del texto limpios
  await ff(['-loop', '1', '-t', '1', '-i', bg, '-vf', `subtitles=${assFile}:fontsdir=${FONTS},format=yuvj444p`, '-frames:v', '1', '-q:v', '1', full]);
  const small = path.join(dir, `${prefix}.jpg`);
  await ff(['-i', full, '-vf', 'scale=1080:1920:flags=lanczos', '-q:v', '3', small]);
  return { full, small };
}

function ass16x9(text, word, color) {
  const LW = 3840, LH = 2160;
  const Y = norm(word);
  const words = String(text).toUpperCase().split(/\s+/).filter(Boolean);
  const len = (k) => Math.max(words.slice(0, k).join(' ').length, words.slice(k).join(' ').length);
  let cut = words.length;
  if (words.length > 1) {
    for (let k = 1; k < words.length; k++) if (len(k) < len(cut)) cut = k;
  }
  const maxChars = Math.max(4, len(cut));
  // El titular va en el tercio/mitad izquierda (ancho ~1650 px de 3840) para dejar libre al protagonista a la derecha
  const size = Math.round(Math.min(520, 1650 / (0.29 * maxChars)));
  const paint = (ws) => ws.map((w) => `{\\c${norm(w) === Y ? color : '&H00FFFFFF&'}}${w.replace(/[{}\\]/g, '')}`).join(' ');
  const line1 = paint(words.slice(0, cut));
  const line2 = words.length > cut ? paint(words.slice(cut)) : '';
  const totalH = line2 ? Math.round(size * 1.62) : size;
  const y1 = Math.round((LH - totalH) / 2 - 40);
  const y2 = Math.round(y1 + size * 0.78);
  const events = [
    `Dialogue: 0,0:00:00.00,0:00:05.00,T,,0,0,0,,{\\an7\\pos(170,${y1})\\frz-2}${line1}`,
    ...(line2 ? [`Dialogue: 0,0:00:00.00,0:00:05.00,T,,0,0,0,,{\\an7\\pos(170,${y2})\\frz-2}${line2}`] : []),
  ].join('\n');
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${LW}
PlayResY: ${LH}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: T,Anton,${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,2,0,1,${Math.round(size / 12)},${Math.round(size / 25)},7,120,120,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;
}

/**
 * Miniatura horizontal 16:9 para vídeos largos de YouTube: 4K (3840×2160) en <prefix>-4k.jpg y HD (1280×720, < 2 MB)
 * en <prefix>.jpg. El titular gigante va en el lado izquierdo despejado para no tapar nunca a los personajes de la derecha.
 */
export async function composeThumb16x9({ art, text, word, dir, prefix = 'thumb', color = '&H0000D2FF&', grade = 'eq=saturation=1.25:contrast=1.08' }, log = () => {}) {
  const LW = 3840, LH = 2160;
  if (existsSync(ESRGAN)) {
    const up = path.join(dir, `${prefix}-art-x4.png`);
    const want = await brightness(art);
    for (const tile of [[], ['-t', '256']]) {
      try { await run(ESRGAN, ['-i', art, '-o', up, '-n', 'realesrgan-x4plus-anime', ...tile], 600000); } catch (e) { log(`⚠️ Real-ESRGAN: ${e.message.slice(0, 80)}`); continue; }
      if (await brightness(up) >= want * 0.6) { art = up; log('🔍 Miniatura 16:9 ampliada ×4 con Real-ESRGAN'); break; }
    }
    if (art !== up) log('↪️ Amplío miniatura 16:9 con lanczos');
  }
  const bg = path.join(dir, `${prefix}-bg.png`);
  await ff(['-i', art, '-vf', `scale=${LW}:${LH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${LW}:${LH},${grade},unsharp=5:5:${art.endsWith('-x4.png') ? 0.3 : 0.8},vignette=PI/5`, '-frames:v', '1', bg]);
  const assFile = path.join(dir, `${prefix}.ass`);
  await writeFile(assFile, ass16x9(text, word, color));
  const full = path.join(dir, `${prefix}-4k.jpg`);
  await ff(['-loop', '1', '-t', '1', '-i', bg, '-vf', `subtitles=${assFile}:fontsdir=${FONTS},format=yuvj444p`, '-frames:v', '1', '-q:v', '1', full]);
  const small = path.join(dir, `${prefix}.jpg`);
  await ff(['-i', full, '-vf', 'scale=1280:720:flags=lanczos', '-q:v', '3', small]);
  return { full, small };
}
