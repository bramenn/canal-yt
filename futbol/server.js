// Estudio de fútbol: biografías narradas sobre fotos. Reutiliza el motor del estudio principal
// (Claude Code, voz IA, alineación Whisper, exportación) con sus propios proyectos en futbol/projects/.
// node futbol/server.js  →  http://localhost:4322
import http from 'node:http';
import path from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runClaude, enginesStatus, setEngine, sendJSON, readRaw, readBody, sse } from '../lib/claude.js';
import { systemPrompt, scriptPrompt, VIDEO_SCHEMA, SEGMENT_SCHEMA, splitScript, importPrompt, importSystem, IMPORT_SCHEMA } from './lib/prompts.js';
import { mediaStore, braveStatus, setBraveKey, braveUsage } from './lib/media.js';
import * as clips from './lib/clips.js';
import { checkImages } from './lib/watermark.js';
import { autoClips } from './lib/autoclips.js';
import { makeThumbs } from './lib/thumbs.js';
import { pickPhotos } from './lib/photopick.js';
import { exportCapcut, capcutStatus } from './lib/capcut.js';
import { applyCreds, credsStatus, saveCreds, clearCred } from './lib/creds.js';
import { migrate, listProjects as dbProjects, getProject, saveProject, deleteProject, getSetting, setSetting } from '../lib/db.js';
import { countUsers } from '../lib/auth.js';
import { gate, serveFrom } from '../lib/web.js';
import { codexLogin } from '../lib/codex.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
// antes de cargar voz y exportación: sus carpetas cuelgan de PROJECTS_DIR
process.env.PROJECTS_DIR ||= path.join(HERE, 'projects');
const PROJECTS = process.env.PROJECTS_DIR;
const tts = await import('../lib/tts/index.js');
const aligner = await import('../lib/align/index.js');
const exporter = await import('../lib/export.js');
const media = mediaStore(path.join(PROJECTS, 'media'));
const PORT = Number(process.env.PORT || 4322);
const STATIC = { '/engine/': path.join(REPO, 'public/js/engine'), '/shared/': path.join(REPO, 'public/js'), '/': path.join(HERE, 'public') };
await mkdir(PROJECTS, { recursive: true });
// Postgres: tablas y, la primera vez, los proyectos y ajustes que había en archivos JSON
const imported = await migrate(PROJECTS);
if (imported) console.log(`  ${imported} proyectos importados a Postgres (los archivos JSON se conservan como copia)`);
if (!process.env.AI_ENGINE) setEngine(await getSetting('engine'));
// credenciales y carpeta de CapCut puestas en ⚙ Ajustes
applyCreds();
{ const d = await getSetting('capcutDrafts'); if (d && !process.env.CAPCUT_DRAFTS) process.env.CAPCUT_DRAFTS = d; }
if (!(await countUsers())) console.log('\n  ⚠️  No hay usuarios: crea el primero con  npm run user -- add <usuario> --admin\n');

const claude = (opts, emit) => runClaude({ system: systemPrompt(), cwd: path.join(HERE, 'style'), ...opts }, emit);
const safeId = (id) => String(id).replace(/[^a-z0-9_-]/gi, '').slice(0, 80);

async function listProjects() {
  const out = [];
  for (const p of await dbProjects()) {
    try {
      const shots = (p.video?.segments ?? []).flatMap((s) => s.shots ?? []);
      // portada: la foto del jugador de la miniatura elegida o la primera foto del vídeo
      const cover = p.thumbs?.[p.thumbPick ?? 0]?.bg?.url ?? shots.find((s) => s.media && s.media.type !== 'video')?.media.url ?? null;
      out.push({ id: p.id, title: p.video?.title ?? p.topic, updated: p.updated, cover, shots: shots.length, withMedia: shots.filter((s) => s.media).length, voice: !!p.voice, thumbs: !!p.thumbs?.length, exported: p.exported ?? null });
    } catch {}
  }
  return out.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
}

