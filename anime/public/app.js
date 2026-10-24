// Estudio Anime: un botón crea los shorts del día (historias, guion, voz y montaje en el servidor); aquí se ven,
// se descargan, se copian título y texto, y se rehacen o borran.
import { stream, getJSON, postJSON } from '/shared/api.js';
import { copyText } from '/shared/social.js';

// sesión caducada o cerrada en otro sitio: de vuelta al login
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const r = await nativeFetch(...args);
  if (r.status === 401) location.replace('/login');
  return r;
};

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60) || 'short';
const sortByCreated = (arr) => [...arr].sort((a, b) => (b.created ?? b.updated ?? 0) - (a.created ?? a.updated ?? 0));
let list = [];

// ================= avisos, preguntas y tareas =================
function toast(text, kind = '', ms = 3800) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function ask({ title, text = '', ok = 'Aceptar', danger = false }) {
  const dlg = $('#ask');
  $('#ask-title').textContent = title;
  $('#ask-text').textContent = text;
  $('#ask-ok').textContent = ok;
  $('#ask-ok').className = danger ? 'danger' : 'primary';
  dlg.showModal();
  return new Promise((resolve) => {
    $('#ask-ok').onclick = () => { dlg.close(); resolve(true); };
    dlg.onclose = () => resolve(null);
  });
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) e.target.closest('dialog')?.close(); });

let job = null;
function startTask(title) {
  const ctrl = new AbortController();
  job = ctrl;
  const box = $('#task');
  box.hidden = false;
  box.className = 'task';
  $('#task-title').textContent = title;
  $('#task-step').textContent = '';
  $('#task-now').textContent = 'Empezando…';
  $('#task-log').innerHTML = '';
  $('#task-close').textContent = 'Cancelar';
  $('#task-close').onclick = () => ctrl.abort();
  const t0 = Date.now();
  const tick = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); $('#task-time').textContent = s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; }, 500);
  const add = (text, cls = '') => {
    const li = document.createElement('li');
    li.textContent = text; li.className = cls;
    $('#task-log').appendChild(li);
    $('#task-log').scrollTop = 1e9;
    if (!/^(⚙️|✍️ )/.test(text)) $('#task-now').textContent = text.replace(/^\s+/, '');
  };
  const end = (text, cls) => {
    clearInterval(tick);
    job = null;
    box.classList.add(cls === 'ok' ? 'done' : 'fail');
    box.classList.remove('min');
    $('#task-now').textContent = text;
    add(text, cls);
    $('#task-close').textContent = 'Cerrar';
    $('#task-close').onclick = () => { box.hidden = true; };
  };
  return {
    signal: ctrl.signal, add,
    step: (s) => { $('#task-step').textContent = s; },
    ok: (t) => { end(t, 'ok'); if ($('#task').classList.contains('min')) toast(t, 'ok'); },
    fail: (t) => end(t, 'bad'),
  };
}
$('#task-min').onclick = () => $('#task').classList.toggle('min');

async function runTask(title, fn) {
  if (job) { toast('Espera a que termine la tarea en marcha (abajo a la derecha)'); return null; }
  const ui = startTask(title);
  try { const msg = await fn(ui); ui.ok(msg || 'Listo'); return true; }
  catch (e) { ui.fail(ui.signal.aborted ? 'Cancelado' : `No se pudo: ${e.message}`); return null; }
}
// cada short que termina aparece al momento en la lista manteniendo el orden por fecha de generación
const streamTo = (ui, url, body) => stream(url, body, (e) => {
  if (e.type === 'log' || e.type === 'text') ui.add(e.text);
  if (e.type === 'short') { list = sortByCreated([e.project, ...list.filter((x) => x.id !== e.project.id)]); render(); }
}, ui.signal);

