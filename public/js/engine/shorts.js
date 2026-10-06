// Shorts verticales (1080×1920) a partir de un tramo del vídeo largo:
// gancho grande arriba · escena animada en el centro · subtítulos grandes palabra a palabra · "vídeo completo" al final.
import { C, MONO, THEME, setTheme, clamp, ease, txt, fitSize, headline, measure, rrect, background } from './draw.js';
import { drawFrame, wordAt } from './timeline.js';

export const SW = 1080;
export const SH = 1920;

let land = null; // lienzo horizontal donde se dibuja la escena del vídeo largo
function landscape() {
  if (!land) { land = document.createElement('canvas'); land.width = 1920; land.height = 1080; }
  return land;
}

/** Rango de tiempo de un clip a partir de las frases elegidas. */
export function clipRange(sentences, clip) {
  const a = sentences[Math.max(0, Math.min(sentences.length - 1, clip.start))];
  const b = sentences[Math.max(0, Math.min(sentences.length - 1, clip.end))];
  return { t0: Math.max(0, a.t0 - 0.15), t1: b.t1 + 0.35 };
}

/** Frases del vídeo con sus tiempos (las palabras ya llevan tiempos reales si la voz está alineada). */
export function sentencesOf(tl) {
  const out = [];
  let cur = null;
  for (const w of tl.words) {
    if (!cur || cur.seg !== w.seg) { if (cur) out.push(cur); cur = { seg: w.seg, words: [], t0: w.t0 }; }
    cur.words.push(w);
    cur.t1 = w.t1;
    if (/[.?!…]["»”)]?$/.test(w.text)) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.map((s, i) => ({ i, t0: s.t0, t1: s.t1, seg: s.seg, text: s.words.map((w) => w.text).join(' '), first: s.words[0] }));
}

/**
 * Dibuja el instante `t` (tiempo del vídeo largo) del short `clip` en un lienzo vertical.
 * clip: { t0, t1, hook_text }, opts: { theme, channel }
 */
export function drawShort(ctx, tl, t, clip, opts = {}) {
  const k = ctx.canvas.width / SW;
  ctx.save();
  ctx.scale(k, k);
  if (opts.theme && opts.theme !== THEME.name) setTheme(opts.theme);
  background(ctx, SW, SH);

  // escena del vídeo largo, a lo ancho, en el centro
  const lc = landscape();
  drawFrame(lc.getContext('2d'), tl, t, { theme: opts.theme, captions: false, chips: false, progress: false, channel: '', callouts: true });
  const sh = (SW * 1080) / 1920;
  const sy = 640;
  ctx.drawImage(lc, 0, sy, SW, sh);
  ctx.fillStyle = C.yellow; ctx.fillRect(0, sy - 6, SW, 6);
  ctx.fillStyle = C.red; ctx.fillRect(0, sy + sh, SW, 6);

  // gancho arriba (todo el short), con *palabra clave* en amarillo
  const hook = String(clip.hook_text || '').toUpperCase();
  if (hook) {
    const wordsH = hook.split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of wordsH) {
      const test = line ? `${line} ${w}` : w;
      if (line && measure(ctx, test.replace(/\*/g, ''), 112) > SW - 140) { lines.push(line); line = w; } else line = test;
    }
    if (line) lines.push(line);
    // los asteriscos de una palabra clave partida entre líneas se cierran/abren en cada línea
    let open = false;
    const fixed = lines.slice(0, 3).map((l) => { const s = (open ? '*' : '') + l; const n = (l.match(/\*/g) ?? []).length; if (n % 2) open = !open; return open ? `${s}*` : s; });
    const size = Math.min(112, ...fixed.map((l) => fitSize(ctx, l.replace(/\*/g, ''), SW - 140, 112)));
    const p = ease.back(clamp((t - clip.t0) / 0.45));
    ctx.save();
    ctx.translate(SW / 2, 330);
    ctx.scale(0.85 + 0.15 * p, 0.85 + 0.15 * p);
    ctx.globalAlpha = clamp(p * 1.5);
    const top = -((fixed.length - 1) * size * 1.02) / 2;
    fixed.forEach((l, i) => headline(ctx, l, 0, top + i * size * 1.02 + size * 0.35, size, 'white', 'center'));
    ctx.restore();
  }

  // subtítulos grandes: grupos de 3-4 palabras contados desde el inicio del clip; la palabra actual en amarillo
  const wi = wordAt(tl, t);
  const firstIdx = Math.max(0, wordAt(tl, clip.t0 + 0.16));
  if (wi >= firstIdx && t <= clip.t1) {
    // grupos de hasta 4 palabras que se cortan también al final de cada frase
    let g0 = firstIdx, n = 0;
    for (let k = firstIdx; k < wi; k++) {
      n++;
      if (n === 4 || /[.?!…:;]["»”)]?$/.test(tl.words[k].text)) { g0 = k + 1; n = 0; }
    }
    const group = [];
    for (let k = g0; k < tl.words.length && group.length < 4; k++) {
      if (tl.words[k].t0 >= clip.t1) break;
      group.push(tl.words[k]);
      if (/[.?!…:;]["»”)]?$/.test(tl.words[k].text)) break;
    }
    const size = 86;
    ctx.save();
    ctx.font = `800 ${size}px "Inter Tight", sans-serif`;
    const space = ctx.measureText(' ').width;
    const ws = group.map((w) => ctx.measureText(w.text.toUpperCase()).width);
    const total = ws.reduce((a, b) => a + b, 0) + space * Math.max(0, group.length - 1);
    const scale = Math.min(1, (SW - 100) / total);
    ctx.translate(SW / 2, 1460);
    ctx.scale(scale, scale);
    let x = -total / 2;
    ctx.textBaseline = 'middle';
    group.forEach((w, j) => {
      const active = tl.words[wi] === w;
      if (active) { ctx.fillStyle = C.yellow; rrect(ctx, x - 14, -size * 0.62, ws[j] + 28, size * 1.24, 10); ctx.fill(); }
      ctx.fillStyle = active ? C.ink : C.white;
      ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(0,0,0,.65)';
      if (!active) ctx.strokeText(w.text.toUpperCase(), x, 4);
      ctx.fillText(w.text.toUpperCase(), x, 4);
      x += ws[j] + space;
    });
    ctx.restore();
  }

  // "vídeo completo" en los últimos 2,5 s
  const left = clip.t1 - t;
  if (left < 2.5) {
    const p = ease.out(clamp((2.5 - left) / 0.4));
    ctx.save();
    ctx.globalAlpha = p;
    ctx.translate(SW / 2, 1690 + (1 - p) * 40);
    const label = 'VÍDEO COMPLETO EN EL CANAL ↗';
    const w = measure(ctx, label, 46) + 70;
    ctx.fillStyle = C.red; rrect(ctx, -w / 2 + 8, -38, w, 84, 10); ctx.fill();
    ctx.fillStyle = C.white; rrect(ctx, -w / 2, -46, w, 84, 10); ctx.fill();
    txt(ctx, label, 0, -2, { size: 46, color: C.ink, align: 'center', base: 'middle' });
    ctx.restore();
  }

  // progreso del clip y canal
  const prog = clamp((t - clip.t0) / Math.max(0.1, clip.t1 - clip.t0));
  ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(60, SH - 120, SW - 120, 10);
  ctx.fillStyle = C.red; ctx.fillRect(60, SH - 120, (SW - 120) * prog, 10);
  if (opts.channel) txt(ctx, `@${opts.channel}`, SW / 2, SH - 70, { size: 34, family: MONO, weight: 600, color: 'rgba(255,255,255,.55)', align: 'center' });

  // entrada desde negro
  const fin = clamp((t - clip.t0) / 0.2);
  if (fin < 1) { ctx.fillStyle = `rgba(0,0,0,${1 - fin})`; ctx.fillRect(0, 0, SW, SH); }
  ctx.restore();
}
