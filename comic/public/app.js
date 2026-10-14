// Estudio Cómic: inicio (nuevo episodio + mis episodios) y la vista de shorts de cada episodio (podcast.js).
import { stream, getJSON, postJSON } from '/shared/api.js';
import { openPodcast, closePodcast } from './podcast.js';

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
let project = null;

// ================= avisos, preguntas y tareas =================
function toast(text, kind = '', ms = 3800) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** Ventana de confirmación o de texto. Devuelve true/el texto, o null si se cancela. */
function ask({ title, text = '', input = false, value = '', ok = 'Aceptar', danger = false }) {
  const dlg = $('#ask');
  $('#ask-title').textContent = title;
  $('#ask-text').textContent = text;
  $('#ask-input').hidden = !input;
  $('#ask-input').value = value;
  $('#ask-ok').textContent = ok;
  $('#ask-ok').className = danger ? 'danger' : 'primary';
  dlg.showModal();
  if (input) $('#ask-input').focus();
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); resolve(v); };
    $('#ask-ok').onclick = () => done(input ? $('#ask-input').value.trim() || null : true);
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
  $('#task-bar').parentElement.classList.remove('det');
  $('#task-bar').style.width = '';
  $('#task-close').textContent = 'Cancelar';
  $('#task-close').onclick = () => ctrl.abort();
  const t0 = Date.now();
  const tick = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); $('#task-time').textContent = s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; }, 500);
  const add = (text, cls = '') => {
    const li = document.createElement('li');
    li.textContent = text; li.className = cls;
    $('#task-log').appendChild(li);
    $('#task-log').scrollTop = 1e9;
    if (!/^(⚙️|✍️)/.test(text)) $('#task-now').textContent = text.replace(/^\s+/, '');
  };
  const end = (text, cls) => {
    clearInterval(tick);
    job = null;
    saveNow();
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
    progress: (p) => { $('#task-bar').parentElement.classList.add('det'); $('#task-bar').style.width = `${Math.round(p * 100)}%`; },
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

/** SSE del servidor con los mensajes al panel de la tarea. */
const streamTo = (ui, url, body, onEvent) => stream(url, body, (e) => {
  if (e.type === 'log' || e.type === 'text') ui.add(e.text);
  onEvent?.(e);
}, ui.signal);

// ================= episodios y navegación =================
let saveTimer = null;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 600); };
const saveNow = () => { clearTimeout(saveTimer); saveTimer = null; return project && postJSON('/api/projects', project).then((r) => { project.updated = r.updated; }).catch((e) => console.error(e)); };
addEventListener('pagehide', () => { if (saveTimer && project) { clearTimeout(saveTimer); navigator.sendBeacon('/api/projects', new Blob([JSON.stringify(project)], { type: 'application/json' })); } });

function showHome() {
  project = null;
  closePodcast();
  history.replaceState(null, '', location.pathname);
  $('#home').hidden = false;
  $('#podcast-view').hidden = true;
  $('#home-btn').hidden = true;
  renderProjects();
}
$('#go-home').onclick = $('#home-btn').onclick = (e) => { e.preventDefault(); if (project) saveNow(); showHome(); };

async function renderProjects() {
  const list = await getJSON('/api/projects').catch(() => []);
  $('#project-list').innerHTML = list.length ? list.map((p) => `
    <div class="card" data-id="${p.id}">
      <div class="cover" style="${p.cover ? `background-image:url('${esc(p.cover)}')` : ''}"></div>
      <div class="body">
        <div class="title">${esc(p.title)}</div>
        <div class="meta">
          <span class="pill">🎙 ${esc(p.channel)}</span>
          <span class="pill">${p.shorts} shorts</span>
          <span class="pill ${p.panels && p.drawn === p.panels ? 'ok' : ''}">🖌 ${p.drawn}/${p.panels} viñetas</span>
        </div>
        <div class="hint">${p.updated ? new Date(p.updated).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' }) : ''}</div>
      </div>
      <button class="icon del" data-del="${p.id}" title="Borrar">🗑</button>
    </div>`).join('') : '<div class="empty">Aún no hay episodios. Pega la URL de uno arriba.</div>';
}
$('#project-list').onclick = async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    if (!(await ask({ title: '¿Borrar este episodio?', text: 'Se mueve a la papelera (recuperable desde la base de datos).', ok: 'Borrar', danger: true }))) return;
    await fetch(`/api/projects/${del.dataset.del}`, { method: 'DELETE' });
    return renderProjects();
  }
  const card = e.target.closest('.card');
  if (card) openProject(await getJSON(`/api/projects/${card.dataset.id}`));
};

function openProject(p) {
  project = p;
  $('#home').hidden = true;
  $('#podcast-view').hidden = false;
  $('#home-btn').hidden = false;
  history.replaceState(null, '', `#${p.id}`);
  openPodcast(p, { $, esc, toast, ask, runTask, streamTo, save, slug });
}

$('#new-form').onsubmit = (e) => {
  e.preventDefault();
  const url = $('#podcast-url').value.trim();
  const id = Date.now().toString(36);
  runTask('Preparando los shorts del episodio', async (ui) => {
    ui.step('Descargar, transcribir, elegir los mejores relatos y guionizar cada cómic');
    const ev = await streamTo(ui, '/api/podcast', { url, projectId: id }, (x) => { if (x.type === 'progress') ui.progress(x.p); });
    const p = { id, source: ev.data.source, shorts: ev.data.shorts };
    p.updated = (await postJSON('/api/projects', p)).updated;
    e.target.reset();
    openProject(p);
    return `${p.shorts.length} shorts listos para dibujar: pulsa «Dibujar» en el que quieras`;
  });
};

$('#logout').onclick = async () => { await postJSON('/api/logout', {}).catch(() => {}); location.replace('/login'); };

// ================= arranque =================
const id = location.hash.slice(1);
const opening = id && getJSON(`/api/projects/${id}`);
const me = await getJSON('/api/me');
$('#me').textContent = `👤 ${me.username}`;
if (opening) opening.then(openProject).catch(showHome);
else showHome();
