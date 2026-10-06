// Cifras → palabras en español, justo antes de mandar el texto a la voz.
// Fish Audio solo normaliza inglés y chino: en español lee "$500" o "1.099" de forma imprevisible
// (género equivocado, formato inglés...). Esto deja el texto listo para leer, de forma determinista.

const UNITS = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
  'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte',
  'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const TENS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const HUNDREDS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

function below1000(n) {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  const h = Math.floor(n / 100), r = n % 100;
  const parts = [];
  if (h) parts.push(HUNDREDS[h]);
  if (r) parts.push(r < 30 ? UNITS[r] : TENS[Math.floor(r / 10)] + (r % 10 ? ` y ${UNITS[r % 10]}` : ''));
  return parts.join(' ');
}

/** "uno" → "un" delante de un sustantivo masculino o de mil/millón ("veintiún mil", "un millón"). */
const apocope = (s) => s.replace(/veintiuno$/, 'veintiún').replace(/\buno$/, 'un');

/** Entero → palabras (masculino, sin apócope final). */
export function intToWords(n) {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'cero';
  const parts = [];
  const billions = Math.floor(n / 1e12);
  const millions = Math.floor((n % 1e12) / 1e6);
  const thousands = Math.floor((n % 1e6) / 1e3);
  const rest = n % 1e3;
  if (billions) parts.push(billions === 1 ? 'un billón' : `${apocope(intToWords(billions))} billones`);
  if (millions) {
    // 1.000 millones = "mil millones"
    parts.push(millions === 1 ? 'un millón' : `${apocope(intToWords(millions))} millones`);
  }
  if (thousands) parts.push(thousands === 1 ? 'mil' : `${apocope(below1000(thousands))} mil`);
  if (rest) parts.push(below1000(rest));
  return parts.join(' ');
}

const FEMININE = (s) => s.replace(/ientos\b/g, 'ientas').replace(/\bveintiuno$/, 'veintiuna').replace(/\buno$/, 'una');

// sustantivos femeninos frecuentes en el canal
const FEM_NOUNS = /^(horas?|personas?|veces|semanas?|tarjetas?|gráficas?|palabras?|preguntas?|pruebas?|capas?|versiones?|líneas?|peticiones?|páginas?|unidades?|cajas?|máquinas?|respuestas?|tareas?|libras?|consultas?|sesiones?|suscripciones?|cuentas?|generaciones?|empresas?|horas)$/i;

/** Número como texto ("1.099", "0,23", "2.5", "1,099") → palabras. Admite separadores de España y Latinoamérica. */
export function numberToWords(raw, { feminine = false, beforeNoun = false } = {}) {
  let s = String(raw).replace(/\s/g, '');
  let intPart = s, dec = '';
  // separador seguido de exactamente 3 cifras (y sin cero inicial) = miles; si no, decimal
  const groups = s.split(/[.,]/);
  const seps = s.match(/[.,]/g) ?? [];
  if (seps.length) {
    const last = groups[groups.length - 1];
    const thousandsStyle = groups.slice(1).every((g) => g.length === 3) && groups[0] !== '0';
    if (thousandsStyle) { intPart = groups.join(''); }
    else { intPart = groups.slice(0, -1).join(''); dec = last; }
  }
  let words = intToWords(Number(intPart));
  if (dec) {
    // "0,05" → "cero coma cero cinco"; "2,5" → "dos coma cinco"; "0,23" → "cero coma veintitrés"
    const lead = dec.match(/^0+/)?.[0].length ?? 0;
    words += ` coma ${'cero '.repeat(lead)}${Number(dec) ? intToWords(Number(dec)) : ''}`.trimEnd();
    return words;
  }
  if (feminine) words = FEMININE(words);
  else if (beforeNoun) words = apocope(words);
  return words;
}

