// Gestión de usuarios desde la terminal (no hay registro público):
//   npm run user -- add <usuario> [--admin]   crea un usuario (pide la contraseña sin mostrarla)
//   npm run user -- passwd <usuario>          cambia su contraseña (cierra sus sesiones)
//   npm run user -- list                      lista los usuarios
//   npm run user -- del <usuario>             borra un usuario
import { createInterface } from 'node:readline';
import { pool, migrate } from '../lib/db.js';
import { createUser, setPassword, listUsers, deleteUser } from '../lib/auth.js';
import { q } from '../lib/db.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// sin terminal (p. ej. `printf 'clave\nclave\n' | npm run user -- add x`) las respuestas se leen de la entrada, línea a línea
let piped = null;
async function nextLine() {
  if (!piped) { let all = ''; for await (const c of process.stdin) all += c; piped = all.split(/\r?\n/); }
  return piped.shift() ?? '';
}

/** Pide un texto sin mostrar lo que se escribe. */
function askHidden(question) {
  if (!process.stdin.isTTY) return nextLine();
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (!rl.muted) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    rl.muted = true;
  });
}

async function newPassword() {
  const a = await askHidden('Contraseña (mín. 10 caracteres): ');
  const b = await askHidden('Repítela: ');
  if (a !== b) throw new Error('Las contraseñas no coinciden');
  return a;
}

const idOf = async (name) => {
  const { rows } = await q('SELECT id FROM users WHERE username = $1', [String(name).toLowerCase()]);
  if (!rows[0]) throw new Error(`No existe el usuario «${name}»`);
  return rows[0].id;
};

const [cmd, name, flag] = process.argv.slice(2);
try {
  await migrate(process.env.PROJECTS_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'projects'));
  if (cmd === 'add' && name) { await createUser(name, await newPassword(), flag === '--admin'); console.log(`✔ Usuario «${name.toLowerCase()}» creado${flag === '--admin' ? ' (administrador)' : ''}`); }
  else if (cmd === 'passwd' && name) { await setPassword(await idOf(name), await newPassword()); console.log(`✔ Contraseña de «${name}» cambiada`); }
  else if (cmd === 'del' && name) { await deleteUser(await idOf(name)); console.log(`✔ Usuario «${name}» borrado`); }
  else if (cmd === 'list') { const users = await listUsers(); if (!users.length) console.log('No hay usuarios todavía.'); for (const u of users) console.log(`${u.username}${u.is_admin ? ' (admin)' : ''} · desde ${u.created_at.toISOString().slice(0, 10)}`); }
  else console.log('Uso: npm run user -- add <usuario> [--admin] | passwd <usuario> | list | del <usuario>');
} catch (e) {
  console.error(`✖ ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
