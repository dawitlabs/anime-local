import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebTorrent, { type Torrent } from 'webtorrent';
import { TorrentService } from '../server/torrents.ts';
import { LibraryStore } from '../server/library.ts';
import { StreamingService } from '../server/streaming.ts';
import { createApp } from '../server/app.ts';

const isolated = {
  dht: false,
  tracker: false,
  lsd: false,
  utp: false,
  natUpnp: false,
  natPmp: false,
  webSeeds: false,
};
const exec = promisify(execFile);
async function eventually(check: () => boolean, message: string) {
  for (let tries = 0; tries < 200; tries++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

test(
  'local swarm: magnet metadata, partial reads, torrent HLS, persistence, pause and removal',
  { timeout: 120_000 },
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yoru-torrent-'));
    const seedDir = path.join(root, 'Synthetic series');
    const media = path.join(root, 'media');
    await mkdir(seedDir);
    await mkdir(media);
    const videoPath = path.join(seedDir, 'S01E01 - Test.mp4');
    await exec(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x720:rate=24',
        '-t',
        '45',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-threads',
        '2',
        '-movflags',
        '+faststart',
        videoPath,
      ],
      { timeout: 60_000 },
    );
    await writeFile(path.join(seedDir, 'unselected.bin'), Buffer.alloc(32 * 1024 ** 2, 42));
    const seeder = new WebTorrent(isolated);
    const engine = new WebTorrent(isolated);
    let service = new TorrentService(path.join(root, 'torrents'), 1024 ** 3, isolated, engine);
    const store = new LibraryStore(media);
    await store.scan();
    await service.start();
    store.external = service;
    const streaming = new StreamingService(store, path.join(root, '.cache', 'streams'), 32 * 1024 ** 2, 1);
    const app = createApp(store, false, streaming, service);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    context.after(async () => {
      streaming.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await service.close();
      await new Promise<void>((resolve) => seeder.destroy(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const seed = await new Promise<Torrent>((resolve, reject) => {
      seeder.once('error', reject);
      const options = { announce: [] as string[], pieceLength: 64 * 1024 };
      seeder.seed(seedDir, options, resolve);
    });
    const invalid = await fetch(`${base}/api/torrents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnet: '/etc/passwd' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(
      (await fetch(`${base}/api/torrents`, { method: 'POST', headers: { Origin: 'https://example.com' } }))
        .status,
      403,
    );
    const add = await fetch(`${base}/api/torrents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnet: seed.magnetURI }),
    });
    assert.equal(add.status, 202);
    const { id } = (await add.json()) as { id: string };
    await eventually(() => engine.torrents.length === 1, 'Torrent was not registered');
    engine.torrents[0].addPeer(`127.0.0.1:${seeder.torrentPort}`);
    await eventually(() => service.list()[0]?.state === 'ready', 'Magnet metadata did not become ready');
    assert.equal(service.list()[0].downloaded, 0, 'Adding a source does not download the season');
    assert.equal(store.library.titles[0].source, 'torrent');
    const video = store.library.titles[0].episodes[0];
    const original = await readFile(videoPath);
    const partial = await fetch(`${base}/api/stream/${video.id}`, { headers: { Range: 'bytes=1000-1999' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-length'), '1000');
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), original.subarray(1000, 2000));
    const tail = await fetch(`${base}/api/stream/${video.id}`, { headers: { Range: 'bytes=-1000' } });
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), original.subarray(-1000));
    assert.equal(
      (await fetch(`${base}/api/stream/${video.id}`, { method: 'HEAD' })).headers.get('content-length'),
      String(original.length),
    );
    assert.equal(
      (await fetch(`${base}/api/stream/${video.id}`, { headers: { Range: 'bytes=99999999999-' } })).status,
      416,
    );
    assert.ok(
      service.list()[0].downloaded < original.length / 2,
      'Only requested pieces should be downloaded',
    );
    const playback = await fetch(`${base}/api/playback/${video.id}`);
    assert.equal(playback.status, 200, await playback.text());
    const segment = await fetch(`${base}/api/hls/${video.id}/240/0.ts`);
    assert.equal(segment.status, 200);
    const bytes = Buffer.from(await segment.arrayBuffer());
    assert.ok(bytes.length > 1000 && bytes.length < 350_000);
    const segmentPath = path.join(root, 'segment.ts');
    await writeFile(segmentPath, bytes);
    const { stdout } = await exec('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=height',
      '-of',
      'csv=p=0',
      segmentPath,
    ]);
    assert.match(stdout, /240/);
    const state = service.list()[0];
    assert.ok(
      state.downloaded < original.length,
      `Playback must start before the video finishes: ${state.downloaded} / ${original.length}`,
    );
    assert.ok(state.downloaded < state.total / 2, 'Unselected padding must not download');
    context.diagnostic(
      `Torrent playback started with ${state.downloaded} / ${original.length} video bytes and ${state.total} total torrent bytes; HLS segment ${bytes.length} bytes.`,
    );
    assert.equal(
      (
        await fetch(`${base}/api/torrents/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused: true }),
        })
      ).status,
      204,
    );
    assert.equal(service.list()[0].state, 'paused');
    assert.equal((await fetch(`${base}/api/stream/${video.id}`)).status, 409);
    await service.close();
    service = new TorrentService(path.join(root, 'torrents'), 1024 ** 3, isolated);
    await service.start();
    store.external = service;
    assert.equal(service.list()[0].state, 'paused');
    assert.equal(service.titles[0].episodes[0].id, video.id);
    await service.pause(id, false);
    await eventually(() => service.list()[0]?.state === 'ready', 'Resume did not restore cached metadata');
    assert.ok(service.list()[0].downloaded > 0, 'Cached pieces survive restart');
    await service.remove(id);
    assert.equal(service.count, 0);
    assert.equal(await service.add(seed.torrentFile), id, '.torrent bytes can be imported too');
    await eventually(() => service.list()[0]?.state === 'ready', '.torrent import did not become ready');
    const torrentInput = service.resolveVideo(video.id);
    assert.ok(torrentInput);
    await assert.rejects(fetch(torrentInput.input, { signal: AbortSignal.timeout(150) }), {
      name: 'TimeoutError',
    });
    assert.equal(service.list()[0].downloaded, 0, 'No-peer streams remain partial and can be cancelled');
    await service.remove(id);
    assert.equal(service.titles.length, 0);
    const limited = new TorrentService(path.join(root, 'limited'), 64 * 1024 ** 2, isolated);
    await limited.start();
    try {
      await assert.rejects(limited.add(seed.torrentFile), /capacity exceeded/);
    } finally {
      await limited.close();
    }
  },
);
