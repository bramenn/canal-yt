// Compartido por los servidores del estudio: lanzar la IA en modo headless (Claude Code o Codex CLI) y utilidades HTTP (SSE, JSON).
import { spawn, execFile } from 'node:child_process';
import { runCodex, codexStatus, viaNode } from './codex.js';
import path from 'node:path';
import { tmpdir } from 'node:os';

export const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// ---------- Claude Code runner ----------

function describeTool(name, input = {}) {
  if (name === 'WebSearch') return `🔎 Buscando: ${input.query ?? ''}`;
  if (name === 'WebFetch') return `📄 Leyendo: ${input.url ?? ''}`;
  if (name === 'StructuredOutput') return '✍️  Escribiendo resultado final…';
  if (name === 'Read') return `📚 Estudiando referencia: ${path.basename(input.file_path ?? '')}`;
  if (name === 'Glob' || name === 'Grep') return '📚 Revisando referencias…';
  return `🛠  ${name}`;
}

/**
 * Lanza `claude -p` y emite eventos {type:'log'|'text'|'result'|'error'} via `emit`.
 * Devuelve una función para cancelar el proceso.
 */
function runClaudeCode({ prompt, schema, model, effort, system, cwd, tools = ['WebSearch', 'WebFetch'] }, emit) {
  const args = [
    '-p',
    '--output-format', 'stream-json', '--verbose',
    '--json-schema', JSON.stringify(schema),
    '--system-prompt', system,
    '--no-session-persistence',
    '--tools', tools.join(','),
  ];
  if (tools.length) args.push('--allowedTools', ...tools);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);

  const child = spawn(...viaNode(CLAUDE_BIN, args), { cwd, env: process.env });
  child.stdin.end(prompt);

  let buf = '';
  let stderr = '';
  let done = false;
  const started = Date.now();

  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!raw) continue;
      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }
      handle(ev);
    }
  });
  child.stderr.on('data', (c) => { stderr += c; });

  function handle(ev) {
    if (ev.type === 'system' && ev.subtype === 'init') {
      emit({ type: 'log', text: `⚙️  Claude Code listo (${ev.model ?? model ?? 'modelo por defecto'})` });
    } else if (ev.type === 'assistant') {
      for (const block of ev.message?.content ?? []) {
        if (block.type === 'tool_use') emit({ type: 'log', text: describeTool(block.name, block.input) });
        else if (block.type === 'text' && block.text?.trim()) emit({ type: 'text', text: block.text.trim().slice(0, 400) });
      }
    } else if (ev.type === 'result') {
      done = true;
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      if (ev.is_error || !ev.structured_output) {
        let data = null;
        try { data = JSON.parse(ev.result); } catch {}
        if (data && !ev.is_error) emit({ type: 'result', data, cost: ev.total_cost_usd, secs });
        else emit({ type: 'error', message: ev.result || ev.subtype || 'Claude Code no devolvió resultado' });
      } else {
        emit({ type: 'result', data: ev.structured_output, cost: ev.total_cost_usd, secs });
      }
    }
  }

  child.on('error', (err) => {
    done = true;
    emit({ type: 'error', message: `No se pudo lanzar "${CLAUDE_BIN}": ${err.message}` });
  });
  child.on('close', (code) => {
    if (!done) emit({ type: 'error', message: `Claude Code terminó (código ${code}). ${stderr.slice(-600)}` });
    emit({ type: 'end' });
  });

  return () => { if (!child.killed) child.kill('SIGTERM'); };
}

// ---------- Antigravity (agy): respaldo cuando Codex se queda sin cuota ----------
export const AGY_BIN = process.env.AGY_BIN || 'agy';
/**
 * Lanza `agy` en modo print: el texto va por stdin en stream-json (sin límite de tamaño, a diferencia de un argumento)
 * y la respuesta llega validada con el esquema. Sin herramientas de terminal (--sandbox): solo redacta.
 */
