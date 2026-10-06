import { getJSON, postJSON, stream } from './api.js';
import { Player, buildTimeline, segmentAt, sceneAt, wordAt, sectionColor, DEFAULT_WPM } from './engine/timeline.js';
import { SCENE_TYPES, SCENE_TEMPLATES } from './engine/scenes.js';
import { ICON_NAMES } from './engine/draw.js';
import { drawThumb, thumbToPNG, THUMB_DEFAULT } from './engine/thumbnail.js';
import { Teleprompter, Recorder, extOf } from './teleprompter.js';
import { drawShort, sentencesOf, clipRange, SW, SH } from './engine/shorts.js';
import { Mixer, DEFAULT_MIX, DENSITY, sfxEvents } from './engine/audio.js';

// ---------- utilidades ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
const debounce = (fn, ms) => { let id; return (...a) => { clearTimeout(id); id = setTimeout(() => fn(...a), ms); }; };
const typing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.id);
  toast.id = setTimeout(() => { el.hidden = true; }, ms);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------- estado ----------
const state = {
  project: null,
  seg: 0,
  scene: 0,
  topics: store.get('topics', []),
  thumbIdx: 0,
  pendingTopic: null,
  recording: null,
};

const canvas = document.createElement('canvas');
const player = new Player(canvas);
const tp = new Teleprompter($('#prompter'), $('#prompter-inner'));
const mixer = new Mixer();
player.setMixer(mixer);

// ---------- motor (panel de Claude Code en vivo) ----------
let job = null;
async function runJob(title, url, body) {
  if (job) { toast('Ya hay una tarea en marcha'); throw new Error('busy'); }
  const panel = $('#engine');
  const log = $('#engine-log');
  panel.hidden = false;
  panel.classList.remove('done', 'fail', 'min');
  $('#engine-title').textContent = title;
  log.innerHTML = '';
  const add = (text, cls = '') => {
    const li = document.createElement('li');
    li.textContent = text;
    if (cls) li.className = cls;
    log.appendChild(li);
    log.scrollTop = log.scrollHeight;
  };
  const ctrl = new AbortController();
  const t0 = Date.now();
  const timer = setInterval(() => { $('#engine-elapsed').textContent = `${Math.floor((Date.now() - t0) / 1000)} s`; }, 500);
  job = ctrl;
  $('#engine-cancel').textContent = 'Cancelar';
  $('#engine-cancel').onclick = () => ctrl.abort();
  add('▶ Lanzando Claude Code…');
  try {
    const res = await stream(url, body, (ev) => {
      if (ev.type === 'log') add(ev.text);
      else if (ev.type === 'text') add(ev.text, 'text');
      else if (ev.type === 'error') add(`✖ ${ev.message}`, 'bad');
    }, ctrl.signal);
    add(`✔ Hecho en ${res.secs ?? Math.round((Date.now() - t0) / 1000)} s${res.cost ? ` · ${res.cost.toFixed(2)} $ equivalentes` : ''}`, 'ok');
    panel.classList.add('done');
    setTimeout(() => { if (!job) panel.classList.add('min'); }, 2500);
    return res.data;
  } catch (e) {
    panel.classList.add('fail');
    add(ctrl.signal.aborted ? '■ Cancelado' : `✖ ${e.message}`, 'bad');
    throw e;
  } finally {
    clearInterval(timer);
    job = null;
    $('#engine-cancel').textContent = 'Cerrar';
    $('#engine-cancel').onclick = () => { if (!job) $('#engine').hidden = true; };
  }
}
$('#engine-min').onclick = () => $('#engine').classList.toggle('min');

// ---------- router ----------
function route() {
  const name = (location.hash || '#descubrir').slice(1);
  $$('.view').forEach((v) => v.classList.toggle('on', v.dataset.view === name));
  $$('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === name));
  if (name !== 'teleprompter' && state.recording) stopTake();
  if (name === 'estudio') { $('#stage-studio').appendChild(canvas); player.rate = Number($('#rate').value); }
  if (name === 'teleprompter') enterPrompter();
  if (name === 'miniatura') renderThumbView();
  if (name === 'estilo') loadStyle();
  if (name === 'proyectos') loadProjects();
  if (name === 'publicar') { renderPublish(); renderShorts(); }
  window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', route);

// ---------- estado de Claude Code ----------
getJSON('/api/health').then((h) => {
  $('#status').classList.add(h.ok ? 'ok' : 'bad');
  $('#status-text').textContent = h.ok ? `Claude Code ${h.claude.split(' ')[0]}` : 'Claude Code no encontrado';
}).catch(() => { $('#status').classList.add('bad'); $('#status-text').textContent = 'Servidor no disponible'; });

// ---------- 01 · DESCUBRIR ----------
function animateHero() {
  const h = $('#hero-title');
  let k = 0;
  const wrap = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        // una caja sin saltos por palabra, para que el titular nunca se corte a mitad de palabra
        const frag = document.createDocumentFragment();
        child.textContent.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(' ')); return; }
          const word = document.createElement('span');
          word.className = 'word';
          for (const ch of part) {
            const s = document.createElement('span');
            s.className = 'ch';
            s.textContent = ch;
            s.style.animationDelay = `${k++ * 28}ms`;
            word.appendChild(s);
          }
          frag.appendChild(word);
        });
        child.replaceWith(frag);
      } else wrap(child);
    }
  };
  wrap(h);
}

$('#topic-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = Object.fromEntries(f);
  body.count = Number(body.count);
  store.set('variant', body.variant);
  try {
    const data = await runJob('Buscando temas nuevos', '/api/topics', body);
    state.topics = data.topics ?? [];
    store.set('topics', state.topics);
    renderTopics();
    toast(`${state.topics.length} temas encontrados`);
  } catch {}
});

$('#own-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = new FormData(e.target).get('title').trim();
  if (!title) return;
  openScriptDialog({ title, hook: '', why_now: '', key_facts: [], sources: [] });
});

function renderTopics() {
  const box = $('#topics');
  box.innerHTML = '';
  state.topics.forEach((tpc, i) => {
    const s = tpc.score ?? {};
    const el = document.createElement('article');
    el.className = 'topic';
    el.style.animationDelay = `${i * 70}ms`;
    el.innerHTML = `
      <canvas width="640" height="360"></canvas>
      <div class="body">
        <div class="meta">
          <div class="score"><div class="ring" style="--p:${Math.round(s.total ?? 0)}">${Math.round(s.total ?? 0)}</div>
            <div class="bars">
              <span>Demanda</span><i><b style="width:${s.demand ?? 0}%"></b></i>
              <span>Novedad</span><i><b style="width:${s.novelty ?? 0}%;background:var(--yellow)"></b></i>
              <span>Encaje</span><i><b style="width:${s.fit ?? 0}%;background:var(--green)"></b></i>
            </div>
          </div>
          <div class="spacer"></div>
          <span class="pill y">${esc(tpc.formula || 'tema')}</span>
        </div>
        <h3>${esc(tpc.title)}</h3>
        <p class="hook">${esc(tpc.hook)}</p>
        <p class="why">${esc(tpc.why_now)}</p>
        <details><summary>Datos clave y fuentes</summary>
          <ul>${(tpc.key_facts ?? []).map((k) => `<li>${esc(k)}</li>`).join('')}</ul>
          <ul>${(tpc.sources ?? []).map((src) => `<li><a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.title)}</a></li>`).join('')}</ul>
        </details>
        <div class="actions">
          <button class="btn primary small" data-act="make">Crear vídeo <span class="arrow">→</span></button>
          <button class="btn ghost small" data-act="copy">Copiar título</button>
        </div>
      </div>`;
    drawThumb(el.querySelector('canvas').getContext('2d'), tpc.thumbnail ?? THUMB_DEFAULT);
    el.querySelector('[data-act=make]').onclick = () => openScriptDialog(tpc);
    el.querySelector('[data-act=copy]').onclick = () => { navigator.clipboard.writeText(tpc.title); toast('Título copiado'); };
    box.appendChild(el);
  });
}

// ---------- diálogo "nuevo vídeo" ----------
function openScriptDialog(topic) {
  state.pendingTopic = topic;
  const form = $('#script-form');
  $('#sd-title').textContent = topic.title;
  form.elements.title.value = topic.title;
  form.elements.variant.value = store.get('variant', 'es-ES');
  form.elements.channel.value = store.get('channel', 'bramenn');
  $('#script-dialog').showModal();
}
$("#script-form").elements.minutes.addEventListener('input', (e) => { $('#sd-min-val').textContent = e.target.value; });
$('#script-dialog').addEventListener('close', async () => {
  if ($('#script-dialog').returnValue !== 'ok') return;
  const f = Object.fromEntries(new FormData($('#script-form')));
  const topic = { ...state.pendingTopic, title: f.title };
  store.set('channel', f.channel);
  store.set('variant', f.variant);
  try {
    const video = await runJob(`Escribiendo: ${topic.title}`, '/api/script', {
      topic, minutes: Number(f.minutes), notes: f.notes, model: f.model, effort: f.effort, channel: f.channel, variant: f.variant,
    });
    const project = {
      id: `${new Date().toISOString().slice(0, 10)}-${slug(video.title || topic.title)}`,
      topic, video, created: Date.now(),
      settings: { wpm: DEFAULT_WPM, theme: 'infografia', captions: false, channel: f.channel, variant: f.variant },
    };
    await saveProject(project);
    openProject(project);
    location.hash = '#estudio';
    toast('Guion listo. Revísalo y pasa al teleprompter.');
  } catch {}
});

// ---------- 02 · ESTUDIO ----------
const saveSoon = debounce(() => state.project && saveProject(state.project, true), 1200);

async function saveProject(p, quiet = false) {
  try {
    const r = await postJSON('/api/projects', p);
    p.id = r.id;
    if (!quiet) toast('Proyecto guardado');
  } catch (e) { toast(`No se pudo guardar: ${e.message}`); }
}

function openProject(p) {
  p.settings = { wpm: DEFAULT_WPM, theme: 'infografia', captions: false, channel: 'bramenn', ...(p.settings ?? {}) };
  state.project = p;
  state.seg = 0;
  state.scene = 0;
  state.thumbIdx = 0;
  $('#studio-empty').hidden = true;
  $('#studio').hidden = false;
  $('#wpm').value = p.settings.wpm;
  $('#captions').checked = p.settings.captions;
  $('#callouts').checked = p.settings.callouts !== false;
  $$('#theme-toggle button').forEach((b) => b.classList.toggle('on', b.dataset.theme === p.settings.theme));
  player.setOpts({ captions: p.settings.captions, callouts: p.settings.callouts !== false, theme: p.settings.theme, channel: p.settings.channel });
  player.seek(0);
  mixer.clearVoice();
  state.voiceDur = null;
  mixer.setMix({ ...DEFAULT_MIX, ...(p.sound ?? {}), monitor: true, breathDb: DEFAULT_MIX.breathDb });
  syncSoundBar();
  rebuild();
  if (p.voice?.segments?.length) loadVoice().catch((e) => toast(`No se pudo cargar la voz IA: ${e.message}`));
  fillTitles();
  fillMeta();
  selectSegment(0);
}

function rebuild() {
  if (!state.project) return;
  const segAlign = voiceAlignments();
  mixer.setVoiceWords(segAlign);
  player.load(state.project.video, { wpm: Number(state.project.settings.wpm) || DEFAULT_WPM, segDurations: voiceDurations(), segAlign });
  updateVoiceBadge();
  updatePace();
  renderSegSteps();
  renderTimelineStrip();
  tp.render(player.tl);
}
const rebuildSoon = debounce(() => {
  rebuild();
  if (state.project && repairCues(state.seg)) rebuild(); // anclas movidas por la edición → se recolocan solas
  saveSoon();
}, 450);

/** Densidad didáctica de un texto: longitud de frases y cifras por cada 100 palabras. */
function didactic(text) {
  const clean = String(text ?? '').replace(/\*/g, '');
  const sentences = clean.split(/(?<=[.?!…])\s+|\n+/).map((x) => x.trim()).filter((x) => x.split(/\s+/).length > 1);
  const words = clean.split(/\s+/).filter(Boolean).length;
  const lens = sentences.map((x) => x.split(/\s+/).length);
  const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const longest = Math.max(0, ...lens);
  const numbers = (clean.match(/\d+(?:[.,]\d+)*/g) ?? []).length;
  const per100 = words ? (numbers / words) * 100 : 0;
  const issues = [];
  if (avg > 18) issues.push('frases largas');
  if (longest > 28) issues.push(`una frase de ${longest} palabras`);
  if (per100 > 4) issues.push('demasiadas cifras');
  return { avg, longest, per100, issues };
}

function showDidactic() {
  const seg = state.project?.video.segments[state.seg];
  if (!seg) return;
  const d = didactic(seg.narration);
  const el = $('#seg-didactic');
  el.className = `didactic${d.issues.length ? ' warn' : ''}`;
  el.innerHTML = `Didáctica: frase media <b>${d.avg.toFixed(0)}</b> pal. · más larga <b>${d.longest}</b> · <b>${d.per100.toFixed(1)}</b> cifras/100 pal.`
    + (d.issues.length ? ` → ${d.issues.join(', ')}: prueba «Más didáctico»` : ' ✓');
}

/** Tramo más quieto dentro de un segmento (escenas, elementos y rótulos). */
function segmentStill(i) {
  const tl = player.tl;
  const seg = tl.segments[i];
  if (!seg) return 0;
  const ev = [
    ...tl.scenes.filter((x) => x.seg === i).flatMap((x) => [x.start, ...x.itemTimes.filter((y) => y != null).map((y) => x.start + y)]),
    ...(tl.callouts ?? []).filter((c) => c.seg === i && !c.redundant).map((c) => c.t0),
    seg.end,
  ].filter((x) => x >= seg.start - 0.01 && x <= seg.end).sort((a, b) => a - b);
  let g = 0;
  for (let k = 1; k < ev.length; k++) g = Math.max(g, ev[k] - ev[k - 1]);
  return g;
}

