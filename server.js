// Servidor local: sirve la app y usa Claude Code en modo headless (`claude -p`) como motor.
// Sin dependencias: node server.js  →  http://localhost:4321
import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, writeFile, readdir, mkdir, stat, rename } from 'node:fs/promises';
import { existsSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  systemPrompt, TOPICS_SCHEMA, VIDEO_SCHEMA, SEGMENT_SCHEMA, DENSIFY_SCHEMA, PUBLISH_SCHEMA, SHORTS_SCHEMA, WPM,
  topicsPrompt, scriptPrompt, refinePrompt, densifyPrompt, publishPrompt, shortsPrompt,
} from './lib/prompts.js';
import { studyChannel, listReferences, ANALYZE_SCHEMA, analyzePrompt } from './lib/study.js';
import { findOverlaps, fixPrompt, applyFixes, FIX_SCHEMA } from './lib/originality.js';
import { detectRedundancy, coherencePrompt, COHERENCE_SCHEMA } from './lib/coherence.js';
import * as tts from './lib/tts/index.js';
import * as sound from './lib/sound.js';
import { readLexicon, saveLexicon, DEFAULT_LEXICON } from './lib/tts/lexicon.js';
import * as aligner from './lib/align/index.js';
import * as exporter from './lib/export.js';
import * as audiofix from './lib/audiofix.js';
import { createReadStream } from 'node:fs';
import { CLAUDE_BIN, runClaude as runClaudeBase, claudeStep as claudeStepBase, sendJSON, readRaw, readBody, sse } from './lib/claude.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PROJECTS = process.env.PROJECTS_DIR || path.join(ROOT, 'projects');
const WORK = path.join(ROOT, '.work');
const STYLE = path.join(ROOT, 'style');
const PORT = Number(process.env.PORT || 4321);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.webm': 'audio/webm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

await mkdir(PROJECTS, { recursive: true });
await mkdir(WORK, { recursive: true });

// ---------- Claude Code (lib/claude.js) con el prompt de sistema del canal ----------

const runClaude = (opts, emit) => runClaudeBase({ cwd: WORK, ...opts, system: opts.system ?? systemPrompt({ variant: opts.variant }) }, emit);
const claudeStep = (opts, emit, track) => claudeStepBase(opts, emit, track, runClaude);

/** Editor de coherencia: quita explicaciones repetidas y une los segmentos en un hilo. Aplica los cambios a `video`. */
async function coherenceStep(video, body, emit, track) {
  const issues = detectRedundancy(video);
  emit({ type: 'log', text: issues.length ? `🧭 Editor de coherencia · pistas: ${issues.map((x) => x.detail).slice(0, 4).join(' · ')}` : '🧭 Editor de coherencia: revisando que cada idea se explique una vez' });
  const ev = await claudeStep({
    prompt: coherencePrompt(video, issues, { targetWords: body.targetWords }),
    schema: COHERENCE_SCHEMA,
    model: body.editorModel || (body.targetWords ? 'opus' : 'sonnet'),
    effort: body.targetWords ? 'high' : 'medium',
    variant: body.variant,
    tools: [],
  }, emit, track);
  const { map = [], changes = [], segments = [] } = ev.data ?? {};
  for (const sg of segments) if (video.segments[sg.index] && sg.narration?.trim()) video.segments[sg.index].narration = sg.narration;
  for (const m of map) if (video.segments[m.index]) video.segments[m.index].plan = { question: m.question, adds: m.adds, introduces: m.introduces };
  for (const c of changes) emit({ type: 'log', text: `✂️  Segmento ${c.index + 1}: ${c.what}` });
  emit({ type: 'log', text: changes.length ? `✅ Coherencia: ${segments.length} segmentos editados` : '✅ Coherencia: no hacía falta tocar nada' });
  return { ev, changed: segments.map((x) => x.index), changes, issuesBefore: issues.length, issuesAfter: detectRedundancy(video).length };
}

