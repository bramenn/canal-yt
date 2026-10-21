// Instala unidades de usuario para el contenedor existente: no recrea ni borra datos.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unitDir = path.join(homedir(), '.config/systemd/user');
// Generar desde el contenedor conserva exactamente su volumen, imagen y configuración.
const { stdout } = await exec('podman', [
  'generate', 'systemd', '--name', 'futbol-db', '--restart-policy=always', '--restart-sec=5', '--no-header',
]);
if (!stdout.includes('PIDFile=') || !stdout.includes('Type=forking') || !stdout.includes('podman start futbol-db')) {
  throw new Error('Podman no devolvió una unidad válida para el contenedor futbol-db existente.');
}
const unit = stdout.replace('Description=Podman container-futbol-db.service', 'Description=PostgreSQL compartido de Canal YT (futbol-db)');
const override = await readFile(path.join(root, 'ops/systemd/anime-database.conf'), 'utf8');
for (const [relative, text] of [
  ['canal-yt-db.service', unit], ['anime.service.d/20-database.conf', override],
]) {
  const file = path.join(unitDir, relative);
  await mkdir(path.dirname(file), { recursive: true });
  let previous;
  try { previous = await readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous != null && previous !== text) {
    await writeFile(`${file}.before-database-fix`, previous, { flag: 'wx' })
      .catch(error => { if (error.code !== 'EEXIST') throw error; });
  }
  await writeFile(file, text, { mode: 0o644 });
  console.log(`Configurado: ${file}`);
}
await exec('systemctl', ['--user', 'daemon-reload']);
console.log('Unidades listas. Activa canal-yt-db.service con systemd y reinicia Anime.');