/** Estado de los tres pasos de un segmento. */
function segStatus(i) {
  const seg = state.project.video.segments[i];
  const d = didactic(seg.narration);
  const still = segmentStill(i);
  const scenes = seg.scenes?.length ?? 0;
  const synced = (seg.scenes ?? []).reduce((a, sc) => a + (sc.items ?? []).filter((it) => it.cue).length, 0) + Math.max(0, scenes - 1);
  const v = voiceOf();
  const vs = v?.segments.find((x) => x.index === i);
  const voice = !vs ? 'todo' : staleSegments().includes(i) || voiceHealth(i)?.broken ? 'warn' : 'ok';
  return { d, still, scenes, synced, voice, words: seg.narration.split(/\s+/).filter(Boolean).length };
}

function renderSegSteps() {
  const box = $('#seg-steps');
  if (!state.project || !box) return;
  const i = state.seg;
  const st = segStatus(i);
  const v = voiceOf();
  const tlSeg = player.tl.segments[i];
  const animState = st.still > 6.5 ? 'warn' : 'ok';
  const sync = syncState(i);
  const sus = suspiciousWords(i);
  box.innerHTML = `
    <div class="step sync ${sync.ok ? 'ok' : 'warn'}"><i>⟳</i><div><b>${sync.ok ? 'Sincronizado' : 'Desincronizado'}</b><small>${sync.ok ? 'guion, voz y animación coinciden' : sync.issues.join(' · ')}</small></div>
      <div class="acts">${sync.ok ? '' : '<button class="btn small" data-step="sync">Sincronizar segmento</button>'}</div></div>
    <div class="step ${st.d.issues.length ? 'warn' : 'ok'}"><i>①</i><div><b>Guion</b><small>${st.words} palabras · ${st.d.issues.length ? st.d.issues.join(', ') : 'didáctica ✓'}</small></div>
      <div class="acts"><button class="btn small ghost" data-step="didactic">Más didáctico</button><button class="btn small ghost" data-step="rewrite">Reescribir…</button></div></div>
    <div class="step ${animState}"><i>②</i><div><b>Animación</b><small>${st.scenes} escenas · ${st.synced} momentos sincronizados con la voz · quieto como máximo ${st.still.toFixed(1)} s${animState === 'warn' ? ' → anímalo' : ''}</small></div>
      <div class="acts"><button class="btn small ${animState === 'warn' ? '' : 'ghost'}" data-step="animate">Animar este segmento</button><button class="btn small ghost" data-step="watch">▶ Ver</button></div></div>
    <div class="step ${st.voice}"><i>③</i><div><b>Voz</b><small>${voiceHealth(i)?.broken ? (() => { const h = voiceHealth(i); return `⚠️ la voz falló: dice ${h.heard} de ${h.expectedWords} palabras y dura ${h.dur.toFixed(0)} s (se atascó o emitió sonidos sin palabras) → Regenerar`; })() : !v?.voiceId ? 'sin voz elegida' : st.voice === 'todo' ? `sin generar · ${esc(v.voiceTitle || PROVIDER_UI[v.provider]?.name || 'voz IA')}` : st.voice === 'warn' ? 'desactualizada (cambió el texto o la voz)' : `al día · ${esc(v.voiceTitle || PROVIDER_UI[v.provider]?.name || 'voz IA')} · ${tlSeg ? (tlSeg.end - tlSeg.start).toFixed(1) : '?'} s · ${tlSeg?.align ? 'sincronizada palabra a palabra ✓' : 'tiempos estimados'}`}</small></div>
      ${sus.length ? `<div class="sus">Puede que suene mal: ${sus.map((x) => `<button type="button" data-at="${x.s}" title="Escuchar ese momento">«${esc(x.w)}» ${x.s.toFixed(0)} s</button>`).join(' ')} <small>→ corrígelo en Voz IA → Pronunciación y regenera</small></div>` : ''}
      <div class="acts">${v?.voiceId ? `<button class="btn small ${st.voice === 'ok' ? 'ghost' : ''}" data-step="voice">${st.voice === 'ok' ? 'Regenerar voz' : 'Generar voz'}</button>` : '<button class="btn small" data-step="pickvoice">Elegir voz…</button>'}${st.voice !== 'todo' ? '<button class="btn small ghost" data-step="listen">▶ Escuchar</button>' : ''}${sus.length && (v?.settings?.temperature ?? 0.7) > 0.8 ? '<button class="btn small" data-step="calm" title="Con expresividad alta el modelo inventa titubeos y sonidos raros. Esto la baja a 0,6 para toda la voz del proyecto y regenera este segmento.">Regenerar con expresividad 0,6</button>' : ''}</div></div>`;
  box.querySelector('[data-step=sync]')?.addEventListener('click', () => syncSegments([i]));
  box.querySelector('[data-step=calm]')?.addEventListener('click', async () => {
    const choice = currentVoiceChoice();
    if (!choice) return;
    choice.settings = { ...choice.settings, temperature: 0.6 };
    const prefs = ttsPrefs();
    store.set('ttsPrefs', { ...prefs, [choice.provider]: { ...(prefs[choice.provider] ?? {}), voiceId: choice.voiceId, voiceTitle: choice.voiceTitle, settings: choice.settings } });
    try {
      await generateVoice([i], choice, { force: [i] });
      playSegment(i);
      const rest = (voiceOf()?.segments ?? []).filter((x) => x.index !== i).length;
      if (rest) toast(`Segmento ${i + 1} regenerado con expresividad 0,6. Los otros ${rest} siguen con la anterior: cuando te guste, «Sincronizar todo» los regenera igual.`, 7000);
    } catch {}
  });
  box.querySelectorAll('[data-at]').forEach((b) => { b.onclick = () => { const seg = player.tl.segments[i]; player.pause(); player.seek(seg.start + Math.max(0, Number(b.dataset.at) - 1.2)); state.stopAt = seg.start + Number(b.dataset.at) + 2; player.play(); }; });
  box.querySelector('[data-step=didactic]').onclick = () => $('#refine-didactic').click();
  box.querySelector('[data-step=rewrite]').onclick = () => $('#refine-instruction').focus();
  box.querySelector('[data-step=animate]').onclick = () => animateSegments([i]);
  box.querySelector('[data-step=watch]').onclick = () => playSegment(i);
  box.querySelector('[data-step=listen]')?.addEventListener('click', () => playSegment(i));
  box.querySelector('[data-step=pickvoice]')?.addEventListener('click', () => $('#open-voice').click());
  box.querySelector('[data-step=voice]')?.addEventListener('click', async () => {
    const choice = currentVoiceChoice();
    if (!choice) return $('#open-voice').click();
    try { await generateVoice([i], choice); playSegment(i); } catch {}
  });
}

/** Reproduce solo un segmento y se para al terminar. */
function playSegment(i) {
  const seg = player.tl.segments[i];
  if (!seg) return;
  player.pause();
  player.seek(seg.start + 0.01);
  state.stopAt = seg.end;
  player.play();
}

/** Claude Code reanima solo estos segmentos (no toca la narración). */
async function animateSegments(indices) {
  const before = indices.map(segmentStill);
  try {
    const data = await runJob(indices.length === 1 ? `Animando el segmento ${indices[0] + 1}` : `Animando ${indices.length} segmentos`, '/api/densify', {
      video: state.project.video, indices, variant: state.project.settings.variant,
    });
    for (const seg of data.segments ?? []) {
      const target = state.project.video.segments[seg.index];
      if (target && seg.scenes?.length && indices.includes(seg.index)) target.scenes = seg.scenes;
    }
    rebuild();
    selectSegment(state.seg);
    saveSoon();
    const after = indices.map(segmentStill);
    toast(`Animado · quieto máx: ${Math.max(...before).toFixed(1)} s → ${Math.max(...after).toFixed(1)} s`);
    if (indices.length === 1) playSegment(indices[0]);
  } catch {}
}

/** Ritmo visual: cada cuánto cambia algo en pantalla y el tramo más largo quieto (clic = ir ahí). */
function updatePace() {
  const pace = player.tl.pace;
  const el = $('#pace');
  if (!pace) { el.textContent = ''; return; }
  const g = pace.longest.gap;
  el.className = `pace ${g > 10 ? 'bad' : g > 6.5 ? 'warn' : ''}`;
  el.innerHTML = `Ritmo visual: un cambio cada <b>${pace.every.toFixed(1)} s</b> · tramo más quieto <b>${g.toFixed(1)} s</b> en ${fmt(pace.longest.at)}${g > 6.5 ? ' → pulsa «Más animación»' : ''}`;
  const dense = state.project ? state.project.video.segments.filter((sg) => didactic(sg.narration).issues.length).length : 0;
  if (dense) el.innerHTML += ` · <b>${dense}</b> segmentos demasiado densos`;
  el.onclick = () => { player.seek(pace.longest.at + 0.05); selectSegment(segmentAt(player.tl, player.t), 0, false); };
}

function fillTitles() {
  const v = state.project.video;
  const sel = $('#title-select');
  const titles = [v.title, ...(v.alt_titles ?? [])].filter((x, i, a) => x && a.indexOf(x) === i);
  sel.innerHTML = titles.map((t) => `<option>${esc(t)}</option>`).join('');
  sel.value = v.title;
}
$('#title-select').onchange = (e) => { state.project.video.title = e.target.value; saveSoon(); };

function fillMeta() {
  const v = state.project.video;
  $('#meta-desc').value = v.description ?? '';
  $('#meta-tags').value = (v.tags ?? []).join(', ');
  $('#meta-sources').innerHTML = (v.sources ?? []).map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join('') || '<li class="muted">Sin fuentes</li>';
}
$('#meta-desc').oninput = (e) => { state.project.video.description = e.target.value; saveSoon(); };
$('#meta-tags').oninput = (e) => { state.project.video.tags = e.target.value.split(',').map((s) => s.trim()).filter(Boolean); saveSoon(); };

function renderTimelineStrip() {
  const box = $('#timeline');
  const tl = player.tl;
  box.innerHTML = '';
  tl.segments.forEach((seg) => {
    const el = document.createElement('div');
    el.className = 'seg' + (seg.index === state.seg ? ' sel' : '');
    el.style.flex = `${seg.end - seg.start} 0 0`;
    el.style.setProperty('--c', sectionColor(seg.section));
    el.innerHTML = `<span>${String(seg.index + 1).padStart(2, '0')} ${esc(seg.section)}</span>`;
    if (state.project?.video.segments[seg.index]) {
      const st = segStatus(seg.index);
      const sy = syncState(seg.index);
      el.insertAdjacentHTML('beforeend', `<span class="marks" title="Animación · Voz · Sincronía"><i class="${st.still > 6.5 ? 'warn' : 'ok'}"></i><i class="${st.voice === 'todo' ? '' : st.voice}"></i><i class="${sy.ok ? 'ok' : 'warn'}"></i></span>`);
    }
    tl.scenes.filter((s) => s.seg === seg.index).forEach((s) => {
      const tick = document.createElement('i');
      tick.className = 'tick' + (seg.index === state.seg && s.idx === state.scene ? ' sel' : '');
      tick.style.left = `${((s.start - seg.start) / (seg.end - seg.start)) * 100}%`;
      tick.title = s.scene.type;
      el.appendChild(tick);
    });
    box.appendChild(el);
  });
  const head = document.createElement('div');
  head.className = 'head';
  head.id = 'tl-head';
  box.appendChild(head);
}

$('#timeline').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const t = ((e.clientX - r.left) / r.width) * player.tl.duration;
  player.seek(t);
  const si = segmentAt(player.tl, t);
  const sc = player.tl.scenes[sceneAt(player.tl, t)];
  selectSegment(si, sc?.seg === si ? sc.idx : 0, false);
});

function selectSegment(i, sceneIdx = 0, seek = true) {
  const segs = state.project?.video.segments ?? [];
  if (!segs.length) return;
  state.seg = Math.max(0, Math.min(i, segs.length - 1));
  state.scene = sceneIdx;
  const seg = segs[state.seg];
  const tlSeg = player.tl.segments[state.seg];
  $('#seg-index').textContent = String(state.seg + 1).padStart(2, '0');
  $('#seg-section').value = seg.section;
  if (document.activeElement !== $('#seg-narration')) $('#seg-narration').value = seg.narration ?? '';
  $('#seg-dur').textContent = tlSeg ? `${Math.round(tlSeg.end - tlSeg.start)} s · ${tlSeg.words.length} palabras` : '';
  if (seek && tlSeg) player.seek(tlSeg.start + 0.01);
  showDidactic();
  renderSegSteps();
  $$('#timeline .seg').forEach((el, k) => el.classList.toggle('sel', k === state.seg));
  renderSceneEditor();
}

function renderSceneEditor() {
  const seg = state.project.video.segments[state.seg];
  seg.scenes = seg.scenes?.length ? seg.scenes : [{ type: 'title', cue: '', ...SCENE_TEMPLATES.title }];
  state.scene = Math.min(state.scene, seg.scenes.length - 1);
  $('#scene-chips').innerHTML = seg.scenes.map((s, k) => `<button data-k="${k}" class="${k === state.scene ? 'on' : ''}">${k + 1} · ${esc(s.type)}</button>`).join('');
  $$('#scene-chips button').forEach((b) => { b.onclick = () => { state.scene = Number(b.dataset.k); seekScene(); renderSceneEditor(); }; });
  const sc = seg.scenes[state.scene];
  $('#scene-type').value = sc.type;
  $('#scene-cue').value = sc.cue ?? '';
  const { type, cue, ...props } = sc;
  if (document.activeElement !== $('#scene-props')) $('#scene-props').value = JSON.stringify(props, null, 2);
  $('#scene-err').textContent = '';
  $$('#timeline .tick').forEach((el) => el.classList.remove('sel'));
  const ticks = $$('#timeline .seg')[state.seg]?.querySelectorAll('.tick');
  ticks?.[state.scene]?.classList.add('sel');
}

