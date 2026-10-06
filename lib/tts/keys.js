// Claves de los proveedores de voz: solo en el servidor local (.secrets/<proveedor>.json, permisos 600) o en variables de entorno.
import { readFileSync, existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const file = (id) => path.join(ROOT, '.secrets', `${id}.json`);

export function readKey(id, envName) {
  if (process.env[envName]) return process.env[envName];
  try { return JSON.parse(readFileSync(file(id), 'utf8')).key || ''; } catch { return ''; }
}

export const keySource = (id, envName) => (process.env[envName] ? 'env' : existsSync(file(id)) ? 'file' : null);

export async function saveKey(id, key) {
  await mkdir(path.dirname(file(id)), { recursive: true, mode: 0o700 });
  await writeFile(file(id), JSON.stringify({ key }), { mode: 0o600 });
}
