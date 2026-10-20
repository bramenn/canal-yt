// Montaje del short vertical (1080×1920) con ffmpeg, editado como un profesional (lib/editor.js): las escenas de los
// tráileres/PV del anime se catalogan (qué se ve, quién sale, plano, acción) y un editor IA decide qué escena va en cada
// corte según lo que dice la voz (cortes de 1,5-3 s en las pausas, sin repetir toma, el gancho con el plano más potente);
// acercamiento rápido en las palabras resaltadas, whoosh y golpe en el clímax, revisión final del montaje; subtítulos
// ASS de 1-2 palabras y la marca del canal.
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { run, ytdlp, search } from '../../lib/ytdlp.js';
import { downloadImages as images } from '../../lib/brave.js';
import { claudeStep } from '../../lib/claude.js';
import { pickRelevant } from '../../lib/imagepick.js';
import { cutSlots, planEdit, reviewEdit, sfxTrack, dhash, groupTakes, enforce } from '../../lib/editor.js';
import { FONTS } from '../../lib/thumbnail.js';
import { W, H, wordEvents, assDoc } from '../../lib/subs.js';
import { makeThumb } from './thumb.js';

export const BRAND = '@notianimes';
const FPS = 30;
// vídeos de reacción/análisis: salen personas, webcams y anuncios encima del anime
const REACTION = /react|reacci|reaccion|analysis|análisis|analisis|explained|review|resumen|theory|teoría/i;
const ff = (args, timeout = 600000) => run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], timeout);
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]/g, '');

// ---------- fuentes ----------
/** Escenas limpias de los tráileres/PV del anime en YouTube (vídeos hasta tener ~20, máx. 4; una vez por anime y proyecto). */
async function trailer(query, dir, log, context = '', exact = false) {
  const slug = norm(query).slice(0, 40) || 'anime';
  // Cambia el nombre cuando cambia el criterio visual: no reutilizar catálogos creados antes de filtrar retículas y texto.
  const scenesFile = path.join(dir, `tr-${slug}-cat-v3.json`);
  if (existsSync(scenesFile)) return { scenes: JSON.parse(await readFile(scenesFile, 'utf8')) };
  // primero el PV japonés (sin subtítulos); anuncios nuevos aún no tienen tráiler: opening o cada parte del nombre
  const parts = String(query).split(/\s+(?:x|×|&|y)\s+|:\s*/i).filter((x) => x.trim() && x !== query);
  const tries = exact ? [query] : [`${query} PV`, `${query} anime trailer`, `${query} anime opening`, ...parts.map((x) => `${x} anime PV`)];
  const scenes = [], seen = new Set();
  let videos = 0, err = null, first = null;
  // YouTube corta a ratos (403): otro formato y, si no, el siguiente vídeo
  find: for (const q of tries) {
    for (const cand of (await search(q, 8).catch(() => [])).filter((x) => x.duration >= 30 && x.duration <= 600 && !seen.has(x.id) && !REACTION.test(x.title)).slice(0, 2)) {
      seen.add(cand.id);
      const file = path.join(dir, `tr-${slug}-${videos}.mp4`);
      for (const fmt of ['bv*[height<=1080][vcodec^=avc1]/bv*[height<=1080]', 'bv*[height<=1080]/b']) {
        try {
          await ytdlp(['-q', '-f', fmt, '--merge-output-format', 'mp4', '-o', file, `https://www.youtube.com/watch?v=${cand.id}`], 300000);
        } catch (e) { err = e; continue; }
        log(`🎞 Tráiler de «${query}»: ${cand.title} (${cand.channel})`);
        videos++;
        first ??= { file, dur: cand.duration };
        scenes.push(...await catalogScenes(file, await scenesOf(file, cand.duration), dir, log, `${query}. ${context}`, exact).catch((e) => { log(`⚠️ Sin revisar escenas: ${e.message.slice(0, 120)}`); return []; }));
        break;
      }
      if (scenes.length >= 20 || videos >= 4) break find;
    }
  }
  if (!first) throw new Error(`No encuentro tráiler de «${query}»${err ? ` (${err.message.slice(0, 80)})` : ''}`);
  // Un PV lleno de overlays, manga o planos descartados no es una fuente útil: las imágenes limpias son mejor respaldo.
  if (scenes.length < 5) throw new Error(`El tráiler de «${query}» no tiene suficientes escenas limpias`);
  await writeFile(scenesFile, JSON.stringify(scenes));
  return { scenes };
}