/** Control de originalidad (frases demasiado parecidas a las referencias). Aplica los cambios a `video`. */
async function originalityStep(video, body, emit, track) {
  const overlaps = findOverlaps(video);
  if (!overlaps.length) { emit({ type: 'log', text: '✅ Originalidad: ninguna frase copiada de las referencias' }); return null; }
  emit({ type: 'log', text: `🧹 ${overlaps.length} frases demasiado parecidas a las referencias → reescribiendo con palabras propias` });
  try {
    const ev = await claudeStep({ prompt: fixPrompt(overlaps), schema: FIX_SCHEMA, model: 'sonnet', effort: 'low', variant: body.variant, tools: [] }, emit, track);
    const n = applyFixes(video, overlaps, ev.data?.fixes);
    const left = findOverlaps(video).length;
    emit({ type: 'log', text: `✅ Reescritas ${n} frases${left ? ` (quedan ${left} con coincidencias menores)` : ''}` });
    return ev;
  } catch (e) {
    emit({ type: 'log', text: `⚠️ No se pudo reescribir (${e.message.slice(0, 120)}); se entrega tal cual` });
    return null;
  }
}

/**
 * Guion: 1) Claude Code investiga y escribe; 2) editor de coherencia (una idea, una vez; hilo entre segmentos);
 * 3) control de originalidad frente a las referencias.
 */
function scriptJob(body, emit) {
  let cancel = () => {};
  const track = (c) => { cancel = c; };
  (async () => {
    const started = Date.now();
    try {
      const first = await claudeStep({
        prompt: scriptPrompt(body),
        schema: VIDEO_SCHEMA,
        model: body.model || 'opus',
        effort: body.effort || 'high',
        variant: body.variant,
        cwd: STYLE,
        tools: ['WebSearch', 'WebFetch', 'Read', 'Glob'],
      }, emit, track);
      const video = first.data;
      let cost = first.cost ?? 0;
      try { const c = await coherenceStep(video, body, emit, track); cost += c.ev.cost ?? 0; }
      catch (e) { emit({ type: 'log', text: `⚠️ El editor de coherencia falló (${e.message.slice(0, 100)}); sigo con el guion tal cual` }); }
      const o = await originalityStep(video, body, emit, track);
      cost += o?.cost ?? 0;
      emit({ type: 'result', data: video, cost, secs: Math.round((Date.now() - started) / 1000) });
    } catch (e) {
      emit({ type: 'error', message: e.message });
    } finally {
      emit({ type: 'end' });
    }
  })();
  return () => cancel();
}

/** Revisar coherencia de un guion ya hecho (botón del Estudio). */
function coherenceJob(body, emit) {
  let cancel = () => {};
  const track = (c) => { cancel = c; };
  (async () => {
    const started = Date.now();
    try {
      const video = JSON.parse(JSON.stringify(body.video));
      const c = await coherenceStep(video, body, emit, track);
      let cost = c.ev.cost ?? 0;
      if (c.changed.length) { const o = await originalityStep(video, body, emit, track); cost += o?.cost ?? 0; }
      emit({ type: 'result', data: { segments: video.segments.map((s, i) => ({ index: i, narration: s.narration, plan: s.plan })), changed: c.changed, changes: c.changes, issuesBefore: c.issuesBefore, issuesAfter: c.issuesAfter }, cost, secs: Math.round((Date.now() - started) / 1000) });
    } catch (e) {
      emit({ type: 'error', message: e.message });
    } finally {
      emit({ type: 'end' });
    }
  })();
  return () => cancel();
}

/**
 * Voz IA: (opcional) Claude Code adapta cifras/siglas para el TTS → el proveedor (Fish Audio / ElevenLabs) sintetiza cada segmento.
 * body: { provider, projectId, voiceId, settings, adapt, variant, segments: [{ index, text, spoken? }] }
 */
