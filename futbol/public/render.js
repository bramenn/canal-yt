// Render de un fotograma: foto o clip del plano a pantalla completa, con movimiento lento y transiciones de montaje
// (fundido, paso a negro, zoom con desenfoque, barrido con desenfoque de movimiento, corte, destello).
// Determinista: sirve para la vista previa y para el MP4 (en exportación los clips se colocan antes con seekFor).
import { sceneAt } from '/engine/timeline.js';

export const W = 1920, H = 1080;
const cache = new Map(); // url → { img | video, bg, dur }
let redraw = () => {};
let live = false;        // vista previa reproduciéndose: los clips suenan en tiempo real
let exporting = false;   // exportación: los clips ya están colocados en su fotograma exacto
export const setRedraw = (fn) => { redraw = fn; };
export const setLive = (on) => { live = on; if (!on) for (const e of cache.values()) e.video?.pause(); };

const isVideo = (m) => m?.type === 'video';

/** Carga (una vez) fotos y clips; resuelve cuando todos han cargado o fallado. */
export function preload(medias) {
  return Promise.all(medias.filter((m) => m?.url).map((m) => {
    if (cache.has(m.url)) return cache.get(m.url).ready;
    const entry = { img: null, video: null, bg: null, dur: m.dur ?? 0 };
    entry.ready = isVideo(m) ? loadVideo(m.url, entry) : loadImage(m.url, entry);
    cache.set(m.url, entry);
    return entry.ready;
  }));
}

function loadImage(url, entry) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { entry.img = img; entry.bg = img.width / img.height < 1.6 ? blurred(img) : null; redraw(); resolve(); };
    img.onerror = () => resolve();
    img.src = url;
  });
}

// como blob: el vídeo entero en memoria se puede posicionar en cualquier instante sin peticiones parciales
async function loadVideo(url, entry) {
  try {
    const blob = await (await fetch(url)).blob();
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.src = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => { v.onloadeddata = resolve; v.onerror = reject; });
    v.onseeked = () => redraw();
    entry.video = v;
    entry.dur = v.duration || entry.dur;
    redraw();
  } catch {}
}

// desenfoque barato: cubrir un lienzo diminuto y luego escalarlo suaviza la imagen
function blurred(img) {
  const c = document.createElement('canvas');
  c.width = 48; c.height = 27;
  const x = c.getContext('2d');
  cover(x, img, 48, 27, img.width, img.height);
  x.fillStyle = 'rgba(0,0,0,.45)';
  x.fillRect(0, 0, 48, 27);
  return c;
}

function cover(ctx, src, w, h, sw, sh) {
  const s = Math.max(w / sw, h / sh);
  ctx.drawImage(src, (w - sw * s) / 2, (h - sh * s) / 2, sw * s, sh * s);
}

const rand = (n) => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const inOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);

// ---------- transiciones ----------
export const TRANSITIONS = { auto: 'Auto', fade: 'Fundido', dip: 'Negro', zoom: 'Zoom', whip: 'Barrido', flash: 'Destello', cut: 'Corte' };
const DUR = { fade: 0.6, dip: 0.8, zoom: 0.5, whip: 0.45, flash: 0.45, cut: 0 };

/** Transición con la que ENTRA la escena i. Auto: paso a negro al cambiar de sección; dentro, sobre todo fundidos. */
export function transitionOf(tl, i) {
  const sc = tl.scenes[i];
  const tr = sc.scene.transition;
  if (tr && tr !== 'auto' && tr in DUR) return tr;
  if (sc.idx === 0) return 'dip';
  const r = rand(sc.seg * 101 + sc.idx + 3);
  return r < 0.6 ? 'fade' : r < 0.78 ? 'zoom' : r < 0.9 ? 'whip' : 'cut';
}

/** Instante local del clip en el tiempo t (se congela en el último fotograma si el plano dura más que el clip). */
const clipTime = (e, sc, t) => clamp(t - sc.start, 0, Math.max(0, e.dur - 0.04));

// fx: { scale, dx, blur, alpha } extra de la transición
function drawShot(ctx, sc, t, fx = {}) {
  const m = sc.scene.media;
  const e = cache.get(m?.url);
  const src = e?.video ?? e?.img;
  if (!src) {
    ctx.fillStyle = '#141414';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#777';
    ctx.textAlign = 'center';
    ctx.font = '600 44px system-ui, sans-serif';
    ctx.fillText(e ? 'Cargando…' : 'Falta foto o clip', W / 2, H / 2 - 30);
    ctx.font = '32px system-ui, sans-serif';
    ctx.fillText(String(sc.scene.desc ?? '').slice(0, 90), W / 2, H / 2 + 30);
    return;
  }
  const seed = sc.seg * 101 + sc.idx;
  const p = clamp((t - sc.start) / (sc.end - sc.start + 0.8));
  let z, dx, dy;
  if (e.video) {
    // el clip ya se mueve: solo un empuje mínimo
    z = 1.01 + 0.03 * p; dx = 0; dy = 0;
    const local = clipTime(e, sc, t);
    if (!exporting) {
      if (live && t - sc.start < e.dur) { if (e.video.paused) e.video.play().catch(() => {}); if (Math.abs(e.video.currentTime - local) > 0.3) e.video.currentTime = local; }
      else { if (!e.video.paused) e.video.pause(); if (Math.abs(e.video.currentTime - local) > 0.05) e.video.currentTime = local; }
    }
  } else {
    // cada foto con su movimiento (acercar o alejar, deriva lateral), siempre el mismo para el mismo plano
    z = rand(seed) < 0.6 ? 1.04 + 0.09 * p : 1.13 - 0.09 * p;
    dx = (rand(seed + 7) - 0.5) * 80 * (p - 0.5);
    dy = (rand(seed + 13) - 0.5) * 40 * (p - 0.5);
  }
  ctx.save();
  ctx.globalAlpha = fx.alpha ?? 1;
  if (fx.blur) ctx.filter = `blur(${fx.blur.toFixed(1)}px)`;
  if (e.bg) ctx.drawImage(e.bg, -40, -40, W + 80, H + 80);
  ctx.translate(W / 2 + dx + (fx.dx ?? 0), H / 2 + dy);
  ctx.scale(z * (fx.scale ?? 1), z * (fx.scale ?? 1));
  ctx.translate(-W / 2, -H / 2);
  if (e.video) cover(ctx, e.video, W, H, e.video.videoWidth, e.video.videoHeight);
  else if (e.bg) { const s = H / e.img.height; ctx.drawImage(e.img, (W - e.img.width * s) / 2, 0, e.img.width * s, H); }
  else cover(ctx, e.img, W, H, e.img.width, e.img.height);
  ctx.restore();
}

