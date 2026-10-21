// Contadores actuales por lotes, con el mismo OAuth de solo lectura que Analytics.
import { youtubeAccessToken, youtubeAnalyticsConfigured } from './youtube-analytics.js';

const count = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);

export async function youtubePublicStats(videoIds, log = () => {}) {
  const updated = new Map();
  const ids = [...new Set(videoIds.filter(id => /^[\w-]{11}$/.test(id ?? '')))];
  if (!youtubeAnalyticsConfigured() || !ids.length) return updated;
  try {
    const token = await youtubeAccessToken();
    for (let offset = 0; offset < ids.length; offset += 50) {
      const url = new URL('https://www.googleapis.com/youtube/v3/videos');
      url.searchParams.set('part', 'snippet,statistics');
      url.searchParams.set('id', ids.slice(offset, offset + 50).join(','));
      url.searchParams.set('fields', 'items(id,snippet(title,publishedAt),statistics(viewCount,likeCount,commentCount))');
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const disabled = data.error?.errors?.some(e => e.reason === 'accessNotConfigured')
          || data.error?.details?.some(e => e.reason === 'SERVICE_DISABLED');
        if (disabled) throw new Error('Habilita YouTube Data API v3 en el mismo proyecto de Google Cloud para obtener likes, comentarios y fechas actuales');
        throw new Error(`HTTP ${response.status}: ${String(data.error?.message ?? 'No se pudo consultar videos.list').slice(0, 160)}`);
      }
      const fetchedAt = Date.now();
      for (const item of data.items ?? []) {
        const published = Date.parse(item.snippet?.publishedAt);
        const counters = {
          views: count(item.statistics?.viewCount),
          likes: count(item.statistics?.likeCount),
          comments: count(item.statistics?.commentCount),
        };
        updated.set(item.id, {
          id: item.id, url: `https://www.youtube.com/shorts/${item.id}`,
          title: item.snippet?.title ?? '', ...counters,
          published: Number.isFinite(published) ? published : null,
          public: { source: 'youtube-data-api', fetchedAt, ...counters },
        });
      }
    }
    log(`📊 YouTube Data API: ${updated.size} vídeos con contadores actuales.`);
  } catch (error) {
    log(`ℹ️ YouTube Data API: ${error.message}. Se mantienen las lecturas públicas disponibles.`);
  }
  return updated;
}
