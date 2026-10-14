// Estudio de fútbol: guion (Claude Code) → imágenes (fotos y clips) → voz IA → miniatura → MP4.
// Interfaz por pasos: inicio (nuevo vídeo + tus vídeos) y editor con 5 pasos y la vista previa siempre visible.
import { Player } from '/engine/timeline.js';
import { Mixer } from '/engine/audio.js';
import { stream, getJSON, postJSON } from '/shared/api.js';
import { exportVideo, canExportFast, downloadUrl } from '/shared/exporter.js';
import { drawThumb, loadImg, fontReady, TW, TH } from './thumb.js';
import { drawFrame, preload, W, H, setRedraw, setLive, seekFor, endExport, TRANSITIONS, transitionOf } from './render.js';

// sesión caducada o cerrada en otro sitio: de vuelta al login
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const r = await nativeFetch(...args);
  if (r.status === 401) location.replace('/login');
  return r;
};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60) || 'video';
const WPM = 150;
const STEPS = ['guion', 'imagenes', 'voz', 'miniatura', 'publicar'];
const CHECK_V = 2; // v2 = la revisión también comprueba que la foto encaje con la frase

const player = new Player($('#canvas'), drawFrame);
const mixer = new Mixer();
player.setMixer(mixer);
setRedraw(() => player.render());
let project = null;
let step = 'guion';
let status = {};
let pickedVoice = null;
const store = { get: (k) => { try { return JSON.parse(localStorage.getItem(`futbol.${k}`)); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(`futbol.${k}`, JSON.stringify(v)); } catch {} } };

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
// todas las ventanas: botón ✕ / Cancelar
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
    // la línea principal: lo último que pasó, sin emojis técnicos repetidos
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
    refreshAll();
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

// ================= proyectos y navegación =================
let saveTimer = null;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 600); };
const saveNow = () => { clearTimeout(saveTimer); saveTimer = null; return project && postJSON('/api/projects', project).then((r) => { project.updated = r.updated; }).catch((e) => console.error(e)); };
// al cerrar la pestaña con cambios sin guardar: se envían igualmente
addEventListener('pagehide', () => { if (saveTimer && project) { clearTimeout(saveTimer); navigator.sendBeacon('/api/projects', new Blob([JSON.stringify(project)], { type: 'application/json' })); } });

function showHome() {
  player.pause();
  project = null;
  history.replaceState(null, '', location.pathname);
  $('#home').hidden = false;
  $('#editor').hidden = true;
  $('#steps').hidden = true;
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
          <span class="pill ${p.shots && p.withMedia === p.shots ? 'ok' : ''}">🖼 ${p.withMedia ?? 0}/${p.shots ?? 0}</span>
          <span class="pill ${p.voice ? 'ok' : ''}">🎙 ${p.voice ? 'voz' : 'sin voz'}</span>
          <span class="pill ${p.thumbs ? 'ok' : ''}">🖼 ${p.thumbs ? 'miniatura' : 'sin miniatura'}</span>
          ${p.exported ? '<span class="pill ok">⬇ exportado</span>' : ''}
        </div>
        <div class="hint">${p.updated ? new Date(p.updated).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' }) : ''}</div>
      </div>
      <button class="icon del" data-del="${p.id}" title="Borrar">🗑</button>
    </div>`).join('') : '<div class="empty">Aún no hay vídeos. Escribe un tema arriba y pulsa «Crear vídeo».</div>';
}
$('#project-list').onclick = async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    if (!(await ask({ title: '¿Borrar este vídeo?', text: 'Se mueve a la papelera del proyecto (futbol/projects/.papelera).', ok: 'Borrar', danger: true }))) return;
    await fetch(`/api/projects/${del.dataset.del}`, { method: 'DELETE' });
    return renderProjects();
  }
  const card = e.target.closest('.card');
  if (card) openProject(await getJSON(`/api/projects/${card.dataset.id}`));
};

async function openProject(p, view) {
  project = p;
  $('#home').hidden = true;
  $('#editor').hidden = false;
  $('#steps').hidden = false;
  $('#home-btn').hidden = false;
  $('#title').textContent = p.video.title;
  mixer.clearVoice();
  player.seek(0);
  pickedVoice = null;
  rebuild();
  preload(allShots().map((s) => s.media));
  setStep(view || store.get(`step.${p.id}`) || 'guion');
  await loadVoice();
}

function setStep(s) {
  step = STEPS.includes(s) ? s : 'guion';
  if (project) { store.set(`step.${project.id}`, step); history.replaceState(null, '', `#${project.id}/${step}`); }
  $$('#steps button').forEach((b) => b.classList.toggle('on', b.dataset.step === step));
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== step; });
  scrollTo({ top: 0 });
  renderStep();
}
$('#steps').onclick = (e) => { const b = e.target.closest('[data-step]'); if (b) setStep(b.dataset.step); };

function renderStep() {
  if (!project) return;
  ({ guion: renderScript, imagenes: renderShots, voz: renderVoice, miniatura: renderThumbs, publicar: renderPublish })[step]();
  updateSteps();
}
function refreshAll() { if (project) { rebuild(); renderStep(); } }

/** Estado de cada paso en la barra superior. */
function updateSteps() {
  const shots = allShots();
  const withMedia = shots.filter((s) => s.media).length;
  const flagged = shots.filter((s) => s.media?.check?.ok === false).length;
  const stale = staleVoice();
  const st = {
    guion: { done: true, text: `${project.video.segments.length} partes` },
    imagenes: { done: withMedia === shots.length && !flagged, warn: flagged > 0, text: flagged ? `${flagged} con aviso` : `${withMedia}/${shots.length}` },
    voz: { done: !!project.voice && !stale, warn: stale > 0, text: project.voice ? (stale ? 'hay cambios' : project.voice.voiceTitle.split(' - ')[0]) : 'pendiente' },
    miniatura: { done: !!project.thumbs?.length, text: project.thumbs?.length ? 'lista' : 'pendiente' },
    publicar: { done: !!project.exported, text: project.exported ? 'exportado' : '' },
  };
  for (const b of $$('#steps button')) {
    const s = st[b.dataset.step];
    b.classList.toggle('done', !!s.done);
    b.classList.toggle('warn', !!s.warn);
    $('small', b).textContent = s.text;
  }
}

$('#title').addEventListener('input', () => { project.video.title = $('#title').textContent.trim(); save(); });
$('#title').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });

