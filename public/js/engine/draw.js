// Primitivas de dibujo en canvas con la estética del canal:
// fondo casi negro, bloques planos con sombras desplazadas roja/azul, tipografía condensada enorme.

import { LOGOS, LOGO_IDS, isLogo, logoImage } from './logos.js';
import { objectDrawers } from './objects.js';
import { OBJECT_NAMES } from './object-list.js';

export const W = 1920;
export const H = 1080;

// Dos estilos estudiados en los vídeos de referencia:
//  - infografia: gris muy oscuro, titulares sans en mayúsculas con palabra clave amarilla, píldoras mono, tags con cifras.
//  - pizarra: negro, trazo a mano blanco con anotaciones neón (amarillo, rosa, cian, verde, rojo).
const PALETTES = {
  infografia: {
    bg: '#171717', bg2: '#202020', white: '#F2F0EA', red: '#E5413A', yellow: '#F5C518', blue: '#2E7BE6',
    green: '#6CC24A', pink: '#E5413A', ink: '#0d0d0d', grey: '#8d8d8d', silver: '#d8d9dc', orange: '#E0794F',
    lite: '#F2F0EA', onWhite: '#0d0d0d', cell: '#2a2a2a',
  },
  pizarra: {
    bg: '#050505', bg2: '#0c0c0c', white: '#F4F4F4', red: '#FF4D4D', yellow: '#FFE14D', blue: '#4FC3FF',
    green: '#62E36B', pink: '#FF4FB8', ink: '#050505', grey: '#a9a9a9', silver: '#d8d9dc', orange: '#FF9A4D',
    lite: '#F4F4F4', onWhite: '#050505', cell: '#2a2a2a',
  },
  // papel claro, tipo periódico/revista: noticias, polémicas, citas. "white" es el color de texto principal.
  editorial: {
    bg: '#F1ECE2', bg2: '#E4DDCD', white: '#151515', red: '#C9362B', yellow: '#C98A00', blue: '#1F5FC4',
    green: '#3B8A2A', pink: '#C9362B', ink: '#151515', grey: '#6B665C', silver: '#d8d9dc', orange: '#C96A3A',
    lite: '#F7F3EA', onWhite: '#F1ECE2', cell: '#D6CEBC',
  },
  // negro con acentos neón y titulares monoespaciados: vídeos técnicos (IA local, motores, benchmarks)
  terminal: {
    bg: '#05090B', bg2: '#0C1519', white: '#D9FFE9', red: '#FF4D6D', yellow: '#3CFF8F', blue: '#3CC8FF',
    green: '#3CFF8F', pink: '#FF4FD8', ink: '#03110A', grey: '#5E8574', silver: '#d8d9dc', orange: '#FFB13C',
    lite: '#D9FFE9', onWhite: '#03110A', cell: '#12231C',
  },
};
export const THEMES = Object.keys(PALETTES);

export const C = { ...PALETTES.infografia };
export const THEME = { name: 'infografia', chalk: false, light: false, mono: false };

export function setTheme(name) {
  const key = PALETTES[name] ? name : 'infografia';
  Object.assign(C, PALETTES[key]);
  THEME.name = key;
  THEME.chalk = key === 'pizarra';
  THEME.light = key === 'editorial';
  THEME.mono = key === 'terminal';
}

export const FONT = '"Inter Tight", "Arial Narrow", sans-serif';
export const HAND = '"Kalam", "Caveat", cursive';
export const MONO = '"JetBrains Mono", ui-monospace, monospace';

export const colorOf = (name) => ({ white: C.white, red: C.red, yellow: C.yellow, blue: C.blue, green: C.green, pink: C.pink }[name] || C.white);

// ---------- tiempo / easing ----------
export const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const prog = (t, start, dur) => clamp((t - start) / dur);
export const ease = {
  out: (x) => 1 - Math.pow(1 - x, 3),
  out5: (x) => 1 - Math.pow(1 - x, 5),
  inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  back: (x) => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); },
  elastic: (x) => (x === 0 ? 0 : x === 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * (2 * Math.PI) / 3) + 1),
};
// pseudo-aleatorio determinista (los fotogramas deben ser reproducibles al hacer scrub)
export const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

