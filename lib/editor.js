// «Editor IA» común a las apps, con lo que hacen los editores profesionales de shorts:
// - lo que se oye es lo que se ve: cada corte muestra lo que SIGNIFICA su frase (no el orden del material);
// - un cambio visual cada 1,5-3 s, cortando en las pausas de la voz; nunca la misma toma seguida; variar el plano;
// - el gancho con el plano más potente; la acción en el clímax; sonido que acompaña (whoosh con movimiento, golpe);
// - y una revisión final del montaje antes de darlo por bueno.
// El material es un catálogo: [{ id, desc, who, shot, action (0-3), emotion, kind: 'video'|'image', … }].
import path from 'node:path';
import { run } from './ytdlp.js';
import { claudeStep } from './claude.js';

const ff = (args, timeout = 300000) => run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], timeout);
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]/g, '');
const fmt = (t) => t.toFixed(1);

// ---------- 1) cortes ----------
/**
 * Divide cada frase en cortes de ~1,5-3 s que caen en las pausas entre palabras (nunca a mitad de palabra).
 * hook: hasta ese segundo los cortes son de ~0,6 s (los vídeos virales cambian de imagen 3-4 veces en los 2 primeros s).
 * lines: [{ text, s, e, … }] con tiempos; words: [{ w, s, e }]. Devuelve [{ i, line, s, e, text, emph }]
 * (emph = segundo, relativo al corte, de la primera palabra resaltada que suena en él).
 */
export function cutSlots(lines, words, { yellow = [], red = [] } = {}, { min: minN = 1.5, target: targetN = 2.3, max: maxN = 3.1, hook = 0 } = {}) {
  const hot = new Set([...yellow, ...red].map(norm));
  const slots = [];
  for (const [li, l] of lines.entries()) {
    const ws = words.filter((w) => w.s >= l.s - 0.01 && w.s < l.e);
    let s = l.s;
    const lim = () => (s < hook ? [0.45, 0.6, 0.8] : [minN, targetN, maxN]);
    while (l.e - s > lim()[2]) {
      const [min, target, max] = lim();
      // Primero busca una pausa natural; si no hay ninguna en la ventana, corta en el límite de una palabra para
      // no dejar un plano demasiado largo. El alineador suele dejar un hueco de al menos una décima entre frases.
      const candidates = ws.map((w, i) => ({ t: w.s, gap: w.s - (ws[i - 1]?.e ?? s) }))
        .filter((x) => x.t - s >= min && x.t - s <= max && l.e - x.t >= min);
      const pauses = candidates.filter((x) => x.gap >= 0.1);
      const cands = (pauses.length ? pauses : candidates).map((x) => x.t);
      const cut = cands.length ? cands.reduce((a, b) => (Math.abs(b - s - target) < Math.abs(a - s - target) ? b : a)) : s + Math.min(target, (l.e - s) / 2);
      slots.push({ line: li, s, e: cut });
      s = cut;
    }
    slots.push({ line: li, s, e: l.e });
  }
  return slots.map((x, i) => {
    const ws = words.filter((w) => w.s >= x.s - 0.01 && w.s < x.e);
    const em = ws.find((w) => hot.has(norm(w.w)));
    return { ...x, i, text: ws.map((w) => w.w).join(' ') || lines[x.line].text, emph: em ? Math.max(0, em.s - x.s) : null };
  });
}

// ---------- 2) lista de montaje ----------
const catalogText = (catalog) => catalog.map((c) => `${c.id}: [${c.shot || 'plano'}${c.kind === 'image' ? ', foto' : ''}] ${c.desc}${c.who ? ` · sale: ${c.who}` : ''} · acción ${c.action ?? 1}/3${c.emotion ? ` · ${c.emotion}` : ''}${c.line != null ? ` · solo frase F${c.line + 1}` : ''}`).join('\n');

/**
 * El editor IA asigna una pieza del catálogo a cada corte. context: de qué va el vídeo (y quién es quién).
 * Devuelve { plan: [id por corte], climax: índice del corte del clímax, motion: [índices con whoosh] }.
 */
