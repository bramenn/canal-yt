// Escalado y mejora de calidad visual de imágenes con Real-ESRGAN Anime
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { run } from './ytdlp.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ESRGAN = process.env.REALESRGAN_BIN || path.join(HERE, '..', '.tools/realesrgan/realesrgan-ncnn-vulkan');
// según la capacidad del equipo: con GPU el modelo grande; sin GPU (servidor) el ligero y con más tiempo
export const ESRGAN_MODEL = process.env.REALESRGAN_MODEL || 'realesrgan-x4plus-anime';
export const ESRGAN_TIMEOUT = Number(process.env.REALESRGAN_TIMEOUT_MS) || 30000;

/**
 * Escala una imagen con Real-ESRGAN (modelo anime) para máxima definición en 1080p/4K.
 * Si ya existe el archivo escalado o falla el binario, devuelve la ruta óptima disponible.
 */
export async function upscaleImage(inputFile, outputDir, scale = 2) {
  if (!inputFile || !existsSync(inputFile)) return inputFile;
  if (!existsSync(ESRGAN)) return inputFile;

  const base = path.basename(inputFile, path.extname(inputFile));
  const outFile = path.join(outputDir, `up-${base}-x${scale}.png`);
  // ya grande (no gana nitidez) o ya falló antes: medido, una imagen de 1447×2048 agota los 30 s y, sin recordar el
  // fallo, se reintentaba en CADA corte que la usaba (+30 s por corte)
  if (existsSync(`${outFile}.fail`)) return inputFile;
  const [w, h] = (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', inputFile]).catch(() => '')).trim().split(',').map(Number);
  if (Math.min(w, h) >= 1000) return inputFile;
  if (existsSync(outFile)) return outFile;

  try {
    await new Promise((resolve, reject) => {
      execFile(ESRGAN, ['-i', inputFile, '-o', outFile, '-n', ESRGAN_MODEL, '-s', String(scale), '-f', 'png'], { timeout: ESRGAN_TIMEOUT }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
    if (existsSync(outFile)) return outFile;
  } catch (e) {
    // Si falla el escalador neuronal, se usa la imagen original (y no se vuelve a intentar con esta imagen)
    // al cortarse por tiempo deja un PNG a medias (negro): se borra para no reutilizarlo
    try { rmSync(outFile, { force: true }); writeFileSync(`${outFile}.fail`, ''); } catch { /* sin caché de fallo */ }
  }
  return inputFile;
}