// ---------- texto ----------
export function font(ctx, size, weight = 800, family = FONT) {
  if (THEME.chalk && family !== MONO) { family = HAND; weight = 700; size *= 1.08; }
  else if (THEME.mono && family === FONT) { family = MONO; weight = Math.min(weight, 700); size *= 0.9; }
  ctx.font = `${weight} ${Math.round(size)}px ${family}`;
}

export function measure(ctx, text, size, weight = 800, family = FONT, spacing = 0) {
  font(ctx, size, weight, family);
  ctx.letterSpacing = `${spacing}px`;
  const w = ctx.measureText(String(text).replace(/\*/g, '')).width;
  ctx.letterSpacing = '0px';
  return w;
}

export function fitSize(ctx, text, maxW, size, weight = 800, family = FONT, spacing = 0) {
  const w = measure(ctx, text, size, weight, family, spacing);
  return w > maxW ? Math.floor((size * maxW) / w) : size;
}

export function txt(ctx, s, x, y, o = {}) {
  const { size = 80, color = C.white, weight = 800, family = FONT, align = 'left', base = 'alphabetic', spacing = 0, maxW } = o;
  const sz = maxW ? fitSize(ctx, s, maxW, size, weight, family, spacing) : size;
  font(ctx, sz, weight, family);
  ctx.letterSpacing = `${spacing}px`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = base;
  ctx.fillText(s, x, y);
  ctx.letterSpacing = '0px';
  return sz;
}

/** Línea de titular. Admite *palabra clave* (en amarillo, o blanco si la línea ya es amarilla).
 *  Si la línea es blanca y termina en "." el punto va en rojo (firma visual de las miniaturas). */
export function headline(ctx, text, x, y, size, color, align = 'left') {
  font(ctx, size, 800);
  ctx.letterSpacing = `${-size * 0.015}px`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const base = colorOf(color);
  const accent = base === C.yellow ? C.white : C.yellow;
  const parts = [];
  String(text).split('*').forEach((seg, i) => { if (seg) parts.push({ s: seg, c: i % 2 ? accent : base }); });
  const last = parts[parts.length - 1];
  if (last && last.c === C.white && /[^.]\.$/.test(last.s)) {
    last.s = last.s.slice(0, -1);
    parts.push({ s: '.', c: C.red });
  }
  const widths = parts.map((p) => ctx.measureText(p.s).width);
  const total = widths.reduce((a, b) => a + b, 0);
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  parts.forEach((p, i) => { ctx.fillStyle = p.c; ctx.fillText(p.s, cx, y); cx += widths[i]; });
  ctx.letterSpacing = '0px';
  return total;
}

/** Texto con dígitos que "ruedan" como una tragaperras y se fijan de izquierda a derecha. */
export function rollText(str, p, t) {
  const digits = [...str].filter((c) => /\d/.test(c)).length;
  if (!digits || p >= 1) return str;
  let k = 0;
  return [...str].map((c) => {
    if (!/\d/.test(c)) return c;
    k++;
    const lockAt = k / (digits + 1);
    return p > lockAt ? c : String(Math.floor(hash(Math.floor(t * 24) + k * 7) * 10));
  }).join('');
}

/** Parte texto con *énfasis* en palabras [{w, em}]. */
export function richWords(text) {
  const out = [];
  let em = false;
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    let w = raw;
    const open = w.startsWith('*');
    if (open) { em = true; w = w.slice(1); }
    const close = /\*[^\w]*$/.test(w);
    w = w.replace(/\*/g, '');
    out.push({ w, em });
    if (close) em = false;
  }
  return out;
}

/** Ajusta palabras a líneas de ancho máximo. Devuelve [[{w,em,x}], ...]. */
export function wrapWords(ctx, words, maxW, size, weight = 700, family = FONT) {
  font(ctx, size, weight, family);
  const space = ctx.measureText(' ').width;
  const lines = [[]];
  let x = 0;
  for (const wd of words) {
    const w = ctx.measureText(wd.w).width;
    if (x + w > maxW && lines[lines.length - 1].length) { lines.push([]); x = 0; }
    lines[lines.length - 1].push({ ...wd, x, width: w });
    x += w + space;
  }
  return lines;
}