export async function planEdit({ slots, lines, catalog, context }, log) {
  const ids = new Set(catalog.map((c) => c.id));
  let data = {};
  try {
    const ev = await claudeStep({
      prompt: `Eres el editor de un short vertical. Tienes que decidir qué plano se ve en cada corte, como un editor profesional.

De qué va: ${context}

Guion por frases (lo que dice la voz):
${lines.map((l, i) => `F${i + 1} (${fmt(l.s)}-${fmt(l.e)} s): «${l.text}»`).join('\n')}

Cortes (hay que asignar un plano a cada uno):
${slots.map((x) => `C${x.i + 1} (F${x.line + 1}, ${fmt(x.e - x.s)} s): «${x.text}»`).join('\n')}

Material disponible (catálogo):
${catalogText(catalog)}

Reglas de edición:
1. LO QUE SE OYE ES LO QUE SE VE: cada corte muestra el plano que mejor ilustra el SIGNIFICADO de lo que se dice en él (si habla de un personaje, ese personaje; si habla de una acción, esa acción; si es un dato, el plano más relacionado). Nunca un plano que contradiga la frase.
2. Los cortes de los 2 primeros segundos (el gancho) llevan PRIMEROS PLANOS de caras con emoción fuerte (sorpresa, gritos, miedo) o la persona real de la que se habla, cada uno distinto; nunca planos generales con figuras pequeñas ni paisajes (ahí se decide si la gente se queda).
3. NUNCA el mismo id en dos cortes seguidos. No repitas un id si queda material sin usar que encaje; si repites, que estén lejos.
4. Varía el tamaño de plano (general → medio → primer plano) y alterna escenas tranquilas y con acción; el momento más fuerte del guion lleva el plano con más acción o emoción.
5. Evita planos vacíos (cielo, paisaje sin nadie) salvo que la frase hable de un lugar.
6. Las fotos (kind image, foto) solo donde la frase habla justo de eso.

Devuelve "plan": [{ "slot": número del corte, "id": id del catálogo }] para TODOS los cortes en orden, "climax": número del corte del momento más fuerte, y "motion": números de los cortes cuyo plano tiene un movimiento fuerte al entrar (llevarán un whoosh; como mucho uno de cada tres cortes).`,
      schema: {
        type: 'object',
        properties: {
          plan: { type: 'array', items: { type: 'object', properties: { slot: { type: 'number' }, id: { type: 'string' } }, required: ['slot', 'id'] } },
          climax: { type: 'number' }, motion: { type: 'array', items: { type: 'number' } },
        },
        required: ['plan', 'climax', 'motion'],
      },
      system: 'Eres editor profesional de vídeo corto vertical (YouTube Shorts, TikTok).', model: 'sonnet', effort: 'medium', tools: [],
    }, () => {}, () => {});
    data = ev.data;
  } catch (e) { log(`⚠️ Editor IA: ${e.message.slice(0, 120)} (se reparte el material sin él)`); }
  const plan = slots.map((x) => {
    const p = (data.plan ?? []).find((y) => Number(y.slot) === x.i + 1);
    const item = p && ids.has(String(p.id)) ? catalog.find((c) => c.id === String(p.id)) : null;
    // Una foto pedida para una frase solo puede aparecer en esa frase; el resto del catálogo son apoyos generales.
    return item && (item.kind !== 'image' || item.line == null || item.line === x.line) ? item.id : null;
  });
  const fixed = enforce(plan, catalog, { slotLines: slots.map((x) => x.line) });
  if (fixed.changed) log(`🧹 Editor: ${fixed.changed} corte${fixed.changed === 1 ? '' : 's'} corregido${fixed.changed === 1 ? '' : 's'} (repeticiones o huecos)`);
  return { plan: fixed.plan, climax: Math.max(0, Math.min(slots.length - 1, (Number(data.climax) || 1) - 1)), motion: (data.motion ?? []).map((n) => Number(n) - 1).filter((n) => n >= 0 && n < slots.length) };
}

/**
 * Reglas que no se discuten, por TOMA (c.group: la misma toma puede venir de varios tráileres): sin huecos, la misma
 * toma no vuelve en los 4 cortes siguientes y no se reutiliza mientras quede alguna sin usar.
 */