// ================= shorts =================
const nf = (n) => (n == null ? '–' : n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e4 ? `${Math.round(n / 1e3)} mil` : n.toLocaleString('es'));
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d`; };
// logos de las redes (Simple Icons, CC0) e iconos de las cifras
const svg = (d, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const LOGO = {
  youtube: svg('M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z', 'logo yt'),
  tiktok: svg('M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z', 'logo tt'),
  facebook: svg('M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z', 'logo fb'),
  instagram: svg('M12 2.2c3.2 0 3.6 0 4.8.1 3.3.1 4.8 1.7 4.9 4.9.1 1.3.1 1.6.1 4.8s0 3.6-.1 4.8c-.1 3.2-1.7 4.8-4.9 4.9-1.3.1-1.6.1-4.8.1s-3.6 0-4.8-.1c-3.3-.1-4.8-1.7-4.9-4.9C2.2 15.6 2.2 15.2 2.2 12s0-3.6.1-4.8C2.4 3.9 3.9 2.4 7.2 2.3 8.4 2.2 8.8 2.2 12 2.2ZM12 0C8.7 0 8.3 0 7.1.1 2.7.3.3 2.7.1 7.1 0 8.3 0 8.7 0 12s0 3.7.1 4.9c.2 4.4 2.6 6.8 7 7 1.2.1 1.6.1 4.9.1s3.7 0 4.9-.1c4.4-.2 6.8-2.6 7-7 .1-1.2.1-1.6.1-4.9s0-3.7-.1-4.9c-.2-4.4-2.6-6.8-7-7C15.7 0 15.3 0 12 0Zm0 5.8a6.2 6.2 0 1 0 0 12.4 6.2 6.2 0 0 0 0-12.4ZM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm6.4-11.8a1.4 1.4 0 1 0 0 2.9 1.4 1.4 0 0 0 0-2.9Z', 'logo ig'),
};
const ICON = {
  views: svg('M12 5C6.5 5 2.3 8.6 1 12c1.3 3.4 5.5 7 11 7s9.7-3.6 11-7c-1.3-3.4-5.5-7-11-7Zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Zm0-2.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'ic'),
  likes: svg('M12 21s-7.5-4.6-9.6-9.2C.9 8.5 3 4.5 6.9 4.5c2.1 0 3.7 1.2 5.1 3 1.4-1.8 3-3 5.1-3 3.9 0 6 4 4.5 7.3C19.5 16.4 12 21 12 21Z', 'ic'),
  comments: svg('M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'ic'),
};
/** Cifras por plataforma: logo, vistas (y lo que subieron desde la lectura anterior), likes y comentarios. */
function statsBox(p) {
  const s = p.stats;
  if (!s) return '';
  const prev = s.history?.at(-2);
  const row = (key, short, name) => {
    const x = s[key];
    if (!x) return `<div class="stat off">${LOGO[key]}<span>Sin publicar en ${name}</span></div>`;
    const d = prev?.[short] != null && x.views != null ? x.views - prev[short] : 0;
    const part = (k) => (x[k] == null ? '' : `<span class="n">${ICON[k]}${nf(x[k])}</span>`);
    return `<a class="stat" href="${esc(x.url)}" target="_blank" rel="noopener" title="Abrir en ${name}">${LOGO[key]}
      <span class="n main">${ICON.views}<b>${nf(x.views)}</b>${d > 0 ? `<em>+${nf(d)}</em>` : ''}</span>${part('likes')}${part('comments')}</a>`;
  };
  const a = s.youtube?.analytics;
  const ytDetail = a?.lifetime ? `<small class="yt-detail" title="YouTube Analytics · datos disponibles hasta ${esc(a.through ?? 's/d')}">YouTube Studio (hasta ${esc(a.through ?? 's/d')}) · ${nf(a.lifetime.engagedViews)} vistas interesadas · ${a.lifetime.averageViewPercentage == null ? 's/d' : `${Number(a.lifetime.averageViewPercentage).toFixed(1)}% visto`} · ${a.lifetime.averageViewDuration == null ? 's/d' : `${Number(a.lifetime.averageViewDuration).toFixed(1)} s promedio`} · +${nf(a.lifetime.subscribersGained)} / −${nf(a.lifetime.subscribersLost)} subs</small>` : '';
  const publicDetail = s.youtube?.public?.fetchedAt ? `<small class="hint">Cifras públicas de YouTube: ${ago(s.youtube.public.fetchedAt)}${!a?.lifetime ? ' · retención y suscriptores pendientes' : ''}</small>` : '';
  return `<div class="stats">${row('youtube', 'yt', 'YouTube')}${row('tiktok', 'tt', 'TikTok')}${row('facebook', 'fb', 'Facebook')}${row('instagram', 'ig', 'Instagram')}
    ${ytDetail}${publicDetail}<small class="hint">Actualizado ${ago(s.at)}</small></div>`;
}
/** Bloque de la miniatura: vista pequeña, su texto y descargar 4K / YouTube / rehacer. */
const thumbBox = (small, full, text, name, act) => (small ? `
  <div class="thumb-box">
    <img src="${esc(small)}" alt="" />
    <div class="info">
      <b>Miniatura</b><small>«${esc(text ?? '')}» · también es el primer fotograma</small>
      <div class="group">
        <a class="btn" href="${esc(full)}" download="${esc(name)}-miniatura-4k.jpg" title="2160×3840">⬇ 4K</a>
        <a class="btn" href="${esc(small)}" download="${esc(name)}-miniatura.jpg" title="1080×1920, menos de 2 MB (para subir a YouTube)">⬇ YouTube</a>
        <button data-act="${act}" title="Texto y dibujo nuevos">🖼 Rehacer</button>
      </div>
    </div>
  </div>` : `<div class="row"><button data-act="${act}">🖼 Hacer miniatura</button></div>`);
// shorts antiguos sin texto por plataforma: título, descripción y hashtags de siempre
const oldText = (p) => `${p.script.title}\n\n${p.script.description}\n\n${(p.script.hashtags ?? []).map((h) => `#${h.replace(/^#/, '')}`).join(' ')}`;

function commentBox(p) {
  const comment = p.script?.copy?.suggested_comment?.trim();
  return `<section class="comment-box" aria-label="Comentario recomendado">
    ${comment ? `<label>Comentario recomendado<textarea class="comment-text" readonly rows="3">${esc(comment)}</textarea></label>
    <div class="row wrap"><button data-act="copy-comment">📋 Copiar comentario</button></div>
    <small class="hint">Pégalo como comentario en tus redes. En YouTube puedes fijarlo.</small>`
    : '<span class="hint">Prepara una pregunta para invitar a conversar, sin rehacer el vídeo.</span><div class="row wrap"><button data-act="comment">💬 Preparar comentario</button></div>'}
  </section>`;
}

const mediaURL = (url, p) => url ? `${url.split('?')[0]}?v=${p.thumbRevision ?? p.updated ?? ''}` : url;
const fmtDur = (sec = 0) => {
  const s = Math.max(0, Math.round(sec));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min` : `${s} s`;
};
const chaptersBox = (p) => {
  if (!p.chaptersTimeline?.length) return '';
  const lines = p.chaptersTimeline.map((c) => {
    const s = Math.max(0, Math.floor(c.start || 0));
    const ts = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    return `${ts} · ${c.number > 0 ? `#${c.number} ${c.heading} (${c.anime})` : c.heading}`;
  }).join('\n');
  return `<details class="hint" open><summary>📌 Capítulos (${p.chaptersTimeline.filter((c) => c.number > 0).length})</summary><div class="chapters-list">${esc(lines)}</div></details>`;
};

