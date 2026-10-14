// Banda sonora de un short, generada en el navegador (Web Audio, sin archivos ni licencias): la voz original,
// un dron noir que sube de tensión hasta el clímax, el ambiente de cada viñeta (short.fx.sfx) y el golpe del clímax
// (short.fx.beat). Se renderiza una vez (OfflineAudioContext): la vista previa y el MP4 suenan igual.
const RATE = 44100;
const cache = new Map();

// ruido con semilla: el mismo short suena siempre igual
function noiseBuffer(ac, secs, seed = 7) {
  const b = ac.createBuffer(1, Math.ceil(secs * ac.sampleRate), ac.sampleRate);
  const d = b.getChannelData(0);
  let x = seed;
  for (let i = 0; i < d.length; i++) { x = (x * 1664525 + 1013904223) >>> 0; d[i] = x / 2 ** 31 - 1; }
  return b;
}
const noise = (ac, buf, t0, t1, dest) => { const s = ac.createBufferSource(); s.buffer = buf; s.loop = true; s.connect(dest); s.start(t0); s.stop(t1); return s; };
const filter = (ac, type, freq, q = 0.7) => { const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; return f; };
const chain = (...nodes) => { nodes.reduce((a, b) => (a.connect(b), b)); return nodes[0]; };
// ganancia con entrada y salida suaves en [t0, t1]
function envGain(ac, t0, t1, level, fade = 0.5) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(level, t0 + fade);
  g.gain.setValueAtTime(level, Math.max(t0 + fade, t1 - fade));
  g.gain.linearRampToValueAtTime(0, t1);
  return g;
}

// ---------- música: dron grave que crece hasta el clímax ----------
function music(ac, len, beat, out) {
  const g = ac.createGain();
  const peak = beat ?? len;
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(0.05, 1.5);
  g.gain.linearRampToValueAtTime(0.11, Math.max(2, peak - 0.2));
  if (beat != null) { g.gain.setValueAtTime(0.02, beat + 0.05); g.gain.linearRampToValueAtTime(0.06, beat + 3); }
  g.gain.setValueAtTime(g.gain.value, len - 1.2);
  g.gain.linearRampToValueAtTime(0, len + 0.3);
  const lp = filter(ac, 'lowpass', 260, 2);
  // el filtro «respira» despacio
  const lfo = ac.createOscillator(); lfo.frequency.value = 0.08;
  const lfoG = ac.createGain(); lfoG.gain.value = 90;
  lfo.connect(lfoG).connect(lp.frequency);
  lfo.start(0); lfo.stop(len + 0.5);
  chain(lp, g, out);
  for (const [f, type, det] of [[55, 'sawtooth', -6], [55, 'sawtooth', 7], [82.41, 'sawtooth', 0], [41.2, 'sine', 0]]) {
    const o = ac.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = det;
    o.connect(lp); o.start(0); o.stop(len + 0.5);
  }
  // un latido grave que se acelera en los 8 s antes del clímax
  if (beat != null) for (let t = Math.max(0.5, beat - 8); t < beat - 0.3;) { thump(ac, t, 0.35, out); t += 1.1 - 0.6 * ((t - (beat - 8)) / 8); }
}

function thump(ac, t, level, out) {
  const o = ac.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.18);
  const g = ac.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(level, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  o.connect(g).connect(out); o.start(t); o.stop(t + 0.25);
}

// ---------- golpe del clímax: «whoosh» que sube y golpe grave ----------
function impact(ac, beat, nb, out) {
  const rise = 1.1;
  const bp = filter(ac, 'bandpass', 300, 1.2);
  bp.frequency.setValueAtTime(300, beat - rise); bp.frequency.exponentialRampToValueAtTime(3500, beat);
  const g = ac.createGain(); g.gain.setValueAtTime(0, beat - rise); g.gain.linearRampToValueAtTime(0.22, beat - 0.02); g.gain.linearRampToValueAtTime(0, beat + 0.05);
  noise(ac, nb, beat - rise, beat + 0.1, bp); bp.connect(g).connect(out);
  const o = ac.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(95, beat); o.frequency.exponentialRampToValueAtTime(32, beat + 0.9);
  const og = ac.createGain(); og.gain.setValueAtTime(0.95, beat); og.gain.exponentialRampToValueAtTime(0.001, beat + 1.4);
  o.connect(og).connect(out); o.start(beat); o.stop(beat + 1.5);
  const lp = filter(ac, 'lowpass', 2200);
  const ng = ac.createGain(); ng.gain.setValueAtTime(0.5, beat); ng.gain.exponentialRampToValueAtTime(0.001, beat + 0.35);
  noise(ac, nb, beat, beat + 0.4, lp); lp.connect(ng).connect(out);
}

