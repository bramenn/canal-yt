// node --experimental-test-module-mocks --test tests/anime-comments.test.mjs
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let request, answer;
mock.module('../lib/claude.js', { namedExports: { claudeStep: async (options) => {
  request = options;
  return { data: answer };
} } });
const { writeCopy, writeComment, COPY_FIELDS } = await import('../lib/social.js');
const about = { about: 'Nirvana en un anime de romance.', brand: '@notianimes', keywordsHint: 'anime' };

test('las otras apps conservan su esquema y texto de publicación', async () => {
  answer = { yt_title: 'Título sin cambios' };
  assert.equal(await writeCopy(about), answer);
  assert.deepEqual(request.schema.required, COPY_FIELDS);
  assert.ok(!Object.hasOwn(request.schema.properties, 'suggested_comment'));
  assert.ok(!request.prompt.includes('suggested_comment'));
});

test('anime añade el comentario al mismo paso sin modificar el guion', async () => {
  answer = { suggested_comment: '¿Qué banda te gustaría escuchar en un opening?' };
  assert.equal(await writeCopy({ ...about, includeComment: true }), answer);
  assert.ok(request.schema.required.includes('suggested_comment'));
  assert.equal(request.schema.properties.suggested_comment.maxLength, 240);
  assert.match(request.prompt, /No modifiques el guion/);
  assert.deepEqual(request.tools, []);
  assert.equal(COPY_FIELDS.length, 5);
});

test('los vídeos antiguos generan únicamente un comentario recortado', async () => {
  answer = { suggested_comment: '  ¿Qué banda te gustaría escuchar en un opening?  ' };
  assert.equal(await writeComment(about.about), answer.suggested_comment.trim());
  assert.deepEqual(request.schema.required, ['suggested_comment']);
  assert.deepEqual(Object.keys(request.schema.properties), ['suggested_comment']);
  assert.match(request.prompt, /Nirvana/);
});

test('no guarda respuestas vacías ni demasiado largas', async () => {
  for (const value of [undefined, null, 42, '', '  ', 'corto', 'a'.repeat(241)]) {
    answer = { suggested_comment: value };
    await assert.rejects(writeComment(about.about), /comentario válido/);
  }
});