// ---------- formas ----------
export function rrect(ctx, x, y, w, h, r = 0) {
  ctx.beginPath();
  if (r && ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

export const SHADOW_DOUBLE = [[-10, 10, C.blue], [10, 14, C.red]];
export const SHADOW_RED = [[12, 12, C.red]];
export const SHADOW_BLUE = [[-12, 12, C.blue]];

/** Bloque plano con sombras desplazadas (la firma visual). */
export function block(ctx, x, y, w, h, o = {}) {
  const { fill = C.white, stroke = null, lw = 6, r = 4, shadows = SHADOW_DOUBLE } = o;
  for (const [dx, dy, col] of shadows) { rrect(ctx, x + dx, y + dy, w, h, r); ctx.fillStyle = col; ctx.fill(); }
  rrect(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.lineWidth = lw; ctx.strokeStyle = stroke; ctx.stroke(); }
}

export function poly(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

/** Pegatina blanca inclinada: etiqueta pequeña + valor grande en rojo. */
export function sticker(ctx, cx, cy, label, value, o = {}) {
  const { rot = -0.06, scale = 1, valueColor = C.red, size = 96 } = o;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.scale(scale, scale);
  const vw = measure(ctx, value, size, 800);
  const lw = label ? measure(ctx, label.toUpperCase(), size * 0.24, 700, FONT, size * 0.05) : 0;
  const w = Math.max(vw, lw) + size * 0.7;
  const h = label ? size * 1.45 : size * 1.15;
  block(ctx, -w / 2, -h / 2, w, h, { fill: '#fbfaf6', r: 6, shadows: [[-8, 8, C.blue], [9, 10, C.red]] });
  rrect(ctx, -w / 2 + 8, -h / 2 + 8, w - 16, h - 16, 3);
  ctx.lineWidth = 3; ctx.strokeStyle = C.red; ctx.stroke();
  if (label) txt(ctx, label.toUpperCase(), 0, -h / 2 + size * 0.36, { size: size * 0.24, weight: 700, color: C.ink, align: 'center', spacing: size * 0.05 });
  txt(ctx, value, 0, h / 2 - size * 0.24, { size, color: valueColor, align: 'center' });
  ctx.restore();
}

/** Flecha amarilla gruesa. */
export function arrow(ctx, x1, y, x2, o = {}) {
  const { color = C.yellow, thick = 26, head = 60 } = o;
  if (x2 - x1 < 4) return;
  const hx = Math.max(x1, x2 - head);
  ctx.fillStyle = color;
  ctx.fillRect(x1, y - thick / 2, hx - x1, thick);
  poly(ctx, [[hx, y - head * 0.75], [x2, y], [hx, y + head * 0.75]]);
  ctx.fill();
}

export function ban(ctx, cx, cy, r, p = 1) {
  ctx.save();
  ctx.lineWidth = r * 0.16;
  ctx.strokeStyle = C.red;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
  ctx.stroke();
  if (p > 0.7) {
    const q = (p - 0.7) / 0.3;
    const a = Math.PI / 4;
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(a) * r, cy - Math.sin(a) * r);
    ctx.lineTo(cx - Math.cos(a) * r + 2 * Math.cos(a) * r * q, cy - Math.sin(a) * r + 2 * Math.sin(a) * r * q);
    ctx.stroke();
  }
  ctx.restore();
}

export function check(ctx, cx, cy, r, p = 1) {
  ctx.save();
  block(ctx, cx - r, cy - r, r * 2, r * 2, { fill: C.yellow, r: r, shadows: SHADOW_RED });
  ctx.lineWidth = r * 0.22; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = C.ink;
  ctx.beginPath();
  const pts = [[cx - r * 0.45, cy], [cx - r * 0.1, cy + r * 0.38], [cx + r * 0.5, cy - r * 0.35]];
  ctx.moveTo(...pts[0]);
  if (p < 0.5) ctx.lineTo(lerp(pts[0][0], pts[1][0], p * 2), lerp(pts[0][1], pts[1][1], p * 2));
  else { ctx.lineTo(...pts[1]); ctx.lineTo(lerp(pts[1][0], pts[2][0], (p - 0.5) * 2), lerp(pts[1][1], pts[2][1], (p - 0.5) * 2)); }
  ctx.stroke();
  ctx.restore();
}

// ---------- iconos ilustrados ----------

function fan(ctx, cx, cy, r, t) {
  ctx.fillStyle = C.ink;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = C.white; ctx.lineWidth = r * 0.07;
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.93, 0, Math.PI * 2); ctx.stroke();
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(t * 5);
  ctx.strokeStyle = C.yellow; ctx.lineWidth = r * 0.09; ctx.lineCap = 'round';
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * 0.2, Math.sin(a) * r * 0.2);
    ctx.quadraticCurveTo(Math.cos(a + 0.35) * r * 0.6, Math.sin(a + 0.35) * r * 0.6, Math.cos(a + 0.15) * r * 0.8, Math.sin(a + 0.15) * r * 0.8);
    ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = C.blue; ctx.beginPath(); ctx.arc(cx, cy, r * 0.17, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = C.white; ctx.beginPath(); ctx.arc(cx, cy, r * 0.06, 0, Math.PI * 2); ctx.fill();
}

function burst(ctx, cx, cy, r, t, color = C.orange) {
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(t * 0.4);
  ctx.strokeStyle = color; ctx.lineCap = 'round';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const len = r * (0.75 + 0.25 * hash(i));
    ctx.lineWidth = r * 0.16;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * 0.12, Math.sin(a) * r * 0.12);
    ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len); ctx.stroke();
  }
  ctx.restore();
}

