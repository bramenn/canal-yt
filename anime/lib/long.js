// Vídeos largos horizontales (16:9, 1920×1080, 8-10 minutos) por capítulos para acumular horas de visualización y
// monetizar con anuncios mid-roll en YouTube (> 8 min).
// Estructura: Introducción potente (~40 s) + 6-7 capítulos numerados (~75-85 s cada uno, con tarjeta animada de capítulo)
// + montaje nativo 16:9 con escenas de tráileres/PV, Cinema Card para imágenes, subtítulos dinámicos de 3-5 palabras,
// cama musical ambiental con ducking + efectos de sonido, miniatura 16:9 y marcas de tiempo (Chapters) en la descripción.
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { claudeStep } from '../../lib/claude.js';
import { run } from '../../lib/ytdlp.js';
import { downloadImages as images } from '../../lib/brave.js';
import { pickRelevant } from '../../lib/imagepick.js';
import { cutSlots, planEdit, planTransitions, applyPairTransitions, sfxTrack, dhash, groupTakes, enforce, tightenVoice } from '../../lib/editor.js';
import { FONTS } from '../../lib/thumbnail.js';
import { assTime, assEsc, YELLOW, RED, WHITE } from '../../lib/subs.js';
import { writeCopy } from '../../lib/social.js';
import { trailer, newsImages, catalogImages, lineTimes, BRAND } from './montage.js';
import { makeThumb16x9 } from './thumb.js';

const LW = 1920, LH = 1080, FPS = 30, CARD_DUR = 2.0;
const ff = (args, timeout = 900000) => run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], timeout);
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ]/g, '');
const clamp = (v, lo, hi, def) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def);
const fmtChapterTime = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// ---------- 1) Investigación y plan de capítulos ----------
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    thumb_text: { type: 'string' },
    thumb_word: { type: 'string' },
    main_anime: { type: 'string' },
    angle: { type: 'string' },
    intro_hook: { type: 'string' },
    chapters: {
      type: 'array',
      minItems: 6,
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          number: { type: 'number' },
          heading: { type: 'string' },
          anime: { type: 'string' },
          scene_query: { type: 'string' },
          angle: { type: 'string' },
          facts: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
        },
        required: ['number', 'heading', 'anime', 'scene_query', 'angle', 'facts', 'sources'],
      },
    },
  },
  required: ['title', 'thumb_text', 'thumb_word', 'main_anime', 'angle', 'intro_hook', 'chapters'],
};