const qaText = (qa) => {
  const mm = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const bad = [qa.repeats?.length && `${qa.repeats.length} repetido${qa.repeats.length > 1 ? 's' : ''} (${qa.repeats.slice(0, 4).map(([a, b]) => `${mm(a)}→${mm(b)}`).join(', ')})`,
    qa.blacks?.length && `${qa.blacks.length} negro${qa.blacks.length > 1 ? 's' : ''} (${qa.blacks.slice(0, 4).map(([a]) => mm(a)).join(', ')})`,
    qa.silences?.length && `${qa.silences.length} silencio${qa.silences.length > 1 ? 's' : ''} (${qa.silences.slice(0, 4).map(([a]) => mm(a)).join(', ')})`].filter(Boolean);
  return bad.length ? `🔎 Revisar: ${bad.join(' · ')}` : '🔎 Revisión: sin repeticiones, negros ni silencios';
};

function renderCard(p) {
  const isLong = p.kind === 'long';
  return `
    <div class="short${isLong ? ' long' : ''}" data-id="${p.id}">
      <video src="${esc(mediaURL(p.video, p))}" ${p.thumbSmall ? `poster="${esc(mediaURL(p.thumbSmall, p))}"` : ''} controls preload="metadata" playsinline></video>
      <div class="body">
        <div class="title">${esc(p.script?.title)}</div>
        ${p.qa ? `<div class="hint" title="Revisión automática del vídeo terminado">${esc(qaText(p.qa))}</div>` : ''}
        ${p.failed ? '<div class="hint">⚠️ El montaje falló: pulsa «🎬 Re-montar» (usa la misma voz, no vuelve a pagar ElevenLabs)</div>' : ''}
        <div class="hint">${esc(p.story?.anime)} · ${esc(p.story?.angle)}${p.voice?.title ? ` · 🎙 ${esc(p.voice.title)}` : ''}</div>
        <div class="row wrap">
          <a class="btn primary" href="${esc(mediaURL(p.video, p))}" download="${esc(slug(p.script?.title ?? p.id))}-${isLong ? 'youtube-16x9' : 'youtube'}.mp4" title="${isLong ? 'Vídeo largo 16:9 para YouTube' : 'Para YouTube Shorts'}">⬇ YouTube${p.duration ? ` · ${fmtDur(p.duration)}` : ''}</a>
          ${isLong ? '' : (p.tiktok ? `<a class="btn primary" href="${esc(mediaURL(p.tiktok.video, p))}" download="${esc(slug(p.script?.title ?? p.id))}-tiktok.mp4" title="Más de 1 minuto: entra en el programa de pagos de TikTok">⬇ TikTok · ${p.tiktok.duration} s</a>`
    : '<button data-act="tiktok" title="Versión de más de 1 minuto para poder monetizar en TikTok">🎵 Hacer versión TikTok</button>')}
          <button data-act="copy-yt" title="Título, descripción${isLong ? ' con capítulos (00:00)' : ' con pregunta'} y hashtags para YouTube">📋 YouTube</button>
          ${isLong ? '' : '<button data-act="copy-tt" title="Texto con palabras clave, pregunta y hashtags para TikTok">📋 TikTok</button><button data-act="copy-ig" title="Texto para el reel de Instagram (sube aquí el vídeo de YouTube): tu mejor red">📋 Instagram</button>'}
          <button data-act="remount" title="Re-montar solo el vídeo manteniendo el mismo guion, voz y miniatura">🎬 Re-montar</button>
          <button data-act="remake" title="Guion, voz y montaje nuevos (con la voz elegida arriba)">🔄 Rehacer</button>
          <button data-act="del" class="danger" title="Borrar">🗑</button>
        </div>
        ${isLong ? '' : scheduleBox(p)}
        ${isLong ? chaptersBox(p) : ''}
        ${commentBox(p)}
        ${p.viral?.level ? `<div class="viral ${p.viral.level}" title="Comparado con la mediana de tus shorts a la misma edad · ${p.viral.perHour ?? 0} vistas/h ahora">${esc(p.viral.label)}</div>` : ''}
        ${statsBox(p)}
        ${thumbBox(mediaURL(p.thumbSmall, p), mediaURL(p.thumb, p), p.script?.thumb_text, slug(p.script?.title ?? p.id), 'thumb')}
        ${p.story?.sources?.length ? `<details class="hint"><summary>Fuentes</summary>${p.story.sources.map((u) => `<div><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a></div>`).join('')}</details>` : ''}
      </div>
    </div>`;
}