// ================= nuevo vídeo =================
// modo: «Tengo una idea» (la IA investiga y escribe) o «Ya tengo el guion» (se usa tal cual)
$('#mode-tabs').onclick = (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  const mode = b.dataset.mode;
  $('#new-form').dataset.mode = mode;
  $$('#mode-tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $('#lead').textContent = mode === 'idea'
    ? 'Escribe la pregunta o la historia. El estudio investiga, escribe el guion, busca fotos y clips, pone la voz y prepara la miniatura.'
    : 'Pega tu guion. Se usa tal cual: el estudio solo le pone las imágenes, los clips, la voz y la miniatura.';
  $('#topic').required = mode === 'idea';
  $('#own-script').required = mode === 'script';
  (mode === 'idea' ? $('#topic') : $('#own-script')).focus();
};
$('#own-script').addEventListener('input', (e) => {
  const words = e.target.value.split(/\s+/).filter(Boolean).length;
  $('#script-stats').textContent = words ? `${words} palabras · unos ${Math.max(1, Math.round(words / WPM * 10) / 10)} min de vídeo` : '';
});
$('#examples').onclick = (e) => { if (e.target.tagName === 'BUTTON') { $('#topic').value = e.target.textContent; $('#topic').focus(); } };
$('#topic').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#new-form').requestSubmit(); } });

$('#new-form').onsubmit = (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const auto = !!f.auto;
  const own = e.target.dataset.mode === 'script';
  runTask(auto ? 'Creando el vídeo completo' : own ? 'Preparando tu guion' : 'Escribiendo el guion', async (ui) => {
    const total = auto ? 5 : 1;
    ui.step(`Paso 1 de ${total} · ${own ? 'Repartiendo las imágenes por tu guion (sin cambiar el texto)' : 'Investigando y escribiendo el guion (unos minutos)'}`);
    const ev = own
      ? await streamTo(ui, '/api/script/import', { text: f.script, title: f.title })
      : await streamTo(ui, '/api/script', { topic: f.topic, minutes: Number(f.minutes), notes: f.notes, model: f.model });
    const p = { id: Date.now().toString(36), topic: own ? (f.title || ev.data.title) : f.topic, video: ev.data };
    p.updated = (await postJSON('/api/projects', p)).updated;
    await openProject(p, 'guion');
    e.target.reset();
    if (!auto) return 'Guion listo. Revísalo y sigue con las imágenes.';
    ui.step('Paso 2 de 5 · Eligiendo las fotos'); setStep('imagenes');
    await doPhotos(ui);
    ui.step('Paso 3 de 5 · Buscando clips de vídeo'); await doClips(ui);
    ui.step('Paso 4 de 5 · Poniendo la voz');
    const voice = await defaultVoice();
    if (voice) { setStep('voz'); await doVoice(ui, voice); } else ui.add('⚠️ No hay voz elegida todavía: elígela en el paso «Voz» y pulsa «Generar la voz».');
    ui.step('Paso 5 de 5 · Creando las miniaturas'); setStep('miniatura');
    await doThumbs(ui);
    return 'Vídeo listo: revisa cada paso y exporta en «Publicar».';
  });
};

// ================= línea de tiempo y vista previa =================
const allShots = () => project.video.segments.flatMap((s) => s.shots);
const shotList = () => project.video.segments.flatMap((s, si) => s.shots.map((sh, k) => ({ sh, si, k, key: `${si + 1}.${k + 1}` })));
const isPhoto = (sh) => sh.media && sh.media.type !== 'video';
const voiceSeg = (i) => { const v = project.voice?.segments?.find((x) => x.index === i); return v && v.text === project.video.segments[i].narration ? v : null; };
const staleVoice = () => (project.voice ? project.video.segments.filter((_, i) => !voiceSeg(i)).length : 0);

function rebuild() {
  const video = { segments: project.video.segments.map((s) => ({ ...s, scenes: s.shots })) };
  const durs = mixer.voice.length ? project.video.segments.map((_, i) => (voiceSeg(i) ? mixer.voice[i]?.duration ?? null : null)) : null;
  const align = project.video.segments.map((_, i) => voiceSeg(i)?.words ?? null);
  mixer.setVoiceWords(align);
  player.load(video, { wpm: WPM, segDurations: durs, segAlign: align });
}

async function loadVoice() {
  if (!project.voice) return;
  await mixer.loadVoice(project.video.segments.map((_, i) => voiceSeg(i)?.url ?? null)).catch((e) => toast(`No se pudo cargar la voz: ${e.message}`, 'bad'));
  rebuild();
  player.refreshAudio();
  updateSteps();
}

$('#play').onclick = $('#big-play').onclick = () => player.toggle();
$('#seek').oninput = (e) => player.seek((e.target.value / 1000) * player.tl.duration);
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && project && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !document.activeElement.isContentEditable && !$('dialog[open]')) { e.preventDefault(); player.toggle(); }
});
let activeShot = null, lastWord = -1;
player.on((type, pl) => {
  if (type === 'play' || type === 'pause' || type === 'ended') {
    $('#play').textContent = pl.playing ? '❚❚' : '▶';
    $('.player').classList.toggle('playing', pl.playing);
    setLive(pl.playing);
  }
  if (type !== 'time' && type !== 'load') return;
  $('#time').textContent = `${fmt(pl.t)} / ${fmt(pl.tl.duration)}`;
  if (document.activeElement !== $('#seek')) $('#seek').value = Math.round((pl.t / pl.tl.duration) * 1000);
  const sc = pl.tl.scenes.find((s) => pl.t >= s.start && pl.t < s.end);
  const key = sc ? `${sc.seg}-${sc.idx}` : null;
  if (key !== activeShot) {
    $('.tile-shot.active')?.classList.remove('active');
    activeShot = key;
    if (key) $(`.tile-shot[data-key="${key}"]`)?.classList.add('active');
  }
  showNow(pl);
});

// «Ahora se dice»: la frase que suena, con la palabra actual resaltada
function showNow(pl) {
  const words = pl.tl.words;
  if (!words.length) return;
  let i = words.findIndex((w) => pl.t < w.t1);
  if (i < 0) i = words.length - 1;
  if (i === lastWord) return;
  lastWord = i;
  let a = i, b = i;
  while (a > 0 && words[a - 1].seg === words[i].seg && !/[.?!…]$/.test(words[a - 1].text)) a--;
  while (b < words.length - 1 && words[b + 1].seg === words[i].seg && !/[.?!…]$/.test(words[b].text)) b++;
  $('#now-text').innerHTML = words.slice(a, b + 1).map((w, n) => (a + n === i ? `<b>${esc(w.text)}</b>` : esc(w.text))).join(' ');
}

// ================= 1 · Guion =================
function renderScript() {
  const tl = player.tl;
  $('#segments').innerHTML = (project.video.ownScript ? '<p class="hint">📝 Es tu guion: la IA no lo modifica. Puedes editarlo tú aquí.</p>' : '') + project.video.segments.map((s, si) => {
    const seg = tl.segments[si];
    const stale = project.voice && !voiceSeg(si);
    return `<div class="seg ${stale ? 'voice-stale' : ''}" data-si="${si}">
      <div class="seg-head"><span class="seg-tag">${si + 1} · ${esc(s.section)}</span>
        <span class="hint">${seg ? `${fmt(seg.start)} – ${fmt(seg.end)}` : ''}${stale ? ' · la voz de esta parte hay que regenerarla' : ''}</span>
        ${project.video.ownScript ? '' : '<button data-act="refine">✨ Reescribir con IA</button>'}</div>
      <textarea data-act="narration" spellcheck="true">${esc(s.narration)}</textarea>
    </div>`;
  }).join('');
}
let editTimer = null;
$('#segments').addEventListener('input', (e) => {
  const seg = e.target.closest('.seg');
  if (!seg || e.target.dataset.act !== 'narration') return;
  project.video.segments[seg.dataset.si].narration = e.target.value;
  clearTimeout(editTimer);
  editTimer = setTimeout(() => { rebuild(); updateSteps(); save(); }, 500);
});
$('#segments').addEventListener('click', async (e) => {
  if (e.target.dataset.act !== 'refine') return;
  const si = Number(e.target.closest('.seg').dataset.si);
  const s = project.video.segments[si];
  const instruction = await ask({ title: `Reescribir la parte ${si + 1}`, text: '¿Qué quieres cambiar? Por ejemplo: «más corto», «añade el dato del traspaso», «más emoción al final».', input: true, ok: 'Reescribir' });
  if (!instruction) return;
  runTask(`Reescribiendo la parte ${si + 1}`, async (ui) => {
    const ev = await streamTo(ui, '/api/refine', { segment: { section: s.section, narration: s.narration, shots: s.shots.map(({ cue, desc, query }) => ({ cue, desc, query })) }, instruction, title: project.video.title });
    project.video.segments[si] = ev.data;
    rebuild(); save();
    return `Parte ${si + 1} reescrita. Sus imágenes cambiaron: completa las que falten en «Imágenes».`;
  });
});

