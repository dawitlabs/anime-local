import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LibraryStore } from '../server/library.ts';
import { StreamingService } from '../server/streaming.ts';
import { createApp } from '../server/app.ts';

const exec = promisify(execFile);

test(
  'real FFmpeg: arbitrary seek, low-bandwidth variants, shared chunk cache and HLS routes',
  { timeout: 120_000 },
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yoru-stream-'));
    const media = path.join(root, 'media');
    const cache = path.join(root, '.cache', 'streams');
    await mkdir(media);
    const file = path.join(media, 'Sample.mp4');
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
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '19',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-threads',
        '2',
        '-c:a',
        'aac',
        '-pix_fmt',
        'yuv420p',
        file,
      ],
      { timeout: 60_000 },
    );
    const store = new LibraryStore(media);
    await store.scan();
    const service = new StreamingService(store, cache, 32 * 1024 ** 2, 1);
    const server = createApp(store, false, service).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    context.after(async () => {
      service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const id = store.library.titles[0].episodes[0].id;
    const playback = await fetch(`${base}/api/playback/${id}`);
    assert.equal(playback.status, 200);
    assert.deepEqual(((await playback.json()) as { qualities: number[] }).qualities, [240, 360, 720]);
    const master = await (await fetch(`${base}/api/hls/${id}/master.m3u8`)).text();
    assert.match(master, /RESOLUTION=426x240/);
    assert.match(master, /720\/index.m3u8/);
    const playlist = await (await fetch(`${base}/api/hls/${id}/240/index.m3u8`)).text();
    assert.match(playlist, /#EXT-X-PLAYLIST-TYPE:VOD/);
    assert.match(playlist, /#EXTINF:1\.000000,\n3.ts/);
    assert.match(playlist, /#EXT-X-ENDLIST/);
    const chunkURL = `${base}/api/hls/${id}/240/2.ts`;
    const chunks = await Promise.all([fetch(chunkURL), fetch(chunkURL)]);
    assert.ok(chunks.every((response) => response.status === 200));
    const [first, second] = await Promise.all(
      chunks.map(async (response) => Buffer.from(await response.arrayBuffer())),
    );
    assert.deepEqual(first, second);
    assert.ok(
      first.byteLength > 0 && first.byteLength < 350_000,
      `240p six-second chunk was ${first.byteLength} bytes`,
    );
    const cached = (await readdir(cache)).filter((name) => name.endsWith('.ts'));
    assert.equal(cached.length, 1, 'Only the requested chunk is encoded, and concurrent requests share it.');
    const chunkFile = path.join(cache, cached[0]);
    const before = (await stat(chunkFile)).mtimeMs;
    await (await fetch(chunkURL)).arrayBuffer();
    assert.equal((await stat(chunkFile)).mtimeMs, before, 'A repeat request reuses the cached chunk.');
    const { stdout } = await exec('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=height',
      '-of',
      'json',
      chunkFile,
    ]);
    assert.equal((JSON.parse(stdout) as { streams: Array<{ height: number }> }).streams[0].height, 240);
    assert.equal((await fetch(`${base}/api/hls/${id}/240/999.ts`)).status, 404);
    assert.equal((await fetch(`${base}/api/hls/${id}/1080/index.m3u8`)).status, 404);
    assert.equal((await fetch(`${base}/api/hls/missing/master.m3u8`)).status, 404);
  },
);
