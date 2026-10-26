// Revisión por Telegram antes de publicar: lo programado en Buffer llega al chat del dueño ~6 h antes con el vídeo, el
// texto y las horas. 👍 / «✅ Publicar» lo aprueba; 👎 / «❌ No publicar» / responder al mensaje con lo que está mal lo
// cancela en Buffer, guarda el motivo (el generador lo lee para no repetirlo) y pide un reemplazo. Sin respuesta, se publica.
// Solo se atiende al chat TELEGRAM_CHAT_ID; cualquier otro remitente se ignora.
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { cancelBufferPosts } from './buffer.js';
import { fmtSlot } from '../../public/js/schedule.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = String(process.env.TELEGRAM_CHAT_ID ?? '');
const PUBLIC_APP = process.env.PUBLIC_APP_URL ?? 'https://anime.bramen.org';
export const telegramReady = () => !!(TOKEN && CHAT);
export const telegramToken = () => !!TOKEN;

const REVIEW_BEFORE = 6 * 3600e3; // se pide la revisión 6 h antes de la primera publicación
const DEADLINE = 30 * 60e3; // sin respuesta 30 min antes, se da por aprobado
const NET = { youtube: 'YouTube', tiktok: 'TikTok', facebook: 'Facebook' };
const GOOD = new Set(['👍', '❤', '❤️', '🔥', '👏', '🎉', '😍', '💯', '⚡', '👌', '🥰', '🤩']);
const BAD = new Set(['👎', '💩', '🤬', '😡', '🤮', '😢', '🤔']);

