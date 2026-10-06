// Mezclador: voz IA + efectos sincronizados con la imagen + música de fondo con "ducking".
// Reglas (ver style/sonido.md): la voz manda; efectos solo en eventos visuales con significado, espaciados y
// con tope por minuto; música 18-24 dB por debajo de la voz mientras se habla y algo más alta en las pausas.

export const DENSITY = {
  sutil: { gap: 1.6, perMin: 8, label: 'Sutil' },
  normal: { gap: 0.9, perMin: 14, label: 'Normal' },
  marcado: { gap: 0.55, perMin: 22, label: 'Marcado' },
};
// prioridad cuando dos efectos chocan; recorte relativo de cada tipo (un tick debe ser mucho más bajo que un golpe)
const PRIORITY = { impact: 5, typing: 4, whoosh: 4, ding: 3, pop: 2, tick: 1 };
const TRIM_DB = { whoosh: -2, pop: -4, tick: -8, impact: 0, ding: -3, typing: -6 };
export const DEFAULT_MIX = { sfx: true, music: true, sfxDb: -16, musicDb: -22, gapBoostDb: 7, density: 'normal', monitor: true, off: [], breathClean: true, breathDb: -15 };
// variación de tono por tipo: los sonidos largos o con tono (barridos, golpes) NO se desafinan (sonarían a "gemido")
const PITCH_VAR = { whoosh: 0, impact: 0, typing: 0, ding: 0.02, pop: 0.04, tick: 0.04 };

const db = (x) => Math.pow(10, x / 20);

const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

