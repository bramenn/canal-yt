// Miniaturas: Claude propone conceptos (texto sugerente + fondo temático + jugador + títulos que juegan con la miniatura),
// se buscan fotos del jugador y del fondo, Claude MIRA los candidatos y elige, y el jugador se recorta (rembg).
// La composición final se dibuja en el navegador (editable).
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeStep } from '../../lib/claude.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_PY = path.join(HERE, '..', '..', '.tools/venv/bin/python');
const PY = process.env.IMG_PYTHON || (existsSync(LOCAL_PY) ? LOCAL_PY : 'python3');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const CANDS = 8;

const run = (bin, args, timeout = 180000) => new Promise((resolve, reject) => execFile(bin, args, { timeout }, (e, out, se) => (e ? reject(new Error(String(se).trim().split('\n').pop() || e.message)) : resolve(out))));
const ffmpeg = (args) => run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args]);

async function pool(items, n, fn) {
  const queue = [...items.entries()];
  const out = [];
  await Promise.all(Array.from({ length: n }, async () => { while (queue.length) { const [i, x] = queue.shift(); out[i] = await fn(x); } }));
  return out;
}

// ---- 1) conceptos ----
const IDEAS_SCHEMA = {
  type: 'object',
  properties: {
    concepts: {
      type: 'array', minItems: 3, maxItems: 3,
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' }, highlight: { type: 'string' }, sticker: { type: 'string' }, side: { type: 'string', enum: ['left', 'right'] },
          player: { type: 'string' }, kit: { type: 'string' }, player_query: { type: 'string' }, bg_desc: { type: 'string' }, bg_query: { type: 'string' },
          titles: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
        },
        required: ['text', 'highlight', 'sticker', 'side', 'player', 'kit', 'player_query', 'bg_desc', 'bg_query', 'titles'],
      },
    },
  },
  required: ['concepts'],
};

function ideasPrompt({ title, segments }) {
  const story = segments.map((s) => `- ${s.section}: ${String(s.narration).replace(/\*/g, '').split(/(?<=[.?!])\s+/).slice(0, 2).join(' ')}`).join('\n');
  return `Diseña 3 conceptos DISTINTOS de miniatura para este vídeo de YouTube de fútbol, cada uno con 3 títulos que jueguen con esa miniatura.

Título de trabajo: ${title}
Historia:
${story}

Cómo es la miniatura del género: el protagonista recortado en grande a un lado; de fondo, la temática de lo que se cuenta (el estadio, el club, el entrenador, el trofeo, el rival, el momento clave); y un texto corto y sugerente que engancha.
- "player": el protagonista del vídeo (nombre completo). "kit": la camiseta que debe llevar en la miniatura, la del club o selección de la que trata el ángulo ("Real Madrid"). "player_query": búsqueda de imágenes para una foto nítida de él con esa camiseta ("Arda Güler Real Madrid 2025").
- "bg_desc" y "bg_query": el fondo temático, que NO sea otra foto del protagonista ("Santiago Bernabéu de noche lleno", "Xabi Alonso en la banda del Real Madrid", "trofeo Champions League"). La búsqueda, en el idioma con más fotos.
- "text": 2-4 palabras en mayúsculas que provoquen curiosidad, emoción o polémica sin contarlo todo ("NADIE LO QUIERE", "¿Y AHORA QUÉ?", "EL ERROR DE ANCELOTTI"). "highlight": UNA palabra de "text" que irá en color.
- "sticker": cifra o dato corto que refuerce ("60M€", "1 TITULARIDAD") o "" si no aporta.
- "side": dónde va el jugador ("right" o "left"); el texto va al otro lado.
- "titles": 3 títulos con el formato del canal (MAYÚSCULAS en las palabras clave, ≤ 70 caracteres, puede acabar en #club). Deben JUGAR con la miniatura: el título da el contexto y la miniatura el giro o la emoción, se completan como pregunta y respuesta o como promesa y prueba. NUNCA repitas en el título las palabras del texto de la miniatura.
Los 3 conceptos deben apostar por ángulos distintos (p. ej. la polémica, la cifra, el personaje enfrentado).`;
}

