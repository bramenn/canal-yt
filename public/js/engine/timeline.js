// Línea de tiempo: convierte el guion (segmentos + escenas con "cue") en tiempos reales
// a partir del ritmo de lectura, y dibuja cada fotograma con transiciones y superposiciones.
import { W, H, C, MONO, THEME, setTheme, clamp, ease, txt, measure, rrect, poly, background, finish } from './draw.js';
import { drawScene } from './scenes.js';

export const DEFAULT_WPM = 180; // ritmo medido en los vídeos de referencia
const TRANSITION = 0.32;

/**
 * Busca la frase `cue` en keys desde `from`.
 * Devuelve { i, len, q }: q = 'exact' (idéntica), 'fuzzy' (≥60 % de sus palabras en el mismo sitio:
 * el guion se editó y el ancla se recoloca sola) o 'lost' (i = -1).
 */
function findCue(keys, cueText, from = 0) {
  const cue = String(cueText ?? '').split(/\s+/).map(norm).filter(Boolean).slice(0, 6);
  if (!cue.length) return { i: -1, len: 0, q: 'none' };
  for (let i = from; i <= keys.length - cue.length; i++) {
    let ok = true;
    for (let j = 0; j < cue.length; j++) if (keys[i + j] !== cue[j]) { ok = false; break; }
    if (ok) return { i, len: cue.length, q: 'exact' };
  }
  // tolerante: ventana del mismo tamaño con más palabras del ancla (en cualquier orden)
  let best = { i: -1, score: 0 };
  for (let i = from; i < keys.length; i++) {
    const win = keys.slice(i, i + cue.length);
    const bag = [...cue];
    let score = 0;
    for (const w of win) { const k = bag.indexOf(w); if (k >= 0) { score++; bag.splice(k, 1); } }
    if (score > best.score) best = { i, score };
  }
  const need = Math.max(2, Math.ceil(cue.length * 0.6));
  if (cue.length >= 2 && best.score >= need) return { i: best.i, len: cue.length, q: 'fuzzy' };
  return { i: -1, len: cue.length, q: 'lost' };
}

/**
 * Cruza las palabras del guion con las que Whisper oyó en el audio (LCS sobre palabras normalizadas).
 * Devuelve para cada palabra del guion { s, e } en segundos (relativos al audio) o null si no hubo pareja,
 * y las palabras oídas que no casan con el guion (posibles fallos de pronunciación).
 */
function matchHeard(keys, heard) {
  const hk = heard.map((h) => norm(h.w));
  const n = keys.length, m = hk.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = keys[i] && keys[i] === hk[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const map = new Array(n).fill(null);
  const used = new Array(m).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (keys[i] && keys[i] === hk[j]) { map[i] = { s: heard[j].s, e: heard[j].e }; used[j] = true; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const extra = heard.filter((_, k) => !used[k] && hk[k]).map((h) => ({ w: h.w, s: h.s, e: h.e, p: h.p }));
  // racha más larga de palabras del guion sin pareja: si es grande, la voz dijo otra cosa (audio roto)
  let run = 0, maxRun = 0;
  for (const m of map) { run = m ? 0 : run + 1; maxRun = Math.max(maxRun, run); }
  return { map, matched: map.filter(Boolean).length, extra, maxRun };
}

const norm = (w) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]/g, '');