export async function findLongPlan({ topic = '', avoid = [], learn = '' } = {}, emit, track) {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Hoy es ${today}. Eres el director de contenidos de un canal de YouTube de anime en español (${BRAND}) y vas a planificar un VÍDEO LARGO HORIZONTAL (16:9) de 8 a 10 minutos, estructurado en una introducción potente y 6 CAPÍTULOS llenos de datos reales y verificados.

${topic.trim() ? `TEMA PEDIDO POR EL USUARIO: «${topic.trim()}»\nDesarrolla exactamente este tema o franquicia con los 6 mejores casos/capítulos documentados.` : `Elige el tema con MAYOR potencial de búsqueda y retención en YouTube (puede ser un análisis/recopilación de 6 momentos, secretos, técnicas o decisiones de una gran franquicia como Dragon Ball, Naruto, One Piece, Jujutsu Kaisen, Demon Slayer, Attack on Titan, Bleach, Hunter x Hunter, Death Note; o una recopilación multi-anime de 6 casos unidos por un hilo fascinante).`}

Investiga en la web (WebSearch y WebFetch) para que cada uno de los 6 capítulos tenga hechos 100 % reales y comprobados: números de episodio o capítulo de manga, nombres exactos de personajes, técnicas, directores, estudios, fechas o declaraciones oficiales. No inventes nada.
${avoid.length ? `\nNO repitas estos temas ya tratados:\n${avoid.slice(0, 30).map((x) => `- ${x}`).join('\n')}\n` : ''}${learn}

Devuelve:
- "title": título buscable y magnético para YouTube (55-85 caracteres), con el nombre del anime o tema principal y lo que despierta curiosidad.
- "thumb_text": texto para la miniatura 16:9, de 2 a 4 palabras en mayúsculas (máx. 20 caracteres) que intriguen sin repetir el título.
- "thumb_word": la palabra de "thumb_text" que irá resaltada en amarillo.
- "main_anime": nombre oficial del anime principal del vídeo (para la miniatura).
- "angle": resumen en 1 frase del hilo conductor del vídeo.
- "intro_hook": qué gancho, contraste o pregunta abrirá los primeros 40 segundos del vídeo para retener al espectador.
- "chapters": exactamente 6 capítulos (numerados del 1 al 6). En cada uno:
  - "number": 1..6,
  - "heading": título corto del capítulo (3-6 palabras, sin poner el número delante),
  - "anime": nombre oficial del anime de ese capítulo,
  - "scene_query": búsqueda concreta en inglés para encontrar en YouTube el clip o escena exacta de ese capítulo (p. ej. "Goku feet Kamehameha vs Piccolo", "Rock Lee drops weights vs Gaara", "Gojo Hollow Purple Toji"),
  - "angle": el giro o dato sorprendente de ese capítulo,
  - "facts": todos los datos concretos verificados (episodio, capítulo del manga, nombres, contexto, consecuencias, fechas),
  - "sources": 1-2 URLs reales consultadas.`;

  const ev = await claudeStep({
    prompt,
    schema: PLAN_SCHEMA,
    system: 'Eres investigador y guionista jefe de documentales y vídeos largos de anime para YouTube. Solo afirmas datos verificados.',
    model: 'sonnet',
    effort: 'medium',
    tools: ['WebSearch', 'WebFetch'],
  }, emit, track);
  return { plan: ev.data, cost: ev.cost ?? 0 };
}

// ---------- 2) Guion por bloques (Intro + Capítulos de ~80 s) ----------
const BLOCK_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      minItems: 8,
      maxItems: 26,
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          show: { type: 'string', enum: ['anime', 'video', 'imagen'] },
          query: { type: 'string' },
          visual: { type: 'string' },
        },
        required: ['text', 'show', 'query', 'visual'],
      },
    },
    yellow: { type: 'array', items: { type: 'string' } },
    red: { type: 'array', items: { type: 'string' } },
  },
  required: ['lines', 'yellow', 'red'],
};

export async function writeIntroScript(plan, emit, track) {
  const prompt = `Escribe la INTRODUCCIÓN narrada (~40-45 segundos, entre 115 y 135 palabras en total, 9-11 frases) para este vídeo largo de YouTube de anime:
TÍTULO: ${plan.title}
ENFOQUE: ${plan.angle}
GANCHO: ${plan.intro_hook}
CAPÍTULOS QUE VEREMOS: ${plan.chapters.map((c) => `${c.number}. ${c.anime} (${c.heading}: ${c.angle})`).join(' · ')}

REGLAS DE ESTILO Y RITMO:
- Español neutro latinoamericano, directo, ágil y con mucha energía narrativa.
- Frase 1 (0-4 s): un gancho directo con el caso más impactante del vídeo para atrapar desde el segundo cero (nunca empieces con «Hola a todos» ni «Bienvenidos a otro vídeo»).
- Presenta el conflicto o hilo conductor, anticipa 2 de los misterios/casos más fuertes que veremos más adelante (para que el espectador se quede hasta el final) y da paso al primer capítulo.
- Frases de 8 a 15 palabras que suenen naturales en voz alta. Escribe cómo se pronuncian las siglas.
- En cada frase indica "show" ("anime" para tráileres/escenas del anime; "video" o "imagen" para algo concreto), "query" (nombre oficial del anime o búsqueda específica en inglés) y "visual" (qué plano o acción debe verse en pantalla 16:9).
- Elige 6-10 palabras clave en "yellow" y 2-4 de máximo impacto en "red".`;

  const ev = await claudeStep({
    prompt,
    schema: BLOCK_SCHEMA,
    system: 'Eres guionista experto en retención de vídeos largos de YouTube de anime.',
    model: 'sonnet',
    effort: 'low',
    tools: [],
  }, emit, track);
  return { block: ev.data, cost: ev.cost ?? 0 };
}

export async function writeChapterScript(ch, plan, { isLast = false, minWords = 230, maxWords = 255 } = {}, emit, track) {
  const prompt = `Escribe el guion narrado del CAPÍTULO ${ch.number} («${ch.heading}») del vídeo largo «${plan.title}».
ANIME DEL CAPÍTULO: ${ch.anime}
ESCENA CLAVE: ${ch.scene_query}
GIRO / ENFOQUE: ${ch.angle}
DATOS VERIFICADOS: ${ch.facts}

EXTENSIÓN OBLIGATORIA para alcanzar los 8-10 minutos totales del vídeo:
- Este capítulo debe tener entre **${minWords} y ${maxWords} palabras en total** (18 a 23 frases de 10-14 palabras cada una, ~80-90 segundos de narración).
- No rellenes con paja: desarrolla la historia paso a paso como un mini-documental apasionante:
  1. Abre el capítulo entrando de lleno en la escena o el problema concreto de ${ch.anime}.
  2. Explica el contexto dentro de la historia (en qué arco, episodio o capítulo ocurre y qué estaba en juego).
  3. Revela el detalle técnico, secreto de producción, regla o giro exacto con todos los nombres y cifras reales.
  4. Cuenta qué consecuencias tuvo en la trama o en los fans y por qué este caso es tan especial.
  ${isLast ? '5. Como este es el ÚLTIMO capítulo del vídeo, cierra las últimas 2-3 frases con una conclusión potente del vídeo entero y una pregunta directa para que la audiencia debata en los comentarios.' : '5. Cierra el capítulo con una frase contundente que deje con ganas de pasar al siguiente caso.'}

VISUALES EN 16:9 ("lines"):
- En cada frase indica:
  - "show": "anime" para escenas en movimiento del anime (${ch.anime}); "video" si pides el clip exacto de "${ch.scene_query}"; "imagen" (1 a 3 veces en el capítulo) para mostrar una prueba visual concreta, comparativa, autor o arte oficial.
  - "query": si show="anime", el nombre oficial "${ch.anime}". Si show="video", "${ch.scene_query}". Si show="imagen", una búsqueda precisa en inglés sin pedir portadas ni páginas de manga con texto.
  - "visual": descripción concreta de lo que debe verse en pantalla durante esa frase (≤ 12 palabras).
- Elige 10-14 palabras clave en "yellow" y 3-5 de máximo impacto en "red".`;

  const ev = await claudeStep({
    prompt,
    schema: BLOCK_SCHEMA,
    system: 'Eres narrador y documentalista de anime en español neutro. Tus capítulos enganchan de principio a fin con datos reales.',
    model: 'sonnet',
    effort: 'low',
    tools: [],
  }, emit, track);
  return { block: ev.data, cost: ev.cost ?? 0 };
}

// ---------- 3) Montaje 16:9 (1920×1080) ----------
/** Tarjeta animada de inicio de capítulo (2,0 s, 1920×1080, 30 fps) sobre fotograma oscurecido del anime. */
async function renderChapterCard({ number, heading, anime, bgFile, dir, out }) {
  const frames = Math.round(CARD_DUR * FPS);
  const assFile = path.join(dir, `card-ch-${number}.ass`);
  const titleUp = assEsc(String(heading).toUpperCase());
  const animeUp = assEsc(String(anime).toUpperCase());
  const titleSize = Math.min(112, Math.max(68, Math.round(1560 / Math.max(8, titleUp.length * 0.56))));
  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${LW}
PlayResY: ${LH}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Kicker,Anton,52,${YELLOW},${YELLOW},&H00000000,&H80000000,0,0,0,0,100,100,6,0,1,6,3,5,60,60,0,1
Style: Head,Anton,${titleSize},${WHITE},${WHITE},&H00000000,&H96000000,0,0,0,0,100,100,2,0,1,12,6,5,80,80,0,1
Style: AnimeTag,Anton,44,&H00E8E8E8&,&H00E8E8E8&,&H00000000,&H80000000,0,0,0,0,100,100,3,0,1,5,2,5,60,60,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 2,0:00:00.00,${assTime(CARD_DUR)},Kicker,,0,0,0,,{\\pos(960,415)\\fad(140,180)}CAPÍTULO ${number}
Dialogue: 3,0:00:00.00,${assTime(CARD_DUR)},Head,,0,0,0,,{\\pos(960,540)\\fscx82\\fscy82\\t(0,180,\\fscx100\\fscy100)\\fad(120,180)}${titleUp}
Dialogue: 2,0:00:00.08,${assTime(CARD_DUR)},AnimeTag,,0,0,0,,{\\pos(960,665)\\fad(180,180)}${animeUp}
`;
  await writeFile(assFile, ass);
  if (bgFile && existsSync(bgFile)) {
    const isVid = /\.mp4$/i.test(bgFile);
    const inputArgs = isVid ? ['-ss', '1', '-t', String(CARD_DUR + 0.1), '-i', bgFile] : ['-loop', '1', '-t', String(CARD_DUR), '-i', bgFile];
    await ff([
      ...inputArgs, '-an',
      '-vf', `scale=${LW * 2}:${LH * 2}:force_original_aspect_ratio=increase,crop=${LW * 2}:${LH * 2},zoompan=z='1+0.06*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${isVid ? 1 : frames}:s=${LW}x${LH}:fps=${FPS},boxblur=22:2,eq=brightness=-0.38:saturation=0.85:contrast=1.1,vignette=PI/4,subtitles=${assFile}:fontsdir=${FONTS},format=yuv420p`,
      '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out,
    ]);
  } else {
    await ff([
      '-f', 'lavfi', '-i', `color=c=#0d1322:s=${LW}x${LH}:r=${FPS}:d=${CARD_DUR}`,
      '-vf', `subtitles=${assFile}:fontsdir=${FONTS},format=yuv420p`,
      '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out,
    ]);
  }
}

