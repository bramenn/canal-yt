// Postgres compartido por las apps (fútbol, cómic): usuarios, sesiones, ajustes y los proyectos de cada app en su tabla
// (projects = vídeos de fútbol, comics = episodios de podcast en cómic, animes = shorts de anime).
// Fotos, clips, audio y exportaciones siguen en disco (PROJECTS_DIR); aquí solo va el proyecto en JSON.
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL (postgres://usuario:clave@host:puerto/base) en el entorno o en .env');
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
export const q = (text, params) => pool.query(text, params);

/** Crea las tablas si no existen e importa (una vez) los proyectos que había en archivos JSON. */
export async function migrate(projectsDir) {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id         serial PRIMARY KEY,
      username   text NOT NULL UNIQUE,
      pass_hash  text NOT NULL,
      is_admin   boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash text PRIMARY KEY,
      user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS projects (
      id         text PRIMARY KEY,
      data       jsonb NOT NULL,
      updated    bigint NOT NULL,
      created_by integer REFERENCES users(id) ON DELETE SET NULL,
      updated_by integer REFERENCES users(id) ON DELETE SET NULL,
      deleted_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS comics (
      id         text PRIMARY KEY,
      data       jsonb NOT NULL,
      updated    bigint NOT NULL,
      created_by integer REFERENCES users(id) ON DELETE SET NULL,
      updated_by integer REFERENCES users(id) ON DELETE SET NULL,
      deleted_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS animes (
      id         text PRIMARY KEY,
      data       jsonb NOT NULL,
      updated    bigint NOT NULL,
      created_by integer REFERENCES users(id) ON DELETE SET NULL,
      updated_by integer REFERENCES users(id) ON DELETE SET NULL,
      deleted_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   text PRIMARY KEY,
      value jsonb NOT NULL
    );`);
  await q('DELETE FROM sessions WHERE expires_at < now()');
  // los episodios de cómic que se crearon dentro de fútbol pasan a su tabla
  await q(`WITH m AS (DELETE FROM projects WHERE data->>'type' = 'podcast' RETURNING *)
           INSERT INTO comics SELECT * FROM m ON CONFLICT (id) DO NOTHING`);
  if (!projectsDir) return 0;
  // primera vez con Postgres: los proyectos de antes (archivos JSON) entran tal cual; los archivos se quedan como copia
  const { rows } = await q("SELECT count(*)::int AS n, (SELECT value FROM settings WHERE key = 'imported_json') AS done FROM projects");
  if (rows[0].done || !existsSync(projectsDir)) return 0;
  let n = 0;
  for (const f of (await readdir(projectsDir)).filter((x) => x.endsWith('.json') && x !== 'settings.json')) {
    try {
      const p = JSON.parse(await readFile(path.join(projectsDir, f), 'utf8'));
      if (!p.id || !p.video) continue;
      await q('INSERT INTO projects (id, data, updated) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [p.id, p, p.updated ?? Date.now()]);
      n++;
    } catch {}
  }
  // ajustes que vivían en settings.json (motor de IA, carpeta de CapCut)
  try {
    const s = JSON.parse(await readFile(path.join(projectsDir, 'settings.json'), 'utf8'));
    for (const [k, v] of Object.entries(s)) await setSetting(k, v);
  } catch {}
  await setSetting('imported_json', true);
  return n;
}

// ---------- proyectos (table: 'projects' | 'comics' | 'animes', nunca viene del usuario) ----------
const TABLES = new Set(['projects', 'comics', 'animes']);
const tbl = (t) => { if (!TABLES.has(t)) throw new Error(`tabla desconocida ${t}`); return t; };
export async function listProjects(table = 'projects') {
  const { rows } = await q(`SELECT data FROM ${tbl(table)} WHERE deleted_at IS NULL ORDER BY updated DESC`);
  return rows.map((r) => r.data);
}
export async function getProject(id, table = 'projects') {
  const { rows } = await q(`SELECT data FROM ${tbl(table)} WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0]?.data ?? null;
}
/** Guarda el proyecto; devuelve el nuevo `updated`. */
export async function saveProject(p, userId, table = 'projects') {
  const updated = Date.now();
  p.updated = updated;
  await q(`INSERT INTO ${tbl(table)} (id, data, updated, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated = EXCLUDED.updated, updated_by = EXCLUDED.updated_by, deleted_at = NULL`,
  [p.id, p, updated, userId]);
  return updated;
}
/** A la papelera (recuperable: deleted_at = NULL). */
export async function deleteProject(id, table = 'projects') {
  const r = await q(`UPDATE ${tbl(table)} SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return r.rowCount > 0;
}

// ---------- ajustes ----------
export async function getSetting(key) {
  const { rows } = await q('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}
export const setSetting = (key, value) => q('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(value)]);
