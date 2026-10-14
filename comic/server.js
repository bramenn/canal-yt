// Estudio Cómic: de un episodio de podcast de YouTube (relatos, entrevistas a delincuentes) salen shorts verticales
// para TikTok con la voz original y el relato dibujado en viñetas de cómic (Codex con la cuenta de ChatGPT).
// Usa lo común de lib/ (login, Postgres, archivos, IA, exportación) y guarda sus episodios en la tabla «comics».
// node comic/server.js  →  http://localhost:4323
import http from 'node:http';
import path from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sendJSON, readBody, sse, setEngine } from '../lib/claude.js';
import { migrate, listProjects, getProject, saveProject, deleteProject, getSetting } from '../lib/db.js';
import { countUsers } from '../lib/auth.js';
import { gate, serveFrom } from '../lib/web.js';
import { fileStore } from '../lib/store.js';
import { ingest, fxShort } from './lib/podcast.js';
import { drawShort } from './lib/comicart.js';
import { makeCover } from './lib/cover.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
// antes de cargar la exportación: su carpeta cuelga de PROJECTS_DIR
process.env.PROJECTS_DIR ||= path.join(HERE, 'projects');
const PROJECTS = process.env.PROJECTS_DIR;
const exporter = await import('../lib/export.js');
const media = fileStore(path.join(PROJECTS, 'media'));
const PORT = Number(process.env.PORT || 4323);
const STATIC = { '/shared/': path.join(REPO, 'public/js'), '/': path.join(HERE, 'public') };
const TABLE = 'comics';
await mkdir(PROJECTS, { recursive: true });
await migrate();
if (!process.env.AI_ENGINE) setEngine(await getSetting('engine'));
if (!(await countUsers())) console.log('\n  ⚠️  No hay usuarios: crea el primero con  npm run user -- add <usuario> --admin\n');

const safeId = (id) => String(id).replace(/[^a-z0-9_-]/gi, '').slice(0, 80);

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

async function summaries() {
  return (await listProjects(TABLE)).map((p) => {
    const panels = (p.shorts ?? []).flatMap((s) => s.panels ?? []);
    return { id: p.id, title: p.source?.title ?? 'Episodio', channel: p.source?.channel ?? '', updated: p.updated, cover: panels.find((x) => x.image)?.image.url ?? null, shorts: p.shorts?.length ?? 0, panels: panels.length, drawn: panels.filter((x) => x.image).length };
  });
}

// sin límite de tiempo por petición: las tareas largas (vídeo completo, viñetas, miniaturas) van por SSE y pasan de 5 min
http.createServer({ requestTimeout: 0 }, async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  let m;
  try {
    // login, sesión, contraseña y usuarios (lib/web.js); si no hay sesión ya ha respondido
    const user = await gate(req, res, p, path.join(HERE, 'public'));
    if (!user) return;

    // ---- episodio → relatos con su guion de cómic (descarga, Whisper, IA) ----
    if (p === '/api/podcast' && req.method === 'POST') {
      const body = await readBody(req);
      return task(res, (emit, track, signal) => ingest({ url: body.url, projectId: safeId(body.projectId) }, media, emit, track, signal));
    }
    // ---- efectos de un short (clímax y ambientes), también para shorts ya dibujados ----
    if (p === '/api/podcast/fx' && req.method === 'POST') {
      const { short } = await readBody(req);
      return task(res, async (emit, track) => { const cost = await fxShort(short, emit, track); return { fx: short.fx, cost }; });
    }
    // ---- viñetas de un short con Codex (image_gen, plan de ChatGPT) ----
    // ---- miniatura de un short (también su primer fotograma): portada noir de Codex + texto a 4K ----
    if (p === '/api/podcast/cover' && req.method === 'POST') {
      const { projectId, n, short } = await readBody(req);
      // referencia del personaje: un primer plano ya dibujado o, si no, cualquier viñeta dibujada
      const drawnPanels = (short.panels ?? []).filter((x) => x.image?.url);
      const ref = drawnPanels.find((x) => /primer|detalle/i.test(x.shot ?? '')) ?? drawnPanels[0];
      let refFile = null;
      try { refFile = ref ? media.fileOf(ref.image.url) : null; } catch {}
      return task(res, (emit, track, signal) => makeCover({ short, n: Number(n) || 0, dir: media.dirOf(safeId(projectId)), refFile }, emit, track, signal));
    }
    if (p === '/api/podcast/draw' && req.method === 'POST') {
      const body = await readBody(req);
      return task(res, (emit, track, signal) => drawShort({ ...body, projectId: safeId(body.projectId) }, media, emit, signal));
    }
    if (p.startsWith('/media/')) {
      try { const f = await media.read(decodeURIComponent(p.slice('/media/'.length))); res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'max-age=31536000, immutable' }); return res.end(f.buf); }
      catch { return sendJSON(res, 404, { error: 'not found' }); }
    }

    // ---- exportación del MP4 vertical (WebCodecs en el navegador + ffmpeg) ----
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
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': (await stat(file)).size, 'Content-Disposition': `attachment; filename="${name}"` });
      return createReadStream(file).pipe(res);
    }

    // ---- episodios ----
    if (p === '/api/projects' && req.method === 'GET') return sendJSON(res, 200, await summaries());
    if (p === '/api/projects' && req.method === 'POST') {
      const project = await readBody(req);
      project.id = safeId(project.id || Date.now().toString(36));
      return sendJSON(res, 200, { id: project.id, updated: await saveProject(project, user.id, TABLE) });
    }
    if ((m = p.match(/^\/api\/projects\/([\w-]+)$/))) {
      const id = safeId(m[1]);
      if (req.method === 'GET') { const pj = await getProject(id, TABLE); return pj ? sendJSON(res, 200, pj) : sendJSON(res, 404, { error: 'No existe' }); }
      if (req.method === 'DELETE') return (await deleteProject(id, TABLE)) ? sendJSON(res, 200, { ok: true }) : sendJSON(res, 404, { error: 'No existe' });
    }

    // ---- estáticos: la app (comic/public) y lo compartido del navegador (public/js) ----
    return serveFrom(req, res, p, STATIC);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJSON(res, 500, { error: err.message });
  }
}).listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`\n  🕵️ Estudio Cómic en http://localhost:${PORT}\n`));
