// Vista de un proyecto «Podcast → Shorts»: una tarjeta por short con vista previa vertical (voz original),
// gancho editable, tira de viñetas (editar y redibujar), dibujar con Codex, exportar MP4 y copiar el texto para TikTok.
import { drawComic, preloadShort, CW, CH, BRAND } from './comic.js';
import { soundtrack, wavOf } from './sound.js';
import { copyText } from '/shared/social.js';
import { exportVideo, canExportFast, downloadUrl } from '/shared/exporter.js';

let ctx = null;          // utilidades de app.js: { $, esc, toast, ask, runTask, streamTo, save, slug }
let project = null;
let playing = null;      // { n, src, t0, raf }: el que suena (t0 = instante del AudioContext en que el short estaría en 0 s)
let ac = null;           // AudioContext de la vista previa
let master = null;       // volumen de la vista previa
const pos = {};          // posición de cada short en pausa (s)
let vol = 1, muted = false;
try { vol = Number(localStorage.getItem('comic.vol') ?? 1); muted = localStorage.getItem('comic.muted') === '1'; } catch {}

export function openPodcast(p, helpers) {
  ctx = helpers;
  project = p;
  stop();
  render();
}
export const closePodcast = () => stop();

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const drawn = (s) => (s.panels ?? []).filter((x) => x.image).length;
function continuation(source, seconds) {
  if (!source?.url) return '';
  const at = Math.max(0, Math.floor(seconds));
  try {
    const url = new URL(source.url);
    url.searchParams.set('t', `${at}s`);
    return `🎬 Continúa la historia desde ${fmt(seconds)}: ${url}`;
  } catch {
    return `🎬 Continúa la historia desde ${fmt(seconds)}: ${source.url}${source.url.includes('?') ? '&' : '?'}t=${at}s`;
  }
}