// ================= 2 · Imágenes =================
function renderShots() {
  const tl = player.tl;
  const list = shotList();
  const missing = list.filter(({ sh }) => !sh.media).length;
  const flagged = list.filter(({ sh }) => sh.media?.check?.ok === false).length;
  const clips = list.filter(({ sh }) => sh.media?.type === 'video').length;
  $('#img-summary').innerHTML = `<span class="pill">${list.length} imágenes</span>${clips ? `<span class="pill">▶ ${clips} clips</span>` : ''}${missing ? `<span class="pill warn">${missing} sin imagen</span>` : ''}${flagged ? `<span class="pill warn">${flagged} con aviso</span>` : ''}${!missing && !flagged ? '<span class="pill ok">todo listo</span>' : ''}`;
  $('#shots').innerHTML = project.video.segments.map((s, si) => `
    <div class="shot-group"><h3>${si + 1} · ${esc(s.section)} <span>${s.shots.length} imágenes${tl.segments[si] ? ` · ${fmt(tl.segments[si].start)}` : ''}</span></h3>
      <div class="shot-grid">${s.shots.map((sh, k) => tileHtml(si, k, sh)).join('')}</div>
    </div>`).join('');
  if (activeShot) $(`.tile-shot[data-key="${activeShot}"]`)?.classList.add('active');
}

function tileHtml(si, k, sh) {
  const m = sh.media;
  const bad = m?.check?.ok === false;
  const badge = m?.type === 'video' ? `<span class="badge">▶ ${Math.round(m.dur)} s</span>` : bad ? '<span class="badge bad">⚠ revisar</span>' : '';
  return `<button class="tile-shot ${bad ? 'flag' : ''}" data-si="${si}" data-k="${k}" data-key="${si}-${k}" title="${esc(bad ? m.check.what : sh.desc)}">
    <div class="img ${m ? '' : 'empty'}" style="${m ? `background-image:url('${esc(m.thumb ?? m.url)}')` : ''}">${m ? '' : 'Sin imagen'}</div>
    <span class="num">${si + 1}.${k + 1}</span>${badge}
    <div class="cap">${esc(sh.desc)}</div>
  </button>`;
}

function refreshShot(si, k) {
  const el = $(`.tile-shot[data-key="${si}-${k}"]`);
  if (el) el.outerHTML = tileHtml(si, k, project.video.segments[si].shots[k]);
  if (shotOpen && shotOpen.si === si && shotOpen.k === k) fillShotDialog();
}

async function setMedia(si, k, media, check = true) {
  project.video.segments[si].shots[k].media = media;
  refreshShot(si, k);
  await preload([media]);
  rebuild();
  updateSteps();
  save();
  if (check) checkInBackground(si, k);
}

$('#shots').addEventListener('click', (e) => {
  const tile = e.target.closest('.tile-shot');
  if (!tile) return;
  const si = Number(tile.dataset.si), k = Number(tile.dataset.k);
  const sc = player.tl.scenes.find((x) => x.seg === si && x.idx === k);
  if (sc) player.seek(sc.start + 0.6);
  openShot(si, k);
});

// ---- ventana de una imagen ----
let shotOpen = null;
$('#shot-transition').innerHTML = Object.entries(TRANSITIONS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');

function openShot(si, k) {
  shotOpen = { si, k };
  $('#shot-results').hidden = true;
  fillShotDialog();
  $('#shot-dlg').showModal();
}

function fillShotDialog() {
  const { si, k } = shotOpen;
  const sh = project.video.segments[si].shots[k];
  const m = sh.media;
  $('#shot-title').textContent = `Imagen ${si + 1}.${k + 1} · ${project.video.segments[si].section}`;
  const box = $('#shot-media');
  box.style.backgroundImage = m && m.type !== 'video' ? `url('${m.url}')` : '';
  box.innerHTML = m?.type === 'video' ? `<video src="${esc(m.url)}" autoplay muted loop playsinline></video>` : m ? '' : 'Sin imagen todavía';
  $('#shot-warn').hidden = m?.check?.ok !== false;
  $('#shot-warn').textContent = m?.check?.ok === false ? `⚠ ${m.check.what}` : '';
  const sentence = sentenceOf(si, sh);
  const cue = String(sh.cue ?? '').trim();
  const at = cue ? sentence.toLowerCase().indexOf(cue.toLowerCase()) : -1;
  $('#shot-sentence').innerHTML = at >= 0 ? `${esc(sentence.slice(0, at))}<b>${esc(sentence.slice(at, at + cue.length))}</b>${esc(sentence.slice(at + cue.length))}` : esc(sentence);
  $('#shot-desc').textContent = sh.desc;
  $('#shot-query').value = sh.query ?? '';
  $('#shot-cue').value = sh.cue ?? '';
  $('#shot-transition').value = sh.transition ?? 'auto';
}
$('#shot-dlg').addEventListener('close', () => { shotOpen = null; $('#shot-media').innerHTML = ''; });

const curShot = () => project.video.segments[shotOpen.si].shots[shotOpen.k];
$('#shot-query').oninput = (e) => { curShot().query = e.target.value; save(); };
$('#shot-cue').oninput = (e) => { curShot().cue = e.target.value; clearTimeout(editTimer); editTimer = setTimeout(() => { rebuild(); fillShotDialog(); save(); }, 500); };
$('#shot-transition').onchange = (e) => { curShot().transition = e.target.value; save(); };

$('#shot-dlg').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || !shotOpen) return;
  const { si, k } = shotOpen;
  if (act === 'file') $('#shot-file').click();
  if (act === 'clip') { $('#shot-dlg').close(); openClip(si, k); }
  if (act === 'url') {
    const url = await ask({ title: 'Pegar enlace de una imagen', text: 'En Google Imágenes: clic derecho sobre la foto → «Copiar dirección de la imagen» y pégala aquí.', input: true, ok: 'Usar esta imagen' });
    if (!url) return;
    try { await setMedia(si, k, await postJSON('/api/media/fetch', { projectId: project.id, url })); toast('Imagen cambiada'); } catch (err) { toast(err.message, 'bad'); }
  }
  if (act === 'del') {
    if (!(await ask({ title: 'Quitar esta imagen', text: 'La frase seguirá en el guion; la imagen anterior se quedará más tiempo en pantalla.', ok: 'Quitar', danger: true }))) return;
    project.video.segments[si].shots.splice(k, 1);
    $('#shot-dlg').close();
    rebuild(); renderShots(); updateSteps(); save();
  }
  if (act === 'search') searchPhotos();
});

