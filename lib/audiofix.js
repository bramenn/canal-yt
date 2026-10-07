// Aberraciones del audio de voz, por segmento: detectarlas y corregirlas.
//  · Texto (Whisper frente al guion): se salta partes, dice cosas que no están, pronunciación dudosa.
//  · Señal (lib/audiocheck.py): sonidos con tono entre palabras, respiraciones fuertes, clics, saturación,
//    saltos de volumen, pausas largas.
// Corregir nunca pisa el original: escribe un mp3 nuevo (…-fixN.mp3) y el cliente guarda el anterior para deshacer.
// Lo que se arregla con la señal (silenciar, atenuar, nivelar, acortar) no gasta créditos; lo que es de texto
// o saturación regenera SOLO el trozo afectado (≤380 caracteres) y lo empalma en una pausa.
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIO_DIR, provider, cleanForVoice, splitForTTS } from './tts/index.js';
import { readLexicon } from './tts/lexicon.js';
import { align } from './align/index.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PY = process.env.ALIGN_PYTHON || path.join(ROOT, '.tools', 'venv', 'bin', 'python');

/** /audio/<proyecto>/<archivo>.mp3 → ruta en disco (sin salirse de AUDIO_DIR). */
export function fileOfUrl(url) {
  const rel = decodeURIComponent(String(url).replace(/^\/audio\//, '').split('?')[0]);
  const full = path.normalize(path.join(AUDIO_DIR, rel));
  if (!full.startsWith(AUDIO_DIR + path.sep) || !full.endsWith('.mp3')) throw new Error('Audio no válido');
  if (!existsSync(full)) throw new Error('No encuentro ese audio');
  return full;
}

function runPy(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, [path.join(ROOT, 'lib', script)]);
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${script}: ${err.split('\n').filter(Boolean).slice(-2).join(' ')}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error(`${script}: respuesta no válida`)); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

// ---------- texto: lo que se oye frente a lo que debía decir ----------
const norm = (w) => String(w).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]/g, '');
const tokens = (s) => String(s).split(/\s+/).map((w) => ({ raw: w, n: norm(w) })).filter((t) => t.n);
// la palabra con tildes (para notar «Páremos» frente a «Paremos»)
const accentOf = (w) => String(w).toLowerCase().replace(/[^a-záéíóúüñ0-9]/g, '');

/** ¿Es la misma palabra? Tolera la ortografía del diccionario de pronunciación ("tóquen" ≈ "token") y errores de Whisper. */
function same(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4)))) return true;
  // distancia de edición relativa
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > Math.max(2, Math.min(m, n) * 0.5)) return false;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n] / Math.max(m, n) <= 0.34;
}