// ---------- ambientes ----------
function ambient(ac, kind, t0, t1, nb, out) {
  if (kind === 'lluvia') { const hp = filter(ac, 'highpass', 900); noise(ac, nb, t0, t1, hp); hp.connect(filter(ac, 'lowpass', 7000)).connect(envGain(ac, t0, t1, 0.07)).connect(out); return; }
  if (kind === 'viento') {
    const bp = filter(ac, 'bandpass', 420, 0.8);
    const lfo = ac.createOscillator(); lfo.frequency.value = 0.15; const lg = ac.createGain(); lg.gain.value = 220;
    lfo.connect(lg).connect(bp.frequency); lfo.start(t0); lfo.stop(t1);
    noise(ac, nb, t0, t1, bp); bp.connect(envGain(ac, t0, t1, 0.08)).connect(out); return;
  }
  if (kind === 'calle') { const lp = filter(ac, 'lowpass', 700); noise(ac, nb, t0, t1, lp); lp.connect(envGain(ac, t0, t1, 0.05)).connect(out); return; }
  if (kind === 'interior') { const lp = filter(ac, 'lowpass', 220); noise(ac, nb, t0, t1, lp); lp.connect(envGain(ac, t0, t1, 0.05)).connect(out); return; }
  if (kind === 'multitud') {
    const bp = filter(ac, 'bandpass', 1100, 1.1);
    const am = ac.createGain(); am.gain.value = 0.6;
    const lfo = ac.createOscillator(); lfo.frequency.value = 0.4; const lg = ac.createGain(); lg.gain.value = 0.35;
    lfo.connect(lg).connect(am.gain); lfo.start(t0); lfo.stop(t1);
    noise(ac, nb, t0, t1, bp); bp.connect(am).connect(envGain(ac, t0, t1, 0.05)).connect(out); return;
  }
  if (kind === 'sirena') {
    // sirena lejana: sube y baja, filtrada
    const o = ac.createOscillator(); o.type = 'triangle';
    const lfo = ac.createOscillator(); lfo.frequency.value = 0.45; const lg = ac.createGain(); lg.gain.value = 170;
    o.frequency.value = 760; lfo.connect(lg).connect(o.frequency);
    const lp = filter(ac, 'lowpass', 1500);
    o.connect(lp).connect(envGain(ac, t0, t1, 0.03, 1)).connect(out);
    o.start(t0); lfo.start(t0); o.stop(t1); lfo.stop(t1); return;
  }
  if (kind === 'latido') for (let t = t0 + 0.2; t < t1 - 0.3; t += 0.95) { thump(ac, t, 0.3, out); thump(ac, t + 0.24, 0.2, out); }
}

/** AudioBuffer con la mezcla completa del short (se guarda en caché mientras no cambien la voz ni los efectos). */
export async function soundtrack(short) {
  const key = JSON.stringify([short.audio, short.fx ?? null, short.panels?.map((p) => p.t)]);
  if (cache.has(key)) return cache.get(key);
  const job = (async () => {
    const voiceData = await (await fetch(short.audio)).arrayBuffer();
    const tmp = new OfflineAudioContext(1, RATE, RATE);
    const voice = await tmp.decodeAudioData(voiceData);
    const len = voice.duration + 0.3;
    const ac = new OfflineAudioContext(2, Math.ceil(len * RATE), RATE);
    // todo pasa por un compresor: nada satura
    const comp = ac.createDynamicsCompressor(); comp.threshold.value = -10; comp.ratio.value = 4;
    comp.connect(ac.destination);
    const v = ac.createBufferSource(); v.buffer = voice; v.connect(comp); v.start(0);
    const bed = ac.createGain(); bed.gain.value = 1; bed.connect(comp);
    const nb = noiseBuffer(ac, 4);
    const beat = short.fx?.beat ?? null;
    music(ac, len, beat, bed);
    if (beat != null) impact(ac, beat, nb, bed);
    // ambientes: tramos seguidos del mismo ambiente se unen (sin cortes entre viñetas)
    const panels = short.panels ?? [];
    let i = 0;
    while (i < panels.length) {
      const kind = short.fx?.sfx?.[i] ?? 'ninguno';
      let j = i;
      while (j + 1 < panels.length && (short.fx?.sfx?.[j + 1] ?? 'ninguno') === kind) j++;
      if (kind !== 'ninguno') ambient(ac, kind, panels[i].t, panels[j + 1]?.t ?? len, nb, bed);
      i = j + 1;
    }
    return ac.startRendering();
  })();
  cache.set(key, job);
  job.catch(() => cache.delete(key));
  return job;
}

/** WAV 16 bits de un AudioBuffer (para el exportador). */
export function wavOf(buf) {
  const ch = buf.numberOfChannels, n = buf.length, bytes = n * ch * 2;
  const dv = new DataView(new ArrayBuffer(44 + bytes));
  const str = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, buf.sampleRate, true);
  dv.setUint32(28, buf.sampleRate * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, bytes, true);
  const data = [...Array(ch)].map((_, c) => buf.getChannelData(c));
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < ch; c++, o += 2) dv.setInt16(o, Math.max(-1, Math.min(1, data[c][i])) * 0x7fff, true);
  return new Blob([dv], { type: 'audio/wav' });
}
