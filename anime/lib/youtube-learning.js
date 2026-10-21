// Combina Analytics con contadores públicos recientes sin sumar periodos ni inventar retención.

const number = (x) => Number.isFinite(Number(x)) ? Number(x) : 0;
const words = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean).length;
const weighted = (rows, metric) => {
  let n = 0, w = 0;
  for (const r of rows) {
    const weight = number(r.views);
    if (weight > 0 && Number.isFinite(r[metric])) { n += r[metric] * weight; w += weight; }
  }
  return w ? n / w : null;
};
const fmt = (x, digits = 0) => x == null ? 's/d' : Number(x).toLocaleString('es-CO', { maximumFractionDigits: digits });

function videoSample(p, describe) {
  const a = p.stats?.youtube?.analytics;
  const daily = a?.daily ?? [];
  if (daily.length < 3) return null;
  const first = daily.slice(0, 3);
  const engaged = first.reduce((n, d) => n + number(d.engagedViews), 0);
  if (engaged < 100) return null;
  const d = describe(p);
  return {
    p, a, d, first,
    views: first.reduce((n, x) => n + number(x.views), 0),
    engaged,
    watched: weighted(first, 'averageViewPercentage'),
    duration: weighted(first, 'averageViewDuration'),
    minutes: first.reduce((n, x) => n + number(x.estimatedMinutesWatched), 0),
    likes: first.reduce((n, x) => n + number(x.likes), 0),
    comments: first.reduce((n, x) => n + number(x.comments), 0),
    shares: first.reduce((n, x) => n + number(x.shares), 0),
    subscribers: first.reduce((n, x) => n + number(x.subscribersGained), 0),
    unsubscribers: first.reduce((n, x) => n + number(x.subscribersLost), 0),
  };
}

function retentionAt(curve, ratio) {
  if (!curve?.length) return null;
  return curve.reduce((best, point) => Math.abs(point.elapsedVideoTimeRatio - ratio) < Math.abs(best.elapsedVideoTimeRatio - ratio) ? point : best, curve[0]);
}

function retentionByScript(sample) {
  const curve = sample.a.retention;
  const lines = sample.p.script?.lines ?? [];
  if (!curve?.length || !lines.length) return '';
  const total = lines.reduce((n, line) => n + words(line.text), 0);
  if (!total) return '';
  const indexes = [...new Set([0, 1, Math.floor((lines.length - 1) / 2), lines.length - 2, lines.length - 1])]
    .filter((i) => i >= 0 && i < lines.length);
  let before = 0;
  const starts = lines.map((line) => { const at = before / total; before += words(line.text); return at; });
  const points = indexes.map((i) => {
    const at = starts[i];
    const point = retentionAt(curve, at);
    if (!point) return null;
    const text = String(lines[i].text ?? '').replace(/\s+/g, ' ').slice(0, 62);
    return `frase ${i + 1} (~${Math.round(at * 100)}% del tiempo, «${text}»): ${fmt(point.audienceWatchRatio, 2)}× vistas; relativo ${fmt(point.relativeRetentionPerformance, 2)}`;
  }).filter(Boolean);
  let worstDrop = null;
  for (let i = 1; i < lines.length; i++) {
    const prev = retentionAt(curve, starts[i - 1]), curr = retentionAt(curve, starts[i]);
    if (!prev || !curr) continue;
    const loss = prev.audienceWatchRatio - curr.audienceWatchRatio;
    if (loss >= 0.25 && (!worstDrop || loss > worstDrop.loss)) {
      worstDrop = { i, loss, at: Math.round(starts[i] * 100), text: String(lines[i].text ?? '').replace(/\s+/g, ' ').slice(0, 62) };
    }
  }
  const dropNote = worstDrop ? ` Mayor caída al entrar en frase ${worstDrop.i + 1} (~${worstDrop.at}%, «${worstDrop.text}»): −${fmt(worstDrop.loss, 2)}× vistas.` : '';
  return points.length ? ` Curva aproximada por frases (posición estimada por palabras): ${points.join(' | ')}.${dropNote}` : '';
}

