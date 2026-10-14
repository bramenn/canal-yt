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
// cada short que termina aparece al momento en la lista
const streamTo = (ui, url, body) => stream(url, body, (e) => {
  if (e.type === 'log' || e.type === 'text') ui.add(e.text);
  if (e.type === 'short') { list = [e.project, ...list.filter((x) => x.id !== e.project.id)]; render(); }
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
  return `<div class="stats">${row('youtube', 'yt', 'YouTube')}${row('tiktok', 'tt', 'TikTok')}${row('facebook', 'fb', 'Facebook')}
    <small class="hint">Actualizado ${ago(s.at)}</small></div>`;
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

function render() {
  $('#shorts').innerHTML = list.length ? list.map((p) => `
    <div class="short" data-id="${p.id}">
      <video src="${esc(p.video)}?v=${p.updated ?? ''}" ${p.thumbSmall ? `poster="${esc(p.thumbSmall)}?v=${p.updated ?? ''}"` : ''} controls preload="metadata" playsinline></video>
      <div class="body">
        <div class="title">${esc(p.script?.title)}</div>
        <div class="hint">${esc(p.story?.anime)} · ${esc(p.story?.angle)}${p.voice?.title ? ` · 🎙 ${esc(p.voice.title)}` : ''}</div>
        <div class="row wrap">
          <a class="btn primary" href="${esc(p.video)}" download="${esc(slug(p.script?.title ?? p.id))}-youtube.mp4" title="Para YouTube Shorts">⬇ YouTube${p.duration ? ` · ${p.duration} s` : ''}</a>
          ${p.tiktok ? `<a class="btn primary" href="${esc(p.tiktok.video)}" download="${esc(slug(p.script?.title ?? p.id))}-tiktok.mp4" title="Más de 1 minuto: entra en el programa de pagos de TikTok">⬇ TikTok · ${p.tiktok.duration} s</a>`
    : '<button data-act="tiktok" title="Versión de más de 1 minuto para poder monetizar en TikTok">🎵 Hacer versión TikTok</button>'}
          <button data-act="copy-yt" title="Título, descripción con pregunta y hashtags para YouTube Shorts">📋 YouTube</button>
          <button data-act="copy-tt" title="Texto con palabras clave, pregunta y hashtags para TikTok">📋 TikTok</button>
          <button data-act="remake" title="Guion, voz y montaje nuevos (con la voz elegida arriba)">🔄 Rehacer</button>
          <button data-act="del" class="danger" title="Borrar">🗑</button>
        </div>
        ${statsBox(p)}
        ${thumbBox(p.thumbSmall, p.thumb, p.script?.thumb_text, slug(p.script?.title ?? p.id), 'thumb')}
        ${p.story?.sources?.length ? `<details class="hint"><summary>Fuentes</summary>${p.story.sources.map((u) => `<div><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a></div>`).join('')}</details>` : ''}
      </div>
    </div>`).join('') : '<div class="empty">Aún no hay shorts. Pulsa «Crear shorts de hoy».</div>';
}

$('#shorts').onclick = async (e) => {
  const card = e.target.closest('.short');
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!card || !act) return;
  const p = list.find((x) => x.id === card.dataset.id);
  if (act === 'copy-yt' || act === 'copy-tt') {
    const yt = act === 'copy-yt';
    await navigator.clipboard.writeText(p.script.copy ? copyText(yt ? 'youtube' : 'tiktok', p.script.copy) : oldText(p));
    toast(`Texto para ${yt ? 'YouTube' : 'TikTok'} copiado`, 'ok');
  }
  if (act === 'tiktok') runTask(`Versión TikTok de «${p.story.anime}»`, async (ui) => { const ev = await streamTo(ui, `/api/tiktok/${p.id}`, {}); return `Versión TikTok lista (${ev.data.duration} s)`; });
  if (act === 'thumb') runTask(`Miniatura de «${p.story.anime}»`, async (ui) => { await streamTo(ui, `/api/thumb/${p.id}`, {}); return 'Miniatura lista: ya es el primer fotograma del vídeo'; });
  if (act === 'remake') runTask(`Rehaciendo «${p.story.anime}»`, async (ui) => { await streamTo(ui, `/api/remake/${p.id}`, { voice: $('#voice-pick').value }); return 'Short rehecho'; });
  if (act === 'del') {
    if (!(await ask({ title: '¿Borrar este short?', text: 'Se mueve a la papelera (recuperable desde la base de datos).', ok: 'Borrar', danger: true }))) return;
    await fetch(`/api/projects/${p.id}`, { method: 'DELETE' });
    list = list.filter((x) => x.id !== p.id);
    render();
  }
};

$('#auto').onclick = () => {
  const count = Number($('#count').value);
  runTask(`Creando ${count} short${count > 1 ? 's' : ''} de anime`, async (ui) => {
    ui.step('Buscar historias → guion → voz → tráileres → montaje');
    const ev = await streamTo(ui, '/api/auto', { count, voice: $('#voice-pick').value });
    return `${ev.data.made} short${ev.data.made === 1 ? '' : 's'} listo${ev.data.made === 1 ? '' : 's'}`;
  });
};

$('#stats').onclick = () => runTask('Leyendo las cifras de YouTube, TikTok y Facebook', async (ui) => {
  const ev = await streamTo(ui, '/api/stats', {});
  list = await getJSON('/api/projects');
  render();
  return `${ev.data.found} short${ev.data.found === 1 ? '' : 's'} con cifras`;
});

$('#logout').onclick = async () => { await postJSON('/api/logout', {}).catch(() => {}); location.replace('/login'); };

// ================= arranque =================
const [me, shorts] = await Promise.all([getJSON('/api/me'), getJSON('/api/projects').catch(() => [])]);
$('#me').textContent = `👤 ${me.username}`;
list = shorts;
render();
// la última voz elegida se recuerda en este navegador
try { $('#voice-pick').value = localStorage.getItem('anime.voice') || 'hombre'; } catch {}
$('#voice-pick').onchange = (e) => { try { localStorage.setItem('anime.voice', e.target.value); } catch {} };
