// Comprueba la conexión PostgreSQL que usa la aplicación, incluido el puerto del host.
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export async function waitForDatabase({
  connectionString = process.env.DATABASE_URL,
  timeoutMs = Number(process.env.DB_WAIT_TIMEOUT_MS || 60000),
  log = console.log,
} = {}) {
  if (!connectionString) throw new Error('Falta DATABASE_URL para comprobar PostgreSQL.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('DB_WAIT_TIMEOUT_MS debe ser positivo.');
  const url = new URL(connectionString);
  const target = `${url.hostname}:${url.port || 5432}`;
  const deadline = Date.now() + timeoutMs;
  let lastCode = 'sin conexión';
  log(`Comprobando PostgreSQL en ${target}…`);
  while (Date.now() < deadline) {
    const remaining = Math.max(1, Math.min(2000, deadline - Date.now()));
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: remaining, query_timeout: remaining });
    // Una desconexión durante la comprobación no debe convertirse en un error de evento sin manejar.
    client.on('error', () => {});
    try {
      await client.connect();
      await client.query('SELECT 1');
      log(`PostgreSQL disponible en ${target}.`);
      return;
    } catch (error) {
      lastCode = error.code || 'conexión no disponible';
      if (error.code === '28P01' || error.code === '3D000') {
        throw new Error(`La configuración de PostgreSQL no permite conectar a ${target} (${error.code}).`);
      }
    } finally {
      await client.end().catch(() => {});
    }
    const delay = Math.min(1000, deadline - Date.now());
    if (delay > 0) await sleep(delay);
  }
  throw new Error(`PostgreSQL no estuvo disponible en ${target} tras ${Math.round(timeoutMs / 1000)} s (${lastCode}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await waitForDatabase(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