const ICON_DRAW = {
  gpu(ctx, S, t) {
    const w = S, h = S * 0.56;
    block(ctx, -w / 2, -h / 2, w, h, { fill: C.yellow, r: 6, stroke: C.ink, lw: 5, shadows: [[14, 14, C.red]] });
    const r = h * 0.33;
    fan(ctx, -w * 0.22, -h * 0.06, r, t);
    fan(ctx, w * 0.2, -h * 0.06, r, t + 0.3);
    ctx.fillStyle = C.ink;
    for (let i = 0; i < 3; i++) ctx.fillRect(-w * 0.42 + i * w * 0.07, h * 0.34, w * 0.045, h * 0.05);
    ctx.fillRect(-w / 2, h * 0.28, w, 4);
  },
  mac(ctx, S, t) {
    const w = S, h = S * 0.34;
    const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
    g.addColorStop(0, '#f2f3f5'); g.addColorStop(0.55, '#cfd1d5'); g.addColorStop(1, '#9fa2a8');
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    rrect(ctx, -w / 2 + 14, h / 2 - 6, w - 28, 22, 10); ctx.fill();
    rrect(ctx, -w / 2, -h / 2, w, h, h * 0.16); ctx.fillStyle = g; ctx.fill();
    ctx.fillStyle = '#e9eaec'; rrect(ctx, -w / 2, -h / 2, w, h * 0.12, [h * 0.16, h * 0.16, 0, 0]); ctx.fill();
    ctx.fillStyle = '#2b2c30';
    ctx.fillRect(-w * 0.38, h * 0.02, w * 0.012, h * 0.2);
    ctx.fillRect(-w * 0.35, h * 0.02, w * 0.012, h * 0.2);
    ctx.fillRect(-w * 0.31, h * 0.1, w * 0.07, h * 0.035);
    ctx.fillStyle = '#58f08a'; ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 3);
    ctx.beginPath(); ctx.arc(w * 0.4, h * 0.12, w * 0.008, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
  },
  chip(ctx, S, t, o) {
    const s = S * 0.62;
    ctx.strokeStyle = C.grey; ctx.lineWidth = 6;
    for (let i = 0; i < 6; i++) {
      const p = -s / 2 + s * (0.14 + i * 0.145);
      ctx.beginPath(); ctx.moveTo(p, -s / 2 - 22); ctx.lineTo(p, -s / 2); ctx.moveTo(p, s / 2); ctx.lineTo(p, s / 2 + 22);
      ctx.moveTo(-s / 2 - 22, p); ctx.lineTo(-s / 2, p); ctx.moveTo(s / 2, p); ctx.lineTo(s / 2 + 22, p); ctx.stroke();
    }
    const g = ctx.createLinearGradient(-s / 2, -s / 2, s / 2, s / 2);
    g.addColorStop(0, '#2a2a33'); g.addColorStop(1, '#101014');
    block(ctx, -s / 2, -s / 2, s, s, { fill: g, r: 14, stroke: '#5b5b6b', lw: 4, shadows: [[-10, 10, C.blue], [10, 12, C.red]] });
    const shine = ctx.createLinearGradient(-s / 2, 0, s / 2, 0);
    const k = (t * 0.25) % 1.6 - 0.3;
    shine.addColorStop(clamp(k - 0.1), 'rgba(255,255,255,0)');
    shine.addColorStop(clamp(k), 'rgba(255,255,255,.12)');
    shine.addColorStop(clamp(k + 0.1), 'rgba(255,255,255,0)');
    rrect(ctx, -s / 2, -s / 2, s, s, 14); ctx.fillStyle = shine; ctx.fill();
    const label = (o?.label || 'AI').toUpperCase();
    txt(ctx, label, 0, s * 0.1, { size: s * 0.3, color: C.lite, align: 'center', base: 'middle', maxW: s * 0.8 });
    if (o?.sub) txt(ctx, o.sub.toUpperCase(), 0, s * 0.3, { size: s * 0.09, color: C.grey, align: 'center', weight: 700, spacing: 3, maxW: s * 0.8 });
  },
  server(ctx, S, t) {
    const w = S * 0.66, h = S * 0.92;
    block(ctx, -w / 2, -h / 2, w, h, { fill: C.yellow, r: 8, stroke: C.ink, lw: 5, shadows: [[16, 16, C.red]] });
    const rows = 4, rh = (h - 60) / rows;
    for (let i = 0; i < rows; i++) {
      const y = -h / 2 + 30 + i * rh;
      ctx.fillStyle = C.ink; rrect(ctx, -w / 2 + 24, y + 6, w - 90, rh - 12, 6); ctx.fill();
      ctx.fillStyle = i % 2 ? C.blue : C.red;
      ctx.fillRect(-w / 2 + 40, y + rh * 0.3, 18, 8);
      ctx.fillStyle = C.lite; ctx.fillRect(-w / 2 + 70, y + rh * 0.3, 40, 6);
      const fr = rh * 0.3;
      fan(ctx, w * 0.02, y + rh / 2, fr, t + i);
      fan(ctx, w * 0.02 + fr * 2.3, y + rh / 2, fr, t + i + 0.5);
    }
    ctx.fillStyle = C.ink;
    for (let i = 0; i < 9; i++) ctx.fillRect(w / 2 - 50, -h / 2 + 60 + i * (h - 120) / 9, 30, 6);
  },
  ram(ctx, S, t, o) {
    const w = S * 0.8, h = S * 0.62;
    block(ctx, -w / 2, -h / 2, w, h, { fill: C.blue, r: 6, shadows: [[14, 14, C.red]] });
    ctx.fillStyle = C.yellow;
    for (let i = 0; i < 14; i++) ctx.fillRect(-w / 2 + 30 + i * (w - 60) / 14, h / 2 - 34, (w - 60) / 14 - 8, 22);
    const label = (o?.label || 'RAM').toUpperCase();
    txt(ctx, label, 0, -h * 0.02, { size: h * 0.3, color: C.lite, align: 'center', base: 'middle', maxW: w * 0.85 });
    if (label !== 'RAM') txt(ctx, 'RAM', 0, h * 0.22, { size: h * 0.1, color: C.lite, align: 'center', weight: 700, spacing: 10 });
  },
  // modelo de IA genérico (red neuronal): neutro, no se parece al logo de ninguna empresa
  model(ctx, S, t) {
    const s = S * 0.62;
    block(ctx, -s / 2, -s / 2, s, s, { fill: '#1d1d1d', r: 4, stroke: C.lite, lw: 6, shadows: [[12, 12, C.red]] });
    const cols = [[-0.3, [-0.22, 0, 0.22]], [0, [-0.3, -0.1, 0.1, 0.3]], [0.3, [-0.15, 0.15]]].map(([x, ys]) => ys.map((y) => [x * s, y * s]));
    // conexiones, con un pulso que recorre la red
    ctx.lineWidth = Math.max(2, s * 0.012);
    for (let c = 0; c < cols.length - 1; c++) {
      for (const [x1, y1] of cols[c]) for (const [x2, y2] of cols[c + 1]) {
        const k = (Math.sin(t * 3 - c * 1.2 + y1 * 0.02 + y2 * 0.03) + 1) / 2;
        ctx.strokeStyle = `rgba(242,240,234,${0.18 + 0.35 * k})`;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
    }
    cols.forEach((col, c) => col.forEach(([x, y], k) => {
      ctx.fillStyle = c === 1 ? C.yellow : c === 2 ? C.blue : C.lite;
      ctx.beginPath(); ctx.arc(x, y, s * 0.055, 0, Math.PI * 2); ctx.fill();
    }));
  },
  // asterisco naranja (disponible a propósito; ya no es el icono por defecto de "modelo")
  burst(ctx, S, t) {
    const s = S * 0.62;
    block(ctx, -s / 2, -s / 2, s, s, { fill: '#1d1d1d', r: 4, stroke: C.lite, lw: 6, shadows: [[12, 12, C.red]] });
    burst(ctx, 0, 0, s * 0.36, t);
  },
  cloud(ctx, S, t) {
    const r = S * 0.17;
    const shape = (c, dx, dy, grow = 0) => {
      c.beginPath();
      c.arc(-r * 1.3 + dx, r * 0.3 + dy, r + grow, 0, Math.PI * 2);
      c.moveTo(r * 1.35 + grow + dx, -r * 0.3 + dy);
      c.arc(0 + dx, -r * 0.3 + dy, r * 1.35 + grow, 0, Math.PI * 2);
      c.moveTo(r * 2.45 + grow + dx, r * 0.3 + dy);
      c.arc(r * 1.4 + dx, r * 0.3 + dy, r * 1.05 + grow, 0, Math.PI * 2);
      c.rect(-r * 1.3 + dx, r * 0.3 + dy - grow, r * 2.7, r + grow * 2);
    };
    if (ctx.__chalk) {
      // contorno de la unión: trazo grueso y luego "borrar" el interior con el color de fondo
      const raw = ctx.__raw;
      shape(raw, 0, 0, 3); raw.fillStyle = C.white; raw.fill();
      shape(raw, 0, 0, -3); raw.fillStyle = C.bg; raw.fill();
      return;
    }
    const draw = (dx, dy, col) => { shape(ctx, dx, dy); ctx.fillStyle = col; ctx.fill(); };
    draw(-10, 12, C.blue); draw(12, 14, C.red); draw(0, 0, C.white);
  },
  laptop(ctx, S, t) {
    const w = S * 0.8, h = S * 0.5;
    block(ctx, -w / 2, -h / 2 - 30, w, h, { fill: '#232323', r: 12, stroke: C.silver, lw: 10, shadows: [[12, 12, C.red]] });
    ctx.fillStyle = C.yellow;
    for (let i = 0; i < 4; i++) ctx.fillRect(-w / 2 + 50, -h / 2 + 10 + i * 40, (w - 140) * (0.4 + 0.6 * hash(i + Math.floor(t * 2))), 16);
    ctx.fillStyle = C.silver; poly(ctx, [[-w / 2 - 50, h / 2 - 20], [w / 2 + 50, h / 2 - 20], [w / 2 + 20, h / 2 + 14], [-w / 2 - 20, h / 2 + 14]]); ctx.fill();
  },
  money(ctx, S, t) {
    const w = S * 0.74, h = S * 0.4;
    block(ctx, -w / 2, -h / 2 - 20, w, h, { fill: '#7fd38a', r: 6, stroke: C.ink, lw: 5, shadows: [[12, 12, C.red]] });
    ctx.strokeStyle = C.ink; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, -20, h * 0.28, 0, Math.PI * 2); ctx.stroke();
    txt(ctx, '$', 0, -20, { size: h * 0.42, color: C.ink, align: 'center', base: 'middle' });
    for (let i = 0; i < 4; i++) {
      const y = h / 2 + 40 - i * 26;
      ctx.fillStyle = C.ink; rrect(ctx, w * 0.1, y - 4, w * 0.4, 30, 15); ctx.fill();
      ctx.fillStyle = C.yellow; rrect(ctx, w * 0.1, y - 8, w * 0.4, 28, 14); ctx.fill();
    }
  },
  doc(ctx, S, t) {
    const w = S * 0.56, h = S * 0.78;
    block(ctx, -w / 2, -h / 2, w, h, { fill: C.blue, r: 2, shadows: [[14, 14, C.red]] });
    ctx.fillStyle = C.white;
    for (let i = 0; i < 10; i++) {
      const lw = (w - 80) * (i % 3 === 2 ? 0.6 : 0.9);
      ctx.fillRect(-w / 2 + 40, -h / 2 + 50 + i * (h - 100) / 10, lw * clamp(t * 1.5 - i * 0.1), 8);
    }
  },
  bolt(ctx, S, t) {
    const s = S * 0.6;
    block(ctx, -s / 2, -s / 2, s, s, { fill: C.ink, r: 4, stroke: C.white, lw: 6, shadows: SHADOW_DOUBLE });
    ctx.fillStyle = C.yellow;
    poly(ctx, [[s * 0.06, -s * 0.38], [-s * 0.22, s * 0.04], [-s * 0.02, s * 0.04], [-s * 0.08, s * 0.38], [s * 0.22, -s * 0.06], [s * 0.02, -s * 0.06]]);
    ctx.fill();
  },
  clock(ctx, S, t) {
    const r = S * 0.32;
    ctx.fillStyle = C.red; ctx.beginPath(); ctx.arc(12, 12, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.white; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.ink; ctx.lineWidth = 10; ctx.lineCap = 'round';
    for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8); ctx.lineTo(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9); ctx.stroke(); }
    const a1 = t * 2 - Math.PI / 2, a2 = t * 0.3 - Math.PI / 2;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a1) * r * 0.7, Math.sin(a1) * r * 0.7); ctx.stroke();
    ctx.lineWidth = 14; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a2) * r * 0.45, Math.sin(a2) * r * 0.45); ctx.stroke();
  },
};

