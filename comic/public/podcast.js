// Vista de un proyecto «Podcast → Shorts»: una tarjeta por short con vista previa vertical (voz original),
// gancho editable, tira de viñetas (editar y redibujar), dibujar con Codex, exportar MP4 y copiar el texto para TikTok.
import { drawComic, preloadShort, CW, CH, BRAND } from './comic.js';
import { soundtrack, wavOf } from './sound.js';
import { exportVideo, canExportFast, downloadUrl } from '/shared/exporter.js';

let ctx = null;          // utilidades de app.js: { $, esc, toast, ask, runTask, streamTo, save, slug }
let project = null;
let playing = null;      // { n, src, raf }
let ac = null;           // AudioContext de la vista previa

export function openPodcast(p, helpers) {
  ctx = helpers;
  project = p;
  stop();
  render();
}
export const closePodcast = () => stop();

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const drawn = (s) => (s.panels ?? []).filter((x) => x.image).length;

function render() {
  const { $, esc } = ctx;
  const src = project.source ?? {};
  $('#pod-head').innerHTML = `<h1 class="video-title">${esc(src.title ?? 'Podcast')}</h1>
    <p class="hint">🎙 ${esc(src.channel ?? '')} · ${fmt(src.duration ?? 0)} · <a href="${esc(src.url ?? '#')}" target="_blank" rel="noopener">ver episodio</a> · ${project.shorts.length} shorts</p>`;
  $('#pod-shorts').innerHTML = project.shorts.map((s, n) => `
    <div class="pod-short" data-n="${n}">
      <div class="pod-preview"><canvas width="${CW}" height="${CH}"></canvas><button class="big-play" data-act="play" title="Reproducir">▶</button></div>
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
          <button data-act="copy">📋 Texto para TikTok</button>
        </div>
      </div>
    </div>`).join('');
  project.shorts.forEach((s, n) => paint(n, 0.6)); // a 0,6 s ya se ve el gancho
  ctx.$('#pod-shorts').onclick = onClick;
  ctx.$('#pod-shorts').oninput = onInput;
}

async function paint(n, t) {
  const s = project.shorts[n];
  const canvas = ctx.$(`.pod-short[data-n="${n}"] canvas`);
  if (!canvas) return;
  await preloadShort(s);
  // en pausa al principio se ve la primera viñeta ya montada (sin el gancho tapándola a medias)
  drawComic(canvas.getContext('2d'), s, t, { credit: project.source?.channel });
}

function stop() {
  if (!playing) return;
  playing.src.onended = null;
  try { playing.src.stop(); } catch {}
  cancelAnimationFrame(playing.raf);
  ctx?.$(`.pod-short[data-n="${playing.n}"] .big-play`)?.classList.remove('hide');
  playing = null;
}

// suena la mezcla completa (voz + música + ambientes + golpe); el reloj del audio manda sobre la imagen
async function play(n) {
  if (playing?.n === n) return stop();
  stop();
  const s = project.shorts[n];
  const btn = ctx.$(`.pod-short[data-n="${n}"] .big-play`);
  btn.classList.add('hide');
  try {
    ac ??= new AudioContext();
    await ac.resume();
    const [buf] = await Promise.all([soundtrack(s), preloadShort(s)]);
    const src = ac.createBufferSource();
    src.buffer = buf; src.connect(ac.destination);
    const c2 = ctx.$(`.pod-short[data-n="${n}"] canvas`).getContext('2d');
    const t0 = ac.currentTime + 0.05;
    playing = { n, src, raf: 0 };
    const loop = () => {
      drawComic(c2, s, Math.max(0, ac.currentTime - t0), { credit: project.source?.channel });
      if (playing?.n === n) playing.raf = requestAnimationFrame(loop);
    };
    src.onended = () => { stop(); paint(n, 0.6); };
    src.start(t0);
    loop();
  } catch (e) { ctx.toast(`No se pudo reproducir: ${e.message}`, 'bad'); btn.classList.remove('hide'); stop(); }
}

function onInput(e) {
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
  if (act === 'play') play(n);
  if (act === 'copy') {
    await navigator.clipboard.writeText(`${s.caption}\n\n${(s.hashtags ?? []).map((h) => `#${h.replace(/^#/, '')}`).join(' ')}\n\n🎙 Audio: ${project.source?.channel ?? ''} · ${BRAND}`);
    ctx.toast('Texto para TikTok copiado', 'ok');
  }
  if (act === 'draw') {
    const todo = s.panels.map((p, i) => (drawn(s) === s.panels.length || !p.image ? i : -1)).filter((i) => i >= 0);
    drawPanels(n, todo);
  }
  if (act === 'export') exportShort(n);
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