function describeSample(x) {
  const dates = `${x.first[0].date} a ${x.first.at(-1).date}`;
  const perThousand = (v) => x.engaged ? (1000 * v / x.engaged) : 0;
  return `- «${x.d.title || x.p.id}» · tipo: ${x.p.story?.type ?? 'noticia'}; historia: ${x.d.angle || 's/d'}; gancho: «${x.d.hook || 's/d'}». Primeros 3 días reportados (${dates}): ${fmt(x.views)} vistas, ${fmt(x.engaged)} engaged views, ${fmt(x.watched, 1)}% promedio visto, ${fmt(x.duration, 1)} s promedio, ${fmt(x.minutes)} min vistos; likes ${fmt(x.likes)}, comentarios ${fmt(x.comments)}, compartidos ${fmt(x.shares)} (${fmt(perThousand(x.shares), 1)} por 1.000 engaged views), suscriptores ganados ${fmt(x.subscribers)} y perdidos ${fmt(x.unsubscribers)} (${fmt(perThousand(x.subscribers - x.unsubscribers), 1)} netos por 1.000 engaged views).${retentionByScript(x)}`;
}

/** Comparación privada de una ventana equivalente, cuando hay suficiente muestra. */
function youtubeAnalyticsLearning(shorts, describe) {
  const samples = shorts.map((p) => videoSample(p, describe)).filter(Boolean);
  if (samples.length < 3) return null;
  const ranked = [...samples].sort((a, b) => b.engaged - a.engaged);
  const top = ranked.slice(0, 4);
  const low = ranked.slice(-3).filter((x) => !top.includes(x)).reverse();
  const used = shorts.slice(0, 25).map((p) => describe(p).hook).filter(Boolean)
    .map((h) => h.split(/\s+/).slice(0, 5).join(' '));
  return `
APRENDIZAJE DE YOUTUBE ANALYTICS (datos privados del canal; muestra: ${samples.length} Shorts):
YouTube tarda en publicar los días más recientes; estas comparaciones usan los primeros tres días reportados por vídeo, con al menos 100 engaged views. «views» sigue la definición del informe para Shorts; «engaged views» cuenta reproducciones que pasaron del primer fotograma o tocaron para reproducir. «averageViewPercentage» y la duración media miden cuánto vieron. Los suscriptores atribuidos a un vídeo son los ganados o perdidos desde su página de reproducción. La curva «audienceWatchRatio» puede superar 1 por repeticiones. Usa estas señales para proponer hipótesis; no afirmes que una palabra o tema causó por sí solo el resultado. Prioriza retención, conversión a suscriptor y compartidos además del volumen; distingue noticias de temas atemporales y considera que franquicia y actualidad también cambian el alcance.
MEJORES PRIMEROS TRES DÍAS (engaged views; métricas, historia y arranque):
${top.map(describeSample).join('\n')}
${low.length ? `MENORES RESULTADOS CON LA MISMA VENTANA (busca qué patrón evitar, sin descartar un tema con una sola muestra):\n${low.map(describeSample).join('\n')}` : ''}
Arranques ya usados (no los repitas): ${used.map((u) => `«${u}…»`).join(' · ')}
Al escoger nuevas historias, formula una hipótesis distinta basada en estas señales y varía una decisión cada vez. No copies títulos, temas ni frases.`;
}

