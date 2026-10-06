// Fish Audio (https://docs.fish.audio): POST /v1/tts con reference_id = voz; GET /model para buscar voces.
import { readKey, keySource, saveKey } from './keys.js';

const API = process.env.FISH_API_BASE || 'https://api.fish.audio';
const ENV = 'FISH_API_KEY';

export const id = 'fish';
export const name = 'Fish Audio';
export const keyHelp = 'fish.audio → API Keys';

export const status = () => ({ configured: !!readKey(id, ENV), source: keySource(id, ENV) });

async function api(pathname, init = {}, key = readKey(id, ENV)) {
  if (!key) throw new Error('Falta la API key de Fish Audio');
  const res = await fetch(`${API}${pathname}`, { ...init, headers: { Authorization: `Bearer ${key}`, ...(init.headers || {}) } });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    const why = { 401: 'API key no válida', 402: 'sin saldo', 429: 'demasiadas peticiones', 503: 'servicio saturado' }[res.status] || `error ${res.status}`;
    throw new Error(`Fish Audio: ${why}${detail ? ` · ${detail}` : ''}`);
  }
  return res;
}

export async function setKey(key) {
  await api('/model?self=true&page_size=1', {}, key);
  await saveKey(id, key);
}

export async function models() {
  return [{ id: 's2.1-pro', name: 's2.1-pro' }, { id: 's2-pro', name: 's2-pro' }, { id: 's1', name: 's1' }];
}

// Fish no distingue acentos en el idioma. El acento se deduce del nombre y la descripción
// (Fish describe muchas voces como "...with a clear Latin American accent" / "neutral Spanish accent").
const LATAM = /latin\s*americ|latinoameric|\blatin[oa]s?\b|\blatam\b|m[eé]xic|argentin|colombi|chilen|venezol|peruvian|peruan|cuban|puerto\s*ric|dominican|ecuator|ecuadorian|urugua|paragua|bolivian|guatemal|hondure|salvador|nicarag|costa\s*ric|panam|caribbean|caribe|rioplat/i;
const NEUTRAL = /neutral\s+(spanish|latin)|español\s+neutr|acento\s+neutr|spanish\s+neutral/i;
const SPAIN = /españa|\bspain\b|castilian|castellan|european\s+spanish|peninsular|madrid|andaluz|catal[aá]n|ib[eé]ric/i;
const isSpanish = (m) => (m.languages ?? []).some((l) => /^es\b|spanish|español/i.test(l));

/** 'latino' | 'neutro' | 'españa' | null */
export function accentOf(m) {
  const t = `${m.title ?? ''} ${m.description ?? ''}`;
  if (SPAIN.test(t)) return 'españa';
  if (LATAM.test(t)) return 'latino';
  if (NEUTRAL.test(t)) return 'neutro';
  return null;
}

function mapVoice(m) {
  return {
    id: m._id, title: m.title, languages: m.languages ?? [], cover: /^https?:/.test(m.cover_image ?? '') ? m.cover_image : '',
    author: m.author?.nickname ?? '',
    tags: (m.tags ?? []).slice(0, 4),
    accent: accentOf(m),
    uses: m.task_count ?? null,
    // muestra publicada por Fish (gratis); solo si viene como URL completa
    sample: (m.samples ?? []).map((x) => x.audio).find((u) => /^https?:/.test(u ?? '')) ?? '',
    sampleText: (m.samples ?? [])[0]?.text || m.description || '',
  };
}

async function page({ q, self, lang, pageNumber, pageSize, sort }) {
  const params = new URLSearchParams({ page_size: String(pageSize), page_number: String(pageNumber), sort_by: sort });
  if (q) params.set('title', q);
  if (self) params.set('self', 'true');
  if (lang) params.set('language', lang);
  return (await api(`/model?${params}`)).json();
}

let langWorks = null; // ¿acepta Fish language=es? (la documentación no da el formato; se comprueba una vez)

/**
 * scope: 'mine' (mis voces) · 'es' (catálogo en español) · 'latam' (catálogo en español con acento latino) · 'all'
 * sort: score | task_count | created_at. Devuelve { items, hasMore }.
 */
export async function listVoices({ q = '', self = false, scope, pageNumber = 1, sort = 'score' } = {}) {
  scope = scope || (self ? 'mine' : 'all');
  if (!['score', 'task_count', 'created_at'].includes(sort)) sort = 'score';
  const usable = (m) => m.type !== 'svc' && m.state !== 'failed';

  if (scope === 'mine' || scope === 'all') {
    const data = await page({ q, self: scope === 'mine', pageNumber, pageSize: 30, sort });
    return { items: (data.items ?? []).filter(usable).map(mapVoice), hasMore: pageNumber * 30 < (data.total ?? 0) };
  }

  // español / latino: language=es si Fish lo acepta; si no, se filtra aquí por idioma
  const PER = 100;
  const SCAN = scope === 'latam' ? 3 : 1; // páginas de 100 que se revisan por cada "Cargar más"
  const out = [];
  let hasMore = false;
  for (let k = 0; k < SCAN; k++) {
    const n = (pageNumber - 1) * SCAN + k + 1;
    let data;
    if (langWorks !== false) {
      data = await page({ q, lang: 'es', pageNumber: n, pageSize: PER, sort });
      if (langWorks === null && n === 1) langWorks = (data.total ?? 0) > 0 && (data.items ?? []).some(isSpanish);
    }
    if (langWorks === false) data = await page({ q, pageNumber: n, pageSize: PER, sort });
    const items = (data.items ?? []).filter(usable).filter(isSpanish);
    out.push(...(scope === 'latam' ? items.filter((m) => ['latino', 'neutro'].includes(accentOf(m))) : items));
    hasMore = n * PER < (data.total ?? 0);
    if (!hasMore) break;
  }
  return { items: out.map(mapVoice), hasMore };
}

/** Ajustes canónicos (lo que afecta al audio; se usa para la caché). */
export const normalize = (s = {}) => ({
  model: s.model || 's2.1-pro',
  speed: Math.min(2, Math.max(0.5, Number(s.speed) || 1)),
  temperature: Math.min(1, Math.max(0, Number(s.temperature ?? 0.7))),
});

export async function tts({ text, voiceId, settings }, signal) {
  const s = normalize(settings);
  const res = await api('/v1/tts', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', model: s.model },
    body: JSON.stringify({
      text, reference_id: voiceId, format: 'mp3', mp3_bitrate: 192,
      temperature: s.temperature, latency: 'normal',
      normalize: false, // su normalización es solo para inglés/chino; las cifras ya llegan en palabras (numbers-es.js)
      chunk_length: 300,
      prosody: { speed: s.speed, volume: 0, normalize_loudness: true },
    }),
  });
  return Buffer.from(await res.arrayBuffer());
}
