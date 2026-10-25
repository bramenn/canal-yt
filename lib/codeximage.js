// Imágenes con la herramienta integrada de Codex (image_gen), con el plan de ChatGPT de la sesión de Codex (sin API
// key), común a las apps. Codex guarda cada imagen en $CODEX_HOME/generated_images/…; de ahí se recoge la nueva.
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { CODEX_BIN, viaNode, codexEnv } from './codex.js';

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

/** Genera una imagen con `prompt` (y `ref`, imagen de referencia opcional). Devuelve la ruta del archivo (en GEN_DIR). */
export async function generateImage({ prompt, ref }, signal) {
  const work = await mkdtemp(path.join(tmpdir(), 'codex-img-'));
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
      // sin red se queda colgado para siempre: quien llama ya tiene plan B (toma del tráiler)
      const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60000);
      child.on('close', () => clearTimeout(timer));
      child.stdin.end(prompt);
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