async function searchPhotos() {
  const { si, k } = shotOpen;
  const box = $('#shot-results');
  box.hidden = false;
  const q = curShot().query;
  box.innerHTML = `<div class="res-head"><input id="res-q" value="${esc(q)}" /><button id="res-go">Buscar</button></div><span class="hint">Buscando fotos…</span>`;
  $('#res-go').onclick = () => { curShot().query = $('#res-q').value; $('#shot-query').value = $('#res-q').value; save(); searchPhotos(); };
  $('#res-q').onkeydown = (e) => { if (e.key === 'Enter') $('#res-go').click(); };
  try {
    const r = await getJSON(`/api/media/search?q=${encodeURIComponent(q)}`);
    box.querySelector('.hint').outerHTML = `<span class="hint" style="grid-column:1/-1">Haz clic en la que quieras usar (${r.items.length} resultados)</span>` + r.items.map((it, n) => `<img src="${esc(it.thumb)}" data-n="${n}" title="${esc(it.title)} · ${esc(it.credit.site)}" loading="lazy" referrerpolicy="no-referrer" />`).join('');
    box.onclick = async (ev) => {
      const it = r.items[ev.target.dataset?.n];
      if (!it || ev.target.tagName !== 'IMG') return;
      ev.target.style.opacity = 0.4;
      try { await setMedia(si, k, await postJSON('/api/media/fetch', { projectId: project.id, url: it.url, credit: it.credit })); box.hidden = true; toast('Imagen cambiada · comprobando que encaje…'); }
      catch (err) { ev.target.style.opacity = 1; toast(`Esa no se pudo descargar: prueba otra (${err.message})`, 'bad'); }
    };
  } catch (err) { box.querySelector('.hint').textContent = err.message; }
}

$('#shot-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file || !shotOpen) return;
  const { si, k } = shotOpen;
  try {
    const r = await fetch(`/api/media/upload?projectId=${project.id}`, { method: 'POST', body: file, headers: { 'Content-Type': file.type } });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    await setMedia(si, k, { ...data, credit: { site: 'propia' } });
    toast('Foto subida');
  } catch (err) { toast(err.message, 'bad'); }
  e.target.value = '';
};

// ---- revisión y elección automática de fotos ----
/** La frase de la narración donde entra la imagen. */
function sentenceOf(si, sh) {
  const sentences = String(project.video.segments[si].narration).replace(/\*/g, '').split(/(?<=[.?!…])\s+/);
  const cue = String(sh.cue ?? '').toLowerCase().trim();
  return (cue && sentences.find((x) => x.toLowerCase().includes(cue))) || sentences[0] || '';
}

/** Claude revisa las fotos: que encajen con su frase y estén limpias (media.check = { ok, what, v }). */
async function checkPhotos(list, onEvent, signal) {
  if (!list.length) return 0;
  const ev = await stream('/api/media/check', { title: project.video.title, items: list.map((x) => ({ url: x.sh.media.url, desc: x.sh.desc, sentence: sentenceOf(x.si, x.sh) })) }, onEvent, signal);
  let bad = 0;
  for (const r of ev.data.results) {
    for (const x of list.filter((y) => y.sh.media?.url === r.url)) {
      x.sh.media.check = r.ok == null ? undefined : { ok: r.ok, what: r.what, v: CHECK_V };
      if (r.ok === false) { bad++; onEvent?.({ type: 'log', text: `🚫 ${x.si + 1}.${x.k + 1}: ${r.what}` }); }
      refreshShot(x.si, x.k);
    }
  }
  save();
  return bad;
}

// una foto elegida a mano se revisa en segundo plano y, si no encaja o tiene marca, se avisa
async function checkInBackground(si, k) {
  const sh = project.video.segments[si].shots[k];
  if (!isPhoto(sh)) return;
  try {
    await checkPhotos([{ sh, si, k }], null);
    if (sh.media.check?.ok === false) toast(`Imagen ${si + 1}.${k + 1}: ${sh.media.check.what}. Mejor elige otra.`, 'bad', 7000);
    updateSteps();
  } catch {}
}

/** 1) revisa las fotos que hay  2) elige mirando para las vacías o rechazadas. Devuelve el resumen. */
async function doPhotos(ui) {
  const unchecked = shotList().filter(({ sh }) => isPhoto(sh) && sh.media.check?.v !== CHECK_V);
  if (unchecked.length) {
    ui.add(`🔍 Revisando ${unchecked.length} fotos: que encajen con lo que se dice y no tengan marcas`);
    const bad = await checkPhotos(unchecked, (e) => { if (e.type === 'log') ui.add(e.text); }, ui.signal);
    ui.add(bad ? `🚫 ${bad} no encajan o tienen marca: las cambio` : '✅ Las fotos que había encajan');
  }
  const todo = shotList().filter(({ sh }) => !sh.media || sh.media.check?.ok === false);
  let added = 0;
  if (todo.length) {
    ui.add(`📷 Eligiendo ${todo.length} fotos mirando cuál encaja mejor…`);
    const byKey = new Map(todo.map((x) => [x.key, x]));
    await streamTo(ui, '/api/media/pick', {
      projectId: project.id, title: project.video.title,
      items: todo.map((x) => ({ key: x.key, desc: x.sh.desc, sentence: sentenceOf(x.si, x.sh), query: x.sh.query })),
      exclude: allShots().map((s) => s.media?.credit?.image).filter(Boolean),
    }, (e) => {
      if (e.type === 'photo') { const x = byKey.get(e.key); if (x) { setMedia(x.si, x.k, e.media, false); added++; ui.progress(added / todo.length); } }
    });
  }
  const left = shotList().filter(({ sh }) => !sh.media || sh.media.check?.ok === false).length;
  return `${added} fotos nuevas${left ? ` · ${left} sin una foto que encaje (elígelas a mano)` : ' · todas encajan'}`;
}
$('#autofill').onclick = () => runTask('Completando y revisando fotos', doPhotos);

/** Clips de YouTube en los planos de acción. */
async function doClips(ui) {
  const durs = {};
  for (const sc of player.tl.scenes) durs[`${sc.seg + 1}.${sc.idx + 1}`] = sc.end - sc.start;
  const segments = project.video.segments.map((s) => ({ narration: s.narration, shots: s.shots.map(({ cue, desc, media }) => ({ cue, desc, media: media && { type: media.type } })) }));
  const ev = await streamTo(ui, '/api/clips/auto', { projectId: project.id, segments, durs }, (e) => {
    if (e.type === 'clip') setMedia(e.si, e.k, { ...e.media, why: e.why }, false);
  });
  return `${ev.data.placed} clips de vídeo colocados`;
}
$('#autoclips').onclick = () => runTask('Poniendo clips de vídeo', doClips);

// ================= 3 · Voz =================
let voiceList = null;
async function renderVoice() {
  const v = project.voice;
  const stale = staleVoice();
  const cur = pickedVoice ?? (v && { title: v.voiceTitle });
  $('#voice-current').innerHTML = cur
    ? `<span class="avatar">🎙</span><div><b>${esc(cur.title)}</b><div class="hint">${pickedVoice && (!v || pickedVoice.id !== v.voiceId) ? 'Elegida: pulsa «Generar la voz» para usarla' : stale ? `${stale} partes del guion cambiaron: vuelve a generar (solo se rehacen esas)` : 'Voz generada y al día'}</div></div>`
    : '<span class="avatar">🎙</span><div><b>Aún no hay voz</b><div class="hint">Escucha las voces de abajo (▶) y elige una.</div></div>';
  $('#voice-info').textContent = v && !stale && !pickedVoice ? '' : 'Tarda 1-2 minutos';
  if (!status.tts?.elevenlabs?.configured) { $('#voices').innerHTML = '<div class="empty">Falta la clave de ElevenLabs: ponla en ⚙ Ajustes.</div>'; return; }
  if (!voiceList) await searchVoices('');
  else drawVoices();
  // sin voz todavía: tu voz clonada ya viene elegida
  const fav = !v && !pickedVoice && voiceList?.find((x) => x.favorite);
  if (fav) { pickedVoice = fav; renderVoice(); }
}