/** Contadores acumulados recientes: sirven también mientras faltan días de Analytics. */
export function youtubePublicLearning(shorts, describe) {
  const samples = shorts.map(p => {
    const yt = p.stats?.youtube;
    if (!yt) return null;
    const history = (p.stats?.history ?? [])
      .filter(h => h.yt != null && Number.isFinite(h.yt) && Number.isFinite(h.at)
        && (!h.ytVideoId || !yt.videoId || h.ytVideoId === yt.videoId))
      .map(h => ({ ...h, at: h.ytAt ?? h.at }))
      .sort((a, b) => a.at - b.at);
    const snapshot = yt.public ?? {
      source: 'youtube-public-feed', fetchedAt: history.at(-1)?.at ?? p.stats.at,
      views: yt.views, likes: yt.likes, comments: yt.comments,
    };
    if (snapshot.views == null || !Number.isFinite(Number(snapshot.views))) return null;
    const observed = Number(snapshot.fetchedAt);
    const published = Number(yt.published) > 0 ? Number(yt.published) : null;
    const born = published ?? history[0]?.at ?? null;
    const age = born != null && Number.isFinite(observed) && observed >= born ? (observed - born) / 3600000 : null;
    // Ritmo entre dos lecturas reales separadas al menos 15 min; nunca se interpola desde cero.
    const earlier = history.filter(h => h.at <= observed - 15 * 60000 && h.at >= observed - 6 * 3600000);
    const previous = earlier.filter(h => h.at <= observed - 3600000).at(-1) ?? earlier[0];
    const elapsed = previous ? (observed - previous.at) / 3600000 : null;
    const delta = previous ? Number(snapshot.views) - previous.yt : null;
    const d = describe(p);
    const ageText = age == null ? 'edad de publicación desconocida'
      : `${fmt(age, 1)} h ${published ? 'desde publicación' : 'desde primera observación (edad mínima)'}`;
    const recent = elapsed ? `; variación ${fmt(delta)} vistas en ${fmt(elapsed, 1)} h (${fmt(delta / elapsed)} vistas/h${delta < 0 ? ', posible corrección del contador' : ''})` : '; ritmo aún sin dos lecturas comparables';
    const through = yt.analytics?.through;
    const source = snapshot.source === 'youtube-data-api' ? 'YouTube Data API' : 'lista pública de YouTube';
    const captured = Number.isFinite(observed) && observed > 0 ? new Date(observed).toISOString() : 's/d';
    return {
      order: born ?? p.created ?? 0,
      text: `- «${d.title || p.id}» · tipo: ${p.story?.type ?? 'noticia'}; historia: ${d.angle || 's/d'}; gancho: «${d.hook || 's/d'}». ${ageText}; ${fmt(Number(snapshot.views))} vistas públicas acumuladas; likes ${fmt(snapshot.likes)}, comentarios ${fmt(snapshot.comments)}${recent}. Fuente: ${source}, lectura ${captured}. Analytics ${through ? `disponible hasta ${through}` : 'todavía sin datos privados'}.`,
    };
  }).filter(Boolean).sort((a, b) => b.order - a.order).slice(0, 12);
  if (!samples.length) return '';
  return `
CONTEXTO PÚBLICO RECIENTE DE YOUTUBE (señales provisionales de ${samples.length} Shorts):
Estas cifras incluyen vídeos recientes aunque Analytics aún no tenga datos. Son contadores acumulados a la fecha de cada lectura: NO los sumes a Analytics ni los uses para rellenar sus días pendientes. Las vistas públicas no equivalen a engaged views. Los likes y comentarios ausentes se muestran como s/d, no como cero. La retención, el tiempo visto, los compartidos y los suscriptores no pueden dedirse de estos contadores. Compara vídeos de edades similares y observa la variación entre lecturas; una primera observación no es la fecha real de publicación. Considera la antigüedad de cada lectura. Un vídeo recién publicado o con pocas vistas sigue siendo una muestra pequeña: úsalo para hipótesis tempranas de tema y gancho, sin declararlo un fracaso ni sustituir conclusiones de retención contrastadas.
${samples.map(s => s.text).join('\n')}`;
}

/** Señales de Instagram, Facebook y TikTok cuando un Short destaca fuera de YouTube (sin mezclar con métricas de YouTube). */
export function otherNetworksLearning(shorts, describe) {
  const hits = shorts.map((p) => {
    const s = p.stats ?? {};
    const ig = number(s.instagram?.views), fb = number(s.facebook?.views), tt = number(s.tiktok?.views);
    if (ig < 2500 && fb < 1200 && tt < 700) return null;
    const d = describe(p);
    const nets = [
      ig >= 500 ? `Instagram ${fmt(ig)} vistas` : null,
      fb >= 500 ? `Facebook ${fmt(fb)} vistas` : null,
      tt >= 300 ? `TikTok ${fmt(tt)} vistas` : null,
    ].filter(Boolean);
    return {
      peak: Math.max(ig, fb, tt),
      text: `- «${d.title || p.id}» · tipo: ${p.story?.type ?? 'noticia'}; historia: ${d.angle || 's/d'}; gancho: «${d.hook || 's/d'}» → ${nets.join(' · ')}.`,
    };
  }).filter(Boolean).sort((a, b) => b.peak - a.peak).slice(0, 5);
  if (!hits.length) return '';
  return `
SEÑALES DESTACADAS EN OTRAS REDES (Instagram, Facebook y TikTok; contadores independientes de YouTube):
Estos temas funcionaron especialmente bien en Reels o TikTok (no sumes estas cifras a las de YouTube):
${hits.map((h) => h.text).join('\n')}`;
}

/** Contexto para cada historia y guion: Analytics contrastado más señales públicas recientes. */
export function youtubeLearning(shorts, describe) {
  const analytics = youtubeAnalyticsLearning(shorts, describe);
  const recent = youtubePublicLearning(shorts, describe);
  const other = otherNetworksLearning(shorts, describe);
  const used = !analytics && (recent || other) ? shorts.slice(0, 25).map(p => describe(p).hook).filter(Boolean)
    .map(h => `«${h.split(/\s+/).slice(0, 5).join(' ')}…»`).join(' · ') : '';
  return [analytics, recent, other, used ? `Arranques ya usados (no los repitas): ${used}` : '']
    .filter(Boolean).join('\n') || null;
}
