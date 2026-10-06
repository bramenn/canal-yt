// ElevenLabs (https://elevenlabs.io/docs): POST /v1/text-to-speech/{voice_id}; GET /v2/voices; GET /v1/models.
import { readKey, keySource, saveKey } from './keys.js';

const API = process.env.ELEVEN_API_BASE || 'https://api.elevenlabs.io';
const ENV = 'ELEVENLABS_API_KEY';

export const id = 'elevenlabs';
export const name = 'ElevenLabs';
export const keyHelp = 'elevenlabs.io → Developers → API Keys';

export const status = () => ({ configured: !!readKey(id, ENV), source: keySource(id, ENV) });

async function api(pathname, init = {}, key = readKey(id, ENV)) {
  if (!key) throw new Error('Falta la API key de ElevenLabs');
  const res = await fetch(`${API}${pathname}`, { ...init, headers: { 'xi-api-key': key, ...(init.headers || {}) } });
  if (!res.ok) {
    let detail = await res.text().catch(() => '');
    try { const j = JSON.parse(detail); detail = j.detail?.message || j.detail?.status || (typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j)); } catch {}
    const why = { 400: 'petición no válida', 401: 'API key no válida o sin permiso / sin cuota', 422: 'petición no válida', 429: 'demasiadas peticiones' }[res.status] || `error ${res.status}`;
    throw new Error(`ElevenLabs: ${why}${detail ? ` · ${String(detail).slice(0, 200)}` : ''}`);
  }
  return res;
}

export async function setKey(key) {
  await api('/v2/voices?page_size=1', {}, key);
  await saveKey(id, key);
}

let modelCache = { at: 0, list: null };
/** Modelos de TTS que ofrece la cuenta (se piden a la API; no se inventan). */
export async function models() {
  if (modelCache.list && Date.now() - modelCache.at < 3600_000) return modelCache.list;
  const fallback = [{ id: 'eleven_multilingual_v2', name: 'Eleven Multilingual v2' }];
  try {
    const data = await (await api('/v1/models')).json();
    const list = (Array.isArray(data) ? data : [])
      .filter((m) => m.can_do_text_to_speech !== false)
      .filter((m) => !m.languages?.length || m.languages.some((l) => /^es/.test(l.language_id ?? '')))
      .map((m) => ({ id: m.model_id, name: m.name || m.model_id }));
    modelCache = { at: Date.now(), list: list.length ? list : fallback };
  } catch { return fallback; }
  return modelCache.list;
}

export async function listVoices({ q = '', self = false, scope } = {}) {
  const params = new URLSearchParams({ page_size: '30' });
  if (q) params.set('search', q);
  if (scope ? scope === 'mine' : self) params.set('voice_type', 'personal');
  const data = await (await api(`/v2/voices?${params}`)).json();
  return { hasMore: false, items: (data.voices ?? []).map((v) => ({
    id: v.voice_id,
    title: v.name,
    languages: [...new Set((v.verified_languages ?? []).map((l) => l.language).filter(Boolean))].slice(0, 4),
    cover: '',
    author: [v.category, v.labels?.accent, v.labels?.gender].filter(Boolean).join(' · '),
    sample: /^https?:/.test(v.preview_url ?? '') ? v.preview_url : '',
    sampleText: v.description ?? '',
  })) };
}

export const normalize = (s = {}) => ({
  model: s.model || 'eleven_multilingual_v2',
  speed: Math.min(1.2, Math.max(0.7, Number(s.speed) || 1)),
  stability: Math.min(1, Math.max(0, Number(s.stability ?? 0.5))),
  similarity: Math.min(1, Math.max(0, Number(s.similarity ?? 0.75))),
  style: Math.min(1, Math.max(0, Number(s.style ?? 0))),
});

/** prevText/nextText: texto vecino para que la entonación sea continua entre segmentos. */
export async function tts({ text, voiceId, settings, prevText, nextText }, signal) {
  const s = normalize(settings);
  const request = (withContext) => api(`/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: s.model,
      voice_settings: { stability: s.stability, similarity_boost: s.similarity, style: s.style, use_speaker_boost: true, speed: s.speed },
      ...(withContext && prevText ? { previous_text: prevText.slice(-600) } : {}),
      ...(withContext && nextText ? { next_text: nextText.slice(0, 600) } : {}),
      apply_text_normalization: 'auto',
    }),
  });
  let res;
  try {
    res = await request(true);
  } catch (e) {
    // algún modelo puede no aceptar el texto vecino: reintento sin él
    if (!(prevText || nextText) || !/petición no válida|error 400/.test(e.message)) throw e;
    res = await request(false);
  }
  return Buffer.from(await res.arrayBuffer());
}
