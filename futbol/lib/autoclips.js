// Clips automáticos: 1) Claude elige qué planos ganan con vídeo real y cómo buscarlo; 2) por cada plano se reúnen
// candidatos de YouTube (momentos más vistos de los mejores vídeos) en una rejilla numerada de miniaturas del storyboard;
// 3) Claude MIRA las rejillas y elige el fotograma que muestra lo que dice la voz (o ninguno); 4) se recorta ese trozo.
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeStep } from '../../lib/claude.js';
import * as clips from './clips.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const PER_VIDEO = 4, VIDEOS = 3, BATCH = 4;

const ffmpeg = (args) => new Promise((resolve, reject) => execFile('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], (e, _o, se) => (e ? reject(new Error(se || e.message)) : resolve())));
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// límite de tareas a la vez (YouTube corta si se le pide todo de golpe)
async function pool(items, n, fn) {
  const queue = [...items.entries()];
  const out = [];
  await Promise.all(Array.from({ length: n }, async () => { while (queue.length) { const [i, x] = queue.shift(); out[i] = await fn(x); } }));
  return out;
}

/** La frase de la narración donde entra el plano. */
function sentenceOf(seg, shot) {
  const sentences = String(seg.narration).replace(/\*/g, '').split(/(?<=[.?!…])\s+/);
  const cue = String(shot.cue ?? '').toLowerCase().trim();
  return (cue && sentences.find((s) => s.toLowerCase().includes(cue))) || sentences[0] || '';
}

// ---- 1) qué planos ----
const PICK_SCHEMA = {
  type: 'object',
  properties: { picks: { type: 'array', items: { type: 'object', properties: { shot: { type: 'string' }, query: { type: 'string' } }, required: ['shot', 'query'] } } },
  required: ['picks'],
};

function pickPrompt(segments, durs, max) {
  const lines = segments.flatMap((seg, si) => seg.shots.map((sh, k) => {
    const id = `${si + 1}.${k + 1}`;
    return `${id} · ${(durs[id] ?? 0).toFixed(1)} s · ${sh.media?.type === 'video' ? '[YA ES CLIP] ' : ''}se ve: ${sh.desc} · voz: "${sentenceOf(seg, sh)}"`;
  }));
  return `Este es el guion por planos de un vídeo de fútbol narrado sobre fotos. Elige los planos que quedarían MUCHO mejor con un trozo de vídeo real de YouTube en vez de una foto, como haría un buen editor.

Buenos para vídeo: goles, jugadas, regates, remates, celebraciones en el campo, momentos concretos de un partido (fecha y rival conocidos), presentaciones oficiales en el estadio, la afición en un momento sonado.
Malos para vídeo (mejor foto): retratos, estadios vacíos, trofeos, logotipos, ideas abstractas, datos, momentos de los que no habrá vídeo (infancia, juveniles poco conocidos), contratos y despachos.

Reglas:
- Como mucho ${max} planos. Prefiere los que duran 2-10 s.
- No más de dos clips seguidos: alterna con fotos.
- No elijas los marcados [YA ES CLIP].
- "query": búsqueda de YouTube para encontrar ESE momento, como titulan los vídeos los canales oficiales o de resúmenes: jugador + acción + rival/torneo + año ("Endrick gol Inglaterra Wembley 2024", "Real Madrid vs Stuttgart resumen 2024"). En el idioma en que más vídeos habrá.

${lines.join('\n')}

Devuelve "picks" con "shot" (el número, p. ej. "3.2") y "query".`;
}

// ---- 2) candidatos: rejilla numerada de miniaturas ----
async function candidatesFor(query, dir, tag, log) {
  const found = (await clips.search(query)).filter((v) => v.duration >= 15 && v.duration <= 1800).slice(0, VIDEOS);
  const infos = (await Promise.all(found.map((v) => clips.rawInfo(v.id).then((d) => ({ v, d })).catch(() => null)))).filter(Boolean);
  const cands = [];
  for (const { v, d } of infos) {
    const sb = clips.tilesOf(d, 320);
    if (!sb?.tiles.length) continue;
    // momentos más vistos; si el vídeo no tiene ese dato, puntos repartidos
    let times = clips.peaksOf(d, PER_VIDEO).map((p) => p.t + 1);
    if (!times.length) times = [0.15, 0.35, 0.55, 0.75].map((f) => Math.round(d.duration * f));
    for (const t of times) {
      const tile = sb.tiles.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
      if (cands.some((c) => c.id === v.id && Math.abs(c.t - tile.t) < 3)) continue;
      cands.push({ id: v.id, title: v.title, channel: v.channel, t: tile.t, tile, w: sb.w, h: sb.h });
    }
  }
  if (!cands.length) return null;
  // láminas del storyboard → cada miniatura recortada y numerada → una rejilla de 4 columnas
  const sheets = new Map();
  for (const c of cands) {
    if (!sheets.has(c.tile.url)) {
      const file = path.join(dir, `${tag}-sheet${sheets.size}.jpg`);
      const r = await fetch(c.tile.url, { headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      await writeFile(file, Buffer.from(await r.arrayBuffer()));
      sheets.set(c.tile.url, file);
    }
  }
  const ok = cands.filter((c) => sheets.has(c.tile.url));
  for (const [n, c] of ok.entries()) {
    await ffmpeg(['-i', sheets.get(c.tile.url), '-vf', `crop=${c.w}:${c.h}:${c.tile.x}:${c.tile.y},scale=320:180,drawtext=text='${n + 1}':x=8:y=6:fontsize=40:fontcolor=yellow:box=1:boxcolor=black@0.75:boxborderw=6,format=yuvj420p`, path.join(dir, `${tag}-c${String(n).padStart(2, '0')}.jpg`)]);
  }
  const grid = `${tag}.jpg`;
  const rows = Math.ceil(ok.length / 4);
  await ffmpeg(['-framerate', '1', '-i', path.join(dir, `${tag}-c%02d.jpg`), '-vf', `tile=4x${rows}:padding=6:color=white`, '-frames:v', '1', path.join(dir, grid)]);
  log?.(`   ${tag}: ${ok.length} candidatos de ${infos.length} vídeos`);
  return { grid, cands: ok };
}

// ---- 3) Claude elige mirando ----
const CHOOSE_SCHEMA = {
  type: 'object',
  properties: { choices: { type: 'array', items: { type: 'object', properties: { shot: { type: 'string' }, ranking: { type: 'array', items: { type: 'number' } }, why: { type: 'string' } }, required: ['shot', 'ranking', 'why'] } } },
  required: ['choices'],
};

const choosePrompt = (items) => `Eres el editor de un vídeo de fútbol. Para cada plano hay una rejilla de miniaturas numeradas (número amarillo) sacadas de vídeos de YouTube.
Abre cada rejilla con Read y ordena los números que sirven, del mejor al peor (máximo 3), según lo bien que muestran lo que dice la voz en ese plano. Si ninguno sirve, ranking vacío.

Un candidato sirve si: es imagen real de partido o del momento (no un plató, presentador, tertulia, persona hablando a cámara, miniatura con títulos, collage, gráfico, videojuego, vídeo vertical con bandas desenfocadas ni pantalla partida); se ve la acción o la persona de la que se habla; y encaja con el momento (equipo, camiseta, estadio, época). Si la voz habla de un jugador o persona concreta, tiene que RECONOCERSE en el fotograma (cara, dorsal o nombre en la camiseta); si no se le distingue, no sirve. Un plano general de partido solo vale cuando la voz habla del partido, del equipo o del estadio, no de una persona. Un marcador pequeño o el logo de la cadena en una esquina se acepta. Entre dos buenos, el de imagen más limpia y cercana a la acción. No pongas el mismo momento de un mismo vídeo en dos planos.

${items.map(({ id, sh, sentence, dur, grid, cands }) => `PLANO ${id} (${dur.toFixed(1)} s) · se ve: ${sh.desc} · voz: "${sentence}" · rejilla: ${grid}
${cands.map((c, n) => `  ${n + 1} = «${c.title}» (${c.channel}) en ${fmt(c.t)}`).join('\n')}`).join('\n\n')}

Devuelve "choices": un elemento por plano con "shot" (p. ej. "3.2"), "ranking" (números, el mejor primero; vacío si ninguno) y "why" (breve: qué se ve en el mejor o por qué ninguno sirve).`;

// ---- 4) comprobación del clip ya recortado ----
const VERIFY_SCHEMA = {
  type: 'object',
  properties: { results: { type: 'array', items: { type: 'object', properties: { shot: { type: 'string' }, ok: { type: 'boolean' }, what: { type: 'string' } }, required: ['shot', 'ok', 'what'] } } },
  required: ['results'],
};

const verifyPrompt = (items) => `Cada imagen tiene 3 fotogramas (inicio, mitad y final) de un clip ya recortado que va a ir en un plano de un vídeo de fútbol. Ábrelas con Read y di si el clip sirve.

ok = true solo si en los 3 fotogramas: es imagen real (partido, entrenamiento, presentación…), encaja con lo que dice la voz (si habla de una persona concreta, se la reconoce al menos en uno y nunca se ve a otra persona como protagonista), y no hay plató, presentador, rótulos grandes, pantalla partida, cortinillas de transición, pantalla en negro ni imagen desenfocada. Logos pequeños de cadena o marcador se aceptan.

${items.map(({ it, strip }) => `PLANO ${it.id} · se ve: ${it.sh.desc} · voz: "${it.sentence}" · imagen: ${strip}`).join('\n')}

Devuelve "results" con "shot", "ok" y "what" (qué se ve, breve).`;

/**
 * body: { projectId, segments, durs: { "si.k" (1-based): segundos } }
 * Emite { type:'clip', si, k, media, why } por cada plano resuelto y al final { type:'result' }.
 */
export async function autoClips(body, store, emit, track, signal) {
  const { segments, durs = {}, projectId } = body;
  const total = segments.reduce((n, s) => n + s.shots.length, 0);
  const max = Math.max(1, Math.round(total * 0.25));
  const log = (text) => emit({ type: 'log', text });
  let cost = 0;

  log(`🎬 Eligiendo qué planos van con vídeo (máx. ${max} de ${total})…`);
  const ev = await claudeStep({ prompt: pickPrompt(segments, durs, max), schema: PICK_SCHEMA, system: 'Eres editor de vídeo deportivo.', model: 'sonnet', effort: 'medium', tools: [], cwd: tmpdir() }, emit, track);
  cost += ev.cost ?? 0;
  const picks = (ev.data?.picks ?? []).map((p) => {
    const [si, k] = String(p.shot).split('.').map((x) => Number(x) - 1);
    const sh = segments[si]?.shots[k];
    return sh && sh.media?.type !== 'video' ? { id: `${si + 1}.${k + 1}`, si, k, sh, query: p.query, sentence: sentenceOf(segments[si], sh), dur: durs[`${si + 1}.${k + 1}`] ?? 5 } : null;
  }).filter(Boolean).slice(0, max);
  log(`🎬 ${picks.length} planos: ${picks.map((p) => p.id).join(', ')}`);

  const dir = await mkdtemp(path.join(tmpdir(), 'autoclips-'));
  let placed = 0;
  try {
    log('🔎 Buscando en YouTube y reuniendo los momentos más vistos…');
    const ready = (await pool(picks, 3, async (p) => {
      if (signal?.aborted) return null;
      try { const c = await candidatesFor(p.query, dir, `plano-${p.id.replace('.', '-')}`, log); return c && { ...p, ...c }; }
      catch (e) { log(`⚠️ ${p.id}: ${e.message.slice(0, 120)}`); return null; }
    })).filter(Boolean);

    const chosen = [];
    for (let i = 0; i < ready.length && !signal?.aborted; i += BATCH) {
      const batch = ready.slice(i, i + BATCH);
      log(`👀 Claude mira los candidatos de ${batch.map((b) => b.id).join(', ')}…`);
      const r = await claudeStep({ prompt: choosePrompt(batch), schema: CHOOSE_SCHEMA, system: 'Eres editor de vídeo deportivo. Miras imágenes con la herramienta Read.', model: 'sonnet', effort: 'low', tools: ['Read'], cwd: dir }, (e) => { if (!(e.type === 'log' && /^📚/.test(e.text))) emit(e); }, track);
      cost += r.cost ?? 0;
      for (const c of r.data?.choices ?? []) {
        const it = batch.find((b) => b.id === String(c.shot));
        if (!it) continue;
        const options = (c.ranking ?? []).map((n) => it.cands[Number(n) - 1]).filter(Boolean);
        if (!options.length) { log(`📷 ${it.id}: se queda la foto (${c.why})`); continue; }
        chosen.push({ it, options, why: c.why });
      }
    }

    // recortar el mejor candidato y comprobar el clip de verdad (3 fotogramas nítidos); si falla, el siguiente del ranking
    let pending = chosen.map((x) => ({ ...x, tryN: 0 }));
    const reserved = []; // momentos ya colocados o en prueba: nunca el mismo trozo en dos planos
    const same = (a, b) => a.id === b.id && Math.abs(a.t - b.t) < 8;
    for (let round = 0; round < 3 && pending.length && !signal?.aborted; round++) {
      for (const x of pending) {
        while (x.tryN < x.options.length && reserved.some((u) => same(u, x.options[x.tryN]))) x.tryN++;
        if (x.tryN < x.options.length) reserved.push(x.options[x.tryN]);
        else log(`📷 ${x.it.id}: sus candidatos ya están en otros planos; se queda la foto`);
      }
      pending = pending.filter((x) => x.tryN < x.options.length);
      const cut = (await pool(pending, 2, async (x) => {
        const cand = x.options[x.tryN];
        try {
          const media = await clips.cut(store, projectId, { id: cand.id, start: Math.max(0, cand.t - 0.5), dur: Math.min(12, x.it.dur + 0.8) });
          const strip = `verifica-${x.it.id.replace('.', '-')}-${round}.jpg`;
          const file = store.fileOf(media.url);
          const d = media.dur;
          await ffmpeg(['-i', file, '-vf', `select='eq(n\\,${Math.round(0.3 * 30)})+eq(n\\,${Math.round(d * 15)})+eq(n\\,${Math.max(0, Math.round((d - 0.4) * 30))})',scale=640:360,tile=3x1:padding=6:color=white`, '-frames:v', '1', '-fps_mode', 'vfr', path.join(dir, strip)]);
          return { ...x, cand, media, strip };
        } catch (e) { log(`⚠️ ${x.it.id}: no se pudo recortar (${e.message.slice(0, 100)})`); return { ...x, cand, failed: true }; }
      })).filter(Boolean);
      const toCheck = cut.filter((x) => !x.failed);
      const verdict = new Map();
      for (let i = 0; i < toCheck.length && !signal?.aborted; i += BATCH) {
        const batch = toCheck.slice(i, i + BATCH);
        log(`🔬 Comprobando los clips recortados de ${batch.map((b) => b.it.id).join(', ')}…`);
        const r = await claudeStep({ prompt: verifyPrompt(batch), schema: VERIFY_SCHEMA, system: 'Eres editor de vídeo deportivo. Miras imágenes con la herramienta Read.', model: 'sonnet', effort: 'low', tools: ['Read'], cwd: dir }, (e) => { if (!(e.type === 'log' && /^📚/.test(e.text))) emit(e); }, track);
        cost += r.cost ?? 0;
        for (const v of r.data?.results ?? []) verdict.set(String(v.shot), v);
      }
      pending = [];
      for (const x of cut) {
        const v = verdict.get(x.it.id);
        if (!x.failed && v?.ok) {
          emit({ type: 'clip', si: x.it.si, k: x.it.k, media: x.media, why: v.what });
          log(`✅ ${x.it.id}: ${v.what} («${x.cand.title}», ${fmt(x.cand.t)})`);
          placed++;
        } else if (x.tryN + 1 < x.options.length) {
          if (v) log(`↩️ ${x.it.id}: ${v.what} → pruebo el siguiente candidato`);
          pending.push({ ...x, tryN: x.tryN + 1 });
        } else log(`📷 ${x.it.id}: ningún clip pasó la comprobación${v ? ` (${v.what})` : ''}; se queda la foto`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { placed, picked: picks.length, cost };
}
