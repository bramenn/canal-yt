// Estudio Anime: shorts verticales de curiosidades y noticias de anime al estilo AniDosis, en automático:
// la IA busca las historias del día, escribe el guion, pone la voz (ElevenLabs) y se monta el MP4 con escenas
// de los tráileres oficiales y subtítulos. Usa lo común de lib/ y guarda sus shorts en la tabla «animes».
// node anime/server.js  →  http://localhost:4324
import http from 'node:http';
import path from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sendJSON, readBody, sse, setEngine, getEngine } from '../lib/claude.js';
import { migrate, listProjects, getProject, saveProject, deleteProject, q, getSetting, setSetting } from '../lib/db.js';
import { countUsers } from '../lib/auth.js';
import { gate, serveFrom } from '../lib/web.js';
import { findStories, thumbText, franchiseOf } from './lib/story.js';
import { makeThumb, makeThumb16x9, firstFrame } from './lib/thumb.js';
import { readdir, readFile, writeFile, appendFile, unlink } from 'node:fs/promises';
import { makeShort, makeTiktok, copyAbout, remountProject } from './lib/make.js';
import { makeLong, remountLong, resumeLong } from './lib/long.js';
import { writeComment } from '../lib/social.js';
import { refreshStats } from '../lib/stats.js';
import { virality, learnings } from '../lib/virality.js';
import { youtubeAnalyticsMissingConfig } from '../lib/youtube-analytics.js';
import { youtubeLearning } from './lib/youtube-learning.js';
import { waitReady } from './lib/episodes.js';

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
const learnFrom = async () => {
  const projects = await listProjects(TABLE);
  return youtubeLearning(projects, describe) ?? learnings(projects, describe);
};
const safeId = (id) => String(id).replace(/[^a-z0-9_-]/gi, '').slice(0, 80);
// las dos voces del canal (biblioteca de ElevenLabs): se elige una al crear o rehacer
const VOICES = { mujer: { id: 'ajOR9IDAaubDK5qtLUqQ', title: 'Mujer' }, hombre: { id: 'qRUgOhnxGASxirG4fKjv', title: 'Hombre (David)' } };
const voiceOf = (key) => VOICES[key] ?? VOICES.hombre;
const analyticsMissing = youtubeAnalyticsMissingConfig();
if (analyticsMissing.length) console.log(`ℹ️ YouTube Analytics sin conectar; faltan ${analyticsMissing.join(', ')}.`);

// cifras de YouTube, TikTok y Facebook: al arrancar (a los 2 min) y cada 30 min; una sola lectura a la vez
let statsRun = null;
// cuentas del canal de anime (TikTok por su ID interno: el perfil @o_notianimes.com_o)
const ACCOUNTS = {
  youtube: 'https://www.youtube.com/@notianimes/shorts',
  tiktok: 'MS4wLjABAAAA9icKmxw6zuctpoqc4NmoW8un0Hr7bS7tbxB_MYd2GWkhoHwQsvxQ1awZmq0aChId',
  facebook: 'https://www.facebook.com/notianimescom/reels/',
  instagram: 'https://www.instagram.com/notianimes_/reels/',
};
const updateStats = (log = () => {}) => (statsRun ??= refreshStats(listProjects(TABLE), null, log, { accounts: ACCOUNTS, table: TABLE })
  .finally(() => { statsRun = null; }));
setTimeout(() => updateStats().catch((e) => console.error('cifras:', e.message)), 120000);
setInterval(() => updateStats().catch((e) => console.error('cifras:', e.message)), 30 * 60000);

