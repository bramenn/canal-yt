// Codex CLI (`codex exec`) como segundo motor, con la misma interfaz que el de Claude Code:
// runCodex({ prompt, schema, model, effort, system, cwd, tools }, emit) → emite {type:'log'|'text'|'result'|'error'|'end'}.
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const CODEX_BIN = process.env.CODEX_BIN || 'codex';
/** Un CLI instalado como script de Node (p. ej. en el instalador de Windows) se lanza con este mismo Node. */
export const viaNode = (bin, args) => (/\.(c|m)?js$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args]);
// los modelos de Claude no existen en Codex: solo se pasa el modelo si se fija a mano
const MODEL = process.env.CODEX_MODEL || '';

/** Esquema "estricto" de OpenAI: todos los objetos cerrados y todas sus propiedades obligatorias. */
export function strictSchema(s) {
  if (Array.isArray(s)) return s.map(strictSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, strictSchema(pv)])) : strictSchema(v);
  if (out.type === 'object' && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}

// Claude abre las imágenes con su herramienta Read; Codex las necesita adjuntas: las que el prompt nombre y existan en cwd
function imagesIn(prompt, cwd) {
  const names = new Set(String(prompt).match(/[\w.-]+\.(?:jpe?g|png|webp)\b/gi) ?? []);
  return [...names].map((n) => path.join(cwd, n)).filter((f) => existsSync(f));
}

function describe(item) {
  if (item.type === 'web_search') return `🔎 Buscando: ${item.query ?? ''}`;
  if (item.type === 'command_execution') return `📚 ${String(item.command ?? '').slice(0, 120)}`;
  if (item.type === 'file_change') return null;
  return null;
}

export function runCodex({ prompt, schema, model, effort, system, cwd = process.cwd(), tools = ['WebSearch', 'WebFetch'] }, emit) {
  let child = null, cancelled = false, done = false;
  const started = Date.now();
  (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'codex-'));
    try {
      const schemaFile = path.join(dir, 'schema.json');
      const outFile = path.join(dir, 'out.json');
      await writeFile(schemaFile, JSON.stringify(strictSchema(schema)));
      const args = [];
      if (tools.some((t) => /^Web/.test(t))) args.push('--search');
      args.push('exec', '--skip-git-repo-check', '--ephemeral', '--json', '-s', 'read-only', '-C', cwd, '--output-schema', schemaFile, '-o', outFile);
      if (MODEL) args.push('-m', MODEL);
      if (effort) args.push('-c', `model_reasoning_effort="${effort === 'max' ? 'high' : effort}"`);
      if (tools.includes('Read')) for (const img of imagesIn(prompt, cwd)) args.push('-i', img);
      args.push('-');
      child = spawn(...viaNode(CODEX_BIN, args), { cwd, env: process.env });
      // sin opción de prompt de sistema en `exec`: va delante de la tarea
      child.stdin.end(system ? `${system}\n\n---\n\n${prompt}` : prompt);
      emit({ type: 'log', text: '⚙️  Codex listo' });
      let buf = '', stderr = '', lastError = '';
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const raw = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          let ev;
          try { ev = JSON.parse(raw); } catch { continue; }
          if (ev.type === 'item.completed' || ev.type === 'item.started') {
            const text = ev.type === 'item.started' ? describe(ev.item ?? {}) : null;
            if (text) emit({ type: 'log', text });
          } else if (ev.type === 'error') lastError = ev.message ?? lastError;
          else if (ev.type === 'turn.failed') lastError = ev.error?.message ?? lastError;
        }
      });
      child.stderr.on('data', (c) => { stderr += c; });
      const code = await new Promise((resolve) => { child.on('close', resolve); child.on('error', (e) => { lastError = `No se pudo lanzar "${CODEX_BIN}": ${e.message}`; resolve(-1); }); });
      if (cancelled) return;
      let data = null;
      try { data = JSON.parse(await readFile(outFile, 'utf8')); } catch {}
      done = true;
      if (data && code === 0) emit({ type: 'result', data, cost: 0, secs: ((Date.now() - started) / 1000).toFixed(0), engine: 'codex' });
      else {
        const why = lastError || stderr.trim().split('\n').pop() || `terminó con código ${code}`;
        emit({ type: 'error', message: /401|unauthorized|not logged in/i.test(why) ? 'Codex no tiene la sesión iniciada: en una terminal ejecuta «codex login»' : `Codex: ${why}`.slice(0, 600) });
      }
    } catch (e) {
      if (!done) emit({ type: 'error', message: `Codex: ${e.message}` });
    } finally {
      await rm(dir, { recursive: true, force: true });
      emit({ type: 'end' });
    }
  })();
  return () => { cancelled = true; if (child && !child.killed) child.kill('SIGTERM'); };
}

/** ¿Instalado y con sesión? */
export function codexStatus() {
  return new Promise((resolve) => execFile(...viaNode(CODEX_BIN, ['login', 'status']), { timeout: 10000 }, (err, stdout, stderr) => {
    const out = `${stdout}${stderr}`.trim();
    if (err && /ENOENT/.test(err.code ?? err.message)) return resolve({ installed: false, loggedIn: false });
    const key = !!(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY);
    resolve({ installed: true, loggedIn: key || (/logged in/i.test(out) && !/not logged in/i.test(out)), detail: out.split('\n')[0] });
  }));
}

/** Inicia sesión en Codex con la cuenta de ChatGPT: lanza `codex login` (abre el navegador) y avisa del enlace por si no se abre. */
export function codexLogin(emit) {
  const env = { ...process.env };
  delete env.CODEX_API_KEY; delete env.OPENAI_API_KEY;
  const child = spawn(...viaNode(CODEX_BIN, ['login']), { env });
  const seen = new Set();
  const onData = (chunk) => {
    for (const url of String(chunk).match(/https:\/\/\S+/g) ?? []) {
      if (seen.has(url)) continue;
      seen.add(url);
      emit({ type: 'log', text: 'Se abre la página de OpenAI: entra con tu cuenta de ChatGPT y autoriza a Codex.', url });
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60 * 1000);
  child.on('error', (e) => { emit({ type: 'error', message: `No se pudo lanzar Codex: ${e.message}` }); emit({ type: 'end' }); });
  child.on('close', async (code) => {
    clearTimeout(timer);
    const st = await codexStatus();
    if (code === 0 && st.loggedIn) emit({ type: 'result', data: st });
    else emit({ type: 'error', message: code === null ? 'Se canceló el inicio de sesión' : `No se completó el inicio de sesión (${st.detail || `código ${code}`})` });
    emit({ type: 'end' });
  });
  return () => { clearTimeout(timer); if (!child.killed) child.kill('SIGTERM'); };
}
