// Métricas privadas del canal con YouTube Analytics API v2 (OAuth de solo lectura).
// Las vistas públicas siguen viniendo de yt-dlp; aquí añadimos engaged views, retención,
// suscripciones y la curva de audiencia que el Analytics API sí ofrece al propietario.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REPORTS_URL = 'https://youtubeanalytics.googleapis.com/v2/reports';
const REFRESH_MS = 12 * 60 * 60 * 1000;
const RETENTION_REFRESH_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 200;
const MAX_PAGES = 1000;
const FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const METRICS = [
  'views', 'engagedViews', 'estimatedMinutesWatched', 'averageViewDuration',
  'averageViewPercentage', 'likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost',
];

let tokenCache = { value: '', expiresAt: 0 };
let retryAfter = 0;

const config = () => ({
  clientId: process.env.YOUTUBE_ANALYTICS_CLIENT_ID?.trim(),
  clientSecret: process.env.YOUTUBE_ANALYTICS_CLIENT_SECRET?.trim(),
  refreshToken: process.env.YOUTUBE_ANALYTICS_REFRESH_TOKEN?.trim(),
});

export function youtubeAnalyticsConfigured() {
  const c = config();
  return Boolean(c.clientId && c.clientSecret && c.refreshToken);
}

export function youtubeAnalyticsMissingConfig() {
  const c = config();
  return [
    ['YOUTUBE_ANALYTICS_CLIENT_ID', c.clientId],
    ['YOUTUBE_ANALYTICS_CLIENT_SECRET', c.clientSecret],
    ['YOUTUBE_ANALYTICS_REFRESH_TOKEN', c.refreshToken],
  ].filter(([, value]) => !value).map(([name]) => name);
}

export function youtubeVideoId(url) {
  const s = String(url ?? '');
  return s.match(/(?:youtube\.com\/(?:shorts|embed)\/|youtu\.be\/)([\w-]{11})/)?.[1]
    ?? s.match(/[?&]v=([\w-]{11})/)?.[1]
    ?? null;
}

async function payload(response) {
  return response.json().catch(() => ({}));
}