export function enforce(plan, catalog, { slotLines = null } = {}) {
  const out = [...plan];
  const by = new Map(catalog.map((c) => [c.id, c]));
  const g = (id) => by.get(id)?.group ?? id;
  const eligible = (c, i) => c && (c.kind !== 'image' || c.line == null || slotLines == null || c.line === slotLines[i]);
  let changed = 0;
  const count = new Map();
  out.forEach((id) => id && count.set(g(id), (count.get(g(id)) ?? 0) + 1));
  // solo mira hacia atrás: si dos cortes chocan, cambia el de después (el gancho, C1, se respeta)
  const near = (i) => new Set(out.slice(Math.max(0, i - 4), i).filter(Boolean).map(g));
  for (let i = 0; i < out.length; i++) {
    const unused = catalog.filter((c) => eligible(c, i) && !count.has(g(c.id)));
    const bad = !out[i] || !eligible(by.get(out[i]), i) || near(i).has(g(out[i])) || ((count.get(g(out[i])) ?? 0) > 1 && unused.length);
    if (!bad) continue;
    const prev = by.get(out[i - 1]);
    const ok = (c) => eligible(c, i) && !near(i).has(g(c.id));
    const pool = unused.filter(ok).length ? unused.filter(ok) : catalog.filter(ok);
    // el sustituto: el menos usado; si empata, el que contraste en acción con el anterior
    // Si el catálogo tiene menos tomas que cortes, la regla de distancia es blanda: siempre hay que devolver una
    // pieza válida para que el render no intente acceder a un item inexistente.
    const candidates = pool.length ? pool : catalog.filter((c) => eligible(c, i));
    const pick = [...candidates].sort((a, b) => (count.get(g(a.id)) ?? 0) - (count.get(g(b.id)) ?? 0) || Math.abs((b.action ?? 1) - (prev?.action ?? 1)) - Math.abs((a.action ?? 1) - (prev?.action ?? 1)))[0];
    if (!pick) continue;
    if (out[i]) count.set(g(out[i]), count.get(g(out[i])) - 1);
    out[i] = pick.id;
    count.set(g(pick.id), (count.get(g(pick.id)) ?? 0) + 1);
    changed++;
  }
  // calidad: personaje en pantalla, acción y si la IA lo eligió para miniatura (el arte oficial también cuenta)
  const q = (c) => (c?.who ? 2 : 0) + (c?.action ?? 0) + (c?.thumb ? Math.max(0, 4 - c.thumb) : 0) + (c?.kind === 'image' && /arte oficial/.test(c?.desc ?? '') ? 1 : 0);
  const used = new Set(out.map(g));
  // el gancho (C1): se respeta lo que eligió el editor salvo que sea flojo (sin personaje ni acción); entonces, el plano
  // más potente que no salga ya en el vídeo
  if (q(by.get(out[0])) < 3) {
    const rest = new Set(out.slice(1).map(g));
    const current = by.get(out[0]);
    const best = [...catalog].filter((c) => eligible(c, 0) && !rest.has(g(c.id))).sort((a, b) => q(b) - q(a))[0]
      ?? [...catalog].filter((c) => eligible(c, 0) && g(c.id) !== g(out[0])).sort((a, b) => q(b) - q(a))[0];
    if (best && q(best) > q(current)) {
      const swap = out.findIndex((id, i) => i > 0 && g(id) === g(best.id));
      // Al intercambiar, una foto específica del gancho tampoco puede acabar en otra frase.
      if (swap <= 0 || (current && eligible(current, swap))) {
        if (swap > 0) out[swap] = current.id;
        out[0] = best.id;
        changed++;
      }
    }
  }
  // como mucho un plano de ambiente (sin nadie y sin acción) por vídeo; los demás, por planos con personajes sin usar
  let ambient = 0;
  for (let i = 0; i < out.length; i++) {
    const c = by.get(out[i]);
    if (!c || c.who || (c.action ?? 0) > 0 || c.kind === 'image') continue;
    if (++ambient <= 1) continue;
    const near = new Set(out.slice(Math.max(0, i - 4), i + 5).map(g));
    const alt = catalog.filter((x) => eligible(x, i) && (x.who || x.kind === 'image') && !near.has(g(x.id)))
      .sort((a, b) => Number(used.has(g(a.id))) - Number(used.has(g(b.id))) || q(b) - q(a))[0];
    if (alt) { out[i] = alt.id; used.add(g(alt.id)); changed++; }
  }
  return { plan: out, changed };
}