function voiceJob(body, emit) {
  const ctrl = new AbortController();
  let cancelClaude = () => {};
  let finished = false;
  const finish = (ev) => { if (!finished) { finished = true; emit(ev); emit({ type: 'end' }); } };
  const started = Date.now();

  const synth = async (segments, cost = 0) => {
    try {
      const out = await tts.synthesize({ ...body, segments }, (text) => emit({ type: 'log', text }), ctrl.signal);
      const bySpoken = new Map(segments.map((s) => [s.index, s.spoken]));
      finish({ type: 'result', data: { segments: out.map((o) => ({ ...o, spoken: bySpoken.get(o.index) })) }, cost, secs: Math.round((Date.now() - started) / 1000) });
    } catch (e) {
      finish({ type: 'error', message: e.message });
    }
  };

  const segs = body.segments ?? [];
  const pending = body.adapt ? segs.filter((s) => !s.spoken) : [];
  if (!pending.length) {
    synth(segs.map((s) => ({ index: s.index, spoken: s.spoken || s.text })));
  } else {
    emit({ type: 'log', text: `🔤 Adaptando cifras y siglas de ${pending.length} segmentos para la voz…` });
    cancelClaude = runClaude({
      prompt: tts.spokenPrompt(pending, body.variant),
      schema: tts.SPOKEN_SCHEMA,
      system: 'Preparas textos para síntesis de voz en español. Solo cambias cómo se escriben cifras, unidades, símbolos y siglas.',
      model: 'sonnet',
      effort: 'low',
      tools: [],
    }, (ev) => {
      if (ev.type === 'end') return;
      if (ev.type === 'error') { emit({ type: 'log', text: `⚠️ No se pudieron adaptar las cifras (${ev.message.slice(0, 100)}); uso el texto tal cual` }); return synth(segs.map((s) => ({ index: s.index, spoken: s.spoken || s.text }))); }
      if (ev.type === 'result') {
        const adapted = new Map((ev.data?.segments ?? []).map((s) => [s.index, s.spoken]));
        return synth(segs.map((s) => ({ index: s.index, spoken: s.spoken || adapted.get(s.index) || s.text })), ev.cost);
      }
      emit(ev);
    });
  }
  return () => { ctrl.abort(); cancelClaude(); };
}


const safeId = (id) => String(id).replace(/[^a-z0-9_-]/gi, '').slice(0, 80);

async function listProjects() {
  const files = (await readdir(PROJECTS)).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const p = JSON.parse(await readFile(path.join(PROJECTS, f), 'utf8'));
      const segs = p.video?.segments ?? [];
      const words = segs.reduce((n, sg) => n + String(sg.narration ?? '').split(/\s+/).filter(Boolean).length, 0);
      const voiced = p.voice?.segments?.length ?? 0;
      out.push({
        id: p.id, title: p.video?.title ?? p.topic?.title ?? f, updated: p.updated, thumbnail: p.video?.thumbnail,
        words, minutes: words / 180, segments: segs.length,
        voice: voiced ? { provider: p.voice.provider, title: p.voice.voiceTitle, done: voiced, total: segs.length } : null,
        published: !!p.publish, shorts: p.shorts?.clips?.length ?? (Array.isArray(p.shorts) ? p.shorts.length : 0),
      });
    } catch {}
  }
  return out.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
}