// Horas para publicar (hora de Colombia), separadas ≥1 h en cada red. Facebook, medido (39 reels, oct-2026): 14-16 h y
// 18-20 h dan 6-10 veces más que la mañana. YouTube no da la hora en su export: horas de más actividad del público latino
// (picos 18-19 h) y las que ya funcionaron. ponytail: franjas fijas; recalcular con más datos.
const SLOTS = { youtube: ['12:00', '18:00', '20:00'], facebook: ['14:30', '18:00', '19:30'] };
let schedule = new Map();
/** Cada short sin publicar en una red recibe la siguiente franja libre, del más antiguo al más nuevo (3 por día). */
function planSchedule(shorts) {
  schedule = new Map();
  for (const net of Object.keys(SLOTS)) {
    shorts.filter((p) => !p.stats?.[net] && Date.now() - (p.created ?? 0) < 3 * 864e5).sort((a, b) => (a.created ?? 0) - (b.created ?? 0)).forEach((p, i) => {
      const day = Math.floor(i / SLOTS[net].length);
      const when = `${day === 0 ? 'hoy' : day === 1 ? 'mañana' : `en ${day} días`} ${SLOTS[net][i % SLOTS[net].length]}`;
      schedule.set(p.id, { ...schedule.get(p.id), [net]: when });
    });
  }
}
const scheduleBox = (p) => { const s = schedule.get(p.id); return s ? `<div class="hint schedule" title="Horas recomendadas (Colombia), una franja distinta para cada short pendiente">🕐 Publicar: ${s.youtube ? `YouTube ${s.youtube}` : ''}${s.youtube && s.facebook ? ' · ' : ''}${s.facebook ? `Facebook ${s.facebook}` : ''}</div>` : ''; };

