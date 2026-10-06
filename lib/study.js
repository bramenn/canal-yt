// Estudio de canales: descarga transcripciones con yt-dlp a style/referencias/ para que
// Claude Code las use como referencia de estilo (y pueda reescribir style/estilo.md).
import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REFS = path.join(ROOT, 'style', 'referencias');
const TMP = path.join(ROOT, '.work', 'subs');
const LOCAL_YTDLP = path.join(ROOT, '.tools', 'venv', 'bin', 'yt-dlp');
const YTDLP = process.env.YTDLP_BIN || (existsSync(LOCAL_YTDLP) ? LOCAL_YTDLP : 'yt-dlp');

function run(bin, args, onProc) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    onProc?.(child);
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.split('\n').filter((l) => /ERROR/.test(l)).join(' ') || `código ${code}`))));
  });
}

/** VTT de subtítulos automáticos → texto limpio con una marca [mm:ss] cada ~30 s. */
export function vttToText(vtt) {
  const out = [];
  const seen = new Set();
  let curT = null, buf = [];
  for (const block of vtt.split(/\n\n+/)) {
    const m = block.match(/(\d\d):(\d\d):(\d\d)\.\d+ -->/);
    if (!m) continue;
    const secs = +m[1] * 3600 + +m[2] * 60 + +m[3];
    for (const raw of block.split('\n').slice(1)) {
      const l = raw.replace(/<[^>]+>/g, '').trim();
      if (!l || l.includes('-->') || seen.has(l)) continue;
      seen.add(l);
      if (curT === null || secs - curT >= 30) {
        if (buf.length) out.push(`[${String(Math.floor(curT / 60)).padStart(2, '0')}:${String(curT % 60).padStart(2, '0')}] ${buf.join(' ')}`);
        buf = []; curT = secs;
      }
      buf.push(l);
    }
  }
  if (buf.length) out.push(`[${String(Math.floor(curT / 60)).padStart(2, '0')}:${String(curT % 60).padStart(2, '0')}] ${buf.join(' ')}`);
  return out.join('\n');
}

export async function listReferences() {
  if (!existsSync(REFS)) return [];
  const files = (await readdir(REFS)).filter((f) => f.endsWith('.txt'));
  const out = [];
  for (const f of files) {
    const txt = await readFile(path.join(REFS, f), 'utf8');
    out.push({ id: f.replace(/\.txt$/, ''), title: (txt.match(/^# (.*)/) || [])[1] || f, words: txt.split(/\s+/).length });
  }
  return out;
}

/** body: { url, limit, filter } — url de canal, playlist o vídeo. */
export function studyChannel({ url, limit = 10, filter = '' }, emit) {
  let child = null;
  let cancelled = false;
  (async () => {
    try {
      if (!url) throw new Error('Falta la URL del canal o vídeo');
      await mkdir(REFS, { recursive: true });
      await mkdir(TMP, { recursive: true });
      let target = url.trim();
      if (/youtube\.com\/@[^/]+\/?$/.test(target)) target = target.replace(/\/?$/, '/videos');
      emit({ type: 'log', text: `📺 Listando vídeos de ${target}` });
      const list = await run(YTDLP, ['--flat-playlist', '--playlist-end', String(Math.max(limit * 3, limit)), '--print', '%(id)s|%(title)s', target], (c) => { child = c; });
      let videos = list.trim().split('\n').filter(Boolean).map((l) => { const i = l.indexOf('|'); return { id: l.slice(0, i), title: l.slice(i + 1) }; });
      if (filter) {
        const re = new RegExp(filter, 'i');
        videos = videos.filter((v) => re.test(v.title));
      }
      videos = videos.slice(0, limit);
      emit({ type: 'log', text: `Encontrados ${videos.length} vídeos` });
      const done = [];
      for (const v of videos) {
        if (cancelled) return;
        emit({ type: 'log', text: `⬇️  Transcripción: ${v.title}` });
        try {
          await run(YTDLP, ['-q', '--skip-download', '--write-auto-subs', '--write-subs', '--sub-langs', 'es-orig,es.*,es,en-orig,en',
            '--sub-format', 'vtt', '-o', path.join(TMP, '%(id)s.%(ext)s'), '--', `https://www.youtube.com/watch?v=${v.id}`], (c) => { child = c; });
          const files = (await readdir(TMP)).filter((f) => f.startsWith(v.id + '.') && f.endsWith('.vtt'));
          const pick = files.find((f) => f.includes('.es-orig.')) || files.find((f) => f.includes('.es')) || files[0];
          if (!pick) { emit({ type: 'log', text: '   (sin subtítulos, se omite)' }); continue; }
          const text = vttToText(await readFile(path.join(TMP, pick), 'utf8'));
          await writeFile(path.join(REFS, `${v.id}.txt`), `# ${v.title}\nFuente: https://www.youtube.com/watch?v=${v.id}\n\n${text}`);
          done.push({ ...v, words: text.split(/\s+/).length });
          for (const f of files) await rm(path.join(TMP, f), { force: true });
        } catch (e) {
          emit({ type: 'log', text: `   ⚠️ ${e.message.slice(0, 160)}` });
        }
      }
      emit({ type: 'result', data: { added: done, referencias: await listReferences() } });
    } catch (e) {
      emit({ type: 'error', message: `${e.message}${/ENOENT/.test(e.message) ? ' — instala yt-dlp (pip install yt-dlp) o define YTDLP_BIN' : ''}` });
    } finally {
      emit({ type: 'end' });
    }
  })();
  return () => { cancelled = true; child?.kill('SIGTERM'); };
}

export const ANALYZE_SCHEMA = {
  type: 'object',
  properties: { markdown: { type: 'string' } },
  required: ['markdown'],
};

export function analyzePrompt() {
  return `En la carpeta referencias/ hay transcripciones de vídeos de un canal de referencia (con marcas [mm:ss]). En estilo.md está la biblia de estilo actual.
1. Lee estilo.md y luego TODAS las transcripciones de referencias/ (usa Glob y Read).
2. Reescribe la biblia de estilo en Markdown, manteniendo la estructura de secciones de estilo.md (promesa del canal, arranques, recursos del cuerpo, cierre, lenguaje, títulos y miniaturas, visual), actualizada con lo que observes.
3. Para cada patrón da: cuándo se usa, cómo se construye y 1-2 ejemplos breves reales (parafraseados o citas de menos de 20 palabras). Incluye el ritmo en palabras por minuto (calcúlalo con las marcas de tiempo) y las longitudes típicas.
4. Sé concreto y accionable: es una guía para que otro guionista imite el oficio sin copiar frases.
Devuelve el Markdown completo en "markdown".`;
}
