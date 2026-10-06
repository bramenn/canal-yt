// Tipos de escena. Cada uno: (ctx, s, t, d) → dibuja la escena `s` en el instante local `t` (s) de una duración `d`.
// Lenguaje visual estudiado en los vídeos de referencia: titular pequeño arriba con *palabra clave* en amarillo,
// píldoras monoespaciadas, tags rellenos con cifras, iconos de hardware y mucho espacio negativo.
// Todo es determinista respecto a `t` para poder hacer scrub y exportar.
import {
  W, H, C, FONT, MONO, THEME, colorOf, clamp, lerp, prog, ease, hash,
  txt, font, headline, fitSize, measure, rollText, richWords, wrapWords,
  block, rrect, poly, sticker, arrow, ban, check, icon, pill, tag, chalkify, SHADOW_RED, SHADOW_DOUBLE,
} from './draw.js';

// tiempos de entrada de cada elemento (cuando la voz lo nombra); si no hay cue, se usa el escalonado por defecto
let ITEM_TIMES = null;
const at = (i, def) => (ITEM_TIMES?.[i] != null ? ITEM_TIMES[i] : def);
/** destello breve al entrar un elemento (0 → 1 → 0 en ~0,5 s) */
const flash = (t, t0) => { const x = (t - t0) / 0.5; return x > 0 && x < 1 ? Math.sin(x * Math.PI) : 0; };

const L = (s, i, fallback = '') => s.lines?.[i] ?? (fallback ? { text: fallback, color: 'white' } : null);
const items = (s) => (Array.isArray(s.items) ? s.items : []);
const float = (t, phase = 0, amp = 8) => Math.sin(t * 1.6 + phase) * amp;
const up = (s) => String(s ?? '').toUpperCase();

/** Revela una línea deslizándola desde abajo dentro de una máscara. */
function maskLine(ctx, t, delay, draw, y, size) {
  const p = ease.out5(prog(t, delay, 0.55));
  if (p <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, y - size * 1.05, W, size * 1.35);
  ctx.clip();
  ctx.translate(0, (1 - p) * size * 1.1);
  draw();
  ctx.restore();
}

/** Aparición con escala y opacidad. */
function pop(ctx, t, delay, cx, cy, draw, dur = 0.45) {
  const p = ease.back(prog(t, delay, dur));
  if (p <= 0) return 0;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(p, p);
  ctx.globalAlpha *= clamp(p * 2);
  draw();
  ctx.restore();
  return p;
}

/** Bloque de titulares grandes (1-3 líneas) con tamaño autoajustado. */
function titleBlock(ctx, lines, t, { x, cy, maxW, maxSize = 170, align = 'left', delay = 0.05 }) {
  let size = Math.min(maxSize, (640 / Math.max(1, lines.length)) * 1.1);
  for (const ln of lines) size = Math.min(size, fitSize(ctx, ln.text, maxW, size, 800, FONT, -size * 0.015));
  const lh = size * 0.98;
  const top = cy - (lh * lines.length) / 2;
  let width = 0;
  lines.forEach((ln, i) => {
    const y = top + lh * (i + 1) - size * 0.14;
    maskLine(ctx, t, delay + i * 0.09, () => { width = Math.max(width, headline(ctx, up(ln.text), x, y, size, ln.color, align)); }, y, size);
  });
  return { top, bottom: top + lh * lines.length, size, width };
}

/** Titular pequeño centrado arriba, como en las infografías ("LO QUE ME PARÓ: *LEER*"). */
function topTitle(ctx, s, t, y = 150, size0 = 68) {
  const ln = L(s, 0);
  if (!ln) return false;
  const size = fitSize(ctx, up(ln.text), 1640, size0);
  maskLine(ctx, t, 0.02, () => headline(ctx, up(ln.text), W / 2, y, size, ln.color, 'center'), y, size);
  return true;
}

function caption(ctx, s, t, y, delay = 0.6) {
  if (!s.caption) return;
  ctx.save();
  const p = ease.out(prog(t, delay, 0.4));
  ctx.globalAlpha *= p;
  txt(ctx, up(s.caption), W / 2, y + (1 - p) * 16, { size: 30, family: MONO, weight: 500, color: C.grey, align: 'center', spacing: 3, maxW: 1600 });
  ctx.restore();
}

/** Parsea "1/4", "72%", "0.25" → fracción 0..1 */
function fraction(v) {
  const str = String(v ?? '');
  let m = str.match(/(\d+[.,]?\d*)\s*\/\s*(\d+[.,]?\d*)/);
  if (m) return clamp(parseFloat(m[1].replace(',', '.')) / parseFloat(m[2].replace(',', '.')));
  m = str.match(/(\d+[.,]?\d*)\s*%/);
  if (m) return clamp(parseFloat(m[1].replace(',', '.')) / 100);
  const n = parseFloat(str.replace(',', '.'));
  return Number.isFinite(n) ? clamp(n > 1 ? n / 100 : n) : 0.5;
}