function seekScene() {
  const s = player.tl.scenes.find((x) => x.seg === state.seg && x.idx === state.scene);
  if (s) player.seek(s.start + Math.min(1.6, (s.end - s.start) * 0.5));
}

$('#scene-type').innerHTML = SCENE_TYPES.map((t) => `<option>${t}</option>`).join('');
$('#seg-narration').addEventListener('input', (e) => { state.project.video.segments[state.seg].narration = e.target.value; showDidactic(); rebuildSoon(); });
$('#seg-section').addEventListener('change', (e) => { state.project.video.segments[state.seg].section = e.target.value; rebuild(); saveSoon(); });
$('#scene-type').addEventListener('change', (e) => {
  const seg = state.project.video.segments[state.seg];
  const cur = seg.scenes[state.scene];
  seg.scenes[state.scene] = { type: e.target.value, cue: cur.cue ?? '', ...structuredClone(SCENE_TEMPLATES[e.target.value] ?? {}) };
  $('#scene-props').blur();
  renderSceneEditor(); rebuild(); seekScene(); saveSoon();
});
$('#scene-cue').addEventListener('change', (e) => { state.project.video.segments[state.seg].scenes[state.scene].cue = e.target.value; rebuild(); seekScene(); saveSoon(); });
$('#scene-apply').onclick = () => {
  try {
    const props = JSON.parse($('#scene-props').value || '{}');
    const seg = state.project.video.segments[state.seg];
    seg.scenes[state.scene] = { type: $('#scene-type').value, cue: $('#scene-cue').value, ...props };
    $('#scene-props').blur();
    rebuild(); renderSceneEditor(); seekScene(); saveSoon();
  } catch (err) { $('#scene-err').textContent = `JSON no válido: ${err.message}`; }
};
$('#scene-props').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') $('#scene-apply').click(); });
$('#scene-template').onclick = () => { $('#scene-props').value = JSON.stringify(SCENE_TEMPLATES[$('#scene-type').value] ?? {}, null, 2); };
$('#scene-add').onclick = () => {
  const seg = state.project.video.segments[state.seg];
  seg.scenes.splice(state.scene + 1, 0, { type: 'title', cue: '', ...structuredClone(SCENE_TEMPLATES.title) });
  state.scene++;
  rebuild(); renderSceneEditor(); saveSoon();
};
$('#scene-del').onclick = () => {
  const seg = state.project.video.segments[state.seg];
  if (seg.scenes.length <= 1) return toast('Un segmento necesita al menos una escena');
  seg.scenes.splice(state.scene, 1);
  state.scene = Math.max(0, state.scene - 1);
  rebuild(); renderSceneEditor(); saveSoon();
};
$('#seg-add').onclick = () => {
  state.project.video.segments.splice(state.seg + 1, 0, { section: 'DATOS', narration: 'Nuevo segmento…', scenes: [{ type: 'title', cue: '', lines: [{ text: 'NUEVO', color: 'white' }] }] });
  rebuild(); selectSegment(state.seg + 1); saveSoon();
};
$('#seg-del').onclick = () => {
  const segs = state.project.video.segments;
  if (segs.length <= 1 || !confirm('¿Borrar este segmento?')) return;
  segs.splice(state.seg, 1);
  rebuild(); selectSegment(Math.max(0, state.seg - 1)); saveSoon();
};

