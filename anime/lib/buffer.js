// Publicar en YouTube, TikTok y Facebook a través de Buffer (API GraphQL, clave personal en BUFFER_API_KEY).
// Buffer no recibe archivos: descarga el vídeo de un enlace público al publicar. Los subimos al servidor de Contabo
// (saitama, /srv/nt-media) y se sirven en https://bramen.org/nt-media/ (nginx del clúster, namespace nt-media).
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat, rm, copyFile, mkdir, readdir } from 'node:fs/promises';
import { run } from '../../lib/ytdlp.js';
import { youtubeAccessToken, youtubeVideoId } from '../../lib/youtube-analytics.js';
import { copyText } from '../../public/js/social.js';
import { SLOTS, nextSlot, fmtSlot } from '../../public/js/schedule.js';

const API = 'https://api.buffer.com';
const HOST = 'root@167.86.102.102';
const REMOTE_DIR = '/srv/nt-media';
const PUBLIC_URL = 'https://bramen.org/nt-media';

export const bufferReady = () => !!process.env.BUFFER_API_KEY;

async function gql(query, variables = {}) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.BUFFER_API_KEY}` },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors?.length) throw new Error(`Buffer: ${j.errors?.[0]?.message ?? `HTTP ${r.status}`}`);
  return j.data;
}

/** Canales conectados en Buffer de las redes que usamos: { youtube, tiktok, facebook } → id. */
export async function bufferChannels() {
  const { account } = await gql('{ account { organizations { id } } }');
  const out = {};
  for (const { id } of account.organizations) {
    const { channels } = await gql('query($id: OrganizationId!) { channels(input: { organizationId: $id }) { id service isQueuePaused } }', { id });
    for (const c of channels) if (SLOTS[c.service] && !out[c.service]) out[c.service] = c.id;
  }
  return out;
}

// en el clúster la propia app sirve la carpeta PUBLIC_MEDIA_DIR en PUBLIC_MEDIA_URL (sin login); en el portátil, saitama por scp
const LOCAL_DIR = process.env.PUBLIC_MEDIA_DIR;
const LOCAL_URL = process.env.PUBLIC_MEDIA_URL;

/** Deja un archivo en un enlace público y lo devuelve (nombre con azar: no se puede adivinar). */
async function host(file, id) {
  const name = `${id}-${randomBytes(6).toString('hex')}${path.extname(file)}`;
  if (LOCAL_DIR) {
    await mkdir(LOCAL_DIR, { recursive: true });
    await copyFile(file, path.join(LOCAL_DIR, name));
    return `${LOCAL_URL}/${name}`;
  }
  await run('scp', ['-q', '-o', 'BatchMode=yes', file, `${HOST}:${REMOTE_DIR}/${name}`], 600000);
  return `${PUBLIC_URL}/${name}`;
}

/** Borra los vídeos públicos de hace más de 10 días (ya publicados). */
async function cleanHosted() {
  if (!LOCAL_DIR) return run('ssh', ['-o', 'BatchMode=yes', HOST, `find ${REMOTE_DIR} -type f -name '*-*' -mtime +10 -delete`]);
  for (const f of await readdir(LOCAL_DIR)) {
    const full = path.join(LOCAL_DIR, f);
    if (Date.now() - (await stat(full)).mtimeMs > 10 * 864e5) await rm(full, { force: true });
  }
}


/**
 * Programa un short o un largo en Buffer en las horas recomendadas.
 * taken: { youtube: Set<ms>, … } horas ya ocupadas por otros vídeos. Devuelve [{ service, id, dueAt }].
 */
export { nextSlot };

export async function scheduleInBuffer(pj, { mediaDir, taken, only = null, from = Date.now() }, log = () => {}) {
  const c = pj.script?.copy;
  if (!c) throw new Error('Este vídeo no tiene texto de publicación');
  const channels = await bufferChannels();
  const isLong = pj.kind === 'long';
  // only: reintentar solo algunas redes (las demás ya estaban programadas)
  const nets = ['youtube', 'facebook', ...(isLong ? [] : ['tiktok'])].filter((n) => channels[n] && (!only || only.includes(n)));
  if (!nets.length) throw new Error('No hay canales de YouTube, TikTok o Facebook conectados en Buffer');
  const dir = path.join(mediaDir, pj.id);
  const local = (u) => u && path.join(dir, path.basename(u));
  log('☁️ Subiendo el vídeo al servidor para Buffer…');
  const video = await host(local(pj.video), pj.id);
  const tiktokFile = local(pj.tiktok?.video);
  const ttVideo = !isLong && tiktokFile && existsSync(tiktokFile) ? await host(tiktokFile, `${pj.id}-tt`) : video;

  // el comentario recomendado lo pone checkBufferPosts en YouTube (el primer comentario de Facebook es de pago en Buffer)
  const posts = [];
  for (const net of nets) {
    // from: programar a partir de un día concreto (p. ej. repartir una serie de shorts en varios días)
    const dueAt = nextSlot(net, taken[net] ?? new Set(), from);
    const yt = net === 'youtube';
    const metadata = yt
      ? { youtube: { title: c.yt_title.slice(0, 100), privacy: 'public', categoryId: '1', madeForKids: false, notifySubscribers: true } }
      : net === 'facebook' ? { facebook: { type: isLong ? 'post' : 'reel' } } : undefined;
    const input = {
      channelId: channels[net],
      text: yt ? [c.yt_description, '', copyText('tiktok', { tt_hashtags: c.yt_hashtags }).trim()].join('\n') : copyText('tiktok', c),
      schedulingType: 'automatic',
      mode: 'customScheduled',
      dueAt: new Date(dueAt).toISOString(),
      // Buffer rechaza miniaturas propias: en TikTok la portada es el primer fotograma, que en los shorts ya es la miniatura;
      // en YouTube la pone checkBufferPosts al publicarse (API de YouTube)
      assets: [{ video: { url: net === 'tiktok' ? ttVideo : video, ...(net === 'tiktok' ? { metadata: { thumbnailOffset: 0 } } : {}) } }],
      ...(metadata ? { metadata } : {}),
    };
    // un fallo en una red no pierde las ya programadas (se guardan igual y el error queda a la vista)
    const { createPost } = await gql(`mutation($input: CreatePostInput!) { createPost(input: $input) {
      ... on PostActionSuccess { post { id dueAt } } ... on MutationError { message } } }`, { input }).catch((e) => ({ createPost: { message: e.message } }));
    if (createPost.message) { log(`⚠️ ${net}: ${createPost.message}`); posts.push({ service: net, dueAt, done: true, error: createPost.message.slice(0, 200) }); continue; }
    posts.push({ service: net, id: createPost.post.id, dueAt });
    (taken[net] ??= new Set()).add(dueAt);
    log(`📤 ${net}: programado para ${fmtSlot(dueAt)}`);
  }
  // lo ya publicado hace más de 10 días ya no hace falta en el servidor
  await cleanHosted().catch(() => {});
  return posts;
}

/** Cancela en Buffer lo que aún no ha salido (rechazado o sin aprobar) y lo deja anotado con el motivo. */
export async function cancelBufferPosts(pj, why) {
  for (const p of pj.buffer?.posts ?? []) {
    if (!p.id || p.done) continue;
    await gql('mutation($id: PostId!) { deletePost(input: { id: $id }) { __typename ... on MutationError { message } } }', { id: p.id }).catch(() => {});
    Object.assign(p, { done: true, error: why });
  }
}

/** Estado de una publicación en Buffer: { status, externalLink, error }. */
export async function bufferPost(id) {
  const { post } = await gql('query($id: PostId!) { post(input: { id: $id }) { status externalLink error { message } } }', { id });
  return post;
}

/** Sube la miniatura del vídeo a YouTube (≤ 2 MB, máx. 1280 px). Requiere el permiso youtube.force-ssl (npm run youtube-auth). */
export async function setYoutubeThumb(videoId, file) {
  const small = `${file}.yt.jpg`;
  try {
    for (const q of [2, 5, 9]) {
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', file, '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease', '-q:v', String(q), small]);
      if ((await stat(small)).size < 2e6) break;
    }
    const r = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await youtubeAccessToken()}`, 'Content-Type': 'image/jpeg' },
      body: await readFile(small),
    });
    if (!r.ok) throw new Error(`YouTube miniatura: ${(await r.json().catch(() => ({})))?.error?.message ?? `HTTP ${r.status}`}`);
  } finally {
    await rm(small, { force: true });
  }
}

