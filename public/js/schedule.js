// Franjas para publicar (hora de Colombia, UTC-5): 4 al día por red (3-4 shorts diarios), separadas ≥ 1,5 h.
// Facebook, medido (39 reels, oct-2026): 14-16 h y 18-20 h dan 6-10 veces más que la mañana. YouTube: picos del público
// latino a las 18-19 h. TikTok: tarde-noche. ponytail: franjas fijas; recalcular con más datos de cada red.
export const SLOTS = {
  youtube: ['12:00', '15:00', '18:00', '20:30'],
  facebook: ['14:00', '15:45', '18:00', '19:45'],
  tiktok: ['13:00', '16:00', '19:00', '21:00'],
};
const COT = -5;
// margen para subir el vídeo y que Buffer lo descargue antes de publicarlo
const MARGIN = 20 * 60e3;

/** Siguiente franja libre de una red desde ahora (ms), sin repetir las de `taken` (Set de ms). */
export function nextSlot(net, taken, now = Date.now()) {
  for (let day = 0; day < 60; day++) {
    for (const hm of SLOTS[net]) {
      const [h, m] = hm.split(':').map(Number);
      const d = new Date(now + COT * 3600e3); // reloj de Colombia en campos UTC
      d.setUTCDate(d.getUTCDate() + day);
      d.setUTCHours(h, m, 0, 0);
      const t = d.getTime() - COT * 3600e3;
      if (t > now + MARGIN && !taken.has(t)) return t;
    }
  }
  throw new Error(`Sin franjas libres en ${net} en 60 días`);
}

/** «dom 25, 6:00 p. m.» en hora de Colombia. */
export const fmtSlot = (t) => new Date(t).toLocaleString('es-CO', { timeZone: 'America/Bogota', weekday: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