/** Renderiza un corte en formato horizontal 16:9 (1920×1080, 30 fps). */
async function renderCut16x9(slot, item, uses, out) {
  const dur = slot.e - slot.s;
  const frames = Math.max(1, Math.round(dur * FPS));
  const punchAt = slot.emph != null ? Math.round(slot.emph * FPS) : null;
  const punchDur = Math.round(0.32 * FPS);
  const fx = clamp(item.focusX, 0.08, 0.92, 0.5);
  const fy = clamp(item.focusY, 0.08, 0.92, 0.45);

  if (item.kind === 'image') {
    const ratio = item.w && item.h ? item.w / item.h : 16 / 9;
    const useCard = item.layout === 'card' || ratio < 1.22;
    const punchImg = punchAt == null ? '' : `if(gte(on,${punchAt}),0.09*(1-pow(max(0,1-(on-${punchAt})/${punchDur}),3)),0)`;
    if (useCard) {
      const cardH = 820;
      const cardW = Math.min(1560, Math.max(560, Math.round((cardH * ratio) / 2) * 2));
      const zFg = punchImg ? `min(1.14,1+0.045*on/${frames}+${punchImg})` : `1+0.045*on/${frames}`;
      const vf = [
        `split[bg0][fg0]`,
        `[bg0]scale=${LW}:${LH}:force_original_aspect_ratio=increase,crop=${LW}:${LH},zoompan=z='1+0.04*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${LW}x${LH}:fps=${FPS},boxblur=30:3,eq=brightness=-0.30:saturation=0.85[bg]`,
        `[fg0]scale=${cardW * 2}:${cardH * 2}:force_original_aspect_ratio=increase,crop=${cardW * 2}:${cardH * 2}:'max(0,min(iw-ow,iw*${fx}-ow/2))':'max(0,min(ih-oh,ih*${fy}-oh/2))',zoompan=z='${zFg}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${cardW}x${cardH}:fps=${FPS},pad=iw+8:ih+8:4:4:color=white@0.88,pad=iw+28:ih+28:14:14:color=black@0.45[fg]`,
        `[bg][fg]overlay=(W-w)/2:(H-h)/2-25,format=yuv420p`,
      ].join(';');
      await ff(['-i', item.file, '-vf', vf, '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', out]);
      return;
    }
    const z = punchImg ? `min(1.16,1+0.05*on/${frames}+${punchImg})` : `1+0.05*on/${frames}`;
    await ff(['-i', item.file, '-vf', `scale=${LW * 2}:${LH * 2}:force_original_aspect_ratio=increase,crop=${LW * 2}:${LH * 2}:'max(0,min(iw-ow,iw*${fx}-ow/2))':'max(0,min(ih-oh,ih*${fy}-oh/2))',zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${LW}x${LH}:fps=${FPS},format=yuv420p`, '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', out]);
    return;
  }

  const len = item.e - item.s;
  const lo = item.s + Math.min(0.2, len / 6), room = Math.max(0, item.e - Math.min(0.2, len / 6) - lo - dur);
  const mid = Math.min(Math.max(lo, (item.s + item.e) / 2 - dur / 2), lo + room);
  const start = len > dur ? (uses ? lo + ((uses * 0.618) % 1) * room : mid) : item.s;
  const slow = Math.max(1, dur / Math.max(0.5, len));
  const punchVid = punchAt == null ? '' : `if(gte(in,${punchAt}),0.10*(1-pow(max(0,1-(in-${punchAt})/${punchDur}),3)),0)`;
  const zoom = punchVid ? `,zoompan=z='min(1.12,1+${punchVid})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${LW}x${LH}:fps=${FPS}` : '';
  // Escala ligeramente mayor (2080×1170) y recorta la franja inferior por si el PV traía subtítulos quemados abajo
  await ff(['-ss', String(start), '-t', String(dur / slow + 0.05), '-i', item.file, '-an', '-vf', `setpts=${slow.toFixed(3)}*(PTS-STARTPTS),scale=2080:1170:force_original_aspect_ratio=increase,crop=${LW}:${LH}:(iw-ow)/2:0,fps=${FPS}${zoom},format=yuv420p`, '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out]);
}

/** Subtítulos 16:9 (grupos de 3-5 palabras en la parte inferior) + insignia superior del capítulo/anime + marca @notianimes. */
function subtitles16x9(words, { yellow = [], red = [] }, segmentsMeta, total) {
  const Y = new Set(yellow.map(norm)), R = new Set(red.map(norm));
  const groups = [];
  for (let i = 0; i < words.length;) {
    const g = [words[i]];
    while (g.length < 4 && i + g.length < words.length) {
      const prev = g.at(-1).w;
      const next = words[i + g.length];
      if (/[.!?…;:]$/.test(prev) || next.s - g.at(-1).e > 0.25) break;
      const chars = g.map((x) => x.w).join(' ').length + 1 + next.w.length;
      if (chars > 32) break;
      g.push(next);
    }
    groups.push(g);
    i += g.length;
  }
  const subEvents = groups.map((g, i) => {
    const s = g[0].s, e = Math.min(groups[i + 1]?.[0].s ?? total, g.at(-1).e + 0.45);
    const text = g.map((w) => `{\\c${R.has(norm(w.w)) ? RED : Y.has(norm(w.w)) ? YELLOW : WHITE}}${assEsc(w.w.toUpperCase().replace(/[.,;:]+$/, ''))}`).join(' ');
    return `Dialogue: 2,${assTime(s)},${assTime(e)},Sub,,0,0,0,,{\\pos(960,1010)\\fscx88\\fscy88\\t(0,75,\\fscx100\\fscy100)}${text}`;
  });
  const badgeEvents = segmentsMeta.filter((m) => m.label).map((m) =>
    `Dialogue: 3,${assTime(m.s)},${assTime(m.e)},Badge,,0,0,0,,{\\an7\\pos(46,36)\\fad(200,200)}${assEsc(m.label.toUpperCase())}`
  );
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${LW}
PlayResY: ${LH}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Anton,74,&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,0,0,0,0,100,100,1,0,1,8,4,2,80,80,35,1
Style: Badge,Anton,38,${YELLOW},${YELLOW},&H00000000,&H96000000,0,0,0,0,100,100,2,0,1,5,2,7,40,40,35,1
Style: Brand,Anton,42,&H45FFFFFF,&H45FFFFFF,&H60000000,&H00000000,0,0,0,0,100,100,1,0,1,4,0,9,46,46,36,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${subEvents.join('\n')}
${badgeEvents.join('\n')}
Dialogue: 3,${assTime(0)},${assTime(total)},Brand,,0,0,0,,${BRAND}
`;
}

/** Cama musical ambiental estéreo libre de derechos (acorde menor 9 cálido con pulso suave), subida en tarjetas de capítulo. */
async function ambientBed(total, cardRanges, dir) {
  const out = path.join(dir, 'ambient-bed.wav');
  const boostExpr = cardRanges.length
    ? cardRanges.map(([a, b]) => `between(t,${a.toFixed(2)},${b.toFixed(2)})`).join('+')
    : '0';
  const volExpr = `0.065+0.075*min(1,${boostExpr})`;
  const synth = `aevalsrc='0.22*sin(2*PI*110*t)+0.18*sin(2*PI*164.81*t)+0.14*sin(2*PI*220*t)+0.11*sin(2*PI*261.63*t)*(0.65+0.35*sin(2*PI*0.18*t))+0.09*sin(2*PI*329.63*t)*(0.6+0.4*cos(2*PI*0.13*t))|0.22*sin(2*PI*110.2*t)+0.18*sin(2*PI*164.6*t)+0.14*sin(2*PI*220*t)+0.11*sin(2*PI*261.9*t)*(0.65+0.35*cos(2*PI*0.18*t))+0.09*sin(2*PI*329.4*t)*(0.6+0.4*sin(2*PI*0.13*t))':s=44100:d=${total.toFixed(2)},lowpass=f=950,highpass=f=65,volume='${volExpr}':eval=frame,afade=t=in:d=1.2,afade=t=out:st=${Math.max(0, total - 2.5).toFixed(2)}:d=2.5`;
  await ff(['-f', 'lavfi', '-i', synth, '-ac', '2', '-ar', '44100', out]);
  return out;
}

/** Descarga/reutiliza el catálogo visual de un bloque (Intro o Capítulo). */
async function buildBlockCatalog(block, animeDefault, sceneQuery, sourcesUrls, context, dir, log, trailerCache) {
  const catalog = [];
  const rawImages = [];
  const animes = [animeDefault].filter(Boolean);
  // Las frases «anime» con una búsqueda de escena concreta (no el nombre de la serie) no disparan un tráiler nuevo cada una:
  // solo se catalogan hasta 2 clips exactos distintos por bloque (más el scene_query del capítulo).
  const exactQueries = [...new Set(block.lines
    .filter((l) => l.show === 'video' || (l.show === 'anime' && l.query && norm(l.query) !== norm(animeDefault) && l.query.split(/\s+/).length > 2))
    .map((l) => l.query))].slice(0, 2);
  for (const q of animes) {
    const key = norm(q);
    if (!trailerCache.has(key)) {
      const t = await trailer(q, dir, log, context).catch((e) => { log(`⚠️ ${e.message}: uso imágenes`); return null; });
      trailerCache.set(key, t);
    }
    const t = trailerCache.get(key);
    if (t) t.scenes.forEach((x) => catalog.push({ ...x, kind: 'video', anime: q, id: `V${catalog.length + 1}` }));
    const extra = `${q} anime official key visual clean no text`;
    for (const f of (await pickRelevant(await images(extra, dir), extra, context, dir)).slice(0, 3)) {
      rawImages.push({ kind: 'image', file: f, anime: q, desc: `arte oficial de ${q}`, hint: `arte oficial de ${q}`, who: 'personajes del anime', shot: 'plano medio', action: 1 });
    }
  }
  if (sceneQuery?.trim() && !animes.some((a) => norm(a) === norm(sceneQuery))) exactQueries.unshift(sceneQuery.trim());
  for (const sq of [...new Set(exactQueries)].slice(0, 3)) {
    if (animes.some((a) => norm(a) === norm(sq))) continue;
    const key = `exact:${norm(sq)}`;
    if (!trailerCache.has(key)) {
      const st = await trailer(sq, dir, log, context, true).catch(() => null);
      trailerCache.set(key, st);
    }
    const st = trailerCache.get(key);
    if (st) st.scenes.forEach((x) => catalog.push({ ...x, kind: 'video', anime: animeDefault, id: `V${catalog.length + 1}`, desc: `escena clave (${sq}): ${x.desc ?? ''}` }));
  }
  for (const [line, l] of block.lines.entries()) if (l.show === 'imagen') {
    const picked = await pickRelevant(await images(l.query, dir), l.query, `${context}. Frase: ${l.text}. Visual: ${l.visual || l.query}`, dir, { specific: true });
    picked.slice(0, 2).forEach((f) => rawImages.push({ kind: 'image', file: f, line, desc: l.visual || l.query, hint: `${l.query} (${l.visual || l.text})`, shot: 'foto', action: 0 }));
  }
  const newsPics = await newsImages(sourcesUrls, dir);
  for (const n of newsPics) rawImages.push({ kind: 'image', file: n.file, news: true, desc: `foto de la fuente: ${n.title}`, hint: `noticia: ${n.title}`, who: '', shot: 'foto', action: 0 });

  const checkedImages = await catalogImages(rawImages, context, dir, log);
  for (const img of checkedImages) catalog.push({ ...img, id: `F${catalog.length + 1}`, hash: img.hash || await dhash(img.file) });
  return catalog;
}

/**
 * Monta el vídeo largo completo (1920×1080) a partir de los bloques ya locutados y alineados.
 * blocks: [{ key, number, heading, anime, scene_query, sources, script, voiceFile, words, duration }]
 */
export async function montageLong({ plan, blocks, dir, thumb = null }, log, signal) {
  await mkdir(dir, { recursive: true });
  const trailerCache = new Map();
  const videoParts = [];
  const audioSegments = [];
  const allWords = [];
  const allYellow = new Set(), allRed = new Set();
  const cardRanges = [];
  const chaptersTimeline = [];
  const segmentsMeta = [];
  const allWhoosh = [], allFlash = [], allImpact = [], allSlots = [], allLines = [];
  let cursor = 0;

  // Silencio de 2,0 s para las tarjetas de capítulo
  const silenceCard = path.join(dir, 'silence-card.wav');
  await ff(['-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo:d=${CARD_DUR}`, '-ac', '2', '-ar', '44100', silenceCard]);

  for (const [bi, b] of blocks.entries()) {
    if (signal?.aborted) throw new Error('Cancelado');
    (b.script.yellow ?? []).forEach((w) => allYellow.add(w));
    (b.script.red ?? []).forEach((w) => allRed.add(w));
    const context = `${b.anime}: ${b.heading}. ${b.angle || plan.angle}`.slice(0, 1200);
    log(`🎞 Preparando material 16:9 del bloque ${bi === 0 ? 'Introducción' : `Cap. ${b.number} (${b.anime})`}…`);
    const catalog = await buildBlockCatalog(b.script, b.anime, b.scene_query, b.sources ?? [], context, dir, log, trailerCache);
    if (!catalog.length) throw new Error(`Sin material visual para el bloque ${b.heading}`);

    // Si es un capítulo numerado (> 0), insertamos primero su tarjeta de capítulo de 2,0 s
    if (b.number > 0) {
      chaptersTimeline.push({ number: b.number, heading: b.heading, anime: b.anime, start: cursor });
      const cardOut = path.join(dir, `seg-card-${b.number}.mp4`);
      const bgSample = catalog.find((c) => c.kind === 'video')?.file ?? catalog[0]?.file;
      await renderChapterCard({ number: b.number, heading: b.heading, anime: b.anime, bgFile: bgSample, dir, out: cardOut });
      videoParts.push(cardOut);
      audioSegments.push(silenceCard);
      cardRanges.push([cursor, cursor + CARD_DUR]);
      allImpact.push(+(cursor + 0.12).toFixed(2));
      allWhoosh.push(+(cursor + CARD_DUR - 0.18).toFixed(2));
      cursor += CARD_DUR;
    } else {
      chaptersTimeline.push({ number: 0, heading: 'Introducción', anime: plan.main_anime, start: 0 });
    }

    const segStart = cursor;
    const dur = b.duration;
    const lines = lineTimes(b.script.lines, b.words, dur);
    const slots = cutSlots(lines, b.words, b.script, { min: 1.8, target: 2.6, max: 3.6, hook: bi === 0 ? 2 : 0 });
    const takes = groupTakes(catalog);
    log(`🎬 Editando ${bi === 0 ? 'Introducción' : `Cap. ${b.number}`} (${slots.length} cortes 16:9 con ${catalog.length} planos / ${takes} tomas)…`);
    const { plan: editPlan, climax, motion } = await planEdit({ slots, lines, catalog, context }, log);
    const byId = new Map(catalog.map((c) => [c.id, c]));
    const uses = new Map();
    const parts = [];
    for (let i = 0; i < slots.length; i++) {
      if (signal?.aborted) throw new Error('Cancelado');
      const id = editPlan[i];
      const k = uses.get(id) ?? 0;
      uses.set(id, k + 1);
      const out = path.join(dir, `cut-b${bi}-${String(i).padStart(3, '0')}.mp4`);
      await renderCut16x9(slots[i], byId.get(id) ?? catalog[0], k, out);
      parts.push(out);
    }
    const tx = planTransitions({ slots, lines, plan: editPlan, byId, motion, climax });
    await applyPairTransitions(parts, slots, tx.transitions, { fps: FPS, w: LW, h: LH });
    videoParts.push(...parts);
    audioSegments.push(b.voiceFile);

    // Desplazar palabras, líneas, cortes y SFX al tiempo global del vídeo largo
    for (const w of b.words) allWords.push({ ...w, s: +(w.s + segStart).toFixed(3), e: +(w.e + segStart).toFixed(3) });
    for (const l of lines) allLines.push({ ...l, s: +(l.s + segStart).toFixed(3), e: +(l.e + segStart).toFixed(3) });
    for (const sl of slots) allSlots.push({ ...sl, s: +(sl.s + segStart).toFixed(3), e: +(sl.e + segStart).toFixed(3) });
    for (const t of tx.whooshAt) allWhoosh.push(+(t + segStart).toFixed(2));
    for (const t of tx.flashAt) allFlash.push(+(t + segStart).toFixed(2));
    // planTransitions devuelve un único instante de clímax (o null)
    if (Number.isFinite(tx.impactAt)) allImpact.push(+(tx.impactAt + segStart).toFixed(2));
    segmentsMeta.push({
      s: segStart,
      e: segStart + dur,
      label: b.number > 0 ? `Cap. ${b.number} · ${b.anime}` : plan.main_anime,
    });
    cursor += dur;
  }

  const total = +(cursor + 0.4).toFixed(2);
  // Unir toda la pista de voz (con los huecos de 2,0 s de las tarjetas de capítulo)
  const voiceList = path.join(dir, 'voice-segments.txt');
  const normVoices = [];
  for (const [i, aFile] of audioSegments.entries()) {
    const wav = path.join(dir, `vseg-${String(i).padStart(2, '0')}.wav`);
    await ff(['-i', aFile, '-ac', '2', '-ar', '44100', wav]);
    normVoices.push(wav);
  }
  await writeFile(voiceList, normVoices.map((p) => `file '${p}'`).join('\n'));
  const fullVoice = path.join(dir, 'voice-full.wav');
  await ff(['-f', 'concat', '-safe', '0', '-i', voiceList, '-c:a', 'pcm_s16le', fullVoice]);

  log('🎵 Generando cama musical ambiental y efectos de sonido sincronizados…');
  const bed = await ambientBed(total, cardRanges, dir);
  const sfx = await sfxTrack({ whooshAt: allWhoosh, flashAt: allFlash, impactAt: allImpact, slots: allSlots, lines: allLines, total, dir }).catch(() => null);

  // Miniatura 16:9
  const mainKey = norm(plan.main_anime);
  const mainScenes = trailerCache.get(mainKey)?.scenes ?? [...trailerCache.values()].find((v) => v?.scenes?.length)?.scenes ?? [{ file: videoParts[0], s: 0, e: 1 }];
  thumb ??= await makeThumb16x9({
    script: { title: plan.title, thumb_text: plan.thumb_text, thumb_word: plan.thumb_word },
    anime: plan.main_anime,
    scenes: mainScenes,
    dir,
    context: `${plan.main_anime}: ${plan.angle}`,
  }, log, signal);

  const listFile = path.join(dir, 'cuts-long.txt');
  await writeFile(listFile, videoParts.map((p) => `file '${p}'`).join('\n'));
  const assFile = path.join(dir, 'subs-long.ass');
  await writeFile(assFile, subtitles16x9(allWords, { yellow: [...allYellow], red: [...allRed] }, segmentsMeta, total));

  const final = path.join(dir, 'long.mp4');
  log(`🎞 Renderizando MP4 final 16:9 (${fmtChapterTime(total)})…`);
  const audioInputs = ['-i', fullVoice, '-i', bed, ...(sfx ? ['-i', sfx] : [])];
  const audioMix = sfx
    ? '[1:a]volume=1.0[v];[2:a]volume=0.85[b];[3:a]volume=0.42[s];[v][b][s]amix=inputs=3:normalize=0:duration=first[a]'
    : '[1:a]volume=1.0[v];[2:a]volume=0.85[b];[v][b]amix=inputs=2:normalize=0:duration=first[a]';
  await ff([
    '-f', 'concat', '-safe', '0', '-i', listFile,
    ...audioInputs,
    '-filter_complex', `[0:v]subtitles=${assFile}:fontsdir=${FONTS}[o];${audioMix}`,
    '-map', '[o]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-t', String(total), '-movflags', '+faststart', final,
  ], 1800000);

  return { video: final, thumb, duration: Math.round(total), chaptersTimeline };
}

