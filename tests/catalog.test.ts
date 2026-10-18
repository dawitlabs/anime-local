import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CatalogService, normalizeAnime, normalizeSources } from '../server/catalog.ts';
import type { TorrentService } from '../server/torrents.ts';
import type { Title } from '../shared/types.ts';

const meta = {
  id: 'kitsu:1',
  name: 'Synthetic story',
  type: 'series',
  genres: ['Adventure'],
  videos: [
    { id: 'kitsu:1:1', title: 'The beginning', episode: 1 },
    { id: 'kitsu:1:2', title: 'The journey', episode: 2 },
    { id: 'kitsu:1:3', title: 'Not released', episode: 3, released: '2099-01-01' },
    { id: 'kitsu:2:1', title: 'Wrong show', episode: 1 },
  ],
};
const hash = 'a'.repeat(40);
const other = 'b'.repeat(40);
const noTorrents = {
  add: async () => {
    throw new Error('Unexpected torrent');
  },
  list: () => [],
  resolveVideo: () => undefined,
  waitForTitle: async () => {
    throw new Error('Unexpected torrent');
  },
  pause: async () => {},
  remove: async () => {},
} satisfies Pick<TorrentService, 'add' | 'list' | 'resolveVideo' | 'waitForTitle' | 'pause' | 'remove'>;

test('catalog normalizes released episodes and ranks smaller seeded sources without accepting arbitrary URLs', () => {
  const title = normalizeAnime(
    { ...meta, poster: 'http://unsafe.example/poster', background: 'https://example.org/art.jpg' },
    true,
  )!;
  assert.equal(title.episodes.length, 2);
  assert.equal(title.poster, undefined);
  assert.equal(title.backdrop, 'https://example.org/art.jpg');
  assert.equal(normalizeAnime({ ...meta, id: '../../etc/passwd' }), undefined);
  const movie = normalizeAnime({ id: 'kitsu:5', name: 'Film', type: 'movie' }, true)!;
  assert.equal(movie.episodes[0].id, 'kitsu:5');
  const sources = normalizeSources([
    { infoHash: hash, fileIdx: 1, name: '1080p', title: '👤 30 💾 700 MB' },
    { infoHash: other, fileIdx: 2, name: '480p', title: '👤 8 💾 150 MB' },
    { infoHash: other, fileIdx: 2, name: '480p', title: 'duplicate' },
    { url: 'http://127.0.0.1/private', title: 'arbitrary HTTP is ignored' },
    { infoHash: 'c'.repeat(40), name: '2160p', title: '👤 50 💾 9 GB' },
  ]);
  assert.deepEqual(
    sources.map((source) => source.hash),
    [other, hash],
  );
});

test('provider failures and malformed pages are retriable; successful requests are shared and cached', async () => {
  let calls = 0;
  const urls: string[] = [];
  const catalog = new CatalogService(noTorrents, {
    fetcher: async (url) => {
      urls.push(String(url));
      calls++;
      if (calls === 1) return new Response('provider offline', { status: 503 });
      if (calls === 2) return Response.json({ streams: [] });
      return Response.json({ metas: [meta] });
    },
  });
  try {
    await assert.rejects(catalog.browse('space & time'), /unavailable/);
    await assert.rejects(catalog.browse('space & time'), /unavailable/);
    const [first, second] = await Promise.all([
      catalog.browse('space & time'),
      catalog.browse('space & time'),
    ]);
    assert.equal(first.titles[0].name, meta.name);
    assert.deepEqual(first, second);
    await catalog.browse('space & time');
    assert.equal(calls, 3);
    assert.match(urls[0], /search=space%20%26%20time/);
    await assert.rejects(catalog.browse('', -1), /Invalid/);
    await assert.rejects(catalog.resolve('kitsu:2', 'kitsu:1:1'), /Invalid episode/);
  } finally {
    catalog.close();
  }
});

test('automatic selection checks file identity, falls back, shares concurrent work, and supports another source', async (context) => {
  const bridge = createServer((_req, res) => {
    res.writeHead(206);
    res.end(Buffer.alloc(65536));
  });
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  const address = bridge.address();
  assert.ok(address && typeof address === 'object');
  context.after(
    () =>
      new Promise<void>((resolve) => {
        bridge.closeAllConnections();
        bridge.close(() => resolve());
      }),
  );
  const added: string[] = [];
  const removed: string[] = [];
  const existing = new Set<string>();
  let requests = 0;
  let goodFirst = false;
  const access = {
    ...noTorrents,
    add: async (magnet: string | Uint8Array) => {
      const id = String(magnet).match(/btih:([a-f0-9]{40})/)![1];
      added.push(id);
      existing.add(id);
      return id;
    },
    remove: async (id: string) => {
      removed.push(id);
      existing.delete(id);
    },
    list: () =>
      [...existing].map((id) => ({
        id,
        state: 'ready' as const,
        name: 'Fixture',
        peers: 1,
        downloaded: 0,
        total: 10,
        downloadSpeed: 0,
        uploadSpeed: 0,
        videoCount: 2,
      })),
    waitForTitle: async (id: string): Promise<Title> => ({
      ...normalizeAnime(meta, true)!,
      source: 'torrent',
      episodes: [1, 2].map((n) => ({
        id: `t-${id}-${n}`,
        title: `Episode ${n}`,
        filename: id === hash && !goodFirst ? `Wrong${n}.mp4` : `Episode${n}.mp4`,
        season: 1,
        number: n,
        size: 100000,
        format: 'MP4',
        subtitles: [],
      })),
    }),
    resolveVideo: () => ({ input: `http://127.0.0.1:${address.port}/video`, network: true, version: '1' }),
  };
  const catalog = new CatalogService(access, {
    fetcher: async (url) => {
      if (String(url).includes('/meta/')) return Response.json({ meta });
      requests++;
      return Response.json({
        streams: [hash, other].map((id, index) => ({
          infoHash: id,
          fileIdx: 1,
          name: '480p',
          title: `👤 2 💾 ${100 + index} MB`,
          behaviorHints: { filename: 'Episode2.mp4' },
        })),
      });
    },
  });
  context.after(() => catalog.close());
  const [result, duplicate] = await Promise.all([
    catalog.resolve('kitsu:1', 'kitsu:1:2'),
    catalog.resolve('kitsu:1', 'kitsu:1:2'),
  ]);
  assert.equal(result.streamId, `t-${other}-2`, 'Filename must win over an inaccurate index');
  assert.deepEqual(result, duplicate);
  assert.deepEqual(removed, [hash]);
  assert.deepEqual(added, [hash, other]);
  assert.equal(requests, 1);
  goodFirst = true;
  assert.equal((await catalog.resolve('kitsu:1', 'kitsu:1:2', true)).streamId, `t-${hash}-2`);
  assert.ok(existing.has(other), 'A prior playable source must survive retry');
  await assert.rejects(catalog.resolve('kitsu:1', 'kitsu:1:3'), /not available/);
});