/** Huella visual (dHash 64 bits) de una imagen: tomas casi iguales dan huellas casi iguales. */
export async function dhash(file, at = null) {
  const { execFile } = await import('node:child_process');
  // sobre el recorte vertical central (lo que de verdad se ve en el short)
  const buf = await new Promise((resolve) => execFile('ffmpeg', ['-v', 'error', ...(at != null ? ['-ss', String(at)] : []), '-i', file, '-frames:v', '1', '-vf', "crop='min(iw,ih*9/16)':ih,scale=9:8:flags=area,format=gray", '-f', 'rawvideo', '-'], { encoding: 'buffer' }, (_e, o) => resolve(o)));
  if (!buf || buf.length < 72) return null;
  let h = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) h = (h << 1n) | (buf[y * 9 + x] > buf[y * 9 + x + 1] ? 1n : 0n);
  return h.toString(16);
}
const ham = (a, b) => { let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };

/** Agrupa el catálogo por toma (huellas a ≤ 14 bits de 64): c.group. */
export function groupTakes(catalog) {
  const reps = [];
  for (const [i, c] of catalog.entries()) {
    const r = c.hash && reps.find((x) => ham(x.hash, c.hash) <= 14);
    c.group = r ? r.group : `T${i + 1}`;
    if (!r && c.hash) reps.push({ hash: c.hash, group: c.group });
  }
  return new Set(catalog.map((c) => c.group)).size;
}

// ---------- 3) revisión final ----------
/**
 * La IA mira un fotograma de cada corte (rejilla numerada) junto a su frase y señala los que no encajan, están repetidos o
 * vacíos, con un id de reemplazo del catálogo. frames: rutas de un .jpg por corte. Devuelve { [índice]: idNuevo }.
 */
export async function reviewEdit({ frames, slots, plan, catalog, context, dir }) {
  const tag = path.join(dir, `review-${Date.now().toString(36)}`);
  for (const [i, f] of frames.entries()) {
    await ff(['-i', f, '-frames:v', '1', '-vf', `scale=180:320:force_original_aspect_ratio=increase,crop=180:320,drawtext=text='${i + 1}':x=6:y=6:fontsize=34:fontcolor=yellow:box=1:boxcolor=black@0.75:boxborderw=4,format=yuvj420p`, `${tag}-${String(i).padStart(2, '0')}.jpg`]);
  }
  await ff(['-framerate', '1', '-i', `${tag}-%02d.jpg`, '-vf', `tile=10x${Math.ceil(frames.length / 10)}:padding=4:color=white`, '-frames:v', '1', `${tag}.jpg`]);
  try {
    const ev = await claudeStep({
      prompt: `Lee la imagen ${path.basename(tag)}.jpg: es el montaje de un short vertical, un fotograma por corte, numerados en orden. De qué va: ${context}
Lo que dice la voz en cada corte:
${slots.map((x) => `${x.i + 1}: «${x.text}»`).join('\n')}

Revisa como un editor exigente y devuelve en "fix" SOLO los cortes que de verdad fallan: el plano no tiene nada que ver con lo que se dice o lo contradice, es casi igual al corte anterior o siguiente (misma toma), está vacío o es de muy mala calidad. Para cada uno, "id" = el mejor reemplazo de este catálogo (que no esté en los cortes vecinos):
${catalogText(catalog)}
Si el montaje está bien, "fix" vacío.`,
      schema: { type: 'object', properties: { fix: { type: 'array', items: { type: 'object', properties: { slot: { type: 'number' }, id: { type: 'string' }, why: { type: 'string' } }, required: ['slot', 'id', 'why'] } } }, required: ['fix'] },
      system: 'Eres editor jefe de vídeo corto. Miras imágenes con la herramienta Read.', model: 'sonnet', effort: 'medium', tools: ['Read'], cwd: dir,
    }, () => {}, () => {});
    const ids = new Set(catalog.map((c) => c.id));
    const fixes = {};
    for (const f of ev.data.fix ?? []) {
      const i = Number(f.slot) - 1;
      const item = catalog.find((c) => c.id === String(f.id));
      if (i >= 0 && i < plan.length && item && (item.kind !== 'image' || item.line == null || item.line === slots[i].line) && String(f.id) !== plan[i - 1] && String(f.id) !== plan[i + 1]) fixes[i] = { id: String(f.id), why: f.why };
    }
    // el gancho solo cambia por un plano con más acción o emoción (no por uno más flojo)
    const by = new Map(catalog.map((c) => [c.id, c]));
    if (fixes[0] && (by.get(fixes[0].id)?.action ?? 0) < (by.get(plan[0])?.action ?? 0)) delete fixes[0];
    return fixes;
  } catch { return {}; }
}

