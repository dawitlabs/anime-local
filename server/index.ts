import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { access } from 'node:fs/promises';
import express from 'express';
import { createApp } from './app.ts';
import { LibraryStore } from './library.ts';
import { StreamingService } from './streaming.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mediaDirectory = path.resolve(root, process.env.MEDIA_DIR || 'media');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const development = process.argv.includes('--dev');
const store = new LibraryStore(mediaDirectory);
try {
  await store.scan();
} catch {
  console.error(`Cannot read media folder: ${mediaDirectory}\nCreate the folder or set MEDIA_DIR in .env.`);
  process.exit(1);
}
const streaming = new StreamingService(
  store,
  path.resolve(root, process.env.CACHE_DIR || '.cache/streams'),
  Number(process.env.CACHE_MAX_MB || 512) * 1024 ** 2,
  Number(process.env.TRANSCODE_WORKERS || 2),
);
const app = createApp(store, development, streaming);
const server = createServer(app);
let closeVite: (() => Promise<void>) | undefined;
if (development) {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    root,
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
  closeVite = () => vite.close();
} else {
  const dist = path.join(root, 'dist');
  try {
    await access(path.join(dist, 'index.html'));
  } catch {
    console.error('Build the website first with: npm run build');
    process.exit(1);
  }
  app.use('/assets', express.static(path.join(dist, 'assets'), { immutable: true, maxAge: '1y' }));
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}
server.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
server.listen(port, host, () => {
  console.log(
    `\n  YORU · Your own little cinema\n  http://${host === '0.0.0.0' ? 'localhost' : host}:${port}\n  Media: ${mediaDirectory}\n  ${store.library.titles.length} titles ready to watch\n`,
  );
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    streaming.close();
    server.close(() => {
      void closeVite?.().finally(() => process.exit(0));
      if (!closeVite) process.exit(0);
    });
    server.closeAllConnections();
  });
}