async function searchVoices(q) {
  sample.pause();
  $('#voices').innerHTML = '<span class="hint">Cargando voces…</span>';
  try { voiceList = (await getJSON(`/api/tts/elevenlabs/voices?q=${encodeURIComponent(q)}`)).items; drawVoices(); }
  catch (e) { $('#voices').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function drawVoices() {
  const sel = pickedVoice?.id ?? project.voice?.voiceId;
  $('#voices').innerHTML = voiceList.map((v, n) => `<div class="voice ${v.id === sel ? 'on' : ''}" data-n="${n}">
      ${v.sample ? `<button class="play" data-play="${esc(v.sample)}" title="Escuchar">▶</button>` : '<span class="play"></span>'}
      <div class="who"><b>${esc(v.title.split(' - ')[0])}</b><small>${esc(v.author)}</small></div>
    </div>`).join('') || '<div class="empty">No hay voces con esa búsqueda.</div>';
}
$('#voice-search').onclick = () => searchVoices($('#voice-q').value.trim());
$('#voice-q').onkeydown = (e) => { if (e.key === 'Enter') $('#voice-search').click(); };
$('#voices').onclick = (e) => {
  const row = e.target.closest('.voice');
  if (!row) return;
  if (e.target.dataset.play) toggleSample(e.target);
  pickedVoice = voiceList[row.dataset.n];
  $$('.voice').forEach((x) => x.classList.toggle('on', x === row));
  renderVoice();
};

// muestras de voz: un solo reproductor; otra muestra corta la anterior y la misma se pausa
const sample = new Audio();
let sampleBtn = null;
const resetSampleBtn = () => { if (sampleBtn) sampleBtn.textContent = '▶'; };
sample.onended = sample.onpause = resetSampleBtn;
function toggleSample(btn) {
  if (sampleBtn === btn && !sample.paused) return sample.pause();
  sample.pause();
  resetSampleBtn(); // el evento 'pause' llega después, cuando sampleBtn ya es el nuevo
  sampleBtn = btn;
  if (sample.src !== btn.dataset.play) sample.src = btn.dataset.play;
  sample.play().then(() => { btn.textContent = '❚❚'; }).catch((e) => toast(`No se pudo reproducir: ${e.message}`, 'bad'));
}

/** La voz para el modo automático: la del proyecto, si no tu voz clonada, si no la última usada o la primera de tu cuenta. */
async function defaultVoice() {
  if (project.voice) return { id: project.voice.voiceId, title: project.voice.voiceTitle };
  const items = await getJSON('/api/tts/elevenlabs/voices?q=').then((r) => r.items).catch(() => []);
  return items.find((v) => v.favorite) ?? store.get('voice') ?? items.find((v) => !v.library) ?? null;
}

async function doVoice(ui, voice) {
  const segments = project.video.segments.map((s, index) => ({ index, text: s.narration }));
  const ev = await streamTo(ui, '/api/voice', { provider: 'elevenlabs', voiceId: voice.id, projectId: project.id, settings: {}, segments });
  project.voice = { provider: 'elevenlabs', voiceId: voice.id, voiceTitle: voice.title, segments: ev.data.segments.map((s) => ({ ...s, text: segments[s.index].text })) };
  store.set('voice', { id: voice.id, title: voice.title });
  pickedVoice = null;
  save();
  await loadVoice();
  return `Voz lista: ${voice.title.split(' - ')[0]}`;
}

$('#voice-gen').onclick = async () => {
  const voice = pickedVoice ?? (project.voice && { id: project.voice.voiceId, title: project.voice.voiceTitle });
  if (!voice) return toast('Primero elige una voz de la lista (pulsa ▶ para escucharlas)');
  // voz de la biblioteca: se añade a tu cuenta (ocupa uno de los huecos de voz del plan)
  if (voice.library) {
    if (!(await ask({ title: `Usar «${voice.title.split(' - ')[0]}»`, text: 'Es una voz de la biblioteca de ElevenLabs: se añadirá a tu cuenta y ocupará uno de los huecos de voz de tu plan.', ok: 'Añadir y usar' }))) return;
    try { Object.assign(voice, { id: (await postJSON('/api/tts/elevenlabs/add', { publicOwnerId: voice.publicOwnerId, voiceId: voice.id, name: voice.title })).voiceId, library: false }); }
    catch (e) { return toast(`No se pudo añadir la voz: ${e.message}`, 'bad'); }
  }
  runTask('Generando la voz', (ui) => doVoice(ui, voice));
};

// ================= 4 · Miniatura =================
async function doThumbs(ui) {
  const ev = await streamTo(ui, '/api/thumbs', {
    projectId: project.id, title: project.video.title,
    segments: project.video.segments.map(({ section, narration }) => ({ section, narration })),
    // fotos del proyecto sin avisos: las del protagonista son las mejores candidatas para recortar
    photos: allShots().filter((sh) => isPhoto(sh) && sh.media.check?.ok !== false).map((sh) => ({ url: sh.media.url, desc: sh.desc, credit: sh.media.credit })),
  });
  project.thumbs = ev.data.concepts;
  project.thumbPick = 0;
  save();
  if (step === 'miniatura') renderThumbs();
  return `${project.thumbs.length} miniaturas listas: elige una y su título`;
}
$('#thumbs-make').onclick = async () => {
  if (project.thumbs?.length && !(await ask({ title: '¿Crear otras 3 miniaturas?', text: 'Se sustituirán las que hay ahora.', ok: 'Crear otras' }))) return;
  runTask('Creando miniaturas', doThumbs);
};

async function paintThumb(canvas, t) {
  await fontReady();
  const [bg, cut] = await Promise.all([loadImg(t.bg.url), loadImg(t.cut.url)]);
  drawThumb(canvas.getContext('2d'), { ...t, bg, cut });
}

function renderThumbs() {
  const list = project.thumbs ?? [];
  $('#thumbs').innerHTML = list.length ? list.map((t, n) => `
    <div class="thumb-card ${n === project.thumbPick ? 'on' : ''}" data-n="${n}">
      <canvas width="${TW}" height="${TH}"></canvas>
      <div class="thumb-side">
        <div class="thumb-fields">
          <input data-f="text" value="${esc(t.text)}" title="Texto grande" placeholder="Texto" />
          <input data-f="highlight" value="${esc(t.highlight)}" title="La palabra que va en amarillo" placeholder="Palabra en amarillo" />
          <input data-f="sticker" value="${esc(t.sticker)}" title="Etiqueta roja (vacío = sin etiqueta)" placeholder="Etiqueta roja" />
          <button data-act="side" title="Cambiar el jugador de lado">⇄</button>
        </div>
        <span class="label">Elige el título (va con esta miniatura)</span>
        <div class="titles">${t.titles.map((x, k) => `<button class="title-opt ${n === project.thumbPick && x === project.video.title ? 'on' : ''}" data-act="title" data-k="${k}"><span>${esc(x)}</span>${n === project.thumbPick && x === project.video.title ? '<i>✓ EN USO</i>' : ''}</button>`).join('')}</div>
        <div class="thumb-actions"><button data-act="png">⬇ Descargar PNG</button></div>
      </div>
    </div>`).join('') : '<div class="empty">Aún no hay miniaturas. Pulsa «Crear 3 miniaturas».</div>';
  $$('#thumbs canvas').forEach((c, n) => paintThumb(c, list[n]).catch(() => {}));
}
$('#thumbs').addEventListener('input', (e) => {
  const card = e.target.closest('.thumb-card');
  if (!card || !e.target.dataset.f) return;
  const t = project.thumbs[card.dataset.n];
  t[e.target.dataset.f] = e.target.value;
  paintThumb($('canvas', card), t);
  save();
});
$('#thumbs').addEventListener('click', (e) => {
  const card = e.target.closest('.thumb-card');
  const btn = e.target.closest('[data-act]');
  if (!card || !btn) return;
  const n = Number(card.dataset.n);
  const t = project.thumbs[n];
  if (btn.dataset.act === 'side') { t.side = t.side === 'left' ? 'right' : 'left'; paintThumb($('canvas', card), t); save(); }
  if (btn.dataset.act === 'png') $('canvas', card).toBlob((b) => download(b, `${slug(project.video.title)}-miniatura.png`), 'image/png');
  if (btn.dataset.act === 'title') {
    // el título y su miniatura van juntos: los otros dos títulos quedan como alternativos
    project.video.title = t.titles[btn.dataset.k];
    project.video.alt_titles = t.titles.filter((x) => x !== project.video.title);
    project.thumbPick = n;
    $('#title').textContent = project.video.title;
    renderThumbs(); updateSteps(); save();
    toast('Título y miniatura elegidos');
  }
});

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ================= 5 · Publicar =================
function renderPublish() {
  const cc = status.capcut ?? {};
  $('#capcut').disabled = !cc.available;
  $('#capcut-hint').textContent = !cc.available ? 'CapCut: falta CapCutAPI en este ordenador.' : cc.deploy ? 'CapCut: el proyecto se mete solo en tu CapCut de escritorio (reinícialo para verlo) y además se descarga un ZIP.' : 'CapCut: se descarga un ZIP con el proyecto.';
  const shots = allShots();
  const missing = shots.filter((s) => !s.media).length;
  const flagged = shots.filter((s) => s.media?.check?.ok === false).length;
  const stale = staleVoice();
  const items = [
    [missing === 0, missing ? `Faltan ${missing} imágenes` : 'Todas las imágenes puestas', 'imagenes'],
    [flagged === 0, flagged ? `${flagged} imágenes con aviso (no encajan o tienen marca)` : 'Ninguna imagen con aviso', 'imagenes'],
    [!!project.voice && !stale, !project.voice ? 'Sin voz (el vídeo saldría mudo)' : stale ? `La voz de ${stale} partes está desactualizada` : 'Voz generada', 'voz'],
    [!!project.thumbs?.length, project.thumbs?.length ? 'Miniatura y título elegidos' : 'Sin miniatura', 'miniatura'],
  ];
  $('#checklist').innerHTML = items.map(([ok, text, go]) => `<li class="${ok ? 'ok' : 'todo'}"><span class="ic">${ok ? '✓' : '!'}</span>${esc(text)}${ok ? '' : `<button data-go="${go}">Arreglar</button>`}</li>`).join('');
  const v = project.video;
  const sites = [...new Set(shots.map((s) => s.media?.credit?.site).filter((x) => x && x !== 'propia'))];
  const desc = [v.description, v.sources?.length ? `Fuentes:\n${v.sources.map((s) => `- ${s.title}: ${s.url}`).join('\n')}` : '', sites.length ? `Imágenes: ${sites.join(', ')}` : ''].filter(Boolean).join('\n\n');
  const fields = [['Título', v.title], ['Descripción', desc], ['Etiquetas', (v.tags ?? []).join(', ')], ['Títulos alternativos', (v.alt_titles ?? []).join('\n')]];
  $('#pub').innerHTML = fields.map(([k, val], n) => `<div class="field"><div class="field-head"><span class="label">${k}</span><button data-copy="${n}">Copiar</button></div><pre>${esc(val)}</pre></div>`).join('');
  $('#pub').onclick = (e) => { if (e.target.dataset.copy) { navigator.clipboard.writeText(fields[e.target.dataset.copy][1]); toast('Copiado'); } };
}
$('#checklist').onclick = (e) => { if (e.target.dataset.go) setStep(e.target.dataset.go); };

$('#export').onclick = async () => {
  if (!canExportFast()) return toast('Este navegador no puede exportar: usa Chrome o Edge', 'bad');
  const missing = allShots().filter((s) => !s.media).length;
  const flagged = allShots().filter((s) => s.media?.check?.ok === false).length;
  if ((missing || flagged || !project.voice) && !(await ask({ title: '¿Exportar igualmente?', text: [missing && `Faltan ${missing} imágenes (saldrán en negro).`, flagged && `${flagged} imágenes tienen aviso.`, !project.voice && 'No hay voz: saldrá sin sonido.'].filter(Boolean).join(' '), ok: 'Exportar igualmente' }))) return;
  player.pause();
  runTask('Exportando el vídeo', async (ui) => {
    try {
      await preload(allShots().map((s) => s.media));
      let audio = null;
      if (mixer.hasVoice()) { ui.add('🎚️ Mezclando la voz…'); audio = await mixer.renderWav(player.tl, { voice: true }); }
      const res = await exportVideo({
        width: W, height: H, fps: 30, t0: 0, t1: player.tl.duration, audio, filename: slug(project.video.title), signal: ui.signal,
        renderFrame: async (ctx, t) => { await seekFor(player.tl, t); drawFrame(ctx, player.tl, t); },
        onProgress: (p, info) => {
          if (info.stage === 'video') { ui.progress(p); $('#task-now').textContent = `Creando el vídeo: ${Math.round(p * 100)} % · quedan unos ${Math.max(1, Math.ceil(info.eta / 60))} min`; }
          if (info.stage === 'mux') ui.add('🧩 Uniendo imagen y sonido…');
        },
      });
      project.exported = Date.now();
      downloadUrl(res.url, res.file);
      return `Vídeo exportado (${(res.bytes / 1048576).toFixed(0)} MB): se está descargando`;
    } finally { endExport(); player.render(); }
  });
};

// ---- abrir en CapCut: mismas imágenes, clips, transiciones y voz, para retocar allí ----
const CAPCUT_TR = { fade: 'Mix', dip: 'Black_Fade', zoom: 'Pull_in', whip: 'Horizontal_Blur', flash: 'White_Flash' };
const srtTime = (t) => { const ms = Math.round(t * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };

$('#capcut').onclick = async () => {
  if (!status.capcut?.available) return toast('Falta CapCutAPI en este ordenador (mira ⚙ Ajustes)', 'bad');
  const tl = player.tl;
  const shots = tl.scenes.filter((sc) => sc.scene.media).map((sc) => {
    const i = tl.scenes.indexOf(sc);
    const next = tl.scenes[i + 1];
    // en CapCut la transición va al final del plano anterior: la de entrada del siguiente
    const tr = next ? CAPCUT_TR[transitionOf(tl, i + 1)] ?? null : null;
    const m = sc.scene.media;
    return { url: m.url, type: m.type === 'video' ? 'video' : 'image', start: sc.start, end: sc.end, clip_dur: m.dur, transition: tr };
  });
  const missing = tl.scenes.length - shots.length;
  if (missing && !(await ask({ title: '¿Abrir en CapCut igualmente?', text: `Faltan ${missing} imágenes: quedarán huecos que puedes rellenar en CapCut.`, ok: 'Seguir' }))) return;
  const audio = project.voice ? project.video.segments.map((_, i) => (voiceSeg(i) && mixer.voice[i] ? { url: voiceSeg(i).url, start: tl.segments[i].start, dur: mixer.voice[i].duration } : null)).filter(Boolean) : [];
  const srt = $('#capcut-subs').checked ? tl.chunks.map((c, n) => `${n + 1}\n${srtTime(c.t0)} --> ${srtTime(c.t1)}\n${c.map((w) => w.text).join(' ')}\n`).join('\n') : null;
  runTask('Abriendo en CapCut', async (ui) => {
    ui.add(audio.length ? `🎙 Con la voz (${audio.length} partes)` : '🔇 Sin voz: genera la voz antes si la quieres en CapCut');
    const ev = await streamTo(ui, '/api/capcut', { projectId: project.id, name: slug(project.video.title), shots, audio, srt });
    downloadUrl(ev.data.zip, `${slug(project.video.title)}-capcut.zip`);
    return ev.data.deployed
      ? 'Listo en tu CapCut: reinícialo y aparece en Proyectos. También se descarga el ZIP.'
      : 'Proyecto de CapCut descargado (ZIP): descomprímelo en la carpeta de proyectos de CapCut.';
  });
};

// ================= clips de YouTube (a mano) =================
// el reproductor oficial de YouTube para elegir el momento; los picos del «más visto» ayudan a encontrar lo útil
let ytApi = null, ytPlayer = null, clipFor = null, clipTimer = null, ytOk = false;
const loadYT = () => (ytApi ??= new Promise((resolve) => {
  window.onYouTubeIframeAPIReady = resolve;
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
}));

function openClip(si, k) {
  const sc = player.tl.scenes.find((x) => x.seg === si && x.idx === k);
  clipFor = { si, k };
  $('#clip-q').value = project.video.segments[si].shots[k].query;
  $('#clip-dur').value = Math.min(12, Math.max(2, Math.ceil(((sc ? sc.end - sc.start : 4) + 0.8) * 2) / 2));
  $('#clip-view').hidden = true;
  $('#clip-dlg').showModal();
  $('#clip-search').click();
}
$('#clip-dlg').addEventListener('close', () => { clearInterval(clipTimer); ytPlayer?.destroy?.(); ytPlayer = null; });
$('#clip-q').onkeydown = (e) => { if (e.key === 'Enter') $('#clip-search').click(); };
$('#clip-search').onclick = async () => {
  const box = $('#clip-results');
  box.innerHTML = '<span class="hint">Buscando en YouTube…</span>';
  try {
    const { items } = await getJSON(`/api/clips/search?q=${encodeURIComponent($('#clip-q').value)}`);
    box.innerHTML = items.map((v, n) => `<div class="clip-item" data-n="${n}"><img src="${v.thumb}" referrerpolicy="no-referrer" /><b>${esc(v.title)}</b><small>${esc(v.channel)} · ${fmt(v.duration)}</small></div>`).join('') || '<span class="hint">Sin resultados</span>';
    box.onclick = (e) => {
      const el = e.target.closest('.clip-item');
      if (!el) return;
      $$('.clip-item').forEach((x) => x.classList.toggle('on', x === el));
      openVideo(items[el.dataset.n]);
    };
  } catch (e) { box.innerHTML = `<span class="hint">${esc(e.message)}</span>`; }
};

async function openVideo(v) {
  $('#clip-view').hidden = false;
  $('#clip-title').textContent = v.title;
  $('#clip-wrap').innerHTML = '<div id="yt"></div>';
  $('#clip-peaks').innerHTML = '<span class="hint">Buscando los momentos más vistos…</span>';
  $('#clip-start').value = 0;
  $('#clip-strip').innerHTML = '';
  clipFor.video = v;
  ytOk = false;
  await loadYT();
  ytPlayer?.destroy?.();
  ytPlayer = new YT.Player('yt', {
    videoId: v.id, width: '100%', height: '100%', playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
    events: { onReady: () => { ytOk = true; }, onError: () => { ytOk = false; } },
  });
  clearInterval(clipTimer);
  clipTimer = setInterval(() => { if (ytOk && document.activeElement !== $('#clip-start') && [1, 2, 3].includes(ytPlayer.getPlayerState?.())) $('#clip-start').value = ytPlayer.getCurrentTime().toFixed(1); }, 250);
  try {
    const info = await getJSON(`/api/clips/info?id=${v.id}`);
    const marks = [...info.peaks.map((p) => ({ t: p.t, label: `🔥 ${fmt(p.t)}`, title: `Momento muy visto (${p.value} %)` })), ...info.chapters.map((c) => ({ t: c.t, label: `${fmt(c.t)} ${c.title}`, title: 'Capítulo' }))];
    const sb = info.storyboard;
    $('#clip-strip').innerHTML = sb ? sb.tiles.map((x) => `<button class="tile" data-t="${x.t}" title="${fmt(x.t)}${x.heat >= 60 ? ' · muy visto' : ''}" style="width:${sb.w}px;height:${sb.h}px;background:url('${x.url}') -${x.x}px -${x.y}px"><i style="height:${Math.max(2, x.heat * 0.18)}px;opacity:${(0.25 + x.heat / 130).toFixed(2)}"></i><span>${fmt(x.t)}</span></button>`).join('') : '';
    $('#clip-peaks').innerHTML = marks.length ? marks.map((m) => `<button data-t="${m.t}" title="${esc(m.title)}">${esc(m.label)}</button>`).join('') : '<span class="hint">Este vídeo no tiene datos de «más visto»: usa la tira.</span>';
  } catch (e) { $('#clip-peaks').innerHTML = `<span class="hint">${esc(e.message)}</span>`; }
}

$('#clip-peaks').onclick = $('#clip-strip').onclick = (e) => {
  const b = e.target.closest('[data-t]');
  if (!b) return;
  const t = Number(b.dataset.t);
  $('#clip-strip .tile.on')?.classList.remove('on');
  $(`#clip-strip .tile[data-t="${t}"]`)?.classList.add('on');
  $('#clip-start').value = t;
  ytPlayer?.seekTo?.(t, true);
  ytPlayer?.playVideo?.();
};

$('#clip-use').onclick = async () => {
  const { si, k, video } = clipFor;
  if (!video) return toast('Elige primero un vídeo de la lista');
  const btn = $('#clip-use');
  btn.disabled = true;
  btn.textContent = 'Recortando…';
  ytPlayer?.pauseVideo?.();
  try {
    const media = await postJSON('/api/clips/cut', { projectId: project.id, id: video.id, start: Number($('#clip-start').value), dur: Number($('#clip-dur').value) });
    $('#clip-dlg').close();
    await setMedia(si, k, media);
    toast('Clip puesto');
  } catch (e) { toast(`No se pudo recortar: ${e.message}`, 'bad'); }
  finally { btn.disabled = false; btn.textContent = 'Usar este trozo'; }
};

// ================= ajustes =================
async function refreshStatus() {
  status = await getJSON('/api/status').catch(() => ({}));
  const ok = (b, yes, no) => `<li>${b ? '✅' : '⚠️'} ${b ? yes : no}</li>`;
  const ai = status.ai ?? {};
  const eng = (e, name, login) => (!e?.installed ? `${name} no está instalado` : e.loggedIn ? `${name} listo` : `${name} sin sesión (en una terminal: ${login})`);
  $('#engine').value = ai.engine ?? 'auto';
  const cs = { ...(status.creds ?? {}), elevenlabs: { configured: status.tts?.elevenlabs?.configured }, brave: { configured: status.brave?.configured } };
  for (const el of $$('.cred-st')) {
    const c = cs[el.dataset.cred];
    const eng = ai[el.dataset.cred === 'openai' ? 'codex' : el.dataset.cred];
    const session = !c?.configured && eng?.loggedIn;
    if (el.dataset.cred === 'openai' && /chatgpt/i.test(eng?.detail ?? '')) { el.textContent = '✓ con tu cuenta de ChatGPT'; el.classList.add('ok'); continue; }
    el.textContent = c?.configured ? `✓ guardada${c.source === 'entorno' ? ' (en .env)' : ''}` : session ? '✓ usando la sesión iniciada en este ordenador' : '· sin poner';
    el.classList.toggle('ok', !!(c?.configured || session));
  }
  if (document.activeElement !== $('#cred-capcut')) $('#cred-capcut').value = status.capcut?.drafts ?? '';
  $('#status-list').innerHTML = [
    ok(ai.claude?.loggedIn, eng(ai.claude, 'Claude Code', ''), eng(ai.claude, 'Claude Code', 'claude')),
    ok(ai.codex?.loggedIn, eng(ai.codex, 'Codex', ''), eng(ai.codex, 'Codex', 'codex login')),
    ok(status.tts?.elevenlabs?.configured, 'Voz (ElevenLabs) lista', 'Falta la clave de ElevenLabs'),
    ok(status.align?.available, 'Sincronización palabra a palabra lista', 'Sin sincronización fina (falta faster-whisper)'),
    ok(status.brave?.configured, 'Brave Search activo', 'Brave sin clave (se usan otros buscadores)'),
  ].join('');
}
$('#open-settings').onclick = () => { refreshStatus(); renderUsers(); $('#settings').showModal(); };
// Codex con la suscripción de ChatGPT: abre la página de OpenAI para entrar con tu cuenta (sin API key)
$('#codex-login').onclick = async () => {
  if (status.creds?.openai?.configured && !(await ask({ title: 'Usar tu cuenta de ChatGPT', text: 'Se quitará la API key de OpenAI guardada, porque si está puesta Codex la usa en lugar de tu suscripción.', ok: 'Seguir' }))) return;
  $('#settings').close();
  // la pestaña se abre YA (en el mismo clic); si se abriera al llegar el enlace, el navegador la bloquearía
  const tab = window.open('', '_blank');
  tab?.document.write('<title>OpenAI</title><body style="font:18px system-ui;background:#0e1012;color:#eee;display:grid;place-items:center;height:90vh">Conectando con OpenAI…</body>');
  const ok = await runTask('Iniciar sesión con ChatGPT', async (ui) => {
    await streamTo(ui, '/api/codex/login', {}, (e) => {
      if (!e.url) return;
      if (tab && !tab.closed) tab.location.href = e.url; else window.open(e.url, '_blank');
      $('#task-now').innerHTML = e.code
        ? `1. <a href="${esc(e.url)}" target="_blank" rel="noopener">Abre la página de OpenAI</a> y entra con tu cuenta de ChatGPT.<br>2. Escribe este código: <b class="big-code">${esc(e.code)}</b>`
        : `Entra con tu cuenta de ChatGPT en la página de OpenAI y autoriza a Codex. <a href="${esc(e.url)}" target="_blank" rel="noopener">Abrir la página</a>`;
    });
    await refreshStatus();
    return 'Codex ya usa tu cuenta de ChatGPT. En ⚙ Ajustes puedes elegir «Solo Codex» o dejarlo en Automático.';
  });
  try { if (!ok && tab && !tab.closed && tab.location.href === 'about:blank') tab.close(); } catch {} // ya en OpenAI: se deja
};
$('#clear-openai').onclick = async () => {
  try { await postJSON('/api/credentials/clear', { id: 'openai' }); await refreshStatus(); toast('API key de OpenAI quitada', 'ok'); }
  catch (e) { toast(e.message, 'bad'); }
};
$('#engine').onchange = async (e) => {
  try { await postJSON('/api/engine', { engine: e.target.value }); toast(`Motor: ${e.target.selectedOptions[0].textContent}`, 'ok'); refreshStatus(); }
  catch (err) { toast(err.message, 'bad'); }
};
$('#save-keys').onclick = async () => {
  const v = (id) => $(`#cred-${id}`).value.trim();
  try {
    await postJSON('/api/credentials', { claude: v('claude'), openai: v('openai'), elevenlabs: v('elevenlabs'), brave: v('brave'), capcutDrafts: v('capcut') });
    for (const id of ['claude', 'openai', 'elevenlabs', 'brave']) $(`#cred-${id}`).value = '';
    voiceList = null;
    await refreshStatus();
    toast('Guardado', 'ok');
  } catch (e) { toast(`No se pudo guardar: ${e.message}`, 'bad'); }
};

// la dirección manda: #proyecto/paso (al escribirla a mano o con atrás/adelante)
addEventListener('hashchange', () => {
  const [id, st] = location.hash.slice(1).split('/');
  if (!id) return showHome();
  if (project?.id === id) return setStep(st);
  getJSON(`/api/projects/${id}`).then((p) => openProject(p, st)).catch(showHome);
});

// ================= sesión, contraseña y usuarios =================
let me = null;
$('#logout').onclick = async () => { if (project) await saveNow(); await postJSON('/api/logout', {}); location.replace('/login'); };

$('#pw-save').onclick = async () => {
  const next = $('#pw-next').value;
  if (next !== $('#pw-repeat').value) return toast('Las contraseñas nuevas no coinciden', 'bad');
  try {
    await postJSON('/api/password', { current: $('#pw-current').value, next });
    for (const id of ['pw-current', 'pw-next', 'pw-repeat']) $(`#${id}`).value = '';
    toast('Contraseña cambiada. Se cerraron tus otras sesiones.', 'ok');
  } catch (e) { toast(e.data?.error || e.message, 'bad'); }
};

async function renderUsers() {
  if (!me?.isAdmin) return;
  const users = await getJSON('/api/users');
  $('#users').innerHTML = users.map((u) => `<li>👤 <b>${esc(u.username)}</b>${u.is_admin ? ' <span class="pill">admin</span>' : ''}${u.id === me.id ? ' <span class="hint">(tú)</span>' : `<button class="danger" data-del-user="${u.id}">Borrar</button>`}</li>`).join('');
}
$('#users').onclick = async (e) => {
  const id = e.target.dataset.delUser;
  if (!id) return;
  const name = e.target.closest('li').querySelector('b').textContent;
  if (!(await ask({ title: `¿Borrar a «${name}»?`, text: 'No podrá volver a entrar. Los vídeos se quedan.', ok: 'Borrar', danger: true }))) return;
  await fetch(`/api/users/${id}`, { method: 'DELETE' });
  renderUsers();
};
$('#nu-add').onclick = async () => {
  try {
    await postJSON('/api/users', { username: $('#nu-name').value, password: $('#nu-pass').value, isAdmin: $('#nu-admin').checked });
    toast(`Usuario «${$('#nu-name').value.trim().toLowerCase()}» creado`, 'ok');
    $('#nu-name').value = $('#nu-pass').value = ''; $('#nu-admin').checked = false;
    renderUsers();
  } catch (e) { toast(e.data?.error || e.message, 'bad'); }
};

// ================= arranque =================
// todo a la vez: el servidor está lejos y cada petición en serie suma medio segundo
const statusReady = refreshStatus();
const [hashId, hashStep] = location.hash.slice(1).split('/');
const opening = hashId && getJSON(`/api/projects/${hashId}`);
me = await getJSON('/api/me');
$('#me').textContent = `👤 ${me.username}`;
$('#admin-only').hidden = !me.isAdmin;
if (opening) Promise.all([opening, statusReady]).then(([p]) => openProject(p, hashStep)).catch(showHome);
else showHome();
