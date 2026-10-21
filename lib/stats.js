// Cifras por plataforma, emparejadas por título o por ID de YouTube ya conocido:
// - YouTube: lista pública (yt-dlp), contadores por lotes (Data API) y métricas privadas (Analytics).
// - TikTok: vídeos del perfil por su ID interno (yt-dlp «tiktokuser:») → vistas, likes, comentarios.
// - Facebook: pestaña de reels con un navegador sin ventana (reproducciones) + texto de cada reel (yt-dlp). Solo si
//   hay playwright-core y Chromium (en el servidor no: se salta).
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ytdlp } from './ytdlp.js';
import { getSetting, setSetting, saveProject } from './db.js';
import { refreshYouTubeAnalytics, youtubeVideoId } from './youtube-analytics.js';
import { youtubePublicStats } from './youtube-data.js';

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
  const fetchedAt = Date.now();
  return (list.entries ?? []).map((e) => ({
    id: e.id, url: `https://www.youtube.com/shorts/${e.id}`, title: e.title ?? '',
    views: e.view_count ?? null, published: e.timestamp ? e.timestamp * 1000 : null,
    public: { source: 'youtube-public-feed', fetchedAt, views: e.view_count ?? null },
  }));
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
  const publicUpdates = await youtubePublicStats([
    ...platforms.youtube.map(v => v.id),
    ...shorts.map(p => p.stats?.youtube?.videoId || youtubeVideoId(p.stats?.youtube?.url)),
  ], log);
  const youtubeVideos = new Map(platforms.youtube.map(v => [v.id, v]));
  for (const [id, details] of publicUpdates) {
    const feed = youtubeVideos.get(id);
    youtubeVideos.set(id, {
      ...(feed ?? {}), ...details,
      // Una respuesta sin contador de vistas no descarta una lectura válida de la lista pública.
      ...(details.views == null && feed?.views != null ? { views: feed.views, public: feed.public } : {}),
    });
  }
  platforms.youtube = [...youtubeVideos.values()];
  let found = 0;
  const changed = new Set();
  const claimed = {
    youtube: new Set(shorts.map(p => p.stats?.youtube?.videoId || youtubeVideoId(p.stats?.youtube?.url)).filter(Boolean)),
    tiktok: new Set(shorts.map(p => p.stats?.tiktok?.url).filter(Boolean)),
    facebook: new Set(shorts.map(p => p.stats?.facebook?.url).filter(Boolean)),
    instagram: new Set(shorts.map(p => p.stats?.instagram?.url).filter(Boolean)),
  };
  for (const p of shorts) {
    const ours = [p.script?.title, p.script?.copy?.yt_title, p.script?.copy?.tt_caption, p.tiktok?.script?.title].filter(Boolean);
    const stats = { ...(p.stats ?? {}), at: Date.now() };
    for (const [name, list] of Object.entries(platforms)) {
      // Conservamos el ID/URL ya conocido; las publicaciones nuevas se emparejan por título sin pisar otro short.
      const knownId = name === 'youtube' ? (stats.youtube?.videoId || youtubeVideoId(stats.youtube?.url)) : stats[name]?.url;
      let best = knownId ? list.find(v => (name === 'youtube' ? v.id : v.url) === knownId) : null, bestScore = 0.6;
      if (!knownId) for (const v of list) {
        const key = name === 'youtube' ? v.id : v.url;
        if (key && claimed[name]?.has(key)) continue;
        for (const t of ours) { const sc = score(v.title, t); if (sc >= bestScore) { best = v; bestScore = sc; } }
      }
      if (!best) continue;
      const bestKey = name === 'youtube' ? best.id : best.url;
      if (bestKey) claimed[name]?.add(bestKey);
      // Los contadores ausentes no borran las últimas lecturas. La captura pública
      // conserva su propia fuente y fecha; nunca rellena métricas privadas de Analytics.
      stats[name] = {
        ...(stats[name] ?? {}),
        url: best.url,
        ...Object.fromEntries(['views', 'likes', 'comments'].filter(k => best[k] != null).map(k => [k, best[k]])),
        published: best.published ?? stats[name]?.published ?? null,
        ...(name === 'youtube' ? { videoId: best.id || youtubeVideoId(best.url) || stats[name]?.videoId, public: best.public } : {}),
      };
    }
    if (!['youtube', 'tiktok', 'facebook', 'instagram'].some((k) => stats[k])) continue;
    found++;
    stats.history = [...(p.stats?.history ?? []), {
      at: stats.at,
      yt: stats.youtube?.public ? (stats.youtube.public.views ?? null) : (stats.youtube?.views ?? null),
      ytAt: stats.youtube?.public?.fetchedAt ?? null, tt: stats.tiktok?.views ?? null,
      fb: stats.facebook?.views ?? null, ig: stats.instagram?.views ?? null,
      ytVideoId: stats.youtube?.videoId ?? null,
      ytLikes: stats.youtube?.public?.likes ?? null, ytComments: stats.youtube?.public?.comments ?? null,
    }].slice(-200);
    p.stats = stats;
    changed.add(p);
  }
  const analytics = await refreshYouTubeAnalytics(shorts, log);
  for (const p of shorts) {
    const yt = p.stats?.youtube;
    const id = yt?.videoId || youtubeVideoId(yt?.url);
    const details = id && analytics.updated.get(id);
    if (!yt || !details) continue;
    yt.videoId = id;
    yt.analytics = details;
    p.stats.at = Date.now();
    changed.add(p);
  }
  for (const p of changed) await save(p);
  return found;
}