function runAgy({ prompt, schema, system, effort }, emit) {
  const model = process.env.AGY_MODEL || `gemini-4-argon-${['low', 'medium', 'high'].includes(effort) ? effort : 'medium'}`;
  const args = ['-p=', '--input-format', 'stream-json', '--output-format', 'stream-json', '--sandbox', '--model', model];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  // AGY_HOME: carpeta persistente con su sesión (en el clúster, en el disco de datos; si no, la del usuario)
  const child = spawn(AGY_BIN, args, { cwd: tmpdir(), env: process.env.AGY_HOME ? { ...process.env, HOME: process.env.AGY_HOME } : process.env });
  child.stdin.end(`${JSON.stringify({ event: 'user', message: { content: system ? `${system}\n\n${prompt}` : prompt } })}\n`);
  emit({ type: 'log', text: `⚙️  Antigravity listo (${model})` });
  let buf = '', stderr = '', done = false;
  const started = Date.now();
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }
      if (ev.event !== 'result') continue;
      done = true;
      const r = ev.result ?? {};
      let data = r.structured_output ?? null;
      if (data == null && r.response) { try { data = JSON.parse(r.response); } catch { data = r.response; } }
      if (r.status === 'SUCCESS' && data != null) emit({ type: 'result', data, cost: 0, secs: ((Date.now() - started) / 1000).toFixed(0) });
      else emit({ type: 'error', message: `Antigravity: ${r.error || r.status || 'sin resultado'}` });
    }
  });
  child.stderr.on('data', (c) => { stderr += c; });
  child.on('error', (err) => { done = true; emit({ type: 'error', message: `No se pudo lanzar "${AGY_BIN}": ${err.message}` }); });
  child.on('close', (code) => {
    if (!done) emit({ type: 'error', message: `Antigravity terminó (código ${code}). ${stderr.slice(-400)}` });
    emit({ type: 'end' });
  });
  return () => { if (!child.killed) child.kill('SIGTERM'); };
}

// ---------- motor: Codex CLI (predeterminado exclusivo) ----------
export const ENGINES = ['codex', 'auto', 'claude', 'agy'];
let engine = ENGINES.includes(process.env.AI_ENGINE) ? process.env.AI_ENGINE : 'codex';
export const getEngine = () => engine;
export const setEngine = (e) => { if (ENGINES.includes(e)) engine = e; return engine; };

/** Lanza la IA con el motor elegido. Por defecto Codex exclusivo, sin fallback oculto a Claude. */
export function runClaude(opts, emit) {
  const mode = opts.engine || engine;
  if (mode === 'claude') return runClaudeCode(opts, emit);
  if (mode === 'agy') return runAgy(opts, emit);
  // Modo 'codex' (predeterminado): ejecuta directamente Codex sin derivar tareas a Claude Code
  return runCodex(opts, emit);
}

/** ¿Qué motores hay instalados y con sesión? */
export async function enginesStatus() {
  const claude = await new Promise((resolve) => execFile(...viaNode(CLAUDE_BIN, ['auth', 'status']), { timeout: 10000 }, (err, stdout) => {
    if (err && /ENOENT/.test(String(err.code ?? err.message))) return resolve({ installed: false, loggedIn: false });
    // con token o API key en el entorno también vale, aunque no haya sesión iniciada en el CLI
    const key = !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
    try { resolve({ installed: true, loggedIn: key || !!JSON.parse(stdout).loggedIn }); } catch { resolve({ installed: true, loggedIn: key || !err }); }
  }));
  return { engine, claude, codex: await codexStatus() };
}

/** runClaude como promesa: reenvía el progreso y resuelve con el evento 'result'. */
export function claudeStep(opts, emit, track, run = runClaude) {
  // Codex sin cuota de ChatGPT («usage limit») a mitad de un vídeo: el resto del trabajo sigue con el respaldo
  // (AI_FALLBACK: Antigravity por defecto; Claude si así se configura)
  return stepOnce(opts, emit, track, run).catch(async (e) => {
    // Codex colgado sin red: un reintento cuando vuelva la conexión
    if (/no respondió en/.test(e.message)) {
      emit({ type: 'log', text: `⚠️ ${e.message.slice(0, 120)}: reintento` });
      return stepOnce(opts, emit, track, run);
    }
    const fallback = process.env.AI_FALLBACK || 'agy';
    if (run !== runClaude || [opts.engine, engine].includes(fallback) || !/usage limit/i.test(e.message)) throw e;
    emit({ type: 'log', text: `⚠️ Codex sin cuota: sigo con ${fallback === 'agy' ? 'Antigravity' : 'Claude'}` });
    return stepOnce({ ...opts, engine: fallback }, emit, track, run);
  });
}

function stepOnce(opts, emit, track, run) {
  return new Promise((resolve, reject) => {
    let done = false;
    const cancel = run(opts, (ev) => {
      if (ev.type === 'end') { if (!done) reject(new Error('El motor de IA terminó sin resultado')); return; }
      if (ev.type === 'result') { done = true; return resolve(ev); }
      if (ev.type === 'error') { done = true; return reject(new Error(ev.message)); }
      emit(ev);
    });
    track(cancel);
  });
}
export const codexStep = claudeStep;
export const aiStep = claudeStep;

// ---------- HTTP ----------

export function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

export async function readRaw(req, limit = 80 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('Archivo demasiado grande (máx. 80 MB)'); chunks.push(c); }
  return Buffer.concat(chunks);
}

export async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export function sse(res, job) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const emit = (ev) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); if (ev.type === 'end') res.end(); };
  const ping = setInterval(() => emit({ type: 'ping' }), 15000);
  const cancel = job(emit);
  res.on('close', () => { clearInterval(ping); cancel(); });
}
