// Revisión visual de las fotos con Claude Code (herramienta Read sobre los archivos): detecta marcas de agua
// y texto o gráficos añadidos encima. Por lotes, para no lanzar un proceso por foto.
import path from 'node:path';
import { claudeStep } from '../../lib/claude.js';

const BATCH = 10;

const SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, ok: { type: 'boolean' }, what: { type: 'string' } },
        required: ['file', 'ok', 'what'],
      },
    },
  },
  required: ['results'],
};

const SYSTEM = 'Eres un editor gráfico que revisa fotos antes de usarlas en un vídeo profesional de YouTube. Miras cada imagen con la herramienta Read y respondes con rigor.';

const prompt = (files, title) => `Abre con Read cada una de estas imágenes y decide si se puede usar tal cual en el vídeo${title ? ` «${title}»` : ''}:
${files.map((f) => `- ${f.name}${f.sentence ? ` · plano: se ve ${f.desc} · voz: "${f.sentence}"` : ''}`).join('\n')}

ok = false si tiene CUALQUIERA de estas cosas:
- Marca de agua o logo superpuesto de una agencia, banco de imágenes, web, periódico o canal (Getty, Alamy, EFE, Europa Press, AFP, "©", una URL, un @usuario, un logo de canal de TV o de una web en una esquina), aunque sea semitransparente o pequeño.
- Texto o gráficos añadidos encima de la foto: miniaturas de YouTube, carteles de noticias, cartas o fichas de videojuego (FIFA, FUT, Football Manager), memes, collages, estadísticas, marcadores dibujados, flechas o círculos.
- Capturas de pantalla de webs, redes sociales o de la interfaz de un programa.
- (Si se indica el plano) NO ENCAJA con lo que dice la voz: es otra persona distinta de la que se habla o no se la reconoce, lleva la camiseta de otro club o selección que el de ese momento de la historia (si la frase no nombra otro equipo, debe ser la del club del que trata el vídeo), es otro estadio, trofeo o competición, o no tiene nada que ver con la frase.
ok = true si es una foto limpia. El texto que forma parte de la escena real NO cuenta: patrocinadores de la camiseta, vallas publicitarias del estadio, carteles reales del lugar, dorsales.
"what": en pocas palabras, qué has visto (p. ej. "marca de agua Europa Press abajo a la derecha", "carta FIFA", "foto limpia").
Devuelve un resultado por archivo, con "file" exactamente como aparece arriba.`;

/** files: [{ file (ruta absoluta), desc?, sentence? }] (todas en el mismo directorio). Devuelve Map(nombre de archivo → { ok, what }). */
export async function checkImages(files, emit, track, title = '') {
  const out = new Map();
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    emit({ type: 'log', text: `🔍 Revisando que encajen y sin marcas: ${i + 1}-${i + batch.length} de ${files.length}` });
    const ev = await claudeStep({
      prompt: prompt(batch.map((f) => ({ ...f, name: path.basename(f.file) })), title),
      schema: SCHEMA, system: SYSTEM, model: 'sonnet', effort: 'low', tools: ['Read'], cwd: path.dirname(batch[0].file),
    }, emit, track);
    for (const r of ev.data?.results ?? []) out.set(path.basename(r.file), { ok: !!r.ok, what: r.what });
  }
  return out;
}