// ---------- 4) Orquestador completo (makeLong y remountLong) ----------
async function voiceAndAlignBlock(blockKey, id, script, voiceId, { tts, aligner }, log, signal) {
  const text = script.lines.map((l) => l.text).join(' ');
  const voiceSettings = { speed: 1.06, stability: 0.36, similarity: 0.8, style: 0.42 };
  const [seg] = await tts.synthesize({
    provider: 'elevenlabs',
    projectId: `${id}-${blockKey}`,
    voiceId,
    settings: voiceSettings,
    segments: [{ index: 0, spoken: text }],
  }, log, signal);
  const file = path.join(tts.AUDIO_DIR, decodeURIComponent(seg.url.replace(/^\/audio\//, '')));
  const [al] = await aligner.align([{ index: 0, file, prompt: text }], log, signal);
  const raw = (al?.words ?? []).map((w) => ({ w: w.w.trim(), s: w.s, e: w.e })).filter((w) => w.w);
  if (!raw.length) throw new Error(`No se pudo alinear la voz del bloque ${blockKey}`);
  const { file: voiceFile, words, duration } = await tightenVoice(file, raw, al.duration ?? raw.at(-1).e);
  return { voiceUrl: seg.url, voiceFile, words, duration };
}

export function formatChaptersCopy(chaptersTimeline = []) {
  return chaptersTimeline.map((c) => `${fmtChapterTime(c.start)} ${c.number > 0 ? `${c.number}. ${c.heading} (${c.anime})` : c.heading}`).join('\n');
}

export async function makeLong({ id, topic = '', voiceId, learn = '', avoid = [] }, deps, emit, track, signal) {
  const log = (text) => emit({ type: 'log', text });
  let cost = 0;
  log(`🔎 Investigando tema y estructurando 6 capítulos para vídeo largo (8-10 min)…`);
  const { plan, cost: c0 } = await findLongPlan({ topic, avoid, learn }, emit, track);
  cost += c0;
  log(`📋 «${plan.title}» · 6 capítulos: ${plan.chapters.map((c) => `${c.number}. ${c.anime}`).join(' · ')}`);

  const blocks = [];
  log('✍️ Escribiendo introducción con gancho…');
  const { block: introScript, cost: cIntro } = await writeIntroScript(plan, emit, track);
  cost += cIntro;
  const introAudio = await voiceAndAlignBlock('intro', id, introScript, voiceId, deps, log, signal);
  blocks.push({
    key: 'intro',
    number: 0,
    heading: 'Introducción',
    anime: plan.main_anime,
    scene_query: plan.chapters[0]?.scene_query || plan.main_anime,
    sources: plan.chapters[0]?.sources ?? [],
    script: introScript,
    ...introAudio,
  });

  // Calculamos cuántas palabras por capítulo necesitamos para superar con holgura los 8 minutos (485 s)
  for (const [idx, ch] of plan.chapters.entries()) {
    if (signal?.aborted) throw new Error('Cancelado');
    const elapsed = blocks.reduce((s, x) => s + x.duration + (x.number > 0 ? CARD_DUR : 0), 0);
    const remainingChapters = plan.chapters.length - idx;
    const neededSecsPerChapter = Math.max(76, (505 - elapsed) / remainingChapters);
    const minWords = Math.min(265, Math.max(220, Math.round(neededSecsPerChapter * 2.95)));
    const maxWords = minWords + 25;
    log(`✍️ Guion del Capítulo ${ch.number}/${plan.chapters.length}: «${ch.heading}» (${ch.anime})…`);
    const { block: chScript, cost: cCh } = await writeChapterScript(ch, plan, {
      isLast: idx === plan.chapters.length - 1,
      minWords,
      maxWords,
    }, emit, track);
    cost += cCh;
    const chAudio = await voiceAndAlignBlock(`ch${ch.number}`, id, chScript, voiceId, deps, log, signal);
    blocks.push({
      key: `ch${ch.number}`,
      number: ch.number,
      heading: ch.heading,
      anime: ch.anime,
      scene_query: ch.scene_query,
      angle: ch.angle,
      facts: ch.facts,
      sources: ch.sources,
      script: chScript,
      ...chAudio,
    });
  }

  const dir = path.join(deps.mediaDir, id);
  return finishLong({ id, plan, blocks, voiceId, cost }, deps, emit, track, signal);
}

/** Guarda en disco el plan, los guiones y las voces ya hechas: si el montaje falla, se reanuda sin gastar voz ni IA otra vez. */
async function saveDraft({ id, plan, blocks, voiceId, cost }, mediaDir) {
  const dir = path.join(mediaDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'long-draft.json'), JSON.stringify({ id, plan, voiceId, cost, blocks: blocks.map(({ voiceFile, words, ...rest }) => rest) }));
}

/** Monta, publica el texto y arma el proyecto a partir de bloques ya guionizados y locutados. */
async function finishLong({ id, plan, blocks, voiceId, cost = 0 }, deps, emit, track, signal) {
  const log = (text) => emit({ type: 'log', text });
  await saveDraft({ id, plan, blocks, voiceId, cost }, deps.mediaDir);
  const dir = path.join(deps.mediaDir, id);
  const out = await montageLong({ plan, blocks, dir }, log, signal);
  const chaptersText = formatChaptersCopy(out.chaptersTimeline);

  const about = `Vídeo largo de YouTube (16:9) sobre ${plan.main_anime}: «${plan.title}». Enfoque: ${plan.angle}.\nCapítulos:\n${chaptersText}`;
  const copy = await writeCopy({
    about,
    brand: BRAND,
    keywordsHint: 'el nombre del anime principal y el tema concreto buscable en YouTube',
    includeComment: true,
  }, emit, track);
  if (copy?.youtube) {
    copy.youtube.description = `${copy.youtube.description.trim()}\n\n📌 CAPÍTULOS:\n${chaptersText}`;
  }

  const project = {
    id,
    kind: 'long',
    story: {
      anime: plan.main_anime,
      angle: plan.angle,
      facts: plan.chapters.map((c) => `${c.number}. ${c.heading} (${c.anime}): ${c.angle}`).join(' · '),
      sources: [...new Set(plan.chapters.flatMap((c) => c.sources ?? []))],
    },
    plan,
    blocks: blocks.map(({ voiceFile, words, ...rest }) => rest),
    chaptersTimeline: out.chaptersTimeline,
    script: {
      title: plan.title,
      thumb_text: plan.thumb_text,
      thumb_word: plan.thumb_word,
      lines: blocks.flatMap((b) => b.script.lines),
      copy,
    },
    voice: { voiceId },
    duration: out.duration,
    video: `/media/${id}/long.mp4`,
    thumb: `/media/${id}/thumb-4k.jpg`,
    thumbSmall: `/media/${id}/thumb.jpg`,
    cost,
    created: Date.now(),
  };
  return project;
}

/** Reanuda un vídeo largo que falló en el montaje, desde su borrador (mismos guiones y voces ya generados). */
export async function resumeLong(id, deps, emit, track, signal) {
  const draft = JSON.parse(await readFile(path.join(deps.mediaDir, id, 'long-draft.json'), 'utf8'));
  const log = (text) => emit({ type: 'log', text });
  const blocks = [];
  for (const b of draft.blocks) {
    const file = path.join(deps.tts.AUDIO_DIR, decodeURIComponent(b.voiceUrl.replace(/^\/audio\//, '')));
    const text = b.script.lines.map((l) => l.text).join(' ');
    const [al] = await deps.aligner.align([{ index: 0, file, prompt: text }], log, signal);
    const raw = (al?.words ?? []).map((w) => ({ w: w.w.trim(), s: w.s, e: w.e })).filter((w) => w.w);
    const { file: voiceFile, words, duration } = await tightenVoice(file, raw, al.duration ?? raw.at(-1).e);
    blocks.push({ ...b, voiceFile, words, duration });
  }
  return finishLong({ id, plan: draft.plan, blocks, voiceId: draft.voiceId, cost: draft.cost }, deps, emit, track, signal);
}

/** Re-monta un vídeo largo (16:9) reutilizando su guion por capítulos, sus audios ya generados y su miniatura. */
export async function remountLong(pj, { tts, aligner, mediaDir }, log = () => {}, signal) {
  const dir = path.join(mediaDir, pj.id);
  const thumb = existsSync(path.join(dir, 'thumb.jpg'))
    ? { full: path.join(dir, 'thumb-4k.jpg'), small: path.join(dir, 'thumb.jpg') }
    : null;
  const blocks = [];
  for (const b of pj.blocks ?? []) {
    const file = path.join(tts.AUDIO_DIR, decodeURIComponent(b.voiceUrl.replace(/^\/audio\//, '')));
    const text = b.script.lines.map((l) => l.text).join(' ');
    const [al] = await aligner.align([{ index: 0, file, prompt: text }], log, signal);
    const raw = (al?.words ?? []).map((w) => ({ w: w.w.trim(), s: w.s, e: w.e })).filter((w) => w.w);
    const { file: voiceFile, words, duration } = await tightenVoice(file, raw, al.duration ?? raw.at(-1).e);
    blocks.push({ ...b, voiceFile, words, duration });
  }
  const out = await montageLong({ plan: pj.plan, blocks, dir, thumb }, log, signal);
  pj.duration = out.duration;
  pj.chaptersTimeline = out.chaptersTimeline;
  return pj;
}
