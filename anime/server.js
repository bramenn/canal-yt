// Estudio Anime: shorts verticales de curiosidades y noticias de anime al estilo AniDosis, en automático:
// la IA busca las historias del día, escribe el guion, pone la voz (ElevenLabs) y se monta el MP4 con escenas
// de los tráileres oficiales y subtítulos. Usa lo común de lib/ y guarda sus shorts en la tabla «animes».
// node anime/server.js  →  http://localhost:4324
import http from 'node:http';
import path from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sendJSON, readBody, sse, setEngine, getEngine } from '../lib/claude.js';
import { migrate, listProjects, getProject, saveProject, deleteProject } from '../lib/db.js';
import { countUsers } from '../lib/auth.js';
import { gate, serveFrom } from '../lib/web.js';
import { findStories, thumbText } from './lib/story.js';
import { makeThumb, firstFrame } from './lib/thumb.js';
import { readdir, readFile } from 'node:fs/promises';
import { makeShort, makeTiktok } from './lib/make.js';
import { refreshStats } from '../lib/stats.js';
import { virality, learnings } from '../lib/virality.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// antes de cargar la voz: sus carpetas cuelgan de PROJECTS_DIR
process.env.PROJECTS_DIR ||= path.join(HERE, 'projects');
const PROJECTS = process.env.PROJECTS_DIR;
const MEDIA = path.join(PROJECTS, 'media');
const tts = await import('../lib/tts/index.js');
const aligner = await import('../lib/align/index.js');
const PORT = Number(process.env.PORT || 4324);
const TABLE = 'animes';
await mkdir(MEDIA, { recursive: true });
await migrate();
// Anime usa Codex directamente por defecto. Claude/auto siguen disponibles con AI_ENGINE.
if (!process.env.AI_ENGINE) setEngine('codex');
if (!(await countUsers())) console.log('\n  ⚠️  No hay usuarios: crea el primero con  npm run user -- add <usuario> --admin\n');

// lo aprendido de las cifras (qué funcionó y qué no) para la IA, sin repetir temas ni arranques
const describe = (p) => ({ title: p.script?.title, hook: p.script?.lines?.[0]?.text, angle: `${p.story?.anime}: ${p.story?.angle}` });
const learnFrom = async () => learnings(await listProjects(TABLE), describe);
const safeId = (id) => String(id).replace(/[^a-z0-9_-]/gi, '').slice(0, 80);
// las dos voces del canal (biblioteca de ElevenLabs): se elige una al crear o rehacer
const VOICES = { mujer: { id: 'ajOR9IDAaubDK5qtLUqQ', title: 'Mujer' }, hombre: { id: 'qRUgOhnxGASxirG4fKjv', title: 'Hombre (David)' } };
const voiceOf = (key) => VOICES[key] ?? VOICES.hombre;

// cifras de YouTube, TikTok y Facebook: al arrancar (a los 2 min) y cada 30 min; una sola lectura a la vez
let statsRun = null;
// cuentas del canal de anime (TikTok por su ID interno: el perfil @o_notianimes.com_o)
const ACCOUNTS = {
  youtube: 'https://www.youtube.com/@notianimes/shorts',
  tiktok: 'MS4wLjABAAAA9icKmxw6zuctpoqc4NmoW8un0Hr7bS7tbxB_MYd2GWkhoHwQsvxQ1awZmq0aChId',
  facebook: 'https://www.facebook.com/notianimescom/reels/',
};
const updateStats = (log = () => {}) => (statsRun ??= refreshStats(listProjects(TABLE), null, log, { accounts: ACCOUNTS, table: TABLE })
  .finally(() => { statsRun = null; }));
setTimeout(() => updateStats().catch((e) => console.error('cifras:', e.message)), 120000);
setInterval(() => updateStats().catch((e) => console.error('cifras:', e.message)), 30 * 60000);

