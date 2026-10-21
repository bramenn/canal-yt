// Rescata un vídeo largo cuyo montaje falló antes de guardarse: reconstruye el borrador (long-draft.json) a partir de las
// voces ya sintetizadas y alineadas (projects/audio/<id>-<bloque>/…words.json) sin gastar ElevenLabs. La IA solo decide
// qué mostrar en cada frase. Después se reanuda con la cola de anime/server.js (projects/remount-queue.json: "long:<id>").
// uso: node scripts/recover-long.mjs <id> <voiceId> <título> <anime> <h1|h2|...|h6 con «;» entre capítulos con su anime>
import path from 'node:path';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { claudeStep } from '../lib/claude.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJECTS = path.join(ROOT, 'anime', 'projects');
const [id, voiceId, title, mainAnime, chaptersArg] = process.argv.slice(2);
const chapters = chaptersArg.split(';').map((s, i) => { const [heading, anime] = s.split('|'); return { number: i + 1, heading: heading.trim(), anime: anime.trim() }; });

async function loadBlock(key) {
  const dir = path.join(PROJECTS, 'audio', `${id}-${key}`);
  const mp3 = (await readdir(dir)).find((f) => /^0-[0-9a-f]+\.mp3$/.test(f));
  const { words } = JSON.parse(await readFile(path.join(dir, `${mp3}.words.json`), 'utf8'));
  return { voiceUrl: `/audio/${id}-${key}/${mp3}`, words };
}

// frases: se corta tras . ? ! … y las muy cortas se pegan a la anterior
function sentences(words) {
  const out = [];
  let cur = [];
  for (const w of words) {
    cur.push(w.w);
    if (/[.?!…]["»)]?$/.test(w.w)) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  const merged = [];
  for (const s of out) {
    if (merged.length && s.length < 4) merged.at(-1).push(...s); else merged.push([...s]);
  }
  return merged.map((s) => s.join(' '));
}

const emit = (ev) => { if (ev.type === 'log') console.log(ev.text); };
const track = () => {};

async function annotate(label, anime, heading, lines) {
  const ev = await claudeStep({
    prompt: `Vídeo largo de anime en 16:9. Bloque: ${label} (anime principal: ${anime}${heading ? `, capítulo «${heading}»` : ''}).
Frases ya narradas, numeradas:
${lines.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Para CADA frase (todas, en orden) indica:
- "show": "anime" (escenas en movimiento de ${anime}) | "video" (clip exacto de una escena concreta) | "imagen" (foto/arte concreto; úsalo 1-3 veces como máximo),
- "query": si show="anime" exactamente "${anime}"; si "video" una búsqueda concreta en inglés de la escena; si "imagen" búsqueda precisa en inglés,
- "visual": qué debe verse (≤ 12 palabras).
Además "yellow": 10-14 palabras clave que se dicen; "red": 3-5 de máximo impacto; y "scene_query": una búsqueda en inglés para encontrar el clip principal de este bloque.`,
    schema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object', properties: { n: { type: 'number' }, show: { type: 'string', enum: ['anime', 'video', 'imagen'] }, query: { type: 'string' }, visual: { type: 'string' } }, required: ['n', 'show', 'query', 'visual'] } },
        yellow: { type: 'array', items: { type: 'string' } },
        red: { type: 'array', items: { type: 'string' } },
        scene_query: { type: 'string' },
      },
      required: ['items', 'yellow', 'red', 'scene_query'],
    },
    system: 'Eres editor de vídeo de anime. Respondes solo con el JSON pedido.', model: 'sonnet', effort: 'low', tools: [],
  }, emit, track);
  const d = ev.data;
  return {
    scene_query: d.scene_query,
    script: {
      lines: lines.map((text, i) => {
        const it = d.items.find((x) => Number(x.n) === i + 1);
        return { text, show: it?.show ?? 'anime', query: it?.query || anime, visual: it?.visual || '' };
      }),
      yellow: d.yellow, red: d.red,
    },
  };
}

const intro = await loadBlock('intro');
const blocks = [];
console.log('Introducción…');
const ia = await annotate('Introducción', mainAnime, '', sentences(intro.words));
blocks.push({ key: 'intro', number: 0, heading: 'Introducción', anime: mainAnime, scene_query: ia.scene_query, sources: [], script: ia.script, voiceUrl: intro.voiceUrl });
for (const ch of chapters) {
  console.log(`Capítulo ${ch.number}…`);
  const b = await loadBlock(`ch${ch.number}`);
  const a = await annotate(`Capítulo ${ch.number}`, ch.anime, ch.heading, sentences(b.words));
  ch.scene_query = a.scene_query;
  blocks.push({ key: `ch${ch.number}`, number: ch.number, heading: ch.heading, anime: ch.anime, scene_query: a.scene_query, angle: '', facts: '', sources: [], script: a.script, voiceUrl: b.voiceUrl });
}

console.log('Texto de miniatura…');
const meta = await claudeStep({
  prompt: `Vídeo largo de YouTube de anime: «${title}». Capítulos: ${chapters.map((c) => `${c.number}. ${c.heading}`).join(' · ')}.
Devuelve "thumb_text" (2 a 4 palabras en mayúsculas, máx. 20 caracteres, que intriguen sin repetir el título), "thumb_word" (la palabra de thumb_text a resaltar) y "angle" (el hilo del vídeo en 1 frase).`,
  schema: { type: 'object', properties: { thumb_text: { type: 'string' }, thumb_word: { type: 'string' }, angle: { type: 'string' } }, required: ['thumb_text', 'thumb_word', 'angle'] },
  system: 'Eres director de arte de miniaturas de YouTube.', model: 'sonnet', effort: 'low', tools: [],
}, emit, track);

const plan = { title, main_anime: mainAnime, angle: meta.data.angle, thumb_text: meta.data.thumb_text, thumb_word: meta.data.thumb_word, intro_hook: '', chapters: chapters.map((c) => ({ ...c, angle: '', facts: '', sources: [] })) };
const dir = path.join(PROJECTS, 'media', id);
await mkdir(dir, { recursive: true });
await writeFile(path.join(dir, 'long-draft.json'), JSON.stringify({ id, plan, voiceId, cost: 0, blocks }));
console.log(`Borrador listo: ${blocks.reduce((s, b) => s + b.script.lines.length, 0)} frases · miniatura «${plan.thumb_text}»`);