// Cola en disco para re-montar proyectos en segundo plano (mismo guion, voz y miniatura)
const REMOUNT_QUEUE = path.join(PROJECTS, 'remount-queue.json');
const REMOUNT_LOG = path.join(PROJECTS, 'remount-status.log');
let remountBusy = false;
const enqueue = async (item) => {
  const q = existsSync(REMOUNT_QUEUE) ? JSON.parse(await readFile(REMOUNT_QUEUE, 'utf8')) : [];
  if (!q.includes(item)) await writeFile(REMOUNT_QUEUE, JSON.stringify([...q, item]));
};
// un largo que falló se reanuda solo desde su borrador; red o disco caídos se reintentan hasta 5 veces
const TRANSIENT = /fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network|socket|timed? ?out|No space left|ENOSPC|descarga a medias/i;
const longTries = new Map();
const resumeLater = async (id, e, started) => {
  // borrador de este intento (al rehacer, el del vídeo anterior no cuenta)
  const draft = path.join(MEDIA, id, 'long-draft.json');
  if (/Cancelado/.test(e.message) || !existsSync(draft) || statSync(draft).mtimeMs < started) return e;
  await enqueue(`long:${id}`);
  return new Error(`${e.message} · El avance quedó guardado: se reanuda solo en segundo plano (registro en remount-status.log)`);
};
setInterval(async () => {
  if (remountBusy || !existsSync(REMOUNT_QUEUE)) return;
  remountBusy = true;
  try {
    const ids = JSON.parse(await readFile(REMOUNT_QUEUE, 'utf8'));
    await unlink(REMOUNT_QUEUE).catch(() => {});
    const logLine = async (msg) => {
      console.log('[remount]', msg);
      await appendFile(REMOUNT_LOG, `[${new Date().toISOString()}] ${msg}\n`).catch(() => {});
    };
    await writeFile(REMOUNT_LOG, `[${new Date().toISOString()}] Iniciando re-montaje de ${ids.length} shorts: ${ids.join(', ')}\n`).catch(() => {});
    for (const id of ids) {
      try {
        // «long:<id>» reanuda un vídeo largo que falló en el montaje, desde su borrador (guion y voces ya hechos)
        if (String(id).startsWith('long:')) {
          const lid = safeId(String(id).slice(5));
          await waitReady(MEDIA, logLine);
          await logLine(`━━ Reanudando vídeo largo ${lid} desde su borrador…`);
          const prev = await getProject(lid, TABLE);
          const pj = await resumeLong(lid, { tts, aligner, mediaDir: MEDIA }, (ev) => { if (ev.type === 'log') logLine(ev.text); }, () => {});
          pj.voice.title = 'Hombre (David)';
          if (prev?.stats) pj.stats = prev.stats;
          if (prev?.created) pj.created = prev.created;
          await saveProject(pj, null, TABLE);
          await logLine(`✅ ${lid} completado (${pj.duration}s)`);
          longTries.delete(lid);
          continue;
        }
        const pj = await getProject(safeId(id), TABLE);
        if (!pj) { await logLine(`⚠️ ${id}: no existe en DB`); continue; }
        await logLine(`━━ Re-montando ${id} (${pj.story?.anime})…`);
        await remountProject(pj, { tts, aligner, mediaDir: MEDIA }, logLine);
        pj.thumbRevision = Date.now();
        await saveProject(pj, null, TABLE);
        await logLine(`✅ ${id} (${pj.story?.anime}) completado (YouTube: ${pj.duration}s${pj.tiktok ? `, TikTok: ${pj.tiktok.duration}s` : ''})`);
      } catch (e) {
        await logLine(`❌ Error en ${id}: ${e.message}`);
        const lid = String(id).startsWith('long:') && safeId(String(id).slice(5));
        const n = (longTries.get(lid) ?? 0) + 1;
        // sin cuota de IA (Codex y Claude): espera media hora antes de reintentar
        const quota = /usage limit|session limit|hit your limit/i.test(e.message);
        if (lid && (TRANSIENT.test(e.message) || quota) && n < 5) {
          longTries.set(lid, n);
          if (quota) { await logLine(`⏸ ${lid}: sin cuota de IA, reintento en 30 min`); await new Promise((r) => setTimeout(r, 30 * 60000)); }
          await enqueue(id); await logLine(`🔁 ${lid}: lo reintento (${n + 1}/5)`);
        }
      }
    }
    await logLine('🎉 Todos los shorts de la cola han sido re-montados.');
  } catch (e) {
    console.error('remount-queue:', e.message);
  } finally {
    remountBusy = false;
  }
}, 5000);