function render() {
  const { $, esc } = ctx;
  const src = project.source ?? {};
  $('#pod-head').innerHTML = `<h1 class="video-title">${esc(src.title ?? 'Podcast')}</h1>
    <p class="hint">🎙 ${esc(src.channel ?? '')} · ${fmt(src.duration ?? 0)} · <a href="${esc(src.url ?? '#')}" target="_blank" rel="noopener">ver episodio</a> · ${project.shorts.length} shorts</p>`;
  $('#pod-shorts').innerHTML = project.shorts.map((s, n) => `
    <div class="pod-short" data-n="${n}">
      <div class="pod-preview">
        <canvas width="${CW}" height="${CH}" data-act="play" title="Reproducir / pausar"></canvas>
        <button class="big-play" data-act="play" title="Reproducir">▶</button>
        <div class="pod-ctrl">
          <button class="pp" data-act="play" title="Reproducir / pausar">▶</button>
          <input class="seek" type="range" min="0" max="${(s.end - s.start + 0.3).toFixed(2)}" step="0.05" value="0" title="Ir a…" />
          <span class="tm">0:00 / ${fmt(s.end - s.start)}</span>
          <button class="mute" data-act="mute" title="Silenciar">${muted ? '🔇' : '🔊'}</button>
          <input class="vol" type="range" min="0" max="1" step="0.05" value="${vol}" title="Volumen" />
        </div>
      </div>
      <div class="pod-info">
        <h3>${esc(s.title)} <span class="hint">· ${Math.round(s.end - s.start)} s · ${fmt(s.start)}–${fmt(s.end)} del episodio</span></h3>
        <p class="hint">${esc(s.why ?? '')}</p>
        <label>Gancho (texto en pantalla al empezar)<input data-f="hook" value="${esc(s.hook)}" /></label>
        <div class="pod-panels">${(s.panels ?? []).map((pn, i) => `
          <button class="pod-panel ${pn.image ? '' : 'pending'}" data-panel="${i}" title="${esc(`${fmt(pn.t)} · ${pn.shot}: ${pn.desc}`)}" style="${pn.image ? `background-image:url('${esc(pn.image.url)}')` : ''}">
            <span>${i + 1}</span>${pn.image ? '' : '<i>sin dibujar</i>'}
          </button>`).join('')}</div>
        <div class="row wrap">
          <button class="primary" data-act="draw">🖌 ${drawn(s) ? (drawn(s) === s.panels.length ? 'Volver a dibujar todo' : `Dibujar las ${s.panels.length - drawn(s)} que faltan`) : `Dibujar ${s.panels?.length ?? 0} viñetas`}</button>
          <button data-act="export" ${drawn(s) ? '' : 'disabled'}>⬇ MP4 vertical</button>
          ${s.fx ? '' : '<button data-act="fx">✨ Efectos y sonido</button>'}
          ${s.cover ? '' : `<button data-act="cover" ${drawn(s) ? '' : 'disabled title="Primero dibuja alguna viñeta (el personaje sale de ellas)"'}>🖼 Hacer miniatura</button>`}
          <button data-act="copy-yt" title="Título, descripción con pregunta y hashtags para YouTube Shorts">📋 YouTube</button>
          <button data-act="copy-tt" title="Texto con palabras clave, pregunta y hashtags para TikTok">📋 TikTok</button>
        </div>
        ${s.cover ? `<div class="thumb-box">
          <img src="${esc(s.cover.small)}" alt="" />
          <div class="info">
            <b>Miniatura</b><small>«${esc(s.cover.text)}» · también es el primer fotograma del MP4</small>
            <div class="group">
              <a class="btn" href="${esc(s.cover.full)}" download="${esc(ctx.slug(s.title))}-miniatura-4k.jpg" title="2160×3840">⬇ 4K</a>
              <a class="btn" href="${esc(s.cover.small)}" download="${esc(ctx.slug(s.title))}-miniatura.jpg" title="1080×1920, menos de 2 MB (para subir a YouTube)">⬇ YouTube</a>
              <button data-act="cover" title="Texto y dibujo nuevos">🖼 Rehacer</button>
            </div>
          </div>
        </div>` : ''}
      </div>
    </div>`).join('');
  project.shorts.forEach((s, n) => paint(n, idleAt(n)));
  ctx.$('#pod-shorts').onclick = onClick;
  ctx.$('#pod-shorts').oninput = onInput;
}

// en reposo: la miniatura si la hay (es el primer fotograma); si no, a 0,6 s ya se ve el gancho
const idleAt = (n) => pos[n] || (project.shorts[n].cover ? 0 : 0.6);
const card = (n) => ctx.$(`.pod-short[data-n="${n}"]`);
function showTime(n, t) {
  const c = card(n);
  if (!c) return;
  c.querySelector('.seek').value = t;
  c.querySelector('.tm').textContent = `${fmt(t)} / ${fmt(project.shorts[n].end - project.shorts[n].start)}`;
}

async function paint(n, t) {
  const s = project.shorts[n];
  const canvas = ctx.$(`.pod-short[data-n="${n}"] canvas`);
  if (!canvas) return;
  await preloadShort(s);
  // en pausa al principio se ve la primera viñeta ya montada (sin el gancho tapándola a medias)
  drawComic(canvas.getContext('2d'), s, t, { credit: project.source?.channel });
}

/** Para el que suena; recuerda dónde iba (pausa). */
function stop() {
  if (!playing) return;
  const { n, src, t0, raf } = playing;
  pos[n] = Math.max(0, ac.currentTime - t0);
  src.onended = null;
  try { src.stop(); } catch {}
  cancelAnimationFrame(raf);
  card(n)?.querySelector('.big-play')?.classList.remove('hide');
  const pp = card(n)?.querySelector('.pp');
  if (pp) pp.textContent = '▶';
  playing = null;
}

const applyVolume = () => { if (master) master.gain.value = muted ? 0 : vol; };