/** Publica un comentario del canal bajo el vídeo (permiso youtube.force-ssl). */
export async function youtubeComment(videoId, text) {
  const r = await fetch('https://www.googleapis.com/youtube/v3/commentThreads?part=snippet', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await youtubeAccessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } } }),
  });
  if (!r.ok) throw new Error(`YouTube comentario: ${(await r.json().catch(() => ({})))?.error?.message ?? `HTTP ${r.status}`}`);
}

/**
 * Revisa las publicaciones programadas que ya tocaban: guarda su enlace o su error y, en YouTube, pone la miniatura.
 * Devuelve true si cambió algo del proyecto (para guardarlo).
 */
export async function checkBufferPosts(pj, mediaDir, log = () => {}) {
  let changed = false;
  for (const p of pj.buffer?.posts ?? []) {
    if (p.done || p.dueAt > Date.now()) continue;
    const post = await bufferPost(p.id).catch(() => null);
    if (post?.status === 'error') { Object.assign(p, { done: true, error: post.error?.message ?? 'error al publicar' }); changed = true; continue; }
    if (post?.status !== 'sent') continue;
    p.url = post.externalLink;
    if (p.service === 'youtube') {
      const videoId = youtubeVideoId(p.url);
      const thumb = path.join(mediaDir, pj.id, 'thumb-4k.jpg');
      if (videoId && existsSync(thumb)) {
        try { await setYoutubeThumb(videoId, thumb); p.thumb = true; log(`🖼 Miniatura puesta en YouTube: ${pj.script?.title}`); }
        catch (e) { p.thumbError = e.message.slice(0, 200); }
      }
      const comment = pj.script?.copy?.suggested_comment?.trim();
      if (videoId && comment) {
        // ponytail: la API de YouTube no permite fijar comentarios; se fija a mano desde YouTube Studio
        try { await youtubeComment(videoId, comment); p.comment = true; }
        catch (e) { p.commentError = e.message.slice(0, 200); }
      }
    }
    p.done = true;
    changed = true;
  }
  return changed;
}