/** Tarea larga por SSE: result / error / end, cancelable al cerrar la conexión. */
const task = (res, run) => sse(res, (emit) => {
  const ctrl = new AbortController();
  let cancel = () => {};
  const started = Date.now();
  run(emit, (c) => { cancel = c; }, ctrl.signal)
    .then((data) => emit({ type: 'result', data, cost: data?.cost, secs: Math.round((Date.now() - started) / 1000) }))
    .catch((e) => emit({ type: 'error', message: e.message }))
    .finally(() => emit({ type: 'end' }));
  return () => { ctrl.abort(); cancel(); };
});

/** Hace un short y lo guarda; si falla, lo cuenta y sigue (en automático no se para todo por uno). */
async function makeAndSave(story, voiceKey, user, emit, track, signal, id = Date.now().toString(36), learn = '') {
  const v = voiceOf(voiceKey);
  emit({ type: 'log', text: `🎙 Voz: ${v.title}` });
  const p = await makeShort({ id, story, voiceId: v.id, learn }, { tts, aligner, mediaDir: MEDIA }, emit, track, signal);
  p.voice.title = v.title;
  await saveProject(p, user.id, TABLE);
  emit({ type: 'short', project: p });
  return p;
}

// sin límite de tiempo por petición: las tareas largas (vídeo completo, viñetas, miniaturas) van por SSE y pasan de 5 min
http.createServer({ requestTimeout: 0 }, async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  let m;
  try {
    const user = await gate(req, res, p, path.join(HERE, 'public'));
    if (!user) return;

    if (p === '/api/ai-status' && req.method === 'GET') {
      return sendJSON(res, 200, { engine: getEngine(), model: getEngine() === 'codex' ? (process.env.CODEX_MODEL || null) : null });
    }

    // ---- automático: historias del día → un short por historia ----
    if (p === '/api/auto' && req.method === 'POST') {
      const { count = 3, voice } = await readBody(req);
      return task(res, async (emit, track, signal) => {
        const log = (text) => emit({ type: 'log', text });
        const avoid = (await listProjects(TABLE)).map((x) => `${x.story?.anime}: ${x.story?.angle}`);
        log('🔎 Buscando las historias de anime con más gancho…');
        const learn = await learnFrom();
        if (learn.includes('LO QUE NOS HA FUNCIONADO')) log('🧠 Aprendiendo de tus shorts que mejor funcionaron…');
        const { stories, cost: c0 } = await findStories({ count: Math.min(5, Math.max(1, Number(count) || 3)), avoid, learn }, emit, track);
        log(`📰 ${stories.length} historias: ${stories.map((s) => s.anime).join(' · ')}`);
        let cost = c0, ok = 0;
        for (const [i, story] of stories.entries()) {
          if (signal.aborted) break;
          log(`━━ Short ${i + 1} de ${stories.length}: ${story.anime}`);
          try { cost += (await makeAndSave(story, voice, user, emit, track, signal, `${Date.now().toString(36)}${i}`, learn)).cost; ok++; }
          catch (e) { log(`⚠️ ${story.anime}: ${e.message.slice(0, 200)}`); }
        }
        return { made: ok, cost };
      });
    }
    // ---- rehacer un short (misma historia, guion y montaje nuevos) ----
    if ((m = p.match(/^\/api\/remake\/([\w-]+)$/)) && req.method === 'POST') {
      const old = await getProject(safeId(m[1]), TABLE);
      if (!old) return sendJSON(res, 404, { error: 'No existe' });
      const { voice } = await readBody(req);
      return task(res, async (emit, track, signal) => makeAndSave(old.story, voice, user, emit, track, signal, old.id, await learnFrom()));
    }
    // ---- cifras de las publicaciones (ahora mismo) ----
    if (p === '/api/stats' && req.method === 'POST') {
      return task(res, async (emit) => ({ found: await updateStats((text) => emit({ type: 'log', text })) }));
    }
    // ---- versión TikTok (> 1 min) de un short ya hecho: guion largo, voz y montaje; misma miniatura ----
    if ((m = p.match(/^\/api\/tiktok\/([\w-]+)$/)) && req.method === 'POST') {
      const pj = await getProject(safeId(m[1]), TABLE);
      if (!pj) return sendJSON(res, 404, { error: 'No existe' });
      return task(res, async (emit, track, signal) => {
        const dir = path.join(MEDIA, pj.id);
        const thumb = existsSync(path.join(dir, 'thumb.jpg')) ? { full: path.join(dir, 'thumb-4k.jpg'), small: path.join(dir, 'thumb.jpg') } : null;
        const voiceId = pj.voice?.voiceId ?? voiceOf('hombre').id;
        const { tiktok, cost } = await makeTiktok({ id: pj.id, story: pj.story, voiceId, thumb }, { tts, aligner, mediaDir: MEDIA }, emit, track, signal);
        pj.tiktok = tiktok;
        await saveProject(pj, user.id, TABLE);
        emit({ type: 'short', project: pj });
        return { duration: tiktok.duration, cost };
      });
    }
    // ---- miniatura de un short ya hecho (sin rehacer voz ni montaje): también pasa a ser su primer fotograma ----
    if ((m = p.match(/^\/api\/thumb\/([\w-]+)$/)) && req.method === 'POST') {
      const pj = await getProject(safeId(m[1]), TABLE);
      if (!pj) return sendJSON(res, 404, { error: 'No existe' });
      return task(res, async (emit, track, signal) => {
        const log = (text) => emit({ type: 'log', text });
        const dir = path.join(MEDIA, pj.id);
        if (!pj.script.thumb_text) Object.assign(pj.script, await thumbText(pj.script, emit, track));
        log(`🖼 Texto de la miniatura: «${pj.script.thumb_text}»`);
        const main = pj.script.lines.find((l) => l.show === 'anime')?.query ?? pj.story.anime;
        const sf = (await readdir(dir)).find((f) => /^tr-.*\.json$/.test(f));
        const scenes = sf ? JSON.parse(await readFile(path.join(dir, sf), 'utf8')) : [{ file: path.join(dir, 'short.mp4'), s: 1, e: 3 }];
        const thumb = await makeThumb({ script: pj.script, anime: main, scenes, dir }, log, signal);
        log('🎬 Poniéndola como primer fotograma del vídeo…');
        await firstFrame(path.join(dir, 'short.mp4'), thumb.small);
        Object.assign(pj, { thumb: `/media/${pj.id}/thumb-4k.jpg`, thumbSmall: `/media/${pj.id}/thumb.jpg` });
        await saveProject(pj, user.id, TABLE);
        emit({ type: 'short', project: pj });
        return { ok: true };
      });
    }
    if (p.startsWith('/media/')) {
      // vídeos con Range (el navegador pide trozos para poder saltar)
      const rel = decodeURIComponent(p.slice('/media/'.length));
      const file = path.normalize(path.join(MEDIA, rel));
      const st = file.startsWith(MEDIA + path.sep) ? await stat(file).catch(() => null) : null;
      if (!st?.isFile()) return sendJSON(res, 404, { error: 'not found' });
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
      const type = file.endsWith('.mp4') ? 'video/mp4' : /\.jpe?g$/.test(file) ? 'image/jpeg' : 'application/octet-stream';
      if (!range) { res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' }); return createReadStream(file).pipe(res); }
      const a = range[1] ? +range[1] : 0, b = range[2] ? +range[2] : st.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes' });
      return createReadStream(file, { start: a, end: b }).pipe(res);
    }

    // ---- shorts ----
    if (p === '/api/projects' && req.method === 'GET') {
      const list = await listProjects(TABLE);
      const v = virality(list);
      return sendJSON(res, 200, list.map((x) => ({ ...x, viral: v[x.id] })));
    }
    if ((m = p.match(/^\/api\/projects\/([\w-]+)$/)) && req.method === 'DELETE') {
      return (await deleteProject(safeId(m[1]), TABLE)) ? sendJSON(res, 200, { ok: true }) : sendJSON(res, 404, { error: 'No existe' });
    }

    return serveFrom(req, res, p, { '/shared/': path.join(HERE, '..', 'public/js'), '/': path.join(HERE, 'public') });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJSON(res, 500, { error: err.message });
  }
}).listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`\n  🍥 Estudio Anime en http://localhost:${PORT}\n  Motor de IA: ${getEngine()}\n`));