// suena la mezcla completa (voz + música + ambientes + golpe); el reloj del audio manda sobre la imagen
async function play(n, from = pos[n] ?? 0) {
  stop();
  const s = project.shorts[n];
  const c = card(n);
  c.querySelector('.big-play').classList.add('hide');
  c.querySelector('.pp').textContent = '⏸';
  try {
    ac ??= new AudioContext();
    if (!master) { master = ac.createGain(); master.connect(ac.destination); applyVolume(); }
    await ac.resume();
    const [buf] = await Promise.all([soundtrack(s), preloadShort(s)]);
    if (from >= buf.duration - 0.1) from = 0;
    const src = ac.createBufferSource();
    src.buffer = buf; src.connect(master);
    const start = ac.currentTime + 0.05;
    const c2 = c.querySelector('canvas').getContext('2d');
    playing = { n, src, t0: start - from, raf: 0 };
    const loop = () => {
      if (playing?.n !== n) return;
      const t = Math.max(0, ac.currentTime - playing.t0);
      drawComic(c2, s, t, { credit: project.source?.channel });
      showTime(n, t);
      playing.raf = requestAnimationFrame(loop);
    };
    src.onended = () => { stop(); pos[n] = 0; showTime(n, 0); paint(n, idleAt(n)); };
    src.start(start, from);
    loop();
  } catch (e) { ctx.toast(`No se pudo reproducir: ${e.message}`, 'bad'); stop(); }
}

/** Saltar a t (sigue sonando si ya sonaba). */
function seek(n, t) {
  pos[n] = t;
  if (playing?.n === n) return play(n, t);
  showTime(n, t);
  paint(n, t);
}

function onInput(e) {
  const n0 = Number(e.target.closest('.pod-short')?.dataset.n);
  if (e.target.classList.contains('seek')) return seek(n0, Number(e.target.value));
  if (e.target.classList.contains('vol')) {
    vol = Number(e.target.value); muted = vol === 0;
    document.querySelectorAll('.pod-ctrl .vol').forEach((x) => { x.value = vol; });
    try { localStorage.setItem('comic.vol', vol); localStorage.setItem('comic.muted', muted ? '1' : '0'); } catch {}
    document.querySelectorAll('.pod-ctrl .mute').forEach((x) => { x.textContent = muted ? '🔇' : '🔊'; });
    return applyVolume();
  }
  const card = e.target.closest('.pod-short');
  if (!card || !e.target.dataset.f) return;
  project.shorts[card.dataset.n][e.target.dataset.f] = e.target.value;
  ctx.save();
  if (!playing) paint(Number(card.dataset.n), 0.5);
}

async function onClick(e) {
  const card = e.target.closest('.pod-short');
  if (!card) return;
  const n = Number(card.dataset.n);
  const s = project.shorts[n];
  const act = e.target.closest('[data-act]')?.dataset.act;
  const panelBtn = e.target.closest('[data-panel]');
  if (panelBtn) return editPanel(n, Number(panelBtn.dataset.panel));
  if (act === 'play') { if (playing?.n === n) stop(); else play(n); }
  if (act === 'mute') {
    muted = !muted;
    try { localStorage.setItem('comic.muted', muted ? '1' : '0'); } catch {}
    document.querySelectorAll('.pod-ctrl .mute').forEach((x) => { x.textContent = muted ? '🔇' : '🔊'; });
    applyVolume();
  }
  if (act === 'copy-yt' || act === 'copy-tt') {
    const yt = act === 'copy-yt';
    // siempre: crédito del audio original y el episodio completo desde ese punto
    const credit = [`🎙 Audio: ${project.source?.channel ?? ''} · ${BRAND}`, continuation(project.source, s.start)];
    const hashtags = (s.hashtags ?? []).map((h) => `#${h.replace(/^#/, '')}`).join(' ');
    await navigator.clipboard.writeText(s.copy ? copyText(yt ? 'youtube' : 'tiktok', s.copy, credit) : [s.caption, hashtags, ...credit].filter(Boolean).join('\n\n'));
    ctx.toast(`Texto para ${yt ? 'YouTube' : 'TikTok'} copiado`, 'ok');
  }
  if (act === 'draw') {
    const todo = s.panels.map((p, i) => (drawn(s) === s.panels.length || !p.image ? i : -1)).filter((i) => i >= 0);
    drawPanels(n, todo);
  }
  if (act === 'export') exportShort(n);
  if (act === 'cover') makeCoverFor(n);
  if (act === 'fx') addFx(n);
}

