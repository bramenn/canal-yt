// Viñetas de cómic dibujadas con Codex (image_gen, plan de ChatGPT; lib/codeximage.js).
import { readFile } from 'node:fs/promises';
import { generateImage } from '../../lib/codeximage.js';
import { STYLE } from './podcast.js';

const panelPrompt = (p, character, setting, hasRef) => `Genera UNA imagen con tu herramienta integrada de generación de imágenes (image_gen). No uses scripts ni pidas OPENAI_API_KEY. No escribas código.

Viñeta de cómic vertical (formato 2:3, retrato), sin ningún texto, letra, bocadillo ni onomatopeya.
Estilo: ${STYLE}.
Protagonista: ${character}.
Lugar y época: ${setting}.
Plano: ${p.shot}.
Escena: ${p.desc}
La violencia solo se sugiere (sombras, siluetas, reacciones); nada de sangre ni heridas.
${hasRef ? 'La imagen adjunta es SOLO la referencia del personaje y del estilo: mantén IDÉNTICOS al protagonista (cara, pelo, ropa) y el estilo de dibujo y entintado, pero NO copies su fondo, encuadre ni composición: dibuja el lugar y el plano que pide esta escena.' : ''}
Cuando la imagen esté generada, responde solo: listo.`;

/** Dibuja una viñeta. Devuelve la ruta del archivo generado. */
export const drawPanel = ({ panel, character, setting, ref }, signal) => generateImage({ prompt: panelPrompt(panel, character, setting, !!ref), ref }, signal);

/**
 * Dibuja las viñetas `indices` de un short. La primera que salga sirve de referencia a las demás
 * (o `refUrl`, una ya dibujada), para que el protagonista sea el mismo en todo el cómic.
 * body: { projectId, indices, panels, character, setting, ref } → emite { type: 'panel', i, image }.
 */
export async function drawShort(body, store, emit, signal) {
  const log = (text) => emit({ type: 'log', text });
  let ref = body.ref ? store.fileOf(body.ref) : null;
  let ok = 0;
  for (const [k, i] of body.indices.entries()) {
    if (signal?.aborted) break;
    const p = body.panels[i];
    log(`🖌 Viñeta ${i + 1} (${k + 1} de ${body.indices.length}): ${p.desc.slice(0, 90)}…`);
    try {
      const file = await drawPanel({ panel: p, character: body.character, setting: body.setting, ref }, signal);
      const buf = await readFile(file);
      const type = /\.webp$/i.test(file) ? 'image/webp' : /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png';
      const image = await store.save(body.projectId, buf, type, { site: 'Codex (ChatGPT)' });
      emit({ type: 'panel', i, image });
      if (!ref) ref = store.fileOf(image.url);
      ok++;
    } catch (e) {
      log(`⚠️ Viñeta ${i + 1}: ${e.message.slice(0, 200)}`);
      if (/limit|quota|rate|usage/i.test(e.message)) { log('⏸ Parece el límite de uso de tu plan: prueba más tarde con «Dibujar las que faltan».'); break; }
    }
  }
  return { drawn: ok };
}
