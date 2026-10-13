// Foto de cada plano elegida MIRANDO: por plano, una rejilla numerada con 8 resultados de búsqueda; Claude ve la rejilla
// junto a lo que dice la voz y elige la que encaja (persona, camiseta, época, lugar) y está limpia. Si ninguna, otra búsqueda.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeStep } from '../../lib/claude.js';
import { gridOf } from './thumbs.js';

const BATCH = 4;

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (queue.length) await fn(queue.shift()); }));
}

const SCHEMA = {
  type: 'object',
  properties: {
    choices: {
      type: 'array',
      items: {
        type: 'object',
        properties: { shot: { type: 'string' }, pick: { type: 'number' }, what: { type: 'string' }, retry_query: { type: 'string' } },
        required: ['shot', 'pick', 'what', 'retry_query'],
      },
    },
  },
  required: ['choices'],
};

const prompt = (items, title) => `Eres el editor gráfico de un vídeo de fútbol narrado sobre fotos. El vídeo se titula «${title}». Para cada plano hay una rejilla de fotos candidatas numeradas (número amarillo). Ábrelas con Read y elige, para cada plano, la foto que MEJOR ilustra lo que dice la voz en ese momento.

La foto encaja si:
- Muestra lo que se nombra: si la voz habla de una persona, es esa persona y se la reconoce (cara, dorsal o nombre); si habla de un estadio, club, trofeo o momento, es ese.
- La época y el contexto cuadran: la camiseta del club o selección de la que se habla en ese momento (no la de otro equipo), la competición y el año aproximados. Si la frase no nombra otro equipo, la camiseta tiene que ser la del club del que trata el vídeo.
- Es una foto real y limpia: sin marca de agua ni logo de agencia o web, sin texto, rótulos, collages, cartas de videojuego, camisetas de tienda ni capturas de pantalla. Mejor apaisada y nítida.
Entre varias que encajan, la más expresiva y cercana a la acción. Si NINGUNA encaja de verdad, pick = 0 y en "retry_query" escribe otra búsqueda de imágenes mejor para ese plano (si eliges una, retry_query = "").

${items.map((it) => `PLANO ${it.key} · se ve: ${it.desc} · voz: "${it.sentence}" · rejilla: ${it.grid}`).join('\n')}

Devuelve "choices": por plano, "shot" (su número), "pick", "what" (qué se ve en la elegida o por qué ninguna sirve) y "retry_query".`;

/**
 * items: [{ key, desc, sentence, query }], exclude: URLs de imagen ya usadas en el vídeo.
 * onPick({ key, media, what }) por cada foto elegida; devuelve las claves que se quedaron sin foto.
 */
export async function pickPhotos({ projectId, items, exclude = [], title = '' }, store, emit, track, signal) {
  const log = (text) => emit({ type: 'log', text });
  const quiet = (e) => { if (!(e.type === 'log' && /^📚/.test(e.text))) emit(e); };
  const used = new Set(exclude);
  const dir = await mkdtemp(path.join(tmpdir(), 'photopick-'));
  let cost = 0;
  let todo = items.map((it) => ({ ...it, tries: 0 }));
  const failed = [];
  try {
    for (let round = 0; round < 2 && todo.length && !signal?.aborted; round++) {
      // rejillas (3 planos a la vez: los buscadores cortan si se les pide todo de golpe)
      const ready = [];
      await pool(todo, 3, async (it) => {
        if (signal?.aborted) return;
        try {
          const r = await store.search(it.query);
          const g = await gridOf(r.items.filter((x) => !used.has(x.url)), dir, `p${it.key.replace('.', '-')}-${round}`, [320, 200]);
          if (g) ready.push({ ...it, ...g }); else failed.push(it.key);
        } catch (e) { log(`⚠️ ${it.key}: ${e.message.slice(0, 120)}`); failed.push(it.key); }
      });
      ready.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
      const retry = [];
      for (let i = 0; i < ready.length && !signal?.aborted; i += BATCH) {
        const batch = ready.slice(i, i + BATCH);
        log(`👀 Claude elige mirando: planos ${batch.map((b) => b.key).join(', ')}`);
        const ev = await claudeStep({ prompt: prompt(batch, title), schema: SCHEMA, system: 'Eres editor gráfico de vídeo deportivo. Miras imágenes con la herramienta Read.', model: 'sonnet', effort: 'low', tools: ['Read'], cwd: dir }, quiet, track);
        cost += ev.cost ?? 0;
        for (const c of ev.data?.choices ?? []) {
          const it = batch.find((b) => b.key === String(c.shot));
          if (!it) continue;
          const cand = it.cands[Number(c.pick) - 1];
          if (cand && !used.has(cand.url)) {
            used.add(cand.url);
            const media = await store.save(projectId, await readFile(cand.file), cand.type, { ...cand.credit, image: cand.url });
            emit({ type: 'photo', key: it.key, media: { ...media, check: { ok: true, what: c.what, v: 2 } } });
            log(`✅ ${it.key}: ${c.what}`);
          } else if (round === 0 && c.retry_query) {
            log(`↩️ ${it.key}: ${c.what} → busco «${c.retry_query}»`);
            retry.push({ ...it, query: c.retry_query });
          } else { log(`📷 ${it.key}: ${c.what}`); failed.push(it.key); }
        }
        // planos que Claude no devolvió: otra ronda con la misma búsqueda
        for (const b of batch) if (!(ev.data?.choices ?? []).some((c) => String(c.shot) === b.key) && round === 0) retry.push(b);
      }
      todo = retry;
    }
    failed.push(...todo.map((x) => x.key));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { failed: [...new Set(failed)], cost };
}
