// La IA mira las imágenes candidatas de una búsqueda (rejilla numerada) y se queda solo con las que de verdad muestran
// lo que se busca: los buscadores fallan a menudo (al buscar «Getty» salen obras del Museo Getty). Común a las apps.
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { run } from './ytdlp.js';
import { claudeStep } from './claude.js';

const ff = (args) => run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], 120000);

/** files: imágenes candidatas; query: lo que se buscó; about: de qué va el vídeo. Devuelve las que encajan, en orden. */
export async function pickRelevant(files, query, about, dir, { business = false } = {}) {
  if (!files.length) return files;
  // El criterio de selección es parte del resultado: versionar la caché evita conservar decisiones antiguas que
  // aceptaban portadas, paneles de manga o resultados de otra serie.
  const tag = path.join(dir, `pick-${business ? 'business-v1' : 'v2'}-${path.basename(files[0], path.extname(files[0]))}`);
  // ya revisadas (la versión TikTok reutiliza lo de la de YouTube)
  if (existsSync(`${tag}.json`)) return JSON.parse(await readFile(`${tag}.json`, 'utf8'));
  for (const [i, f] of files.entries()) {
    await ff(['-i', f, '-frames:v', '1', '-vf', `scale=300:300:force_original_aspect_ratio=increase,crop=300:300,drawtext=text='${i + 1}':x=8:y=6:fontsize=40:fontcolor=yellow:box=1:boxcolor=black@0.75:boxborderw=5,format=yuvj420p`, `${tag}-${String(i).padStart(2, '0')}.jpg`]);
  }
  await ff(['-framerate', '1', '-i', `${tag}-%02d.jpg`, '-vf', `tile=${Math.min(4, files.length)}x${Math.ceil(files.length / 4)}:padding=6:color=white`, '-frames:v', '1', `${tag}.jpg`]);
  try {
    const ev = await claudeStep({
      prompt: `Lee la imagen ${path.basename(tag)}.jpg: es una rejilla numerada de fotos encontradas al buscar «${query}» para un vídeo sobre: ${about}.
${business ? 'Devuelve en "good" los números de las fotos que muestran exactamente la persona, empresa, producto, sede o lugar buscados, de mejor a peor. Acepta un logo auténtico si la búsqueda pide ese logo, o si aparece naturalmente en el producto o edificio. Descarta marcas homónimas, otra persona, capturas de noticias o webs, collages, titulares superpuestos, fotos borrosas, recortes que ocultan al protagonista y marcas de agua. Las fotos históricas en blanco y negro son válidas si corresponden a la historia. Las cifras y titulares los dibuja la app: no selecciones imágenes llenas de texto para representarlos. Si ninguna cumple, devuelve "good": [].' : 'Devuelve en "good" solo las fotos que de verdad muestran lo buscado (la persona, la empresa, su logo, su producto, su sede o el lugar), de mejor a peor. Descarta cualquier resultado que no corresponda exactamente, aunque comparta una palabra; también descarta resultados de otra serie, portadas de manga, páginas o viñetas, dibujos en blanco y negro, carteles, logos o cualquier imagen con título japonés/latino, texto grande, subtítulos, interfaz o marca de agua dominante. Para un vídeo vertical solo sirven imágenes limpias, a color y visualmente claras. Si ninguna cumple, devuelve "good": [].'}`,
      schema: { type: 'object', properties: { good: { type: 'array', items: { type: 'number' } } }, required: ['good'] },
      system: 'Eres editor gráfico de vídeo. Miras imágenes con la herramienta Read.', model: 'sonnet', effort: 'low', tools: ['Read'], cwd: dir,
    }, () => {}, () => {});
    const good = [...new Set((ev.data.good ?? []).map((n) => files[n - 1]).filter(Boolean))];
    await writeFile(`${tag}.json`, JSON.stringify(good));
    return good;
  } catch { return business ? [] : files; } // Dinero usa ilustración de respaldo en lugar de fotos sin verificar.
}
