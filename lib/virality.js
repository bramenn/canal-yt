// ¿Se está haciendo viral? y ¿qué nos ha funcionado? — con las cifras que se leen cada 30 min (p.stats.history).
// Las redes prueban cada vídeo con un grupo pequeño (YouTube ~50-1.000, TikTok ~200-500, Facebook ~500-2.000) y lo
// amplían si retiene; las primeras vistas predicen bastante bien las finales. Por eso se compara cada short con la
// MEDIANA DEL PROPIO CANAL A LA MISMA EDAD (desde que se vio publicado por primera vez), red por red.

const NETS = ['yt', 'tt', 'fb', 'ig'];
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

const KEY = { yt: 'youtube', tt: 'tiktok', fb: 'facebook', ig: 'instagram' };
/** Momento de publicación en una red (si la red lo da) o, si no, la primera lectura con vistas. */
const born = (p, net) => p.stats?.[KEY[net]]?.published ?? (p.stats?.history ?? []).find((h) => h[net] != null)?.at ?? null;

/** Vistas de una red a una edad dada (h desde que se publicó), interpolando el histórico (0 vistas al publicar). */
function viewsAt(p, net, ageH) {
  const t0 = born(p, net);
  if (t0 == null) return null;
  const pts = [{ at: t0, [net]: 0 }, ...(p.stats?.history ?? []).filter((h) => h[net] != null && h.at > t0)];
  if (pts.length < 2) return null;
  const target = t0 + ageH * 3600000;
  if (target > pts.at(-1).at) return null; // aún no tiene esa edad
  let prev = pts[0];
  for (const p of pts) {
    if (p.at >= target) return prev.at === p.at ? p[net] : prev[net] + (p[net] - prev[net]) * (target - prev.at) / (p.at - prev.at);
    prev = p;
  }
  return pts.at(-1)[net];
}

/**
 * Estado de cada short: { [id]: { level: 'fire'|'up'|'normal'|'stuck'|null, ratio, net, ageH, perHour, label } }.
 * shorts: proyectos con stats.history.
 */
export function virality(shorts) {
  const out = {};
  for (const p of shorts) {
    const h = p.stats?.history ?? [];
    let best = null;
    for (const net of NETS) {
      const pts = h.filter((x) => x[net] != null);
      if (!pts.length || born(p, net) == null) continue;
      const ageH = (pts.at(-1).at - born(p, net)) / 3600000;
      const now = pts.at(-1)[net];
      // la mediana de los demás shorts a la misma edad (hacen falta al menos 3 para comparar)
      const others = shorts.filter((q) => q !== p).map((q) => viewsAt(q, net, ageH)).filter((v) => v != null);
      const base = others.length >= 3 ? Math.max(50, median(others)) : null;
      const ratio = base ? now / base : null;
      // ritmo de la última hora
      const hourAgo = pts.filter((x) => x.at <= pts.at(-1).at - 3600000).at(-1) ?? (pts.length > 1 ? pts[0] : { at: born(p, net), [net]: 0 });
      const perHour = Math.max(0, (now - hourAgo[net]) / Math.max(0.5, (pts.at(-1).at - hourAgo.at) / 3600000));
      let level = 'normal';
      if (ratio != null && ratio >= 3 && now >= 300) level = 'fire';
      else if (ratio != null && ratio >= 1.5) level = 'up';
      // sin shorts con los que comparar: ritmo sostenido alto (≥ 150 vistas/h de media y ahora mismo)
      else if (ratio == null && ageH >= 1 && now / ageH >= 150 && perHour >= 150) level = 'up';
      else if (ageH >= 6 && now < 300) level = 'stuck'; // no pasó la primera prueba (~200-500 personas)
      const rank = { fire: 3, up: 2, normal: 1, stuck: 0 }[level];
      if (!best || rank > best.rank || (rank === best.rank && (ratio ?? 0) > (best.ratio ?? 0))) best = { level, rank, ratio, net, ageH, perHour: Math.round(perHour), now };
    }
    if (!best) { out[p.id] = { level: null }; continue; }
    const name = { yt: 'YouTube', tt: 'TikTok', fb: 'Facebook', ig: 'Instagram' }[best.net] ?? best.net;
    const x = best.ratio?.toFixed(1);
    const label = {
      fire: () => `🔥 Despegando en ${name}: ×${x} tu media a esta edad`,
      up: () => (x ? `📈 Por encima de tu media en ${name} (×${x})` : `📈 Buen ritmo en ${name}: ${best.perHour} vistas/h`),
      stuck: () => `😴 Atascado: no pasó la primera prueba (${best.now} vistas en ${Math.round(best.ageH)} h)`,
      normal: () => (x ? `En tu media (×${x})` : 'Aún sin suficientes shorts para comparar'),
    }[best.level]();
    out[p.id] = { level: best.level, ratio: best.ratio, net: best.net, ageH: Math.round(best.ageH * 10) / 10, perHour: best.perHour, label };
  }
  return out;
}

/** Vistas totales (todas las redes) de un short, para ordenar qué funcionó mejor. */
const total = (p) => ['youtube', 'tiktok', 'facebook', 'instagram'].reduce((a, k) => a + (p.stats?.[k]?.views ?? 0), 0);

/**
 * Lo aprendido para la IA: los shorts que mejor y peor funcionaron (con al menos 12 h publicados: la primera ola ya pasó) y los arranques ya
 * usados. describe(p) → { title, hook, angle } del short. Devuelve texto para añadir al prompt (o '' si aún no hay datos).
 */
export function learnings(shorts, describe) {
  const dayMs = 12 * 3600000;
  const rated = shorts.filter((p) => NETS.some((n) => born(p, n) != null && Date.now() - born(p, n) >= dayMs)).sort((a, b) => total(b) - total(a));
  const used = shorts.slice(0, 25).map((p) => describe(p).hook).filter(Boolean).map((h) => h.split(/\s+/).slice(0, 5).join(' '));
  if (rated.length < 3) return used.length ? `\nArranques ya usados en el canal (NO empieces igual ni parecido): ${used.map((u) => `«${u}…»`).join(' · ')}` : '';
  const line = (p) => { const d = describe(p); return `- «${d.title}» (${total(p).toLocaleString('es')} vistas) · ángulo: ${d.angle} · arranque: «${d.hook}»`; };
  const top = rated.slice(0, 4), worst = rated.slice(-3).filter((p) => !top.includes(p));
  return `
LO QUE NOS HA FUNCIONADO EN ESTE CANAL (datos reales de vistas). Aprende el PATRÓN —tipo de historia, ángulo, forma del gancho, tono, ritmo—, NUNCA copies el tema, el título ni las frases (repetirse es lo que hunde un canal):
${top.map(line).join('\n')}
LO QUE PEOR FUNCIONÓ (evita sus patrones):
${worst.map(line).join('\n')}
Arranques ya usados (NO empieces igual ni parecido): ${used.map((u) => `«${u}…»`).join(' · ')}`;
}