export const ICON_NAMES = [...Object.keys(ICON_DRAW), ...OBJECT_NAMES, ...LOGO_IDS];

/** Dibuja un icono centrado en (cx,cy) con ancho nominal S. o.label para chip/ram. */
/** Logo de una empresa/modelo: SVG original sobre placa blanca, con las sombras del canal. */
function drawLogo(ctx, id, S) {
  const g = ctx.__raw || ctx; // en pizarra la placa sigue siendo sólida (el logo necesita fondo claro)
  const s = S * 0.62;
  block(g, -s / 2, -s / 2, s, s, { fill: '#FFFFFF', r: s * 0.18, stroke: null, shadows: [[12, 12, C.red]] });
  const img = logoImage(id);
  if (img) {
    const k = s * 0.64;
    g.drawImage(img, -k / 2, -k / 2, k, k);
  } else {
    txt(g, LOGOS[id], 0, 0, { size: s * 0.16, color: '#151515', align: 'center', base: 'middle', maxW: s * 0.86 });
  }
}

// objetos de objects.js (se crean al primer uso para no depender del orden de carga de los módulos)
let OBJ = null;
const objDraw = () => (OBJ ??= objectDrawers());

export function icon(ctx, name, cx, cy, S, t = 0, o = {}) {
  if (isLogo(name)) {
    ctx.save(); ctx.translate(cx, cy);
    if (o.rot) ctx.rotate(o.rot);
    if (o.scale != null) ctx.scale(o.scale, o.scale);
    drawLogo(ctx, name, S);
    ctx.restore();
    return;
  }
  const fn = ICON_DRAW[name] || objDraw()[name] || ICON_DRAW.model;
  ctx.save();
  ctx.translate(cx, cy);
  if (o.rot) ctx.rotate(o.rot);
  if (o.scale != null) ctx.scale(o.scale, o.scale);
  fn(ctx, S, t, o);
  ctx.restore();
}