// ---- 2) candidatos en rejilla numerada, Claude elige mirando ----
export async function gridOf(items, dir, tag, cell) {
  const ok = [];
  await pool(items.slice(0, CANDS * 2), 4, async (it) => {
    if (ok.length >= CANDS) return;
    if (it.file) { ok.push(it); return; } // foto del propio proyecto, ya en disco
    try {
      const r = await fetch(it.url, { headers: { 'User-Agent': UA, Accept: 'image/*' }, signal: AbortSignal.timeout(15000) });
      const type = r.headers.get('content-type') ?? '';
      if (!r.ok || !/^image\/(jpeg|png|webp)/.test(type)) return;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 20000 || ok.length >= CANDS) return;
      const file = path.join(dir, `${tag}-src${ok.length}-${Math.random().toString(36).slice(2, 6)}`);
      await writeFile(file, buf);
      ok.push({ ...it, file, type });
    } catch {}
  });
  const [w, h] = cell;
  // todas las casillas con el mismo formato de color: si cambia a mitad, ffmpeg reinicia la rejilla y pierde las anteriores
  for (const [n, c] of ok.entries()) {
    await ffmpeg(['-i', c.file, '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=gray,drawtext=text='${n + 1}':x=8:y=6:fontsize=36:fontcolor=yellow:box=1:boxcolor=black@0.75:boxborderw=6,format=yuvj420p`, '-frames:v', '1', path.join(dir, `${tag}-c${String(n).padStart(2, '0')}.jpg`)]).catch(() => {});
  }
  if (!ok.length) return null;
  await rm(path.join(dir, `${tag}.jpg`), { force: true });
  await ffmpeg(['-framerate', '1', '-i', path.join(dir, `${tag}-c%02d.jpg`), '-vf', `tile=4x${Math.ceil(ok.length / 4)}:padding=6:color=white`, '-frames:v', '1', path.join(dir, `${tag}.jpg`)]);
  return { grid: `${tag}.jpg`, cands: ok };
}

const PICK_SCHEMA = {
  type: 'object',
  properties: { pick: { type: 'number' }, why: { type: 'string' } },
  required: ['pick', 'why'],
};

const CRITERIA = {
  player: (c) => `fotos candidatas de ${c.player}. Elige la mejor para RECORTARLO y ponerlo en grande: es claramente ${c.player} (no otro jugador), lleva la camiseta de ${c.kit} (obligatorio: con otra camiseta no sirve), una sola persona protagonista, cara visible y nítida, de cintura o pecho para arriba, buena resolución, expresión con fuerza (celebrando, serio, gritando, mirando a cámara), sin marcas de agua ni texto encima, sin otras personas tapándolo.`,
  bg: (c) => `fondos candidatos para "${c.bg_desc}". Elige el que mejor cuenta esa temática, apaisado, nítido, sin marcas de agua ni texto grande encima. Si el fondo es una persona, tiene que verse GRANDE y reconocible (primer plano o plano medio), no pequeña al fondo de la escena.`,
};
const pickPrompt = (kind, c, g) => `Vas a elegir una foto para una miniatura de YouTube. Abre con Read la rejilla ${g.grid} (números amarillos): ${CRITERIA[kind](c)} Si ninguna sirve, 0.
Devuelve "pick" (el número) y "why" (breve).`;

/** body: { projectId, title, segments, photos: [{ url, desc }] (fotos limpias del proyecto) }. Emite logs; devuelve { concepts: [...con player/bg/cut] , cost }. */
export async function makeThumbs(body, store, emit, track) {
  const log = (text) => emit({ type: 'log', text });
  const quiet = (e) => { if (!(e.type === 'log' && /^📚/.test(e.text))) emit(e); };
  let cost = 0;
  log('💡 Pensando 3 miniaturas y sus títulos…');
  const ev = await claudeStep({ prompt: ideasPrompt(body), schema: IDEAS_SCHEMA, system: 'Eres el diseñador de miniaturas y el titulador de un canal de fútbol de YouTube en español latino. Sabes qué hace que la gente haga clic sin engañarla.', model: 'sonnet', effort: 'medium', tools: [], cwd: tmpdir() }, emit, track);
  cost += ev.cost ?? 0;
  const concepts = ev.data?.concepts ?? [];
  const dir = await mkdtemp(path.join(tmpdir(), 'thumbs-'));
  const usedPlayers = new Set();
  try {
    const built = await pool(concepts, 2, async (c, n = concepts.indexOf(c)) => {
      try {
        log(`🔎 Miniatura ${n + 1} («${c.text}»): buscando fotos de ${c.player} y del fondo…`);
        // el jugador: primero sus fotos del proyecto (ya revisadas), luego otras búsquedas si Claude no ve ninguna buena
        const surname = c.player.trim().split(/\s+/).pop().toLowerCase();
        const own = (body.photos ?? []).filter((x) => String(x.desc).toLowerCase().includes(surname)).flatMap((x) => { try { return [{ url: x.url, file: store.fileOf(x.url), type: /\.png$/.test(x.url) ? 'image/png' : 'image/jpeg', credit: x.credit }]; } catch { return []; } });
        const choose = async (kind, sources) => {
          for (const [round, src] of sources.entries()) {
            const items = typeof src === 'string' ? (await store.search(src).catch(() => ({ items: [] }))).items : src;
            const list = kind === 'bg' ? items.filter((x) => !x.width || x.width >= x.height) : items;
            const g = await gridOf(list, dir, `m${n}-${kind}${round}`, kind === 'player' ? [240, 300] : [320, 180]);
            if (!g) continue;
            const r = await claudeStep({ prompt: pickPrompt(kind, c, g), schema: PICK_SCHEMA, system: 'Eres diseñador de miniaturas. Miras imágenes con la herramienta Read.', model: 'sonnet', effort: 'low', tools: ['Read'], cwd: dir }, quiet, track);
            cost += r.cost ?? 0;
            const hit = g.cands[r.data.pick - 1];
            if (hit) return hit;
            log(`↩️ Miniatura ${n + 1}: ${kind === 'player' ? 'foto del jugador' : 'fondo'} no válido (${r.data.why.slice(0, 90)}); pruebo otra búsqueda`);
          }
          throw new Error(`no encontré ${kind === 'player' ? `una buena foto de ${c.player}` : 'un fondo'}`);
        };
        log(`👀 Miniatura ${n + 1}: Claude elige la foto del jugador y el fondo…`);
        // cada miniatura parte de fotos propias distintas, y nunca repite la foto que ya usa otra
        const mine = own.filter((_, i) => i % concepts.length === n).slice(0, 4);
        const fresh = (items) => items.filter((x) => !usedPlayers.has(x.url));
        const ownAndSearch = async () => fresh([...mine, ...(await store.search(c.player_query).catch(() => ({ items: [] }))).items]);
        const [p, b] = await Promise.all([
          choose('player', [await ownAndSearch(), fresh((await store.search(`${c.player} ${c.kit}`).catch(() => ({ items: [] }))).items), fresh((await store.search(`${c.player} ${c.kit} celebración`).catch(() => ({ items: [] }))).items)]),
          choose('bg', [c.bg_query, c.bg_desc]),
        ]);
        usedPlayers.add(p.url);
        const player = p.file && p.url?.startsWith('/media/') ? { url: p.url, credit: p.credit } : await store.save(body.projectId, await readFile(p.file), p.type, p.credit);
        const background = await store.save(body.projectId, await readFile(b.file), b.type, b.credit);
        log(`✂️ Miniatura ${n + 1}: recortando a ${c.player}…`);
        const out = path.join(dir, `m${n}-cut.png`);
        await run(PY, [path.join(HERE, 'cutout.py'), p.file, out], 300000);
        const cut = await store.save(body.projectId, await readFile(out), 'image/png', null);
        log(`✅ Miniatura ${n + 1} lista`);
        return { ...c, player: c.player, photo: player, bg: background, cut };
      } catch (e) { log(`⚠️ Miniatura ${n + 1}: ${e.message.slice(0, 160)}`); return null; }
    });
    return { concepts: built.filter(Boolean), cost };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
