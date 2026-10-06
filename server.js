// Servidor local: sirve la app y usa Claude Code en modo headless (`claude -p`) como motor.
// Sin dependencias: node server.js  →  http://localhost:4321
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { existsSync, copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  systemPrompt, TOPICS_SCHEMA, VIDEO_SCHEMA, SEGMENT_SCHEMA, DENSIFY_SCHEMA, PUBLISH_SCHEMA, SHORTS_SCHEMA, WPM,
  topicsPrompt, scriptPrompt, refinePrompt, densifyPrompt, publishPrompt, shortsPrompt,
} from './lib/prompts.js';
import { studyChannel, listReferences, ANALYZE_SCHEMA, analyzePrompt } from './lib/study.js';
import { findOverlaps, fixPrompt, applyFixes, FIX_SCHEMA } from './lib/originality.js';
import * as tts from './lib/tts/index.js';
import * as sound from './lib/sound.js';
import { readLexicon, saveLexicon, DEFAULT_LEXICON } from './lib/tts/lexicon.js';
import * as aligner from './lib/align/index.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PROJECTS = process.env.PROJECTS_DIR || path.join(ROOT, 'projects');
const WORK = path.join(ROOT, '.work');
const STYLE = path.join(ROOT, 'style');
const PORT = Number(process.env.PORT || 4321);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.webm': 'audio/webm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

await mkdir(PROJECTS, { recursive: true });
await mkdir(WORK, { recursive: true });

// ---------- Claude Code runner ----------

function describeTool(name, input = {}) {
  if (name === 'WebSearch') return `🔎 Buscando: ${input.query ?? ''}`;
  if (name === 'WebFetch') return `📄 Leyendo: ${input.url ?? ''}`;
  if (name === 'StructuredOutput') return '✍️  Escribiendo resultado final…';
  if (name === 'Read') return `📚 Estudiando referencia: ${path.basename(input.file_path ?? '')}`;
  if (name === 'Glob' || name === 'Grep') return '📚 Revisando referencias…';
  return `🛠  ${name}`;
}

/**
 * Lanza `claude -p` y emite eventos {type:'log'|'text'|'result'|'error'} via `emit`.
 * Devuelve una función para cancelar el proceso.
 */
function runClaude({ prompt, schema, model, effort, variant, system, cwd = WORK, tools = ['WebSearch', 'WebFetch'] }, emit) {
  const args = [
    '-p',
    '--output-format', 'stream-json', '--verbose',
    '--json-schema', JSON.stringify(schema),
    '--system-prompt', system ?? systemPrompt({ variant }),
    '--no-session-persistence',
    '--tools', tools.join(','),
  ];
  if (tools.length) args.push('--allowedTools', ...tools);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);

  const child = spawn(CLAUDE_BIN, args, { cwd, env: process.env });
  child.stdin.end(prompt);

  let buf = '';
  let stderr = '';
  let done = false;
  const started = Date.now();

  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!raw) continue;
      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }
      handle(ev);
    }
  });
  child.stderr.on('data', (c) => { stderr += c; });

  function handle(ev) {
    if (ev.type === 'system' && ev.subtype === 'init') {
      emit({ type: 'log', text: `⚙️  Claude Code listo (${ev.model ?? model ?? 'modelo por defecto'})` });
    } else if (ev.type === 'assistant') {
      for (const block of ev.message?.content ?? []) {
        if (block.type === 'tool_use') emit({ type: 'log', text: describeTool(block.name, block.input) });
        else if (block.type === 'text' && block.text?.trim()) emit({ type: 'text', text: block.text.trim().slice(0, 400) });
      }
    } else if (ev.type === 'result') {
      done = true;
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      if (ev.is_error || !ev.structured_output) {
        let data = null;
        try { data = JSON.parse(ev.result); } catch {}
        if (data && !ev.is_error) emit({ type: 'result', data, cost: ev.total_cost_usd, secs });
        else emit({ type: 'error', message: ev.result || ev.subtype || 'Claude Code no devolvió resultado' });
      } else {
        emit({ type: 'result', data: ev.structured_output, cost: ev.total_cost_usd, secs });
      }
    }
  }

  child.on('error', (err) => {
    done = true;
    emit({ type: 'error', message: `No se pudo lanzar "${CLAUDE_BIN}": ${err.message}` });
  });
  child.on('close', (code) => {
    if (!done) emit({ type: 'error', message: `Claude Code terminó (código ${code}). ${stderr.slice(-600)}` });
    emit({ type: 'end' });
  });

  return () => { if (!child.killed) child.kill('SIGTERM'); };
}

