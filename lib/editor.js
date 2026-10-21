// «Editor IA» común a las apps, con lo que hacen los editores profesionales de shorts:
// - lo que se oye es lo que se ve: cada corte muestra lo que SIGNIFICA su frase (no el orden del material);
// - un cambio visual cada 1,5-3 s, cortando en las pausas de la voz; nunca la misma toma seguida; variar el plano;
// - el gancho con el plano más potente; la acción en el clímax; sonido que acompaña (whoosh con movimiento, golpe);
// - y una revisión final del montaje antes de darlo por bueno.
// El material es un catálogo: [{ id, desc, who, shot, action (0-3), emotion, kind: 'video'|'image', … }].
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from './ytdlp.js';
import { claudeStep } from './claude.js';

const SFX_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sfx');

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
const catalogText = (catalog) => catalog.map((c) => `${c.id}: [${c.shot || 'plano'}${c.kind === 'image' ? ', foto' : ''}${c.layout === 'card' ? ', encuadre completo' : ''}] ${c.desc}${c.who ? ` · sale: ${c.who}` : ''} · acción ${c.action ?? 1}/3${c.emotion ? ` · ${c.emotion}` : ''}${c.line != null ? ` · EXCLUSIVO y PRIORITARIO para frase F${c.line + 1}` : ''}`).join('\n');

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

Guion por frases (lo que dice la voz y qué pide ver en pantalla):
${lines.map((l, i) => `F${i + 1} (${fmt(l.s)}-${fmt(l.e)} s): «${l.text}»${l.visual ? ` → [Mostrar: ${l.visual}]` : ''}`).join('\n')}

Cortes (hay que asignar un plano a cada uno):
${slots.map((x) => `C${x.i + 1} (F${x.line + 1}, ${fmt(x.e - x.s)} s): «${x.text}»${lines[x.line]?.visual ? ` [Visual F${x.line + 1}: ${lines[x.line].visual}]` : ''}`).join('\n')}

Material disponible (catálogo):
${catalogText(catalog)}

Reglas de edición:
1. LO QUE SE OYE ES LO QUE SE VE: cada corte muestra el plano que mejor ilustra el SIGNIFICADO exacto de lo que se dice en él y lo que pide [Mostrar: …] (si habla de un personaje, ese personaje bien visible; si habla de una acción o gesto, esa acción; si menciona al creador, actor, noticia o prueba, la foto/vídeo correspondiente). Nunca un plano que contradiga la frase.
2. PRIORIDAD DE CONTENIDO ESPECÍFICO: si en el catálogo hay piezas marcadas con «EXCLUSIVO y PRIORITARIO para frase Fk», DEBES usarlas en los cortes de esa frase Fk justo cuando la voz habla de ese elemento.
3. Los cortes de los 2 primeros segundos (el gancho) llevan PRIMEROS PLANOS de caras con emoción fuerte (sorpresa, gritos, tensión) o la persona/escena protagonista de la que se habla, cada uno distinto; nunca planos generales con figuras pequeñas ni paisajes vacíos.
4. NUNCA el mismo id en dos cortes seguidos. No repitas un id si queda material sin usar que encaje; si repites, que estén lejos.
5. Varía el tamaño de plano (general → medio → primer plano) y alterna escenas tranquilas y con acción; el momento más fuerte del guion lleva el plano con más acción o emoción.
6. Evita planos vacíos (cielo, paisaje sin nadie) salvo que la frase hable de un lugar.

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
    // Una pieza pedida para una frase concreta solo puede aparecer en esa frase; el resto del catálogo son apoyos generales.
    return item && (item.line == null || item.line === x.line) ? item.id : null;
  });
  const fixed = enforce(plan, catalog, { slotLines: slots.map((x) => x.line) });
  if (fixed.changed) log(`🧹 Editor: ${fixed.changed} corte${fixed.changed === 1 ? '' : 's'} corregido${fixed.changed === 1 ? '' : 's'} (repeticiones o huecos)`);
  return { plan: fixed.plan, climax: Math.max(0, Math.min(slots.length - 1, (Number(data.climax) || 1) - 1)), motion: (data.motion ?? []).map((n) => Number(n) - 1).filter((n) => n >= 0 && n < slots.length) };
}

/**
 * Reglas que no se discuten, por TOMA (c.group: la misma toma puede venir de varios tráileres): sin huecos, la misma
 * toma no vuelve en los 4 cortes siguientes, no se reutiliza mientras quede alguna sin usar, y si una frase tiene
 * material específico descargado para ella (`c.line === line`), se garantiza que aparezca en esa frase.
 */
