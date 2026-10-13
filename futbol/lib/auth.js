// Login con usuario y contraseña.
// - Contraseñas: scrypt con sal aleatoria (node:crypto), comparación en tiempo constante.
// - Sesiones: token aleatorio de 32 bytes en una cookie HttpOnly + SameSite=Lax (+ Secure si se entra por https);
//   en la base de datos solo se guarda su SHA-256, así que una copia de la base no permite entrar.
// - Fuerza bruta: tras 5 fallos seguidos (por usuario o por IP) hay que esperar 15 minutos.
// - Peticiones que cambian algo: el Origin tiene que ser esta misma web (otra página no puede actuar en tu nombre).
import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { q } from './db.js';

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_DAYS = 30;
const COOKIE = 'sid';

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(String(password).normalize('NFKC'), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scryptAsync(String(password).normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return timingSafeEqual(key, expected);
}

export function checkPasswordStrength(password) {
  if (String(password).length < 10) return 'La contraseña tiene que tener al menos 10 caracteres';
  return null;
}

// ---------- usuarios ----------
export async function createUser(username, password, isAdmin = false) {
  const name = String(username).trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(name)) throw new Error('El usuario: 3-32 caracteres (letras, números, punto, guion)');
  const weak = checkPasswordStrength(password);
  if (weak) throw new Error(weak);
  const { rows } = await q('INSERT INTO users (username, pass_hash, is_admin) VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING RETURNING id', [name, await hashPassword(password), isAdmin]);
  if (!rows.length) throw new Error(`Ya existe el usuario «${name}»`);
  return rows[0].id;
}

export async function setPassword(userId, password) {
  const weak = checkPasswordStrength(password);
  if (weak) throw new Error(weak);
  await q('UPDATE users SET pass_hash = $2 WHERE id = $1', [userId, await hashPassword(password)]);
  // cambiar la contraseña cierra todas las sesiones de ese usuario
  await q('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

export const listUsers = async () => (await q('SELECT id, username, is_admin, created_at FROM users ORDER BY id')).rows;
export const deleteUser = (id) => q('DELETE FROM users WHERE id = $1', [id]);
export const countUsers = async () => (await q('SELECT count(*)::int AS n FROM users')).rows[0].n;

// ---------- intentos fallidos ----------
const fails = new Map(); // clave → { n, until }
const LIMIT = 5, LOCK_MS = 15 * 60 * 1000;
const locked = (k) => { const f = fails.get(k); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0; };
function fail(k) {
  const f = fails.get(k) ?? { n: 0, until: 0 };
  f.n++;
  if (f.n >= LIMIT) { f.until = Date.now() + LOCK_MS; f.n = 0; }
  fails.set(k, f);
}

// hash de una contraseña que no existe: el tiempo de respuesta es el mismo exista o no el usuario
const DUMMY = await hashPassword(randomBytes(16).toString('hex'));

/** Comprueba usuario y contraseña. Devuelve el usuario o lanza un error con un mensaje para mostrar. */
export async function login(username, password, ip) {
  const name = String(username ?? '').trim().toLowerCase();
  const wait = Math.max(locked(`u:${name}`), locked(`ip:${ip}`));
  if (wait) throw new Error(`Demasiados intentos fallidos. Prueba de nuevo en ${wait} min.`);
  const { rows } = await q('SELECT id, username, pass_hash, is_admin FROM users WHERE username = $1', [name]);
  const ok = await verifyPassword(password ?? '', rows[0]?.pass_hash ?? DUMMY);
  if (!rows[0] || !ok) {
    fail(`u:${name}`); fail(`ip:${ip}`);
    throw new Error('Usuario o contraseña incorrectos');
  }
  fails.delete(`u:${name}`); fails.delete(`ip:${ip}`);
  return { id: rows[0].id, username: rows[0].username, isAdmin: rows[0].is_admin };
}

// ---------- sesiones ----------
const sha = (t) => createHash('sha256').update(t).digest('hex');
// en producción (detrás de Cloudflare) SECURE_COOKIES=1: la app no ve el https, pero el navegador sí
const isHttps = (req) => process.env.SECURE_COOKIES === '1' || req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;

export async function startSession(res, req, userId) {
  const token = randomBytes(32).toString('base64url');
  await q(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [sha(token), userId]);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`);
}

const tokenOf = (req) => (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';

/** El usuario de la sesión de esta petición, o null. */
export async function userOf(req) {
  const token = tokenOf(req);
  if (!token) return null;
  const { rows } = await q(`SELECT u.id, u.username, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha(token)]);
  return rows[0] ? { id: rows[0].id, username: rows[0].username, isAdmin: rows[0].is_admin } : null;
}

export async function endSession(res, req) {
  const token = tokenOf(req);
  if (token) await q('DELETE FROM sessions WHERE token_hash = $1', [sha(token)]);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? '; Secure' : ''}`);
}

/** Peticiones que cambian algo: solo desde esta misma web (el navegador siempre manda Origin en un POST). */
export function sameOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
