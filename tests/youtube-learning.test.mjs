import test from 'node:test';
import assert from 'node:assert/strict';
import { virality } from '../lib/virality.js';
import { youtubeLearning, youtubePublicLearning, otherNetworksLearning } from '../anime/lib/youtube-learning.js';

const describe = (p) => ({
  title: p.script?.title,
  hook: p.script?.lines?.[0]?.text,
  angle: `${p.story?.anime ?? ''}: ${p.story?.angle ?? ''}`,
});

test('virality muestra Instagram cuando es la red donde despega el short', () => {
  const t0 = Date.parse('2026-10-19T12:00:00Z');
  const t1 = t0 + 4 * 3600000;
  const makeShort = (id, igViews) => ({
    id,
    stats: {
      instagram: { views: igViews },
      history: [
        { at: t0, ig: 10 },
        { at: t1, ig: igViews },
      ],
    },
  });
  const shorts = [
    makeShort('base-1', 200),
    makeShort('base-2', 220),
    makeShort('base-3', 180),
    makeShort('hit-ig', 1500),
  ];
  const out = virality(shorts);
  assert.equal(out['hit-ig'].level, 'fire');
  assert.equal(out['hit-ig'].net, 'ig');
  assert.match(out['hit-ig'].label, /Instagram/);
  assert.doesNotMatch(out['hit-ig'].label, /undefined/);
});

test('youtubeLearning detecta la mayor caída en la curva de retención e incluye tipo y otras redes', () => {
  const makeDaily = (engaged) => [
    { date: '2026-10-15', views: engaged * 2, engagedViews: engaged, averageViewPercentage: 55, averageViewDuration: 24, estimatedMinutesWatched: 120, likes: 30, comments: 2, shares: 3, subscribersGained: 4, subscribersLost: 0 },
    { date: '2026-10-16', views: 200, engagedViews: 100, averageViewPercentage: 50, averageViewDuration: 22, estimatedMinutesWatched: 40, likes: 10, comments: 0, shares: 1, subscribersGained: 1, subscribersLost: 0 },
    { date: '2026-10-17', views: 100, engagedViews: 50, averageViewPercentage: 48, averageViewDuration: 21, estimatedMinutesWatched: 20, likes: 5, comments: 0, shares: 0, subscribersGained: 0, subscribersLost: 0 },
  ];
  const shorts = [
    {
      id: 's1',
      story: { anime: 'Naruto', angle: 'Clones de sombra', type: 'atemporal' },
      script: {
        title: 'NARUTO Entrenaba Con CLONES!',
        lines: [
          { text: 'Naruto podía entrenar con mil clones al mismo tiempo.' },
          { text: 'Pero había un problema enorme con el cansancio.' },
          { text: 'La historia sigue a un joven ninja que busca ser Hokage.' },
          { text: 'Por eso Kakashi solo se lo permitió a él.' },
        ],
      },
      stats: {
        youtube: {
          videoId: 'vid00000001',
          views: 5000,
          published: Date.parse('2026-10-15T12:00:00Z'),
          public: { source: 'youtube-data-api', fetchedAt: Date.parse('2026-10-18T12:00:00Z'), views: 5000, likes: 250, comments: 5 },
          analytics: {
            through: '2026-10-17',
            daily: makeDaily(900),
            retention: [
              { elapsedVideoTimeRatio: 0.0, audienceWatchRatio: 1.15, relativeRetentionPerformance: 0.6 },
              { elapsedVideoTimeRatio: 0.25, audienceWatchRatio: 1.05, relativeRetentionPerformance: 0.55 },
              { elapsedVideoTimeRatio: 0.5, audienceWatchRatio: 0.48, relativeRetentionPerformance: 0.34 },
              { elapsedVideoTimeRatio: 0.8, audienceWatchRatio: 0.42, relativeRetentionPerformance: 0.5 },
            ],
          },
        },
        instagram: { views: 14000 },
        facebook: { views: 3200 },
      },
    },
    {
      id: 's2',
      story: { anime: 'Bleach', angle: 'Cine' },
      script: { title: 'BLEACH En El CINE!', lines: [{ text: 'Bleach lleva nueve episodios al cine.' }] },
      stats: {
        youtube: {
          videoId: 'vid00000002',
          views: 2000,
          analytics: { through: '2026-10-17', daily: makeDaily(500) },
        },
      },
    },
    {
      id: 's3',
      story: { anime: 'One Piece', angle: 'Francia', type: 'noticia' },
      script: { title: 'LUFFY En FRANCIA!', lines: [{ text: 'Luffy apareció en Francia.' }] },
      stats: {
        youtube: {
          videoId: 'vid00000003',
          views: 1500,
          analytics: { through: '2026-10-17', daily: makeDaily(300) },
        },
      },
    },
  ];

  const out = youtubeLearning(shorts, describe);
  assert.ok(out);
  assert.match(out, /tipo: atemporal/);
  assert.match(out, /tipo: noticia/);
  assert.doesNotMatch(out, /tipo: s\/d/);
  assert.match(out, /Mayor caída al entrar en frase 3/);
  assert.match(out, /SEÑALES DESTACADAS EN OTRAS REDES/);
  assert.match(out, /Instagram 14\.000 vistas/);

  const pub = youtubePublicLearning(shorts, describe);
  assert.match(pub, /tipo: atemporal/);

  const other = otherNetworksLearning(shorts, describe);
  assert.match(other, /Facebook 3\.200 vistas/);
});
