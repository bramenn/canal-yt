// Miniatura 1280×720: fondo temático, jugador recortado en grande con contorno y brillo, texto sugerente y pegatina.
export const TW = 1280, TH = 720;
const FONT = 'Anton';
const YELLOW = '#FFD21F', RED = '#E5262B';

const imgCache = new Map();
export function loadImg(url) {
  if (!imgCache.has(url)) imgCache.set(url, new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; }));
  return imgCache.get(url);
}
export const fontReady = () => document.fonts.load(`100px ${FONT}`).catch(() => {});

function cover(ctx, img, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  ctx.drawImage(img, (w - img.width * s) / 2, (h - img.height * s) / 2, img.width * s, img.height * s);
}

// silueta del recorte en un color (para el contorno y el brillo)
function silhouette(img, w, h, color) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w); c.height = Math.ceil(h);
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0, w, h);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = color;
  x.fillRect(0, 0, w, h);
  return c;
}

// texto en líneas que quepan en maxW, con el tamaño más grande posible
function layoutText(ctx, words, maxW, maxH) {
  for (let size = 170; size >= 50; size -= 4) {
    ctx.font = `${size}px ${FONT}`;
    const lines = [];
    let cur = [];
    for (const w of words) {
      const test = [...cur, w].join(' ');
      if (cur.length && ctx.measureText(test).width > maxW) { lines.push(cur); cur = [w]; } else cur.push(w);
    }
    if (cur.length) lines.push(cur);
    const lh = size * 1.02;
    if (lines.length <= 3 && lines.length * lh <= maxH && lines.every((l) => ctx.measureText(l.join(' ')).width <= maxW)) return { size, lines, lh };
  }
  return { size: 50, lines: [words], lh: 51 };
}

/** t: { bg, cut (imágenes), text, highlight, sticker, side } */
export function drawThumb(ctx, t) {
  const right = t.side !== 'left';
  ctx.save();
  // fondo: más contraste y algo oscuro para que resalten jugador y texto
  ctx.filter = 'saturate(1.25) contrast(1.1) brightness(0.8)';
  if (t.bg) cover(ctx, t.bg, TW, TH); else { ctx.fillStyle = '#123'; ctx.fillRect(0, 0, TW, TH); }
  ctx.filter = 'none';
  // degradado oscuro detrás del texto
  const g = ctx.createLinearGradient(right ? 0 : TW, 0, right ? TW * 0.7 : TW * 0.3, 0);
  g.addColorStop(0, 'rgba(0,0,0,0.85)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, TW, TH);
  const v = ctx.createRadialGradient(TW / 2, TH / 2, TH * 0.4, TW / 2, TH / 2, TW * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = v; ctx.fillRect(0, 0, TW, TH);

  // jugador: ocupa todo el alto (algo más), pegado abajo, con brillo y contorno blanco
  let px = right ? TW : 0, pw = 0;
  if (t.cut) {
    const h = TH * 1.08;
    const w = Math.min(TW * 0.55, (t.cut.width / t.cut.height) * h);
    const hh = (t.cut.height / t.cut.width) * w;
    const x = right ? TW - w - TW * 0.02 : TW * 0.02;
    const y = TH - hh + TH * 0.04;
    px = x; pw = w;
    ctx.save();
    ctx.shadowColor = 'rgba(255,210,31,0.75)';
    ctx.shadowBlur = 45;
    ctx.drawImage(silhouette(t.cut, w, hh, YELLOW), x, y);
    ctx.restore();
    const white = silhouette(t.cut, w, hh, '#fff');
    for (let a = 0; a < 16; a++) ctx.drawImage(white, x + Math.cos((a / 16) * Math.PI * 2) * 7, y + Math.sin((a / 16) * Math.PI * 2) * 7);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 25; ctx.shadowOffsetY = 8;
    ctx.drawImage(t.cut, x, y, w, hh);
    ctx.restore();
  }

  // texto: mayúsculas, contorno negro grueso, una palabra en amarillo
  const words = String(t.text ?? '').toUpperCase().split(/\s+/).filter(Boolean);
  const hl = String(t.highlight ?? '').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
  // el texto ocupa el hueco libre al otro lado del jugador (nunca encima de él)
  const free = right ? px - 48 - 24 : TW - (px + pw) - 48 - 24;
  const area = { x: right ? 48 : px + pw + 24, w: Math.max(TW * 0.4, free), top: 70, h: TH - 160 };
  const { size, lines, lh } = layoutText(ctx, words, area.w, area.h);
  ctx.font = `${size}px ${FONT}`;
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  let y = area.top + (area.h - lines.length * lh) / 2;
  for (const line of lines) {
    let x = area.x;
    for (const word of line) {
      const isHl = hl && word.replace(/[^\p{L}\p{N}]/gu, '') === hl;
      ctx.lineWidth = size * 0.14;
      ctx.strokeStyle = '#000';
      ctx.strokeText(word, x, y);
      ctx.fillStyle = isHl ? YELLOW : '#fff';
      ctx.fillText(word, x, y);
      x += ctx.measureText(`${word} `).width;
    }
    y += lh;
  }

  // pegatina con la cifra, inclinada
  if (t.sticker) {
    const s = String(t.sticker).toUpperCase();
    ctx.font = `64px ${FONT}`;
    const w = ctx.measureText(s).width + 48;
    ctx.save();
    ctx.translate(right ? 60 + w / 2 : TW - 60 - w / 2, TH - 95);
    ctx.rotate(-0.06);
    ctx.fillStyle = '#000'; ctx.fillRect(-w / 2 + 8, -44 + 8, w, 88);
    ctx.fillStyle = RED; ctx.fillRect(-w / 2, -44, w, 88);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(s, 0, 4);
    ctx.restore();
  }
  ctx.restore();
}
