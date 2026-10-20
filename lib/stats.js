// Cifras públicas de cada short en YouTube, TikTok y Facebook (sin API ni login), emparejadas por título:
// - YouTube: lista de shorts del canal y detalle de cada uno (yt-dlp, títulos en español) → vistas, likes, comentarios.
// - TikTok: vídeos del perfil por su ID interno (yt-dlp «tiktokuser:») → vistas, likes, comentarios.
// - Facebook: pestaña de reels con un navegador sin ventana (reproducciones) + texto de cada reel (yt-dlp). Solo si
//   hay playwright-core y Chromium (en el servidor no: se salta).
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ytdlp } from './ytdlp.js';
import { getSetting, setSetting, saveProject } from './db.js';

// cuentas de cada app: { youtube: URL de /shorts del canal, tiktok: ID interno (secUid) del perfil, facebook / instagram: URL de /reels/ }

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
/** Parecido entre el título publicado y el del short: parte de las palabras del short que aparecen (0-1). */
function score(published, ours) {
  const pub = new Set(norm(published));
  const w = norm(ours).slice(0, 12);
  return w.length ? w.filter((x) => pub.has(x)).length / w.length : 0;
}
const json = async (args, timeout = 120000) => JSON.parse(await ytdlp(args, timeout));

// ---------- por plataforma: [{ id, url, title, views, likes, comments }] ----------
async function youtube(url) {
  const list = await json(['--extractor-args', 'youtube:lang=es', '--flat-playlist', '-I', '1:60', '-J', url]);
  return (list.entries ?? []).map((e) => ({ id: e.id, url: `https://www.youtube.com/shorts/${e.id}`, title: e.title ?? '', views: e.view_count ?? null }));
}
async function tiktok(secUid) {
  const list = await json(['--flat-playlist', '-I', '1:60', '-J', `tiktokuser:${secUid}`]);
  return (list.entries ?? []).map((e) => ({ id: e.id, url: e.url ?? e.webpage_url, title: e.title ?? e.description ?? '', views: e.view_count ?? null, likes: e.like_count ?? null, comments: e.comment_count ?? null, published: e.timestamp ? e.timestamp * 1000 : null }));
}

const chromium = () => process.env.CHROMIUM_BIN || (() => {
  const base = path.join(homedir(), '.cache/ms-playwright');
  const dir = existsSync(base) && readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
  return dir ? path.join(base, dir, 'chrome-linux64/chrome') : null;
})();

/** Pestaña de reels de Facebook o Instagram (se ven sin iniciar sesión): enlace y reproducciones de cada uno. */
async function reelsTab(url, log, cacheKey) {
  const pw = await import('playwright-core').catch(() => null);
  const bin = chromium();
  if (!pw || !bin || !existsSync(bin)) { log('ℹ️ Reels: sin navegador en esta máquina (se salta)'); return []; }
  const b = await pw.chromium.launch({ executablePath: bin });
  let reels = [];
  try {
    const p = await b.newPage({ locale: 'es-ES', viewport: { width: 1280, height: 2400 } });
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForTimeout(8000);
    // cada reel de la pestaña: enlace y reproducciones («1,2 mil» → 1200)
    reels = await p.$$eval('a[href*="/reel/"]', (as) => as.map((a) => ({ url: a.href.split('?')[0], label: a.innerText.trim() })));
  } finally { await b.close(); }
  const num = (s) => { const m = String(s).replace(/\./g, '').replace(',', '.').match(/([\d.]+)\s*(mil|k|m)?/i); if (!m) return null; return Math.round(Number(m[1]) * ({ mil: 1e3, k: 1e3, m: 1e6 }[m[2]?.toLowerCase()] ?? 1)); };
  // el texto de cada reel (para emparejarlo) se guarda: solo se pide la primera vez
  const titles = (await getSetting(cacheKey)) ?? {};
  const out = [];
  for (const r of [...new Map(reels.map((x) => [x.url, x])).values()].slice(0, 30)) {
    // Instagram da «Video by …» como título: el texto va en la descripción
    if (!titles[r.url]) { try { const d = await json(['--skip-download', '-J', r.url], 90000); titles[r.url] = (/^Video by /.test(d.title ?? '') ? d.description : d.title) ?? ''; } catch { titles[r.url] = ''; } }
    out.push({ id: r.url, url: r.url, title: titles[r.url], views: num(r.label), likes: null, comments: null, published: null });
  }
  await setSetting(cacheKey, titles);
  return out;
}

/**
 * Actualiza p.stats de cada short: { youtube|tiktok|facebook|instagram: { url, views, likes, comments }, at, history: [...] }.
 * shorts: los proyectos; save(p) los guarda. Devuelve cuántos shorts tienen cifras.
 */
export async function refreshStats(shorts, save, log = () => {}, { accounts, table }) {
  shorts = await shorts;
  save ??= (p) => saveProject(p, null, table);
  const read = async (name, fn) => { try { const r = await fn(); log(`📊 ${name}: ${r.length} publicaciones`); return r; } catch (e) { log(`⚠️ ${name}: ${e.message.slice(0, 120)}`); return []; } };
  const skip = async () => [];
  const platforms = {
    youtube: await read('YouTube', accounts.youtube ? () => youtube(accounts.youtube) : skip),
    tiktok: await read('TikTok', accounts.tiktok ? () => tiktok(accounts.tiktok) : skip),
    facebook: await read('Facebook', accounts.facebook ? () => reelsTab(accounts.facebook, log, `${table}.fbTitles`) : skip),
    instagram: await read('Instagram', accounts.instagram ? () => reelsTab(accounts.instagram, log, `${table}.igTitles`) : skip),
  };
  let found = 0;
  for (const p of shorts) {
    const ours = [p.script?.title, p.script?.copy?.yt_title, p.script?.copy?.tt_caption, p.tiktok?.script?.title].filter(Boolean);
    const stats = { ...(p.stats ?? {}), at: Date.now() };
    for (const [name, list] of Object.entries(platforms)) {
      // la publicación que más se parece a alguno de sus títulos (mínimo 60 % de las palabras)
      let best = null, bestScore = 0.6;
      for (const v of list) for (const t of ours) { const sc = score(v.title, t); if (sc >= bestScore) { best = v; bestScore = sc; } }
      if (!best) continue;
      // ponytail: sin el detalle de cada short en YouTube (likes/comentarios): 1 petición por vídeo cada 30 min hacía que
      // YouTube bloqueara la IP. Las vistas llegan con la lista; likes y retención, en YouTube Studio.
      stats[name] = { url: best.url, views: best.views, likes: best.likes, comments: best.comments, published: best.published ?? p.stats?.[name]?.published ?? null };
    }
    if (!['youtube', 'tiktok', 'facebook', 'instagram'].some((k) => stats[k])) continue;
    found++;
    stats.history = [...(p.stats?.history ?? []), { at: stats.at, yt: stats.youtube?.views ?? null, tt: stats.tiktok?.views ?? null, fb: stats.facebook?.views ?? null, ig: stats.instagram?.views ?? null }].slice(-200);
    p.stats = stats;
    await save(p);
  }
  return found;
}
