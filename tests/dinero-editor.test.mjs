// node --experimental-test-module-mocks --test tests/dinero-editor.test.mjs
// Render real con ffmpeg; las búsquedas y la IA usan respuestas controladas, sin consumir servicios.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../lib/ytdlp.js';

let photos = [], reviewed = false;
mock.module('../lib/claude.js', { namedExports: {
  claudeStep: async ({ schema }) => {
    if (schema.properties.photos) return { data: { photos: photos.map((_, i) => ({ n: i + 1, desc: `Producto ${i + 1}`, who: '', shot: 'detalle', emotion: '', focusX: i, focusY: 0.5, hook: true, bad: false })) } };
    if (schema.properties.plan) return { data: { plan: [{ slot: 1, id: 'NO_EXISTE' }], climax: 3, motion: [2, 4] } };
    if (schema.properties.fix) { reviewed = true; return { data: { fix: [] } }; }
    throw new Error('Llamada IA inesperada en la prueba');
  },
} });
mock.module('../lib/brave.js', { namedExports: { downloadImages: async () => photos } });
mock.module('../lib/imagepick.js', { namedExports: { pickRelevant: async (files, _q, _about, _dir, opts) => {
  assert.equal(opts.business, true);
  return files;
} } });
mock.module('../lib/codeximage.js', { namedExports: { generateImage: async () => { throw new Error('Generación de imágenes desactivada en pruebas'); } } });

const { cutSlots, enforce, groupTakes } = await import('../lib/editor.js');
const { montage } = await import('../dinero/lib/montage.js');

test('los cortes conservan la duración y no dejan planos largos por un resto corto', () => {
  const words = Array.from({ length: 7 }, (_, i) => ({ w: `w${i}`, s: i * 0.5, e: i * 0.5 + 0.3 }));
  const slots = cutSlots([{ text: 'frase', s: 0, e: 3.2 }], words, { yellow: ['w3'] });
  assert.equal(slots.length, 2);
  assert.equal(slots[0].s, 0);
  assert.equal(slots.at(-1).e, 3.2);
  assert.equal(slots[0].e, slots[1].s);
  assert.ok(slots.every(s => s.e - s.s >= 1.5 && s.e - s.s <= 3.1));
  assert.equal(slots[1].emph, 0);
});

test('el reemplazo del gancho no intercambia fotos entre frases distintas', () => {
  const catalog = [
    { id: 'a', kind: 'image', line: 0, group: 'A', action: 0 },
    { id: 'b', kind: 'image', line: 0, group: 'B', who: 'Fundador', thumb: 1 },
    { id: 'c', kind: 'image', line: 1, group: 'B', who: 'Fundador', thumb: 1 },
  ];
  const { plan } = enforce(['a', 'c'], catalog, { slotLines: [0, 1] });
  assert.ok(plan.every((id, i) => catalog.find(c => c.id === id).line === i));
});

test('las imágenes sin huella no se confunden con una misma toma', () => {
  const catalog = [{ hash: null }, { hash: null }, { hash: 'ffffffffffffffff' }, { hash: 'ffffffffffffffff' }];
  assert.equal(groupTakes(catalog), 3);
  assert.notEqual(catalog[0].group, catalog[1].group);
  assert.equal(catalog[2].group, catalog[3].group);
});

test('montaje vertical con tarjetas continuas, revisión, voz y efectos', { timeout: 240000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dinero-editor-test-'));
  photos = [path.join(dir, 'a.jpg'), path.join(dir, 'b.jpg')];
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=1', '-frames:v', '1', photos[0]]);
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=1', '-frames:v', '1', photos[1]]);
  const voice = path.join(dir, 'voice.wav');
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12.8', '-ar', '44100', voice]);
  const words = [], lines = ['cifra', 'titular', 'grafica', 'foto'].map((show, li) => {
    const ws = Array.from({ length: 8 }, (_, i) => ({ w: `palabra${li}${i}`, s: li * 3.2 + i * 0.4, e: li * 3.2 + i * 0.4 + 0.25 }));
    words.push(...ws);
    return { text: ws.map(w => w.w).join(' '), show, query: `producto ${li}`, number: '$100', label: 'Prueba', outlet: 'Prensa', headline: 'Titular de prueba', bars: [{ label: 'Antes', value: 100 }, { label: 'Ahora', value: 50 }], unit: '%' };
  });
  const logs = [];
  const result = await montage({ script: { title: 'Prueba', lines, yellow: ['palabra30'], red: [] }, about: 'Empresa de prueba', voice, words, duration: 12.8, dir,
    thumb: { small: photos[0], full: photos[0] } }, s => logs.push(s));
  const meta = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', result.video]));
  const video = meta.streams.find(s => s.codec_type === 'video'), audio = meta.streams.find(s => s.codec_type === 'audio');
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);
  assert.ok(audio);
  assert.ok(Math.abs(Number(meta.format.duration) - 13.1) < 0.15);
  assert.ok(Math.abs(Number(audio.duration) - Number(video.duration)) < 0.15);
  assert.ok(reviewed);
  const edit = JSON.parse(await readFile(path.join(dir, 'edit-short.json'), 'utf8'));
  assert.equal(edit.slots.length, 8);
  assert.ok(edit.plan.every((id, i) => edit.catalog.find(c => c.id === id)?.line === edit.slots[i].line));
  const ass = await readFile(path.join(dir, 'subs-short.ass'), 'utf8');
  assert.match(ass, /Num,/);
  assert.match(ass, /Headline,/);
  assert.match(ass, /Bar,/);
  assert.equal(ass.split('\n').filter(l => l.startsWith('Dialogue:') && l.includes(',Headline,')).length, 1);
  assert.ok((await stat(edit.catalog[0].file)).size > 0);
  assert.ok(!logs.some(l => l.includes('Sin efectos')));
  console.log(`MP4 de prueba: ${result.video}`);
});
