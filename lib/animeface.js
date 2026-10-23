// Detección de caras y sujetos de anime para encuadre vertical inteligente (9:16)
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'anime_faces.py');
const VENV_PY = path.join(HERE, '..', '.tools', 'venv', 'bin', 'python');

const clamp = (v, lo, hi, def) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def);

/**
 * Detecta caras de anime en un archivo (imagen o tramo de vídeo).
 * Devuelve { w, h, samples: [{ t, faces: [[cx, cy, size], ...] }] }
 */
export async function detectFaces(file, start = 0, dur = 0, step = 0.4) {
  try {
    const raw = await new Promise((resolve, reject) => {
      execFile(VENV_PY, [SCRIPT, file, String(start), String(dur), String(step)], { timeout: 15000 }, (err, stdout) => {
        if (err) return resolve(null);
        try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
      });
    });
    return raw;
  } catch {
    return null;
  }
}

/**
 * Analiza el encuadre óptimo de un elemento (vídeo o foto) para un corte de duración `dur`.
 * Si hay 2 personajes en extremos opuestos, recomienda Cinema Card ('card').
 * Si hay un personaje principal, centra en su cara suavemente sin sobre-recortar.
 */
export async function computeSmartFraming(item, start = 0, dur = 2.0) {
  const isImg = item.kind === 'image';
  const data = await detectFaces(item.file, isImg ? 0 : start, isImg ? 0 : dur);
  if (!data?.samples?.length) {
    return {
      focusX: clamp(item.focusX, 0.15, 0.85, 0.5),
      focusY: clamp(item.focusY, 0.15, 0.85, 0.42),
      layout: item.layout || 'full',
    };
  }

  // Recolectar todas las caras detectadas en las muestras del tramo
  const allFaces = [];
  for (const s of data.samples) {
    for (const f of s.faces || []) allFaces.push(f);
  }

  if (!allFaces.length) {
    return {
      focusX: clamp(item.focusX, 0.15, 0.85, 0.5),
      focusY: clamp(item.focusY, 0.15, 0.85, 0.42),
      layout: item.layout || 'full',
    };
  }

  // Comprobar si hay 2 personajes separados a lo ancho (distancia horizontal > 35% del ancho)
  for (const s of data.samples) {
    if (s.faces?.length >= 2) {
      const sorted = [...s.faces].sort((a, b) => a[0] - b[0]);
      const left = sorted[0][0];
      const right = sorted.at(-1)[0];
      if (right - left > 0.35) {
        // En 9:16 recortar los lados amputaría a uno de los dos personajes; usar Cinema Card
        return {
          focusX: clamp((left + right) / 2, 0.2, 0.8, 0.5),
          focusY: clamp(sorted[0][1], 0.2, 0.8, 0.42),
          layout: 'card',
        };
      }
    }
  }

  // Calcular la posición media del personaje principal (ponderada por tamaño)
  let sumX = 0, sumY = 0, sumW = 0;
  for (const [x, y, sz] of allFaces) {
    const w = Math.max(0.01, sz * sz);
    sumX += x * w;
    sumY += y * w;
    sumW += w;
  }
  const avgX = sumW > 0 ? sumX / sumW : item.focusX ?? 0.5;
  const avgY = sumW > 0 ? sumY / sumW : item.focusY ?? 0.42;

  // Si la cara está muy arriba o muy abajo, mantener márgenes seguros para pelo/cuerpo y subtítulos
  return {
    focusX: clamp(avgX, 0.20, 0.80, 0.5),
    focusY: clamp(avgY, 0.22, 0.65, 0.40),
    layout: item.layout === 'card' ? 'card' : 'full',
  };
}
