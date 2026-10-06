// Cliente del servidor local. Las tareas de IA llegan como eventos SSE desde Claude Code.

export async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

export async function postJSON(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

/**
 * Lanza una tarea y va llamando a onEvent con cada evento ({type:'log'|'text'|'result'|'error'}).
 * Resuelve con el evento 'result'. Se cancela con signal (el servidor mata el proceso de Claude Code).
 */
export async function stream(url, body, onEvent, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`El servidor respondió ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let result = null;
  let error = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!chunk.startsWith('data: ')) continue;
      let ev;
      try { ev = JSON.parse(chunk.slice(6)); } catch { continue; }
      if (ev.type === 'ping') continue;
      if (ev.type === 'result') result = ev;
      if (ev.type === 'error') error = ev.message;
      onEvent?.(ev);
    }
  }
  if (result) return result;
  throw new Error(error || 'Claude Code terminó sin resultado');
}
