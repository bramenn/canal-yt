// Catálogo visual de fotos de negocios: identidad, encuadre y foco para el recorte vertical.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { run } from '../../lib/ytdlp.js';
import { claudeStep } from '../../lib/claude.js';
import { dhash } from '../../lib/editor.js';

const ff = (args) => run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], 120000);
const focus = (v) => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;

/** Una entrada por archivo. La búsqueda ya fue filtrada; aquí se describe el contenido real, no solo la consulta. */
export async function catalogPhotos(photos, context, dir, log, signal) {
  const catalog = [];
  for (let b = 0; b < photos.length; b += 12) {
    signal?.throwIfAborted();
    const batch = photos.slice(b, b + 12);
    const signatures = await Promise.all(batch.map(async (p) => {
      const st = await stat(p.file);
      return `${p.file}:${p.query}:${st.size}:${st.mtimeMs}`;
    }));
    const hash = createHash('sha256').update(JSON.stringify([context, signatures])).digest('hex').slice(0, 16);
    const tag = path.join(dir, `photos-v1-${hash}`);
    let data = await readFile(`${tag}.json`, 'utf8').then(JSON.parse).catch(() => null);
    if (!data) {
      for (const [i, p] of batch.entries()) {
        await ff(['-i', p.file, '-frames:v', '1', '-vf', `scale=320:220:force_original_aspect_ratio=decrease,pad=320:220:(ow-iw)/2:(oh-ih)/2,drawtext=text='${i + 1}':x=6:y=4:fontsize=30:fontcolor=yellow:box=1:boxcolor=black@0.75:boxborderw=4`, `${tag}-${String(i).padStart(2, '0')}.jpg`]);
      }
      await ff(['-framerate', '1', '-i', `${tag}-%02d.jpg`, '-vf', `tile=4x${Math.ceil(batch.length / 4)}:padding=4:color=white`, '-frames:v', '1', `${tag}.jpg`]);
      try {
        const ev = await claudeStep({
          prompt: `Lee ${path.basename(tag)}.jpg: fotos numeradas de una historia de negocios. Contexto: ${context}.
Describe lo que realmente se ve, no lo que esperas por la búsqueda. Consultas: ${batch.map((p, i) => `${i + 1}: ${p.query}`).join(' · ')}.
Para CADA foto devuelve n, desc (máximo 15 palabras), who (persona reconocible, o vacío), shot (primer plano, plano medio, general o detalle), emotion, focusX y focusY (0-1: punto del ORIGINAL que debe permanecer visible en un recorte 9:16; prioriza la cara o el producto), hook (si funciona como gancho potente y nítido), bad (persona/marca equivocada, imagen ilegible, texto o marca de agua dominante). Los logos auténticos y fotos históricas son válidos. No inventes identidades.`,
          system: 'Eres editor gráfico de vídeos de negocios. Inspeccionas cada foto con visión.',
          schema: { type: 'object', properties: { photos: { type: 'array', items: { type: 'object', properties: {
            n: { type: 'integer' }, desc: { type: 'string' }, who: { type: 'string' }, shot: { type: 'string' }, emotion: { type: 'string' },
            focusX: { type: 'number' }, focusY: { type: 'number' }, hook: { type: 'boolean' }, bad: { type: 'boolean' },
          }, required: ['n', 'desc', 'who', 'shot', 'emotion', 'focusX', 'focusY', 'hook', 'bad'] } } }, required: ['photos'] },
          model: 'sonnet', effort: 'low', tools: ['Read'], cwd: dir,
        }, () => {}, () => {});
        data = ev.data;
        await writeFile(`${tag}.json`, JSON.stringify(data));
      } catch (e) {
        log(`⚠️ Sin catálogo visual: ${e.message.slice(0, 100)}; uso las fotos ya verificadas`);
        data = { photos: [] };
      }
    }
    for (const [i, p] of batch.entries()) {
      const d = data.photos?.find((x) => x.n === i + 1);
      if (d?.bad) continue;
      catalog.push({ ...p, kind: 'image', desc: d?.desc || `Foto verificada: ${p.query}`, who: d?.who || '', shot: d?.shot || 'foto',
        emotion: d?.emotion || '', focusX: focus(d?.focusX), focusY: focus(d?.focusY), action: 0,
        ...(d?.hook ? { thumb: 1 } : {}), hash: await dhash(p.file) });
    }
  }
  log(`👀 Catálogo: ${catalog.length} fotos descritas y revisadas`);
  return catalog;
}