/**
 * Guion en dos pasadas: 1) Claude Code investiga y escribe; 2) si hay frases demasiado parecidas
 * a las referencias (copia textual o frases-firma), una pasada rápida las reescribe con palabras propias.
 */
function scriptJob(body, emit) {
  let cancel = () => {};
  let finished = false;
  const finish = (ev) => { if (!finished) { finished = true; emit(ev); emit({ type: 'end' }); } };

  cancel = runClaude({
    prompt: scriptPrompt(body),
    schema: VIDEO_SCHEMA,
    model: body.model || 'opus',
    effort: body.effort || 'high',
    variant: body.variant,
    cwd: STYLE,
    tools: ['WebSearch', 'WebFetch', 'Read', 'Glob'],
  }, (ev) => {
    if (ev.type === 'end') return; // lo cierra finish()
    if (ev.type === 'error') return finish(ev);
    if (ev.type !== 'result') return emit(ev);

    const video = ev.data;
    const overlaps = findOverlaps(video);
    if (!overlaps.length) {
      emit({ type: 'log', text: '✅ Originalidad: ninguna frase copiada de las referencias' });
      return finish(ev);
    }
    emit({ type: 'log', text: `🧹 ${overlaps.length} frases demasiado parecidas a las referencias → reescribiendo con palabras propias` });
    cancel = runClaude({
      prompt: fixPrompt(overlaps),
      schema: FIX_SCHEMA,
      model: 'sonnet',
      effort: 'low',
      variant: body.variant,
      tools: [],
    }, (ev2) => {
      if (ev2.type === 'end') return;
      if (ev2.type === 'result') {
        const n = applyFixes(video, overlaps, ev2.data?.fixes);
        const left = findOverlaps(video).length;
        emit({ type: 'log', text: `✅ Reescritas ${n} frases${left ? ` (quedan ${left} con coincidencias menores)` : ''}` });
        return finish({ ...ev, cost: (ev.cost ?? 0) + (ev2.cost ?? 0), secs: Number(ev.secs) + Number(ev2.secs) });
      }
      if (ev2.type === 'error') {
        emit({ type: 'log', text: `⚠️ No se pudo reescribir (${ev2.message.slice(0, 120)}); se entrega el guion tal cual` });
        return finish(ev);
      }
      emit(ev2);
    });
  });
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

// ---------- HTTP helpers ----------

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': MIME['.json'] });
  res.end(JSON.stringify(data));
}

async function readRaw(req, limit = 80 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('Archivo demasiado grande (máx. 80 MB)'); chunks.push(c); }
  return Buffer.concat(chunks);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sse(res, job) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const emit = (ev) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); if (ev.type === 'end') res.end(); };
  const ping = setInterval(() => emit({ type: 'ping' }), 15000);
  const cancel = job(emit);
  res.on('close', () => { clearInterval(ping); cancel(); });
}

const safeId = (id) => String(id).replace(/[^a-z0-9_-]/gi, '').slice(0, 80);

async function listProjects() {
  const files = (await readdir(PROJECTS)).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const p = JSON.parse(await readFile(path.join(PROJECTS, f), 'utf8'));
      out.push({ id: p.id, title: p.video?.title ?? p.topic?.title ?? f, updated: p.updated, thumbnail: p.video?.thumbnail });
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
        prompt: densifyPrompt(body.video, body.indices),
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
        aligner.align(items, (text) => emit({ type: 'log', text }), ctrl.signal)
          .then((data) => emit({ type: 'result', data: { segments: data }, secs: Math.round((Date.now() - started) / 1000) }))
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
      project.updated = Date.now();
      await writeFile(path.join(PROJECTS, `${project.id}.json`), JSON.stringify(project, null, 2));
      return sendJSON(res, 200, { id: project.id, updated: project.updated });
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
