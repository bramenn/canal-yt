// Primera autorización local para YouTube Analytics.
// Requiere YOUTUBE_ANALYTICS_CLIENT_ID y YOUTUBE_ANALYTICS_CLIENT_SECRET en .env.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const scopes = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  // poner la miniatura a los vídeos que publica Buffer (su API no sube miniaturas)
  'https://www.googleapis.com/auth/youtube.force-ssl',
];
const clientId = process.env.YOUTUBE_ANALYTICS_CLIENT_ID?.trim();
const clientSecret = process.env.YOUTUBE_ANALYTICS_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  throw new Error('Añade YOUTUBE_ANALYTICS_CLIENT_ID y YOUTUBE_ANALYTICS_CLIENT_SECRET a .env antes de autorizar.');
}

const envFile = path.resolve(process.env.YOUTUBE_ANALYTICS_ENV_FILE || '.env');
const port = Number(process.env.YOUTUBE_ANALYTICS_OAUTH_PORT || 45931);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('YOUTUBE_ANALYTICS_OAUTH_PORT no es válido.');
const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
const state = randomBytes(24).toString('hex');
const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

let resolveAuthorization, rejectAuthorization;
const authorization = new Promise((resolve, reject) => { resolveAuthorization = resolve; rejectAuthorization = reject; });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== '/oauth2callback') { res.writeHead(404).end('No encontrado'); return; }
  if (url.searchParams.get('state') !== state) { res.writeHead(400).end('Estado OAuth no válido.'); rejectAuthorization(new Error('La respuesta OAuth no coincide con esta sesión.')); return; }
  const googleError = url.searchParams.get('error');
  if (googleError) { res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end('Autorización cancelada. Puedes cerrar esta pestaña.'); rejectAuthorization(new Error(`Google rechazó la autorización: ${googleError}`)); return; }
  const code = url.searchParams.get('code');
  if (!code) { res.writeHead(400).end('Google no devolvió un código de autorización.'); rejectAuthorization(new Error('No llegó el código OAuth.')); return; }
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(data.error_description || data.error || `HTTP ${response.status}`).slice(0, 180));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end('<!doctype html><meta charset="utf-8"><title>Autorizado</title><p>YouTube Analytics conectado. Ya puedes cerrar esta pestaña y volver a la terminal.</p>');
    resolveAuthorization(data);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('No se pudo guardar la autorización. Revisa la terminal.');
    rejectAuthorization(error);
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});
const actualPort = server.address().port;
const actualRedirect = `http://127.0.0.1:${actualPort}/oauth2callback`;
const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
for (const [key, value] of Object.entries({
  client_id: clientId,
  redirect_uri: actualRedirect,
  response_type: 'code',
  scope: scopes.join(' '),
  access_type: 'offline',
  prompt: 'consent',
  include_granted_scopes: 'true',
  state,
  code_challenge: challenge,
  code_challenge_method: 'S256',
})) authUrl.searchParams.set(key, value);

const timeout = setTimeout(() => rejectAuthorization(new Error('La autorización venció tras cinco minutos.')), 5 * 60_000);
console.log('Abre esta dirección e inicia sesión con la cuenta propietaria del canal de YouTube:');
console.log(authUrl.toString());
console.log('La respuesta se guarda directamente en .env; el token no se imprime.');

try {
  const tokens = await authorization;
  if (!tokens.refresh_token && !process.env.YOUTUBE_ANALYTICS_REFRESH_TOKEN) {
    throw new Error('Google no devolvió un refresh token. Vuelve a autorizar con acceso offline y consentimiento.');
  }
  if (tokens.refresh_token) {
    const before = await readFile(envFile, 'utf8').catch(() => '');
    const line = `YOUTUBE_ANALYTICS_REFRESH_TOKEN=${tokens.refresh_token}`;
    const pattern = /^\s*YOUTUBE_ANALYTICS_REFRESH_TOKEN\s*=.*$/m;
    const after = pattern.test(before) ? before.replace(pattern, line) : `${before}${before && !before.endsWith('\n') ? '\n' : ''}${line}\n`;
    await writeFile(envFile, after, { mode: 0o600 });
    await chmod(envFile, 0o600);
  }
  console.log(`Autorización guardada en ${envFile}. Reinicia Anime para empezar a consultar las métricas.`);
} finally {
  clearTimeout(timeout);
  server.close();
}
