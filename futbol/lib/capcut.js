// Exportar a CapCut: borrador con las imágenes/clips (pista principal + transiciones), la voz y subtítulos opcionales,
// creado con CapCutAPI (pyJianYingDraft). Si está el CapCut de escritorio en Wine (import-draft.sh), se importa solo;
// siempre queda además un ZIP del borrador en exports/.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CAPCUT_DIR = process.env.CAPCUT_DIR || path.join(homedir(), 'CapCutAPI');
const WIN = process.platform === 'win32';
const PY = process.env.CAPCUT_PYTHON || path.join(CAPCUT_DIR, WIN ? '.venv/Scripts/python.exe' : '.venv/bin/python');
// Linux: CapCut de escritorio en Wine (Bottles) + import-draft.sh, que reescribe las rutas a Windows
const IMPORT = path.join(CAPCUT_DIR, 'import-draft.sh');
const WINE_DRAFTS = path.join(homedir(), '.var/app/com.usebottles.bottles/data/bottles/bottles/capcut/drive_c/users', userInfo().username, 'AppData/Local/CapCut/User Data/Projects/com.lveditor.draft');
// Windows: la carpeta de proyectos de CapCut (la de ⚙ Ajustes o la de siempre); el borrador se escribe ahí directamente
const winDrafts = () => process.env.CAPCUT_DRAFTS || path.join(process.env.LOCALAPPDATA ?? '', 'CapCut/User Data/Projects/com.lveditor.draft');
const W = 1920, H = 1080;

const run = (bin, args, opts = {}) => new Promise((resolve, reject) => execFile(bin, args, { maxBuffer: 64 << 20, timeout: 900000, ...opts }, (e, out, err) => (e ? reject(new Error(String(err).trim().split('\n').slice(-3).join(' ') || e.message)) : resolve(out))));

export const capcutStatus = () => ({ available: existsSync(PY), deploy: WIN ? existsSync(winDrafts()) : existsSync(IMPORT) && existsSync(WINE_DRAFTS), drafts: WIN ? winDrafts() : WINE_DRAFTS });

/** Foto → fotograma 16:9 como en el vídeo: apaisada a pantalla completa; vertical, centrada sobre ella misma desenfocada. */
async function frame(store, projectId, url) {
  const file = store.fileOf(url);
  const [w, h] = (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])).trim().split(',').map(Number);
  const out = path.join(await mkdtemp(path.join(tmpdir(), 'cc-')), 'f.jpg');
  const vf = w / h >= 1.6
    ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
    : `split[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=40:2,eq=brightness=-0.12[bg];[b]scale=-2:${H}[fg];[bg][fg]overlay=(W-w)/2:0`;
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', file, '-filter_complex', `${vf},format=yuvj420p`, '-frames:v', '1', '-q:v', '2', out]);
  const media = await store.save(projectId, await readFile(out), 'image/jpeg', null);
  await rm(path.dirname(out), { recursive: true, force: true });
  return media.url;
}

/**
 * body: { projectId, name, shots: [{ url, type, start, end, clip_dur?, transition? }], audio: [{ url, start, dur }], srt?: texto SRT }
 * baseUrl: dirección de este servidor (CapCutAPI descarga los archivos por URL).
 */
export async function exportCapcut(body, store, outDir, baseUrl, log) {
  if (!existsSync(PY)) throw new Error(`No encuentro CapCutAPI en ${CAPCUT_DIR} (o fija CAPCUT_DIR)`);
  const abs = (u) => (u.startsWith('http') ? u : `${baseUrl}${u}`);
  log(`🖼 Preparando ${body.shots.length} imágenes en 16:9…`);
  const shots = [];
  for (const s of body.shots) shots.push({ ...s, url: abs(s.type === 'video' ? s.url : await frame(store, body.projectId, s.url)) });
  const work = await mkdtemp(path.join(tmpdir(), 'capcut-'));
  try {
    let srt = null;
    if (body.srt) { srt = path.join(work, 'subtitulos.srt'); await writeFile(srt, body.srt); }
    const direct = WIN && existsSync(winDrafts());
    const draftsOut = direct ? winDrafts() : path.join(outDir, 'capcut');
    await mkdir(draftsOut, { recursive: true });
    const plan = { name: body.name, out_dir: draftsOut, width: W, height: H, shots, audio: body.audio.map((a) => ({ ...a, url: abs(a.url) })), srt };
    log('🎬 Montando el borrador de CapCut (descarga cada imagen, clip y audio)…');
    const out = await new Promise((resolve, reject) => {
      const child = execFile(PY, [path.join(HERE, 'capcut_export.py'), CAPCUT_DIR], { maxBuffer: 64 << 20, timeout: 1800000 }, (e, stdout, stderr) => (e ? reject(new Error(String(stderr).trim().split('\n').slice(-3).join(' ') || e.message)) : resolve(stdout)));
      child.stdin.end(JSON.stringify(plan));
    });
    const { draft_id: draftId, draft_dir: draftDir } = JSON.parse(out.trim().split('\n').pop());
    // ZIP del borrador para llevarlo a otro ordenador
    const zipBase = path.join(outDir, `${body.name}-capcut`);
    await run(PY, ['-c', 'import shutil,sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2], sys.argv[3])', zipBase, path.dirname(draftDir), path.basename(draftDir)]);
    let deployed = direct;
    if (!WIN && capcutStatus().deploy) {
      log('📥 Importando en tu CapCut de escritorio…');
      await run('sh', [IMPORT, draftDir], { cwd: CAPCUT_DIR });
      deployed = true;
    }
    return { draftId, deployed, zip: `/exports/${encodeURIComponent(path.basename(zipBase))}.zip` };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