// solo el botón «Cancelar» corta una tarea: recargar la página (F5) o perder la conexión ya no tira el short a medias
let cancelAt = 0;
/** Tarea larga por SSE: result / error / end; sigue aunque se cierre la conexión, salvo con «Cancelar». */
const task = (res, run) => sse(res, (emit) => {
  const ctrl = new AbortController();
  let cancel = () => {};
  const started = Date.now();
  run(emit, (c) => { cancel = c; }, ctrl.signal)
    .then((data) => emit({ type: 'result', data, cost: data?.cost, secs: Math.round((Date.now() - started) / 1000) }))
    .catch((e) => emit({ type: 'error', message: e.message }))
    .finally(() => emit({ type: 'end' }));
  return () => setTimeout(() => { if (Date.now() - cancelAt < 5000) { ctrl.abort(); cancel(); } }, 1500);
});

/** Hace un short y lo guarda; si falla, lo cuenta y sigue (en automático no se para todo por uno). */
async function makeAndSave(story, voiceKey, user, emit, track, signal, id = Date.now().toString(36), learn = '', previous = null) {
  const v = voiceOf(voiceKey);
  emit({ type: 'log', text: `🎙 Voz: ${v.title}` });
  const tiktok = (await getSetting(`${TABLE}.tiktok`)) !== false; // configuración: generar o no la versión TikTok
  const p = await makeShort({ id, story, voiceId: v.id, learn, tiktok }, { tts, aligner, mediaDir: MEDIA }, emit, track, signal).catch(async (e) => {
    // el montaje falló con la voz ya pagada: se guarda para «🎬 Re-montar» (misma voz, sin volver a pagar ElevenLabs)
    if (!e.partial) throw e;
    e.partial.voice.title = v.title;
    await saveProject(e.partial, user.id, TABLE);
    emit({ type: 'short', project: e.partial });
    emit({ type: 'log', text: `💾 Guardado sin vídeo: pulsa «🎬 Re-montar» en «${e.partial.script.title}» (no vuelve a pagar la voz)` });
    throw e;
  });
  p.voice.title = v.title;
  if (previous?.stats) p.stats = previous.stats;
  if (previous?.created) p.created = previous.created;
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

    if (p === '/api/config') {
      if (req.method === 'POST') { const { tiktok } = await readBody(req); await setSetting(`${TABLE}.tiktok`, tiktok !== false); }
      return sendJSON(res, 200, { tiktok: (await getSetting(`${TABLE}.tiktok`)) !== false });
    }

    if (p === '/api/cancel' && req.method === 'POST') { cancelAt = Date.now(); return sendJSON(res, 200, { ok: true }); }

    if (p === '/api/ai-status' && req.method === 'GET') {
      return sendJSON(res, 200, { engine: getEngine(), model: getEngine() === 'codex' ? (process.env.CODEX_MODEL || null) : null });
    }

    // Solo texto para copiar: nunca rehace ni publica el vídeo.
    if ((m = p.match(/^\/api\/comment\/([\w-]+)$/)) && req.method === 'POST') {
      const pj = await getProject(safeId(m[1]), TABLE);
      if (!pj) return sendJSON(res, 404, { error: 'No existe' });
      return task(res, async (emit, track, signal) => {
        if (pj.script?.copy?.suggested_comment?.trim()) {
          emit({ type: 'short', project: pj });
          return { comment: pj.script.copy.suggested_comment };
        }
        emit({ type: 'log', text: '💬 Preparando una pregunta sobre este vídeo…' });
        const comment = await writeComment(copyAbout(pj.story, pj.script), emit, track);
        if (signal.aborted) throw new Error('Cancelado');
        // Actualización parcial: conserva las cifras y cualquier otro cambio concurrente.
        // Si se rehízo o borró el vídeo mientras respondía la IA, no guardamos una pregunta obsoleta.
        const updated = Date.now();
        const { rows } = await q(`UPDATE animes SET
          data = jsonb_set(jsonb_set(data, '{script,copy}', COALESCE(NULLIF(data#>'{script,copy}', 'null'::jsonb), '{}'::jsonb) || $2::jsonb), '{updated}', to_jsonb($3::bigint)),
          updated = $3, updated_by = $4
          WHERE id = $1 AND deleted_at IS NULL AND data->'script'->'lines' = $5::jsonb AND data->'story' = $6::jsonb
          RETURNING data`, [pj.id, JSON.stringify({ suggested_comment: comment }), updated, user.id, JSON.stringify(pj.script.lines), JSON.stringify(pj.story)]);
        if (!rows.length) throw new Error('El vídeo cambió. Actualiza la página e inténtalo de nuevo.');
        emit({ type: 'short', project: rows[0].data });
        return { comment };
      });
    }

    // ---- automático: historias del día → un short por historia ----
    if (p === '/api/auto' && req.method === 'POST') {
      const { count = 3, voice } = await readBody(req);
      return task(res, async (emit, track, signal) => {
        const log = (text) => emit({ type: 'log', text });
        const allProjects = await listProjects(TABLE);
        const avoid = allProjects.map((x) => `${x.story?.anime}: ${x.story?.angle}`);
        // Franquicias tratadas en los últimos 8 vídeos para enfriamiento obligatorio
        const recentFranchises = [...new Set(
          allProjects.slice(0, 8).map((x) => franchiseOf(x.story?.anime)).filter(Boolean)
        )];
        log('🔎 Buscando historias de anime con gancho y variedad de franquicias…');
        const learn = await learnFrom();
        if (learn.includes('APRENDIZAJE DE YOUTUBE ANALYTICS') || learn.includes('CONTEXTO PÚBLICO RECIENTE')) log('🧠 Usando Analytics y las señales públicas disponibles de tus Shorts…');
        else if (learn.includes('LO QUE NOS HA FUNCIONADO')) log('🧠 Aprendiendo de tus shorts que mejor funcionaron…');
        const { stories, cost: c0 } = await findStories({ count: Math.min(5, Math.max(1, Number(count) || 3)), avoid, recentFranchises, learn }, emit, track);
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
    // ---- vídeo largo horizontal 16:9 (8-10 min por capítulos) ----
    if (p === '/api/long' && req.method === 'POST') {
      const { topic = '', voice } = await readBody(req);
      return task(res, async (emit, track, signal) => {
        const v = voiceOf(voice);
        emit({ type: 'log', text: `🎙 Voz: ${v.title}` });
        const allProjects = await listProjects(TABLE);
        const avoid = allProjects.map((x) => `${x.story?.anime}: ${x.story?.angle}`);
        const recentFranchises = [...new Set(
          allProjects.slice(0, 8).map((x) => franchiseOf(x.story?.anime)).filter(Boolean)
        )];
        const learn = await learnFrom();
        const started = Date.now();
        const id = `${started.toString(36)}L`;
        const pj = await makeLong({ id, topic, voiceId: v.id, learn, avoid, recentFranchises }, { tts, aligner, mediaDir: MEDIA }, emit, track, signal)
          .catch(async (e) => { throw await resumeLater(id, e, started); });
        pj.voice.title = v.title;
        await saveProject(pj, user.id, TABLE);
        emit({ type: 'short', project: pj });
        return { id: pj.id, duration: pj.duration, cost: pj.cost };
      });
    }
    // ---- rehacer un short o vídeo largo (misma historia/tema, guion y montaje nuevos) ----
    if ((m = p.match(/^\/api\/remake\/([\w-]+)$/)) && req.method === 'POST') {
      const old = await getProject(safeId(m[1]), TABLE);
      if (!old) return sendJSON(res, 404, { error: 'No existe' });
      const { voice } = await readBody(req);
      if (old.kind === 'long') {
        return task(res, async (emit, track, signal) => {
          const v = voiceOf(voice);
          emit({ type: 'log', text: `🎙 Voz: ${v.title}` });
          const started = Date.now();
          const pj = await makeLong({ id: old.id, topic: `${old.story?.anime}: ${old.story?.angle}`, voiceId: v.id, learn: await learnFrom() }, { tts, aligner, mediaDir: MEDIA }, emit, track, signal)
            .catch(async (e) => { throw await resumeLater(old.id, e, started); });
          pj.voice.title = v.title;
          if (old.stats) pj.stats = old.stats;
          if (old.created) pj.created = old.created;
          await saveProject(pj, user.id, TABLE);
          emit({ type: 'short', project: pj });
          return pj;
        });
      }
      return task(res, async (emit, track, signal) => makeAndSave(old.story, voice, user, emit, track, signal, old.id, await learnFrom(), old));
    }
    // ---- re-montar solo el vídeo (mismo guion, mismo audio y misma miniatura) ----
    if ((m = p.match(/^\/api\/remount\/([\w-]+)$/)) && req.method === 'POST') {
      const pj = await getProject(safeId(m[1]), TABLE);
      if (!pj) return sendJSON(res, 404, { error: 'No existe' });
      return task(res, async (emit, _track, signal) => {
        if (pj.kind === 'long') await remountLong(pj, { tts, aligner, mediaDir: MEDIA }, (text) => emit({ type: 'log', text }), signal);
        else await remountProject(pj, { tts, aligner, mediaDir: MEDIA }, (text) => emit({ type: 'log', text }), signal);
        pj.thumbRevision = Date.now();
        await saveProject(pj, user.id, TABLE);
        emit({ type: 'short', project: pj });
        return { ok: true };
      });
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
        const learn = await learnFrom();
        const { tiktok, cost } = await makeTiktok({ id: pj.id, story: pj.story, voiceId, thumb, learn }, { tts, aligner, mediaDir: MEDIA }, emit, track, signal);
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
        const catalogs = (await readdir(dir)).filter((f) => /^tr-.*-cat-v[34]\.json$/.test(f));
        const fallbackVideo = path.join(dir, pj.kind === 'long' ? 'long.mp4' : 'short.mp4');
        const scenes = catalogs.length ? (await Promise.all(catalogs.map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'))))).flat()
          : [{ file: fallbackVideo, s: 1, e: 3 }];
        const context = `${pj.story.anime}: ${pj.story.angle}. ${pj.story.facts}`;
        if (pj.kind === 'long') {
          await makeThumb16x9({ script: pj.script, anime: main, scenes, dir, context }, log, signal);
        } else {
          const thumb = await makeThumb({ script: pj.script, anime: main, scenes, dir, context }, log, signal);
          log('🎬 Poniéndola como primer fotograma del vídeo…');
          await firstFrame(path.join(dir, 'short.mp4'), thumb.small);
          if (pj.tiktok?.video && existsSync(path.join(dir, 'tiktok.mp4'))) await firstFrame(path.join(dir, 'tiktok.mp4'), thumb.small);
        }
        const revision = Date.now();
        // No sobrescribir las estadísticas que se hayan actualizado durante la generación.
        const { rows } = await q(`UPDATE animes SET data = jsonb_set(jsonb_set(data || $2::jsonb,
          '{script,thumb_text}', to_jsonb($5::text)), '{script,thumb_word}', to_jsonb($6::text)), updated = $3, updated_by = $4
          WHERE id = $1 AND deleted_at IS NULL RETURNING data`, [pj.id, JSON.stringify({ thumb: `/media/${pj.id}/thumb-4k.jpg?v=${revision}`, thumbSmall: `/media/${pj.id}/thumb.jpg?v=${revision}`, thumbRevision: revision, updated: revision }), revision, user.id, pj.script.thumb_text || pj.script.title, pj.script.thumb_word || '']);
        if (rows[0]) emit({ type: 'short', project: rows[0].data });
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
