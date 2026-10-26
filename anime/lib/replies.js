// Respuestas automáticas a los comentarios de YouTube (solo YouTube: TikTok no tiene API de comentarios y Facebook
// exige una app de Meta revisada; ninguna API permite dar like a un comentario). Cada respuesta parte de lo que dice
// la persona y de lo que cuenta el vídeo; la IA se salta lo que no merece respuesta (spam, insultos, sin sentido).
import { claudeStep } from '../../lib/claude.js';
import { youtubeAccessToken, youtubeVideoId } from '../../lib/youtube-analytics.js';

const API = 'https://www.googleapis.com/youtube/v3';
// cuota diaria de YouTube: 10.000 unidades y cada respuesta cuesta 50 → tope holgado de 60 al día
// ponytail: el contador vive en memoria (un reinicio lo pone a 0); a 60/día sobra margen igualmente
const PER_RUN = 10, PER_DAY = 60;
const sentToday = { day: '', n: 0 };

async function yt(pathq, body) {
  const r = await fetch(`${API}/${pathq}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${await youtubeAccessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`YouTube: ${j.error?.message ?? `HTTP ${r.status}`}`);
  return j;
}

let myChannel = null;
const channelId = async () => (myChannel ??= (await yt('channels?part=id&mine=true')).items?.[0]?.id);

const REPLY_SCHEMA = {
  type: 'object',
  properties: { replies: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, reply: { type: 'string' } }, required: ['id', 'reply'] } } },
  required: ['replies'],
};

/** La IA escribe una respuesta por comentario ("" = no responder). */
export async function writeReplies(pj, comments) {
  const script = (pj.script?.lines ?? []).map((l) => l.text).join(' ').slice(0, 2500);
  const prompt = `Eres quien lleva el canal de anime @notianimes y respondes comentarios de tu vídeo de YouTube.
VÍDEO: «${pj.script?.title}» (${pj.story?.anime})
LO QUE CUENTA EL VÍDEO: ${script}

COMENTARIOS (id: autor: texto):
${comments.map((c) => `${c.id}: ${c.author}: ${c.text}`).join('\n')}

Para cada comentario devuelve { id, reply }:
- Responde a lo que dice ESA persona en concreto, con un dato o detalle del vídeo o del anime cuando venga al caso. Nada genérico («¡gracias por comentar!», «qué buen comentario»): si no tienes algo específico que aportar, reply = "".
- 1-2 frases cortas (máx. 200 caracteres), tono cercano y fan, en el idioma del comentario (normalmente español neutro). Como mucho 1 emoji.
- Cuando encaje, termina con una pregunta sencilla para seguir la conversación (no en todas).
- No inventes datos que no estén en el vídeo o que no sean conocidos del anime. Sin enlaces, sin pedir likes ni suscripciones, sin hashtags.
- reply = "" si es spam, enlace, insulto, odio, contenido sexual, autopromoción, sin sentido o una provocación: no se responde.
- Si corrige un dato y tiene razón, reconócelo con naturalidad; si no la tiene, explica el dato sin discutir.`;
  const ev = await claudeStep({ prompt, schema: REPLY_SCHEMA, system: 'Community manager de un canal de anime en español. Respuestas breves, específicas y humanas.', effort: 'low', tools: [] }, () => {}, () => {});
  return new Map((ev.data?.replies ?? []).map((r) => [r.id, String(r.reply ?? '').trim()]));
}

/**
 * Responde los comentarios nuevos de los vídeos de los últimos 7 días. save(pj) guarda lo respondido en el proyecto
 * (pj.replied: ids ya vistos; pj.replies: registro { at, author, comment, reply }).
 */
export async function replyComments(projects, { save, log = () => {} }) {
  const day = new Date().toISOString().slice(0, 10);
  if (sentToday.day !== day) Object.assign(sentToday, { day, n: 0 });
  const me = await channelId();
  let sent = 0;
  for (const pj of projects) {
    if (sent >= PER_RUN || sentToday.n >= PER_DAY) break;
    if (Date.now() - (pj.created ?? 0) > 7 * 864e5) continue;
    const videoId = pj.stats?.youtube?.videoId ?? youtubeVideoId(pj.stats?.youtube?.url) ?? youtubeVideoId(pj.buffer?.posts?.find((x) => x.service === 'youtube')?.url);
    if (!videoId) continue;
    const { items = [] } = await yt(`commentThreads?part=snippet,replies&videoId=${videoId}&maxResults=50&order=time`).catch(() => ({}));
    const seen = new Set(pj.replied ?? []);
    const todo = items.filter((t) => {
      const top = t.snippet.topLevelComment.snippet;
      return top.authorChannelId?.value !== me && !seen.has(t.id) && !(t.replies?.comments ?? []).some((r) => r.snippet.authorChannelId?.value === me);
    }).map((t) => ({ id: t.id, author: t.snippet.topLevelComment.snippet.authorDisplayName, text: t.snippet.topLevelComment.snippet.textOriginal.slice(0, 500) }));
    if (!todo.length) continue;
    const replies = await writeReplies(pj, todo);
    pj.replies ??= [];
    for (const c of todo) {
      const reply = replies.get(c.id);
      if (reply && sent < PER_RUN && sentToday.n < PER_DAY) {
        try {
          await yt('comments?part=snippet', { snippet: { parentId: c.id, textOriginal: reply.slice(0, 500) } });
          sent++; sentToday.n++;
          pj.replies.push({ at: Date.now(), author: c.author, comment: c.text, reply });
          log(`💬 ${pj.script?.title?.slice(0, 40)} · ${c.author}: ${reply}`);
        } catch (e) { log(`⚠️ No se pudo responder: ${e.message}`); continue; }
      } else if (reply) continue; // tope alcanzado: queda para la próxima tanda
      seen.add(c.id); // respondido o descartado por la IA: no se vuelve a mirar
    }
    pj.replied = [...seen];
    await save(pj);
  }
  return sent;
}