export const SCENES = {
  // ------------------------------------------------------------ afirmación rotunda
  title(ctx, s, t) {
    const lines = s.lines?.length ? s.lines : [{ text: '...', color: 'white' }];
    const hasIcon = !!s.icon;
    const cy = s.sticker ? 470 : 540;
    const tb = titleBlock(ctx, lines, t, hasIcon
      ? { x: 170, cy, maxW: 900, maxSize: 160 }
      : { x: W / 2, cy, maxW: 1600, align: 'center', maxSize: 180 });
    if (hasIcon) {
      const p = ease.back(prog(t, 0.25, 0.6));
      icon(ctx, s.icon, 1430, 520 + float(t), 480, t, { scale: p, rot: (1 - p) * 0.3, label: s.value });
    }
    if (s.sticker) {
      const p = ease.back(prog(t, 0.6, 0.5));
      const sx = hasIcon ? 170 + Math.min(tb.width, 900) * 0.42 : W / 2;
      if (p > 0) sticker(ctx, sx, tb.bottom + 115, s.sticker.label, rollText(s.sticker.value, prog(t, 0.6, 0.9), t), { scale: p, rot: -0.05 + (1 - p) * 0.4, size: 78 });
    }
    caption(ctx, s, t, 990, 0.9);
  },

  // ------------------------------------------------------------ cifra grande
  stat(ctx, s, t) {
    const value = s.value || s.sticker?.value || '0';
    const label = L(s, 0);
    if (label) {
      const sz = fitSize(ctx, up(label.text), 1500, 64);
      maskLine(ctx, t, 0, () => headline(ctx, up(label.text), W / 2, 330, sz, label.color, 'center'), 330, sz);
    }
    const p = ease.back(prog(t, 0.15, 0.6));
    const size = fitSize(ctx, value, 1500, 280);
    ctx.save();
    ctx.translate(W / 2, 590);
    ctx.scale(0.7 + 0.3 * p, 0.7 + 0.3 * p);
    ctx.globalAlpha *= clamp(p * 2);
    headline(ctx, rollText(value, prog(t, 0.2, 1.1), t), 0, size * 0.36, size, s.lines?.[1]?.color || 'yellow', 'center');
    ctx.restore();
    const bw = measure(ctx, value, size) * ease.out(prog(t, 0.7, 0.5));
    ctx.fillStyle = C.red;
    ctx.fillRect(W / 2 - bw / 2, 590 + size * 0.5, bw, 12);
    caption(ctx, s, t, 860, 0.9);
  },

  // ------------------------------------------------------------ precio con pegatina
  price(ctx, s, t) {
    topTitle(ctx, s, t);
    const pi = ease.back(prog(t, 0, 0.6));
    icon(ctx, s.icon || 'gpu', 720, 560 + float(t), 540, t, { scale: pi, label: s.value });
    const st = s.sticker || { label: 'HOY', value: s.value || '?' };
    const drop = ease.elastic(prog(t, 0.45, 0.9));
    if (t > 0.45) sticker(ctx, 1330, lerp(-200, 540, drop), st.label, rollText(st.value, prog(t, 0.6, 1.1), t), { rot: -0.08 + Math.sin(t * 1.3) * 0.015, size: 110 });
    caption(ctx, s, t, 950, 1.1);
  },

  // ------------------------------------------------------------ barras
  compare(ctx, s, t) {
    topTitle(ctx, s, t);
    const its = items(s).slice(0, 6);
    if (!its.length) return;
    const max = Math.max(...its.map((i) => Number(i.value) || 0), 1);
    const rowH = Math.min(130, 640 / its.length);
    const top = 560 - (rowH * its.length) / 2 + 20;
    const x0 = 600, maxW = 1000;
    its.forEach((it, i) => {
      const y = top + i * rowH;
      const bh = rowH * 0.5;
      const t0 = at(i, 0.25 + i * 0.14);
      const p = ease.out5(prog(t, t0, 0.9));
      ctx.save();
      ctx.globalAlpha *= clamp(prog(t, t0 - 0.05, 0.25));
      const fl = flash(t, t0);
      if (fl) { ctx.translate(x0, y + bh / 2); ctx.scale(1 + fl * 0.04, 1 + fl * 0.04); ctx.translate(-x0, -(y + bh / 2)); }
      const col = it.highlight ? C.yellow : i % 2 ? C.blue : C.red;
      pill(ctx, it.label, x0 - 36, y + bh / 2, { color: it.highlight ? C.yellow : C.grey, align: 'right', size: Math.min(26, bh * 0.42) });
      ctx.fillStyle = C.bg2;
      ctx.fillRect(x0, y, maxW, bh);
      const w = Math.max(6, (maxW * (Number(it.value) || 0)) / max * p);
      block(ctx, x0, y, w, bh, { fill: col, r: 2, shadows: it.highlight ? [[6, 6, C.red]] : [] });
      const disp = it.display ?? String(it.value ?? '');
      if (p > 0.2) tag(ctx, rollText(disp, p, t), x0 + w + 24, y + bh / 2, { size: Math.min(44, bh * 0.62), align: 'left', fill: it.highlight ? C.yellow : C.white, shadow: it.highlight ? C.red : null });
      ctx.restore();
    });
    caption(ctx, s, t, 990, 1.2);
  },

  // ------------------------------------------------------------ A → B
  versus(ctx, s, t) {
    topTitle(ctx, s, t);
    const [a, b] = [items(s)[0] || { label: 'A' }, items(s)[1] || { label: 'B' }];
    const side = (it, cx, delay, phase) => {
      const p = ease.back(prog(t, delay, 0.6));
      if (p <= 0) return;
      icon(ctx, it.icon || 'model', cx, 500 + float(t, phase), 400, t, { scale: p, label: it.display });
      ctx.save(); ctx.globalAlpha *= clamp(p);
      pill(ctx, it.label, cx, 760, { color: it.highlight ? C.yellow : C.grey, size: 30 });
      if (it.display) tag(ctx, it.display, cx, 850, { size: 52, fill: it.highlight ? C.yellow : C.red, shadow: it.highlight ? C.red : null });
      ctx.restore();
    };
    side(a, 520, at(0, 0.1), 0);
    side(b, 1400, at(1, 0.5), 1.5);
    const pa = ease.out(prog(t, Math.max(0.35, at(1, 0.5) - 0.15), 0.5));
    const bob = Math.sin(t * 4) * 8;
    arrow(ctx, 860 + bob, 500, 860 + bob + 190 * pa, { thick: 24, head: 60 });
    caption(ctx, s, t, 990, 1);
  },

  // ------------------------------------------------------------ lista numerada / punto de control / quiz
  list(ctx, s, t) {
    const title = L(s, 0);
    if (title) {
      const sz = fitSize(ctx, up(title.text), 1600, 72);
      maskLine(ctx, t, 0, () => headline(ctx, up(title.text), 200, 210, sz, title.color), 210, sz);
    }
    const its = items(s).slice(0, 5);
    const step = Math.min(140, 660 / Math.max(1, its.length));
    const colors = [C.blue, C.yellow, C.green, C.red, C.blue];
    its.forEach((it, i) => {
      const y = 300 + i * step;
      const t0 = at(i, 0.3 + i * 0.22);
      const p = ease.out5(prog(t, t0, 0.6));
      if (p <= 0) return;
      ctx.save();
      ctx.translate((1 - p) * -260 + flash(t, t0) * 14, 0);
      ctx.globalAlpha *= clamp(p * 1.5);
      const bs = Math.min(70, step * 0.55);
      const col = it.highlight ? C.red : colors[i % colors.length];
      block(ctx, 200, y, bs, bs, { fill: col, r: 3, shadows: [] });
      txt(ctx, String(i + 1), 200 + bs / 2, y + bs / 2 + 2, { size: bs * 0.62, color: col === C.yellow || col === C.green ? C.ink : C.white, align: 'center', base: 'middle' });
      const ls = bs * 0.72;
      txt(ctx, up(it.label), 200 + bs + 34, y + (it.note ? ls * 0.8 : bs / 2 + 2), { size: ls, base: it.note ? 'alphabetic' : 'middle', maxW: 1380, color: it.highlight ? C.yellow : C.white });
      if (it.note) txt(ctx, up(it.note), 200 + bs + 36, y + ls * 0.8 + 38, { size: 24, color: C.grey, weight: 500, family: MONO, spacing: 2, maxW: 1380 });
      ctx.restore();
    });
    caption(ctx, s, t, 1000, 0.4 + its.length * 0.22);
  },

  // ------------------------------------------------------------ objetos protagonistas
  showcase(ctx, s, t) {
    topTitle(ctx, s, t);
    const its = items(s).slice(0, 3);
    const n = Math.max(1, its.length);
    const S = n === 1 ? 520 : n === 2 ? 420 : 340;
    its.forEach((it, i) => {
      const cx = (W * (i + 1)) / (n + 1);
      const p = ease.back(prog(t, at(i, 0.15 + i * 0.22), 0.6));
      if (p <= 0) return;
      const hl = it.highlight;
      icon(ctx, it.icon || 'model', cx, 500 + float(t, i * 1.3), S, t + i, { scale: p * (hl ? 1.06 : 1), label: it.display });
      ctx.save(); ctx.globalAlpha *= clamp(p);
      pill(ctx, it.label, cx, 770, { color: hl ? C.yellow : C.grey, size: 28 });
      if (it.display) tag(ctx, it.display, cx, 855, { size: 46, fill: hl ? C.yellow : C.white, shadow: hl ? C.red : null });
      ctx.restore();
    });
    if (s.sticker) {
      const p = ease.back(prog(t, 1, 0.5));
      if (p > 0) sticker(ctx, W - 330, 270, s.sticker.label, s.sticker.value, { scale: p, size: 68, rot: 0.05 });
    }
    caption(ctx, s, t, 990, 1.1);
  },

  // ------------------------------------------------------------ generaciones en escalera
  stairs(ctx, s, t) {
    topTitle(ctx, s, t);
    const its = items(s).slice(0, 6);
    const n = Math.max(1, its.length);
    const stepW = 1500 / n;
    const rise = Math.min(90, 400 / n);
    const chip = Math.min(220, stepW * 0.78);
    its.forEach((it, i) => {
      const cx = 210 + stepW * i + stepW / 2;
      const py = 900 - i * rise;
      const p = ease.back(prog(t, at(i, 0.2 + i * 0.25), 0.55));
      if (p <= 0) return;
      block(ctx, cx - stepW / 2 + 8, py, stepW - 16, 22, { fill: C.blue, r: 2, shadows: [[6, 6, C.red]] });
      const hl = it.highlight;
      const shake = hl ? Math.sin(t * 30) * 4 * clamp(t - 0.5 - at(i, 0.2 + i * 0.25)) : 0;
      ctx.save();
      ctx.translate(cx + shake, py - chip * 0.5 - 16 - (1 - p) * 200);
      ctx.rotate(hl ? 0.2 : 0);
      ctx.globalAlpha *= clamp(p * 2);
      icon(ctx, it.icon || 'chip', 0, 0, chip / 0.62, t, { label: it.label, sub: it.display });
      ctx.restore();
      if (hl && p >= 1) {
        ctx.strokeStyle = C.red; ctx.lineWidth = 7; ctx.lineCap = 'round';
        for (let k = 0; k < 3; k++) {
          const a = -1.1 + k * 0.35;
          const r1 = chip * 0.62, r2 = r1 + 46;
          const ox = cx + 20, oy = py - chip * 0.6;
          ctx.beginPath(); ctx.moveTo(ox + Math.cos(a) * r1, oy + Math.sin(a) * r1); ctx.lineTo(ox + Math.cos(a) * r2, oy + Math.sin(a) * r2); ctx.stroke();
        }
      }
    });
    caption(ctx, s, t, 1010, 1.4);
  },

  // ------------------------------------------------------------ lo que dijo la comunidad / el paper
  quote(ctx, s, t) {
    const q = s.quote || { text: s.caption || '', source: '' };
    const p = ease.out5(prog(t, 0, 0.6));
    const cw = 1320, size = 58;
    const words = richWords(up(q.text));
    const lines = wrapWords(ctx, words, cw - 180, size, 800);
    const ch = 210 + lines.length * size * 1.18;
    ctx.save();
    ctx.translate(W / 2, H / 2 + (1 - p) * 120);
    ctx.globalAlpha *= clamp(p * 1.4);
    rrect(ctx, -cw / 2, -ch / 2, cw, ch, 6);
    ctx.fillStyle = C.bg2; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = C.green; ctx.stroke();
    // cabecera
    block(ctx, -cw / 2 + 40, -ch / 2 + 34, 44, 44, { fill: C.red, r: 22, shadows: [] });
    txt(ctx, '“', -cw / 2 + 62, -ch / 2 + 74, { size: 52, color: C.white, align: 'center' });
    txt(ctx, up(q.source || 'Fuente'), -cw / 2 + 104, -ch / 2 + 57, { size: 26, family: MONO, weight: 600, color: C.green, base: 'middle', spacing: 3, maxW: cw - 360 });
    let k = 0;
    lines.forEach((ln, li) => {
      const lw = ln.length ? ln[ln.length - 1].x + ln[ln.length - 1].width : 0;
      const y = -ch / 2 + 170 + li * size * 1.18;
      ln.forEach((wd) => {
        k++;
        const x = -lw / 2 + wd.x;
        const hp = ease.out(prog(t, 0.5 + k * 0.035, 0.25));
        font(ctx, size, 800);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.globalAlpha = clamp(p * 1.4) * (0.25 + 0.75 * hp);
        ctx.fillStyle = wd.em ? C.yellow : C.white;
        ctx.fillText(wd.w, x, y);
      });
    });
    ctx.globalAlpha = clamp(p * 1.4);
    if (q.votes) {
      const pv = ease.back(prog(t, 0.9, 0.4));
      if (pv > 0) { ctx.save(); ctx.translate(cw / 2 - 120, ch / 2); ctx.scale(pv, pv); tag(ctx, `▲ ${q.votes}`, 0, 0, { size: 34, fill: C.yellow, shadow: C.red }); ctx.restore(); }
    }
    ctx.restore();
    caption(ctx, s, t, 1000, 1);
  },

  // ------------------------------------------------------------ giro: "ESPERA... ¿QUÉ?"
  wait(ctx, s, t) {
    const a = L(s, 0, 'ESPERA...');
    const b = L(s, 1, '¿QUÉ?');
    const slam = 0.55;
    const ps = prog(t, slam, 0.25);
    const shake = t > slam && t < slam + 0.35 ? (hash(Math.floor(t * 60)) - 0.5) * 26 * (1 - (t - slam) / 0.35) : 0;
    ctx.save();
    ctx.translate(shake, shake * 0.6);
    let size = 190;
    const gap = 46;
    const ta = up(a.text), tb = up(b.text);
    const oneRow = measure(ctx, ta, size) + measure(ctx, tb, size) + gap < 1700;
    if (!oneRow) size = Math.min(size, fitSize(ctx, ta, 1600, size), fitSize(ctx, tb, 1600, size));
    const wa = measure(ctx, ta, size), wb = measure(ctx, tb, size);
    const ax = oneRow ? W / 2 - (wa + wb + gap) / 2 : W / 2;
    const ay = oneRow ? 600 : 470;
    maskLine(ctx, t, 0, () => headline(ctx, ta, ax, ay, size, a.color, oneRow ? 'left' : 'center'), ay, size);
    if (ps > 0) {
      const bx = oneRow ? ax + wa + gap + wb / 2 : W / 2;
      const by = oneRow ? 600 : 700;
      const sc = lerp(2.3, 1, ease.out5(ps));
      ctx.save();
      ctx.translate(bx, by - size * 0.35);
      ctx.scale(sc, sc);
      ctx.globalAlpha *= clamp(ps * 3);
      headline(ctx, tb, 0, size * 0.35, size, b.color === 'white' ? 'red' : b.color, 'center');
      ctx.restore();
    }
    ctx.restore();
    const fl = 1 - prog(t, slam, 0.18);
    if (t > slam && fl > 0 && !THEME.chalk) { ctx.fillStyle = `rgba(255,255,255,${0.3 * fl})`; ctx.fillRect(0, 0, W, H); }
    caption(ctx, s, t, 900, 1);
  },

  // ------------------------------------------------------------ terminal
  terminal(ctx, s, t) {
    const code = (s.code || '$ ollama run llama3').split('\n').slice(0, 9);
    const p = ease.out5(prog(t, 0, 0.6));
    const w = 1400, h = 120 + code.length * 70 + 50;
    ctx.save();
    ctx.translate(W / 2 - w / 2, (H - h) / 2 - 30 + (1 - p) * 160);
    ctx.globalAlpha *= clamp(p * 1.5);
    block(ctx, 0, 0, w, h, { fill: '#0b0b0c', r: 12, stroke: '#2c2c2c', lw: 3, shadows: [[-10, 10, C.blue], [10, 14, C.red]] });
    ctx.fillStyle = '#1c1c1e'; rrect(ctx, 0, 0, w, 60, [12, 12, 0, 0]); ctx.fill();
    [C.red, C.yellow, C.green].forEach((c, i) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(40 + i * 34, 30, 10, 0, Math.PI * 2); ctx.fill(); });
    txt(ctx, 'TERMINAL', w / 2, 38, { size: 22, family: MONO, weight: 500, color: '#777', align: 'center', spacing: 4 });
    const cps = 38;
    let budget = Math.max(0, (t - 0.5) * cps);
    let cursor = null;
    code.forEach((ln, i) => {
      const isCmd = /^\s*[$>#]/.test(ln);
      const shown = isCmd ? ln.slice(0, Math.floor(budget)) : (budget > 0 ? ln : '');
      budget -= isCmd ? ln.length : Math.max(6, ln.length * 0.15);
      const y = 124 + i * 70;
      if (!shown) return;
      if (isCmd) {
        const m = shown.match(/^(\s*[$>#])(.*)$/);
        const pre = m ? m[1] : '';
        txt(ctx, pre, 50, y, { size: 36, family: MONO, weight: 600, color: C.yellow });
        txt(ctx, m ? m[2] : shown, 50 + measure(ctx, pre, 36, 600, MONO), y, { size: 36, family: MONO, weight: 500, color: C.white, maxW: w - 140 });
        if (shown.length < ln.length) cursor = [50 + measure(ctx, shown, 36, 500, MONO) + 6, y];
      } else {
        txt(ctx, shown, 50, y, { size: 32, family: MONO, weight: 400, color: /error|fail/i.test(ln) ? C.red : '#a9a9a9', maxW: w - 100 });
      }
      if (!cursor && i === code.length - 1 && budget > 0) cursor = [50, y + 70];
    });
    if (cursor && Math.floor(t * 2.5) % 2 === 0) { ctx.fillStyle = C.white; ctx.fillRect(cursor[0], cursor[1] - 30, 18, 38); }
    ctx.restore();
    caption(ctx, s, t, 1010, 1);
  },

  // ------------------------------------------------------------ cuentas en pantalla
  calc(ctx, s, t) {
    const title = L(s, 0);
    if (title) {
      const sz = fitSize(ctx, up(title.text), 1600, 72);
      maskLine(ctx, t, 0, () => headline(ctx, up(title.text), W / 2, 190, sz, title.color, 'center'), 190, sz);
    }
    const its = items(s).slice(0, 5);
    const step = Math.min(140, 680 / Math.max(1, its.length));
    const top = 560 - (step * its.length) / 2 + 30;
    its.forEach((it, i) => {
      const last = i === its.length - 1;
      const y = top + i * step;
      const d0 = at(i, 0.35 + i * 0.6);
      const p = ease.out5(prog(t, d0, 0.5));
      if (p <= 0) return;
      ctx.save();
      ctx.globalAlpha *= clamp(p * 1.5);
      ctx.translate(0, (1 - p) * 30);
      const hl = it.highlight || last;
      const rowH = step * 0.74;
      if (hl) block(ctx, 220, y, 1480, rowH, { fill: C.yellow, r: 4, shadows: SHADOW_RED });
      else { rrect(ctx, 220, y, 1480, rowH, 4); ctx.lineWidth = 2; ctx.strokeStyle = '#3a3a3a'; ctx.stroke(); }
      const fs = rowH * 0.42;
      txt(ctx, up(it.label), 260, y + rowH / 2 + 2, { size: fs, base: 'middle', weight: 600, color: hl ? C.ink : C.white, maxW: 900, family: MONO });
      const disp = it.display ?? String(it.value ?? '');
      const pr = prog(t, d0 + 0.25, 0.6);
      if (pr > 0) {
        txt(ctx, '=', 1230, y + rowH / 2 + 2, { size: fs * 1.2, base: 'middle', color: hl ? C.ink : C.grey, align: 'center' });
        txt(ctx, rollText(up(disp), pr, t), 1660, y + rowH / 2 + 4, { size: fs * 1.35, base: 'middle', align: 'right', color: hl ? C.ink : C.yellow, maxW: 380 });
      }
      ctx.restore();
    });
    caption(ctx, s, t, 1010, 0.4 + its.length * 0.6);
  },

  // ------------------------------------------------------------ proporción en cuadrícula ("SOLO CABE 1 DE CADA 4")
  grid(ctx, s, t) {
    topTitle(ctx, s, t, 200, 72);
    const f = fraction(s.value);
    const cols = 20, rows = 10, cell = 34, gap = 8;
    const gw = cols * (cell + gap) - gap, gh = rows * (cell + gap) - gap;
    const x0 = 360, y0 = 560 - gh / 2 + 40;
    const total = cols * rows;
    const filled = Math.round(total * f);
    for (let i = 0; i < total; i++) {
      const c = i % cols, r = Math.floor(i / cols);
      const appear = prog(t, 0.2 + (c + r) * 0.018, 0.25);
      if (appear <= 0) continue;
      const on = i < filled && t > 0.9 + (i / Math.max(1, filled)) * 0.8;
      ctx.globalAlpha = appear;
      ctx.fillStyle = on ? C.green : '#2a2a2a';
      ctx.fillRect(x0 + c * (cell + gap), y0 + r * (cell + gap), cell, cell);
    }
    ctx.globalAlpha = 1;
    const p = ease.back(prog(t, 1.6, 0.5));
    if (p > 0) {
      ctx.save(); ctx.translate(x0 + gw + 200, y0 + gh / 2 - 30); ctx.scale(p, p);
      tag(ctx, rollText(String(s.value ?? ''), prog(t, 1.6, 0.8), t), 0, 0, { size: 84, fill: C.green, shadow: null });
      ctx.restore();
      ctx.globalAlpha = clamp(p);
      txt(ctx, s.caption ? up(s.caption) : '', x0 + gw + 200, y0 + gh / 2 + 70, { size: 24, family: MONO, color: C.grey, align: 'center', spacing: 2, maxW: 380 });
      ctx.globalAlpha = 1;
    }
  },

  // ------------------------------------------------------------ analogía ("LA COCINA DE UN RESTAURANTE")
  analogy(ctx, s, t) {
    topTitle(ctx, s, t, 170, 72);
    const its = items(s).slice(0, 4);
    const palette = [C.yellow, C.blue, C.green, C.red];
    const n = Math.max(1, its.length);
    const boxW = 1100;
    const step = Math.min(200, 700 / n);
    const top = 560 - (step * n) / 2 + 40;
    its.forEach((it, i) => {
      const col = palette[i % palette.length];
      const y = top + i * step;
      const p = ease.out5(prog(t, at(i, 0.35 + i * 0.5), 0.5));
      if (p <= 0) return;
      ctx.save();
      ctx.globalAlpha *= clamp(p * 1.4);
      ctx.translate(0, (1 - p) * 30);
      const bh = Math.min(100, step * 0.52);
      const bw = boxW * (0.6 + 0.4 * (1 - i / n)) * (0.6 + 0.4 * p);
      rrect(ctx, W / 2 - bw / 2, y, bw, bh, 4);
      ctx.lineWidth = 4; ctx.strokeStyle = col; ctx.stroke();
      const label = up(it.label);
      const ls = fitSize(ctx, label, bw * 0.55, bh * 0.52);
      const lw = measure(ctx, label, ls);
      const tw = it.display ? measure(ctx, up(it.display), 22, 600, MONO, 2) + 24 + 18 : 0;
      const sx = W / 2 - (lw + tw) / 2;
      txt(ctx, label, sx, y + bh / 2 + 2, { size: ls, color: col, base: 'middle' });
      if (it.display) pill(ctx, it.display, sx + lw + 18, y + bh / 2, { color: col, size: 22, align: 'left' });
      if (it.note) txt(ctx, up(it.note), W / 2, y + bh + 34, { size: 22, family: MONO, color: col, align: 'center', spacing: 3, weight: 500, maxW: 1200 });
      ctx.restore();
    });
    caption(ctx, s, t, 1010, 0.4 + n * 0.5);
  },

  // ------------------------------------------------------------ veredicto
  verdict(ctx, s, t) {
    const lines = s.lines?.length ? s.lines : [{ text: 'DEPENDE.', color: 'white' }];
    const tb = titleBlock(ctx, lines, t, { x: 170, cy: 560, maxW: 900, delay: 0.25, maxSize: 150 });
    const ps = ease.back(prog(t, 0, 0.5));
    if (ps > 0) {
      ctx.save();
      ctx.translate(170, tb.top - 44);
      ctx.scale(ps, ps);
      pill(ctx, 'Veredicto', 0, 0, { color: C.red, filled: true, size: 28, align: 'left', textColor: C.white });
      ctx.restore();
    }
    const pi = ease.back(prog(t, 0.4, 0.6));
    const ic = s.icon || 'mac';
    icon(ctx, ic, 1420, 540 + float(t), 480, t, { scale: pi });
    if (s.mood === 'negative') ban(ctx, 1420, 540 + float(t), 210, ease.out(prog(t, 1, 0.6)));
    if (s.mood === 'positive') check(ctx, 1620, 340, 70, ease.out(prog(t, 1, 0.5)));
    if (s.sticker) {
      const p = ease.back(prog(t, 1.2, 0.5));
      if (p > 0) sticker(ctx, 170 + Math.min(tb.width, 900) * 0.45, tb.bottom + 100, s.sticker.label, s.sticker.value, { scale: p, size: 68 });
    }
    caption(ctx, s, t, 1000, 1.4);
  },

  // ------------------------------------------------------------ cierre: pregunta para comentarios
  cta(ctx, s, t) {
    const lines = s.lines?.length ? s.lines : [{ text: 'CONTADME EN *COMENTARIOS*', color: 'white' }];
    titleBlock(ctx, lines, t, { x: W / 2, cy: 430, maxW: 1500, align: 'center', maxSize: 130 });
    const p = ease.back(prog(t, 0.6, 0.5));
    if (p > 0) {
      ctx.save();
      ctx.translate(W / 2, 720);
      ctx.scale(p, p);
      const bw = 640, bh = 120;
      rrect(ctx, -bw / 2, -bh / 2, bw, bh, 8);
      ctx.fillStyle = C.bg2; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = '#3a3a3a'; ctx.stroke();
      const typed = 'Mi equipo: '.slice(0, Math.floor(clamp((t - 1) * 14, 0, 11)));
      txt(ctx, typed, -bw / 2 + 36, 4, { size: 40, weight: 600, color: C.white, base: 'middle' });
      if (Math.floor(t * 2.5) % 2 === 0) { ctx.fillStyle = C.yellow; ctx.fillRect(-bw / 2 + 40 + measure(ctx, typed, 40, 600), -24, 4, 50); }
      txt(ctx, 'COMENTAR', bw / 2 - 30, 4, { size: 26, family: MONO, weight: 600, color: C.yellow, align: 'right', base: 'middle', spacing: 3 });
      ctx.restore();
    }
    caption(ctx, s, t, 880, 1.6);
  },
};

export const SCENE_TYPES = Object.keys(SCENES);

/** Plantillas de props por tipo (para el editor y al cambiar de tipo). */
export const SCENE_TEMPLATES = {
  title: { lines: [{ text: 'NUEVO ES', color: 'white' }, { text: 'PEOR.', color: 'red' }], icon: 'chip', sticker: { label: 'Mínimo', value: '574 GB' } },
  stat: { lines: [{ text: 'IA local ahora va', color: 'white' }], value: '6X', caption: 'más rápida en el mismo hardware' },
  price: { lines: [{ text: 'La RAM, *4-5× más cara*', color: 'white' }], icon: 'ram', value: '64 GB', sticker: { label: 'Esa RAM hoy', value: '1.099 $' } },
  compare: { lines: [{ text: 'Mismo modelo, *misma versión*', color: 'white' }], items: [{ label: 'llama.cpp', value: 15, display: '15 TOK/S' }, { label: 'Motor nuevo', value: 62, display: '62 TOK/S', highlight: true }] },
  versus: { lines: [{ text: '¿Puede *sustituirlo*?', color: 'white' }], items: [{ label: 'Plan Max', icon: 'cloud', display: '200 $/mes' }, { label: 'Mac Mini M6', icon: 'mac', display: '1.299 $', highlight: true }] },
  list: { lines: [{ text: 'Punto de *control*', color: 'white' }], items: [{ label: 'El modelo ocupa 354 GB', note: 'comprimido: 66 GB' }, { label: 'Cada token usa el 2 %', note: 'de los expertos' }, { label: 'El cuello de botella', note: 'es el pasillo', highlight: true }] },
  showcase: { lines: [{ text: 'Encima de la *mesa*', color: 'white' }], items: [{ label: 'Mac Studio', icon: 'mac', display: '512 GB' }, { label: 'DGX Spark', icon: 'server', display: '128 GB', highlight: true }, { label: 'RTX 5090', icon: 'gpu', display: '32 GB' }] },
  stairs: { lines: [{ text: 'Cada *generación*', color: 'white' }], items: [{ label: 'M1', display: 'MAX' }, { label: 'M3', display: 'ULTRA' }, { label: 'M5', display: 'MAX' }, { label: 'M6', display: 'BASE', highlight: true }] },
  quote: { quote: { text: 'Casi *mágico*… como *3×* más rápido que llama.cpp', source: 'r/LocalLLaMA · el elogio más votado', votes: '85' } },
  wait: { lines: [{ text: 'ESPERA...', color: 'white' }, { text: '¿CUÁNTO?', color: 'red' }] },
  terminal: { code: '$ ollama run qwen3:32b\npulling manifest... done\n>>> ¿Cuánto es 2+2?\n4', caption: 'Así de simple lo arrancas' },
  calc: { lines: [{ text: '¿Cuándo se *amortiza*?', color: 'white' }], items: [{ label: '1.299 $ ÷ 200 $/mes', display: '6,5 meses' }, { label: 'Valor real: 17 $/mes', display: '76 meses' }, { label: 'En años', display: '≈ 6 años', highlight: true }] },
  grid: { lines: [{ text: 'Solo cabe *1 de cada 4*', color: 'white' }], value: '25%', caption: 'expertos en la VRAM' },
  analogy: { lines: [{ text: 'La cocina de un *restaurante*', color: 'white' }], items: [{ label: 'Encimera', display: 'VRAM', note: 'pequeña · rapidísima' }, { label: 'Despensa', display: 'RAM', note: 'mucho más · cada viaje cuesta' }, { label: 'Trastero', display: 'SSD', note: 'enorme · lento' }] },
  verdict: { lines: [{ text: 'NO MERECE', color: 'white' }, { text: 'LA PENA.', color: 'white' }], mood: 'negative', icon: 'mac', sticker: { label: '14 años de un plan de', value: '20 $' } },
  cta: { lines: [{ text: '¿Qué RAM y qué *gráfica* tenéis?', color: 'white' }], caption: 'Contádmelo en los comentarios' },
};

export function drawScene(ctx, scene, t, d, itemTimes = null) {
  const fn = SCENES[scene?.type] || SCENES.title;
  const c = THEME.chalk ? chalkify(ctx) : ctx;
  ITEM_TIMES = itemTimes;
  c.save();
  try { fn(c, scene || {}, t, d); } catch (e) { console.warn('Escena con error', scene, e); }
  c.restore();
  ITEM_TIMES = null;
}