/** Eventos de efectos a partir de la línea de tiempo, ya filtrados por las reglas de densidad. */
export function sfxEvents(tl, density = 'normal', available = null) {
  const cfg = DENSITY[density] ?? DENSITY.normal;
  const ev = [];
  const add = (t, cat, extra = {}) => { if (t >= 0 && (!available || available.has(cat))) ev.push({ t, cat, ...extra }); };
  tl.scenes.forEach((sc, i) => {
    const type = sc.scene?.type;
    const items = Array.isArray(sc.scene?.items) ? sc.scene.items : [];
    if (i > 0) {
      if (type === 'wait') add(sc.start + 0.55, 'impact');            // el "¿QUÉ?" golpea
      else add(Math.max(0, sc.start - 0.12), 'whoosh');                // el barrido cruza la pantalla
    }
    if (type === 'verdict') add(sc.start + 0.45, 'impact', { soft: true });
    sc.itemTimes?.forEach((x) => { if (x != null && x > 0.25) add(sc.start + x, 'pop'); });
    if (type === 'calc' && items.length) {
      const last = sc.itemTimes?.[items.length - 1] ?? 0.35 + (items.length - 1) * 0.6;
      add(sc.start + last + 0.85, 'ding');                            // el resultado final se fija
    }
    if (type === 'stat') add(sc.start + 1.2, 'ding');
    if (type === 'grid') add(sc.start + 1.7, 'ding');
    if (type === 'terminal') {
      const chars = String(sc.scene.code ?? '').split('\n').filter((l) => /^\s*[$>#]/.test(l)).join('').length;
      add(sc.start + 0.5, 'typing', { dur: Math.min(sc.end - sc.start - 0.8, Math.max(0.8, chars / 38)) });
    }
  });
  for (const c of tl.callouts ?? []) if (!c.redundant) add(c.t0, 'tick');

  // 1) separación mínima: se queda el de más prioridad. El teclado es el fondo de su escena, no un golpe: no compite.
  const beds = ev.filter((e) => e.cat === 'typing');
  const kept = [];
  for (const e of ev.filter((x) => x.cat !== 'typing').sort((a, b) => PRIORITY[b.cat] - PRIORITY[a.cat] || a.t - b.t)) {
    if (kept.every((k) => Math.abs(k.t - e.t) >= cfg.gap)) kept.push(e);
  }
  kept.sort((a, b) => a.t - b.t);
  // 2) tope por minuto (ventana deslizante): se descartan primero los de menos prioridad
  for (let i = 0; i < kept.length; i++) {
    const win = kept.filter((k) => k.t >= kept[i].t && k.t < kept[i].t + 60);
    while (win.length > cfg.perMin) {
      const worst = win.reduce((a, b) => (PRIORITY[b.cat] < PRIORITY[a.cat] ? b : a));
      win.splice(win.indexOf(worst), 1);
      kept.splice(kept.indexOf(worst), 1);
    }
  }
  // 3) sobre la voz, 4 dB más bajos (la voz manda)
  const all = [...kept, ...beds].sort((a, b) => a.t - b.t);
  for (const e of all) e.overSpeech = tl.words.some((w) => e.t >= w.t0 && e.t < w.t1);
  return all;
}

/** Tramos con voz (para el ducking de la música). */
function speechSpans(tl) {
  const spans = [];
  for (const seg of tl.segments) {
    if (!seg.words.length) continue;
    const a = seg.words[0].t0, b = seg.words[seg.words.length - 1].t1;
    const last = spans[spans.length - 1];
    if (last && a - last[1] < 0.8) last[1] = b; else spans.push([a, b]);
  }
  return spans;
}

/** Normaliza cada sonido a un RMS objetivo para que los deslizadores signifiquen lo mismo con cualquier archivo. */
function normGain(buf, targetDb) {
  const d = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(d.length / 200000));
  let sum = 0, n = 0, peak = 0;
  for (let i = 0; i < d.length; i += step) { const v = Math.abs(d[i]); sum += v * v; n++; if (v > peak) peak = v; }
  const rms = Math.sqrt(sum / Math.max(1, n)) || 1e-4;
  let g = db(targetDb) / rms;
  g = Math.min(g, 0.95 / Math.max(peak, 1e-4)); // sin recortar picos
  return Math.max(0.05, Math.min(g, 8));
}

export class Mixer {
  constructor() {
    this.ctx = new AudioContext();
    this.mix = { ...DEFAULT_MIX };
    this.voice = [];          // AudioBuffer por segmento (o null)
    this.voiceOn = true;
    this.sfx = {};            // cat → [{ buf, gain }]
    this.music = null;        // { buf, gain }
    this.sources = [];
    this.t0 = 0;
    this.running = false;
    this.nodes = this.graph(this.ctx, this.ctx.destination);
    this.recDest = this.ctx.createMediaStreamDestination();
    this.nodes.limiter.connect(this.recDest);
  }

  /** master → limitador → (altavoces · grabación). Buses: voz, efectos, música (+ducking). */
  graph(ctx, out) {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3; limiter.knee.value = 2; limiter.ratio.value = 20;
    limiter.attack.value = 0.003; limiter.release.value = 0.25;
    const speaker = ctx.createGain();
    limiter.connect(speaker); speaker.connect(out);
    const voice = ctx.createGain(); voice.connect(limiter);
    const sfx = ctx.createGain(); sfx.connect(limiter);
    const music = ctx.createGain(); const duck = ctx.createGain();
    music.connect(duck); duck.connect(limiter);
    const mic = ctx.createGain(); // solo a la grabación, nunca a los altavoces (evita acoples)
    return { limiter, speaker, voice, sfx, music, duck, mic };
  }

  async decode(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`No se pudo cargar ${url}`);
    return this.ctx.decodeAudioData(await res.arrayBuffer());
  }

  /** Carga la voz IA y la normaliza: RMS de las partes habladas ≈ -17 dBFS → mezcla final ≈ -15 LUFS
   *  (lo del canal de referencia; YouTube baja lo que pasa de -14 LUFS pero no sube lo que queda por debajo). */
  async loadVoice(urls) {
    this.voice = await Promise.all(urls.map((u) => (u ? this.decode(u) : null)));
    let sum = 0, n = 0;
    for (const b of this.voice) {
      if (!b) continue;
      const d = b.getChannelData(0);
      const win = Math.floor(b.sampleRate * 0.05);
      for (let i = 0; i + win <= d.length; i += win) {
        let e = 0;
        for (let j = i; j < i + win; j += 4) e += d[j] * d[j];
        e /= win / 4;
        if (e > 1e-5) { sum += e; n++; } // solo ventanas con voz (descarta silencios)
      }
    }
    const rms = n ? Math.sqrt(sum / n) : 0;
    this.voiceGain = rms ? Math.max(0.25, Math.min(4, db(-17) / rms)) : 1;
    // nivel de voz (dB) de cada audio, medido en las partes habladas
    this.voiceSpeechDb = this.voice.map((b) => {
      if (!b) return null;
      const d = b.getChannelData(0), win = Math.floor(b.sampleRate * 0.05);
      let s2 = 0, c = 0;
      for (let k = 0; k + win <= d.length; k += win) {
        let e = 0;
        for (let j = k; j < k + win; j += 4) e += d[j] * d[j];
        e /= win / 4;
        if (e > 1e-5) { s2 += e; c++; }
      }
      return c ? 10 * Math.log10(s2 / c) : null;
    });
    return this.voice.map((b) => (b ? b.duration : null));
  }
  clearVoice() { this.voice = []; this.voiceWords = null; }
  /** Palabras alineadas (Whisper) de cada audio de voz: permiten limpiar lo que suena ENTRE palabras. */
  setVoiceWords(words) { this.voiceWords = words; }
  hasVoice() { return this.voiceOn && this.voice.some(Boolean); }

  /** kit: { cat: [url, ...] } */
  async loadKit(kit) {
    const out = {};
    for (const [cat, urls] of Object.entries(kit)) {
      if (cat === 'music') continue;
      out[cat] = (await Promise.all(urls.map(async (u) => { try { const buf = await this.decode(u); return { buf, gain: normGain(buf, -18) }; } catch { return null; } }))).filter(Boolean);
    }
    this.sfx = out;
    const m = kit.music?.[0];
    this.music = m ? await this.decode(m).then((buf) => ({ buf, gain: normGain(buf, -20) })).catch(() => null) : null;
  }

  setMix(m) { Object.assign(this.mix, m); }
  active() { return this.hasVoice() || (this.mix.sfx && Object.keys(this.sfx).length > 0) || (this.mix.music && !!this.music); }

  /** Programa todo desde el instante t de la línea de tiempo `tl`. */
  play(t, tl) {
    this.stop();
    this.ctx.resume();
    const now = this.ctx.currentTime + 0.06;
    this.t0 = now - t;
    this.running = true;
    this.sources = this.schedule(this.ctx, this.nodes, tl, t, now, { voice: true, sfx: true, music: true });
    this.nodes.speaker.gain.value = this.mix.monitor ? 1 : 0;
  }

  schedule(ctx, n, tl, t, now, parts) {
    const srcs = [];
    const at = (x) => now + Math.max(0, x - t);
    // voz
    if (parts.voice && this.voiceOn) {
      n.voice.gain.value = this.voiceGain ?? 1;
      this.voice.forEach((b, i) => {
        const s = tl.segments[i]?.start;
        if (!b || s == null || s + b.duration <= t) return;
        const src = ctx.createBufferSource(); src.buffer = b;
        const g = ctx.createGain();
        src.connect(g); g.connect(n.voice);
        const offset = Math.max(0, t - s);
        const when = at(s);
        src.start(when, offset); srcs.push(src);
        // limpieza de respiraciones entre FRASES, muy conservadora (nunca debe notarse):
        //  · solo en pausas tras puntuación (fin de frase o coma), nunca dentro de una frase
        //  · solo si lo que suena en la pausa está ≥24 dB por debajo de la voz (respiración/ruido, no voz)
        //  · bajada suave (-15 dB) con rampas lentas
        const words = this.voiceWords?.[i];
        if (this.mix.breathClean && words?.length > 3) {
          const low = db(this.mix.breathDb ?? -15);
          const data = b.getChannelData(0);
          const rate = b.sampleRate;
          const rmsDb = (x0, x1) => {
            const a0 = Math.max(0, Math.floor(x0 * rate)), a1 = Math.min(data.length, Math.floor(x1 * rate));
            let e = 0;
            for (let k = a0; k < a1; k += 2) e += data[k] * data[k];
            return 10 * Math.log10(e / Math.max(1, (a1 - a0) / 2) + 1e-12);
          };
          const speechDb = this.voiceSpeechDb?.[i] ?? -20;
          const tAt = (x) => when + (x - offset); // instante absoluto del segundo x del audio
          g.gain.setValueAtTime(1, Math.max(ctx.currentTime, when));
          for (let k = 1; k < words.length; k++) {
            if (!/[.,;:?!…]$/.test(words[k - 1].w.trim())) continue;
            const a = words[k - 1].e + 0.15, z = words[k].s - 0.1;   // márgenes amplios: colas y ataques intactos
            if (z - a < 0.2 || z - a > 2.5 || z <= offset) continue;
            if (rmsDb(a, z) > speechDb - 24) continue;                 // hay voz (o casi): no tocar
            const from = Math.max(a, offset);
            g.gain.setValueAtTime(1, tAt(from));
            g.gain.linearRampToValueAtTime(low, tAt(Math.min(z, from + 0.1)));
            g.gain.setValueAtTime(low, tAt(Math.max(from + 0.1, z - 0.1)));
            g.gain.linearRampToValueAtTime(1, tAt(z));
          }
        }
      });
    }
    // efectos
    if (parts.sfx && this.mix.sfx) {
      n.sfx.gain.value = db(this.mix.sfxDb);
      const off = new Set(this.mix.off ?? []);
      const avail = new Set(Object.keys(this.sfx).filter((k) => this.sfx[k].length && !off.has(k)));
      sfxEvents(tl, this.mix.density, avail).forEach((e, k) => {
        if (e.t < t - 0.02) return;
        const variants = this.sfx[e.cat];
        const v = variants[Math.floor(hash(k + e.t) * variants.length)] ?? variants[0];
        const src = ctx.createBufferSource(); src.buffer = v.buf;
        src.playbackRate.value = 1 + (hash(k * 3.7) - 0.5) * 2 * (PITCH_VAR[e.cat] ?? 0); // variación solo en sonidos cortos
        const g = ctx.createGain();
        g.gain.value = v.gain * db(TRIM_DB[e.cat] + (e.overSpeech ? -4 : 0) + (e.soft ? -5 : 0) + (hash(k) - 0.5) * 3);
        src.connect(g); g.connect(n.sfx);
        const when = at(e.t);
        if (e.dur) { g.gain.setValueAtTime(g.gain.value, when + e.dur - 0.15); g.gain.linearRampToValueAtTime(0, when + e.dur); src.start(when); src.stop(when + e.dur + 0.05); }
        else src.start(when);
        srcs.push(src);
      });
    }
    // música con ducking
    if (parts.music && this.mix.music && this.music) {
      const { buf, gain } = this.music;
      n.music.gain.value = gain;
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; src.connect(n.music);
      src.start(now, t % buf.duration); srcs.push(src);
      const low = db(this.mix.musicDb), high = db(this.mix.musicDb + this.mix.gapBoostDb);
      const p = n.duck.gain;
      p.cancelScheduledValues(0);
      const spans = speechSpans(tl);
      const inSpeech = spans.some(([a, b]) => t >= a && t < b);
      const fadeIn = t < 1.5 ? (t / 1.5) : 1;
      p.setValueAtTime((inSpeech ? low : high) * fadeIn, now);
      if (t < 1.5) p.linearRampToValueAtTime(inSpeech ? low : high, at(1.5));
      for (const [a, b] of spans) {
        if (b < t) continue;
        if (a > t) { p.setValueAtTime(high, at(a - 0.3)); p.linearRampToValueAtTime(low, at(a - 0.05)); }   // baja antes de la primera palabra
        p.setValueAtTime(low, at(b + 0.15)); p.linearRampToValueAtTime(high, at(b + 0.9));                    // sube suave en la pausa
      }
      const end = tl.duration;
      if (end > t) { p.setValueAtTime(high, at(Math.max(t, end - 3))); p.linearRampToValueAtTime(0.0001, at(end)); src.stop(at(end) + 0.1); }
    }
    return srcs;
  }

  time() { return this.ctx.currentTime - this.t0; }

  stop() {
    for (const s of this.sources) { try { s.stop(); } catch {} }
    this.sources = [];
    this.running = false;
    this.nodes.duck.gain.cancelScheduledValues(0);
  }

  /** Durante la grabación de tu voz: el micro entra a la grabación (con efectos y música), no a los altavoces. */
  attachMic(stream) {
    this.micSrc = this.ctx.createMediaStreamSource(stream);
    this.micSrc.connect(this.nodes.mic);
    this.nodes.mic.connect(this.recDest);
  }
  detachMic() { try { this.micSrc?.disconnect(); this.nodes.mic.disconnect(); } catch {} this.micSrc = null; }

  /** Render offline a WAV: parts = { voice, sfx, music } (mezcla completa o pistas por separado). */
  async renderWav(tl, parts = { voice: true, sfx: true, music: true }) {
    const rate = 48000;
    const off = new OfflineAudioContext(2, Math.ceil((tl.duration + 0.5) * rate), rate);
    const n = this.graph(off, off.destination);
    this.schedule(off, n, tl, 0, 0, parts);
    return wav(await off.startRendering());
  }
}

function wav(buf) {
  const ch = buf.numberOfChannels, len = buf.length, rate = buf.sampleRate;
  const out = new ArrayBuffer(44 + len * ch * 2);
  const v = new DataView(out);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + len * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, len * ch * 2, true);
  const data = [...Array(ch)].map((_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { v.setInt16(o, Math.max(-1, Math.min(1, data[c][i])) * 0x7fff, true); o += 2; }
  return new Blob([out], { type: 'audio/wav' });
}