/** La imagen principal (og:image) de cada noticia de la historia: suele ser justo lo que se cuenta (el post, la foto, el anuncio). */
async function newsImages(urls = [], dir) {
  const out = [];
  for (const [k, u] of urls.slice(0, 4).entries()) {
    try {
      const html = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) })).text();
      const meta = (p) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']+)`, 'i'))?.[1]
        ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${p}["']`, 'i'))?.[1];
      const img = meta('og:image') ?? meta('twitter:image');
      if (!img) continue;
      const res = await fetch(new URL(img.replace(/&amp;/g, '&'), u), { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const file = path.join(dir, `news-${k}.img`);
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      const [w, h] = (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])).trim().split(',').map(Number);
      if (w >= 400 && h >= 300) out.push({ file, title: (meta('og:title') ?? '').replace(/&[#\w]+;/g, ' ').slice(0, 120) });
    } catch { /* noticia sin imagen o caída: no pasa nada */ }
  }
  return out;
}

/** Planos del vídeo (cambios de escena) enteros, sin el principio (logos), el final (créditos) ni negros. */
async function scenesOf(file, dur) {
  const out = await new Promise((resolve) => execFile('ffmpeg', ['-nostdin', '-i', file, '-an', '-vf', "scale=320:-2,blackdetect=d=0.1:pix_th=0.1,select='gt(scene,0.22)',showinfo", '-f', 'null', '-'],
    { maxBuffer: 64 << 20, timeout: 300000 }, (_e, _o, err) => resolve(String(err))));
  const cuts = [...out.matchAll(/pts_time:([\d.]+)/g)].map((m) => +m[1]);
  const blacks = [...out.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  const edges = [0, ...cuts, dur].sort((a, b) => a - b);
  return edges.slice(0, -1).map((s, i) => ({ file, s: s + 0.08, e: edges[i + 1] - 0.08 }))
    .filter((x) => x.e - x.s >= 1.0 && x.s > dur * 0.05 && x.e < dur * 0.92 && !blacks.some(([a, b]) => a < x.e && b > x.s));
}

/**
 * Catálogo de escenas: la IA mira una rejilla con un fotograma de cada una y describe qué se ve, quién sale (si se le
 * reconoce), el plano, la acción y la emoción; quita las que no sirven (texto grande, logos, personas reales, negro) y
 * marca las mejores para miniatura.
 */
async function catalogScenes(file, scenes, dir, log, context, real = false) {
  const all = scenes.slice(0, 64);
  if (!all.length) { log('👀 Escenas del tráiler: ninguna útil'); return []; }
  const bad = new Set();
  // de 16 en 16: con rejillas grandes la IA se deja escenas sin describir
  for (let b = 0; b < all.length; b += 16) {
    const pick = all.slice(b, b + 16);
    const tag = path.join(dir, `grid-${path.basename(file, '.mp4')}-${b}`);
    for (const [i, x] of pick.entries()) {
      await ff(['-ss', String((x.s + x.e) / 2), '-i', file, '-frames:v', '1', '-vf', `scale=320:180:force_original_aspect_ratio=increase,crop=320:180,drawtext=text='${i + 1}':x=6:y=4:fontsize=34:fontcolor=yellow:box=1:boxcolor=black@0.75:boxborderw=4,format=yuvj420p`, `${tag}-${String(i).padStart(2, '0')}.jpg`]);
    }
    await ff(['-framerate', '1', '-i', `${tag}-%02d.jpg`, '-vf', `tile=4x${Math.ceil(pick.length / 4)}:padding=4:color=white`, '-frames:v', '1', `${tag}.jpg`]);
    const ev = await claudeStep({
      prompt: `Lee la imagen ${path.basename(tag)}.jpg: es una rejilla numerada (1-${pick.length}) con un fotograma de cada escena de ${real ? 'un vídeo real del que habla la noticia' : 'un tráiler de anime'} (${context}).
Para CADA una de las ${pick.length} escenas devuelve en "scenes": "n" (número), "desc" (qué se ve, ≤ 12 palabras, concreto), "who" (qué personaje sale, por su nombre si lo reconoces por el anime y la historia, o una descripción breve: «chica pelirroja con delantal»; vacío si no sale nadie), "shot" (primer plano | plano medio | plano general | detalle), "action" (0 quieto … 3 mucha acción), "emotion" (una palabra).
En "thumb" hasta 2 números de escenas que serían una buena miniatura (primer plano con emoción clara, nítido).
En "bad" las que NO sirven: texto grande o en el centro (títulos, créditos, fechas, logos, carteles, portadas de manga o títulos japoneses), retículas/miras/interfaz gráfica que cubran la imagen, viñetas o páginas de manga, dibujos en blanco y negro, imágenes estáticas promocionales con texto, ${real ? '' : 'personas reales, webcams o anuncios, '}pantallas negras o casi vacías, muy borrosas. Acepta solo fotogramas ${real ? 'nítidos del vídeo (personas, lugares y objetos reales valen)' : 'de animación a color'}, sin texto dominante; los subtítulos pequeños abajo no importan (se recortan).`,
      schema: {
        type: 'object',
        properties: {
          scenes: { type: 'array', items: { type: 'object', properties: { n: { type: 'number' }, desc: { type: 'string' }, who: { type: 'string' }, shot: { type: 'string' }, action: { type: 'number' }, emotion: { type: 'string' } }, required: ['n', 'desc', 'who', 'shot', 'action', 'emotion'] } },
          thumb: { type: 'array', items: { type: 'number' } }, bad: { type: 'array', items: { type: 'number' } },
        },
        required: ['scenes', 'thumb', 'bad'],
      },
      system: 'Eres editor de vídeo y experto en anime. Miras imágenes con la herramienta Read.', model: 'sonnet', effort: 'low', tools: ['Read'], cwd: dir,
    }, () => {}, () => {}).catch(() => ({ data: {} }));
    for (const n of ev.data.bad ?? []) bad.add(b + Number(n) - 1);
    // «ninguno», «nadie», «-»… = no sale nadie
    for (const d of ev.data.scenes ?? []) { const x = pick[d.n - 1]; if (x) Object.assign(x, { desc: d.desc, who: /^(ningun[oa]?|nadie|none|n\/a|-|—|sin personajes?)$/i.test(String(d.who ?? '').trim()) ? '' : d.who, shot: d.shot, action: d.action, emotion: d.emotion }); }
    (ev.data.thumb ?? []).forEach((n, r) => { if (pick[n - 1]) pick[n - 1].thumb = r + 1 + b; });
  }
  const good = all.filter((x, i) => !bad.has(i));
  for (const x of good) { x.desc ||= 'escena del anime'; x.hash = await dhash(file, (x.s + x.e) / 2); }
  log(`👀 Escenas del tráiler: ${good.length} útiles de ${all.length} (${good.filter((x) => x.desc !== 'escena del anime').length} descritas)`);
  return good;
}

// ---------- tiempos ----------
/** Inicio y fin de cada frase del guion a partir de las palabras alineadas (por recuento de palabras). */
function lineTimes(lines, words, total) {
  let k = 0;
  return lines.map((l, i) => {
    const n = String(l.text).split(/\s+/).filter(Boolean).length;
    const s = i ? (words[k]?.s ?? total) : 0;
    k += n;
    return { ...l, s };
  }).map((l, i, a) => ({ ...l, e: a[i + 1]?.s ?? total }));
}

// ---------- subtítulos (lib/subs.js) ----------
const subtitles = (words, script, total) => assDoc({ events: wordEvents(words, script, total), brand: BRAND, total });

// ---------- montaje ----------
/** Clip de un corte. Vídeo: una parte de la escena (otra cada vez que se reutiliza); foto: acercamiento lento.
 *  emph: segundo del corte en que suena una palabra resaltada → acercamiento rápido («punch-in») desde ahí. */
async function renderCut(c, item, uses, out) {
  const dur = +(c.e - c.s).toFixed(3);
  const frames = Math.max(1, Math.round(dur * FPS));
  if (!item) throw new Error(`El editor no asignó material al corte ${c.i + 1}`);
  // zoompan expresa `on` en fotogramas, mientras emph llega en segundos relativos al corte.
  const punchAt = c.emph == null ? null : Math.max(0, Math.round(c.emph * FPS));
  const punch = punchAt == null ? '' : `if(gte(on,${punchAt}),min(0.12,0.12*(on-${punchAt})/${Math.max(1, Math.round(FPS * 0.15))}),0)`;
  if (item.kind === 'image') {
    const z = punch ? `min(1.12,1+0.06*on/${frames}+${punch})` : `1+0.06*on/${frames}`;
    await ff(['-i', item.file, '-vf', `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS},format=yuv420p`, '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', out]);
    return;
  }
  const len = item.e - item.s;
  // la primera vez, centrado en el fotograma que la IA vio y describió; al reutilizar, otra parte (sin los bordes, que
  // suelen ser transiciones borrosas); si la escena es más corta que el corte, un poco más lenta
  const lo = item.s + Math.min(0.2, len / 6), room = Math.max(0, item.e - Math.min(0.2, len / 6) - lo - dur);
  const mid = Math.min(Math.max(lo, (item.s + item.e) / 2 - dur / 2), lo + room);
  const start = len > dur ? (uses ? lo + ((uses * 0.618) % 1) * room : mid) : item.s;
  const slow = Math.max(1, dur / Math.max(0.5, len));
  const zoom = punch ? `,zoompan=z='min(1.12,1+${punch})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}` : '';
  await ff(['-ss', String(start), '-t', String(dur / slow + 0.05), '-i', item.file, '-an', '-vf', `setpts=${slow.toFixed(3)}*PTS,scale=${Math.round(W * 1.25)}:${Math.round(H * 1.25)}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-ow)/2:(ih-oh)*0.2,fps=${FPS}${zoom},format=yuv420p`, '-t', String(dur), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out]);
}

/**
 * script: { lines: [{ text, show, query }], yellow, red }, voice: mp3, words: [{ w, s, e }] (alineadas); context: de
 * qué va (historia y personajes). Devuelve { video, thumb }.
 */
export async function montage({ script, voice, words, duration, dir, name = 'short', thumb = null, context = '', sources: news = [] }, log, signal) {
  await mkdir(dir, { recursive: true });
  const total = duration + 0.3;
  const lines = lineTimes(script.lines, words, total);
  // catálogo: escenas de los tráileres de cada anime del guion y fotos de las frases «imagen» que encajen
  const catalog = [];
  const animes = [...new Set(script.lines.filter((l) => l.show === 'anime').map((l) => l.query))];
  const sources = new Map();
  for (const q of animes) {
    const t = await trailer(q, dir, log, context).catch((e) => { log(`⚠️ ${e.message}: uso imágenes`); return null; });
    sources.set(q, t);
    if (t) t.scenes.forEach((x) => catalog.push({ ...x, kind: 'video', anime: q, id: `V${catalog.length + 1}` }));
    else {
      const clean = `${q} anime official artwork clean no text`;
      (await pickRelevant(await images(clean, dir), clean, context, dir)).forEach((f) => catalog.push({ kind: 'image', file: f, anime: q, id: `F${catalog.length + 1}`, desc: `imagen de ${q}`, who: 'personajes del anime', shot: 'plano medio', action: 1 }));
    }
    // Más variedad: solo arte promocional limpio. Las portadas del manga suelen meter títulos enormes y arruinan el
    // ritmo visual, aunque la búsqueda las considere «relevantes».
    for (const extra of [`${q} anime official key visual clean no text`]) {
      for (const f of (await pickRelevant(await images(extra, dir), extra, context, dir)).slice(0, 3)) catalog.push({ kind: 'image', file: f, anime: q, id: `F${catalog.length + 1}`, desc: `arte oficial: ${extra.replace(q, '').trim()}`, who: 'personajes del anime', shot: 'plano medio', action: 1, hash: await dhash(f) });
    }
  }
  for (const [line, l] of script.lines.entries()) if (l.show === 'imagen') {
    // Las búsquedas «manga cover/portada» devuelven casi siempre una portada llena de texto. Para el dato usamos
    // arte promocional limpio del anime; la frase ya aporta la cifra y no necesitamos mostrar una portada ilegible.
    const query = /manga\s*(cover|portada)|portada\s*(del|de)?\s*manga/i.test(l.query)
      ? `${animes[0] ?? l.query} anime official key visual clean no text`
      : `${l.query} official photo clean no text`;
    (await pickRelevant(await images(query, dir), query, context, dir)).slice(0, 3).forEach((f) => catalog.push({ kind: 'image', file: f, line, id: `F${catalog.length + 1}`, desc: l.query, shot: 'foto', action: 0 }));
  }
  // lo que se cuenta, tal cual: el vídeo concreto de las frases «video» y la foto de cada noticia
  // ponytail: como mucho 2 vídeos distintos (las búsquedas parecidas devuelven el mismo clip y cada uno se revisa con IA)
  const videoLines = [...script.lines.entries()].filter(([, l]) => l.show === 'video');
  for (const [line, l] of videoLines.filter(([, l], k) => videoLines.findIndex(([, m]) => norm(m.query) === norm(l.query)) === k).slice(0, 2)) {
    const t = await trailer(l.query, dir, log, context, true).catch((e) => { log(`⚠️ Vídeo «${l.query}»: ${e.message.slice(0, 100)}`); return null; });
    if (t) t.scenes.forEach((x) => catalog.push({ ...x, kind: 'video', line, id: `V${catalog.length + 1}`, desc: `vídeo real «${l.query}»: ${x.desc ?? ''}` }));
    else (await pickRelevant(await images(l.query, dir), l.query, context, dir)).slice(0, 3).forEach((f) => catalog.push({ kind: 'image', file: f, line, id: `F${catalog.length + 1}`, desc: l.query, shot: 'foto', action: 0 }));
  }
  const newsPics = await newsImages(news, dir);
  if (newsPics.length) log(`📰 ${newsPics.length} foto${newsPics.length === 1 ? '' : 's'} de las noticias: ${newsPics.map((n) => n.title.slice(0, 50)).join(' · ')}`);
  for (const n of newsPics) catalog.push({ kind: 'image', file: n.file, id: `F${catalog.length + 1}`, desc: `foto de la noticia: ${n.title}`, who: '', shot: 'foto', action: 0 });
  if (!catalog.length) throw new Error('Sin escenas ni imágenes para montar');
  // Las imágenes de respaldo también deben participar en la detección de tomas casi iguales.
  for (const item of catalog) if (item.kind === 'image' && !item.hash) item.hash = await dhash(item.file);
  const takes = groupTakes(catalog);
  // El ritmo no se relaja por tener poco material: un short necesita cambios visuales frecuentes. Si faltan tomas,
  // el editor reutiliza una parte distinta de una escena antes que dejar un plano estático de 4-5 segundos.
  // medido (2026-10): AniDosis cambia de imagen cada ~1 s; con nuestro material, ~1,9 s cortando en las pausas
  const target = 1.9;
  const slots = cutSlots(lines, words, script, { min: 1.3, target, max: 2.6, hook: 2 });
  log(`🎬 Editor IA: ${slots.length} cortes de ~${target.toFixed(1)} s con ${catalog.length} planos (${takes} tomas distintas)…`);
  const { plan, climax, motion } = await planEdit({ slots, lines, catalog, context }, log);
  // el gancho (2 primeros s) siempre con primeros planos de personajes distintos, los de más acción primero: medido,
  // los virales abren con caras y emoción, y la IA a veces elige planos abstractos
  const faces = catalog.filter((c) => c.kind !== 'image' && c.who && /primer/i.test(c.shot ?? '')).sort((a, b) => (b.action ?? 0) - (a.action ?? 0));
  slots.forEach((x, i) => { if (x.s < 2 && faces[i]) plan[i] = faces[i].id; });
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const uses = new Map();
  const parts = [];
  const render = async (i) => {
    const id = plan[i];
    const k = uses.get(id) ?? 0;
    uses.set(id, k + 1);
    const out = path.join(dir, `cut-${name}-${String(i).padStart(3, '0')}.mp4`);
    await renderCut(slots[i], byId.get(id), k, out);
    parts[i] = out;
  };
  for (let i = 0; i < slots.length; i++) { if (signal?.aborted) throw new Error('Cancelado'); await render(i); }
  // revisión final: la IA mira el montaje y rehace los cortes que fallan
  const frames = [];
  for (const [i, p] of parts.entries()) { const f = `${p}.jpg`; await ff(['-ss', String((slots[i].e - slots[i].s) / 2), '-i', p, '-frames:v', '1', f]); frames.push(f); }
  const fixes = await reviewEdit({ frames, slots, plan, catalog, context, dir });
  for (const [i, f] of Object.entries(fixes)) plan[i] = f.id;
  // los reemplazos tampoco pueden repetir toma cerca: se vuelven a aplicar las reglas y se rehace lo que cambie
  const before = [...plan];
  enforce(plan, catalog, { slotLines: slots.map((x) => x.line) }).plan.forEach((id, i) => { plan[i] = id; });
  for (let i = 0; i < plan.length; i++) if (fixes[i] || plan[i] !== before[i]) await render(i);
  log(`✂️ ${parts.length} cortes montados${Object.keys(fixes).length ? ` · revisión: ${Object.keys(fixes).length} rehecho${Object.keys(fixes).length === 1 ? '' : 's'} (${Object.values(fixes).map((f) => f.why).join('; ').slice(0, 160)})` : ' · revisión: todo bien'}`);
  const list = path.join(dir, `cuts-${name}.txt`);
  await writeFile(list, parts.map((p) => `file '${p}'`).join('\n'));
  const ass = path.join(dir, `subs-${name}.ass`);
  await writeFile(ass, subtitles(words, script, total));
  // miniatura: del mejor primer plano del anime principal (o del primer corte si solo hubo imágenes)
  const main = animes[0] ?? script.lines[0].query;
  const scenes = sources.get(main)?.scenes ?? [{ file: parts[0], s: 0, e: 1 }];
  thumb ??= await makeThumb({ script, anime: main, scenes, dir, context }, log, signal); // la versión TikTok reutiliza la de YouTube
  // sonido: whoosh en los cortes con movimiento (no más de uno cada 3 s) y golpe en el clímax
  let last = -9;
  const whooshAt = motion.map((i) => slots[i].s).filter((t) => t > 0.5 && t - last >= 3 && (last = t));
  const sfx = await sfxTrack({ whooshAt, impactAt: slots[climax]?.s ?? null, total, dir }).catch(() => null);
  const final = path.join(dir, `${name}.mp4`);
  // el primer fotograma es la miniatura: solo 2 fotogramas, para poder elegirla de portada sin que se vea una tarjeta
  // fija al empezar (medido en TikTok: la gente se va en el segundo 0:01-0:02)
  await ff(['-f', 'concat', '-safe', '0', '-i', list, '-i', voice, '-loop', '1', '-t', String(total), '-i', thumb.small, ...(sfx ? ['-i', sfx] : []),
    '-filter_complex', `[0:v]subtitles=${ass}:fontsdir=${FONTS}[v];[2:v]scale=${W}:${H}[t];[v][t]overlay=enable='lt(t,0.066)'[o]${sfx ? ';[3:a]volume=0.45[s];[1:a][s]amix=inputs=2:normalize=0:duration=first[a]' : ''}`,
    '-map', '[o]', '-map', sfx ? '[a]' : '1:a',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-t', String(total), '-movflags', '+faststart', final]);
  return { video: final, thumb };
}
