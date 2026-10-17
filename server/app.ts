import express, { type ErrorRequestHandler } from 'express';
import compression from 'compression';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { LibraryStore } from './library.ts';
import { StreamError, type StreamingService } from './streaming.ts';
import type { TorrentService } from './torrents.ts';

export function createApp(
  store: LibraryStore,
  development = false,
  streaming?: StreamingService,
  torrents?: TorrentService,
) {
  const app = express();
  app.use(compression());
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (!development)
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data:; font-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
      );
    // The API is private to this origin, including when enabled on a trusted LAN.
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) {
      res.status(403).json({ code: 'CROSS_ORIGIN', error: 'Use the app from its own address.' });
      return;
    }
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  if (torrents) {
    app.get('/api/torrents', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(torrents.list());
    });
    app.post('/api/torrents', express.json({ limit: '20kb' }), async (req, res) => {
      const body: unknown = req.body;
      if (!body || typeof body !== 'object' || !('magnet' in body) || typeof body.magnet !== 'string')
        throw new StreamError('Enter a magnet link.', 400);
      res.status(202).json({ id: await torrents.add(body.magnet.trim()) });
    });
    app.post(
      '/api/torrents/file',
      express.raw({ type: 'application/octet-stream', limit: '2mb' }),
      async (req, res) => {
        if (!Buffer.isBuffer(req.body) || !req.body.length)
          throw new StreamError('Choose a .torrent file.', 400);
        res.status(202).json({ id: await torrents.add(req.body) });
      },
    );
    app.patch('/api/torrents/:id', express.json({ limit: '1kb' }), async (req, res) => {
      const body: unknown = req.body;
      if (!body || typeof body !== 'object' || !('paused' in body) || typeof body.paused !== 'boolean')
        throw new StreamError('paused must be true or false.', 400);
      await torrents.pause(req.params.id, body.paused);
      res.sendStatus(204);
    });
    app.delete('/api/torrents/:id', async (req, res) => {
      await torrents.remove(req.params.id);
      res.sendStatus(204);
    });
  }
  app.get('/api/library', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(store.library);
  });
  app.post('/api/library/scan', async (_req, res) => {
    try {
      res.json(await store.scan());
    } catch {
      res.status(503).json({
        code: 'SCAN_FAILED',
        error: 'Could not read the media folder. Check MEDIA_DIR and folder permissions, then scan again.',
      });
    }
  });
  if (streaming) {
    app.get('/api/playback/:id', async (req, res) => {
      const info = await streaming.info(req.params.id);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        manifest: `/api/hls/${req.params.id}/master.m3u8`,
        duration: info.duration,
        qualities: info.qualities.map((quality) => quality.height),
      });
    });
    app.get('/api/hls/:id/master.m3u8', async (req, res) => {
      const info = await streaming.info(req.params.id);
      res.setHeader('Cache-Control', 'no-cache');
      res.type('application/vnd.apple.mpegurl').send(streaming.master(info));
    });
    app.get('/api/hls/:id/:quality/index.m3u8', async (req, res) => {
      const info = await streaming.info(req.params.id);
      res.setHeader('Cache-Control', 'no-cache');
      res.type('application/vnd.apple.mpegurl').send(streaming.playlist(info, Number(req.params.quality)));
    });
    app.get('/api/hls/:id/:quality/:segment.ts', async (req, res, next) => {
      const info = await streaming.info(req.params.id);
      const segment = await streaming.segment(info, Number(req.params.quality), Number(req.params.segment));
      res.on('close', segment.release);
      res.on('finish', segment.release);
      // IDs stay stable when a local file is replaced. Revalidate instead of
      // allowing a browser to keep chunks from an older version of that file.
      res
        .type('video/mp2t')
        .sendFile(path.basename(segment.file), { root: path.dirname(segment.file), maxAge: 0 }, (error) => {
          if (error) {
            segment.release();
            next(error);
          }
        });
    });
  }
  app.get('/api/stream/:id', async (req, res, next) => {
    if (torrents && req.params.id.startsWith('t-')) {
      torrents.serve(req, res, req.params.id);
      return;
    }
    const file = await store.resolveFile(req.params.id, 'video');
    if (!file) {
      res
        .status(404)
        .json({ code: 'VIDEO_NOT_FOUND', error: 'Video no longer exists. Rescan your library.' });
      return;
    }
    // sendFile streams from disk and handles byte ranges, HEAD, seeking and backpressure.
    const types: Record<string, string> = {
      '.mkv': 'video/x-matroska',
      '.m4v': 'video/mp4',
      '.ogv': 'video/ogg',
    };
    const type = types[path.extname(file).toLowerCase()];
    if (type) res.type(type);
    res.sendFile(
      path.basename(file),
      { root: path.dirname(file), cacheControl: false, dotfiles: 'deny' },
      (error) => {
        if (error) next(error);
      },
    );
  });
  app.get('/api/artwork/:id', async (req, res, next) => {
    const file = await store.resolveFile(req.params.id, 'artwork');
    if (!file) {
      res.status(404).json({ code: 'ARTWORK_NOT_FOUND', error: 'Artwork not found.' });
      return;
    }
    res.sendFile(path.basename(file), { root: path.dirname(file), maxAge: '1h' }, (error) => {
      if (error) next(error);
    });
  });
  app.get('/api/subtitles/:id', async (req, res) => {
    const file = await store.resolveFile(req.params.id, 'subtitle');
    if (!file) {
      res.status(404).json({ code: 'SUBTITLE_NOT_FOUND', error: 'Subtitle not found.' });
      return;
    }
    if ((await stat(file)).size > 5_000_000) {
      res
        .status(413)
        .json({ code: 'SUBTITLE_TOO_LARGE', error: 'Subtitle files must be smaller than 5 MB.' });
      return;
    }
    let content = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (path.extname(file).toLowerCase() === '.srt') {
      content = `WEBVTT\n\n${content.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;
    }
    res.type('text/vtt').send(content);
  });
  app.use('/api', (_req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', error: 'API route not found.' });
  });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof StreamError) {
      res.status(error.status).json({ code: 'STREAM_UNAVAILABLE', error: error.message });
      return;
    }
    const status =
      error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
        ? error.status
        : 500;
    res.status(status >= 400 && status < 600 ? status : 500).json({
      code: status === 416 ? 'INVALID_RANGE' : 'REQUEST_FAILED',
      error:
        status === 416 ? 'Requested video range is not available.' : 'The request could not be completed.',
    });
  };
  app.use(errors);
  return app;
}
