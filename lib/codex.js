// Codex CLI (`codex exec`) como segundo motor, con la misma interfaz que el de Claude Code:
// runCodex({ prompt, schema, model, effort, system, cwd, tools }, emit) → emite {type:'log'|'text'|'result'|'error'|'end'}.
import { spawn, execFile } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const CODEX_BIN = process.env.CODEX_BIN || 'codex';
// ---------- puente IPv4 (CODEX_IPV4=1) ----------
// En redes sin salida IPv6 (p. ej. el k3s), Codex intenta las direcciones IPv6 de OpenAI y no vuelve a IPv4.
// La solución: un proxy HTTPS (CONNECT) local, solo en 127.0.0.1 y solo hacia OpenAI/ChatGPT, que conecta por IPv4.
const ALLOWED = /(^|\.)(openai\.com|chatgpt\.com|oaistatic\.com|oaiusercontent\.com)$/i;
let proxyUrl = null;
async function ipv4Proxy() {
  if (process.env.CODEX_IPV4 !== '1') return null;
  if (proxyUrl) return proxyUrl;
  const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, client, head) => {
    const [host, port = '443'] = String(req.url).split(':');
    if (!ALLOWED.test(host) || port !== '443') { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const upstream = net.connect({ host, port: 443, family: 4 }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  proxyUrl = `http://127.0.0.1:${server.address().port}`;
  return proxyUrl;
}
/** Entorno para lanzar Codex (con el puente IPv4 si está activado). */
export async function codexEnv(base = process.env) {
  const proxy = await ipv4Proxy();
  return proxy ? { ...base, HTTPS_PROXY: proxy, https_proxy: proxy, NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' } : base;
}

/** Un CLI instalado como script de Node (p. ej. en el instalador de Windows) se lanza con este mismo Node. */
export const viaNode = (bin, args) => (/\.(c|m)?js$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args]);
// Con una cuenta de ChatGPT, Codex CLI debe elegir su modelo compatible. Solo se
// fuerza un slug cuando el usuario lo configura (normalmente con una API key).
const MODEL = process.env.CODEX_MODEL || '';
const MODEL_LABEL = MODEL || 'modelo predeterminado de Codex';

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
      child = spawn(...viaNode(CODEX_BIN, args), { cwd, env: await codexEnv() });
      // sin opción de prompt de sistema en `exec`: va delante de la tarea
      child.stdin.end(system ? `${system}\n\n---\n\n${prompt}` : prompt);
      emit({ type: 'log', text: `⚙️  Codex listo (${MODEL_LABEL})` });
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
export async function codexStatus() {
  const env = await codexEnv();
  return new Promise((resolve) => execFile(...viaNode(CODEX_BIN, ['login', 'status']), { timeout: 10000, env }, (err, stdout, stderr) => {
    const out = `${stdout}${stderr}`.trim();
    if (err && /ENOENT/.test(err.code ?? err.message)) return resolve({ installed: false, loggedIn: false });
    const key = !!(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY);
    resolve({ installed: true, loggedIn: key || (/logged in/i.test(out) && !/not logged in/i.test(out)), detail: out.split('\n')[0] });
  }));
}

/**
 * Inicia sesión en Codex con la cuenta de ChatGPT.
 * En el mismo ordenador: `codex login` abre el navegador y OpenAI vuelve a localhost.
 * En un servidor (CODEX_DEVICE_AUTH=1): `codex login --device-auth` da un enlace y un código que se escribe en esa página.
 */
export function codexLogin(emit) {
  const base = { ...process.env };
  delete base.CODEX_API_KEY; delete base.OPENAI_API_KEY;
  const device = process.env.CODEX_DEVICE_AUTH === '1';
  let child = null, cancelled = false;
  codexEnv(base).then((env) => {
    if (cancelled) return;
    child = spawn(...viaNode(CODEX_BIN, device ? ['login', '--device-auth'] : ['login']), { env });
    wire(child);
  });
  const wire = (child) => {
    const seen = new Set();
    let out = '';
    const onData = (chunk) => {
      out += String(chunk).replace(/\x1b\[[0-9;]*m/g, '');
      const code = device ? out.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/)?.[0] : null;
      for (const url of out.match(/https:\/\/\S+/g) ?? []) {
        if (seen.has(url) || (device && !code)) continue;
        seen.add(url);
        emit({ type: 'log', text: device ? `Abre la página de OpenAI, entra con tu cuenta de ChatGPT y escribe el código ${code}` : 'Se abre la página de OpenAI: entra con tu cuenta de ChatGPT y autoriza a Codex.', url, code });
      }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60 * 1000);
  child.on('error', (e) => { emit({ type: 'error', message: `No se pudo lanzar Codex: ${e.message}` }); emit({ type: 'end' }); });
  child.on('close', async (code) => {
    clearTimeout(timer);
    const st = await codexStatus();
    // el motivo real (p. ej. un error de conexión), no solo «Not logged in»
    const why = out.split('\n').map((l) => l.trim()).filter((l) => /error/i.test(l)).pop();
    if (code === 0 && st.loggedIn) emit({ type: 'result', data: st });
    else emit({ type: 'error', message: code === null ? 'Se canceló el inicio de sesión' : `No se completó el inicio de sesión: ${why || st.detail || `código ${code}`}` });
    emit({ type: 'end' });
  });
  };
  return () => { cancelled = true; if (child && !child.killed) child.kill('SIGTERM'); };
}