// barrido: varias copias desplazadas y transparentes = desenfoque de movimiento horizontal
// (media de n copias: la k-ésima con opacidad 1/(k+1) deja a todas con el mismo peso)
function smear(ctx, sc, t, x, speed) {
  const n = speed > 0.05 ? 10 : 1;
  const spread = 260 * speed;
  for (let k = 0; k < n; k++) drawShot(ctx, sc, t, { dx: x + (n > 1 ? (k / (n - 1) - 0.5) * spread : 0), alpha: 1 / (k + 1), blur: 5 * speed });
}

export function drawFrame(ctx, tl, t) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!tl.scenes.length) return;
  const i = sceneAt(tl, t);
  const sc = tl.scenes[i];
  const prev = tl.scenes[i - 1];
  const tr = i > 0 ? transitionOf(tl, i) : 'cut';
  const local = t - sc.start;
  const d = DUR[tr];
  if (!prev || local >= d) drawShot(ctx, sc, t);
  else {
    const p = clamp(local / d);
    const q = inOut(p);
    if (tr === 'fade') { drawShot(ctx, sc, t); drawShot(ctx, prev, t, { alpha: 1 - q }); }
    else if (tr === 'dip') {
      // sale a negro y entra desde negro
      if (p < 0.5) drawShot(ctx, prev, t, { alpha: 1 - inOut(p * 2) });
      else drawShot(ctx, sc, t, { alpha: inOut((p - 0.5) * 2) });
    } else if (tr === 'zoom') {
      // la saliente se acerca y se desenfoca; la entrante llega acercada y se enfoca
      drawShot(ctx, sc, t, { scale: 1.25 - 0.25 * q, blur: 14 * (1 - q) });
      drawShot(ctx, prev, t, { scale: 1 + 0.35 * q, blur: 14 * q, alpha: 1 - q });
    } else if (tr === 'whip') {
      const speed = Math.sin(Math.PI * p); // máxima a mitad del barrido
      smear(ctx, prev, t, -W * q, speed);
      smear(ctx, sc, t, W * (1 - q), speed);
    } else if (tr === 'flash') {
      drawShot(ctx, p < 0.2 ? prev : sc, t);
      ctx.fillStyle = `rgba(255,255,255,${(0.85 * (1 - Math.abs(p - 0.2) / 0.8)).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    } else drawShot(ctx, sc, t);
  }
  finish(ctx, t);
}

// ---------- acabado: viñeta y grano de película ----------
const vignettes = new WeakMap(); // un degradado por lienzo (vista previa y exportación usan lienzos distintos)
let grain = null;
function finish(ctx, t) {
  let vignette = vignettes.get(ctx);
  if (!vignette) {
    vignette = ctx.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.72);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.38)');
    vignettes.set(ctx, vignette);
  }
  if (!grain) {
    grain = document.createElement('canvas');
    grain.width = grain.height = 256;
    const g = grain.getContext('2d');
    const img = g.createImageData(256, 256);
    for (let k = 0; k < img.data.length; k += 4) { const v = rand(k + 1) * 255; img.data[k] = img.data[k + 1] = img.data[k + 2] = v; img.data[k + 3] = 255; }
    g.putImageData(img, 0, 0);
  }
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);
  // el grano cambia de posición en cada fotograma (determinista por el tiempo)
  const f = Math.floor(t * 30);
  ctx.save();
  ctx.globalAlpha = 0.045;
  ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = ctx.createPattern(grain, 'repeat');
  ctx.translate(-Math.floor(rand(f) * 256), -Math.floor(rand(f + 99) * 256));
  ctx.fillRect(0, 0, W + 256, H + 256);
  ctx.restore();
}

/** Exportación: coloca cada clip visible en el fotograma exacto de t antes de dibujarlo. */
export async function seekFor(tl, t) {
  exporting = true;
  const i = sceneAt(tl, t);
  for (const sc of [tl.scenes[i], tl.scenes[i - 1]]) {
    const e = sc && cache.get(sc.scene.media?.url);
    if (!e?.video) continue;
    const local = clipTime(e, sc, t);
    if (Math.abs(e.video.currentTime - local) < 1e-3) continue;
    await new Promise((resolve) => { e.video.addEventListener('seeked', resolve, { once: true }); e.video.currentTime = local; });
  }
}
export const endExport = () => { exporting = false; };