// ---------- Rutas ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === '/api/health') {
      execFile(CLAUDE_BIN, ['--version'], (err, stdout) => {
        sendJSON(res, 200, { ok: !err, claude: err ? null : stdout.trim() });
      });
      return;
    }

    if (p === '/api/topics' && req.method === 'POST') {
      const body = await readBody(req);
      const avoid = (await listProjects()).map((x) => x.title).slice(0, 30);
      return sse(res, (emit) => runClaude({
        prompt: topicsPrompt({ ...body, avoid }),
        schema: TOPICS_SCHEMA,
        variant: body.variant,
        model: body.model || 'sonnet',
        effort: body.effort || 'medium',
      }, emit));
    }

    if (p === '/api/script' && req.method === 'POST') {
      const body = await readBody(req);
      return sse(res, (emit) => scriptJob(body, emit));
    }

    // Editor de coherencia para un guion ya hecho
    if (p === '/api/coherence' && req.method === 'POST') {
      const body = await readBody(req);
      return sse(res, (emit) => coherenceJob(body, emit));
    }

    // Publicación: títulos que hablan con la miniatura, descripción, capítulos, etiquetas
    if (p === '/api/publish' && req.method === 'POST') {
      const body = await readBody(req);
      return sse(res, (emit) => runClaude({
        prompt: publishPrompt(body),
        schema: PUBLISH_SCHEMA,
        model: body.model || 'sonnet',
        effort: 'medium',
        variant: body.variant,
        tools: [],
      }, emit));
    }

    // Shorts: Claude Code elige los mejores momentos (rangos de frases con tiempos reales)
    if (p === '/api/shorts' && req.method === 'POST') {
      const body = await readBody(req);
      return sse(res, (emit) => runClaude({
        prompt: shortsPrompt(body),
        schema: SHORTS_SCHEMA,
        model: body.model || 'sonnet',
        effort: 'medium',
        variant: body.variant,
        tools: [],
      }, emit));
    }

    // "Más animación": redistribuye escenas de un guion hecho, sin tocar la narración
    if (p === '/api/densify' && req.method === 'POST') {
      const body = await readBody(req);
      return sse(res, (emit) => runClaude({
        prompt: densifyPrompt(body.video, body.indices, { instruction: String(body.instruction ?? '').slice(0, 600), durations: body.durations }),
        schema: DENSIFY_SCHEMA,
        model: body.model || 'sonnet',
        effort: 'medium',
        variant: body.variant,
        tools: [],
      }, emit));
    }

    if (p === '/api/refine' && req.method === 'POST') {
      const body = await readBody(req);
      return sse(res, (emit) => runClaude({
        prompt: refinePrompt(body),
        schema: SEGMENT_SCHEMA,
        variant: body.variant,
        model: body.model || 'sonnet',
        effort: 'medium',
      }, emit));
    }

    if (p === '/api/style' && req.method === 'GET') {
      const estilo = await readFile(path.join(STYLE, 'estilo.md'), 'utf8').catch(() => '');
      return sendJSON(res, 200, { estilo, referencias: await listReferences(), wpm: WPM });
    }

    // Descarga transcripciones de un canal/vídeos (yt-dlp) a style/referencias/
    if (p === '/api/study' && req.method === 'POST') {
      const body = await readBody(req);
      return sse(res, (emit) => studyChannel(body, emit));
    }

    // Claude Code relee todas las referencias y reescribe style/estilo.md
    if (p === '/api/style/analyze' && req.method === 'POST') {
      const body = await readBody(req);
      return sse(res, (emit) => runClaude({
        prompt: analyzePrompt(),
        schema: ANALYZE_SCHEMA,
        system: 'Eres un analista de guiones de YouTube. Estudias transcripciones y destilas el oficio del creador en una guía práctica para otro guionista.',
        model: body.model || 'opus',
        effort: 'high',
        cwd: STYLE,
        tools: ['Read', 'Glob'],
      }, (ev) => {
        // síncrono a propósito: el evento 'end' llega justo después y cierra la respuesta
        if (ev.type === 'result' && ev.data?.markdown) {
          const file = path.join(STYLE, 'estilo.md');
          if (existsSync(file)) copyFileSync(file, path.join(STYLE, 'estilo.anterior.md'));
          writeFileSync(file, ev.data.markdown);
        }
        emit(ev);
      }));
    }

    // ---- Voz IA (Fish Audio / ElevenLabs) ----
    if (p === '/api/tts/status') return sendJSON(res, 200, tts.statusAll());
    // alineación palabra a palabra del audio de voz (Whisper local)
    if (p === '/api/align/status') return sendJSON(res, 200, await aligner.status());
    if (p === '/api/align' && req.method === 'POST') {
      const body = await readBody(req);
      return sse(res, (emit) => {
        const ctrl = new AbortController();
        const started = Date.now();
        const items = (body.segments ?? []).map((sg) => {
          const rel = decodeURIComponent(String(sg.url ?? '').replace(/^\/audio\//, ''));
          const file = path.normalize(path.join(tts.AUDIO_DIR, rel));
          return file.startsWith(tts.AUDIO_DIR) && existsSync(file) ? { index: sg.index, file, prompt: sg.spoken ?? '' } : null;
        }).filter(Boolean);
        // forzar: se descarta la alineación guardada (p. ej. Whisper lo oyó mal) y se vuelve a escuchar
        if (body.force) for (const it of items) rmSync(`${it.file}.words.json`, { force: true });
        aligner.align(items, (text) => emit({ type: 'log', text }), ctrl.signal)
          .then((data) => emit({ type: 'result', data: { segments: data }, secs: Math.round((Date.now() - started) / 1000) }))
          .catch((e) => emit({ type: 'error', message: e.message }))
          .finally(() => emit({ type: 'end' }));
        return () => ctrl.abort();
      });
    }
    // aberraciones del audio de un segmento: detectar (Whisper + análisis de la señal) y corregir sobre una copia
    if ((p === '/api/audio/check' || p === '/api/audio/fix') && req.method === 'POST') {
      const body = await readBody(req);
      return sse(res, (emit) => {
        const ctrl = new AbortController();
        const log = (text) => emit({ type: 'log', text });
        const job = p.endsWith('check') ? audiofix.check(body, log) : audiofix.fix(body, log, ctrl.signal);
        job.then((data) => emit({ type: 'result', data }))
          .catch((e) => emit({ type: 'error', message: e.message }))
          .finally(() => emit({ type: 'end' }));
        return () => ctrl.abort();
      });
    }
    if (p === '/api/tts/lexicon' && req.method === 'GET') return sendJSON(res, 200, { items: await readLexicon(), defaults: DEFAULT_LEXICON });
    if (p === '/api/tts/lexicon' && req.method === 'POST') return sendJSON(res, 200, { items: await saveLexicon((await readBody(req)).items) });
    let m;
    if ((m = p.match(/^\/api\/tts\/(fish|elevenlabs)\/(key|voices|models)$/))) {
      const prov = tts.provider(m[1]);
      try {
        if (m[2] === 'key' && req.method === 'POST') { await prov.setKey(String((await readBody(req)).key || '').trim()); return sendJSON(res, 200, tts.statusAll()); }
        if (m[2] === 'voices') {
          const sp = url.searchParams;
          return sendJSON(res, 200, await prov.listVoices({
            q: sp.get('q') || '', scope: sp.get('scope') || 'mine', pageNumber: Math.max(1, Number(sp.get('page')) || 1), sort: sp.get('sort') || 'score',
          }));
        }
        if (m[2] === 'models') return sendJSON(res, 200, { items: await prov.models() });
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (p === '/api/tts/preview' && req.method === 'POST') {
      try { return sendJSON(res, 200, await tts.preview(await readBody(req))); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (p === '/api/tts/generate' && req.method === 'POST') {
      const body = await readBody(req);
      return sse(res, (emit) => voiceJob(body, emit));
    }
    // ---- Sonido: efectos y música (Freesound / archivos propios) ----
    if (p.startsWith('/api/sound/')) {
      const sp = url.searchParams;
      try {
        if (p === '/api/sound/status') return sendJSON(res, 200, sound.status());
        if (p === '/api/sound/key' && req.method === 'POST') { await sound.setKey(String((await readBody(req)).key || '').trim()); return sendJSON(res, 200, sound.status()); }
        if (p === '/api/sound/library') return sendJSON(res, 200, await sound.library());
        if (p === '/api/sound/credits') return sendJSON(res, 200, await sound.credits(sp.has('cats') ? sp.get('cats').split(',').filter(Boolean) : null));
        if (p === '/api/sound/search') {
          return sendJSON(res, 200, await sound.search({ q: sp.get('q') || '', category: sp.get('category'), licenses: sp.get('licenses') || 'cc0', page: Number(sp.get('page') || 1), sort: sp.get('sort') || 'rating_desc' }));
        }
        if (p === '/api/sound/add' && req.method === 'POST') return sendJSON(res, 200, await sound.addFromFreesound(await readBody(req)));
        if (p === '/api/sound/remove' && req.method === 'POST') return sendJSON(res, 200, await sound.removeSound((await readBody(req)).key));
        if (p === '/api/sound/upload' && req.method === 'POST') {
          return sendJSON(res, 200, await sound.addUpload({ category: sp.get('category'), filename: sp.get('filename'), license: sp.get('license') || 'propia', author: sp.get('author') || '', data: await readRaw(req) }));
        }
        // kit automático: el mejor sonido CC0 de cada hueco (o los que falten)
        if (p === '/api/sound/autokit' && req.method === 'POST') {
          const body = await readBody(req);
          const lib = await sound.library();
          const done = [];
          for (const cat of Object.keys(sound.CATEGORIES)) {
            if (!body.replace && lib.kit[cat]?.length) continue;
            const found = await sound.search({ category: cat, licenses: body.licenses || 'cc0', sort: cat === 'music' ? 'downloads_desc' : 'rating_desc' });
            const pick = found.items.find((x) => (x.downloads ?? 0) > 50) ?? found.items[0];
            if (pick) { await sound.addFromFreesound({ id: pick.id, category: cat }); done.push(cat); }
          }
          return sendJSON(res, 200, { added: done, ...(await sound.library()) });
        }
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    // ---- Exportación de vídeo (WebCodecs en el navegador + ffmpeg aquí) ----
    let ex;
    if (p === '/api/export/start' && req.method === 'POST') return sendJSON(res, 200, await exporter.start());
    if ((ex = p.match(/^\/api\/export\/([a-z0-9]+)\/(video|audio|finish|cancel)$/)) && req.method === 'POST') {
      try {
        if (ex[2] === 'finish') return sendJSON(res, 200, await exporter.finish(ex[1], await readBody(req)));
        if (ex[2] === 'cancel') { await exporter.cancel(ex[1]); return sendJSON(res, 200, { ok: true }); }
        return sendJSON(res, 200, await exporter.append(ex[1], ex[2], req));
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (p.startsWith('/exports/')) {
      const name = path.basename(decodeURIComponent(p.slice('/exports/'.length)));
      const file = path.join(exporter.OUT_DIR, name);
      if (!existsSync(file)) return sendJSON(res, 404, { error: 'not found' });
      const st = await stat(file);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${name}"` });
      return createReadStream(file).pipe(res);
    }

    if (p.startsWith('/sounds/')) {
      try {
        const rel = decodeURIComponent(p.slice('/sounds/'.length));
        const buf = await sound.readSound(rel);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream', 'Cache-Control': 'max-age=31536000, immutable' });
        return res.end(buf);
      } catch { return sendJSON(res, 404, { error: 'not found' }); }
    }

    if (p.startsWith('/audio/')) {
      try {
        const buf = await tts.readAudio(decodeURIComponent(p.slice('/audio/'.length)));
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'max-age=31536000, immutable' });
        return res.end(buf);
      } catch { return sendJSON(res, 404, { error: 'not found' }); }
    }

    if (p === '/api/projects' && req.method === 'GET') return sendJSON(res, 200, await listProjects());

    if (p === '/api/projects' && req.method === 'POST') {
      const project = await readBody(req);
      project.id = safeId(project.id || Date.now().toString(36));
      const file = path.join(PROJECTS, `${project.id}.json`);
      // otra pestaña (o una versión antigua) no puede pisar cambios más nuevos: el cliente envía la versión que conoce
      if (!url.searchParams.get('force') && project.updated && existsSync(file)) {
        try {
          const disk = JSON.parse(await readFile(file, 'utf8'));
          if (disk.updated && disk.updated !== project.updated) return sendJSON(res, 409, { error: 'conflict', updated: disk.updated });
        } catch {}
      }
      project.updated = Date.now();
      await writeFile(file, JSON.stringify(project, null, 2));
      return sendJSON(res, 200, { id: project.id, updated: project.updated });
    }

    // borrar = mover a projects/.papelera (recuperable a mano)
    if (p.startsWith('/api/projects/') && req.method === 'DELETE') {
      const id = safeId(decodeURIComponent(p.split('/').pop()));
      const file = path.join(PROJECTS, `${id}.json`);
      if (!existsSync(file)) return sendJSON(res, 404, { error: 'No existe' });
      const bin = path.join(PROJECTS, '.papelera');
      await mkdir(bin, { recursive: true });
      await rename(file, path.join(bin, `${id}-${Date.now()}.json`));
      return sendJSON(res, 200, { ok: true });
    }

    if (p.startsWith('/api/projects/') && req.method === 'GET') {
      const file = path.join(PROJECTS, `${safeId(p.split('/').pop())}.json`);
      return sendJSON(res, 200, JSON.parse(await readFile(file, 'utf8')));
    }

    // Estáticos (la app en public/ y las imágenes de referencia en style/)
    const base = p.startsWith('/style/') && p.endsWith('.jpg') ? ROOT : PUBLIC;
    let file = path.normalize(path.join(base, p === '/' ? 'index.html' : decodeURIComponent(p)));
    if (!file.startsWith(base)) return sendJSON(res, 403, { error: 'forbidden' });
    const st = await stat(file).catch(() => null);
    if (!st || !st.isFile()) return sendJSON(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJSON(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  ▶ Estudio listo en http://localhost:${PORT}\n  Motor: Claude Code (${CLAUDE_BIN} -p)\n`);
});