export async function youtubeAccessToken() {
  if (tokenCache.value && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.value;
  const c = config();
  if (!c.clientId || !c.clientSecret || !c.refreshToken) throw new Error('Falta configurar OAuth de YouTube Analytics en .env');
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await payload(response);
  if (!response.ok || !data.access_token) {
    const reason = String(data.error_description || data.error || `HTTP ${response.status}`).slice(0, 180);
    throw new Error(`No se pudo renovar OAuth de YouTube Analytics: ${reason}`);
  }
  tokenCache = { value: data.access_token, expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000 };
  return tokenCache.value;
}

async function queryReport(params) {
  const token = await youtubeAccessToken();
  const url = new URL(REPORTS_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const data = await payload(response);
  if (!response.ok) {
    const reason = String(data.error?.message || data.error_description || `HTTP ${response.status}`).slice(0, 200);
    throw new Error(`YouTube Analytics API ${response.status}: ${reason}`);
  }
  return data;
}

async function allRows(params) {
  const rows = [];
  let headers = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await queryReport({ ...params, maxResults: PAGE_SIZE, startIndex: page * PAGE_SIZE + 1 });
    if (result.columnHeaders?.length) headers = result.columnHeaders.map((h) => h.name);
    const batch = result.rows ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { headers, rows };
  }
  throw new Error(`YouTube Analytics devolvió más de ${PAGE_SIZE * MAX_PAGES} filas; reduce el periodo consultado`);
}

const day = (value) => {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
};
const dateBefore = (date, days) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};
const textCell = (row, headers, name) => {
  const i = headers.indexOf(name);
  if (i < 0 || row[i] == null || row[i] === '') return null;
  return String(row[i]);
};
const cell = (row, headers, name) => {
  const value = textCell(row, headers, name);
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function summary(rows) {
  const totals = Object.fromEntries(['views', 'engagedViews', 'estimatedMinutesWatched', 'likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost'].map((k) => [k, 0]));
  let durationWeight = 0, duration = 0, percentageWeight = 0, percentage = 0;
  for (const d of rows) {
    for (const k of Object.keys(totals)) totals[k] += d[k] ?? 0;
    const w = d.views ?? 0;
    if (w > 0 && d.averageViewDuration != null) { duration += d.averageViewDuration * w; durationWeight += w; }
    if (w > 0 && d.averageViewPercentage != null) { percentage += d.averageViewPercentage * w; percentageWeight += w; }
  }
  return {
    ...totals,
    averageViewDuration: durationWeight ? duration / durationWeight : null,
    averageViewPercentage: percentageWeight ? percentage / percentageWeight : null,
  };
}

function readDaily(report) {
  const { headers, rows } = report;
  const out = new Map();
  for (const row of rows) {
    const videoId = textCell(row, headers, 'video');
    const date = textCell(row, headers, 'day');
    if (!videoId || !date) continue;
    const item = { date };
    for (const metric of METRICS) item[metric] = cell(row, headers, metric);
    const list = out.get(videoId) ?? [];
    list.push(item);
    out.set(videoId, list);
  }
  for (const [videoId, list] of out) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    if (list.length < 2) continue;
    const byDate = new Map(list.map((x) => [x.date, x]));
    const completed = [];
    const end = new Date(`${list.at(-1).date}T12:00:00Z`);
    for (let d = new Date(`${list[0].date}T12:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const date = d.toISOString().slice(0, 10);
      completed.push(byDate.get(date) ?? {
        date,
        ...Object.fromEntries(METRICS.map((metric) => [metric, metric.startsWith('average') ? null : 0])),
      });
    }
    out.set(videoId, completed);
  }
  return out;
}

function readRetention(report) {
  const { headers, rows } = report;
  return rows.map((row) => ({
    elapsedVideoTimeRatio: cell(row, headers, 'elapsedVideoTimeRatio'),
    audienceWatchRatio: cell(row, headers, 'audienceWatchRatio'),
    relativeRetentionPerformance: cell(row, headers, 'relativeRetentionPerformance'),
  })).filter((p) => p.elapsedVideoTimeRatio != null && p.audienceWatchRatio != null)
    .sort((a, b) => a.elapsedVideoTimeRatio - b.elapsedVideoTimeRatio);
}

/** Actualiza análisis privado de los Shorts; Google no publica las métricas más recientes al instante. */
export async function refreshYouTubeAnalytics(shorts, log = () => {}, { force = false } = {}) {
  if (!youtubeAnalyticsConfigured()) {
    return { configured: false, updated: new Map() };
  }

  const now = Date.now();
  if (now < retryAfter) {
    log('ℹ️ YouTube Analytics API en pausa temporal tras un error anterior; se conservan las cifras públicas.');
    return { configured: true, updated: new Map(), checked: 0, coolingDown: true };
  }
  const items = shorts.map((p) => {
    const yt = p.stats?.youtube;
    const videoId = yt?.videoId || youtubeVideoId(yt?.url);
    if (!videoId || !/^[\w-]{11}$/.test(videoId)) return null;
    const published = yt?.published ?? p.created;
    return { p, videoId, published, old: yt.analytics ?? {} };
  }).filter(Boolean).sort((a, b) => (b.p.created ?? 0) - (a.p.created ?? 0));
  const stale = items.filter((x) => force || now - (x.old.checkedAt ?? 0) >= REFRESH_MS);
  if (!stale.length) return { configured: true, updated: new Map(), checked: 0 };

  const updates = new Map();
  try {
    const endDate = new Date(now).toISOString().slice(0, 10);
    // Hasta 500 IDs por consulta; así se cubren todos los Shorts registrados con ID conocido.
    for (let start = 0; start < stale.length; start += 500) {
      const batch = stale.slice(start, start + 500);
      const ids = batch.map((x) => x.videoId);
      const earliestPublished = batch.reduce((earliest, x) => {
        const d = day(x.published);
        return d < earliest ? d : earliest;
      }, day(batch[0].published));
      const startDate = dateBefore(earliestPublished, 1);
      const report = await allRows({
        ids: 'channel==MINE', startDate, endDate,
        metrics: METRICS.join(','), dimensions: 'day,video',
        filters: `video==${ids.join(',')}`, sort: 'day,video',
      });
      const byVideo = readDaily(report);
      const through = [...byVideo.values()].flat().reduce((max, x) => x.date > max ? x.date : max, '');
      for (const item of batch) {
        const daily = byVideo.get(item.videoId) ?? [];
        const old = item.old;
        if (daily.length) {
          const { noDataYet: _noDataYet, ...previous } = old;
          updates.set(item.videoId, {
            ...previous,
            source: 'youtube-analytics-api',
            checkedAt: now,
            fetchedAt: now,
            startDate,
            through: daily.at(-1).date,
            daily,
            lifetime: summary(daily),
            retention: old.retention ?? [],
            retentionCheckedAt: old.retentionCheckedAt ?? null,
          });
        } else updates.set(item.videoId, { ...old, source: 'youtube-analytics-api', checkedAt: now, fetchedAt: old.fetchedAt ?? null, noDataYet: true });
      }

      // La curva de retención solo admite un vídeo por consulta: se obtiene por tandas pequeñas y se cachea 24 h.
      const retentionCandidates = batch.map((item) => ({ ...item, daily: byVideo.get(item.videoId) ?? [] }))
        .filter((x) => x.daily.reduce((n, d) => n + (d.engagedViews ?? 0), 0) >= 100
          && now - (x.old.retentionCheckedAt ?? 0) >= RETENTION_REFRESH_MS)
        .sort((a, b) => b.daily.reduce((n, d) => n + (d.engagedViews ?? 0), 0) - a.daily.reduce((n, d) => n + (d.engagedViews ?? 0), 0))
        .slice(0, 5);
      for (const item of retentionCandidates) {
        const previous = updates.get(item.videoId) ?? item.old;
        try {
          const report = await allRows({
            ids: 'channel==MINE', startDate: previous.startDate ?? startDate,
            endDate: previous.through ?? through ?? endDate,
            metrics: 'audienceWatchRatio,relativeRetentionPerformance',
            dimensions: 'elapsedVideoTimeRatio', filters: `video==${item.videoId}`,
          });
          updates.set(item.videoId, {
            ...previous,
            retention: readRetention(report),
            retentionCheckedAt: now,
          });
        } catch (error) {
          updates.set(item.videoId, { ...previous, retentionCheckedAt: now });
          log(`⚠️ Curva de retención (${item.p.script?.title ?? item.videoId}): ${error.message.slice(0, 120)}`);
        }
      }
    }
    const withData = [...updates.values()].filter((x) => x.daily?.length).length;
    log(`📈 YouTube Analytics: ${withData} vídeos con métricas privadas; datos disponibles hasta ${[...updates.values()].map((x) => x.through).filter(Boolean).sort().at(-1) ?? 'sin fecha'}.`);
    retryAfter = 0;
    return { configured: true, updated: updates, checked: stale.length };
  } catch (error) {
    retryAfter = Date.now() + FAILURE_COOLDOWN_MS;
    log(`⚠️ YouTube Analytics API: ${error.message.slice(0, 180)}. Se conservan las cifras públicas.`);
    return { configured: true, updated: new Map(), checked: stale.length, error: error.message };
  }
}
