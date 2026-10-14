// Short vertical en cómic (1080×1920): viñetas en marco de cómic sobre papel, que entran como al pasar página,
// subtítulos grandes palabra a palabra, gancho al principio y crédito del podcast. Determinista (vista previa y MP4).
export const CW = 1080, CH = 1920;
const PAPER = '#efe9dd', INK = '#111', ACCENT = '#c8102e', YELLOW = '#ffd21f';
const M = 46;                                   // margen del marco
const FRAME = { x: M, y: 250, w: CW - 2 * M, h: 1240 };
const SLIDE = 0.32;                              // entrada de cada viñeta
const HOOK_SECS = 3.2;

const cache = new Map();
export function loadPanel(url) {
  if (!url) return Promise.resolve(null);
  if (!cache.has(url)) cache.set(url, new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => resolve(null); i.src = url; }));
  return cache.get(url);
}
const ready = new Map();
export async function preloadShort(short) {
  await document.fonts.load('80px Anton').catch(() => {}); // si no, el primer dibujo sale con otra letra
  for (const p of short.panels ?? []) if (p.image?.url) ready.set(p.image.url, await loadPanel(p.image.url));
}

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const easeOut = (p) => 1 - (1 - p) ** 3;

function cover(ctx, img, x, y, w, h, zoom = 1) {
  const s = Math.max(w / img.width, h / img.height) * zoom;
  ctx.drawImage(img, x + (w - img.width * s) / 2, y + (h - img.height * s) / 2, img.width * s, img.height * s);
}

function drawPanel(ctx, panel, n, local, dur, dy = 0) {
  const { x, y, w, h } = FRAME;
  ctx.save();
  ctx.translate(0, dy);
  // sombra dura del cómic
  ctx.fillStyle = INK;
  ctx.fillRect(x + 14, y + 14, w, h);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x, y, w, h);
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  const img = ready.get(panel.image?.url);
  if (img) cover(ctx, img, x, y, w, h, 1 + 0.05 * clamp(local / Math.max(1, dur)));
  else {
    ctx.fillStyle = '#ddd'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#666'; ctx.textAlign = 'center'; ctx.font = '600 40px Inter, sans-serif';
    ctx.fillText(`Viñeta ${n + 1} sin dibujar`, CW / 2, y + h / 2 - 20);
    ctx.font = '30px Inter, sans-serif';
    wrap(ctx, panel.desc ?? '', CW / 2, y + h / 2 + 30, w - 120, 40, 4);
  }
  ctx.restore();
  ctx.save();
  ctx.translate(0, dy);
  ctx.lineWidth = 10; ctx.strokeStyle = INK;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

function wrap(ctx, text, cx, y, maxW, lh, maxLines) {
  const words = String(text).split(/\s+/);
  let line = '', n = 0;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, cx, y + n * lh); line = w; if (++n >= maxLines) return; }
    else line = test;
  }
  if (line) ctx.fillText(line, cx, y + n * lh);
}

// subtítulos: grupos de hasta 4 palabras (cortando en pausas y puntuación)
function chunksOf(words) {
  const out = [];
  let cur = [];
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    if (cur.length >= 4 || /[.?!…,;:]$/.test(w[0]) || (next && next[1] - w[2] > 0.6)) { out.push(cur); cur = []; }
  });
  if (cur.length) out.push(cur);
  return out;
}

function drawCaption(ctx, words, t) {
  if (!words?.length) return;
  words.chunks ??= chunksOf(words);
  const chunk = words.chunks.find((c) => t >= c[0][1] - 0.05 && t < c.at(-1)[2] + 0.25);
  if (!chunk) return;
  ctx.save();
  ctx.font = '82px Anton, Impact, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const text = chunk.map((w) => w[0].toUpperCase());
  const space = ctx.measureText(' ').width;
  // dos líneas si no cabe
  const lines = [[]];
  let lw = 0;
  text.forEach((w, i) => {
    const ww = ctx.measureText(w).width;
    if (lw && lw + space + ww > CW - 140) { lines.push([]); lw = 0; }
    lines.at(-1).push(i); lw += (lw ? space : 0) + ww;
  });
  const y0 = 1590 - (lines.length - 1) * 48;
  lines.forEach((idx, li) => {
    const total = idx.reduce((a, i, k) => a + ctx.measureText(text[i]).width + (k ? space : 0), 0);
    let x = CW / 2 - total / 2;
    for (const i of idx) {
      const w = chunk[i];
      const now = t >= w[1] - 0.03 && t < w[2] + 0.08;
      ctx.lineWidth = 14; ctx.strokeStyle = INK; ctx.strokeText(text[i], x, y0 + li * 96);
      ctx.fillStyle = now ? YELLOW : '#fff'; ctx.fillText(text[i], x, y0 + li * 96);
      x += ctx.measureText(text[i]).width + space;
    }
  });
  ctx.restore();
}

function drawHook(ctx, hook, t) {
  if (!hook || t > HOOK_SECS) return;
  const p = Math.min(easeOut(clamp(t / 0.3)), clamp((HOOK_SECS - t) / 0.3));
  ctx.save();
  ctx.globalAlpha = p;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // el gancho cabe en 2 líneas como mucho: si no, letra más pequeña
  let size = 74, lines = [];
  for (; size >= 46; size -= 4) {
    ctx.font = `${size}px Anton, Impact, sans-serif`;
    lines = [];
    let cur = '';
    for (const w of String(hook).toUpperCase().split(/\s+/)) {
      const test = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(test).width > CW - 160 && cur) { lines.push(cur); cur = w; } else cur = test;
    }
    if (cur) lines.push(cur);
    if (lines.length <= 2) break;
  }
  const lh = size * 1.16;
  const h = lines.length * lh + 40;
  const y = 125 - h / 2 + 10;
  ctx.fillStyle = INK; ctx.fillRect(M, y, CW - 2 * M, h);
  ctx.fillStyle = ACCENT; ctx.fillRect(M, y + h - 12, CW - 2 * M, 12);
  ctx.fillStyle = '#fff';
  lines.forEach((l, i) => ctx.fillText(l, CW / 2, y + 20 + lh / 2 + i * lh));
  ctx.restore();
}

/** Dibuja el instante t (segundos desde el inicio del short). */
export function drawComic(ctx, short, t, { credit = '' } = {}) {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, CW, CH);
  const panels = short.panels ?? [];
  const dur = short.end - short.start;
  let i = panels.findLastIndex((p) => p.t <= t);
  if (i < 0) i = 0;
  if (panels[i]) {
    const local = t - panels[i].t;
    const pdur = (panels[i + 1]?.t ?? dur) - panels[i].t;
    if (i > 0 && local < SLIDE) {
      // la nueva viñeta sube y empuja a la anterior, como al pasar página
      const q = easeOut(local / SLIDE);
      const shift = (FRAME.h + 160) * q;
      drawPanel(ctx, panels[i - 1], i - 1, t - panels[i - 1].t, panels[i].t - panels[i - 1].t, -shift);
      drawPanel(ctx, panels[i], i, local, pdur, FRAME.h + 160 - shift);
    } else drawPanel(ctx, panels[i], i, local, pdur);
  }
  drawHook(ctx, short.hook, t);
  drawCaption(ctx, short.words, t);
  if (credit) {
    ctx.save();
    ctx.font = '600 30px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(17,17,17,.7)';
    ctx.fillText(`🎙 ${credit}`, CW / 2, CH - 70);
    ctx.restore();
  }
}