/** LCS entre el guion (tokens) y lo oído (palabras de Whisper): pares [iGuion, iOído]. */
function lcs(script, heard) {
  const m = script.length, n = heard.length;
  const L = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) {
    L[i][j] = same(script[i].n, heard[j].n) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (same(script[i].n, heard[j].n)) { pairs.push([i, j]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * Trozos en los que se generó la voz (los mismos que splitForTTS) con su tramo de tiempo en el audio,
 * deducido de las palabras alineadas.
 */
function chunksWithTimes(text, words, duration, lexicon = []) {
  const parts = splitForTTS(text);
  const script = [];
  parts.forEach((p, k) => tokens(p).forEach((t) => script.push({ ...t, chunk: k })));
  // lo oído pasa por el mismo conversor que el guion ("17%" → "diecisiete por ciento", "GPT" → "ge pe te")
  const heard = words.flatMap((w) => tokens(cleanForVoice(w.w, lexicon)).map((t) => ({ ...w, n: t.n, accent: accentOf(t.raw) })));
  const pairs = lcs(script, heard);
  const chunks = parts.map((p, k) => {
    const hs = pairs.filter(([i]) => script[i].chunk === k).map(([, j]) => heard[j]);
    return { k, text: p, t0: hs.length ? hs[0].s : null, t1: hs.length ? hs[hs.length - 1].e : null };
  });
  // trozos sin palabras reconocidas: entre sus vecinos
  chunks.forEach((c, k) => {
    if (c.t0 == null) c.t0 = k ? (chunks[k - 1].t1 ?? 0) : 0;
    if (c.t1 == null) c.t1 = chunks[k + 1]?.t0 ?? duration;
  });
  // límites de corte: a mitad de la pausa entre trozos (ahí se puede empalmar sin que se note)
  chunks.forEach((c, k) => {
    c.cut0 = k ? (chunks[k - 1].t1 + c.t0) / 2 : 0;
    c.cut1 = k < chunks.length - 1 ? (c.t1 + chunks[k + 1].t0) / 2 : duration;
  });
  return { chunks, script, heard, pairs };
}

function textIssues({ script, heard, pairs }, lexicon = []) {
  const lexWords = new Set(lexicon.flatMap((e) => [norm(e.from), ...String(e.from).split(/\s+/).map(norm)]).filter(Boolean));
  // palabras del guion que son reescrituras del diccionario («ráuter»): Whisper oirá la original
  const lexTo = new Set(lexicon.flatMap((e) => String(e.to).split(/\s+/).map(norm)).filter(Boolean));
  const issues = [];
  const matchedS = new Map(pairs.map(([i, j]) => [i, j]));
  const matchedH = new Set(pairs.map(([, j]) => j));
  // partes del guion que no se oyen
  for (let i = 0; i < script.length;) {
    if (matchedS.has(i)) { i++; continue; }
    let k = i;
    while (k < script.length && !matchedS.has(k)) k++;
    if (k - i >= 3) {
      const prevJ = [...pairs].reverse().find(([a]) => a < i)?.[1];
      const nextJ = pairs.find(([a]) => a >= k)?.[1];
      const t0 = prevJ != null ? heard[prevJ].e : 0;
      const t1 = nextJ != null ? heard[nextJ].s : (heard.at(-1)?.e ?? 0);
      const said = script.slice(i, k).map((t) => t.raw).join(' ').slice(0, 90);
      // en ese hueco se oye otra cosa corta: no se lo salta, lo dice distinto (sigla mal leída, palabra deformada)
      const instead = heard.filter((_, j) => j > (prevJ ?? -1) && j < (nextJ ?? heard.length) && !matchedH.has(j));
      if (k - i <= 4 && instead.length && instead.length <= 4) {
        const heardTxt = [...new Set(instead.map((w) => w.w))].join(' ');
        issues.push({ kind: 'doubt', t0: instead[0].s, t1: instead.at(-1).e, detail: `suena distinto: se oye «${heardTxt}» en vez de «${said}»`, chunk: script[i].chunk });
      } else {
        issues.push({ kind: 'skip', t0, t1, detail: `no se oye: «${said}»`, chunk: script[i].chunk });
      }
    }
    i = k;
  }
  // palabras oídas que no están en el guion (repeticiones, inventos, "dijo otra cosa")
  for (let j = 0; j < heard.length;) {
    if (matchedH.has(j)) { j++; continue; }
    let k = j;
    while (k < heard.length && !matchedH.has(k)) k++;
    if (k - j >= 3) {
      const before = pairs.filter(([, h]) => h < j).at(-1);
      const said = [...new Set(heard.slice(j, k).map((w) => w.w))].join(' ');
      // nombres técnicos (Q4_K_M, cifras…) los transcribe Whisper a su manera: avisar, pero no marcar por defecto
      const technical = /[\d_]/.test(said) || k - j < 5;
      issues.push({ kind: 'extra', t0: heard[j].s, t1: heard[k - 1].e, detail: `dice algo que no está en el guion: «${said.slice(0, 90)}»`, chunk: before ? script[before[0]].chunk : 0, ...(technical ? { auto: false } : {}) });
    }
    j = k;
  }
  // pronunciación dudosa (Whisper casi no la reconoce aunque esté en su sitio)
  for (const [i, j] of pairs) {
    const w = heard[j];
    const want = script[i].raw.replace(/[^\p{L}\p{N}]/gu, '');
    // se oye DISTINTO (otra letra o el acento en otra sílaba); «solo/sólo» no cuenta
    const differs = w.accent !== accentOf(script[i].raw) && !/^s[oó]lo$/.test(w.accent);
    // otra LETRA en una palabra corriente del guion («bibujo» por «dibujo»): fallo de la voz aunque Whisper esté seguro.
    // Nombres propios (mayúscula) y cifras quedan fuera: ahí Whisper escribe variantes aunque la voz lo diga bien.
    const letters = w.n !== script[i].n && /^[a-záéíóúüñ]{4,}$/.test(want);
    // Whisper escribe cifras («21») y términos ingleses («Router») aunque la voz los diga bien: no son fallos
    if (/\d/.test(w.w) || lexWords.has(norm(w.w)) || lexTo.has(script[i].n)) continue;
    if (differs && script[i].n.length >= 4 && (letters || (w.p != null && w.p < 0.35))) {
      issues.push({ kind: 'doubt', t0: w.s, t1: w.e, said: w.w.replace(/[^\p{L}\p{N}]/gu, ''), want, detail: `dice «${w.w.replace(/[^\p{L}\p{N}]/gu, '')}» en vez de «${want}»`, chunk: script[i].chunk });
    }
  }
  return issues;
}

// qué hacer con cada tipo y si se propone marcado por defecto
const PLAN = {
  skip: { fix: 'regen', auto: true, label: 'Se salta texto' },
  extra: { fix: 'regen', auto: true, label: 'Dice algo que no está' },
  doubt: { fix: 'regen', auto: false, label: 'Palabra mal dicha' },
  clip: { fix: 'regen', auto: true, label: 'Saturación' },
  noise: { fix: 'mute', auto: false, label: 'Sonido raro entre palabras' },
  breath: { fix: 'soften', auto: true, label: 'Respiración fuerte' },
  click: { fix: 'declick', auto: true, label: 'Clic' },
  level: { fix: 'level', auto: true, label: 'Salto de volumen' },
  pause: { fix: 'shorten', auto: true, label: 'Pausa larga' },
};

/**
 * Analiza el audio de un segmento. spoken = el texto que se envió a la voz (antes del diccionario).
 * Devuelve { duration, speechDb, chunks, issues: [{ id, kind, label, t0, t1, detail, fix, auto, chunk }] }.
 */
export async function check({ url, spoken, index = 0 }, onProgress) {
  const file = fileOfUrl(url);
  const lexicon = await readLexicon();
  const text = cleanForVoice(spoken, lexicon);
  onProgress?.('🎧 Escuchando el audio con Whisper…');
  const [al] = await align([{ index, file, prompt: text }], onProgress);
  const words = al.words ?? [];
  onProgress?.('🔎 Analizando la señal (clics, ruidos, volumen, pausas)…');
  let sig = await runPy('audiocheck.py', { file, words });
  let tx = chunksWithTimes(text, words, sig.duration, lexicon);
  // falta un trozo grande del guion: casi siempre es Whisper que lo oyó mal (alineación guardada) → se vuelve a escuchar, gratis
  if (al.cached && textIssues(tx, lexicon).some((i) => i.kind === 'skip' && i.t1 - i.t0 > 4)) {
    onProgress?.('🎧 Parece que Whisper lo oyó mal: vuelvo a escucharlo (gratis)…');
    await rm(`${file}.words.json`, { force: true });
    const [again] = await align([{ index, file, prompt: text }], onProgress);
    words.splice(0, words.length, ...(again.words ?? []));
    sig = await runPy('audiocheck.py', { file, words });
    tx = chunksWithTimes(text, words, sig.duration, lexicon);
    var realigned = words;
  }
  const chunkAt = (t) => tx.chunks.find((c) => t >= c.cut0 && t <= c.cut1)?.k ?? 0;
  const issues = [
    ...textIssues(tx, lexicon),
    ...sig.issues.map((i) => ({ ...i, chunk: chunkAt((i.t0 + i.t1) / 2) })),
  ]
    .sort((a, b) => a.t0 - b.t0)
    .map((i, n) => ({ id: n, ...PLAN[i.kind], ...i, t0: +Number(i.t0).toFixed(3), t1: +Number(i.t1).toFixed(3) }));
  return {
    duration: sig.duration, speechDb: sig.speech_db,
    ...(realigned ? { realigned } : {}),
    chunks: tx.chunks.map(({ k, text: t, cut0, cut1 }) => ({ k, chars: t.length, cut0: +cut0.toFixed(3), cut1: +cut1.toFixed(3), preview: t.slice(0, 80) })),
    issues,
  };
}

/**
 * Corrige: issues = los avisos elegidos (con su fix). voice = { provider, voiceId, settings } para regenerar trozos.
 * Devuelve { url } del mp3 corregido (el original no se toca).
 */
export async function fix({ url, spoken, index = 0, issues = [], voice }, onProgress, signal) {
  const file = fileOfUrl(url);
  const lexicon = await readLexicon();
  const text = cleanForVoice(spoken, lexicon);
  const cache = `${file}.words.json`;
  const al = existsSync(cache) ? JSON.parse(await readFile(cache, 'utf8')) : (await align([{ index, file, prompt: text }]))[0];
  const words = al.words ?? [];
  const duration = al.duration ?? words.at(-1)?.e ?? 0;
  const { chunks } = chunksWithTimes(text, words, duration, lexicon);

  const edits = [];
  const regen = new Set();
  for (const i of issues) {
    const r = 0.02;
    if (i.fix === 'regen') regen.add(i.chunk ?? 0);
    else if (i.fix === 'mute') edits.push({ type: 'gain', t0: i.t0, t1: i.t1, gain: 0.02, ramp: r });
    else if (i.fix === 'soften') edits.push({ type: 'gain', t0: i.t0, t1: i.t1, gain: 0.25, ramp: 0.04 });
    else if (i.fix === 'declick') edits.push({ type: 'gain', t0: i.t0 - 0.006, t1: i.t1 + 0.006, gain: 0.08, ramp: 0.004 });
    else if (i.fix === 'level') edits.push({ type: 'gain', t0: i.t0, t1: i.t1, gain: Math.pow(10, -Number(i.db || 0) / 20), ramp: 0.08 });
    else if (i.fix === 'shorten') {
      const gap = i.t1 - i.t0;
      const keep = i.t0 === 0 ? 0.35 : i.t1 >= duration - 0.01 ? 0.6 : 0.7;
      if (gap > keep + 0.1) {
        if (i.t0 === 0) edits.push({ type: 'cut', t0: 0, t1: i.t1 - keep });
        else if (i.t1 >= duration - 0.01) edits.push({ type: 'cut', t0: i.t0 + keep, t1: duration });
        else edits.push({ type: 'cut', t0: i.t0 + keep / 2, t1: i.t1 - keep / 2 });
      }
    }
  }

  // trozos a regenerar: se sustituye su tramo (de pausa a pausa) por audio nuevo
  const tmp = `${file}.fixparts`;
  await mkdir(tmp, { recursive: true });
  try {
    if (regen.size) {
      if (!voice?.voiceId) throw new Error('Para regenerar trozos hace falta la voz del proyecto');
      const p = provider(voice.provider);
      const s = p.normalize(voice.settings);
      for (const k of [...regen].sort((a, b) => a - b)) {
        if (signal?.aborted) throw new Error('Cancelado');
        const c = chunks[k];
        if (!c) continue;
        onProgress?.(`🎙️  Regenerando el trozo ${k + 1}/${chunks.length} (${c.text.length} caracteres)…`);
        const out = path.join(tmp, `chunk-${k}.mp3`);
        await writeFile(out, await p.tts({ text: c.text, voiceId: voice.voiceId, settings: s, prevText: chunks[k - 1]?.text, nextText: chunks[k + 1]?.text }, signal));
        edits.push({ type: 'replace', t0: c.cut0, t1: c.cut1, file: out, padStart: k ? 0.12 : 0, padEnd: k < chunks.length - 1 ? 0.12 : 0 });
      }
    }
    if (!edits.length) throw new Error('No hay nada que corregir con lo elegido');
    onProgress?.('🛠️  Aplicando las correcciones…');
    const n = (path.basename(file).match(/-fix(\d+)\.mp3$/)?.[1] ?? 0) * 1 + 1;
    const outFile = file.replace(/(-fix\d+)?\.mp3$/, `-fix${n}.mp3`);
    await runPy('audiofix.py', { file, out: outFile, edits });
    return { url: `/audio/${path.relative(AUDIO_DIR, outFile).split(path.sep).map(encodeURIComponent).join('/')}`, regenerated: regen.size, chars: [...regen].reduce((a, k) => a + (chunks[k]?.text.length ?? 0), 0) };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