$$('.insp-tabs button').forEach((b) => {
  b.onclick = () => {
    $$('.insp-tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('[data-insp-panel]').forEach((p) => { p.hidden = p.dataset.inspPanel !== b.dataset.insp; });
  };
});

$('#refine-didactic').onclick = () => {
  $('#refine-instruction').value = 'Hazlo más didáctico sin perder el estilo: una sola idea, frases de 8-18 palabras, como máximo 1-2 cifras (cada una traducida a algo tangible), define cualquier término antes de usarlo, señaliza los pasos y cierra con una frase-resumen. No añadas datos nuevos; si sobran cifras, quítalas de la voz y déjalas en las escenas. Ajusta los cue de las escenas al texto nuevo.';
  $('#refine').click();
};

$('#refine').onclick = async () => {
  const seg = state.project.video.segments[state.seg];
  const i = state.seg;
  try {
    const data = await runJob(`Reescribiendo segmento ${i + 1}`, '/api/refine', {
      segment: seg, instruction: $('#refine-instruction').value, context: state.project.video.title, variant: state.project.settings.variant,
    });
    state.project.video.segments[i] = data;
    $('#refine-instruction').value = '';
    rebuild(); selectSegment(i); saveSoon();
    toast('Segmento reescrito');
  } catch {}
};

// transporte
$('#play').onclick = () => { state.stopAt = null; player.toggle(); };
$('#rate').onchange = (e) => { player.rate = Number(e.target.value); };
$('#scrub').addEventListener('input', (e) => player.seek((e.target.value / 1000) * player.tl.duration));
$('#captions').onchange = (e) => { state.project.settings.captions = e.target.checked; player.setOpts({ captions: e.target.checked }); saveSoon(); };
$('#callouts').onchange = (e) => { state.project.settings.callouts = e.target.checked; player.setOpts({ callouts: e.target.checked }); saveSoon(); };

$('#sync-all').onclick = () => { if (state.project) syncSegments(state.project.video.segments.map((_, i) => i)); };

$('#densify').onclick = () => {
  if (!state.project) return;
  animateSegments(state.project.video.segments.map((_, i) => i));
};

$('#wpm').onchange = (e) => { state.project.settings.wpm = Number(e.target.value); rebuild(); saveSoon(); };
$$('#theme-toggle button').forEach((b) => {
  b.onclick = () => {
    $$('#theme-toggle button').forEach((x) => x.classList.toggle('on', x === b));
    state.project.settings.theme = b.dataset.theme;
    player.setOpts({ theme: b.dataset.theme });
    saveSoon();
  };
});
$('#save').onclick = () => saveProject(state.project);
$('#load-demo').onclick = async () => { openProject(await getJSON('/demo/demo.json')); toast('Demo cargada'); };

let lastWord = -1;
player.on((type, p) => {
  if (type === 'play' || type === 'pause') $('#play').textContent = p.playing ? '❚❚' : '▶';
  if (type !== 'time') return;
  const tl = p.tl;
  $('#time').textContent = `${fmt(p.t)} / ${fmt(tl.duration)}`;
  if (document.activeElement !== $('#scrub')) $('#scrub').value = Math.round((p.t / tl.duration) * 1000);
  const head = $('#tl-head');
  if (head) head.style.left = `${(p.t / tl.duration) * 100}%`;
  if (p.playing && state.project) {
    const si = segmentAt(tl, p.t);
    const sc = tl.scenes[sceneAt(tl, p.t)];
    if (si !== state.seg && !typing()) selectSegment(si, 0, false);
    else if (sc && sc.seg === state.seg && sc.idx !== state.scene && !typing()) { state.scene = sc.idx; renderSceneEditor(); }
  }
  // lectura actual bajo el reproductor
  const wi = wordAt(tl, p.t);
  if (wi !== lastWord && wi >= 0) {
    lastWord = wi;
    const seg = tl.segments[tl.words[wi].seg];
    const from = Math.max(0, seg.words.indexOf(tl.words[wi]) - 14);
    const slice = seg.words.slice(from, from + 30);
    $('#now-reading').innerHTML = slice.map((w) => `<span class="w ${w === tl.words[wi] ? 'on' : w.t1 <= p.t ? 'said' : ''}">${esc(w.text)}</span>`).join(' ');
  }
  tp.update(p.t);
  if (state.stopAt != null && p.playing && p.t >= state.stopAt) { state.stopAt = null; p.pause(); }
  if (state.recording) $('#tp-time').textContent = fmt(p.t);
});

player.on((type) => { if (type === 'ended' && state.recording) stopTake(); });

// guion en texto plano
$('#download-script').onclick = () => {
  const v = state.project.video;
  const tl = player.tl;
  const body = v.segments.map((s, i) => {
    const text = String(s.narration).replace(/\*([^*]+)\*/g, (_, w) => w.toUpperCase());
    return `## ${String(i + 1).padStart(2, '0')} · ${s.section}  [${fmt(tl.segments[i]?.start ?? 0)}]\n\n${text}`;
  }).join('\n\n');
  download(new Blob([`# ${v.title}\n\n${body}\n`], { type: 'text/plain' }), `${slug(v.title)}-guion.txt`);
};

// exportar vídeo sin voz (tiempo real)
$('#export-video').onclick = async () => {
  if (state.recording) return;
  const rec = new Recorder(canvas);
  await rec.start({ mic: false, audioStream: player.audioOn() ? mixer.recDest.stream : null });
  state.recording = { rec, export: true };
  player.seek(0);
  player.rate = 1;
  player.play();
  toast(`Exportando en tiempo real (${fmt(player.tl.duration)}). No cambies de pestaña.`, 5000);
};

// ---------- 03 · TELEPROMPTER ----------
function enterPrompter() {
  if (!state.project) { location.hash = '#estudio'; toast('Primero abre o genera un guion'); return; }
  $('#stage-pip').appendChild(canvas);
  $('#prompter').classList.toggle('with-pip', $('#tp-preview').checked);
  tp.render(player.tl);
  tp.setSize(Number($('#tp-size').value));
  player.rate = Number($('#tp-rate').value);
  tp.update(player.t, true);
}

async function countdown() {
  const el = $('#countdown');
  el.hidden = false;
  for (const n of [3, 2, 1]) {
    el.textContent = n;
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    await new Promise((r) => setTimeout(r, 1000));
  }
  el.hidden = true;
}

$('#tp-rehearse').onclick = async () => {
  if (state.recording) return;
  if (player.playing) return player.pause();
  await countdown();
  player.play();
};

$('#tp-record').onclick = async () => {
  if (state.recording) return;
  const rec = new Recorder(canvas);
  try {
    // el vídeo lleva tu voz + efectos + música; la voz IA no suena (la sustituyes tú)
    mixer.voiceOn = false;
    mixer.setMix({ monitor: $('#tp-monitor').checked });
    await rec.start({
      mic: true,
      audioStream: mixer.recDest.stream,
      onMic: (stream) => mixer.attachMic(stream),
      onLevel: (v) => { $('#vu i').style.height = `${Math.min(100, v * 160)}%`; },
    });
  } catch (e) { toast(`Sin acceso al micrófono: ${e.message}`, 4000); return; }
  rec.pause();
  state.recording = { rec, startAt: player.t };
  $('#tp-record').classList.add('live');
  $('#tp-stop').disabled = false;
  await countdown();
  rec.resume();
  player.play();
};

async function stopTake() {
  const r = state.recording;
  if (!r || r.short != null) return; // la exportación de un short se cierra en su propio manejador
  state.recording = null;
  player.pause();
  mixer.detachMic();
  mixer.voiceOn = $('#voice-toggle').checked;
  mixer.setMix({ monitor: true });
  $('#tp-record').classList.remove('live');
  $('#tp-stop').disabled = true;
  $('#vu i').style.height = '0';
  const { video, audio } = await r.rec.stop();
  const name = slug(state.project?.video.title || 'video');
  if (r.export) {
    if (video) download(video, `${name}-animacion.${extOf(video)}`);
    toast('Vídeo exportado');
    return;
  }
  const take = document.createElement('div');
  take.className = 'take';
  const n = $$('.take').length + 1;
  const vurl = video ? URL.createObjectURL(video) : '';
  take.innerHTML = `<b>Toma ${n} · ${fmt(player.t - (r.startAt ?? 0))}</b>${vurl ? `<video controls src="${vurl}"></video>` : ''}<div class="row"></div>`;
  const row = take.querySelector('.row');
  if (video) { const b = document.createElement('button'); b.className = 'btn small primary'; b.textContent = `Vídeo + voz (.${extOf(video)})`; b.onclick = () => download(video, `${name}-toma${n}.${extOf(video)}`); row.appendChild(b); }
  if (audio) { const b = document.createElement('button'); b.className = 'btn small'; b.textContent = `Solo voz (.${extOf(audio)})`; b.onclick = () => download(audio, `${name}-toma${n}-voz.${extOf(audio)}`); row.appendChild(b); }
  $('#takes').prepend(take);
  toast('Toma guardada abajo');
}
$('#tp-stop').onclick = stopTake;

$('#tp-rate').addEventListener('input', (e) => { player.rate = Number(e.target.value); $('#tp-rate-val').textContent = `${Number(e.target.value).toFixed(2)}×`; });
$('#tp-size').addEventListener('input', (e) => tp.setSize(Number(e.target.value)));
$('#tp-mirror').onchange = (e) => $('#prompter').classList.toggle('mirror', e.target.checked);
$('#tp-preview').onchange = (e) => { $('#stage-pip').hidden = !e.target.checked; $('#prompter').classList.toggle('with-pip', e.target.checked); tp.update(player.t, true); };

function jumpSegment(dir) {
  const tl = player.tl;
  const si = segmentAt(tl, player.t);
  const cur = tl.segments[si];
  let target = si + dir;
  if (dir < 0 && player.t - cur.start > 1.5) target = si;
  const seg = tl.segments[Math.max(0, Math.min(tl.segments.length - 1, target))];
  player.seek(seg.start + 0.01);
}

document.addEventListener('keydown', (e) => {
  if (typing()) return;
  const view = (location.hash || '#descubrir').slice(1);
  if (view === 'teleprompter') {
    if (e.code === 'Space') {
      e.preventDefault();
      if (player.playing) { player.pause(); state.recording?.rec.pause(); }
      else { state.recording?.rec.resume(); player.play(); }
    } else if (e.key === 'ArrowRight') jumpSegment(1);
    else if (e.key === 'ArrowLeft') jumpSegment(-1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const r = $('#tp-rate');
      r.value = Math.max(0.6, Math.min(1.5, Number(r.value) + (e.key === 'ArrowUp' ? 0.05 : -0.05)));
      r.dispatchEvent(new Event('input'));
    } else if (e.key === 'Escape') { state.recording ? stopTake() : player.pause(); }
  } else if (view === 'estudio' && e.code === 'Space' && state.project) {
    e.preventDefault();
    player.toggle();
  }
});

// ---------- 04 · MINIATURA ----------
const iconOptions = ICON_NAMES.map((n) => `<option>${n}</option>`).join('');
$('#thumb-form').icon.innerHTML = iconOptions;
$('#thumb-form').icon2.innerHTML = `<option>none</option>${iconOptions}`;

function thumbs() {
  const v = state.project?.video;
  if (!v) return [structuredClone(THUMB_DEFAULT)];
  v.thumbnail = v.thumbnail ?? structuredClone(THUMB_DEFAULT);
  return [v.thumbnail, ...(v.alt_thumbnails ?? [])];
}
const currentThumb = () => thumbs()[state.thumbIdx] ?? thumbs()[0];

function renderThumbView() {
  const list = thumbs();
  const box = $('#thumb-variants');
  box.innerHTML = '';
  list.forEach((spec, i) => {
    const c = document.createElement('canvas');
    c.width = 440; c.height = 248;
    c.className = i === state.thumbIdx ? 'on' : '';
    drawThumb(c.getContext('2d'), spec);
    c.onclick = () => { state.thumbIdx = i; renderThumbView(); };
    box.appendChild(c);
  });
  fillThumbForm();
  drawThumb($('#thumb-canvas').getContext('2d'), currentThumb());
}

function fillThumbForm() {
  const spec = currentThumb();
  const f = $('#thumb-form');
  $('#thumb-lines').innerHTML = '';
  (spec.lines ?? []).forEach((ln, i) => {
    const row = document.createElement('div');
    row.className = 'thumb-line';
    row.innerHTML = `<input value="${esc(ln.text)}" /><select>${['white', 'red', 'yellow', 'blue'].map((c) => `<option ${c === ln.color ? 'selected' : ''}>${c}</option>`).join('')}</select><button type="button" title="Quitar">×</button>`;
    const [inp, sel, del] = row.children;
    inp.oninput = () => { ln.text = inp.value; redrawThumb(); };
    sel.onchange = () => { ln.color = sel.value; redrawThumb(); };
    del.onclick = () => { spec.lines.splice(i, 1); fillThumbForm(); redrawThumb(); };
    $('#thumb-lines').appendChild(row);
  });
  f.stLabel.value = spec.sticker?.label ?? '';
  f.stValue.value = spec.sticker?.value ?? '';
  f.icon.value = spec.icon ?? 'gpu';
  f.icon2.value = spec.icon2 ?? 'none';
  $$('#thumb-layout button').forEach((b) => b.classList.toggle('on', b.dataset.layout === (spec.layout ?? 'left')));
}

const redrawThumb = () => {
  drawThumb($('#thumb-canvas').getContext('2d'), currentThumb());
  const c = $$('#thumb-variants canvas')[state.thumbIdx];
  if (c) drawThumb(c.getContext('2d'), currentThumb());
  saveSoon();
};
$('#thumb-form').addEventListener('input', (e) => {
  const spec = currentThumb();
  const f = e.currentTarget;
  if (e.target === f.stLabel || e.target === f.stValue) {
    spec.sticker = f.stLabel.value || f.stValue.value ? { label: f.stLabel.value, value: f.stValue.value } : null;
  }
  if (e.target === f.icon) spec.icon = f.icon.value;
  if (e.target === f.icon2) spec.icon2 = f.icon2.value;
  redrawThumb();
});
$$('#thumb-layout button').forEach((b) => { b.onclick = () => { currentThumb().layout = b.dataset.layout; fillThumbForm(); redrawThumb(); }; });
$('#thumb-add-line').onclick = () => { const s = currentThumb(); s.lines = s.lines ?? []; s.lines.push({ text: 'NUEVA', color: 'white' }); fillThumbForm(); redrawThumb(); };
$('#thumb-download').onclick = () => thumbToPNG(currentThumb(), `${slug(state.project?.video.title || 'miniatura')}-${state.thumbIdx + 1}.png`);

// ---------- 05 · ESTILO ----------
function md(src) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');
  const out = [];
  let list = null;
  for (const line of src.split('\n')) {
    const m = line.match(/^(#{1,3}) (.*)/);
    const li = line.match(/^\s*(?:[-*]|\d+\.) (.*)/);
    if (!li && list) { out.push(`</${list}>`); list = null; }
    if (m) out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    else if (li) {
      const type = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (!list) { out.push(`<${type}>`); list = type; }
      out.push(`<li>${inline(li[1])}</li>`);
    } else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join('\n');
}

async function loadStyle() {
  try {
    const s = await getJSON('/api/style');
    $('#style-md').innerHTML = md(s.estilo || '*Sin biblia de estilo todavía.*');
    $('#ref-count').textContent = s.referencias.length;
    $('#refs').innerHTML = s.referencias.map((r) => `<li>${esc(r.title)}<span>${r.words.toLocaleString('es-ES')} pal.</span></li>`).join('');
  } catch (e) { toast(e.message); }
}

$('#study-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  body.limit = Number(body.limit);
  try {
    const data = await runJob('Descargando transcripciones', '/api/study', body);
    toast(`${data.added.length} transcripciones nuevas`);
    loadStyle();
  } catch {}
});
$('#analyze-style').onclick = async () => {
  try {
    await runJob('Reanalizando el estilo (lee todas las referencias)', '/api/style/analyze', { model: 'opus' });
    toast('Biblia de estilo actualizada');
    loadStyle();
  } catch {}
};

// ---------- VOZ IA (Fish Audio / ElevenLabs) ----------
const SCOPES = {
  fish: [['mine', 'Mis voces'], ['latam', 'Catálogo: español latino'], ['es', 'Catálogo: todo en español'], ['all', 'Catálogo completo']],
  elevenlabs: [['mine', 'Mis voces'], ['all', 'Todas las voces de mi cuenta']],
};
const PROVIDER_UI = {
  fish: { name: 'Fish Audio', speed: [0.8, 1.3], keyHint: 'Pega tu API key de Fish Audio (fish.audio → API Keys)', selfEmpty: 'No tienes voces propias todavía: desmarca «Solo mis voces» para buscar en la biblioteca pública, o crea tu clon en fish.audio.' },
  elevenlabs: { name: 'ElevenLabs', speed: [0.7, 1.2], keyHint: 'Pega tu API key de ElevenLabs (elevenlabs.io → Developers → API Keys)', selfEmpty: 'No tienes voces propias: desmarca «Solo mis voces» para ver las voces de tu cuenta, o crea un clon en elevenlabs.io.' },
};
let ttsStatus = {};

/** project.voice normalizado (los proyectos anteriores solo tenían Fish con los ajustes sueltos). */
function voiceOf(p = state.project) {
  const v = p?.voice;
  if (!v) return null;
  if (!v.provider) {
    v.provider = 'fish';
    v.settings = v.settings ?? { model: v.model, speed: v.speed, temperature: v.temperature };
  }
  return v;
}

function voiceDurations() {
  const v = voiceOf();
  if (!v || !state.voiceDur || !$('#voice-toggle').checked) return null;
  return state.project.video.segments.map((_, i) => state.voiceDur[i] ?? null);
}

function staleSegments() {
  const v = voiceOf();
  if (!v) return [];
  return state.project.video.segments
    .map((s, i) => ({ i, seg: v.segments.find((x) => x.index === i) }))
    .filter(({ i, seg }) => !seg || seg.text !== state.project.video.segments[i].narration || (seg.sig && seg.sig !== sigOf(currentVoiceChoice())))
    .map(({ i }) => i);
}

function updateVoiceBadge() {
  const v = voiceOf();
  const stale = staleSegments();
  $('#open-voice').classList.toggle('has-voice', !!v && !stale.length);
  $('#open-voice').classList.toggle('stale', !!v && stale.length > 0);
  $('#voice-toggle-wrap').hidden = !v;
  $('#voice-wav').disabled = !v;
  $('#voice-remove').disabled = !v;
  $('#voice-info').textContent = !v ? 'Se genera un audio por segmento; si luego cambias un segmento, solo se regenera ese.'
    : `Voz actual: ${PROVIDER_UI[v.provider]?.name} · ${v.voiceTitle || v.voiceId} · ${v.settings?.model ?? ''} · ${v.segments.length} segmentos${stale.length ? ` · ⚠️ ${stale.length} segmentos cambiaron desde la última generación: vuelve a generar (solo se rehacen esos)` : ' · al día'}`;
}

async function loadVoice() {
  const v = voiceOf();
  const urls = state.project.video.segments.map((_, i) => v.segments.find((x) => x.index === i)?.url ?? null);
  state.voiceDur = await mixer.loadVoice(urls);
  mixer.voiceOn = $('#voice-toggle').checked;
  rebuild();
  player.refreshAudio();
}

$('#voice-toggle').onchange = (e) => {
  player.pause();
  mixer.voiceOn = e.target.checked;
  rebuild();
};

// preferencias por proveedor (voz y ajustes recordados entre proyectos)
const ttsPrefs = () => store.get('ttsPrefs', { provider: 'fish', adapt: true });
const currentProvider = () => $('#voice-provider button.on')?.dataset.provider ?? 'fish';

const SLIDERS = ['voice-temp', 'voice-stability', 'voice-similarity', 'voice-style'];
function readSettings() {
  const prov = currentProvider();
  const base = { model: $('#voice-model').value, speed: Number($('#voice-speed').value) };
  return prov === 'fish'
    ? { ...base, temperature: Number($('#voice-temp').value) }
    : { ...base, stability: Number($('#voice-stability').value), similarity: Number($('#voice-similarity').value), style: Number($('#voice-style').value) };
}

function setRange(id, v) {
  const el = $(`#${id}`);
  if (v != null) el.value = v;
  el.dispatchEvent(new Event('input'));
}

async function selectProvider(prov, prefill = null) {
  stopPreview();
  $$('#voice-provider button').forEach((b) => b.classList.toggle('on', b.dataset.provider === prov));
  $$('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== prov; });
  const ui = PROVIDER_UI[prov];
  const saved = prefill ?? ttsPrefs()[prov] ?? {};
  const set = saved.settings ?? {};
  $('#tts-key').placeholder = ui.keyHint;
  const scope = store.get(`voiceScope:${prov}`, 'mine');
  $('#voice-scope').innerHTML = SCOPES[prov].map(([v, l]) => `<option value="${v}" ${v === scope ? 'selected' : ''}>${l}</option>`).join('');
  $('#voice-sort').hidden = prov !== 'fish';
  $('#voice-id').value = saved.voiceId ?? '';
  $('#voice-id').dataset.title = saved.voiceTitle ?? '';
  $('#voice-speed').min = ui.speed[0];
  $('#voice-speed').max = ui.speed[1];
  setRange('voice-speed', set.speed ?? 1);
  setRange('voice-temp', set.temperature ?? 0.7);
  setRange('voice-stability', set.stability ?? 0.5);
  setRange('voice-similarity', set.similarity ?? 0.75);
  setRange('voice-style', set.style ?? 0);
  setKeyStatus();
  $('#voices').innerHTML = '';
  // modelos: Fish lista fija; ElevenLabs se piden a su API
  const sel = $('#voice-model');
  sel.innerHTML = '<option>…</option>';
  if (ttsStatus[prov]?.configured) {
    try {
      const { items } = await getJSON(`/api/tts/${prov}/models`);
      sel.innerHTML = items.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
      if (set.model && items.some((m) => m.id === set.model)) sel.value = set.model;
    } catch (e) { sel.innerHTML = ''; toast(e.message, 4000); }
    searchVoices();
  } else sel.innerHTML = '';
}

$('#open-voice').onclick = async () => {
  ttsStatus = await getJSON('/api/tts/status').catch(() => ({}));
  loadLexicon().catch(() => {});
  const v = voiceOf();
  const prefs = ttsPrefs();
  $('#voice-adapt').checked = (v?.adapt ?? prefs.adapt) !== false;
  $('#voice-breath').checked = mixer.mix.breathClean !== false;
  if (!$('#voice-sample-text').value) $('#voice-sample-text').value = defaultSampleText();
  updateVoiceBadge();
  $('#voice-dialog').showModal();
  await selectProvider(v?.provider ?? prefs.provider ?? 'fish', v ? { voiceId: v.voiceId, voiceTitle: v.voiceTitle, settings: v.settings } : null);
};

$$('#voice-provider button').forEach((b) => { b.onclick = () => selectProvider(b.dataset.provider); });

function setKeyStatus() {
  const st = ttsStatus[currentProvider()] ?? {};
  $('#tts-key-box').classList.toggle('ok', !!st.configured);
  $('#tts-status').className = `pill ${st.configured ? 'g' : 'r'}`;
  $('#tts-status').textContent = st.configured ? `API key lista${st.source === 'env' ? ' (variable de entorno)' : ''}` : 'Sin API key';
}

$('#tts-key-change').onclick = () => { $('#tts-key-box').classList.remove('ok'); $('#tts-key').focus(); };

$('#tts-key-save').onclick = async () => {
  const key = $('#tts-key').value.trim();
  if (!key) return;
  const prov = currentProvider();
  $('#tts-status').textContent = 'Comprobando…';
  try {
    const r = await fetch(`/api/tts/${prov}/key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    $('#tts-key').value = '';
    ttsStatus = data;
    await selectProvider(prov);
  } catch (e) { $('#tts-status').className = 'pill r'; $('#tts-status').textContent = e.message.slice(0, 70); }
};

let voicePage = 1;
let voiceCount = 0;
const seenVoices = new Set();
async function searchVoices(more = false) {
  const box = $('#voices');
  const prov = currentProvider();
  const scope = $('#voice-scope').value || 'mine';
  store.set(`voiceScope:${prov}`, scope);
  voicePage = more === true ? voicePage + 1 : 1;
  if (voicePage === 1) seenVoices.clear();
  if (voicePage === 1) { box.innerHTML = `<p class="muted">${scope === 'latam' ? 'Recorriendo el catálogo en español y quedándome con los acentos latinos…' : 'Buscando voces…'}</p>`; voiceCount = 0; }
  $('#voices-more').hidden = true;
  $('#voices-more').disabled = true;
  try {
    const q = encodeURIComponent($('#voice-q').value.trim());
    const data = await getJSON(`/api/tts/${prov}/voices?q=${q}&scope=${scope}&page=${voicePage}&sort=${$('#voice-sort').value}`);
    if (prov !== currentProvider()) return; // el usuario cambió de proveedor mientras tanto
    if (voicePage === 1) box.innerHTML = '';
    const fresh = data.items.filter((v) => !seenVoices.has(v.id));
    fresh.forEach((v) => seenVoices.add(v.id));
    voiceCount += fresh.length;
    if (!voiceCount) {
      box.innerHTML = `<p class="muted">${scope === 'mine' ? PROVIDER_UI[prov].selfEmpty : data.hasMore ? 'Nada en esta tanda; prueba «Cargar más».' : 'Sin resultados.'}</p>`;
    }
    for (const v of fresh) {
      const b = document.createElement('div');
      b.className = 'voice' + (v.id === $('#voice-id').value ? ' on' : '');
      b.tabIndex = 0;
      const accent = { latino: 'acento latino', neutro: 'acento neutro', españa: 'acento de España' }[v.accent];
      const meta = [accent ?? v.languages.join(' · '), ...(v.tags ?? []).slice(0, 2), v.uses ? `${Intl.NumberFormat('es', { notation: 'compact' }).format(v.uses)} usos` : ''].filter(Boolean).join(' · ') || v.author;
      b.innerHTML = `${v.cover ? `<img src="${esc(v.cover)}" alt="" loading="lazy" />` : `<div class="ph">${esc(v.title[0] ?? '?')}</div>`}<div><b title="${esc(v.title)}">${esc(v.title)}</b><span title="${esc(meta)}">${esc(meta)}</span></div>
        <div class="acts">${v.sample ? `<button type="button" data-act="sample" title="${esc(v.sampleText || `Muestra publicada en ${PROVIDER_UI[prov].name} (gratis)`)}">▶ Muestra</button>` : ''}<button type="button" data-act="try" title="Genera tu frase de prueba con esta voz (gasta muy poco crédito; se guarda en caché)">▶ Probar</button></div>`;
      const select = () => {
        $('#voice-id').value = v.id;
        $('#voice-id').dataset.title = v.title;
        $$('#voices .voice').forEach((x) => x.classList.toggle('on', x === b));
      };
      b.onclick = (e) => { if (!e.target.closest('.acts')) select(); };
      b.onkeydown = (e) => { if (e.key === 'Enter') select(); };
      b.querySelector('[data-act=sample]')?.addEventListener('click', (e) => playUrl(e.currentTarget, v.sample));
      b.querySelector('[data-act=try]').addEventListener('click', (e) => { select(); tryVoice(e.currentTarget, v.id); });
      box.appendChild(b);
    }
    $('#voices-count').textContent = voiceCount ? `${voiceCount} voces${data.hasMore ? ' (hay más)' : ''}` : '';
    $('#voices-more').hidden = !data.hasMore;
    $('#voices-more').disabled = false;
  } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
$('#voices-more').onclick = () => searchVoices(true);
$('#voice-scope').onchange = () => searchVoices();
$('#voice-sort').onchange = () => searchVoices();

// ---- escuchar voces antes de elegir ----
const previewAudio = new Audio();
let previewBtn = null;
function stopPreview() {
  previewAudio.pause();
  previewBtn?.classList.remove('playing');
  if (previewBtn) previewBtn.textContent = previewBtn.dataset.label;
  previewBtn = null;
}
function playUrl(btn, url) {
  const same = previewBtn === btn;
  stopPreview();
  if (same) return; // segundo clic = parar
  btn.dataset.label = btn.dataset.label || btn.textContent;
  previewBtn = btn;
  btn.classList.add('playing');
  btn.textContent = '■ Parar';
  previewAudio.src = url;
  previewAudio.play().catch((e) => { toast(`No se pudo reproducir: ${e.message}`); stopPreview(); });
}
previewAudio.onended = stopPreview;
$('#voice-dialog').addEventListener('close', stopPreview);

const defaultSampleText = () => {
  const first = String(state.project?.video.segments?.[0]?.narration ?? '').replace(/\*/g, '').split(/(?<=[.?!])\s+/).slice(0, 2).join(' ');
  return first.slice(0, 220) || 'Hoy vamos a hacer la cuenta que nadie hace: cuánto cuesta de verdad ejecutar este modelo en casa.';
};

async function tryVoice(btn, voiceId) {
  if (!voiceId) return toast('Elige una voz o pega su ID');
  if (previewBtn === btn) return stopPreview();
  btn.dataset.label = btn.dataset.label || btn.textContent;
  btn.classList.add('loading');
  btn.textContent = 'Generando…';
  try {
    const r = await fetch('/api/tts/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: currentProvider(), voiceId, text: $('#voice-sample-text').value, settings: readSettings() }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    btn.classList.remove('loading');
    playUrl(btn, data.url);
  } catch (e) {
    btn.classList.remove('loading');
    btn.textContent = btn.dataset.label;
    toast(e.message, 4000);
  }
}
$('#voice-try-id').onclick = (e) => tryVoice(e.currentTarget, $('#voice-id').value.trim());

$('#voice-search').onclick = () => searchVoices();
$('#voice-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchVoices(); } });
$('#voice-id').addEventListener('input', (e) => { e.target.dataset.title = ''; });
$('#voice-speed').addEventListener('input', (e) => { $('#voice-speed-val').textContent = `${Number(e.target.value).toFixed(2)}×`; });
SLIDERS.forEach((id) => $(`#${id}`).addEventListener('input', (e) => { $(`[data-val="${id}"]`).textContent = Number(e.target.value).toFixed(2); }));

// ---- alineación palabra a palabra y sincronización guion · voz · animación ----
state.aligner = { available: false };
getJSON('/api/align/status').then((st) => { state.aligner = st; }).catch(() => {});

/** Palabras oídas en cada audio (solo si la alineación corresponde a ese mismo audio). */
function voiceAlignments() {
  const v = voiceOf();
  if (!v || !$('#voice-toggle').checked) return null;
  return state.project.video.segments.map((_, i) => {
    const sg = v.segments.find((x) => x.index === i);
    return sg?.words && sg.alignedUrl === sg.url ? sg.words : null;
  });
}

/** Alinea los audios de esos segmentos (Whisper local) y guarda los tiempos reales de cada palabra. */
async function alignSegments(indices, { quiet = false } = {}) {
  const v = voiceOf();
  if (!v || !state.aligner.available) return false;
  const segs = indices.map((i) => v.segments.find((x) => x.index === i)).filter((x) => x?.url && x.alignedUrl !== x.url);
  if (!segs.length) return true;
  const data = await runJob(segs.length === 1 ? `Sincronizando con la voz · segmento ${segs[0].index + 1}` : `Sincronizando con la voz · ${segs.length} segmentos`, '/api/align', {
    segments: segs.map((x) => ({ index: x.index, url: x.url, spoken: x.spoken ?? state.project.video.segments[x.index].narration })),
  });
  for (const r of data.segments) {
    const sg = v.segments.find((x) => x.index === r.index);
    if (sg) { sg.words = r.words; sg.alignedUrl = sg.url; }
  }
  rebuild();
  saveSoon();
  if (!quiet) toast('Imagen sincronizada con la voz palabra a palabra');
  return true;
}

/** Palabras que Whisper oyó y no están ni en el guion ni en lo enviado a la voz: posibles fallos de pronunciación. */
function suspiciousWords(i) {
  const tlSeg = player.tl.segments[i];
  const sg = voiceOf()?.segments.find((x) => x.index === i);
  if (!tlSeg?.align?.extra?.length || !sg) return [];
  const n = (w) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]/g, '');
  const known = new Set([...String(sg.spoken ?? '').split(/\s+/), ...String(state.project.video.segments[i].narration).split(/\s+/)].map(n));
  return tlSeg.align.extra.filter((x) => { const k = n(x.w); return k.length >= 3 && !known.has(k); }).slice(0, 6);
}

/** Recoloca las anclas que el texto editado movió (sin IA): reescribe el cue con las palabras actuales. */
function repairCues(i) {
  const seg = state.project.video.segments[i];
  const words = player.tl.segments[i]?.words ?? [];
  const textAt = (f) => words.slice(f.i, f.i + f.len).map((w) => w.text.replace(/[.,;:!?¿¡…"«»()]+/g, '')).join(' ');
  let fixed = 0;
  for (const sc of player.tl.scenes.filter((x) => x.seg === i)) {
    const raw = seg.scenes?.[sc.idx];
    if (!raw) continue;
    if (sc.cueInfo?.q === 'fuzzy') { raw.cue = textAt(sc.cueInfo); fixed++; }
    sc.itemInfo?.forEach((f, k) => { if (f.q === 'fuzzy' && raw.items?.[k]) { raw.items[k].cue = textAt(f); fixed++; } });
  }
  return fixed;
}

/** Estado de sincronía de un segmento: qué falta para que guion, voz y animación coincidan. */
function syncState(i) {
  const sc = player.tl.scenes.filter((x) => x.seg === i);
  const lost = sc.filter((x) => x.cueInfo?.q === 'lost').length + sc.reduce((a, x) => a + (x.itemInfo ?? []).filter((f) => f.q === 'lost').length, 0);
  const fuzzy = sc.filter((x) => x.cueInfo?.q === 'fuzzy').length + sc.reduce((a, x) => a + (x.itemInfo ?? []).filter((f) => f.q === 'fuzzy').length, 0);
  const v = voiceOf();
  const sg = v?.segments.find((x) => x.index === i);
  const voiceStale = !!sg && staleSegments().includes(i);
  const unaligned = !!sg && !voiceStale && sg.alignedUrl !== sg.url;
  const broken = !!sg && !voiceStale && !!voiceHealth(i)?.broken;
  const issues = [];
  if (broken) issues.push('la voz falló en este audio');
  if (voiceStale) issues.push('voz desactualizada');
  if (unaligned && state.aligner.available) issues.push('voz sin alinear (tiempos estimados)');
  if (fuzzy) issues.push(`${fuzzy} anclas movidas`);
  if (lost) issues.push(`${lost} anclas perdidas`);
  return { lost, fuzzy, voiceStale, broken, unaligned: unaligned && state.aligner.available, issues, ok: !issues.length };
}

/**
 * ¿El audio de voz salió bien? Detecta los fallos típicos de los modelos expresivos (se atascan, repiten o
 * emiten sonidos sin palabras): duración muy por encima de lo esperado, muchas palabras sin decir o huecos largos.
 */
function voiceHealth(i) {
  const sg = voiceOf()?.segments.find((x) => x.index === i);
  if (!sg?.words || sg.alignedUrl !== sg.url) return null; // sin alinear: no se puede comprobar
  const expectedWords = String(state.project.video.segments[i].narration).split(/\s+/).filter(Boolean).length;
  const dur = state.voiceDur?.[i] ?? 0;
  const heard = sg.words.length;
  let maxGap = 0;
  for (let k = 1; k < sg.words.length; k++) maxGap = Math.max(maxGap, sg.words[k].s - sg.words[k - 1].e);
  const tooLong = dur > (expectedWords / 140) * 60 + 6;        // más lento que 140 palabras/min + margen
  const missing = heard < expectedWords * 0.7;                    // se "comió" más del 30 % del texto
  const stuck = maxGap > 4 || (sg.words[0]?.e - sg.words[0]?.s) > 3; // >4 s sin palabras o una "palabra" eterna
  const broken = (tooLong && missing) || (missing && stuck) || (tooLong && stuck);
  return { broken, heard, expectedWords, dur, maxGap };
}

/** Pone de acuerdo guion, voz y animación de esos segmentos, en orden y pidiendo confirmación de lo que cuesta. */
async function syncSegments(indices) {
  const states = indices.map((i) => ({ i, ...syncState(i) }));
  const fixCues = states.filter((x) => x.fuzzy).map((x) => x.i);
  const regen = states.filter((x) => x.voiceStale || x.broken).map((x) => x.i);
  const force = states.filter((x) => x.broken).map((x) => x.i);
  const align = states.filter((x) => x.unaligned || x.voiceStale || x.broken).map((x) => x.i);
  const reanimate = states.filter((x) => x.lost).map((x) => x.i);
  if (!fixCues.length && !regen.length && !align.length && !reanimate.length) return toast(indices.length === 1 ? 'Este segmento ya está sincronizado ✓' : 'Todo está sincronizado ✓');
  const plan = [
    fixCues.length && `recolocar anclas movidas en ${fixCues.length} segmento(s) (instantáneo)`,
    regen.length && `regenerar la voz de ${regen.length} segmento(s) — gasta créditos de voz`,
    align.length && (state.aligner.available ? `alinear la voz palabra a palabra en ${align.length} segmento(s) (local, gratis)` : 'alinear: no disponible (instala faster-whisper)'),
    reanimate.length && `reanimar ${reanimate.length} segmento(s) con anclas perdidas — usa Claude Code`,
  ].filter(Boolean);
  if ((regen.length || reanimate.length) && !confirm(`Sincronizar:\n• ${plan.join('\n• ')}\n\n¿Continuar?`)) return;
  try {
    for (const i of fixCues) repairCues(i);
    if (fixCues.length) { rebuild(); saveSoon(); }
    if (regen.length) {
      const choice = currentVoiceChoice();
      if (choice) await generateVoice(regen, choice, { align: false, force });
    }
    if (align.length) await alignSegments(align, { quiet: true });
    const stillLost = reanimate.filter((i) => syncState(i).lost);
    if (stillLost.length) await animateSegments(stillLost);
    rebuild();
    selectSegment(state.seg, state.scene, false);
    const left = indices.filter((i) => !syncState(i).ok).length;
    toast(left ? `Sincronizado (quedan ${left} segmentos con avisos)` : 'Guion, voz y animación sincronizados ✓');
  } catch {}
}

/** Voz elegida en el panel (valida clave y voz). */
function voiceChoiceFromDialog() {
  const voiceId = $('#voice-id').value.trim();
  if (!voiceId) { toast('Elige una voz o pega su ID'); return null; }
  const provider = currentProvider();
  if (!ttsStatus[provider]?.configured) { toast(`Falta la API key de ${PROVIDER_UI[provider].name}`); return null; }
  const choice = { provider, voiceId, voiceTitle: $('#voice-id').dataset.title || '', settings: readSettings(), adapt: $('#voice-adapt').checked };
  store.set('ttsPrefs', { ...ttsPrefs(), provider, adapt: choice.adapt, [provider]: { voiceId: choice.voiceId, voiceTitle: choice.voiceTitle, settings: choice.settings } });
  return choice;
}

/** Voz del proyecto (o la última usada). null si aún no se ha elegido ninguna. */
function currentVoiceChoice() {
  const v = voiceOf();
  if (v?.voiceId) return { provider: v.provider, voiceId: v.voiceId, voiceTitle: v.voiceTitle, settings: v.settings, adapt: v.adapt !== false };
  const prefs = ttsPrefs();
  const p = prefs[prefs.provider ?? 'fish'];
  return p?.voiceId ? { provider: prefs.provider ?? 'fish', ...p, adapt: prefs.adapt !== false } : null;
}
const sigOf = (c) => (c ? JSON.stringify([c.provider, c.voiceId, c.settings, c.adapt]) : "");

/** Genera la voz SOLO de los segmentos `indices` y la fusiona con la que ya había. */
async function generateVoice(indices, choice, { align = true, force = [], retry = true } = {}) {
  const prev = voiceOf();
  const sig = sigOf(choice);
  const segs = indices.map((i) => {
    const s = state.project.video.segments[i];
    const old = prev?.segments.find((x) => x.index === i);
    // reutiliza el texto ya adaptado si la narración y los ajustes no cambiaron (así también acierta la caché de audio)
    const reuse = old && old.text === s.narration && (old.sig ?? sig) === sig;
    return { index: i, text: s.narration, spoken: reuse ? old.spoken : undefined };
  });
  const label = indices.length === 1 ? `segmento ${indices[0] + 1}` : `${indices.length} segmentos`;
  const data = await runJob(`Voz · ${label} · ${PROVIDER_UI[choice.provider].name}`, '/api/tts/generate', {
    provider: choice.provider, voiceId: choice.voiceId, voiceTitle: choice.voiceTitle, settings: choice.settings, adapt: choice.adapt,
    projectId: state.project.id, variant: state.project.settings.variant, segments: segs, force,
  });
  const fresh = data.segments.map((x) => ({ ...x, text: state.project.video.segments[x.index].narration, sig }));
  const keep = (prev?.segments ?? []).filter((x) => !indices.includes(x.index));
  state.project.voice = { ...choice, segments: [...keep, ...fresh].sort((a, b) => a.index - b.index) };
  $('#voice-toggle').checked = true;
  await loadVoice();
  saveSoon();
  const otherVoice = keep.filter((x) => x.sig && x.sig !== sig).length;
  if (align && state.aligner.available) {
    await alignSegments(indices, { quiet: true }).catch(() => {});
    // control de calidad: si el audio salió roto (se atascó, repitió o emitió sonidos sin palabras), un reintento
    const broken = indices.filter((i) => voiceHealth(i)?.broken);
    if (broken.length && retry) {
      toast(`La voz falló en ${broken.map((i) => `el segmento ${i + 1}`).join(', ')}: reintentando…`, 4000);
      return generateVoice(broken, choice, { align: true, force: broken, retry: false });
    }
    if (broken.length) toast(`La voz sigue fallando en ${broken.map((i) => `el segmento ${i + 1}`).join(', ')}. Baja la expresividad (0,5–0,7) o acorta ese segmento y regenera.`, 7000);
  }
  if (otherVoice) toast(`${otherVoice} segmentos siguen con la voz anterior: regénéralos para que todo suene igual`, 5000);
}

$('#voice-generate').onclick = async () => {
  const choice = voiceChoiceFromDialog();
  if (!choice) return;
  $('#voice-dialog').close();
  try {
    await generateVoice(state.project.video.segments.map((_, i) => i), choice);
    player.seek(0);
    toast('Voz lista: dale a ▶ para escucharla con las animaciones');
  } catch {}
};

// elegir la voz sin generar nada (luego se genera segmento a segmento)
$('#voice-use').onclick = () => {
  const choice = voiceChoiceFromDialog();
  if (!choice) return;
  const prev = voiceOf();
  state.project.voice = { ...choice, segments: prev?.segments ?? [] };
  $('#voice-dialog').close();
  rebuild();
  renderSegSteps();
  saveSoon();
  toast('Voz elegida. Genérala por segmento en el paso ③ del inspector');
};

// ---- diccionario de pronunciación ----
state.lexicon = [];
async function loadLexicon() {
  const data = await getJSON('/api/tts/lexicon');
  state.lexicon = data.items;
  state.lexiconDefaults = data.defaults;
  renderLexicon();
}
function renderLexicon() {
  const box = $('#lexicon-rows');
  box.innerHTML = '';
  state.lexicon.forEach((e, i) => {
    const row = document.createElement('div');
    row.className = 'lex-row';
    row.innerHTML = `<input value="${esc(e.from)}" placeholder="token" /><input value="${esc(e.to)}" placeholder="tóquen" /><div class="acts"><button type="button" title="Escuchar cómo lo dice tu voz">▶ Probar</button><button type="button" title="Quitar">×</button></div>`;
    const [from, to] = row.querySelectorAll('input');
    from.oninput = () => { e.from = from.value; };
    to.oninput = () => { e.to = to.value; };
    const [tryBtn, del] = row.querySelectorAll('button');
    tryBtn.onclick = () => {
      // frase corta con la palabra en contexto, usando la pronunciación escrita (aún sin guardar)
      const prevText = $('#voice-sample-text').value;
      $('#voice-sample-text').value = `Te lo explico: ${e.to}. Fíjate en ${e.to}.`;
      tryVoice(tryBtn, $('#voice-id').value.trim()).finally(() => { $('#voice-sample-text').value = prevText; });
    };
    del.onclick = () => { state.lexicon.splice(i, 1); renderLexicon(); };
    box.appendChild(row);
  });
}
$('#lex-add').onclick = () => { state.lexicon.unshift({ from: '', to: '' }); renderLexicon(); $('#lexicon-rows input')?.focus(); };
$('#lex-reset').onclick = () => { if (confirm('¿Volver a la lista inicial de pronunciaciones?')) { state.lexicon = structuredClone(state.lexiconDefaults); renderLexicon(); } };
$('#lex-save').onclick = async () => {
  const before = await getJSON('/api/tts/lexicon');
  const { items } = await postJSON('/api/tts/lexicon', { items: state.lexicon });
  // palabras cuyo "se dice" cambió → los segmentos con voz que las contienen quedan desactualizados
  const old = Object.fromEntries(before.items.map((e) => [e.from.toLowerCase(), e.to]));
  const now = Object.fromEntries(items.map((e) => [e.from.toLowerCase(), e.to]));
  const changed = [...new Set([...Object.keys(old), ...Object.keys(now)])].filter((k) => old[k] !== now[k]);
  const v = voiceOf();
  let marked = 0;
  if (v && changed.length) {
    for (const seg of v.segments) {
      const text = String(state.project.video.segments[seg.index]?.narration ?? '').toLowerCase();
      if (changed.some((w) => new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(text))) { seg.sig = 'pronunciacion-cambiada'; marked++; }
    }
    saveSoon();
  }
  state.lexicon = items;
  renderLexicon();
  updateVoiceBadge(); renderSegSteps(); renderTimelineStrip();
  toast(marked ? `Pronunciaciones guardadas · ${marked} segmentos con esas palabras quedan para regenerar` : 'Pronunciaciones guardadas');
};
$('#voice-temp').addEventListener('input', (e) => { $('#voice-temp-warn').hidden = Number(e.target.value) <= 0.8; });
$('#voice-breath').onchange = (e) => { applyMix({ breathClean: e.target.checked }); toast(e.target.checked ? 'Limpieza suave activada: solo respiraciones en pausas entre frases (-15 dB)' : 'Limpieza desactivada: la voz suena tal cual'); };

$('#voice-wav').onclick = async () => {
  if (!state.project?.voice) return;
  toast('Mezclando la voz…');
  download(await mixer.renderWav(player.tl, { voice: true }), `${slug(state.project.video.title)}-voz.wav`);
};

$('#voice-remove').onclick = () => {
  if (!confirm('¿Quitar la voz IA de este proyecto? (los audios siguen en caché)')) return;
  state.project.voice = null;
  state.voiceDur = null;
  mixer.clearVoice();
  $('#voice-dialog').close();
  rebuild();
  saveSoon();
};

// ---------- SONIDO (efectos + música) ----------
state.soundLib = { sounds: [], kit: {}, categories: {} };
const soundUrl = (s) => `/sounds/${s.file.split('/').map(encodeURIComponent).join('/')}`;

async function loadSoundLib() {
  try {
    state.soundLib = await getJSON('/api/sound/library');
    const byKey = Object.fromEntries(state.soundLib.sounds.map((x) => [x.key, x]));
    const kit = Object.fromEntries(Object.entries(state.soundLib.kit).map(([cat, keys]) => [cat, keys.map((k) => byKey[k]).filter(Boolean).map(soundUrl)]));
    await mixer.loadKit(kit);
    player.refreshAudio();
  } catch (e) { console.warn('Biblioteca de sonido', e); }
  syncSoundBar();
}

function soundSettings() {
  if (!state.project) return { ...DEFAULT_MIX };
  state.project.sound = { ...DEFAULT_MIX, ...(state.project.sound ?? {}) };
  delete state.project.sound.monitor;
  return state.project.sound;
}

function syncSoundBar() {
  const kitCount = Object.values(state.soundLib.kit ?? {}).flat().length;
  const m = mixer.mix;
  $('#open-sound').classList.toggle('has-voice', kitCount > 0 && (m.sfx || m.music));
  if ($('#sound-dialog').open) mixStats();
}

function mixStats() {
  const avail = new Set(Object.keys(mixer.sfx).filter((k) => mixer.sfx[k].length));
  const ev = mixer.mix.sfx ? sfxEvents(player.tl, mixer.mix.density, avail) : [];
  const perMin = ev.length / Math.max(1, player.tl.duration / 60);
  $('#mix-stats').textContent = `Este vídeo: ${ev.length} efectos (≈ ${perMin.toFixed(1)} por minuto, nunca a menos de ${DENSITY[mixer.mix.density].gap} s entre sí)`
    + (mixer.music && mixer.mix.music ? ` · música ${-mixer.mix.musicDb} dB bajo la voz, +${mixer.mix.gapBoostDb} dB en pausas` : mixer.mix.music ? ' · sin música en el kit' : '');
}

function applyMix(patch) {
  Object.assign(soundSettings(), patch);
  mixer.setMix(patch);
  player.refreshAudio();
  syncSoundBar();
  saveSoon();
}

function fillMixForm() {
  const m = mixer.mix;
  $('#mix-sfx').checked = m.sfx; $('#mix-music').checked = m.music;
  $('#mix-sfx-db').value = m.sfxDb; $('#mix-music-db').value = m.musicDb; $('#mix-gap').value = m.gapBoostDb;
  $('#mix-sfx-val').textContent = `${m.sfxDb} dB`; $('#mix-music-val').textContent = `${m.musicDb} dB`; $('#mix-gap-val').textContent = `+${m.gapBoostDb} dB`;
  $$('#mix-density button').forEach((b) => b.classList.toggle('on', b.dataset.d === m.density));
}

$('#mix-sfx').onchange = (e) => applyMix({ sfx: e.target.checked });
$('#mix-music').onchange = (e) => applyMix({ music: e.target.checked });
$('#mix-sfx-db').oninput = (e) => { $('#mix-sfx-val').textContent = `${e.target.value} dB`; applyMix({ sfxDb: Number(e.target.value) }); };
$('#mix-music-db').oninput = (e) => { $('#mix-music-val').textContent = `${e.target.value} dB`; applyMix({ musicDb: Number(e.target.value) }); };
$('#mix-gap').oninput = (e) => { $('#mix-gap-val').textContent = `+${e.target.value} dB`; applyMix({ gapBoostDb: Number(e.target.value) }); };
$$('#mix-density button').forEach((b) => { b.onclick = () => { applyMix({ density: b.dataset.d }); fillMixForm(); }; });

// escucha de muestras (reutiliza el reproductor de pruebas de voz)
function renderKit() {
  const { categories, kit, sounds } = state.soundLib;
  const byKey = Object.fromEntries(sounds.map((x) => [x.key, x]));
  $('#kit').innerHTML = '';
  for (const [cat, info] of Object.entries(categories)) {
    const row = document.createElement('div');
    row.className = 'kit-row';
    const items = (kit[cat] ?? []).map((k) => byKey[k]).filter(Boolean);
    const isOff = (mixer.mix.off ?? []).includes(cat);
    if (isOff) row.classList.add('off');
    row.innerHTML = `<div>${cat === 'music' ? '' : `<label class="check kit-on" title="Activar o desactivar solo este tipo de efecto"><input type="checkbox" data-on="${cat}" ${isOff ? '' : 'checked'} /> </label>`}<b>${esc(info.label)}</b><small>${esc(info.when)}</small></div>
      <div class="chips">${items.length ? items.map((x) => `<span class="chip" title="${esc(`${x.name} · ${x.author || 'archivo propio'}`)}"><span>${esc(x.name)}</span><i class="lic ${x.license}">${x.license === 'cc0' ? 'CC0' : x.license === 'by' ? 'CC BY' : esc(x.license)}</i><button type="button" data-play="${esc(x.key)}">▶</button><button type="button" data-del="${esc(x.key)}" title="Quitar">×</button></span>`).join('') : '<span class="empty">vacío — no sonará</span>'}</div>
      <div class="row tight">${cat === 'music' ? '<label class="btn small ghost">Subir archivo<input type="file" accept="audio/*" hidden data-upload="music" /></label>' : ''}<button type="button" class="btn small" data-search="${cat}">${items.length ? 'Añadir variante' : 'Buscar'}</button></div>`;
    row.querySelectorAll('[data-play]').forEach((b) => { b.onclick = () => playUrl(b, soundUrl(byKey[b.dataset.play])); });
    row.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => { state.soundLib = await postJSON('/api/sound/remove', { key: b.dataset.del }); renderKit(); loadSoundLib(); }; });
    row.querySelector('[data-search]').onclick = () => openSoundSearch(cat);
    row.querySelector('[data-on]')?.addEventListener('change', (e) => {
      const off = new Set(mixer.mix.off ?? []);
      if (e.target.checked) off.delete(cat); else off.add(cat);
      applyMix({ off: [...off] });
      renderKit();
      toast(e.target.checked ? `${info.label}: activado` : `${info.label}: silenciado (el resto de efectos sigue sonando)`);
    });
    row.querySelector('[data-upload]')?.addEventListener('change', (e) => uploadSound(cat, e.target.files[0]));
    $('#kit').appendChild(row);
  }
  getJSON('/api/sound/credits').then((c) => { $('#fs-credits').value = c.text || 'Con solo sonidos CC0 no hace falta atribución (aunque se agradece).'; }).catch(() => {});
}

async function uploadSound(cat, file) {
  if (!file) return;
  const license = prompt('¿De dónde es este audio? (p. ej. «Biblioteca de audio de YouTube», «propio», «CC BY Autor»)', 'Biblioteca de audio de YouTube') ?? 'propia';
  toast('Subiendo…');
  const r = await fetch(`/api/sound/upload?category=${cat}&filename=${encodeURIComponent(file.name)}&license=${encodeURIComponent(license)}`, { method: 'POST', body: file });
  const data = await r.json();
  if (!r.ok) return toast(data.error);
  state.soundLib = data;
  renderKit();
  loadSoundLib();
  toast('Añadido al kit');
}

let soundCat = 'whoosh';
function openSoundSearch(cat) {
  soundCat = cat;
  const info = state.soundLib.categories[cat];
  $('#fs-search').hidden = false;
  $('#fs-search-title').textContent = info.label;
  $('#fs-q').value = info.query;
  searchSounds();
  $('#fs-search').scrollIntoView({ block: 'nearest' });
}
$('#fs-close').onclick = () => { $('#fs-search').hidden = true; stopPreview(); };
$('#fs-go').onclick = () => searchSounds();
$('#fs-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchSounds(); } });

async function searchSounds() {
  const box = $('#fs-results');
  box.innerHTML = '<p class="muted">Buscando en Freesound…</p>';
  try {
    const data = await getJSON(`/api/sound/search?category=${soundCat}&q=${encodeURIComponent($('#fs-q').value)}&licenses=${$('#fs-licenses').value}&sort=${soundCat === 'music' ? 'downloads_desc' : 'rating_desc'}`);
    if (!data.items.length) { box.innerHTML = '<p class="muted">Sin resultados con esa licencia y duración. Prueba otras palabras (en inglés suele haber más).</p>'; return; }
    box.innerHTML = '';
    for (const x of data.items) {
      const row = document.createElement('div');
      row.className = 'fs-item';
      row.innerHTML = `<button type="button" data-p>▶</button><span class="nm" title="${esc(x.name)}">${esc(x.name)} <span class="meta">· ${esc(x.author)}</span></span>
        <span class="meta">${x.duration.toFixed(1)} s · ${Intl.NumberFormat('es', { notation: 'compact' }).format(x.downloads ?? 0)} desc.</span>
        <i class="lic ${x.license}">${x.license === 'cc0' ? 'CC0' : 'CC BY'}</i><button type="button" data-use>Usar</button>`;
      row.querySelector('[data-p]').onclick = (e) => playUrl(e.currentTarget, x.preview);
      row.querySelector('[data-use]').onclick = async (e) => {
        e.currentTarget.textContent = '…';
        try {
          state.soundLib = await postJSON('/api/sound/add', { id: x.id, category: soundCat });
          renderKit(); await loadSoundLib(); mixStats();
          e.currentTarget.textContent = '✓';
        } catch (err) { toast(err.message); e.currentTarget.textContent = 'Usar'; }
      };
      box.appendChild(row);
    }
  } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

$('#kit-auto').onclick = async () => {
  const b = $('#kit-auto');
  b.disabled = true; b.textContent = 'Eligiendo sonidos…';
  try {
    const r = await fetch('/api/sound/autokit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ licenses: $('#fs-licenses').value }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    state.soundLib = data;
    renderKit(); await loadSoundLib(); mixStats();
    toast(data.added.length ? `Kit completado: ${data.added.length} huecos rellenados. Escúchalos y cambia los que no te gusten.` : 'Tu kit ya estaba completo');
  } catch (e) { toast(e.message, 5000); }
  b.disabled = false; b.textContent = 'Kit automático';
};

function setFsKeyStatus(st) {
  $('#fs-key-box').classList.toggle('ok', !!st.configured);
  $('#fs-status').className = `pill ${st.configured ? 'g' : 'r'}`;
  $('#fs-status').textContent = st.configured ? 'Freesound listo' : 'Sin API key de Freesound';
}
$('#fs-key-change').onclick = () => { $('#fs-key-box').classList.remove('ok'); $('#fs-key').focus(); };
$('#fs-key-save').onclick = async () => {
  const key = $('#fs-key').value.trim();
  if (!key) return;
  $('#fs-status').textContent = 'Comprobando…';
  try {
    const r = await fetch('/api/sound/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    $('#fs-key').value = '';
    setFsKeyStatus(data);
  } catch (e) { $('#fs-status').className = 'pill r'; $('#fs-status').textContent = e.message.slice(0, 60); }
};
$('#fs-credits-copy').onclick = () => { navigator.clipboard.writeText($('#fs-credits').value); toast('Créditos copiados'); };

$$('[data-stem]').forEach((b) => {
  b.onclick = async () => {
    const parts = { mix: { voice: true, sfx: true, music: true }, voice: { voice: true }, sfx: { sfx: true }, music: { music: true } }[b.dataset.stem];
    toast('Renderizando audio…');
    download(await mixer.renderWav(player.tl, parts), `${slug(state.project?.video.title || 'video')}-${b.dataset.stem}.wav`);
  };
});

$('#open-sound').onclick = async () => {
  if (!state.project) return;
  fillMixForm();
  renderKit();
  mixStats();
  $('#sound-dialog').showModal();
  setFsKeyStatus(await getJSON('/api/sound/status').catch(() => ({})));
};
$('#sound-dialog').addEventListener('close', () => { stopPreview(); $('#fs-search').hidden = true; });

// ---------- 07 · PUBLICAR ----------
const STOP = new Set('el la los las un una unos unas de del al a en y o que es son por para con sin tu tus su sus mi mis lo se no ya más mas muy como qué que cuánto cuanto cuál este esta esto ese esa eso hoy'.split(' '));
const words = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9ñ]+/g) ?? [];

/** Palabras con contenido que el título repite de la miniatura (lo ideal: 0-1). */
function thumbOverlap(title, thumb) {
  const tw = new Set(words([...(thumb?.lines ?? []).map((l) => l.text), thumb?.sticker?.label, thumb?.sticker?.value].join(' ')).filter((w) => !STOP.has(w) && w.length > 1));
  return [...new Set(words(title).filter((w) => tw.has(w)))];
}

const fmtTs = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; };

/** Capítulos con los tiempos REALES de la línea de tiempo y las reglas de YouTube (00:00, ≥3, ≥10 s). */
function chaptersText(pub) {
  const tl = player.tl;
  let ch = (pub.chapters ?? [])
    .map((c) => ({ t: tl.segments[Math.max(0, Math.min(tl.segments.length - 1, Math.round(c.segment)))]?.start ?? 0, title: c.title.trim() }))
    .sort((a, b) => a.t - b.t);
  if (!ch.length || ch[0].t > 0.5) ch.unshift({ t: 0, title: ch[0]?.title ? 'Introducción' : 'Inicio' });
  ch[0].t = 0;
  // fusionar capítulos de menos de 10 s con el anterior
  for (let k = ch.length - 1; k > 0; k--) {
    const next = k + 1 < ch.length ? ch[k + 1].t : tl.duration;
    if (next - ch[k].t < 10 || ch[k].t - ch[k - 1].t < 10) ch.splice(k, 1);
  }
  return { text: ch.map((c) => `${fmtTs(c.t)} ${c.title}`).join('\n'), count: ch.length };
}

async function assembleDescription(pub) {
  const v = state.project.video;
  const ch = chaptersText(pub);
  // solo los sonidos que de verdad suenan en este vídeo
  const m = mixer.mix;
  const cats = [...(m.sfx ? Object.keys(mixer.sfx).filter((c) => mixer.sfx[c].length && !(m.off ?? []).includes(c)) : []), ...(m.music && mixer.music ? ['music'] : [])];
  const credits = cats.length ? await getJSON(`/api/sound/credits?cats=${cats.join(',')}`).catch(() => ({ text: '' })) : { text: '' };
  const usesSound = !!credits.text;
  const parts = [
    pub.description_hook.trim(),
    pub.description_body.trim(),
    `⏱️ Capítulos\n${ch.text}`,
    (v.sources ?? []).length ? `📚 Fuentes\n${v.sources.map((x) => `• ${x.title} — ${x.url}`).join('\n')}` : '',
    usesSound ? `🎵 Sonido\n${credits.text}` : '',
    (pub.hashtags ?? []).slice(0, 3).map((h) => `#${h.replace(/^#/, '').replace(/\s+/g, '')}`).join(' '),
  ].filter(Boolean);
  $('#pub-chapters-warn').textContent = ch.count < 3 ? `Solo ${ch.count} capítulos: YouTube necesita al menos 3 (de ≥10 s) para mostrarlos.` : '';
  return parts.join('\n\n');
}

function renderPubPreview() {
  const pub = state.project?.publish;
  const title = pub?.titles?.[pub.selected ?? 0]?.title ?? state.project?.video.title ?? '';
  const cut = 50;
  $('#pub-preview-title').innerHTML = title.length > cut ? `${esc(title.slice(0, cut))}<span class="cut">${esc(title.slice(cut))}</span>` : esc(title);
  $('#pub-preview-sub').textContent = `${state.project?.settings?.channel || 'tu canal'} · ${fmt(player.tl.duration)}`;
}

function renderTitles() {
  const pub = state.project.publish;
  const thumb = state.project.video.thumbnail;
  $('#pub-titles').innerHTML = '';
  (pub.titles ?? []).forEach((t, k) => {
    const rep = thumbOverlap(t.title, thumb);
    const el = document.createElement('div');
    el.className = `pub-title${k === (pub.selected ?? 0) ? ' on' : ''}`;
    el.innerHTML = `<input type="radio" name="pubt" ${k === (pub.selected ?? 0) ? 'checked' : ''} /><div><b>${esc(t.title)}</b><small>${esc(t.angle)} · ${esc(t.why)}</small></div>
      <span class="${rep.length >= 2 ? 'rep' : 'chars'}">${rep.length >= 2 ? `repite miniatura: ${esc(rep.join(', '))}` : rep.length ? `comparte «${esc(rep[0])}»` : 'complementa ✓'}</span>
      <span class="chars ${t.title.length > 65 ? 'warn' : ''}">${t.title.length} car.</span>`;
    el.onclick = () => { pub.selected = k; state.project.video.title = t.title; saveSoon(); renderTitles(); renderPubPreview(); fillTitles(); };
    el.addEventListener('dblclick', () => { navigator.clipboard.writeText(t.title); toast('Título copiado'); });
    $('#pub-titles').appendChild(el);
  });
  const copy = document.createElement('button');
  copy.className = 'btn small';
  copy.textContent = 'Copiar título elegido';
  copy.onclick = () => { navigator.clipboard.writeText(pub.titles[pub.selected ?? 0].title); toast('Título copiado'); };
  $('#pub-titles').appendChild(copy);
}

async function renderPublish() {
  if (!state.project) { $('#pub-status').textContent = 'Abre o genera un proyecto primero.'; return; }
  drawThumb($('#pub-thumb').getContext('2d'), state.project.video.thumbnail ?? THUMB_DEFAULT);
  const pub = state.project.publish;
  renderPubPreview();
  if (!pub) {
    $('#pub-titles').innerHTML = '<p class="muted">Pulsa «Generar con Claude Code» cuando el vídeo esté terminado (los capítulos usan los tiempos reales).</p>';
    ['pub-desc', 'pub-tags', 'pub-hashtags', 'pub-pinned'].forEach((id) => { $(`#${id}`).value = ''; });
    $('#pub-advice').textContent = '';
    return;
  }
  renderTitles();
  $('#pub-desc').value = pub.descriptionEdited ? pub.description : await assembleDescription(pub);
  $('#pub-tags').value = (pub.tags ?? []).join(', ');
  $('#pub-hashtags').value = (pub.hashtags ?? []).map((h) => `#${h.replace(/^#/, '')}`).join(' ');
  $('#pub-pinned').value = pub.pinned_comment ?? '';
  $('#pub-advice').textContent = pub.thumbnail_advice ? `Miniatura: ${pub.thumbnail_advice}` : '';
  updatePubCounts();
}

function updatePubCounts() {
  const d = $('#pub-desc').value.length, t = $('#pub-tags').value.length;
  $('#pub-desc-count').textContent = `${d} / 5000`;
  $('#pub-tags-count').textContent = `${t} / 500${t > 500 ? ' — demasiadas' : ''}`;
}

$('#pub-generate').onclick = async () => {
  if (!state.project) return toast('Abre un proyecto primero');
  const tl = player.tl;
  const segments = state.project.video.segments.map((sg, i) => ({
    index: i, section: sg.section, secs: Math.round((tl.segments[i]?.end ?? 0) - (tl.segments[i]?.start ?? 0)),
    summary: String(sg.narration).replace(/\*/g, '').split(/\s+/).slice(0, 45).join(' '),
  }));
  try {
    const data = await runJob('Preparando la publicación', '/api/publish', {
      video: { title: state.project.video.title, sources: state.project.video.sources }, thumbnail: state.project.video.thumbnail,
      segments, channel: state.project.settings.channel, variant: state.project.settings.variant,
    });
    // el título mejor puntuado que NO repita la miniatura queda elegido
    const thumb = state.project.video.thumbnail;
    const pick = (max) => data.titles.findIndex((t) => thumbOverlap(t.title, thumb).length <= max);
    const best = [pick(0), pick(1)].find((k) => k >= 0) ?? 0;
    state.project.publish = { ...data, selected: best, descriptionEdited: false };
    state.project.video.title = data.titles[best].title;
    state.project.video.alt_titles = data.titles.map((t) => t.title).filter((_, k) => k !== best);
    state.project.video.tags = data.tags;
    saveSoon();
    fillTitles();
    await renderPublish();
    toast('Publicación lista para copiar');
  } catch {}
};

$('#pub-desc').addEventListener('input', () => { if (state.project?.publish) { state.project.publish.description = $('#pub-desc').value; state.project.publish.descriptionEdited = true; saveSoon(); } updatePubCounts(); });
$('#pub-tags').addEventListener('input', () => { if (state.project?.publish) { state.project.publish.tags = $('#pub-tags').value.split(',').map((x) => x.trim()).filter(Boolean); saveSoon(); } updatePubCounts(); });
$('#pub-pinned').addEventListener('input', () => { if (state.project?.publish) { state.project.publish.pinned_comment = $('#pub-pinned').value; saveSoon(); } });
$$('[data-copy]').forEach((b) => { b.onclick = () => { navigator.clipboard.writeText($(`#${b.dataset.copy}`).value); toast('Copiado'); }; });
$('#pub-copy-all').onclick = () => {
  const pub = state.project?.publish;
  if (!pub) return toast('Genera primero la publicación');
  const all = `TÍTULO\n${pub.titles[pub.selected ?? 0].title}\n\nDESCRIPCIÓN\n${$('#pub-desc').value}\n\nETIQUETAS\n${$('#pub-tags').value}\n\nCOMENTARIO FIJADO\n${$('#pub-pinned').value}`;
  navigator.clipboard.writeText(all);
  toast('Todo copiado');
};

// ---------- SHORTS ----------
state.short = null; // { k, canvas, recording }

function shortClips() {
  const list = state.project?.shorts?.clips ?? [];
  const sentences = sentencesOf(player.tl);
  return list.map((c) => ({ ...c, ...clipRange(sentences, c) }));
}

function shortOpts() { return { theme: state.project?.settings.theme, channel: state.project?.settings.channel }; }

function renderShorts() {
  const box = $('#shorts');
  if (!state.project) { box.innerHTML = ''; return; }
  const clips = shortClips();
  if (!clips.length) { box.innerHTML = '<p class="muted">Todavía no hay shorts. Mejor generarlos con la voz ya alineada: así los cortes caen exactos.</p>'; return; }
  box.innerHTML = '';
  clips.forEach((c, k) => {
    const raw = state.project.shorts.clips[k];
    const dur = c.t1 - c.t0;
    const el = document.createElement('article');
    el.className = 'short';
    el.innerHTML = `<canvas width="540" height="960"></canvas>
      <div class="info">
        <div class="top"><span class="score">${Math.round(c.score)}</span><b>Short ${k + 1}</b><span class="muted">${fmt(c.t0)} → ${fmt(c.t1)} · ${dur.toFixed(0)} s</span>${dur > 60 ? '<span class="warn">largo: mejor &lt; 60 s</span>' : ''}</div>
        <div class="why">${esc(c.why)}</div>
        <label>Gancho en pantalla</label><input data-f="hook_text" value="${esc(c.hook_text)}" />
        <label>Título <button type="button" data-c="title">Copiar</button></label><input data-f="title" value="${esc(c.title)}" />
        <label>Descripción <button type="button" data-c="desc">Copiar</button></label><textarea data-f="description" rows="3">${esc(c.description)}</textarea>
        <label>Hashtags <button type="button" data-c="tags">Copiar</button></label><input data-f="hashtags" value="${esc((c.hashtags ?? []).map((h) => `#${h.replace(/^#/, '')}`).join(' '))}" />
        <div class="acts">
          <button class="btn small" data-a="play">▶ Ver</button>
          <button class="btn small primary" data-a="export">Exportar short</button>
          <button class="btn small ghost" data-a="copy">Copiar textos</button>
          <button class="btn small ghost" data-a="del">Quitar</button>
        </div>
      </div>`;
    const cv = el.querySelector('canvas');
    drawShort(cv.getContext('2d'), player.tl, c.t0 + Math.min(2.5, dur / 2), c, shortOpts());
    el.querySelectorAll('[data-f]').forEach((inp) => {
      inp.addEventListener('input', () => {
        raw[inp.dataset.f] = inp.dataset.f === 'hashtags' ? inp.value.split(/\s+/).map((h) => h.replace(/^#/, '')).filter(Boolean) : inp.value;
        saveSoon();
        if (inp.dataset.f === 'hook_text') drawShort(cv.getContext('2d'), player.tl, c.t0 + Math.min(2.5, dur / 2), { ...c, hook_text: inp.value }, shortOpts());
      });
    });
    const textOf = (f) => el.querySelector(`[data-f=${f}]`).value;
    el.querySelector('[data-c=title]').onclick = () => { navigator.clipboard.writeText(textOf('title')); toast('Título copiado'); };
    el.querySelector('[data-c=desc]').onclick = () => { navigator.clipboard.writeText(`${textOf('description')}\n\n${textOf('hashtags')}`); toast('Descripción copiada'); };
    el.querySelector('[data-c=tags]').onclick = () => { navigator.clipboard.writeText(textOf('hashtags')); toast('Hashtags copiados'); };
    el.querySelector('[data-a=copy]').onclick = () => { navigator.clipboard.writeText(`TÍTULO\n${textOf('title')}\n\nDESCRIPCIÓN\n${textOf('description')}\n\n${textOf('hashtags')}`); toast('Textos copiados'); };
    el.querySelector('[data-a=play]').onclick = () => openShortView(k);
    el.querySelector('[data-a=export]').onclick = () => exportShort(k, cv);
    el.querySelector('[data-a=del]').onclick = () => { state.project.shorts.clips.splice(k, 1); saveSoon(); renderShorts(); };
    box.appendChild(el);
  });
}

function playShort(k, cv) {
  const c = shortClips()[k];
  if (!c) return;
  // primero se para lo que suene (esa pausa no debe cerrar el short nuevo) y luego se marca el short activo
  player.pause();
  state.short = null;
  player.seek(c.t0);
  state.short = { k, canvas: cv };
  state.stopAt = c.t1;
  player.play();

}

/** Ver el short en grande (ventana vertical a casi toda la altura). */
function openShortView(k) {
  state.shortView = k;
  $('#short-view').hidden = false;
  playShort(k, $('#short-big'));
}
function closeShortView() {
  if ($('#short-view').hidden) return;
  $('#short-view').hidden = true;
  state.shortView = null;
  state.stopAt = null;
  if (!state.recording) player.pause();
}
$('#short-close').onclick = closeShortView;
$('#short-replay').onclick = () => { if (state.shortView != null) playShort(state.shortView, $('#short-big')); };
$('#short-view').addEventListener('click', (e) => { if (e.target.id === 'short-view') closeShortView(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeShortView(); });

async function exportShort(k, cv) {
  if (state.recording) return toast('Ya hay una grabación en curso');
  const c = shortClips()[k];
  // a resolución completa mientras se graba
  cv.width = SW; cv.height = SH;
  const rec = new Recorder(cv);
  player.pause();
  player.seek(c.t0);
  drawShort(cv.getContext('2d'), player.tl, c.t0, c, shortOpts());
  await rec.start({ mic: false, audioStream: player.audioOn() ? mixer.recDest.stream : null });
  state.short = { k, canvas: cv, rec };
  state.recording = { rec, short: k };
  state.stopAt = c.t1;
  player.play();
  toast(`Exportando el short ${k + 1} en tiempo real (${(c.t1 - c.t0).toFixed(0)} s). No cambies de pestaña.`, 5000);
}

// cada fotograma del reproductor también pinta el short que se está viendo/exportando
player.on((type, p) => {
  const sh = state.short;
  if (!sh) return;
  const c = shortClips()[sh.k];
  if (type === 'time' && c) drawShort(sh.canvas.getContext('2d'), p.tl, Math.min(p.t, c.t1), c, shortOpts());
  if ((type === 'pause' || type === 'ended') && !p.playing) {
    if (sh.rec && state.recording?.short === sh.k) {
      state.recording = null;
      sh.rec.stop().then(({ video }) => {
        sh.canvas.width = 540; sh.canvas.height = 960;
        if (video) download(video, `${slug(state.project.video.title)}-short${sh.k + 1}.${extOf(video)}`);
        renderShorts();
        toast(`Short ${sh.k + 1} exportado`);
      });
    }
    state.short = null;
  }
});

$('#shorts-generate').onclick = async () => {
  if (!state.project) return toast('Abre un proyecto primero');
  const sentences = sentencesOf(player.tl);
  if (!voiceAlignments()?.some(Boolean)) toast('Consejo: con la voz generada y sincronizada los cortes caen exactos', 4000);
  try {
    const data = await runJob('Buscando los mejores momentos para Shorts', '/api/shorts', {
      title: state.project.video.title, channel: state.project.settings.channel, variant: state.project.settings.variant,
      sentences: sentences.map((x) => ({ i: x.i, t0: x.t0, t1: x.t1, text: x.text })),
    });
    // validación: rangos dentro del vídeo, ordenados y sin solaparse
    const clips = data.clips
      .map((c) => ({ ...c, start: Math.max(0, Math.round(c.start)), end: Math.min(sentences.length - 1, Math.round(c.end)) }))
      .filter((c) => c.end >= c.start)
      .sort((a, b) => b.score - a.score)
      .filter((c, k, arr) => !arr.slice(0, k).some((o) => c.start <= o.end && c.end >= o.start));
    state.project.shorts = { clips, created: Date.now() };
    saveSoon();
    renderShorts();
    toast(`${clips.length} shorts listos`);
  } catch {}
};

// ---------- 06 · PROYECTOS ----------
async function loadProjects() {
  const box = $('#projects');
  box.innerHTML = '';
  const add = (title, sub, spec, onclick) => {
    const el = document.createElement('div');
    el.className = 'project';
    el.innerHTML = `<canvas width="480" height="270"></canvas><div><b>${esc(title)}</b><span class="muted">${esc(sub)}</span></div>`;
    drawThumb(el.querySelector('canvas').getContext('2d'), spec ?? THUMB_DEFAULT);
    el.onclick = onclick;
    box.appendChild(el);
  };
  try {
    for (const p of await getJSON('/api/projects')) {
      add(p.title, new Date(p.updated).toLocaleString('es-ES'), p.thumbnail, async () => {
        openProject(await getJSON(`/api/projects/${encodeURIComponent(p.id)}`));
        location.hash = '#estudio';
      });
    }
  } catch {}
  add('Demo del motor', 'Proyecto de ejemplo', { lines: [{ text: 'ES LA', color: 'white' }, { text: 'RAM.', color: 'yellow' }], sticker: { label: 'Esa RAM hoy', value: '1.099 $' }, icon: 'ram', layout: 'left' }, async () => {
    openProject(await getJSON('/demo/demo.json'));
    location.hash = '#estudio';
  });
}

// ---------- arranque ----------
await Promise.allSettled([
  document.fonts.load('800 100px "Inter Tight"'),
  document.fonts.load('900 100px "Inter Tight"'),
  document.fonts.load('600 30px "JetBrains Mono"'),
  document.fonts.load('700 30px "Kalam"'),
]);
animateHero();
renderTopics();
loadSoundLib();
player.render();
route();
