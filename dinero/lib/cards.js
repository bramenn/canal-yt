// Tarjetas animadas de los shorts de dinero, como eventos ASS sobre el fondo (la foto desenfocada):
// cifra gigante que cuenta hacia arriba, titular de prensa que entra deslizando y gráfica de barras que crecen.
// Van en la mitad de arriba; los subtítulos de dinero bajan (SUB_Y) para no pisarse.
import { assTime, assEsc } from '../../lib/subs.js';

export const SUB_Y = 1430;
export const CARD_STYLES = [
  'Style: Num,Anton,300,&H0000D2FF,&H0000D2FF,&H00000000,&H96000000,0,0,0,0,100,100,1,0,1,14,6,5,40,40,0,1',
  'Style: NumLabel,Anton,104,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,1,0,1,8,3,5,60,60,0,1',
  // titular: caja blanca opaca (BorderStyle 3: el contorno es la caja)
  'Style: Headline,Anton,104,&H00111111,&H00111111,&H00FFFFFF,&H64000000,0,0,0,0,100,100,0,0,3,28,8,5,120,120,0,1',
  'Style: Bar,Anton,40,&H0000D2FF,&H0000D2FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,4,0,2,0,0,0,1',
  'Style: BarText,Anton,62,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,0,0,1,6,2,5,0,0,0,1',
  'Style: ChartTitle,Anton,88,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,1,0,1,8,3,5,60,60,0,1',
];

const ev = (layer, s, e, style, text) => `Dialogue: ${layer},${assTime(s)},${assTime(e)},${style},,0,0,0,,${text}`;
const fmt = (n, dec) => n.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec });

/** «$400.000», «-97 %», «1.000 M €», «2,5 M» → { pre, value, dec, post } (o null si no hay número). */
function parseNumber(s) {
  const m = String(s).match(/^(.*?)(-?\d[\d.]*(?:,\d+)?)(.*)$/);
  if (!m) return null;
  const raw = m[2];
  const dec = raw.includes(',') ? raw.split(',')[1].length : 0;
  const value = Number(raw.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(value) ? { pre: m[1], value, dec, post: m[3] } : null;
}

/** Cifra gigante: cuenta hacia arriba en 0,6 s con un «pop» y su etiqueta debajo. */
function numberCard({ number, label }, s, e) {
  const out = [];
  const n = parseNumber(number);
  const steps = n && Math.abs(n.value) >= 10 ? 12 : 0;
  for (let k = 0; k < steps; k++) {
    const v = (n.value * (k + 1)) / (steps + 1);
    out.push(ev(1, s + k * 0.05, s + (k + 1) * 0.05, 'Num', `{\\pos(540,700)}${assEsc(n.pre + fmt(n.dec ? v : Math.round(v), n.dec) + n.post)}`));
  }
  out.push(ev(1, s + steps * 0.05, e, 'Num', `{\\pos(540,700)${steps ? '' : '\\fscx60\\fscy60\\t(0,160,\\fscx100\\fscy100)'}}${assEsc(number)}`));
  if (label) out.push(ev(1, s + 0.35, e, 'NumLabel', `{\\pos(540,900)\\fad(200,0)}${assEsc(String(label).toUpperCase())}`));
  return out;
}

/** Titular de prensa: caja blanca que entra deslizando desde la derecha, con el medio en rojo. */
function headlineCard({ outlet, headline }, s, e) {
  const text = `{\\an5\\move(1500,700,540,700,0,260)\\frz-2}{\\fs66\\c&H002D2DFF&}${assEsc(String(outlet ?? '').toUpperCase())}{\\r}\\N${assEsc(headline ?? '')}`;
  return [ev(1, s, e, 'Headline', text)];
}

/** Gráfica de barras: crecen de una en una desde abajo y después aparece su valor; título con la unidad arriba. */
function chartCard({ bars = [], unit = '', label }, s, e) {
  const list = bars.slice(0, 5).filter((b) => Number.isFinite(Number(b.value)));
  if (!list.length) return [];
  const max = Math.max(...list.map((b) => Math.abs(Number(b.value)))) || 1;
  const n = list.length, bw = n > 3 ? 120 : 160, area = 860;
  const gap = n > 1 ? (area - n * bw) / (n - 1) : 0;
  const x0 = 540 - area / 2 + bw / 2;
  const base = 1120, top = 560;
  const out = [];
  if (unit || label) out.push(ev(1, s, e, 'ChartTitle', `{\\pos(540,430)\\fad(200,0)}${assEsc(String(label || unit).toUpperCase())}`));
  list.forEach((b, i) => {
    const x = Math.round(n > 1 ? x0 + i * (bw + gap) : 540);
    const h = Math.max(12, Math.round(((base - top) * Math.abs(Number(b.value))) / max));
    const t = Math.round(150 + i * 140);
    out.push(ev(1, s, e, 'Bar', `{\\an2\\pos(${x},${base})\\fscy0\\t(${t},${t + 450},\\fscy100)\\p1}m 0 0 l ${bw} 0 ${bw} ${h} 0 ${h}{\\p0}`));
    const shown = `${fmt(Number(b.value), Number.isInteger(Number(b.value)) ? 0 : 1)}${unit && unit.length <= 3 ? ` ${unit}` : ''}`;
    out.push(ev(1, s + (t + 450) / 1000, e, 'BarText', `{\\an2\\pos(${x},${base - h - 12})\\fad(150,0)}${assEsc(shown)}`));
    out.push(ev(1, s + 0.2, e, 'BarText', `{\\an8\\pos(${x},${base + 14})\\fs52}${assEsc(String(b.label).toUpperCase())}`));
  });
  return out;
}

/** Eventos de la tarjeta de una frase (según su "show"), entre s y e. */
export function cardEvents(line, s, e) {
  if (line.show === 'cifra' && line.number) return numberCard(line, s, e);
  if (line.show === 'titular' && line.headline) return headlineCard(line, s, e);
  if (line.show === 'grafica' && line.bars?.length) return chartCard(line, s, e);
  return [];
}