// ---------- píldoras y tags (lenguaje visual de la infografía) ----------

/** Píldora mono en mayúsculas con borde fino de color. Devuelve el ancho. */
export function pill(ctx, text, x, y, o = {}) {
  const { color = C.grey, size = 26, align = 'center', filled = false, textColor } = o;
  const label = String(text).toUpperCase();
  const tw = measure(ctx, label, size, 600, MONO, size * 0.08);
  const w = tw + size * 1.1, h = size * 1.7;
  const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  rrect(ctx, x0, y - h / 2, w, h, 3);
  if (filled) { ctx.fillStyle = color; ctx.fill(); }
  else { ctx.lineWidth = 2.5; ctx.strokeStyle = color; ctx.stroke(); }
  txt(ctx, label, x0 + w / 2, y + 1, { size, family: MONO, weight: 600, color: textColor || (filled ? (color === C.white ? C.onWhite : C.ink) : color), align: 'center', base: 'middle', spacing: size * 0.08 });
  return w;
}

/** Tag relleno con cifra en negrita y sombra corta desplazada. */
export function tag(ctx, text, x, y, o = {}) {
  const { fill = C.yellow, color, size = 54, align = 'center', shadow = C.red } = o;
  const tw = measure(ctx, text, size, 800);
  const w = tw + size * 0.6, h = size * 1.3;
  const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  block(ctx, x0, y - h / 2, w, h, { fill, r: 4, shadows: shadow ? [[size * 0.1, size * 0.1, shadow]] : [] });
  txt(ctx, text, x0 + w / 2, y + size * 0.04, { size, color: color || (fill === C.red || fill === C.blue ? C.lite : fill === C.white ? C.onWhite : C.ink), align: 'center', base: 'middle' });
  return w;
}

