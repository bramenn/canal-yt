// Coherencia del guion: cada idea se explica UNA vez y cada segmento existe porque aporta algo nuevo
// y continúa lo anterior. Un detector mecánico encuentra pistas (definiciones repetidas, frases casi
// iguales, exceso de resúmenes, estructura anunciada dos veces) y Claude Code hace de editor.

const STOP = new Set('el la los las un una unos unas de del al a en y o que es son por para con sin tu tus su sus lo se no ya más mas muy como esto eso esa ese este esta pero si te me le les nos hay ha han fue era'.split(' '));
const clean = (s) => String(s ?? '').replace(/\*/g, '');
const content = (x) => new Set((x.toLowerCase().match(/[a-záéíóúñ0-9]+/g) ?? []).filter((w) => !STOP.has(w) && w.length > 2));
const sentencesOf = (t) => clean(t).split(/(?<=[.?!…])\s+|\n+/).map((x) => x.trim()).filter((x) => x.split(/\s+/).length >= 5);

/** Pistas mecánicas de redundancia (no lo detecta todo: el editor juzga el fondo). */
export function detectRedundancy(video) {
  const segs = (video?.segments ?? []).map((s) => clean(s.narration));
  const issues = [];

  // 1) el mismo término definido en varios segmentos ("un token es…", "la cuota es lo que…")
  const defs = {};
  segs.forEach((s, i) => {
    for (const m of s.matchAll(/\b(?:un|una|el|la|los|las)\s+([a-záéíóúñ]+)\s+(?:es|son)\s+(?:un|una|el|la|lo que|básicamente|más o menos)\b/gi)) {
      const k = m[1].toLowerCase();
      if (k.length < 4) continue;
      (defs[k] ??= new Set()).add(i);
    }
  });
  for (const [term, set] of Object.entries(defs)) if (set.size > 1) issues.push({ type: 'definicion', segments: [...set], detail: `«${term}» se define en ${set.size} segmentos` });

  // 2) frases casi iguales en segmentos distintos
  const sents = segs.flatMap((s, i) => sentencesOf(s).map((t) => ({ i, t, c: content(t) })));
  for (let a = 0; a < sents.length; a++) for (let b = a + 1; b < sents.length; b++) {
    const x = sents[a], y = sents[b];
    if (x.i === y.i || !x.c.size || !y.c.size) continue;
    const inter = [...x.c].filter((w) => y.c.has(w)).length;
    if (inter >= 3 && inter / new Set([...x.c, ...y.c]).size >= 0.5) issues.push({ type: 'repeticion', segments: [x.i, y.i], detail: `«${x.t.slice(0, 70)}» ≈ «${y.t.slice(0, 70)}»` });
  }

  // 3) estructura anunciada más de una vez
  const announce = segs.map((s, i) => (/\b(te lo cuento|vamos a ver|te explico|veremos) en (dos|tres|cuatro|\d) (pasos|partes|bloques)/i.test(s) ? i : -1)).filter((i) => i >= 0);
  if (announce.length > 1) issues.push({ type: 'estructura', segments: announce, detail: 'la estructura del vídeo se anuncia varias veces' });

  // 4) demasiados mini-resúmenes ("O sea…", "En resumen…")
  const recaps = segs.map((s, i) => ((s.match(/\b(o sea|en resumen|resumiendo|recapitulando|es decir)\b/gi) ?? []).length ? i : -1)).filter((i) => i >= 0);
  if (recaps.length > 3) issues.push({ type: 'resumenes', segments: recaps, detail: `resúmenes («o sea», «en resumen»…) en ${recaps.length} segmentos` });

  return issues;
}

export const COHERENCE_SCHEMA = {
  type: 'object',
  properties: {
    map: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' }, question: { type: 'string' }, adds: { type: 'string' },
          introduces: { type: 'array', items: { type: 'string' } },
        },
        required: ['index', 'question', 'adds', 'introduces'],
      },
    },
    changes: { type: 'array', items: { type: 'object', properties: { index: { type: 'number' }, what: { type: 'string' } }, required: ['index', 'what'] } },
    segments: { type: 'array', items: { type: 'object', properties: { index: { type: 'number' }, narration: { type: 'string' } }, required: ['index', 'narration'] } },
  },
  required: ['map', 'changes', 'segments'],
};

export function coherencePrompt(video, issues, { targetWords = null } = {}) {
  const segs = video.segments.map((s, i) => ({ index: i, section: s.section, narration: s.narration }));
  const words = segs.reduce((n, s) => n + String(s.narration).split(/\s+/).filter(Boolean).length, 0);
  const shorten = targetWords && targetWords < words * 0.97 ? `
ACORTAR (obligatorio): el guion tiene ${words} palabras y debe quedar en ${targetWords} (±4 %), es decir, unas ${words - targetWords} palabras menos.
Orden de recorte: 1) explicaciones y datos repetidos; 2) rodeos, frases de transición vacías y anuncios; 3) ejemplos o cifras secundarias que no cambian el veredicto; 4) matices que se pueden decir en menos palabras.
Conserva el arco completo (arranque con la escena concreta, lo que no sabemos, las cuentas clave, el giro, el veredicto por perfil, la regla final y la vuelta al arranque) y todas las cifras que sostienen el veredicto. Puede quedar algún segmento muy corto, pero no vacío. En este caso reescribe TODOS los segmentos que recortes y devuélvelos completos.
` : '';
  return `Eres el editor del guion de un vídeo explicativo. El guion se siente redundante: explica cosas más de una vez y algunos segmentos repiten en vez de avanzar.

PRINCIPIOS (obligatorios):
1. Cada concepto o término se explica UNA sola vez, la primera vez que hace falta. Después se usa sin volver a explicarlo (como mucho un recordatorio de 3-5 palabras si han pasado varios minutos y es imprescindible).
2. Cada cifra se presenta y se explica una vez. Más adelante se nombra ("esos 300 dólares la hora") sin recalcularla ni volver a contarla.
3. La estructura del vídeo se anuncia una sola vez (en el arranque). Como mucho un punto de control a mitad y un cierre; nada de mini-resúmenes ("O sea…", "En resumen…") al final de cada bloque: solo donde una idea compleja lo necesita de verdad (máximo 2 en todo el vídeo).
4. Hilo conductor: cada segmento responde a la pregunta que dejó abierta el anterior y aporta algo NUEVO. Su primera frase recoge lo que acaba de quedar claro (sin repetirlo entero) y su última frase abre lo siguiente. Nada de reintroducir el tema.
5. Precisión: una afirmación exacta vale más que tres aproximadas. Quita frases que no añaden información.

${shorten}
TAREA:
a) Haz el mapa del vídeo: para cada segmento, qué pregunta responde ("question"), qué aporta de nuevo ("adds", una frase) y qué conceptos introduce por primera vez ("introduces").
b) Reescribe SOLO los segmentos que lo necesiten para cumplir los principios. Mantén el estilo, el tono, la variante de español, los *énfasis* y todos los datos (no añadas datos nuevos ni cambies cifras). Conserva tal cual las frases que no haya que tocar.
c) En "changes" explica brevemente qué cambiaste en cada segmento ("quito la segunda definición de token", "uno el anuncio de pasos con el del arranque"…).
Devuelve en "segments" SOLO los segmentos reescritos, con la narración completa.

${issues.length ? `Pistas detectadas automáticamente (no son todas; usa tu criterio):\n${issues.map((x) => `- ${x.detail} (segmentos ${x.segments.map((i) => i + 1).join(', ')})`).join('\n')}\n` : ''}
Guion:
${JSON.stringify(segs, null, 1)}`;
}
