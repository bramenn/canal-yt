// node --experimental-test-module-mocks --test tests/anime-thumbnails.test.mjs
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

let source, request, imagePrompt, composedArt, failCompose = false, generatedHash = 'aaaaaaaaaaaaaaaa';
mock.module('../lib/claude.js', { namedExports: { claudeStep: async (opts) => {
  request = opts; return { data: { index: 0, direction: 'Yuji junto a una alcantarilla ilustrada, vista oblicua' } };
} } });
mock.module('../lib/ytdlp.js', { namedExports: { run: async (_bin, args) => {
  source = args[args.indexOf('-i') + 1]; await writeFile(args.at(-1), 'fresh-frame');
} } });
mock.module('../lib/editor.js', { namedExports: { dhash: async (file) => {
  if (file.endsWith('new.png')) return generatedHash;
  if (file.includes('.thumb-next-')) return 'ffffffffffffffff';
  return '0000000000000000';
} } });
mock.module('../lib/codeximage.js', { namedExports: { generateImage: async (opts) => {
  imagePrompt = opts.prompt; return path.join(path.dirname(opts.ref), '../new.png');
} } });
mock.module('../lib/thumbnail.js', { namedExports: { composeThumb: async ({ dir, art }) => {
  composedArt = art;
  if (failCompose) throw new Error('composición fallida');
  for (const name of ['thumb-4k.jpg', 'thumb.jpg']) await writeFile(path.join(dir, name), 'new-cover');
} } });
const { freshScenes, hashDistance, makeThumb } = await import('../anime/lib/thumb.js');

test('descarta la misma toma y otras casi idénticas aunque cambie el archivo', () => {
  const candidates = [
    { file: 'otro-trailer.mp4', hash: '0000000000000000' },
    { file: 'otro-instante.mp4', hash: '0000000000000003' },
    { file: 'nuevo.mp4', hash: 'ffffffffffffffff' },
    { file: 'ilegible.mp4', hash: null },
  ];
  assert.deepEqual(freshScenes(candidates, [{ frameHash: '0000000000000000' }]), [candidates[2]]);
  assert.equal(hashDistance(null, null), 64);
  assert.equal(freshScenes([candidates[2]], [{ frameHash: '0000000000000000', usedFrameHashes: ['ffffffffffffffff'] }]).length, 0);
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'anime-thumbnails-test-'));
  const old = path.join(root, 'old'), dir = path.join(root, 'current');
  await mkdir(old); await mkdir(dir);
  await writeFile(path.join(old, 'thumb-frame.png'), 'used');
  await writeFile(path.join(old, 'thumb-art.png'), 'old-art');
  await writeFile(path.join(dir, 'thumb.jpg'), 'original-cover');
  await writeFile(path.join(dir, 'new.png'), 'generated');
  return { dir, anime: 'Jujutsu Kaisen', context: 'Yuji ilustrado en tapas de alcantarilla en Tokio',
    script: { title: 'Hechiceros bajo los zapatos', thumb_text: 'CUIDADO DÓNDE PISAS', lines: [{ text: 'Dos tapas ilustradas en Ikebukuro' }] },
    scenes: [{ file: 'used.mp4', s: 0, e: 2, thumb: 1, hash: '0000000000000000' }, { file: 'fresh.mp4', s: 2, e: 4, thumb: 2, hash: 'ffffffffffffffff' }] };
}

test('la portada usa una toma nueva y transmite la historia y composición al generador', async () => {
  const opts = await fixture(); failCompose = false;
  const result = await makeThumb(opts);
  assert.equal(source, 'fresh.mp4');
  assert.match(request.prompt, /alcantarilla/);
  assert.match(imagePrompt, /Dos tapas ilustradas/);
  assert.match(imagePrompt, /NO copies su pose/);
  assert.match(imagePrompt, /vista oblicua/);
  assert.equal(await readFile(result.small, 'utf8'), 'new-cover');
  const meta = JSON.parse(await readFile(path.join(opts.dir, 'thumb-selection.json'), 'utf8'));
  assert.equal(meta.frameHash, 'ffffffffffffffff');
});

test('si no queda material distinto falla sin sustituir la portada anterior', async () => {
  const opts = await fixture(); opts.scenes = opts.scenes.slice(0, 1);
  await assert.rejects(makeThumb(opts), /No hay una toma diferente/);
  assert.equal(await readFile(path.join(opts.dir, 'thumb.jpg'), 'utf8'), 'original-cover');
});

test('un fallo al componer conserva la portada anterior y no contamina su referencia', async () => {
  const opts = await fixture(); failCompose = true;
  try {
    await assert.rejects(makeThumb(opts), /composición fallida/);
    assert.equal(await readFile(path.join(opts.dir, 'thumb.jpg'), 'utf8'), 'original-cover');
    await assert.rejects(readFile(path.join(opts.dir, 'thumb-frame.png')), { code: 'ENOENT' });
  } finally { failCompose = false; }
});

test('un dibujo repetido se rechaza y el respaldo es una toma inédita', async () => {
  const opts = await fixture(); generatedHash = '0000000000000000';
  const messages = [];
  try {
    await makeThumb(opts, (message) => messages.push(message));
    assert.equal(source, 'fresh.mp4');
    assert.equal(path.basename(composedArt), 'thumb-frame.png');
    assert.ok(messages.some((m) => m.includes('se parece demasiado')));
  } finally { generatedHash = 'aaaaaaaaaaaaaaaa'; }
});