async function tg(method, body) {
  const form = body instanceof FormData;
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    ...(form ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(300000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description ?? `HTTP ${r.status}`}`);
  return j.result;
}
const say = (text, extra = {}) => tg('sendMessage', { chat_id: CHAT, text, ...extra });
export const notify = (text) => (telegramReady() ? say(text).catch(() => {}) : undefined);

const pending = (pj) => (pj.buffer?.posts ?? []).filter((p) => p.id && !p.done);
const firstDue = (pj) => Math.min(...pending(pj).map((p) => p.dueAt));
const buttons = (id) => ({ inline_keyboard: [[{ text: '✅ Publicar', callback_data: `ok:${id}` }, { text: '❌ No publicar', callback_data: `no:${id}` }]] });

/** Manda el vídeo (o miniatura + enlace si pasa de 50 MB) con su texto y horas, y deja la revisión pendiente. */
async function sendReview(pj, mediaDir) {
  const c = pj.script?.copy ?? {};
  const when = pending(pj).map((p) => `• ${NET[p.service] ?? p.service}: ${fmtSlot(p.dueAt)}`).join('\n');
  const head = `🕐 Para publicar (hora de Colombia):\n${when}\n\n🎬 ${c.yt_title ?? pj.script?.title}\n\n`;
  const tail = '\n\n👍 o ✅ = publicar · 👎 o ❌ = no (hago otro) · responde para decir qué está mal · sin respuesta, se publica';
  const caption = (body) => `${head}${body}`.slice(0, 1024 - tail.length) + tail;
  const file = path.join(mediaDir, pj.id, path.basename(pj.video ?? ''));
  let msg;
  if (existsSync(file) && statSync(file).size < 49e6) {
    const fd = new FormData();
    fd.append('chat_id', CHAT);
    fd.append('caption', caption(c.yt_description ?? ''));
    fd.append('supports_streaming', 'true');
    fd.append('reply_markup', JSON.stringify(buttons(pj.id)));
    fd.append('video', new Blob([await readFile(file)], { type: 'video/mp4' }), `${pj.id}.mp4`);
    msg = await tg('sendVideo', fd);
  } else {
    // vídeos largos: Telegram no deja a los bots subir más de 50 MB
    const thumb = path.join(mediaDir, pj.id, 'thumb.jpg');
    const fd = new FormData();
    fd.append('chat_id', CHAT);
    fd.append('caption', caption(`▶️ Vídeo completo: ${PUBLIC_APP}${pj.video}\n\n${c.yt_description ?? ''}`));
    fd.append('reply_markup', JSON.stringify(buttons(pj.id)));
    if (existsSync(thumb)) fd.append('photo', new Blob([await readFile(thumb)], { type: 'image/jpeg' }), 'thumb.jpg');
    msg = existsSync(thumb) ? await tg('sendPhoto', fd) : await say(caption(`▶️ ${PUBLIC_APP}${pj.video}`), { reply_markup: buttons(pj.id) });
  }
  pj.review = { status: 'pending', messageId: msg.message_id, sentAt: Date.now() };
}

/** Revisa lo programado: pide revisión 6 h antes y da por aprobado lo que llegó a 30 min sin respuesta. Devuelve los proyectos cambiados. */
export async function reviewTick(projects, mediaDir, log = () => {}, { ahead = REVIEW_BEFORE } = {}) {
  const changed = [];
  for (const pj of projects) {
    if (!pending(pj).length || ['approved', 'rejected', 'expired'].includes(pj.review?.status)) continue;
    const left = firstDue(pj) - Date.now();
    if (left < DEADLINE) {
      // quien calla otorga: se publica tal cual
      pj.review = { ...pj.review, status: 'approved', silent: true, at: Date.now() };
      changed.push(pj);
      await say(`⏰ Sin respuesta: «${pj.script?.title}» sale ${fmtSlot(firstDue(pj))}.`, pj.review.messageId ? { reply_to_message_id: pj.review.messageId } : {}).catch(() => {});
    } else if (!pj.review && left < ahead) { // ahead: adelantar la revisión (pruebas)
      try { await sendReview(pj, mediaDir); changed.push(pj); log(`📨 Revisión enviada: ${pj.script?.title}`); }
      catch (e) { log(`⚠️ Telegram: ${e.message}`); }
    }
  }
  return changed;
}

/** Aplica una decisión del dueño. ok: true = publicar; false = cancelar (con el motivo, si lo dio) y pedir un reemplazo. */
async function decide(pj, ok, feedback, store) {
  if (ok) {
    if (pj.review?.status === 'rejected') return '⚠️ Ya estaba cancelado en Buffer: vuelve a programarlo desde la app.';
    pj.review = { ...pj.review, status: 'approved', at: Date.now() };
    return `✅ Aprobado: «${pj.script?.title}» sale ${fmtSlot(firstDue(pj))}.`;
  }
  const first = pj.review?.status !== 'rejected';
  if (first) await cancelBufferPosts(pj, 'rechazado en Telegram');
  pj.review = { ...pj.review, status: 'rejected', at: Date.now(), ...(feedback ? { feedback } : {}) };
  const what = first ? `❌ Cancelado «${pj.script?.title}». ${store.rejected?.(pj) ?? ''}` : '';
  return `${what}${feedback ? '\n📝 Anotado el motivo: lo tendré en cuenta en los próximos vídeos.' : '\nResponde a este mensaje si quieres decirme qué está mal.'}`.trim();
}

/**
 * Escucha Telegram (long polling) y aplica botones, reacciones y respuestas del dueño.
 * store: { offset(): n, setOffset(n), byId(id) → pj, byMessage(messageId) → pj, save(pj), rejected(pj) → texto (pide el reemplazo) }.
 */
export async function listenTelegram(store, log = () => {}) {
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset: await store.offset(), timeout: 50, allowed_updates: ['message', 'callback_query', 'message_reaction'] });
      for (const u of updates) {
        await store.setOffset(u.update_id + 1);
        const chat = String(u.message?.chat.id ?? u.callback_query?.message?.chat.id ?? u.message_reaction?.chat.id ?? '');
        if (chat !== CHAT) { if (u.message?.text?.startsWith('/start')) log(`ℹ️ Telegram: /start desde el chat ${chat} (no es TELEGRAM_CHAT_ID)`); continue; }
        if (u.callback_query) {
          const [act, id] = String(u.callback_query.data).split(':');
          const pj = await store.byId(id);
          const text = pj ? await decide(pj, act === 'ok', '', store) : 'No encuentro ese vídeo';
          if (pj) await store.save(pj);
          await tg('answerCallbackQuery', { callback_query_id: u.callback_query.id, text: text.slice(0, 190) });
          await tg('editMessageReplyMarkup', { chat_id: CHAT, message_id: u.callback_query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
          await say(text, { reply_to_message_id: u.callback_query.message.message_id });
        } else if (u.message_reaction) {
          const emoji = u.message_reaction.new_reaction?.map((r) => r.emoji).find(Boolean);
          const pj = emoji && await store.byMessage(u.message_reaction.message_id);
          if (!pj || (!GOOD.has(emoji) && !BAD.has(emoji))) continue;
          const text = await decide(pj, GOOD.has(emoji), '', store);
          await store.save(pj);
          await say(text, { reply_to_message_id: u.message_reaction.message_id });
        } else if (u.message?.text) {
          const pj = u.message.reply_to_message && await store.byMessage(u.message.reply_to_message.message_id);
          if (!pj) { await say('Responde al mensaje del vídeo para decirme qué está mal (o reacciona con 👍 / 👎).'); continue; }
          const text = await decide(pj, false, u.message.text.slice(0, 1000), store);
          await store.save(pj);
          await say(text, { reply_to_message_id: u.message.message_id });
        }
      }
    } catch (e) {
      log(`⚠️ Telegram: ${e.message}`);
      await new Promise((r) => setTimeout(r, 30000));
    }
  }
}

/** Motivos de rechazo recientes, para que el generador no repita lo que no gustó. */
export function reviewLearnings(projects) {
  const notes = projects.filter((p) => p.review?.feedback).sort((a, b) => (b.review.at ?? 0) - (a.review.at ?? 0)).slice(0, 12)
    .map((p) => `- «${p.script?.title}»: ${p.review.feedback}`);
  return notes.length ? `\nREVISIONES DEL DUEÑO DEL CANAL (vídeos que rechazó y por qué: no repitas esos fallos):\n${notes.join('\n')}\n` : '';
}