// ---------- 4) sonido ----------
/** Pista de efectos (whoosh en los cortes con movimiento y golpe en el clímax), generada con ffmpeg y sin licencias. */
export async function sfxTrack({ whooshAt = [], impactAt = null, total, dir }) {
  const whoosh = path.join(dir, 'sfx-whoosh.wav'), impact = path.join(dir, 'sfx-impact.wav'), out = path.join(dir, `sfx-${Date.now().toString(36)}.wav`);
  // whoosh: ruido rosa filtrado que entra y se va (0,45 s); golpe: grave que cae + chasquido
  await ff(['-f', 'lavfi', '-i', 'anoisesrc=d=0.45:c=pink:a=0.6', '-af', 'highpass=f=350,lowpass=f=5000,afade=t=in:d=0.25,afade=t=out:st=0.25:d=0.2,volume=0.5', '-ar', '44100', '-ac', '2', whoosh]);
  await ff(['-f', 'lavfi', '-i', "aevalsrc='0.9*sin(2*PI*(90-50*t)*t)*exp(-4*t)':d=0.9", '-f', 'lavfi', '-i', 'anoisesrc=d=0.15:c=white:a=0.4', '-filter_complex', '[1]lowpass=f=2500,afade=t=out:d=0.15[n];[0][n]amix=inputs=2:normalize=0,volume=0.8', '-ar', '44100', '-ac', '2', impact]);
  const ev = [...whooshAt.map((t) => [whoosh, Math.max(0, t - 0.2)]), ...(impactAt != null ? [[impact, impactAt]] : [])];
  if (!ev.length) return null;
  const inputs = ev.flatMap(([f]) => ['-i', f]);
  const chains = ev.map(([, t], k) => `[${k}]adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)}[d${k}]`).join(';');
  await ff([...inputs, '-filter_complex', `${chains};${ev.map((_, k) => `[d${k}]`).join('')}amix=inputs=${ev.length}:normalize=0,apad=whole_dur=${total.toFixed(2)}`, '-t', total.toFixed(2), '-ar', '44100', '-ac', '2', out]);
  return out;
}

// ---------- 5) ritmo de la voz ----------
/**
 * Acorta las pausas de la voz (ElevenLabs deja 0,5-1,2 s con respiración tras cada punto: medido, 10-15 % del audio;
 * los canales grandes de anime hablan casi sin pausas, ~3 palabras/s). Recorta cada hueco entre palabras de más de
 * maxGap s y lo deja en maxGap, y desplaza los tiempos de las palabras (no hace falta volver a alinear).
 * Devuelve { file, words, duration }.
 */
export async function tightenVoice(file, words, duration, { maxGap = 0.22 } = {}) {
  const cuts = [];
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].s - words[i].e;
    if (gap > maxGap + 0.13) cuts.push([words[i].e + maxGap * 0.4, words[i + 1].s - maxGap * 0.6]);
  }
  if (!cuts.length) return { file, words, duration };
  const keep = [];
  let t = 0;
  for (const [a, b] of cuts) { keep.push([t, a]); t = b; }
  keep.push([t, duration]);
  const out = file.replace(/\.mp3$/, '') + '.tight.mp3';
  const chains = keep.map(([a, b], k) => `[0:a]atrim=${a.toFixed(3)}:${b.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.01,afade=t=out:st=${Math.max(0, b - a - 0.01).toFixed(3)}:d=0.01[k${k}]`).join(';');
  await ff(['-i', file, '-filter_complex', `${chains};${keep.map((_, k) => `[k${k}]`).join('')}concat=n=${keep.length}:v=0:a=1[o]`, '-map', '[o]', '-ar', '44100', '-b:a', '192k', out]);
  const shift = (x) => x - cuts.reduce((s, [a, b]) => s + (x >= b ? b - a : x > a ? x - a : 0), 0);
  return { file: out, words: words.map((w) => ({ ...w, s: shift(w.s), e: shift(w.e) })), duration: shift(duration) };
}