export function enforce(plan, catalog, { slotLines = null } = {}) {
  const out = [...plan];
  const by = new Map(catalog.map((c) => [c.id, c]));
  const g = (id) => by.get(id)?.group ?? id;
  const eligible = (c, i) => c && (c.line == null || slotLines == null || c.line === slotLines[i]);
  let changed = 0;
  // 1) Garantizar que cada frase que pidió contenido específico (foto o vídeo con `c.line === L`) lo muestre en pantalla.
  if (slotLines) {
    const linesWithSpecific = [...new Set(catalog.filter((c) => c.line != null).map((c) => c.line))];
    for (const L of linesWithSpecific) {
      const idxs = slotLines.map((line, idx) => (line === L ? idx : -1)).filter((idx) => idx >= 0);
      if (!idxs.length) continue;
      const hasSpecific = idxs.some((idx) => by.get(out[idx])?.line === L);
      if (!hasSpecific) {
        const specItem = catalog.find((c) => c.line === L);
        if (specItem) {
          out[idxs[0]] = specItem.id;
          changed++;
        }
      }
    }
  }
  const count = new Map();
  out.forEach((id) => id && count.set(g(id), (count.get(g(id)) ?? 0) + 1));
  // solo mira hacia atrás: si dos cortes chocan, cambia el de después (el gancho, C1, se respeta)
  const near = (i) => new Set(out.slice(Math.max(0, i - 4), i).filter(Boolean).map(g));
  for (let i = 0; i < out.length; i++) {
    const cur = by.get(out[i]);
    // Si este corte es el único que muestra el material específico de su frase, no lo reemplazamos por uno genérico.
    const isSoleSpecific = cur?.line != null && slotLines && slotLines.filter((l, idx) => l === cur.line && by.get(out[idx])?.line === cur.line).length <= 1 && !near(i).has(g(out[i]));
    if (isSoleSpecific) continue;
    const unused = catalog.filter((c) => eligible(c, i) && !count.has(g(c.id)));
    const bad = !out[i] || !eligible(cur, i) || near(i).has(g(out[i])) || ((count.get(g(out[i])) ?? 0) > 1 && unused.length);
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
  // el gancho (C1): se respeta lo que eligió el editor salvo que sea flojo (sin personaje ni acción ni material específico);
  // entonces, el plano más potente que no salga ya en el vídeo
  if (q(by.get(out[0])) < 3 && by.get(out[0])?.line == null) {
    const rest = new Set(out.slice(1).map(g));
    const current = by.get(out[0]);
    const best = [...catalog].filter((c) => eligible(c, 0) && !rest.has(g(c.id))).sort((a, b) => q(b) - q(a))[0]
      ?? [...catalog].filter((c) => eligible(c, 0) && g(c.id) !== g(out[0])).sort((a, b) => q(b) - q(a))[0];
    if (best && q(best) > q(current)) {
      const swap = out.findIndex((id, i) => i > 0 && g(id) === g(best.id));
      // Al intercambiar, una pieza específica del gancho tampoco puede acabar en otra frase.
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
    if (!c || c.who || (c.action ?? 0) > 0 || c.kind === 'image' || c.line != null) continue;
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
export async function reviewEdit({ frames, slots, lines = [], plan, catalog, context, dir }) {
  const tag = path.join(dir, `review-${Date.now().toString(36)}`);
  for (const [i, f] of frames.entries()) {
    await ff(['-i', f, '-frames:v', '1', '-vf', `scale=180:320:force_original_aspect_ratio=increase,crop=180:320,drawtext=text='${i + 1}':x=6:y=6:fontsize=34:fontcolor=yellow:box=1:boxcolor=black@0.75:boxborderw=4,format=yuvj420p`, `${tag}-${String(i).padStart(2, '0')}.jpg`]);
  }
  await ff(['-framerate', '1', '-i', `${tag}-%02d.jpg`, '-vf', `tile=10x${Math.ceil(frames.length / 10)}:padding=4:color=white`, '-frames:v', '1', `${tag}.jpg`]);
  try {
    const ev = await claudeStep({
      prompt: `Lee la imagen ${path.basename(tag)}.jpg: es el montaje de un short vertical, un fotograma por corte, numerados en orden. De qué va: ${context}
Lo que dice la voz en cada corte:
${slots.map((x) => `${x.i + 1}: «${x.text}»${lines[x.line]?.visual ? ` [Visual pedido: ${lines[x.line].visual}]` : ''}`).join('\n')}

Revisa como un editor exigente y devuelve en "fix" SOLO los cortes que de verdad fallan: el plano no tiene nada que ver con lo que se dice o lo contradice, el protagonista o detalle clave quedó mal encuadrado o cortado en el borde, es casi igual al corte anterior o siguiente (misma toma), está vacío o es de muy mala calidad. Para cada uno, "id" = el mejor reemplazo de este catálogo (que no esté en los cortes vecinos):
${catalogText(catalog)}
Si el montaje está bien, "fix" vacío.`,
      schema: { type: 'object', properties: { fix: { type: 'array', items: { type: 'object', properties: { slot: { type: 'number' }, id: { type: 'string' }, why: { type: 'string' } }, required: ['slot', 'id', 'why'] } } }, required: ['fix'] },
      system: 'Eres editor jefe de vídeo corto. Miras imágenes con la herramienta Read.', model: 'sonnet', effort: 'medium', tools: ['Read'], cwd: dir,
    }, () => {}, () => {});
    const by = new Map(catalog.map((c) => [c.id, c]));
    const fixes = {};
    for (const f of ev.data.fix ?? []) {
      const i = Number(f.slot) - 1;
      const item = by.get(String(f.id));
      const cur = by.get(plan[i]);
      // No quitar la única pieza específica de una frase por una genérica salvo que sea por otra específica de la misma frase.
      if (cur?.line != null && item?.line !== cur.line) continue;
      if (i >= 0 && i < plan.length && item && (item.line == null || item.line === slots[i].line) && String(f.id) !== plan[i - 1] && String(f.id) !== plan[i + 1]) fixes[i] = { id: String(f.id), why: f.why };
    }
    // el gancho solo cambia por un plano con más acción o emoción (no por uno más flojo)
    if (fixes[0] && (by.get(fixes[0].id)?.action ?? 0) < (by.get(plan[0])?.action ?? 0)) delete fixes[0];
    return fixes;
  } catch { return {}; }
}

// ---------- 4) transiciones y sonido ----------
/**
 * Planifica qué transición visual y auditiva lleva cada corte para que imagen y sonido caigan SIEMPRE en pausas
 * naturales (cambios de frase/bloque narrativo) y nunca a mitad de una frase hablada:
 * - en el clímax (`climax`): flash blanco corto + sacudida de cámara amortiguada (`impact`);
 * - en cortes que abren una frase nueva (`Math.abs(slot.s - line.s) < 0.08`, espaciados ≥ 7,5 s): alterna `whip-left`,
 *   `zoom` y `whip-right` (máximo 3-4 en todo el short para no saturar).
 */
export function planTransitions({ slots = [], lines = [], plan = [], byId = new Map(), motion = [], climax = null }) {
  const transIn = new Array(slots.length).fill(null);
  const transOut = new Array(slots.length).fill(null);
  const whooshAt = [];
  const flashAt = [];

  if (climax != null && climax > 0 && slots[climax]) {
    transIn[climax] = 'impact';
  }

  // Un corte es frontera de frase cuando empieza justo donde empieza una frase del guion (tras punto y pausa de voz).
  const isLineStart = (i) => {
    const s = slots[i]?.s;
    if (s == null) return false;
    if (lines.length) return lines.some((l, li) => li > 0 && Math.abs(l.s - s) < 0.08);
    return true;
  };

  const cycle = ['whip-left', 'zoom', 'whip-right'];
  let cycleIdx = 0;
  let lastWhoosh = -9;
  const motionSet = new Set(motion);
  // Prioriza inicios de frase donde el editor pidió movimiento; si no, inicios de frase bien espaciados.
  const lineStartSlots = slots.map((_, i) => i).filter((i) => i > 0 && isLineStart(i));
  const candidates = [
    ...lineStartSlots.filter((i) => motionSet.has(i)),
    ...lineStartSlots.filter((i) => !motionSet.has(i)),
  ].sort((a, b) => a - b);

  for (const i of candidates) {
    if (transIn[i]) continue;
    const t = slots[i].s;
    if (t < 3.5 || t > (slots.at(-1)?.e ?? 48) - 2.5) continue;
    if (t - lastWhoosh < 7.5) continue;
    if (climax != null && Math.abs(t - (slots[climax]?.s ?? -9)) < 3.5) continue;
    transIn[i] = cycle[cycleIdx++ % cycle.length];
    whooshAt.push(t);
    lastWhoosh = t;
    if (whooshAt.length >= 4) break;
  }

  for (let i = 0; i < slots.length - 1; i++) {
    const next = transIn[i + 1];
    if (next === 'whip-left' || next === 'whip-right' || next === 'zoom') transOut[i] = next;
  }

  return {
    transitions: slots.map((_, i) => ({ transIn: transIn[i], transOut: transOut[i] })),
    whooshAt,
    flashAt,
    impactAt: climax != null ? (slots[climax]?.s ?? null) : null,
  };
}

/**
 * Aplica transiciones reales entre pares de cortes (`xfade`: `smoothleft`, `smoothright`, `zoomin`, `fadewhite` + sacudida)
 * centradas en el instante exacto de unión (`d1`) sin alterar la duración ni el número de fotogramas de ningún corte.
 */
export async function applyPairTransitions(parts, slots, transitions, { fps = 30, w = 1080, h = 1920 } = {}) {
  const { renameSync, rmSync } = await import('node:fs');
  for (let i = 1; i < slots.length; i++) {
    const kind = transitions[i]?.transIn;
    if (!kind || !parts[i - 1] || !parts[i]) continue;
    const d1 = +(slots[i - 1].e - slots[i - 1].s).toFixed(3);
    const d2 = +(slots[i].e - slots[i].s).toFixed(3);
    if (d1 < 0.45 || d2 < 0.45) continue;

    const half = kind === 'impact' ? 0.09 : 0.14;
    const dur = +(half * 2).toFixed(3);
    const offset = +(d1 - half).toFixed(3);
    const xfName = kind === 'whip-left'
      ? 'smoothleft'
      : kind === 'whip-right'
        ? 'smoothright'
        : kind === 'zoom'
          ? 'zoomin'
          : 'fadewhite';

    const postFilter = kind === 'whip-left' || kind === 'whip-right'
      ? `,avgblur=sizeX=20:sizeY=1:enable='between(t,${+(d1 - 0.08).toFixed(3)},${+(d1 + 0.08).toFixed(3)})'`
      : kind === 'impact'
        ? `,scale=${Math.round(w * 1.12)}:${Math.round(h * 1.12)}:force_original_aspect_ratio=increase,crop=${w}:${h}:x='(iw-ow)/2+if(between(t,${d1},${+(d1 + 0.24).toFixed(3)}),sin((t-${d1})*115)*exp(-12*(t-${d1}))*42,0)':y='(ih-oh)/2+if(between(t,${d1},${+(d1 + 0.24).toFixed(3)}),cos((t-${d1})*150)*exp(-12*(t-${d1}))*30,0)'`
        : '';

    const pairFile = `${parts[i]}.pair.mp4`;
    const outA = `${parts[i - 1]}.txa.mp4`;
    const outB = `${parts[i]}.txb.mp4`;
    const f1 = Math.max(1, Math.round(d1 * fps));
    const f2 = Math.max(1, Math.round(d2 * fps));

    await ff([
      '-i', parts[i - 1], '-i', parts[i],
      '-filter_complex', `[0:v]fps=${fps},settb=AVTB,tpad=stop_duration=${half}:stop_mode=clone[v0];[1:v]fps=${fps},settb=AVTB,tpad=start_duration=${half}:start_mode=clone[v1];[v0][v1]xfade=transition=${xfName}:duration=${dur}:offset=${offset}${postFilter},fps=${fps},format=yuv420p[out]`,
      '-map', '[out]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', pairFile,
    ]);
    await ff(['-i', pairFile, '-frames:v', String(f1), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', outA]);
    await ff(['-ss', String(d1), '-i', pairFile, '-frames:v', String(f2), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', outB]);
    renameSync(outA, parts[i - 1]);
    renameSync(outB, parts[i]);
    rmSync(pairFile, { force: true });
  }
}

/**
 * Pista de efectos y enganches auditivos con muestras reales de edición (`lib/sfx/`), colocados solo en pausas/cambios
 * narrativos reales (nunca a mitad de frase):
 * - ding.wav: campanita sutil en la palabra clave del gancho inicial y al abrir la pregunta final;
 * - whoosh-1..3.wav: 3 variantes de deep/whip swoosh (Sam Kolder pack) cuyo pico cae exacto en el cambio de frase;
 * - impact.wav: golpe grave limpio en el corte del clímax (sin riser previo que pise la voz).
 */
export async function sfxTrack({ whooshAt = [], flashAt = [], impactAt = null, dingAt = null, popAt = null, slots = [], lines = [], total, dir }) {
  const out = path.join(dir, `sfx-${Date.now().toString(36)}.wav`);
  const sample = (name) => path.join(SFX_DIR, name);

  const near = (list, t, minGap = 1.8) => list.some((x) => Math.abs(x - t) < minGap);
  // impactAt puede ser un instante (shorts) o una lista (vídeos largos con un golpe por capítulo)
  const impacts = [].concat(impactAt ?? []).filter((x) => Number.isFinite(x));
  const nearImpact = (t, gap) => impacts.some((x) => Math.abs(x - t) < gap);
  const emphTimes = slots.filter((s) => s.emph != null).map((s) => +(s.s + s.emph).toFixed(3));

  // 1) Campanita real (ding): solo en el gancho inicial (≤ 3,0 s) y al abrir la pregunta/remate final (inicio de la última frase).
  const dings = [...(dingAt ?? [])];
  if (!dingAt && slots.length) {
    const hookDing = emphTimes.find((t) => t >= 0.4 && t <= 3.0);
    if (hookDing != null && !nearImpact(hookDing, 2.0)) dings.push(hookDing);
    const tailStart = lines.at(-1)?.s;
    if (tailStart && tailStart > 12 && tailStart < total - 1.5 && !near(dings, tailStart, 6) && !nearImpact(tailStart, 2.5)) {
      dings.push(tailStart);
    }
  }

  const flashes = (flashAt ?? []).filter((t) => !near(dings, t, 1.5) && !nearImpact(t, 2.0));
  const pops = (popAt ?? []).filter((t) => !near(dings, t, 1.5) && !near(whooshAt, t, 1.5));

  const occupied = [...dings, ...flashes, ...pops, ...impacts];
  const cleanWhoosh = whooshAt.filter((t) => !near(occupied, t, 1.8));

  // Cada muestra tiene su pico de energía medido a 10 ms para que caiga en el fotograma exacto del corte (t + 0,000 s).
  const whooshes = [
    { file: sample('whoosh-1.wav'), peak: 0.16, vol: 0.72 },
    { file: sample('whoosh-2.wav'), peak: 0.17, vol: 0.75 },
    { file: sample('whoosh-3.wav'), peak: 0.16, vol: 0.72 },
  ].filter((w) => existsSync(w.file));
  const popFiles = ['pop-1.wav', 'pop-2.wav'].map(sample).filter(existsSync);
  const dingFile = sample('ding.wav');
  const shutterFile = sample('shutter.wav');
  const impactFile = sample('impact.wav');

  const ev = [
    ...cleanWhoosh.map((t, i) => {
      const w = whooshes[i % whooshes.length];
      return w ? [w.file, Math.max(0, t - w.peak), w.vol] : [null, 0, 1];
    }),
    ...(existsSync(shutterFile) ? flashes.map((t) => [shutterFile, Math.max(0, t - 0.08), 0.65]) : []),
    ...(existsSync(impactFile) ? impacts.map((t) => [impactFile, Math.max(0, t - 0.06), 0.78]) : []),
    ...(existsSync(dingFile) ? dings.map((t) => [dingFile, Math.max(0, t - 0.04), 0.55]) : []),
    ...(popFiles.length ? pops.map((t, i) => [popFiles[i % popFiles.length], Math.max(0, t - 0.03), 0.58]) : []),
  ].filter(([f]) => f && existsSync(f));
  if (!ev.length) return null;

  const inputs = ev.flatMap(([f]) => ['-i', f]);
  const chains = ev.map(([, t, vol], k) => `[${k}]volume=${vol.toFixed(2)},adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)}[d${k}]`).join(';');
  await ff([...inputs, '-filter_complex', `${chains};${ev.map((_, k) => `[d${k}]`).join('')}amix=inputs=${ev.length}:normalize=0,apad=whole_dur=${total.toFixed(2)}`, '-t', total.toFixed(2), '-ar', '44100', '-ac', '2', out]);
  return out;
}

// ---------- 5) ritmo de la voz ----------
/**
 * Acorta las pausas largas de la voz y aplica ecualización/compresión de presencia para shorts:
 * - recorta ÚNICAMENTE dentro de silencios acústicos reales (`silencedetect` a -40 dB), nunca guiándose a ciegas por
 *   `w.e` de Whisper (porque en números como «48» o «146» y en consonantes finales Whisper suele situar `w.e` antes
 *   de que el narrador termine de pronunciar «y ocho» o «y seis»);
 * - deja siempre un colchón natural tras el final real de la voz (110 ms después de caer bajo -40 dB) y antes de la
 *   palabra siguiente (90 ms), y corrige `w.e` cuando Whisper lo cerró antes de que acabara de sonar la palabra/número;
 * - aplica filtro de presencia vocal (corte de graves < 80 Hz, cuerpo en 185 Hz, brillo en 3,5 kHz y compresor suave).
 * Devuelve { file, words, duration }.
 */
export async function tightenVoice(file, words, duration, { maxGap = 0.20 } = {}) {
  const { execFile } = await import('node:child_process');
  // Detección acústica real a -40 dB: garantiza que jamás se corte una sílaba final, consonante suave (-s, -n, -d)
  // ni la cola de un número («cuarenta y ocho», «ciento cuarenta y seis») que siga sonando aunque Whisper cierre antes `w.e`.
  const padAfter = Math.max(0.11, maxGap * 0.55);
  const padBefore = Math.max(0.09, maxGap * 0.45);
  const minSilence = +(padAfter + padBefore + 0.03).toFixed(2);
  const silenceLog = await new Promise((resolve) => execFile(
    'ffmpeg',
    ['-nostdin', '-i', file, '-af', `silencedetect=noise=-40dB:d=${minSilence}`, '-f', 'null', '-'],
    { timeout: 60000 },
    (_e, _o, stderr) => resolve(String(stderr || '')),
  ));
  const starts = [...silenceLog.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => +m[1]);
  const ends = [...silenceLog.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => +m[1]);
  const silences = [];
  const cuts = [];
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    const s = starts[i], e = ends[i];
    if (s < 0.20 || e > duration - 0.20) continue;
    silences.push([s, e]);
    const a = +(s + padAfter).toFixed(3);
    const b = +(e - padBefore).toFixed(3);
    if (b - a > 0.02) cuts.push([a, b]);
  }
  // Si Whisper cerró `w.e` antes de que terminara de sonar un número o final de frase, lo extendemos hasta el inicio real del silencio `s`
  const fixedWords = words.map((w, i) => {
    const nextS = words[i + 1]?.s ?? duration;
    let we = w.e;
    for (const [s, e] of silences) {
      if (w.s < s && we < s && nextS >= s - 0.05 && s - we <= 0.85) {
        we = +(s - 0.01).toFixed(3);
        break;
      }
      if (e > nextS) break;
    }
    return we !== w.e ? { ...w, e: we } : w;
  });
  if (!cuts.length) return { file, words: fixedWords, duration };
  const keep = [];
  let t = 0;
  for (const [a, b] of cuts) { if (a > t + 0.01) keep.push([t, a]); t = b; }
  if (duration > t + 0.01) keep.push([t, duration]);
  const out = file.replace(/\.mp3$/, '') + '.tight.mp3';
  const chains = keep.map(([a, b], k) => `[0:a]atrim=${a.toFixed(3)}:${b.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.008,afade=t=out:st=${Math.max(0, b - a - 0.008).toFixed(3)}:d=0.008[k${k}]`).join(';');
  const vocalMaster = 'highpass=f=80,equalizer=f=185:t=q:w=1.2:g=1.6,equalizer=f=3500:t=q:w=1.4:g=2.4,acompressor=threshold=-18dB:ratio=2.2:attack=8:release=80:makeup=1.5';
  await ff(['-i', file, '-filter_complex', `${chains};${keep.map((_, k) => `[k${k}]`).join('')}concat=n=${keep.length}:v=0:a=1,${vocalMaster}[o]`, '-map', '[o]', '-ar', '44100', '-b:a', '192k', out]);
  const shift = (x) => +(x - cuts.reduce((s, [a, b]) => s + (x >= b ? b - a : x > a ? x - a : 0), 0)).toFixed(3);
  return {
    file: out,
    words: fixedWords.map((w) => {
      // Si Whisper pegó un silencio al inicio de la palabra (`w.s` cae antes/dentro del recorte pero la voz suena al final),
      // ajustamos `w.s` tras el corte para que el subtítulo no salga en silencio.
      let ws = w.s;
      for (const [a, b] of cuts) {
        if (ws <= a + 0.05 && w.e > b + 0.04 && (w.e - ws) - (b - a) >= 0.08) ws = b;
      }
      const ns = shift(ws), ne = Math.max(+(ns + 0.06).toFixed(3), shift(w.e));
      return { ...w, s: ns, e: ne };
    }),
    duration: shift(duration),
  };
}