// ---------- modo pizarra: convierte rellenos en trazos a mano ----------
const chalkCache = new WeakMap();
export function chalkify(ctx) {
  if (chalkCache.has(ctx)) return chalkCache.get(ctx);
  const proxy = new Proxy(ctx, {
    get(target, prop) {
      if (prop === '__chalk') return true;
      if (prop === '__raw') return target;
      if (prop === 'fillText') return (str, x, y, mw) => {
        // el texto "tinta" iría sobre un relleno que en pizarra es solo contorno: lo pasamos a blanco
        const dark = target.fillStyle === C.ink;
        if (dark) { target.save(); target.fillStyle = C.white; }
        mw === undefined ? target.fillText(str, x, y) : target.fillText(str, x, y, mw);
        if (dark) target.restore();
      };
      if (prop === 'fill') return () => {
        target.save();
        target.strokeStyle = target.fillStyle;
        target.lineWidth = Math.max(3, target.lineWidth);
        target.lineJoin = 'round'; target.lineCap = 'round';
        target.stroke();
        target.restore();
      };
      if (prop === 'fillRect') return (x, y, w, h) => {
        if (w * h > 600 * 400) return; // no dibujar contornos de destellos a pantalla completa
        target.save();
        target.strokeStyle = target.fillStyle;
        target.lineWidth = Math.min(4, Math.max(2, Math.min(w, h) / 2));
        target.lineCap = 'round';
        if (Math.min(w, h) < 10) { target.fillRect(x, y, w, h); } else { target.strokeRect(x, y, w, h); }
        target.restore();
      };
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  chalkCache.set(ctx, proxy);
  return proxy;
}

// ---------- fondo ----------
let grainCanvas = null;
function grain() {
  if (grainCanvas) return grainCanvas;
  grainCanvas = document.createElement('canvas');
  grainCanvas.width = grainCanvas.height = 256;
  const g = grainCanvas.getContext('2d');
  const img = g.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return grainCanvas;
}

export function background(ctx, w = W, h = H) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);
  if (THEME.chalk) return;
  const g = ctx.createRadialGradient(w / 2, h * 0.45, 0, w / 2, h * 0.45, w * 0.6);
  g.addColorStop(0, 'rgba(255,255,255,0.045)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

export function finish(ctx, t, w = W, h = H) {
  const v = ctx.createRadialGradient(w / 2, h / 2, h * 0.45, w / 2, h / 2, w * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, `rgba(0,0,0,${THEME.chalk ? 0.2 : THEME.light ? 0.12 : 0.4})`);
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.globalAlpha = 0.045;
  ctx.globalCompositeOperation = 'overlay';
  const pat = ctx.createPattern(grain(), 'repeat');
  const ox = Math.floor(hash(Math.floor(t * 24)) * 256), oy = Math.floor(hash(Math.floor(t * 24) + 9) * 256);
  ctx.translate(-ox, -oy);
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, w + 256, h + 256);
  ctx.restore();
  // terminal: líneas de barrido muy sutiles
  if (THEME.mono) {
    ctx.save();
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = '#000';
    for (let y = (Math.floor(t * 40) % 4); y < h; y += 4) ctx.fillRect(0, y, w, 1);
    ctx.restore();
  }
}
