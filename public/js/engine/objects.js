// Biblioteca de objetos animados para las escenas (se suman a los iconos de draw.js).
// Mismo lenguaje que el canal: planos de color, contorno de tinta, sombra roja desplazada y un detalle que se mueve.
// Cada objeto se dibuja en un espacio de 100×100 unidades centrado en (0,0); `t` es el tiempo en segundos
// (determinista: el mismo t da el mismo fotograma, para poder exportar).
import { C, rrect } from './draw.js';

const TAU = Math.PI * 2;
const LW = 2.6; // grosor de contorno en unidades
const SH = 4.5; // desplazamiento de la sombra

// ---------- primitivas en unidades ----------
function shape(ctx, path, { fill = C.yellow, stroke = C.ink, lw = LW, shadow = C.red, dx = SH, dy = SH } = {}) {
  if (shadow) { ctx.save(); ctx.translate(dx, dy); path(); ctx.fillStyle = shadow; ctx.fill(); ctx.restore(); }
  path();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.strokeStyle = stroke; ctx.stroke(); }
}
const box = (ctx, x, y, w, h, r, o) => shape(ctx, () => rrect(ctx, x, y, w, h, r), o);
const disc = (ctx, x, y, r, o) => shape(ctx, () => { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); }, o);
const pathOf = (ctx, pts, close = true) => () => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); if (close) ctx.closePath(); };
const poly = (ctx, pts, o) => shape(ctx, pathOf(ctx, pts), o);
function dot(ctx, x, y, r, color) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = color; ctx.fill(); }
function stroke(ctx, pts, color = C.ink, lw = LW, cap = 'round') {
  ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.lineWidth = lw; ctx.lineCap = cap; ctx.lineJoin = 'round'; ctx.strokeStyle = color; ctx.stroke();
}
function arcLine(ctx, x, y, r, a0, a1, color = C.ink, lw = LW) {
  ctx.beginPath(); ctx.arc(x, y, r, a0, a1); ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.strokeStyle = color; ctx.stroke();
}
function label(ctx, text, x, y, size, color = C.ink, weight = 900) {
  ctx.font = `${weight} ${size}px "Inter Tight", sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
const wave = (t, speed = 1, phase = 0) => Math.sin(t * speed * TAU + phase);
const saw = (t, period) => ((t % period) + period) % period / period;
// claro "de material" (papel, pantalla, metal): no cambia con el tema editorial
const LITE = () => C.lite || '#F2F0EA';
// líneas sueltas sobre el fondo: color del texto del tema (claro en temas oscuros, tinta en editorial)
const FG = () => C.white;

export const OBJECTS = {
  // ======================= tecnología =======================
  phone(ctx, t) {
    box(ctx, -22, -42, 44, 84, 9, { fill: '#1d1d1f' });
    box(ctx, -18, -35, 36, 66, 4, { fill: C.blue, stroke: null, shadow: null });
    stroke(ctx, [[-6, -39], [6, -39]], '#555', 2.2);
    // notificación que cae y rebota
    const p = Math.min(1, saw(t, 3) * 3);
    const y = -40 + 18 * (1 - (1 - p) ** 3);
    ctx.globalAlpha = p;
    box(ctx, -15, y, 30, 11, 3, { fill: LITE(), stroke: null, shadow: null });
    dot(ctx, -10, y + 5.5, 2.6, C.red);
    stroke(ctx, [[-5, y + 4], [10, y + 4]], '#999', 1.6); stroke(ctx, [[-5, y + 7.5], [5, y + 7.5]], '#bbb', 1.6);
    ctx.globalAlpha = 1;
  },
  laptopcode(ctx, t) {
    box(ctx, -38, -32, 76, 50, 4, { fill: '#1d1d1f' });
    box(ctx, -33, -27, 66, 40, 2, { fill: '#0b0f12', stroke: null, shadow: null });
    poly(ctx, [[-46, 18], [46, 18], [40, 26], [-40, 26]], { fill: '#cfd1d5' });
    const lines = [[-28, -20, 30, C.yellow], [-24, -13, 22, C.green], [-24, -6, 34, C.blue], [-28, 1, 14, C.yellow], [-24, 8, 26, C.green]];
    const n = Math.floor(saw(t, 4) * 7);
    lines.slice(0, n).forEach(([x, y, w, c]) => stroke(ctx, [[x, y], [x + w, y]], c, 2.6));
    if (Math.floor(t * 2.5) % 2 === 0 && n < 6) { const l = lines[Math.min(n, 4)]; ctx.fillStyle = LITE(); ctx.fillRect(l[0], l[1] - 3, 3, 6); }
  },
  code(ctx, t) {
    box(ctx, -40, -30, 80, 60, 6, { fill: '#14161a' });
    ctx.save(); ctx.translate(0, 2);
    const g = 4 + 3 * Math.max(0, wave(t, 0.6));
    stroke(ctx, [[-14 - g, -14], [-28 - g, 0], [-14 - g, 14]], C.yellow, 5.5);
    stroke(ctx, [[14 + g, -14], [28 + g, 0], [14 + g, 14]], C.yellow, 5.5);
    stroke(ctx, [[6, -17], [-6, 17]], C.red, 5.5);
    ctx.restore();
  },
  terminal(ctx, t) {
    box(ctx, -42, -30, 84, 60, 6, { fill: '#0b0b0c' });
    ctx.fillStyle = '#1c1c1e'; rrect(ctx, -42, -30, 84, 11, [6, 6, 0, 0]); ctx.fill();
    [C.red, C.yellow, C.green].forEach((c, i) => dot(ctx, -35 + i * 6, -24.5, 2, c));
    stroke(ctx, [[-32, -6], [-24, 0], [-32, 6]], C.green, 4);
    if (Math.floor(t * 2) % 2 === 0) { ctx.fillStyle = LITE(); ctx.fillRect(-18, 1, 12, 4); }
  },
  database(ctx, t) {
    for (let i = 2; i >= 0; i--) {
      const y = -24 + i * 20;
      shape(ctx, () => { ctx.beginPath(); ctx.ellipse(0, y + 14, 32, 9, 0, 0, Math.PI); ctx.lineTo(-32, y); ctx.ellipse(0, y, 32, 9, 0, Math.PI, TAU); ctx.closePath(); }, { fill: i === 0 ? C.blue : '#2a5fb0' });
      dot(ctx, 22, y + 9, 2.2, (Math.floor(t * 3) + i) % 3 === 0 ? C.green : '#123');
    }
    shape(ctx, () => { ctx.beginPath(); ctx.ellipse(0, -24, 32, 9, 0, 0, TAU); }, { fill: '#5b95ee', shadow: null });
  },
  cloudup(ctx, t) {
    const cloud = () => { ctx.beginPath(); ctx.arc(-16, 6, 15, Math.PI * 0.5, Math.PI * 1.5); ctx.arc(-2, -10, 19, Math.PI, Math.PI * 1.85); ctx.arc(20, 2, 15, Math.PI * 1.4, Math.PI * 0.5); ctx.closePath(); };
    shape(ctx, cloud, { fill: LITE() });
    const y = 10 - saw(t, 1.2) * 20;
    ctx.globalAlpha = 1 - saw(t, 1.2) * 0.6;
    stroke(ctx, [[2, y + 14], [2, y]], C.blue, 5); stroke(ctx, [[-6, y + 8], [2, y], [10, y + 8]], C.blue, 5);
    ctx.globalAlpha = 1;
  },
  wifi(ctx, t) {
    const lit = Math.floor(saw(t, 1.6) * 4);
    [34, 23, 12].forEach((r, i) => arcLine(ctx, 0, 18, r, Math.PI * 1.22, Math.PI * 1.78, 3 - i <= lit ? C.yellow : '#3a3a3a', 7));
    dot(ctx, 0, 18, 5, C.yellow);
  },
  battery(ctx, t) {
    box(ctx, -36, -18, 66, 36, 6, { fill: '#1d1d1f', stroke: LITE() });
    box(ctx, 30, -8, 7, 16, 2, { fill: LITE(), stroke: null, shadow: null });
    const lvl = 0.15 + 0.85 * saw(t, 3);
    ctx.fillStyle = lvl < 0.3 ? C.red : lvl < 0.6 ? C.yellow : C.green;
    rrect(ctx, -31, -13, 56 * lvl, 26, 3); ctx.fill();
    poly(ctx, [[-2, -14], [-10, 2], [-1, 2], [-5, 15], [8, -3], [-1, -3], [4, -14]], { fill: LITE(), stroke: C.ink, lw: 1.8, shadow: null });
  },
  plug(ctx, t) {
    stroke(ctx, [[-44, 22], [-26, 22], [-18, 14]], '#777', 6);
    box(ctx, -20, -14, 26, 30, 5, { fill: LITE() });
    stroke(ctx, [[6, -6], [18, -6]], C.ink, 4.5, 'butt'); stroke(ctx, [[6, 6], [18, 6]], C.ink, 4.5, 'butt');
    // chispa intermitente
    if (saw(t, 1.4) < 0.25) {
      ctx.save(); ctx.translate(28, 0); ctx.rotate(t * 3);
      for (let i = 0; i < 6; i++) { ctx.rotate(TAU / 6); stroke(ctx, [[5, 0], [12, 0]], C.yellow, 3); }
      ctx.restore();
    }
  },
  gear(ctx, t) {
    const g = (x, y, R, teeth, rot, fill) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
      shape(ctx, () => {
        ctx.beginPath();
        for (let i = 0; i < teeth * 2; i++) {
          const a = (i / (teeth * 2)) * TAU, r = i % 2 ? R : R * 1.22, a2 = ((i + 1) / (teeth * 2)) * TAU;
          ctx.arc(0, 0, r, a, a2);
        }
        ctx.closePath();
      }, { fill });
      dot(ctx, 0, 0, R * 0.35, C.ink);
      ctx.restore();
    };
    g(-10, 4, 24, 8, t * 0.8, C.yellow);
    g(24, -20, 13, 6, -t * 1.47 + 0.3, C.blue);
  },
  robot(ctx, t) {
    stroke(ctx, [[0, -32], [0, -42]], C.ink, 3); dot(ctx, 0, -44, 4.5, wave(t, 1) > 0 ? C.red : '#7a1f1b');
    box(ctx, -32, -32, 64, 54, 12, { fill: '#cfd1d5' });
    box(ctx, -24, -22, 48, 26, 7, { fill: '#14161a', stroke: null, shadow: null });
    const blink = saw(t, 3.2) > 0.94 ? 0.15 : 1;
    [-11, 11].forEach((x) => { ctx.save(); ctx.translate(x, -9); ctx.scale(1, blink); dot(ctx, 0, 0, 5, C.blue); ctx.restore(); });
    stroke(ctx, [[-10, 12], [10, 12]], C.ink, 3);
    box(ctx, -38, -12, 6, 16, 3, { fill: '#9fa2a8', shadow: null }); box(ctx, 32, -12, 6, 16, 3, { fill: '#9fa2a8', shadow: null });
    box(ctx, -18, 26, 36, 14, 4, { fill: '#9fa2a8' });
  },
  brain(ctx, t) {
    const lobe = (sx) => () => {
      ctx.beginPath();
      ctx.moveTo(0, -30); ctx.bezierCurveTo(sx * 18, -42, sx * 40, -30, sx * 36, -10);
      ctx.bezierCurveTo(sx * 46, 4, sx * 36, 28, sx * 18, 26); ctx.bezierCurveTo(sx * 10, 36, 0, 30, 0, 24); ctx.closePath();
    };
    shape(ctx, lobe(-1), { fill: '#F29CB4' }); shape(ctx, lobe(1), { fill: '#F29CB4', shadow: null });
    stroke(ctx, [[0, -30], [0, 24]], C.ink, 2.4);
    [[-24, -14, -10, -18], [-28, 6, -12, 2], [-16, 18, -6, 10], [24, -14, 10, -18], [28, 6, 12, 2], [16, 18, 6, 10]].forEach(([a, b, c, d]) => stroke(ctx, [[a, b], [c, d]], '#a24a63', 2.2));
    // sinapsis que viajan
    for (let i = 0; i < 3; i++) {
      const k = saw(t + i * 0.37, 1.1);
      const pts = [[-24, -14], [-10, -18], [10, -18], [24, -14]];
      const seg = Math.min(2, Math.floor(k * 3)), f = k * 3 - seg;
      const [x1, y1] = pts[seg], [x2, y2] = pts[seg + 1];
      dot(ctx, x1 + (x2 - x1) * f, y1 + (y2 - y1) * f, 2.8, C.yellow);
    }
  },
  sparkles(ctx, t) {
    const star = (x, y, r, c, ph) => {
      const k = 0.75 + 0.25 * wave(t, 0.8, ph);
      poly(ctx, [[x, y - r * k], [x + r * 0.22 * k, y - r * 0.22 * k], [x + r * k, y], [x + r * 0.22 * k, y + r * 0.22 * k], [x, y + r * k], [x - r * 0.22 * k, y + r * 0.22 * k], [x - r * k, y], [x - r * 0.22 * k, y - r * 0.22 * k]], { fill: c, lw: 2 });
    };
    star(-8, 6, 32, C.yellow, 0); star(26, -24, 15, LITE(), 2); star(28, 22, 10, C.blue, 4);
  },
  lightbulb(ctx, t) {
    const glow = 0.5 + 0.5 * wave(t, 0.7);
    ctx.save(); ctx.globalAlpha = 0.25 * glow;
    for (let i = 0; i < 10; i++) { const a = -Math.PI * 0.95 + (i / 9) * Math.PI * 0.9 - Math.PI * 0.025; stroke(ctx, [[Math.cos(a) * 36, -8 + Math.sin(a) * 36], [Math.cos(a) * 46, -8 + Math.sin(a) * 46]], C.yellow, 4); }
    ctx.restore();
    shape(ctx, () => { ctx.beginPath(); ctx.arc(0, -10, 26, Math.PI * 0.8, Math.PI * 2.2); ctx.lineTo(10, 22); ctx.lineTo(-10, 22); ctx.closePath(); }, { fill: glow > 0.3 ? C.yellow : '#e0b416' });
    stroke(ctx, [[-6, 10], [-4, -4], [0, 2], [4, -4], [6, 10]], C.ink, 2.2);
    box(ctx, -11, 22, 22, 13, 3, { fill: '#9fa2a8' });
    stroke(ctx, [[-11, 27], [11, 27]], C.ink, 1.8); stroke(ctx, [[-11, 31], [11, 31]], C.ink, 1.8);
  },

  // ======================= dinero y negocio =======================
  card(ctx, t) {
    ctx.save(); ctx.rotate(-0.12 + 0.03 * wave(t, 0.4));
    box(ctx, -42, -26, 84, 52, 7, { fill: C.blue });
    ctx.fillStyle = C.ink; ctx.fillRect(-42, -15, 84, 10);
    box(ctx, -32, 2, 16, 12, 3, { fill: C.yellow, lw: 1.8, shadow: null });
    stroke(ctx, [[-8, 14], [28, 14]], 'rgba(255,255,255,.6)', 3);
    ctx.restore();
  },
  wallet(ctx, t) {
    const out = 6 + 6 * Math.max(0, wave(t, 0.5));
    box(ctx, -18, -26 - out, 44, 26, 3, { fill: '#7fd38a', shadow: null }); label(ctx, '$', 4, -13 - out, 16);
    box(ctx, -40, -20, 80, 50, 8, { fill: '#8a5a2b' });
    box(ctx, 14, -4, 30, 18, 6, { fill: '#6f4521' }); dot(ctx, 24, 5, 3.5, C.yellow);
  },
  piggy(ctx, t) {
    // moneda que cae en la ranura
    const k = saw(t, 1.8);
    if (k < 0.55) { const y = -46 + k / 0.55 * 30; disc(ctx, 0, y, 7, { fill: C.yellow, lw: 2, shadow: null }); }
    shape(ctx, () => { ctx.beginPath(); ctx.ellipse(0, 6, 36, 26, 0, 0, TAU); }, { fill: '#F29CB4' });
    box(ctx, 30, -2, 12, 14, 5, { fill: '#F29CB4', shadow: null }); dot(ctx, 35, 3, 1.6, C.ink); dot(ctx, 38, 7, 1.6, C.ink);
    poly(ctx, [[-14, -16], [-6, -30], [2, -18]], { fill: '#e07c99', shadow: null });
    dot(ctx, 18, -4, 2.6, C.ink);
    stroke(ctx, [[-6, -18], [8, -18]], C.ink, 3.2);
    [[-22, 28], [16, 28]].forEach(([x, y]) => box(ctx, x - 5, y, 10, 10, 2, { fill: '#e07c99', shadow: null }));
  },
  coins(ctx, t) {
    for (let i = 0; i < 5; i++) {
      const y = 26 - i * 9, x = -14 + (i % 2) * 3;
      shape(ctx, () => { ctx.beginPath(); ctx.ellipse(x, y, 22, 7, 0, 0, TAU); }, { fill: C.yellow, lw: 2.2, shadow: i === 0 ? C.red : null });
    }
    const h = Math.abs(Math.cos(t * 2.2));
    shape(ctx, () => { ctx.beginPath(); ctx.ellipse(24, -18, 17 * Math.max(0.12, h), 17, 0, 0, TAU); }, { fill: C.yellow, lw: 2.2 });
    if (h > 0.5) label(ctx, '$', 24, -17, 16 * h);
  },
  token(ctx, t) {
    // ficha de "token" que gira
    const h = Math.cos(t * 1.8);
    ctx.save(); ctx.scale(Math.max(0.1, Math.abs(h)), 1);
    disc(ctx, 0, 0, 36, { fill: h > 0 ? C.yellow : '#d9a90f' });
    arcLine(ctx, 0, 0, 28, 0, TAU, C.ink, 2);
    label(ctx, 'T', 0, 2, 38);
    ctx.restore();
  },
  receipt(ctx, t) {
    const n = Math.floor(saw(t, 3) * 6);
    const zig = []; for (let i = 0; i <= 8; i++) zig.push([-26 + i * 6.5, 40 + (i % 2 ? 4 : 0)]);
    poly(ctx, [[-26, -40], [26, -40], ...zig.reverse()], { fill: LITE() });
    for (let i = 0; i < Math.min(n, 4); i++) { stroke(ctx, [[-18, -28 + i * 11], [4, -28 + i * 11]], '#888', 2.4); stroke(ctx, [[12, -28 + i * 11], [18, -28 + i * 11]], '#888', 2.4); }
    if (n >= 5) { stroke(ctx, [[-18, 20], [18, 20]], C.ink, 1.6); label(ctx, 'TOTAL', -6, 29, 8); label(ctx, '$', 15, 29, 12, C.red); }
  },
  cart(ctx, t) {
    const roll = t * 2;
    stroke(ctx, [[-44, -26], [-34, -26], [-24, 14], [26, 14]], FG(), 4);
    poly(ctx, [[-31, -16], [36, -16], [28, 6], [-26, 6]], { fill: C.yellow });
    [-16, 20].forEach((x) => { disc(ctx, x, 24, 7, { fill: '#555', shadow: null }); ctx.save(); ctx.translate(x, 24); ctx.rotate(roll); stroke(ctx, [[-5, 0], [5, 0]], LITE(), 2); ctx.restore(); });
  },
  chartup(ctx, t) {
    box(ctx, -42, -36, 84, 72, 6, { fill: '#14161a' });
    const k = Math.min(1, saw(t, 3.5) * 1.6);
    [12, 20, 30, 44].forEach((h, i) => { ctx.fillStyle = i === 3 ? C.green : '#4d7c3a'; ctx.fillRect(-32 + i * 17, 28 - h * k, 12, h * k); });
    stroke(ctx, [[-30, 14], [-12, 4], [4, 8], [28, -24]], C.yellow, 4);
    poly(ctx, [[28, -24], [16, -22], [26, -12]], { fill: C.yellow, stroke: null, shadow: null });
  },
  chartdown(ctx, t) {
    box(ctx, -42, -36, 84, 72, 6, { fill: '#14161a' });
    const k = Math.min(1, saw(t, 3.5) * 1.6);
    [44, 32, 20, 10].forEach((h, i) => { ctx.fillStyle = i === 3 ? C.red : '#7a2a26'; ctx.fillRect(-32 + i * 17, 28 - h * k, 12, h * k); });
    stroke(ctx, [[-30, -24], [-12, -10], [4, -14], [28, 16]], C.red, 4);
    poly(ctx, [[28, 16], [16, 16], [26, 4]], { fill: C.red, stroke: null, shadow: null });
  },
  trophy(ctx, t) {
    arcLine(ctx, -22, -14, 10, Math.PI * 0.5, Math.PI * 1.5, FG(), 4); arcLine(ctx, 22, -14, 10, Math.PI * 1.5, Math.PI * 0.5, FG(), 4);
    shape(ctx, () => { ctx.beginPath(); ctx.moveTo(-24, -30); ctx.lineTo(24, -30); ctx.quadraticCurveTo(24, 10, 0, 12); ctx.quadraticCurveTo(-24, 10, -24, -30); ctx.closePath(); }, { fill: C.yellow });
    box(ctx, -5, 12, 10, 12, 1, { fill: '#d9a90f', shadow: null }); box(ctx, -18, 24, 36, 12, 3, { fill: '#8a5a2b' });
    label(ctx, '1', 0, -10, 22);
    const sh = saw(t, 2.4); if (sh < 0.3) { ctx.save(); ctx.globalAlpha = 1 - sh / 0.3; stroke(ctx, [[-16 + sh * 80, -28], [-24 + sh * 80, 0]], 'rgba(255,255,255,.8)', 3); ctx.restore(); }
  },
  crown(ctx, t) {
    ctx.save(); ctx.translate(0, 2 * wave(t, 0.5));
    poly(ctx, [[-38, 22], [-38, -16], [-19, 2], [0, -26], [19, 2], [38, -16], [38, 22]], { fill: C.yellow });
    [[-38, -16], [0, -26], [38, -16]].forEach(([x, y]) => disc(ctx, x, y - 4, 4.5, { fill: C.red, lw: 2, shadow: null }));
    [C.blue, C.red, C.green].forEach((c, i) => disc(ctx, -18 + i * 18, 12, 4.5, { fill: c, lw: 2, shadow: null }));
    ctx.restore();
  },
  scale(ctx, t) {
    const tilt = 0.18 * wave(t, 0.35);
    poly(ctx, [[-16, 38], [16, 38], [4, 30], [-4, 30]], { fill: '#8a5a2b' });
    stroke(ctx, [[0, 30], [0, -26]], FG(), 4);
    ctx.save(); ctx.translate(0, -26); ctx.rotate(tilt);
    stroke(ctx, [[-36, 0], [36, 0]], FG(), 4);
    ctx.restore();
    [-1, 1].forEach((s) => {
      const x = s * 36 * Math.cos(tilt), y = -26 + s * 36 * Math.sin(tilt);
      stroke(ctx, [[x, y], [x - 10, y + 22]], FG(), 1.6); stroke(ctx, [[x, y], [x + 10, y + 22]], FG(), 1.6);
      shape(ctx, () => { ctx.beginPath(); ctx.ellipse(x, y + 22, 14, 5, 0, 0, Math.PI); ctx.closePath(); }, { fill: s < 0 ? C.yellow : C.blue, lw: 2, shadow: null });
    });
    disc(ctx, 0, -26, 4, { fill: C.yellow, lw: 2, shadow: null });
  },

  // ======================= tiempo y rendimiento =======================
  hourglass(ctx, t) {
    const k = saw(t, 4);
    box(ctx, -26, -40, 52, 7, 2, { fill: '#8a5a2b' }); box(ctx, -26, 33, 52, 7, 2, { fill: '#8a5a2b', shadow: null });
    shape(ctx, pathOf(ctx, [[-20, -33], [20, -33], [3, 0], [20, 33], [-20, 33], [-3, 0]]), { fill: 'rgba(200,230,255,.25)', shadow: null });
    ctx.fillStyle = C.yellow;
    const top = 30 * (1 - k); poly(ctx, [[-20 * (top / 33) * 0.9, -top], [20 * (top / 33) * 0.9, -top], [2, -1], [-2, -1]], { fill: C.yellow, stroke: null, shadow: null });
    const b = 26 * k; poly(ctx, [[-18, 33], [18, 33], [18 - b * 0.4, 33 - b], [-18 + b * 0.4, 33 - b]], { fill: C.yellow, stroke: null, shadow: null });
    if (k < 0.97) stroke(ctx, [[0, 0], [0, 32 - b]], C.yellow, 1.6);
  },
  stopwatch(ctx, t) {
    box(ctx, -6, -44, 12, 8, 2, { fill: '#9fa2a8' }); stroke(ctx, [[22, -30], [28, -36]], C.ink, 4);
    disc(ctx, 0, 2, 36, { fill: LITE() });
    for (let i = 0; i < 12; i++) { const a = (i / 12) * TAU; stroke(ctx, [[Math.cos(a) * 28, 2 + Math.sin(a) * 28], [Math.cos(a) * 32, 2 + Math.sin(a) * 32]], C.ink, i % 3 ? 1.6 : 3); }
    const a = t * TAU / 2 - Math.PI / 2;
    stroke(ctx, [[0, 2], [Math.cos(a) * 26, 2 + Math.sin(a) * 26]], C.red, 3.2); dot(ctx, 0, 2, 3.5, C.red);
  },
  calendar(ctx, t) {
    box(ctx, -34, -30, 68, 66, 6, { fill: LITE() });
    ctx.fillStyle = C.red; rrect(ctx, -34, -30, 68, 18, [6, 6, 0, 0]); ctx.fill();
    [-18, 18].forEach((x) => stroke(ctx, [[x, -38], [x, -24]], C.ink, 4));
    const day = 1 + (Math.floor(t / 1.2) % 31);
    label(ctx, String(day), 0, 12, 30);
    // hoja que pasa
    const k = saw(t, 1.2);
    if (k < 0.25) { ctx.save(); ctx.globalAlpha = 1 - k * 4; ctx.translate(0, -12 + k * 60); ctx.rotate(k * 2); box(ctx, -30, 0, 60, 30, 3, { fill: LITE(), shadow: null }); ctx.restore(); }
  },
  snail(ctx, t) {
    const x = -6 + 6 * wave(t, 0.15);
    ctx.save(); ctx.translate(x, 0);
    shape(ctx, () => { ctx.beginPath(); ctx.moveTo(-40, 26); ctx.lineTo(36, 26); ctx.quadraticCurveTo(44, 26, 42, 8); ctx.lineTo(34, 10); ctx.lineTo(30, 20); ctx.lineTo(-40, 20); ctx.closePath(); }, { fill: '#b9c46a' });
    stroke(ctx, [[36, 10], [34, -6]], FG(), 2.2); stroke(ctx, [[40, 10], [44, -4]], FG(), 2.2);
    dot(ctx, 34, -7, 2.6, FG()); dot(ctx, 44, -5, 2.6, FG());
    disc(ctx, -6, -2, 24, { fill: '#c97b3a' });
    ctx.beginPath(); for (let a = 0; a < 5.2 * Math.PI; a += 0.2) { const r = 2 + a * 1.25; ctx.lineTo(-6 + Math.cos(a) * r, -2 + Math.sin(a) * r); }
    ctx.lineWidth = 2.4; ctx.strokeStyle = C.ink; ctx.stroke();
    ctx.restore();
  },
  rocket(ctx, t) {
    ctx.save(); ctx.translate(0, 3 * wave(t, 1.3)); ctx.rotate(0.6);
    const f = 0.7 + 0.3 * wave(t, 6);
    poly(ctx, [[-8, 28], [8, 28], [0, 28 + 22 * f]], { fill: C.orange, stroke: null, shadow: null });
    poly(ctx, [[-5, 28], [5, 28], [0, 28 + 13 * f]], { fill: C.yellow, stroke: null, shadow: null });
    poly(ctx, [[-12, 6], [-24, 26], [-10, 22]], { fill: C.red }); poly(ctx, [[12, 6], [24, 26], [10, 22]], { fill: C.red });
    shape(ctx, () => { ctx.beginPath(); ctx.moveTo(0, -42); ctx.quadraticCurveTo(18, -22, 13, 28); ctx.lineTo(-13, 28); ctx.quadraticCurveTo(-18, -22, 0, -42); ctx.closePath(); }, { fill: LITE() });
    disc(ctx, 0, -10, 7, { fill: C.blue, lw: 2.4, shadow: null });
    ctx.restore();
  },
  fire(ctx, t) {
    const flame = (s, c, ph) => () => {
      const w = 1 + 0.08 * wave(t, 2.3, ph), h = 1 + 0.1 * wave(t, 3.1, ph + 1);
      ctx.beginPath(); ctx.moveTo(0, 34);
      ctx.bezierCurveTo(-30 * s * w, 30, -28 * s * w, 0, -12 * s, -14 * s * h);
      ctx.quadraticCurveTo(-8 * s, -2, -4 * s, -6);
      ctx.bezierCurveTo(-6 * s, -24 * s * h, 4 * s, -36 * s * h, 6 * s * w, -44 * s * h);
      ctx.bezierCurveTo(14 * s, -24 * s, 30 * s * w, -4, 26 * s * w, 12);
      ctx.bezierCurveTo(24 * s, 28, 12 * s, 34, 0, 34); ctx.closePath(); ctx.fillStyle = c;
    };
    shape(ctx, flame(1, C.red, 0), { fill: C.red });
    shape(ctx, flame(0.66, C.orange, 1), { fill: C.orange, shadow: null, stroke: null });
    shape(ctx, flame(0.36, C.yellow, 2), { fill: C.yellow, shadow: null, stroke: null });
  },
  speed(ctx, t) {
    // velocímetro pequeño con la aguja al rojo
    shape(ctx, () => { ctx.beginPath(); ctx.arc(0, 14, 40, Math.PI, TAU); ctx.closePath(); }, { fill: '#14161a' });
    [[0, 0.55, C.green], [0.55, 0.8, C.yellow], [0.8, 1, C.red]].forEach(([a, b, c]) => arcLine(ctx, 0, 14, 31, Math.PI + a * Math.PI, Math.PI + b * Math.PI, c, 7));
    const a = Math.PI + (0.85 + 0.1 * wave(t, 2.2)) * Math.PI;
    stroke(ctx, [[0, 14], [Math.cos(a) * 28, 14 + Math.sin(a) * 28]], LITE(), 3.6); dot(ctx, 0, 14, 5, LITE());
  },
  thumbup(ctx, t) {
    ctx.save(); ctx.rotate(-0.08 * Math.max(0, wave(t, 0.7)));
    box(ctx, -38, -6, 16, 40, 3, { fill: C.blue });
    shape(ctx, () => { ctx.beginPath(); ctx.moveTo(-20, -4); ctx.lineTo(-6, -24); ctx.quadraticCurveTo(-4, -40, 6, -36); ctx.quadraticCurveTo(10, -30, 4, -14); ctx.lineTo(30, -14); ctx.quadraticCurveTo(40, -12, 34, 0); ctx.quadraticCurveTo(40, 10, 32, 14); ctx.quadraticCurveTo(36, 24, 26, 26); ctx.quadraticCurveTo(28, 36, 16, 34); ctx.lineTo(-20, 34); ctx.closePath(); }, { fill: C.yellow });
    ctx.restore();
  },
  thumbdown(ctx, t) {
    ctx.save(); ctx.rotate(Math.PI); OBJECTS.thumbup(ctx, t + 0.5); ctx.restore();
  },
  target(ctx, t) {
    [36, 26, 16, 6].forEach((r, i) => disc(ctx, 0, 0, r, { fill: i % 2 ? LITE() : C.red, lw: 2, shadow: i ? null : C.ink }));
    const k = Math.min(1, saw(t, 2.5) * 3);
    const x = 50 * (1 - k), y = -50 * (1 - k);
    ctx.save(); ctx.translate(x, y); ctx.rotate(-Math.PI / 4);
    stroke(ctx, [[0, 0], [44, 0]], '#8a5a2b', 3.6);
    poly(ctx, [[-2, 0], [6, -5], [6, 5]], { fill: C.ink, stroke: null, shadow: null });
    poly(ctx, [[38, 0], [48, -7], [44, 0], [48, 7]], { fill: C.yellow, lw: 1.4, shadow: null });
    ctx.restore();
  },
  warning(ctx, t) {
    const s = 1 + 0.06 * Math.max(0, wave(t, 1.2));
    ctx.save(); ctx.scale(s, s);
    poly(ctx, [[0, -38], [42, 34], [-42, 34]], { fill: C.yellow, lw: 3.4 });
    stroke(ctx, [[0, -14], [0, 12]], C.ink, 7); dot(ctx, 0, 24, 4.5, C.ink);
    ctx.restore();
  },
  lock(ctx, t) {
    const open = Math.max(0, wave(t, 0.4)) > 0.85 ? 8 : 0;
    arcLine(ctx, 0, -8 - open, 18, Math.PI, TAU, '#9fa2a8', 8);
    stroke(ctx, [[-18, -8 - open], [-18, 0]], '#9fa2a8', 8, 'butt'); stroke(ctx, [[18, -8 - open], [18, 0]], '#9fa2a8', 8, 'butt');
    box(ctx, -30, -4, 60, 46, 7, { fill: C.yellow });
    disc(ctx, 0, 14, 6, { fill: C.ink, stroke: null, shadow: null }); box(ctx, -2.5, 16, 5, 12, 1, { fill: C.ink, stroke: null, shadow: null });
  },
  key(ctx, t) {
    ctx.save(); ctx.rotate(-0.5 + 0.15 * wave(t, 0.5));
    disc(ctx, -24, 0, 16, { fill: C.yellow });
    dot(ctx, -24, 0, 6, '#14161a');
    box(ctx, -8, -5, 50, 10, 2, { fill: C.yellow });
    box(ctx, 26, 5, 6, 10, 1, { fill: C.yellow, shadow: null }); box(ctx, 36, 5, 6, 14, 1, { fill: C.yellow, shadow: null });
    ctx.restore();
  },
  shield(ctx, t) {
    shape(ctx, () => { ctx.beginPath(); ctx.moveTo(0, -40); ctx.lineTo(32, -28); ctx.quadraticCurveTo(32, 20, 0, 40); ctx.quadraticCurveTo(-32, 20, -32, -28); ctx.closePath(); }, { fill: C.blue });
    const k = Math.min(1, saw(t, 2.5) * 2.5);
    const pts = [[-14, 0], [-4, 12], [16, -12]];
    const len = k * 2; const out = [pts[0]];
    for (let i = 0; i < 2; i++) { const f = Math.max(0, Math.min(1, len - i)); if (f <= 0) break; out.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f]); }
    stroke(ctx, out, LITE(), 7);
  },
  bug(ctx, t) {
    const leg = 4 * wave(t, 2);
    for (const s of [-1, 1]) for (let i = 0; i < 3; i++) stroke(ctx, [[s * 14, -6 + i * 12], [s * 30, -12 + i * 14 + (i % 2 ? leg : -leg)]], FG(), 3);
    stroke(ctx, [[-6, -28], [-14, -40]], FG(), 2.4); stroke(ctx, [[6, -28], [14, -40]], FG(), 2.4);
    disc(ctx, 0, -24, 10, { fill: '#14161a', stroke: FG() });
    shape(ctx, () => { ctx.beginPath(); ctx.ellipse(0, 8, 20, 26, 0, 0, TAU); }, { fill: C.red });
    stroke(ctx, [[0, -16], [0, 34]], C.ink, 2.4);
    [[-9, 0], [9, 4], [-8, 18], [10, 20]].forEach(([x, y]) => dot(ctx, x, y, 3.5, C.ink));
  },
  magnet(ctx, t) {
    // herradura abierta hacia arriba, polos claros y líneas de campo que salen de ellos
    for (let i = 0; i < 3; i++) { const k = saw(t + i * 0.33, 1.2); ctx.globalAlpha = 1 - k; arcLine(ctx, 0, -22, 22 + k * 16, Math.PI * 1.08, Math.PI * 1.92, C.yellow, 2.6); }
    ctx.globalAlpha = 1;
    shape(ctx, () => { ctx.beginPath(); ctx.moveTo(-32, -26); ctx.lineTo(-32, 6); ctx.arc(0, 6, 32, Math.PI, 0, true); ctx.lineTo(32, -26); ctx.lineTo(16, -26); ctx.lineTo(16, 6); ctx.arc(0, 6, 16, 0, Math.PI); ctx.lineTo(-16, -26); ctx.closePath(); }, { fill: C.red });
    box(ctx, -32, -36, 16, 12, 1, { fill: LITE(), shadow: null }); box(ctx, 16, -36, 16, 12, 1, { fill: LITE(), shadow: null });
  },
  puzzle(ctx, t) {
    const piece = (x, y, c, dx = 0, dy = 0) => {
      ctx.save(); ctx.translate(x + dx, y + dy);
      shape(ctx, () => { ctx.beginPath(); ctx.moveTo(-18, -18); ctx.lineTo(-4, -18); ctx.arc(0, -18, 5, Math.PI, 0); ctx.lineTo(18, -18); ctx.lineTo(18, -4); ctx.arc(18, 0, 5, -Math.PI / 2, Math.PI / 2); ctx.lineTo(18, 18); ctx.lineTo(-18, 18); ctx.closePath(); }, { fill: c });
      ctx.restore();
    };
    const k = Math.max(0, wave(t, 0.4));
    piece(-12, 0, C.blue); piece(26, 0, C.yellow, 8 * k, -8 * k);
  },
  flask(ctx, t) {
    shape(ctx, () => { ctx.beginPath(); ctx.moveTo(-8, -40); ctx.lineTo(8, -40); ctx.lineTo(8, -14); ctx.lineTo(32, 32); ctx.quadraticCurveTo(34, 38, 26, 38); ctx.lineTo(-26, 38); ctx.quadraticCurveTo(-34, 38, -32, 32); ctx.lineTo(-8, -14); ctx.closePath(); }, { fill: 'rgba(200,230,255,.18)' });
    poly(ctx, [[-20, 10], [20, 10], [31, 32], [-31, 32]], { fill: C.green, stroke: null, shadow: null });
    for (let i = 0; i < 4; i++) { const k = saw(t + i * 0.45, 1.8); dot(ctx, -10 + i * 7, 28 - k * 60, 2 + (i % 2) * 1.5, k < 0.5 ? C.green : 'rgba(108,194,74,.6)'); }
    stroke(ctx, [[-12, -40], [12, -40]], C.ink, 3.4);
  },
  book(ctx, t) {
    const flip = saw(t, 2.6);
    shape(ctx, () => { ctx.beginPath(); ctx.moveTo(0, -24); ctx.quadraticCurveTo(-22, -32, -42, -26); ctx.lineTo(-42, 26); ctx.quadraticCurveTo(-22, 20, 0, 28); ctx.quadraticCurveTo(22, 20, 42, 26); ctx.lineTo(42, -26); ctx.quadraticCurveTo(22, -32, 0, -24); ctx.closePath(); }, { fill: LITE() });
    stroke(ctx, [[0, -24], [0, 28]], C.ink, 2);
    for (let i = 0; i < 4; i++) { stroke(ctx, [[-34, -14 + i * 9], [-8, -12 + i * 9]], '#999', 2); stroke(ctx, [[8, -12 + i * 9], [34, -14 + i * 9]], '#999', 2); }
    if (flip < 0.4) { const k = flip / 0.4; const x = 42 * Math.cos(k * Math.PI); poly(ctx, [[0, -24], [x, -26 - 6 * Math.sin(k * Math.PI)], [x, 26 - 6 * Math.sin(k * Math.PI)], [0, 28]], { fill: '#e6e2d8', lw: 1.8, shadow: null }); }
  },
  globe(ctx, t) {
    disc(ctx, 0, 0, 38, { fill: C.blue });
    ctx.save(); ctx.beginPath(); ctx.arc(0, 0, 38, 0, TAU); ctx.clip();
    for (let i = 0; i < 4; i++) {
      const ph = (t * 0.25 + i / 4) % 1, w = Math.cos(ph * Math.PI) * 38;
      ctx.beginPath(); ctx.ellipse(0, 0, Math.abs(w), 38, 0, 0, TAU); ctx.lineWidth = 1.8; ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.stroke();
    }
    [-19, 0, 19].forEach((y) => stroke(ctx, [[-40, y], [40, y]], 'rgba(255,255,255,.5)', 1.8));
    const off = ((t * 12) % 80) - 40;
    [[-10, -14, 12, 9], [12, 8, 9, 12], [-18, 14, 7, 6]].forEach(([x, y, rx, ry]) => { ctx.beginPath(); ctx.ellipse(((x + off + 120) % 80) - 40, y, rx, ry, 0.4, 0, TAU); ctx.fillStyle = C.green; ctx.fill(); });
    ctx.restore();
    arcLine(ctx, 0, 0, 38, 0, TAU, C.ink, LW);
  },
  house(ctx, t) {
    poly(ctx, [[-36, -4], [0, -38], [36, -4]], { fill: C.red });
    box(ctx, -28, -6, 56, 44, 2, { fill: LITE() });
    box(ctx, -8, 12, 16, 26, 2, { fill: '#8a5a2b', shadow: null });
    const on = wave(t, 0.3) > -0.4;
    box(ctx, 12, 2, 12, 12, 1, { fill: on ? C.yellow : '#333', shadow: null });
    stroke(ctx, [[18, 2], [18, 14]], C.ink, 1.4); stroke(ctx, [[12, 8], [24, 8]], C.ink, 1.4);
    box(ctx, 16, -32, 9, 16, 1, { fill: '#8a5a2b', shadow: null });
    for (let i = 0; i < 2; i++) { const k = saw(t + i * 0.8, 1.6); ctx.globalAlpha = 0.5 * (1 - k); dot(ctx, 20 + k * 8, -36 - k * 18, 4 + k * 4, '#bbb'); }
    ctx.globalAlpha = 1;
  },

  // ======================= comunicación y medios =======================
  chat(ctx, t) {
    box(ctx, -40, -34, 52, 30, 10, { fill: LITE() });
    poly(ctx, [[-30, -6], [-34, 6], [-20, -6]], { fill: LITE(), stroke: null, shadow: null });
    box(ctx, -8, 0, 50, 30, 10, { fill: C.blue });
    poly(ctx, [[30, 28], [36, 40], [22, 28]], { fill: C.blue, stroke: null, shadow: null });
    stroke(ctx, [[-32, -24], [2, -24]], '#999', 2.6); stroke(ctx, [[-32, -15], [-10, -15]], '#999', 2.6);
    for (let i = 0; i < 3; i++) dot(ctx, 5 + i * 12, 15, 3.6, `rgba(255,255,255,${0.35 + 0.65 * Math.max(0, wave(t, 1.4, -i * 0.9))})`);
  },
  mic(ctx, t) {
    for (let i = 0; i < 2; i++) { const k = saw(t + i * 0.5, 1); ctx.globalAlpha = 1 - k; arcLine(ctx, 0, -12, 26 + k * 16, -0.6, 0.6, C.yellow, 3); arcLine(ctx, 0, -12, 26 + k * 16, Math.PI - 0.6, Math.PI + 0.6, C.yellow, 3); }
    ctx.globalAlpha = 1;
    box(ctx, -13, -40, 26, 46, 13, { fill: '#9fa2a8' });
    for (let i = 0; i < 4; i++) stroke(ctx, [[-8, -30 + i * 7], [8, -30 + i * 7]], '#555', 1.6);
    arcLine(ctx, 0, -2, 21, 0.1, Math.PI - 0.1, FG(), 4);
    stroke(ctx, [[0, 19], [0, 32]], FG(), 4); stroke(ctx, [[-14, 34], [14, 34]], FG(), 5);
  },
  headphones(ctx, t) {
    arcLine(ctx, 0, 6, 32, Math.PI, TAU, '#3a3a3a', 11); arcLine(ctx, 0, 6, 32, Math.PI, TAU, FG(), 3);
    const b = 1.5 * wave(t, 2);
    box(ctx, -42 - b, -2, 18, 34, 7, { fill: C.red }); box(ctx, 24 + b, -2, 18, 34, 7, { fill: C.red });
    for (let i = 0; i < 4; i++) { const h = 4 + 8 * Math.abs(wave(t, 1.5, i)); stroke(ctx, [[-9 + i * 6, 14 - h], [-9 + i * 6, 14 + h]], C.yellow, 3.2); }
  },
  camera(ctx, t) {
    box(ctx, -40, -22, 58, 44, 6, { fill: '#2a2a2a' });
    poly(ctx, [[18, -6], [40, -18], [40, 18], [18, 6]], { fill: '#2a2a2a' });
    disc(ctx, -11, 0, 13, { fill: '#14161a', stroke: '#777', shadow: null }); dot(ctx, -11, 0, 6, C.blue);
    if (Math.floor(t * 1.5) % 2 === 0) { dot(ctx, -30, -12, 4, C.red); label(ctx, 'REC', -16, -12, 7, C.red); }
  },
  image(ctx, t) {
    box(ctx, -40, -30, 80, 60, 4, { fill: '#7fc6f2' });
    ctx.save(); rrect(ctx, -40, -30, 80, 60, 4); ctx.clip();
    dot(ctx, 20, -12 + 3 * wave(t, 0.3), 8, C.yellow);
    poly(ctx, [[-40, 30], [-14, -2], [6, 30]], { fill: C.green, stroke: null, shadow: null });
    poly(ctx, [[-8, 30], [16, 4], [40, 30]], { fill: '#4d9a3a', stroke: null, shadow: null });
    ctx.restore();
    rrect(ctx, -40, -30, 80, 60, 4); ctx.lineWidth = LW; ctx.strokeStyle = C.ink; ctx.stroke();
  },
  video(ctx, t) {
    box(ctx, -42, -28, 84, 56, 8, { fill: C.red });
    const s = 1 + 0.08 * Math.max(0, wave(t, 1));
    ctx.save(); ctx.scale(s, s); poly(ctx, [[-10, -14], [16, 0], [-10, 14]], { fill: LITE(), stroke: null, shadow: null }); ctx.restore();
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(-34, 20, 68, 3);
    ctx.fillStyle = LITE(); ctx.fillRect(-34, 20, 68 * saw(t, 6), 3);
  },
  mail(ctx, t) {
    ctx.save(); ctx.translate(0, 2 * wave(t, 0.6));
    box(ctx, -40, -26, 80, 52, 4, { fill: LITE() });
    stroke(ctx, [[-40, -26], [0, 4], [40, -26]], C.ink, LW);
    if (saw(t, 2) < 0.6) { disc(ctx, 34, -24, 9, { fill: C.red, lw: 2, shadow: null }); label(ctx, '1', 34, -23, 11, '#fff'); }
    ctx.restore();
  },
  eye(ctx, t) {
    const open = saw(t, 3) > 0.92 ? 0.1 : 1;
    ctx.save(); ctx.scale(1, open);
    shape(ctx, () => { ctx.beginPath(); ctx.moveTo(-42, 0); ctx.quadraticCurveTo(0, -38, 42, 0); ctx.quadraticCurveTo(0, 38, -42, 0); ctx.closePath(); }, { fill: LITE() });
    const look = 8 * wave(t, 0.25);
    disc(ctx, look, 0, 14, { fill: C.blue, lw: 2, shadow: null }); dot(ctx, look, 0, 6, C.ink); dot(ctx, look + 4, -4, 2.4, '#fff');
    ctx.restore();
  },
  search(ctx, t) {
    const x = 10 * wave(t, 0.4), y = 6 * wave(t, 0.4, 1.2);
    ctx.save(); ctx.translate(x, y);
    stroke(ctx, [[14, 14], [34, 34]], '#8a5a2b', 10);
    disc(ctx, -6, -6, 26, { fill: 'rgba(200,230,255,.25)', lw: 5 });
    arcLine(ctx, -6, -6, 17, Math.PI * 1.1, Math.PI * 1.5, 'rgba(255,255,255,.8)', 3);
    ctx.restore();
  },
  megaphone(ctx, t) {
    poly(ctx, [[-30, -10], [24, -34], [24, 30], [-30, 10]], { fill: C.yellow });
    box(ctx, -40, -12, 12, 24, 3, { fill: C.red });
    box(ctx, -26, 10, 10, 18, 3, { fill: C.red, shadow: null });
    for (let i = 0; i < 3; i++) { const k = saw(t + i * 0.33, 1); ctx.globalAlpha = 1 - k; arcLine(ctx, 26, -2, 8 + k * 22, -0.7, 0.7, C.yellow, 3); }
    ctx.globalAlpha = 1;
  },
  dice(ctx, t) {
    ctx.save(); ctx.rotate(0.2 * wave(t, 0.5));
    box(ctx, -30, -30, 60, 60, 10, { fill: LITE() });
    const face = 1 + (Math.floor(t * 1.2) % 6);
    const P = { 1: [[0, 0]], 2: [[-14, -14], [14, 14]], 3: [[-14, -14], [0, 0], [14, 14]], 4: [[-14, -14], [14, -14], [-14, 14], [14, 14]], 5: [[-14, -14], [14, -14], [0, 0], [-14, 14], [14, 14]], 6: [[-14, -14], [14, -14], [-14, 0], [14, 0], [-14, 14], [14, 14]] };
    P[face].forEach(([x, y]) => dot(ctx, x, y, 5.5, face === 1 ? C.red : C.ink));
    ctx.restore();
  },
  download(ctx, t) {
    const y = -8 + 10 * saw(t, 1.1);
    stroke(ctx, [[0, -36 + y], [0, 2 + y]], C.green, 8); stroke(ctx, [[-14, -12 + y], [0, 2 + y], [14, -12 + y]], C.green, 8);
    stroke(ctx, [[-36, 10], [-36, 32], [36, 32], [36, 10]], FG(), 7);
  },
  upload(ctx, t) {
    const y = 8 - 10 * saw(t, 1.1);
    stroke(ctx, [[0, 2 + y], [0, -36 + y]], C.blue, 8); stroke(ctx, [[-14, -22 + y], [0, -36 + y], [14, -22 + y]], C.blue, 8);
    stroke(ctx, [[-36, 10], [-36, 32], [36, 32], [36, 10]], FG(), 7);
  },
};

/** Adaptador al formato de ICON_DRAW de draw.js: (ctx, S, t) con S = tamaño en px. */
export function objectDrawers() {
  const out = {};
  for (const [name, fn] of Object.entries(OBJECTS)) {
    out[name] = (ctx, S, t) => { const k = (S * 0.68) / 100; ctx.save(); ctx.scale(k, k); fn(ctx, t); ctx.restore(); };
  }
  return out;
}
