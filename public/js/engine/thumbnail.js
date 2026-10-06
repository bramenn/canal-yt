// Miniaturas 1280×720 con la fórmula del canal: 2-4 palabras enormes, una línea en rojo/amarillo,
// pegatina inclinada con cifra y un objeto plano con sombras desplazadas.
import { C, THEME, setTheme, fitSize, headline, sticker, arrow, icon, background, font } from './draw.js';

export const TW = 1280;
export const TH = 720;

export const THUMB_DEFAULT = {
  lines: [{ text: 'ESPERA...', color: 'white' }, { text: '¿CUÁNTO?', color: 'red' }],
  sticker: { label: 'Mínimo', value: '92.000 $' },
  icon: 'gpu',
  icon2: 'model',
  layout: 'top',
};

function textBlock(ctx, lines, { x, cy, maxW, maxSize = 150, align = 'left' }) {
  let size = Math.min(maxSize, 520 / Math.max(1, lines.length));
  const up = lines.map((l) => ({ ...l, text: String(l.text).toUpperCase() }));
  for (const ln of up) size = Math.min(size, fitSize(ctx, ln.text, maxW, size, 800));
  const lh = size * 0.9;
  const top = cy - (lh * up.length) / 2;
  let width = 0;
  up.forEach((ln, i) => { width = Math.max(width, headline(ctx, ln.text, x, top + lh * (i + 1) - size * 0.1, size, ln.color, align)); });
  return { top, bottom: top + lh * up.length, size, width };
}

/** Dibuja la miniatura `spec` en un contexto de cualquier tamaño (escala automáticamente). */
export function drawThumb(ctx, spec = THUMB_DEFAULT, t = 0.6) {
  const prevTheme = THEME.name;
  setTheme('infografia');
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  ctx.save();
  ctx.scale(cw / TW, ch / TH);
  background(ctx, TW, TH);
  ctx.fillStyle = '#141414';
  ctx.fillRect(0, 0, TW, TH);

  const lines = spec.lines?.length ? spec.lines : THUMB_DEFAULT.lines;
  const st = spec.sticker;
  const ic = spec.icon || 'gpu';
  const ic2 = spec.icon2 && spec.icon2 !== 'none' ? spec.icon2 : null;

  if (spec.layout === 'top') {
    const tb = textBlock(ctx, lines, { x: TW / 2, cy: 150, maxW: 1160, align: 'center', maxSize: 130 });
    const y = Math.max(tb.bottom + 210, 470);
    if (ic2) {
      icon(ctx, ic2, 330, y, 330, t);
      arrow(ctx, 520, y, 640, { thick: 22, head: 50 });
      icon(ctx, ic, 880, y + 10, 420, t);
      if (st) sticker(ctx, 840, y - 150, st.label, st.value, { size: 66, rot: -0.06 });
    } else {
      icon(ctx, ic, TW / 2 - 120, y, 460, t);
      if (st) sticker(ctx, TW / 2 + 300, y - 40, st.label, st.value, { size: 74, rot: -0.06 });
    }
  } else if (spec.layout === 'arrow') {
    const tb = textBlock(ctx, lines, { x: 70, cy: 310, maxW: 560, maxSize: 140 });
    arrow(ctx, 660, 320, 800, { thick: 24, head: 56 });
    icon(ctx, ic, 1030, 330, 400, t);
    if (ic2) icon(ctx, ic2, 1030, 600, 220, t);
    if (st) sticker(ctx, 70 + Math.min(tb.width, 560) * 0.45, tb.bottom + 90, st.label, st.value, { size: 60, rot: -0.05 });
  } else {
    const tb = textBlock(ctx, lines, { x: 70, cy: st ? 300 : 360, maxW: 580, maxSize: 160 });
    if (ic2) icon(ctx, ic2, 1150, 170, 220, t, { rot: 0.08 });
    icon(ctx, ic, 990, 410, 460, t);
    if (st) sticker(ctx, 70 + Math.min(tb.width, 580) * 0.42, tb.bottom + 100, st.label, st.value, { size: 70, rot: -0.05 });
  }
  ctx.restore();
  setTheme(prevTheme);
}

export function thumbToPNG(spec, filename = 'miniatura.png') {
  const c = document.createElement('canvas');
  c.width = TW; c.height = TH;
  drawThumb(c.getContext('2d'), spec);
  c.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
}

export { font };