async function editPanel(n, i) {
  const pn = project.shorts[n].panels[i];
  const desc = await ctx.ask({ title: `Viñeta ${i + 1} (a los ${fmt(pn.t)})`, text: 'Qué tiene que verse. Al aceptar se vuelve a dibujar.', input: true, value: pn.desc, ok: 'Redibujar' });
  if (!desc) return;
  pn.desc = desc;
  ctx.save();
  drawPanels(n, [i]);
}

function drawPanels(n, indices) {
  const s = project.shorts[n];
  ctx.runTask(`Dibujando «${s.title}»`, async (ui) => {
    let done = 0;
    await ctx.streamTo(ui, '/api/podcast/draw', {
      projectId: project.id, n, indices, character: s.character, setting: s.setting,
      panels: s.panels.map(({ t, shot, desc }) => ({ t, shot, desc })),
      ref: s.panels.find((p, i) => p.image && !indices.includes(i))?.image.url ?? null,
    }, (ev) => {
      if (ev.type !== 'panel') return;
      s.panels[ev.i].image = ev.image;
      done++;
      ui.progress(done / indices.length);
      ctx.save();
      render();
    });
    return `${done} viñetas dibujadas`;
  });
}

/** Clímax y ambientes para un short que no los tiene (episodios preparados antes de existir). */
function addFx(n) {
  const s = project.shorts[n];
  ctx.runTask(`Efectos y sonido de «${s.title}»`, async (ui) => {
    const { title, start, end, panels, words } = s;
    const ev = await ctx.streamTo(ui, '/api/podcast/fx', { short: { title, start, end, words, panels: panels.map(({ t, shot, desc }) => ({ t, shot, desc })) } });
    s.fx = ev.data.fx;
    ctx.save();
    render();
    return `Clímax a los ${s.fx.beat.toFixed(1)} s · pulsa ▶ para escucharlo`;
  });
}

/** Miniatura del short (portada noir de Codex + texto a 4K); también es el primer fotograma del MP4. */
function makeCoverFor(n) {
  const s = project.shorts[n];
  ctx.runTask(`Miniatura de «${s.title}»`, async (ui) => {
    const { title, hook, caption, character, setting, panels } = s;
    const ev = await ctx.streamTo(ui, '/api/podcast/cover', { projectId: project.id, n, short: { title, hook, caption, character, setting, panels } });
    s.cover = ev.data;
    ctx.save();
    render();
    return 'Miniatura lista: ya es el primer fotograma del vídeo';
  });
}

async function exportShort(n) {
  if (!canExportFast()) return ctx.toast('Este navegador no puede exportar: usa Chrome o Edge', 'bad');
  stop();
  const s = project.shorts[n];
  ctx.runTask(`Exportando «${s.title}»`, async (ui) => {
    ui.add('🎚️ Mezclando voz, música y efectos…');
    const [buf] = await Promise.all([soundtrack(s), preloadShort(s)]);
    const audio = wavOf(buf);
    const res = await exportVideo({
      width: CW, height: CH, fps: 30, t0: 0, t1: s.end - s.start + 0.3, audio, filename: ctx.slug(`${project.source?.title ?? 'podcast'}-${n + 1}-${s.title}`), signal: ui.signal,
      renderFrame: (c, t) => drawComic(c, s, t, { credit: project.source?.channel }),
      onProgress: (p, info) => { if (info.stage === 'video') ui.progress(p); },
    });
    downloadUrl(res.url, res.file);
    return `MP4 vertical listo (${(res.bytes / 1048576).toFixed(0)} MB): se está descargando`;
  });
}