// sin límite de tiempo por petición: las tareas largas (vídeo completo, viñetas, miniaturas) van por SSE y pasan de 5 min
http.createServer({ requestTimeout: 0 }, async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const sp = url.searchParams;
  let m;
  try {
    // login, sesión, contraseña y usuarios (lib/web.js); si no hay sesión ya ha respondido
    const user = await gate(req, res, p, path.join(HERE, 'public'));
    if (!user) return;
    // lo que cambia claves o el motor de IA: solo el administrador
    const ADMIN = /^\/api\/(credentials|engine|codex\/login|brave\/key)/.test(p) || (p === '/api/tts/elevenlabs/key' && req.method === 'POST');
    if (ADMIN && !user.isAdmin) return sendJSON(res, 403, { error: 'Solo el administrador puede cambiar esto' });

    // gasto en servicios de pago, visible para todos
    if (p === '/api/usage') {
      const [eleven, brave] = await Promise.all([
        tts.provider('elevenlabs').usage().catch((e) => ({ error: e.message })),
        braveUsage().catch((e) => ({ error: e.message })),
      ]);
      return sendJSON(res, 200, { eleven, brave });
    }
    if (p === '/api/status') {
      return sendJSON(res, 200, { tts: tts.statusAll(), align: await aligner.status(), brave: braveStatus(), ai: await enginesStatus(), capcut: capcutStatus(), creds: credsStatus() });
    }
    // credenciales de ⚙ Ajustes: solo se guardan las que vienen con valor; nunca se devuelven
    if (p === '/api/credentials' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        await saveCreds(b);
        if (b.elevenlabs?.trim()) await tts.provider('elevenlabs').setKey(b.elevenlabs.trim());
        if (b.brave?.trim()) await setBraveKey(b.brave.trim());
        if (typeof b.capcutDrafts === 'string') {
          process.env.CAPCUT_DRAFTS = b.capcutDrafts.trim();
          await setSetting('capcutDrafts', b.capcutDrafts.trim());
        }
        return sendJSON(res, 200, { ok: true });
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (p === '/api/credentials/clear' && req.method === 'POST') {
      try { return sendJSON(res, 200, await clearCred((await readBody(req)).id)); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    // Codex con la suscripción de ChatGPT (Plus/Pro): `codex login` abre la página de OpenAI; sin API key de por medio
    if (p === '/api/codex/login' && req.method === 'POST') {
      await clearCred('openai'); // una API key guardada mandaría sobre la sesión de ChatGPT
      return sse(res, (emit) => codexLogin(emit));
    }
    // motor de IA: 'auto' (Claude Code y, si falla, Codex) | 'claude' | 'codex'; se recuerda entre reinicios
    if (p === '/api/engine' && req.method === 'POST') {
      const engine = setEngine((await readBody(req)).engine);
      await setSetting('engine', engine);
      return sendJSON(res, 200, { engine });
    }

    // ---- guion ----
    if (p === '/api/script' && req.method === 'POST') {
      const body = await readBody(req);
      return sse(res, (emit) => claude({ prompt: scriptPrompt(body), schema: VIDEO_SCHEMA, model: body.model || 'opus', effort: 'high', tools: ['WebSearch', 'WebFetch', 'Read', 'Glob'] }, emit));
    }
    // guion propio: el texto del creador se divide aquí (sin IA) y la IA solo decide los planos; la narración nunca sale de la IA
    if (p === '/api/script/import' && req.method === 'POST') {
      const { text = '', title = '' } = await readBody(req);
      const parts = splitScript(text);
      if (!parts.length) return sendJSON(res, 400, { error: 'El guion está vacío' });
      return sse(res, (emit) => {
        emit({ type: 'log', text: `📄 Tu guion: ${parts.length} partes. No se cambia ni una palabra; solo se eligen las imágenes de cada frase.` });
        return claude({ prompt: importPrompt(parts, title.trim()), system: importSystem(), schema: IMPORT_SCHEMA, model: 'sonnet', effort: 'medium', tools: [] }, (ev) => {
          if (ev.type !== 'result') return emit(ev);
          const d = ev.data;
          const norm = (x) => String(x).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();
          const segments = parts.map((narration, i) => {
            const sg = d.segments?.find((x) => Number(x.index) === i) ?? d.segments?.[i] ?? {};
            // un "cue" que no esté literal en el texto se deja vacío: la imagen entra repartida en el tiempo
            const shots = (sg.shots?.length ? sg.shots : [{ cue: '', desc: title || 'Imagen', query: title || 'fútbol' }])
              .map((sh, k) => ({ ...sh, cue: k && norm(narration).includes(norm(sh.cue)) ? sh.cue : '' }));
            return { section: sg.section || `PARTE ${i + 1}`, narration, shots };
          });
          emit({ ...ev, data: { title: title.trim() || d.title, alt_titles: d.alt_titles ?? [], description: d.description ?? '', tags: d.tags ?? [], sources: [], segments, ownScript: true } });
        });
      });
    }
    // rehacer un segmento (texto y planos) con una indicación
    if (p === '/api/refine' && req.method === 'POST') {
      const { segment, instruction, title } = await readBody(req);
      return sse(res, (emit) => claude({
        prompt: `Vídeo: "${title}". Reescribe este segmento siguiendo la indicación y rehaz sus planos.\nIndicación: ${String(instruction).slice(0, 600)}\n\n${JSON.stringify(segment, null, 1)}`,
        schema: SEGMENT_SCHEMA, model: 'sonnet', effort: 'medium',
      }, emit));
    }

    // ---- imágenes ----
    if (p === '/api/media/search') {
      try { return sendJSON(res, 200, await media.search(sp.get('q') || '')); } catch (e) { return sendJSON(res, 502, { error: e.message }); }
    }
    if (p === '/api/media/fetch' && req.method === 'POST') {
      const { projectId, url: src, credit } = await readBody(req);
      try { return sendJSON(res, 200, await media.fetchUrl(projectId, src, credit)); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    // revisión visual: marcas de agua y texto superpuesto (Claude Code mira cada foto)
    if (p === '/api/media/check' && req.method === 'POST') {
      // items: [{ url, desc, sentence }] (con el plano, también se comprueba que la foto encaje con lo que dice la voz)
      const body = await readBody(req);
      const items = body.items ?? (body.urls ?? []).map((url) => ({ url }));
      return sse(res, (emit) => {
        let cancel = () => {};
        const quiet = (ev) => { if (!(ev.type === 'log' && /^📚/.test(ev.text))) emit(ev); }; // sin una línea por cada foto abierta
        (async () => {
          const files = items.map((it) => ({ ...it, file: media.fileOf(it.url) }));
          const found = await checkImages(files, quiet, (c) => { cancel = c; }, body.title);
          emit({ type: 'result', data: { results: files.map((f) => ({ url: f.url, ...(found.get(path.basename(f.file)) ?? { ok: null, what: 'sin revisar' }) })) } });
        })().catch((e) => emit({ type: 'error', message: e.message })).finally(() => emit({ type: 'end' }));
        return () => cancel();
      });
    }
    if (p === '/api/media/upload' && req.method === 'POST') {
      try { return sendJSON(res, 200, await media.upload(sp.get('projectId'), await readRaw(req), req.headers['content-type'])); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    // miniaturas: conceptos + títulos que juegan con ellas, fotos elegidas mirando y jugador recortado
    if (p === '/api/thumbs' && req.method === 'POST') {
      const body = await readBody(req);
      return sse(res, (emit) => {
        let cancel = () => {};
        const started = Date.now();
        makeThumbs(body, media, emit, (c) => { cancel = c; })
          .then((data) => emit({ type: 'result', data, cost: data.cost, secs: Math.round((Date.now() - started) / 1000) }))
          .catch((e) => emit({ type: 'error', message: e.message }))
          .finally(() => emit({ type: 'end' }));
        return () => cancel();
      });
    }
    // foto de cada plano elegida mirando los candidatos (encaje con la voz + limpia)
    if (p === '/api/media/pick' && req.method === 'POST') {
      const body = await readBody(req);
      return sse(res, (emit) => {
        const ctrl = new AbortController();
        let cancel = () => {};
        const started = Date.now();
        pickPhotos(body, media, emit, (c) => { cancel = c; }, ctrl.signal)
          .then((data) => emit({ type: 'result', data, cost: data.cost, secs: Math.round((Date.now() - started) / 1000) }))
          .catch((e) => emit({ type: 'error', message: e.message }))
          .finally(() => emit({ type: 'end' }));
        return () => { ctrl.abort(); cancel(); };
      });
    }
    // clips automáticos: qué planos van con vídeo y qué trozo exacto (Claude mira los candidatos)
    if (p === '/api/clips/auto' && req.method === 'POST') {
      const body = await readBody(req);
      return sse(res, (emit) => {
        const ctrl = new AbortController();
        let cancel = () => {};
        const started = Date.now();
        autoClips(body, media, emit, (c) => { cancel = c; }, ctrl.signal)
          .then((data) => emit({ type: 'result', data, cost: data.cost, secs: Math.round((Date.now() - started) / 1000) }))
          .catch((e) => emit({ type: 'error', message: e.message }))
          .finally(() => emit({ type: 'end' }));
        return () => { ctrl.abort(); cancel(); };
      });
    }
    // clips de YouTube: buscar, momentos más vistos y recortar un trozo
    if (p.startsWith('/api/clips/')) {
      try {
        if (p === '/api/clips/search') return sendJSON(res, 200, { items: await clips.search(sp.get('q') || '') });
        if (p === '/api/clips/info') return sendJSON(res, 200, await clips.info(sp.get('id')));
        if (p === '/api/clips/cut' && req.method === 'POST') { const b = await readBody(req); return sendJSON(res, 200, await clips.cut(media, b.projectId, b)); }
      } catch (e) { return sendJSON(res, 502, { error: e.message }); }
    }
    if (p === '/api/brave/key' && req.method === 'POST') { await setBraveKey(String((await readBody(req)).key || '').trim()); return sendJSON(res, 200, braveStatus()); }
    if (p.startsWith('/media/')) {
      try { const f = await media.read(decodeURIComponent(p.slice('/media/'.length))); res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'max-age=31536000, immutable' }); return res.end(f.buf); }
      catch { return sendJSON(res, 404, { error: 'not found' }); }
    }

    // ---- voz IA (lib/tts) ----
    if ((m = p.match(/^\/api\/tts\/(elevenlabs)\/(key|voices)$/))) {
      const prov = tts.provider(m[1]);
      try {
        if (m[2] === 'key' && req.method === 'POST') { await prov.setKey(String((await readBody(req)).key || '').trim()); return sendJSON(res, 200, tts.statusAll()); }
        return sendJSON(res, 200, await prov.listLatamVoices({ q: sp.get('q') || '' }));
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (p === '/api/tts/elevenlabs/add' && req.method === 'POST') {
      try { return sendJSON(res, 200, await tts.provider('elevenlabs').addSharedVoice(await readBody(req))); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (p === '/api/tts/preview' && req.method === 'POST') {
      try { return sendJSON(res, 200, await tts.preview(await readBody(req))); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    // un audio por segmento (caché por contenido: solo se rehacen los segmentos que cambiaron) y alineación palabra a palabra
    if (p === '/api/voice' && req.method === 'POST') {
      const body = await readBody(req);
      return sse(res, (emit) => {
        const ctrl = new AbortController();
        const log = (text) => emit({ type: 'log', text });
        (async () => {
          const segs = await tts.synthesize({ ...body, segments: body.segments.map((s) => ({ index: s.index, spoken: s.text })) }, log, ctrl.signal);
          const { available } = await aligner.status();
          let words = [];
          if (available) {
            const items = segs.map((s) => ({ index: s.index, file: path.join(tts.AUDIO_DIR, decodeURIComponent(s.url.replace(/^\/audio\//, ''))), prompt: body.segments.find((x) => x.index === s.index)?.text ?? '' }));
            words = await aligner.align(items, log, ctrl.signal);
          } else log('⚠️ Sin alineador (faster-whisper): las fotos se reparten por la duración del audio');
          emit({ type: 'result', data: { segments: segs.map((s) => ({ ...s, words: words.find((w) => w.index === s.index)?.words ?? null })) } });
        })().catch((e) => emit({ type: 'error', message: e.message })).finally(() => emit({ type: 'end' }));
        return () => ctrl.abort();
      });
    }
    if (p.startsWith('/audio/')) {
      try { const buf = await tts.readAudio(decodeURIComponent(p.slice('/audio/'.length))); res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); return res.end(buf); }
      catch { return sendJSON(res, 404, { error: 'not found' }); }
    }

    // ---- exportar a CapCut (borrador editable) ----
    if (p === '/api/capcut' && req.method === 'POST') {
      const body = await readBody(req);
      return sse(res, (emit) => {
        const started = Date.now();
        exportCapcut(body, media, exporter.OUT_DIR, `http://127.0.0.1:${PORT}`, (text) => emit({ type: 'log', text }))
          .then((data) => emit({ type: 'result', data, secs: Math.round((Date.now() - started) / 1000) }))
          .catch((e) => emit({ type: 'error', message: e.message }))
          .finally(() => emit({ type: 'end' }));
        return () => {};
      });
    }
    // ---- exportación (WebCodecs en el navegador + ffmpeg) ----
    if (p === '/api/export/start' && req.method === 'POST') return sendJSON(res, 200, await exporter.start());
    if ((m = p.match(/^\/api\/export\/([a-z0-9]+)\/(video|audio|finish|cancel)$/)) && req.method === 'POST') {
      try {
        if (m[2] === 'finish') return sendJSON(res, 200, await exporter.finish(m[1], await readBody(req)));
        if (m[2] === 'cancel') { await exporter.cancel(m[1]); return sendJSON(res, 200, { ok: true }); }
        return sendJSON(res, 200, await exporter.append(m[1], m[2], req));
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (p.startsWith('/exports/')) {
      const name = path.basename(decodeURIComponent(p.slice('/exports/'.length)));
      const file = path.join(exporter.OUT_DIR, name);
      if (!existsSync(file)) return sendJSON(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': name.endsWith('.zip') ? 'application/zip' : 'video/mp4', 'Content-Length': (await stat(file)).size, 'Content-Disposition': `attachment; filename="${name}"` });
      return createReadStream(file).pipe(res);
    }

    // ---- proyectos ----
    if (p === '/api/projects' && req.method === 'GET') return sendJSON(res, 200, await listProjects());
    if (p === '/api/projects' && req.method === 'POST') {
      const project = await readBody(req);
      project.id = safeId(project.id || Date.now().toString(36));
      const updated = await saveProject(project, user.id);
      return sendJSON(res, 200, { id: project.id, updated });
    }
    if ((m = p.match(/^\/api\/projects\/([\w-]+)$/))) {
      const id = safeId(m[1]);
      if (req.method === 'GET') { const pj = await getProject(id); return pj ? sendJSON(res, 200, pj) : sendJSON(res, 404, { error: 'No existe' }); }
      // a la papelera (deleted_at): recuperable desde Postgres
      if (req.method === 'DELETE') return (await deleteProject(id)) ? sendJSON(res, 200, { ok: true }) : sendJSON(res, 404, { error: 'No existe' });
    }

    // ---- estáticos: la app (futbol/public) y el motor compartido (public/js) ----
    return serveFrom(req, res, p, STATIC);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJSON(res, 500, { error: err.message });
  }
}).listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`\n  ⚽ Estudio de fútbol en http://localhost:${PORT}\n`));