/** Peso temporal de una palabra: las pausas de puntuación cuentan. */
function weightOf(raw) {
  let w = 1;
  if (/\.\.\.$|…$/.test(raw)) w += 1.1;
  else if (/[.?!]["»”)]?$/.test(raw)) w += 0.7;
  else if (/[,;:]$/.test(raw)) w += 0.3;
  return w;
}

/**
 * @param video { segments: [{ section, narration, scenes: [{cue, type, ...}] }] }
 * @returns { duration, segments[], scenes[], words[], chunks[] }
 */
export function buildTimeline(video, { wpm = DEFAULT_WPM, segDurations = null, segAlign = null } = {}) {
  // el ritmo medido en los vídeos (ppm) ya incluye pausas: repartimos ese tiempo según el peso de cada palabra
  let nWords = 0, nWeight = 0, nParas = 0;
  for (const seg of video?.segments ?? []) {
    for (const para of String(seg.narration ?? '').split(/\n+/).filter((p) => p.trim())) {
      nParas++;
      for (const raw of para.split(/\s+/).filter(Boolean)) { nWords++; nWeight += weightOf(raw.replace(/\*/g, '')); }
    }
  }
  const secPerWeight = nWeight ? (60 / wpm) * (nWords / (nWeight + nParas * 0.7)) : 60 / wpm;
  const words = [];
  const segments = [];
  const scenes = [];
  const callouts = [];
  let t = 0;

  (video?.segments ?? []).forEach((seg, si) => {
    const start = t;
    const paragraphs = String(seg.narration ?? '').split(/\n+/).map((p) => p.trim()).filter(Boolean);
    const segWords = [];
    // con voz IA, el segmento dura exactamente lo que su audio y las palabras se reparten dentro
    const audioDur = segDurations?.[si];
    let spw = secPerWeight;
    if (audioDur > 0) {
      let segWeight = paragraphs.length * 0.7;
      for (const para of paragraphs) for (const raw of para.split(/\s+/).filter(Boolean)) segWeight += weightOf(raw.replace(/\*/g, ''));
      spw = segWeight ? audioDur / segWeight : secPerWeight;
    }
    paragraphs.forEach((para, pi) => {
      for (const raw of para.split(/\s+/).filter(Boolean)) {
        const clean = raw.replace(/\*/g, '');
        const dur = weightOf(clean) * spw;
        const w = { raw, text: clean, em: false, t0: t, t1: t + dur, seg: si, para: pi, key: norm(clean) };
        segWords.push(w);
        words.push(w);
        t += dur;
      }
      t += 0.35 * spw * 2; // respiración entre párrafos
    });
    if (audioDur > 0) t = start + audioDur;
    // con alineación (Whisper): cada palabra en su instante REAL; las no emparejadas (p. ej. cifras dichas
    // como "quinientos") se reparten entre sus vecinas emparejadas
    let alignInfo = null;
    const heard = segAlign?.[si];
    if (audioDur > 0 && heard?.length && segWords.length) {
      const { map, matched, extra, maxRun } = matchHeard(segWords.map((w) => w.key), heard);
      alignInfo = { ratio: matched / segWords.length, extra, maxRun };
      if (matched / segWords.length >= 0.35) {
        let k = 0;
        while (k < segWords.length) {
          if (map[k]) { segWords[k].t0 = start + map[k].s; segWords[k].t1 = start + Math.max(map[k].s + 0.05, map[k].e); k++; continue; }
          let j = k;
          while (j < segWords.length && !map[j]) j++;
          const a = k > 0 ? segWords[k - 1].t1 : start;
          const b = j < segWords.length ? start + map[j].s : start + audioDur;
          const ws = segWords.slice(k, j).map((w) => weightOf(w.text));
          const total = ws.reduce((x, y) => x + y, 0) || 1;
          let cur = a;
          for (let m = k; m < j; m++) { const d = ((b - a) * ws[m - k]) / total; segWords[m].t0 = cur; segWords[m].t1 = cur + d; cur += d; }
          k = j;
        }
      }
    }
    // énfasis *...* (puede abarcar varias palabras)
    let em = false;
    for (const w of segWords) {
      const open = w.raw.startsWith('*');
      if (open) em = true;
      w.em = em;
      if (/\*[^\w]*$/.test(w.raw) && (w.raw.length > 1 || !open)) em = false;
    }
    t += audioDur > 0 ? 0.35 : 0.5; // hueco entre segmentos
    const end = t;
    segments.push({ index: si, section: seg.section || '', start, end, words: segWords, align: alignInfo });

    // escenas: localizar cada cue dentro de las palabras del segmento
    const list = seg.scenes?.length ? seg.scenes : [{ type: 'title', cue: '', lines: [{ text: seg.section || '...', color: 'white' }] }];
    const keys = segWords.map((w) => w.key);
    let searchFrom = 0;
    const cueInfo = [];
    const starts = list.map((sc, k) => {
      if (k === 0) { cueInfo.push({ q: 'first' }); return start; }
      const f = findCue(keys, sc.cue, searchFrom);
      cueInfo.push(f);
      if (f.i < 0) return null;
      searchFrom = f.i + 1;
      return Math.max(start, segWords[f.i].t0 - 0.15);
    });
    // los cues no encontrados se reparten entre los vecinos conocidos
    for (let k = 1; k < starts.length; k++) {
      if (starts[k] !== null) continue;
      let j = k;
      while (j < starts.length && starts[j] === null) j++;
      const a = starts[k - 1];
      const b = j < starts.length ? starts[j] : end;
      for (let m = k; m < j; m++) starts[m] = a + ((b - a) * (m - k + 1)) / (j - k + 1);
      k = j - 1;
    }
    // asegurar orden creciente
    for (let k = 1; k < starts.length; k++) if (starts[k] <= starts[k - 1] + 1) starts[k] = Math.min(end - 0.5, starts[k - 1] + 1);
    list.forEach((sc, k) => {
      const sStart = starts[k];
      const sEnd = k + 1 < list.length ? starts[k + 1] : end;
      // cada elemento (items[i].cue) entra cuando la voz lo nombra; tiempo local a la escena
      const firstWord = Math.max(0, segWords.findIndex((w) => w.t0 >= sStart - 0.2));
      let from = firstWord;
      const itemInfo = [];
      const itemTimes = (Array.isArray(sc.items) ? sc.items : []).map((it) => {
        let f = findCue(keys, it?.cue, from);
        // la frase puede nombrar los elementos en otro orden: se busca en todo el tramo de la escena
        if (f.i < 0 && it?.cue) { const g = findCue(keys, it.cue, firstWord); if (g.i >= 0 && segWords[g.i].t0 < sEnd) f = g; }
        // o justo antes de que entre la escena (se nombra al final de la escena anterior)
        if (f.i < 0 && it?.cue) { const g = findCue(keys, it.cue, Math.max(0, firstWord - 25)); if (g.i >= 0 && segWords[g.i].t0 < sEnd) f = g; }
        itemInfo.push(f);
        if (f.i < 0 || segWords[f.i].t0 >= sEnd) return null;
        from = Math.max(from, f.i + 1);
        return Math.max(0, segWords[f.i].t0 - sStart - 0.1);
      });
      scenes.push({ scene: sc, seg: si, idx: k, start: sStart, end: sEnd, itemTimes, cueInfo: cueInfo[k], itemInfo });
    });

    // rótulos de palabras clave: cada *énfasis* dicho en voz aparece en pantalla al decirse
    let group = null;
    const flush = () => { if (group) { callouts.push(group); group = null; } };
    for (const w of segWords) {
      if (!w.em) { flush(); continue; }
      const text = w.text.replace(/[.,;:!?¿¡…"«»()]+$/g, '').replace(/^[¿¡"«(]+/, '');
      if (!group) group = { text, t0: w.t0, t1: w.t1, seg: si };
      else { group.text += ` ${text}`; group.t1 = w.t1; }
      if (/[.?!…]$/.test(w.text)) flush();
    }
    flush();
  });

  // un rótulo dura hasta ~1,8 s después de dicho, sin pisar al siguiente; se omite si la escena ya lo muestra
  callouts.forEach((c, i) => {
    c.end = Math.min(c.t1 + 1.8, callouts[i + 1] ? callouts[i + 1].t0 - 0.1 : Infinity);
    const sc = scenes.find((x) => c.t0 >= x.start && c.t0 < x.end);
    const onScreen = sc ? norm(JSON.stringify(sc.scene)) : '';
    c.redundant = c.text.length > 34 || (c.text.length > 0 && onScreen.includes(norm(c.text.replace(/\s+/g, ''))));
  });

  // frases para subtítulos (≤ 7 palabras, cortando en puntuación)
  const chunks = [];
  let cur = [];
  words.forEach((w, i) => {
    cur.push(w);
    if (cur.length >= 7 || /[.?!…:;]$/.test(w.text) || (cur.length >= 4 && /,$/.test(w.text))) { chunks.push(cur); cur = []; }
    else if (words[i + 1]?.seg !== w.seg) { chunks.push(cur); cur = []; }
  });
  if (cur.length) chunks.push(cur);
  chunks.forEach((c) => { c.t0 = c[0].t0; c.t1 = c[c.length - 1].t1; });

  // ritmo visual: tramos sin ningún cambio (escena nueva, elemento que entra o rótulo)
  const events = [
    ...scenes.map((s) => s.start),
    ...scenes.flatMap((s) => s.itemTimes.filter((x) => x != null).map((x) => s.start + x)),
    ...callouts.filter((c) => !c.redundant).map((c) => c.t0),
  ].sort((a, b) => a - b);
  let longest = { gap: 0, at: 0 };
  events.push(Math.max(t, 1));
  for (let i = 1; i < events.length; i++) if (events[i] - events[i - 1] > longest.gap) longest = { gap: events[i] - events[i - 1], at: events[i - 1] };
  const pace = { events: events.length - 1, every: Math.max(t, 1) / Math.max(1, events.length - 1), longest };

  return { duration: Math.max(t, 1), segments, scenes, words, chunks, callouts, pace, wpm };
}

function findIndex(arr, t, key0 = 'start', key1 = 'end') {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < arr[mid][key0]) hi = mid - 1;
    else if (t >= arr[mid][key1]) lo = mid + 1;
    else return mid;
  }
  return clamp(lo, 0, arr.length - 1);
}

export const wordAt = (tl, t) => (tl.words.length ? findIndex(tl.words, t, 't0', 't1') : -1);
export const sceneAt = (tl, t) => (tl.scenes.length ? findIndex(tl.scenes, t) : -1);
export const segmentAt = (tl, t) => (tl.segments.length ? findIndex(tl.segments, t) : -1);

// ---------- render de un fotograma ----------

const SECTION_COLORS = { HOOK: '#E5413A', CONTEXTO: '#2E7BE6', DATOS: '#F5C518', GIRO: '#E5413A', VEREDICTO: '#6CC24A', CIERRE: '#8d8d8d' };
export const sectionColor = (s) => SECTION_COLORS[s] || '#8d8d8d';

function sceneFrame(ctx, sc, t) {
  const local = t - sc.start;
  const d = sc.end - sc.start;
  // empuje de cámara muy suave
  const k = 1 + 0.02 * clamp(local / Math.max(d, 1));
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(k, k);
  ctx.translate(-W / 2, -H / 2);
  drawScene(ctx, sc.scene, local, d, sc.itemTimes);
  ctx.restore();
}

/**
 * Dibuja el instante `t` de la línea de tiempo.
 * opts: { captions, channel, theme, chips, progress }
 */
export function drawFrame(ctx, tl, t, opts = {}) {
  if (opts.theme && opts.theme !== THEME.name) setTheme(opts.theme);
  ctx.save();
  background(ctx);
  if (!tl.scenes.length) { ctx.restore(); return; }
  const i = sceneAt(tl, t);
  const sc = tl.scenes[i];
  const local = t - sc.start;

  if (i > 0 && local < TRANSITION) {
    // cortinilla diagonal: escena anterior congelada + barras amarilla/roja barriendo
    const prev = tl.scenes[i - 1];
    sceneFrame(ctx, prev, prev.end - 0.001);
    const p = ease.inOut(local / TRANSITION);
    const edge = -300 + (W + 600) * p;
    const skew = 160;
    ctx.save();
    poly(ctx, [[-400, 0], [edge + skew, 0], [edge - skew, H], [-400, H]]);
    ctx.clip();
    background(ctx);
    sceneFrame(ctx, sc, t);
    ctx.restore();
    ctx.fillStyle = C.red;
    poly(ctx, [[edge + skew, 0], [edge + skew + 34, 0], [edge - skew + 34, H], [edge - skew, H]]);
    ctx.fill();
    ctx.fillStyle = C.yellow;
    poly(ctx, [[edge + skew - 26, 0], [edge + skew + 4, 0], [edge - skew + 4, H], [edge - skew - 26, H]]);
    ctx.fill();
  } else {
    sceneFrame(ctx, sc, t);
  }

  // ---- superposiciones ----
  const si = segmentAt(tl, t);
  const seg = tl.segments[si];
  if (opts.chips !== false && seg?.section) {
    const ls = t - seg.start;
    const p = ease.out5(clamp(ls / 0.5)) * (1 - clamp((ls - 4) / 0.5));
    if (p > 0) {
      ctx.save();
      ctx.globalAlpha = p;
      const label = `${String(si + 1).padStart(2, '0')} · ${seg.section}`;
      const w = measure(ctx, label, 22, 600, MONO, 3) + 44;
      const x = 60 - (1 - p) * 40;
      rrect(ctx, x, 50, w, 44, 3);
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fill();
      ctx.fillStyle = sectionColor(seg.section);
      ctx.fillRect(x, 50, 6, 44);
      txt(ctx, label, x + 24, 73, { size: 22, family: MONO, weight: 600, color: C.white, base: 'middle', spacing: 3 });
      ctx.restore();
    }
  }

  if (opts.callouts !== false) drawCallout(ctx, tl, t);
  if (opts.captions) drawCaptions(ctx, tl, t);

  if (opts.channel) {
    txt(ctx, `<${opts.channel}`, W - 40, H - 30, { size: 20, family: MONO, weight: 500, color: 'rgba(255,255,255,.35)', align: 'right' });
  }
  if (opts.progress !== false) {
    ctx.fillStyle = 'rgba(255,255,255,.08)';
    ctx.fillRect(0, H - 6, W, 6);
    ctx.fillStyle = C.red;
    ctx.fillRect(0, H - 6, (W * t) / tl.duration, 6);
  }
  finish(ctx, t);
  ctx.restore();
}

/** Rótulo de palabra clave: aparece al decirse, arriba a la derecha (no tapa la escena ni los subtítulos). */
function drawCallout(ctx, tl, t) {
  const c = tl.callouts?.find((x) => !x.redundant && t >= x.t0 - 0.05 && t < x.end);
  if (!c) return;
  const local = t - c.t0;
  const pin = ease.back(clamp(local / 0.35));
  const pout = clamp((c.end - t) / 0.25);
  const p = Math.min(pin, pout);
  if (p <= 0) return;
  const text = c.text.toUpperCase();
  const size = 46;
  const tw = measure(ctx, text, size, 800);
  const w = tw + 44, h = size * 1.45;
  ctx.save();
  ctx.translate(W - 70 - w / 2, 92);
  ctx.rotate(-0.035);
  ctx.scale(p, p);
  ctx.globalAlpha = clamp(p * 1.5);
  ctx.fillStyle = C.red;
  rrect(ctx, -w / 2 + 7, -h / 2 + 7, w, h, 4); ctx.fill();
  ctx.fillStyle = C.yellow;
  rrect(ctx, -w / 2, -h / 2, w, h, 4); ctx.fill();
  // subrayado que avanza mientras se dice
  const said = clamp((t - c.t0) / Math.max(0.2, c.t1 - c.t0));
  ctx.fillStyle = C.ink;
  ctx.fillRect(-w / 2 + 22, h / 2 - 12, (w - 44) * said, 5);
  txt(ctx, text, 0, 3, { size, color: C.ink, align: 'center', base: 'middle' });
  ctx.restore();
}

function drawCaptions(ctx, tl, t) {
  const ci = findIndex(tl.chunks, t, 't0', 't1');
  const chunk = tl.chunks[ci];
  if (!chunk || t < chunk.t0 - 0.05 || t > chunk.t1 + 0.4) return;
  const size = 46;
  const font = `700 ${size}px "Inter Tight", sans-serif`;
  ctx.save();
  ctx.font = font;
  const space = ctx.measureText(' ').width;
  const widths = chunk.map((w) => ctx.measureText(w.text).width);
  const total = widths.reduce((a, b) => a + b, 0) + space * (chunk.length - 1);
  let x = W / 2 - total / 2;
  const y = H - 92;
  rrect(ctx, x - 26, y - size * 0.95, total + 52, size * 1.45, 6);
  ctx.fillStyle = 'rgba(0,0,0,.72)';
  ctx.fill();
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  chunk.forEach((w, k) => {
    const active = t >= w.t0 && t < w.t1 + 0.05;
    const said = t >= w.t1;
    ctx.fillStyle = active ? C.yellow : said || w.em ? '#ffffff' : 'rgba(255,255,255,.6)';
    ctx.fillText(w.text, x, y);
    x += widths[k] + space;
  });
  ctx.restore();
}

// ---------- reproductor ----------

export class Player {
  constructor(canvas, draw = drawFrame) {
    this.canvas = canvas;
    this.draw = draw; // otro tipo de vídeo puede traer su propio render de fotograma
    this.ctx = canvas.getContext('2d');
    canvas.width = W;
    canvas.height = H;
    this.tl = buildTimeline({ segments: [] });
    this.t = 0;
    this.rate = 1;
    this.playing = false;
    this.opts = { captions: false, channel: '', theme: 'infografia' };
    this.listeners = new Set();
    this.dirty = true;
    this.last = performance.now();
    const loop = (now) => {
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      if (this.playing) {
        if (this.audioOn()) this.t = this.mixer.time();
        else this.t += dt * this.rate;
        if (this.t >= this.tl.duration) { this.t = this.tl.duration; this.pause(); this.emit('ended'); }
        this.dirty = true;
      }
      if (this.dirty) {
        this.dirty = false;
        // en pausa al principio, la intro aún no ha entrado y el lienzo parece vacío: mostrar la primera escena ya montada
        const poster = !this.playing && this.t < 0.2 && this.tl.scenes?.length ? Math.min(1.5, this.tl.scenes[0].end - 0.05) : this.t;
        this.draw(this.ctx, this.tl, poster, this.opts);
        this.emit('time');
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type) { for (const fn of this.listeners) fn(type, this); }
  load(video, { wpm, segDurations, segAlign } = {}) {
    this.tl = buildTimeline(video, { wpm: wpm || this.tl.wpm || DEFAULT_WPM, segDurations, segAlign });
    this.t = Math.min(this.t, this.tl.duration);
    if (this.playing && this.audioOn()) this.mixer.play(this.t, this.tl);
    this.dirty = true;
    this.emit('load');
  }
  /** Mezclador de audio (voz IA + efectos + música). Cuando suena, su reloj manda: imagen y sonido nunca se separan. */
  setMixer(m) { this.mixer = m; }
  audioOn() { return !!this.mixer?.active(); }
  /** Vuelve a programar el audio (tras cambiar mezcla, kit o voz). */
  refreshAudio() { if (this.playing) { this.mixer?.stop(); if (this.audioOn()) this.mixer.play(this.t, this.tl); } }
  setOpts(o) { Object.assign(this.opts, o); this.dirty = true; }
  play() {
    if (this.t >= this.tl.duration) this.t = 0;
    this.playing = true;
    this.last = performance.now();
    if (this.audioOn()) this.mixer.play(this.t, this.tl);
    this.emit('play');
  }
  pause() { this.playing = false; this.mixer?.stop(); this.emit('pause'); }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(t) {
    this.t = clamp(t, 0, this.tl.duration);
    if (this.playing && this.audioOn()) this.mixer.play(this.t, this.tl);
    this.dirty = true;
  }
  render() { this.dirty = true; }
}