function render() {
  const shortsList = list.filter((p) => p.kind !== 'long');
  planSchedule(shortsList);
  const longsList = list.filter((p) => p.kind === 'long');
  $('#shorts').innerHTML = shortsList.length ? shortsList.map(renderCard).join('') : '<div class="empty">Aún no hay shorts. Pulsa «Crear shorts de hoy».</div>';
  if ($('#longs')) $('#longs').innerHTML = longsList.length ? longsList.map(renderCard).join('') : '<div class="empty">Aún no hay vídeos largos 16:9. Pulsa «Crear vídeo largo (8-10 min)».</div>';
}

const onCardClick = async (e) => {
  const card = e.target.closest('.short');
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!card || !act) return;
  const p = list.find((x) => x.id === card.dataset.id);
  if (act === 'copy-comment') {
    const text = p.script?.copy?.suggested_comment?.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast('Comentario copiado: listo para pegar', 'ok');
    } catch {
      const field = $('.comment-text', card);
      field.focus(); field.select();
      toast('No se pudo copiar automáticamente. El texto está seleccionado para copiarlo.', 'bad');
    }
  }
  if (act === 'comment') runTask(`Comentario de «${p.story.anime}»`, async (ui) => { await streamTo(ui, `/api/comment/${p.id}`, {}); return 'Comentario listo para copiar'; });
  if (act === 'copy-yt' || act === 'copy-tt' || act === 'copy-ig') {
    const yt = act === 'copy-yt';
    await navigator.clipboard.writeText(p.script.copy ? copyText(yt ? 'youtube' : 'tiktok', p.script.copy) : oldText(p));
    toast(`Texto para ${yt ? 'YouTube' : act === 'copy-ig' ? 'Instagram' : 'TikTok'} copiado`, 'ok');
  }
  if (act === 'tiktok') runTask(`Versión TikTok de «${p.story.anime}»`, async (ui) => { const ev = await streamTo(ui, `/api/tiktok/${p.id}`, {}); return `Versión TikTok lista (${ev.data.duration} s)`; });
  if (act === 'thumb') runTask(`Miniatura de «${p.story.anime}»`, async (ui) => { await streamTo(ui, `/api/thumb/${p.id}`, {}); return p.kind === 'long' ? 'Miniatura 16:9 lista' : 'Miniatura lista: ya es el primer fotograma del vídeo'; });
  if (act === 'remount') runTask(`Re-montando vídeo de «${p.story.anime}»`, async (ui) => { await streamTo(ui, `/api/remount/${p.id}`, {}); return 'Vídeo re-montado con el mismo guion y voz'; });
  if (act === 'remake') {
    const voice = p.kind === 'long' ? ($('#long-voice-pick')?.value || $('#voice-pick').value) : $('#voice-pick').value;
    runTask(`Rehaciendo «${p.story.anime}»`, async (ui) => { await streamTo(ui, `/api/remake/${p.id}`, { voice }); return p.kind === 'long' ? 'Vídeo largo rehecho' : 'Short rehecho'; });
  }
  if (act === 'del') {
    if (!(await ask({ title: p.kind === 'long' ? '¿Borrar este vídeo largo?' : '¿Borrar este short?', text: 'Se mueve a la papelera (recuperable desde la base de datos).', ok: 'Borrar', danger: true }))) return;
    await fetch(`/api/projects/${p.id}`, { method: 'DELETE' });
    list = list.filter((x) => x.id !== p.id);
    render();
  }
};
$('#shorts').onclick = onCardClick;
if ($('#longs')) $('#longs').onclick = onCardClick;

