// Viñetas de cómic dibujadas con la herramienta de imágenes integrada de Codex (image_gen), que usa el plan de
// ChatGPT de la sesión de Codex (sin API key). Codex guarda cada imagen en $CODEX_HOME/generated_images/…;
// de ahí se recoge la nueva y se guarda en el proyecto.
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { CODEX_BIN, viaNode, codexEnv } from '../../lib/codex.js';
import { STYLE } from './podcast.js';

const GEN_DIR = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'generated_images');

async function newestSince(dir, since) {
  if (!existsSync(dir)) return null;
  let best = null;
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { await walk(f); continue; }
      if (!/\.(png|webp|jpe?g)$/i.test(e.name)) continue;
      const st = await stat(f);
      if (st.mtimeMs >= since && (!best || st.mtimeMs > best.t)) best = { f, t: st.mtimeMs };
    }
  };
  await walk(dir);
  return best?.f ?? null;
}

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

/** Dibuja una viñeta. Devuelve la ruta del archivo generado (en GEN_DIR). */
export async function drawPanel({ panel, character, setting, ref }, signal) {
  const work = await mkdtemp(path.join(tmpdir(), 'vineta-'));
  try {
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--json', '-s', 'read-only', '-C', work];
    if (ref) { const r = path.join(work, `referencia${path.extname(ref) || '.png'}`); await copyFile(ref, r); args.push('-i', r); }
    args.push('-');
    const since = Date.now() - 1000;
    const env = await codexEnv();
    let out = '', err = '';
    const code = await new Promise((resolve, reject) => {
      const child = spawn(...viaNode(CODEX_BIN, args), { cwd: work, env });
      signal?.addEventListener('abort', () => child.kill('SIGTERM'));
      child.stdin.end(panelPrompt(panel, character, setting, !!ref));
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      child.on('error', reject);
      child.on('close', resolve);
    });
    // la ruta que Codex anuncia («Saved to: …») o, si no, la imagen más reciente de su carpeta
    const said = out.match(/(\/[^"\s]+generated_images\/[^"\s]+\.(?:png|webp|jpe?g))/i)?.[1];
    const file = (said && existsSync(said) ? said : null) ?? await newestSince(GEN_DIR, since);
    if (!file) {
      const why = [...out.matchAll(/"message":"([^"]{5,300})"/g)].map((m) => m[1]).pop() || err.trim().split('\n').pop() || `código ${code}`;
      throw new Error(`Codex no generó la imagen: ${why}`);
    }
    return file;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

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
