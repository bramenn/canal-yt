// Lo común a las apps web (fútbol, cómic): estáticos con caché, IP del visitante y la puerta de acceso
// (login, sesión, contraseña y usuarios). Cada app sirve su propio login.html y app.css desde su carpeta public/.
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { sendJSON, readBody } from './claude.js';
import { login, startSession, endSession, userOf, sameOrigin, createUser, setPassword, listUsers, deleteUser } from './auth.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.jpg': 'image/jpeg' };

export async function serveStatic(req, res, file) {
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) return sendJSON(res, 404, { error: 'not found' });
  // el navegador guarda la copia y pregunta si cambió: «304» sin cuerpo si sigue igual
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag });
  res.end(await readFile(file));
}

/** Estáticos por prefijo ({ '/shared/': carpeta, '/': carpeta }), sin salirse de la carpeta. */
export function serveFrom(req, res, p, dirs) {
  const prefix = Object.keys(dirs).find((k) => p.startsWith(k));
  const base = dirs[prefix];
  const file = path.normalize(path.join(base, p === '/' ? 'index.html' : decodeURIComponent(p.slice(prefix.length))));
  if (!file.startsWith(base)) return sendJSON(res, 403, { error: 'forbidden' });
  return serveStatic(req, res, file);
}

// el servidor solo escucha en 127.0.0.1: si hay un proxy delante (ngrok), la IP real es la ÚLTIMA de X-Forwarded-For
// (la añade el proxy; las anteriores las puede inventar quien hace la petición)
// con CLIENT_IP_HEADER (p. ej. cf-connecting-ip detrás de Cloudflare) se usa esa cabecera, que pone el proxy de confianza
export const clientIp = (req) => (process.env.CLIENT_IP_HEADER && String(req.headers[process.env.CLIENT_IP_HEADER.toLowerCase()] ?? '').trim())
  || String(req.headers['x-forwarded-for'] ?? '').split(',').pop().trim() || req.socket.remoteAddress;

/**
 * Puerta de acceso. Atiende el login, la sesión, la contraseña y los usuarios; devuelve el usuario de la sesión
 * o null si ya respondió (petición resuelta aquí, sin sesión u otro origen). `publicDir`: login.html, app.css, favicon.
 */
export async function gate(req, res, p, publicDir) {
  if (!sameOrigin(req)) { sendJSON(res, 403, { error: 'Petición de otro origen' }); return null; }
  if (p === '/login' || p === '/login.html') { await serveStatic(req, res, path.join(publicDir, 'login.html')); return null; }
  if (p === '/app.css' || p === '/favicon.ico') { await serveStatic(req, res, path.join(publicDir, p.slice(1))); return null; }
  if (p === '/api/login' && req.method === 'POST') {
    const b = await readBody(req);
    try {
      const u = await login(b.username, b.password, clientIp(req));
      await startSession(res, req, u.id);
      sendJSON(res, 200, { username: u.username, isAdmin: u.isAdmin });
    } catch (e) { sendJSON(res, 401, { error: e.message }); }
    return null;
  }
  if (p === '/api/logout' && req.method === 'POST') { await endSession(res, req); sendJSON(res, 200, { ok: true }); return null; }

  const user = await userOf(req);
  if (!user) {
    if (p.startsWith('/api/')) sendJSON(res, 401, { error: 'Inicia sesión' });
    else { res.writeHead(302, { Location: '/login' }); res.end(); }
    return null;
  }
  if (p === '/api/me') { sendJSON(res, 200, user); return null; }
  if (p === '/api/password' && req.method === 'POST') {
    const b = await readBody(req);
    try {
      await login(user.username, b.current, clientIp(req)); // la actual tiene que ser correcta
      await setPassword(user.id, b.next);
      await startSession(res, req, user.id); // las demás sesiones se cierran; esta sigue
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendJSON(res, 400, { error: e.message.replace('Usuario o contraseña incorrectos', 'La contraseña actual no es correcta') }); }
    return null;
  }
  // ---- usuarios (administrador) ----
  let m;
  if (p === '/api/users' || /^\/api\/users\/\d+$/.test(p)) {
    if (!user.isAdmin) { sendJSON(res, 403, { error: 'Solo el administrador puede cambiar esto' }); return null; }
    if (p === '/api/users' && req.method === 'GET') sendJSON(res, 200, await listUsers());
    else if (p === '/api/users' && req.method === 'POST') {
      const b = await readBody(req);
      try { await createUser(b.username, b.password, !!b.isAdmin); sendJSON(res, 200, await listUsers()); }
      catch (e) { sendJSON(res, 400, { error: e.message }); }
    } else if ((m = p.match(/^\/api\/users\/(\d+)$/)) && req.method === 'DELETE') {
      if (Number(m[1]) === user.id) sendJSON(res, 400, { error: 'No puedes borrarte a ti mismo' });
      else { await deleteUser(Number(m[1])); sendJSON(res, 200, await listUsers()); }
    } else sendJSON(res, 405, { error: 'Método no admitido' });
    return null;
  }
  return user;
}
