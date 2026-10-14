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
/** Cifras por plataforma: 👁 ❤ 💬, enlace y lo que subieron las vistas desde la lectura anterior. */
function statsBox(p) {
  const s = p.stats;
  if (!s) return '';
  const prev = s.history?.at(-2);
  const row = (key, short, icon, name) => {
    const x = s[key];
    if (!x) return `<div class="stat off">${icon} ${name} <small>sin publicar</small></div>`;
    const d = prev?.[short] != null && x.views != null ? x.views - prev[short] : 0;
    return `<a class="stat" href="${esc(x.url)}" target="_blank" rel="noopener" title="Abrir en ${name}">${icon} <b>${nf(x.views)}</b>${d > 0 ? `<em>+${nf(d)}</em>` : ''} <span>❤ ${nf(x.likes)}</span> <span>💬 ${nf(x.comments)}</span></a>`;
  };
  return `<div class="stats">${row('youtube', 'yt', '▶️', 'YouTube')}${row('tiktok', 'tt', '🎵', 'TikTok')}${row('facebook', 'fb', '📘', 'Facebook')}
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
