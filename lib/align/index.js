// Alineación palabra a palabra del audio de voz (faster-whisper local, lib/align/align.py).
// Da el instante real de cada palabra → escenas, elementos y rótulos caen exactamente cuando se dicen.
// El resultado se guarda junto al mp3 (<audio>.words.json): cada audio se alinea una sola vez.
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const PY = process.env.ALIGN_PYTHON || path.join(ROOT, '.tools', 'venv', 'bin', 'python');
const SCRIPT = path.join(ROOT, 'lib', 'align', 'align.py');
const MODEL = process.env.ALIGN_MODEL || 'small';

let available = null;
export function status() {
  return new Promise((resolve) => {
    if (available !== null) return resolve({ available, model: MODEL });
    execFile(PY, ['-c', 'import faster_whisper, numpy'], (err) => {
      available = !err;
      resolve({ available, model: MODEL, hint: err ? 'Instala el alineador: .tools/venv/bin/pip install faster-whisper' : undefined });
    });
  });
}

/**
 * items: [{ index, file (ruta absoluta del mp3), prompt (texto que se dijo) }]
 * Devuelve [{ index, words: [{w,s,e,p}], duration }]. Usa la caché si existe.
 */
export async function align(items, onProgress, signal) {
  const out = [];
  const todo = [];
  for (const it of items) {
    const cache = `${it.file}.words.json`;
    if (existsSync(cache)) {
      out.push({ index: it.index, ...JSON.parse(await readFile(cache, 'utf8')), cached: true });
      onProgress?.(`♻️  Segmento ${it.index + 1}: ya alineado`);
    } else todo.push(it);
  }
  if (todo.length) {
    onProgress?.(`🎧 Escuchando ${todo.length} audio(s) con Whisper (${MODEL}) para medir cada palabra…`);
    const res = await new Promise((resolve, reject) => {
      const child = spawn(PY, [SCRIPT]);
      signal?.addEventListener('abort', () => child.kill('SIGTERM'));
      let stdout = '', stderr = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => {
        stderr += c;
        for (const line of String(c).split('\n')) {
          const m = line.match(/^alineado (.*)$/);
          if (m) { const it = todo.find((x) => x.file === m[1]); if (it) onProgress?.(`✅ Segmento ${it.index + 1} alineado`); }
        }
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`El alineador falló: ${stderr.split('\n').filter(Boolean).slice(-2).join(' ')}`));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Respuesta del alineador no válida')); }
      });
      child.stdin.end(JSON.stringify({ model: MODEL, items: todo.map((x) => ({ file: x.file, prompt: x.prompt })) }));
    });
    for (const r of res) {
      const it = todo.find((x) => x.file === r.file);
      await writeFile(`${r.file}.words.json`, JSON.stringify({ words: r.words, duration: r.duration }));
      out.push({ index: it.index, words: r.words, duration: r.duration });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}