const NUM = String.raw`\d{1,3}(?:[.,  ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
const CURRENCY = { '$': ['dólar', 'dólares'], 'US$': ['dólar', 'dólares'], 'USD': ['dólar', 'dólares'], '€': ['euro', 'euros'], 'EUR': ['euro', 'euros'], '£': ['libra', 'libras'] };
const SCALE = { k: 'mil', K: 'mil', mil: 'mil', M: 'millones', millones: 'millones', B: 'mil millones', bn: 'mil millones' };
const UNITS_MAP = [
  [/^(tok\/s|t\/s|tokens\/s|tps)$/i, 'tokens por segundo'], [/^GB\/s$/i, 'gigas por segundo'], [/^TB\/s$/i, 'teras por segundo'],
  [/^GB$/i, 'gigas'], [/^TB$/i, 'teras'], [/^MB$/i, 'megas'], [/^GHz$/i, 'gigahercios'], [/^kWh$/i, 'kilovatios hora'],
  [/^W$/, 'vatios'], [/^ms$/, 'milisegundos'], [/^h$/, 'horas'], [/^min$/, 'minutos'], [/^s$/, 'segundos'],
];

const isOne = (raw) => /^0*1$/.test(String(raw).replace(/[.,\s]/g, ''));

function scaled(raw, scale) {
  // "1,5 M" → "uno coma cinco millones"; "27B" → "veintisiete mil millones"; "50K" → "cincuenta mil"
  const w = SCALE[scale];
  if (w === 'millones' && isOne(raw)) return 'un millón';
  return `${numberToWords(raw, { beforeNoun: true })} ${w}`;
}

/** Convierte todas las cifras de un texto a palabras. */
export function speakNumbers(text) {
  let t = String(text);

  // modelos de gráfica: "RTX 5090" → "RTX cincuenta noventa"
  t = t.replace(/\b(RTX|GTX|RX|Radeon|Arc)\s?(\d{2})(\d{2})\b/g, (_, p, a, b) => `${p} ${intToWords(+a)} ${+b ? intToWords(+b) : 'cien'}`);

  // "una 5090", "la 4070 Ti", "mi 3060": numeración de gráficas por parejas
  t = t.replace(/\b(la|las|una|unas|mi|tu|su|esa|esta|dos|tres|cuatro|ocho)\s(10|16|20|30|40|50|60|70|80|90)(50|60|70|80|90)(\s?Ti)?\b/gi,
    (_, art, a, b, ti) => `${art} ${intToWords(+a)} ${intToWords(+b)}${ti ? ' Ti' : ''}`);

  // moneda delante: "$500", "US$ 1.299", "€20", "$1,5M"
  t = t.replace(new RegExp(String.raw`(US\$|\$|€|£)\s?(${NUM})\s?(k|K|M|B|bn|mil|millones)?(?![\w])`, 'g'), (_, cur, num, sc) => {
    const [one, many] = CURRENCY[cur];
    if (sc) return `${scaled(num, sc)} de ${many}`;
    return isOne(num) ? `un ${one}` : `${numberToWords(num, { beforeNoun: true })} ${many}`;
  });
  // moneda detrás: "500 $", "1.099 €", "20 USD", "500 dólares" ya en palabras se trata abajo
  t = t.replace(new RegExp(String.raw`(${NUM})\s?(k|K|M|B|bn)?\s?(US\$|\$|€|£|USD|EUR)(?![\w])`, 'g'), (_, num, sc, cur) => {
    const [one, many] = CURRENCY[cur];
    if (sc) return `${scaled(num, sc)} de ${many}`;
    return isOne(num) ? `un ${one}` : `${numberToWords(num, { beforeNoun: true })} ${many}`;
  });

  // porcentajes: "50 %", "+30%"
  t = t.replace(new RegExp(String.raw`([+-])?(${NUM})\s?%`, 'g'), (_, sign, num) => `${sign === '+' ? 'más ' : sign === '-' ? 'menos ' : ''}${numberToWords(num)} por ciento`);

  // multiplicadores: "8x más rápido" → "ocho veces"; como nombre ("el plan 20x", "ese 1x de Plus") → "veinte equis"
  t = t.replace(new RegExp(String.raw`(\p{L}+\s)?(${NUM})\s?[x×](?![\w])`, 'gu'), (m, before, num, offset, all) => {
    const after = all.slice(offset + m.length).trimStart().split(/\s+/)[0] ?? '';
    const comparative = /^(m[aá]s|menos|mejor|peor|superior|inferior|r[aá]pid|lent|car[oa]s?|barat|grande|pequeñ|veces)/i.test(after)
      || /^(hasta|unas|unos|casi|de|en|por|es|son|va|van|corre|sube|baja|multiplica)\s$/i.test(before ?? '');
    const words = comparative ? (isOne(num) ? 'una vez' : `${numberToWords(num, { feminine: true })} veces`) : `${numberToWords(num)} equis`;
    return `${before ?? ''}${words}`;
  });

  // escalas: "27B parámetros", "50K tokens", "1M de tokens"
  const COUNTABLE = /^(tokens?|parámetros|pesos|usuarios|personas|dólares|euros|palabras|líneas|descargas|vistas|suscriptores|visitas|operaciones|transistores|filas|ejemplos|imágenes|horas|mensajes|peticiones|consultas|archivos|documentos|expertos)$/i;
  t = t.replace(new RegExp(String.raw`(${NUM})\s?(K|k|M|B|bn)(?![\w])(\s+(de\s+)?([a-záéíóúñ]+))?`, 'gi'), (m, num, sc, tail, de, next) => {
    if (!/^(k|m|b|bn)$/i.test(sc)) return m;
    const counted = next && COUNTABLE.test(next);
    // nombre de modelo ("Qwen3 27B corre…") → "veintisiete be"
    if (/^(b|bn)$/i.test(sc) && !counted) return `${numberToWords(num)} be${tail ? ` ${de ?? ''}${next}` : ''}`;
    const words = scaled(num, sc.toUpperCase() === 'K' ? 'K' : sc.toUpperCase() === 'M' ? 'M' : 'B');
    if (!tail) return words;
    // "mil millones de parámetros", "un millón de tokens", pero "cincuenta mil tokens"
    if (counted) return `${words}${/mill(ón|ones)$/.test(words) ? ' de ' : ' '}${next}`;
    return `${words} ${de ?? ''}${next}`;
  });

  // unidades: "24 GB", "0,23 tok/s", "140 W"
  t = t.replace(new RegExp(String.raw`(${NUM})\s?(tok\/s|t\/s|tokens\/s|tps|GB\/s|TB\/s|GB|TB|MB|GHz|kWh|W|ms|min|h|s)(?![\w])`, 'g'), (m, num, unit) => {
    const name = UNITS_MAP.find(([re]) => re.test(unit))?.[1];
    if (!name) return m;
    if (isOne(num) && !/[.,]/.test(num)) return `un ${name.replace(/s\b/, '').replace(/ por segundo/, ' por segundo')}`;
    return `${numberToWords(num, { beforeNoun: true })} ${name}`;
  });

  // horas: "7:30" → "siete y treinta"
  t = t.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => `${intToWords(+h)}${+m ? ` y ${intToWords(+m)}` : ' en punto'}`);

  // dígitos pegados a letras ("M5", "GPT-6", "Qwen3", "K3"): separar para que la voz no los trague
  t = t.replace(/\b([A-Za-z]+)-?(\d+)\b/g, (_, l, d) => `${l} ${intToWords(+d)}`);

  // resto de cifras sueltas; el género lo decide la palabra siguiente
  t = t.replace(new RegExp(String.raw`(^|[^\w])(${NUM})(?![\w])(\s+([\wáéíóúñ]+))?`, 'gi'), (m, pre, num, rest, next) => {
    const feminine = !!next && FEM_NOUNS.test(next);
    const beforeNoun = !!next && /^[a-záéíóúñ]/i.test(next) && !/^(y|o|a|de|en|por|con|que|es|son|más|menos|veces)$/i.test(next);
    return `${pre}${numberToWords(num, { feminine, beforeNoun })}${rest ?? ''}`;
  });

  return t;
}
