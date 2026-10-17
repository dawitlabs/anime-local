import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LibraryStore, withinRoot } from '../server/library.ts';
import { createApp } from '../server/app.ts';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'yoru-library-'));
  const media = path.join(root, 'media');
  await mkdir(path.join(media, 'Series', 'Night Train', 'Season 02'), { recursive: true });
  await mkdir(path.join(media, 'Movies', 'Quiet Sky'), { recursive: true });
  const video = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  await writeFile(path.join(media, 'Series', 'Night Train', 'Season 02', 'S02E10 - Arrival.mp4'), video);
  await writeFile(path.join(media, 'Series', 'Night Train', 'Season 02', 'S02E02 - Departure.mp4'), video);
  await writeFile(
    path.join(media, 'Series', 'Night Train', 'Season 02', 'S02E02 - Departure.en.srt'),
    '1\r\n00:00:01,000 --> 00:00:03,500\r\nHello from home.\r\n',
  );
  await writeFile(
    path.join(media, 'Series', 'Night Train', 'title.json'),
    JSON.stringify({
      title: 'The Night Train',
      year: 2026,
      genres: ['Adventure'],
      description: 'A test series.',
    }),
  );
  await writeFile(path.join(media, 'Movies', 'Quiet Sky', 'movie.mp4'), video);
  await writeFile(path.join(media, 'Movies', 'Quiet Sky', 'poster.jpg'), 'poster');
  const store = new LibraryStore(media);
  await store.scan();
  return { root, media, store, video };
}

test('scans movies and seasons, sorts episode numbers, reads metadata and subtitles', async (context) => {
  const { root, store } = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(store.library.titles.length, 2);
  const series = store.library.titles.find((title) => title.kind === 'series')!;
  assert.equal(series.name, 'The Night Train');
  assert.equal(series.year, 2026);
  assert.deepEqual(
    series.episodes.map((episode) => [episode.season, episode.number]),
    [
      [2, 2],
      [2, 10],
    ],
  );
  assert.equal(series.episodes[0].subtitles[0].language, 'en');
  assert.match(store.library.titles.find((title) => title.kind === 'movie')!.poster!, /^\/api\/artwork\//);
  const ids = series.episodes.map((episode) => episode.id);
  await store.scan();
  assert.deepEqual(
    store.library.titles.find((title) => title.kind === 'series')!.episodes.map((episode) => episode.id),
    ids,
  );
  assert.equal(store.library.totalBytes, 768);
});

test('ignores symlinks and refuses an indexed file replaced with an escaping symlink', async (context) => {
  const { root, media, store } = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const secret = path.join(root, 'outside.mp4');
  await writeFile(secret, 'private');
  await symlink(secret, path.join(media, 'escape.mp4'));
  await store.scan();
  assert.equal(store.library.titles.length, 2);
  const episode = store.library.titles.find((title) => title.kind === 'movie')!.episodes[0];
  const file = await store.resolveFile(episode.id, 'video');
  assert.ok(file);
  await rm(file);
  await symlink(secret, file);
  assert.equal(await store.resolveFile(episode.id, 'video'), undefined);
  assert.equal(await store.resolveFile('../outside.mp4', 'video'), undefined);
  assert.equal(withinRoot('/tmp/media', '/tmp/media-elsewhere/file.mp4'), false);
});

test('invalid metadata produces a warning; a failed rescan preserves the last library', async (context) => {
  const { root, media, store } = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(media, 'Series', 'Night Train', 'title.json'), '{broken');
  await store.scan();
  assert.equal(store.library.warnings.length, 1);
  const before = store.library;
  await rm(media, { recursive: true });
  await assert.rejects(store.scan());
  assert.equal(store.library, before);
});

test('HTTP playback supports ranges, suffixes, HEAD, invalid ranges and converted captions', async (context) => {
  const { root, store, video } = await fixture();
  const server = createApp(store).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const series = store.library.titles.find((title) => title.kind === 'series')!;
  const episode = series.episodes[0];
  const url = `${base}/api/stream/${episode.id}`;
  const partial = await fetch(url, { headers: { Range: 'bytes=10-19' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 10-19/256');
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), video.subarray(10, 20));
  const suffix = await fetch(url, { headers: { Range: 'bytes=-5' } });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), video.subarray(-5));
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '256');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(url, { headers: { Range: 'bytes=999-' } })).status, 416);
  assert.equal((await fetch(`${base}/api/stream/missing`)).status, 404);
  assert.equal(
    (
      await fetch(`${base}/api/library/scan`, {
        method: 'POST',
        headers: { Origin: 'https://unrelated.example' },
      })
    ).status,
    403,
  );
  const captions = await fetch(`${base}/api/subtitles/${episode.subtitles[0].id}`);
  assert.match(captions.headers.get('content-type')!, /text\/vtt/);
  assert.match(await captions.text(), /^WEBVTT\n\n1\n00:00:01\.000 --> 00:00:03\.500/);
});