// Pestañas Shorts / Vídeos largos
document.querySelectorAll('.tab[data-tab]').forEach((btn) => {
  btn.onclick = () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
    $('#view-shorts').hidden = tab !== 'shorts';
    $('#view-long').hidden = tab !== 'long';
  };
});

$('#auto').onclick = () => {
  const count = Number($('#count').value);
  runTask(`Creando ${count} short${count > 1 ? 's' : ''} de anime`, async (ui) => {
    ui.step('Buscar historias → guion → voz → tráileres → montaje');
    const ev = await streamTo(ui, '/api/auto', { count, voice: $('#voice-pick').value });
    return `${ev.data.made} short${ev.data.made === 1 ? '' : 's'} listo${ev.data.made === 1 ? '' : 's'}`;
  });
};

if ($('#make-long')) {
  $('#make-long').onclick = () => {
    const topic = $('#long-topic')?.value.trim() || '';
    const voice = $('#long-voice-pick')?.value || $('#voice-pick').value;
    runTask('Creando vídeo largo 16:9 (8-10 min)', async (ui) => {
      ui.step('Top 10 con episodio exacto → guion y voz por puesto → escenas del episodio (nyaa) → montaje 16:9 → miniatura y capítulos');
      const ev = await streamTo(ui, '/api/long', { topic, voice });
      return `Vídeo largo listo (${fmtDur(ev.data.duration)})`;
    });
  };
}

$('#stats').onclick = () => runTask('Leyendo las cifras de YouTube, TikTok y Facebook', async (ui) => {
  const ev = await streamTo(ui, '/api/stats', {});
  list = sortByCreated(await getJSON('/api/projects'));
  render();
  return `${ev.data.found} short${ev.data.found === 1 ? '' : 's'} con cifras`;
});

$('#logout').onclick = async () => { await postJSON('/api/logout', {}).catch(() => {}); location.replace('/login'); };

// ================= arranque =================
const [me, shorts, ai, config] = await Promise.all([getJSON('/api/me'), getJSON('/api/projects').catch(() => []), getJSON('/api/ai-status').catch(() => null), getJSON('/api/config').catch(() => null)]);
if (config) $('#tiktok-on').checked = config.tiktok;
$('#tiktok-on').onchange = async (e) => {
  try { await postJSON('/api/config', { tiktok: e.target.checked }); toast(e.target.checked ? 'Se hará también la versión TikTok' : 'Solo versión YouTube (súbela también a TikTok)', 'ok'); }
  catch { e.target.checked = !e.target.checked; toast('No se pudo guardar la configuración', 'bad'); }
};
$('#ai-engine').textContent = ai ? `IA: ${ai.engine === 'codex' ? 'Codex' : ai.engine === 'claude' ? 'Claude' : 'Automático'}` : '';
$('#me').textContent = `👤 ${me.username}`;
list = sortByCreated(shorts);
render();
// la última voz elegida se recuerda en este navegador
try {
  const savedVoice = localStorage.getItem('anime.voice') || 'hombre';
  $('#voice-pick').value = savedVoice;
  if ($('#long-voice-pick')) $('#long-voice-pick').value = savedVoice;
} catch {}
const syncVoice = (e) => {
  try { localStorage.setItem('anime.voice', e.target.value); } catch {}
  $('#voice-pick').value = e.target.value;
  if ($('#long-voice-pick')) $('#long-voice-pick').value = e.target.value;
};
$('#voice-pick').onchange = syncVoice;
if ($('#long-voice-pick')) $('#long-voice-pick').onchange = syncVoice;
