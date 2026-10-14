// Subtítulos ASS para shorts verticales (1080×1920), comunes a las apps: palabra a palabra en grupos de 1-2, Anton
// blanca con borde, palabras clave en amarillo/rojo y un «pop» al entrar, más la marca del canal.
// Las apps pueden añadir sus propios estilos y eventos (tarjetas de cifras, titulares, gráficas…).
export const W = 1080, H = 1920;
export const assTime = (t) => { const cs = Math.max(0, Math.round(t * 100)); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; };
export const assEsc = (s) => String(s).replace(/[{}\\]/g, '');
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]/g, '');
export const YELLOW = '&H001FD2FF&', RED = '&H002D2DFF&', WHITE = '&H00FFFFFF&';

/** Eventos de subtítulos (palabras alineadas [{ w, s, e }]) a la altura y. */
export function wordEvents(words, { yellow = [], red = [] }, total, y = 1150) {
  const Y = new Set(yellow.map(norm)), R = new Set(red.map(norm));
  // grupos de 1-2 palabras (corta en signos de puntuación y en palabras largas)
  const groups = [];
  for (let i = 0; i < words.length;) {
    const g = [words[i]];
    const a = words[i].w, b = words[i + 1]?.w;
    if (b && !/[.,;:!?…]$/.test(a) && (a + b).length <= 11 && !R.has(norm(a)) && !Y.has(norm(a))) g.push(words[i + 1]);
    groups.push(g); i += g.length;
  }
  return groups.map((g, i) => {
    const s = g[0].s, e = Math.min(groups[i + 1]?.[0].s ?? total, g.at(-1).e + 0.5);
    const text = g.map((w) => `{\\c${R.has(norm(w.w)) ? RED : Y.has(norm(w.w)) ? YELLOW : WHITE}}${assEsc(w.w.toUpperCase().replace(/[.,;:]+$/, ''))}`).join(' ');
    return `Dialogue: 2,${assTime(s)},${assTime(e)},Sub,,0,0,0,,{\\pos(540,${y})\\fscx70\\fscy70\\t(0,90,\\fscx100\\fscy100)}${text}`;
  });
}

/** Documento ASS completo: estilos base (Sub, Brand) + `styles` extra, eventos y la marca durante todo el vídeo. */
export function assDoc({ events, brand, total, styles = [], subSize = 190 }) {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Anton,${subSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,1,0,1,13,5,5,50,50,0,1
Style: Brand,Anton,76,&H40FFFFFF,&H40FFFFFF,&H60000000,&H00000000,0,0,0,0,100,100,1,0,1,5,0,7,46,46,70,1
${styles.join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
Dialogue: 3,${assTime(0)},${assTime(total)},Brand,,0,0,0,,${brand}
`;
}
