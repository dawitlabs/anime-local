import WebTorrent, { type Torrent, type TorrentFile, type Options } from 'webtorrent';
import parseTorrent, { type Instance } from 'parse-torrent';
import rangeParser from 'range-parser';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Title, TorrentStatus } from '../shared/types.ts';
import { type ExternalLibrary, type VideoSource, withinRoot } from './library.ts';
import { StreamError } from './streaming.ts';

const videoExtensions = new Set(['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.ogv']);
const WINDOW_BYTES = 512 * 1024;
interface SavedTorrent {
  id: string;
  source: string;
  file: boolean;
  paused: boolean;
  addedAt: number;
  name: string;
  total: number;
  cachedBytes?: number;
  title?: Title;
}
interface Entry {
  saved: SavedTorrent;
  torrent?: Torrent;
  error?: string;
}

/** A host-side BitTorrent client. No torrent engine or peer traffic runs in the browser. */
export class TorrentService implements ExternalLibrary {
  private client: WebTorrent;
  private entries = new Map<string, Entry>();
  private bridge = createServer((req, res) => {
    const prefix = `/${this.secret}/`;
    if (!req.url?.startsWith(prefix) || !['GET', 'HEAD'].includes(req.method || '')) {
      res.writeHead(404).end();
      return;
    }
    this.serve(req, res, req.url.slice(prefix.length));
  });
  private secret = randomBytes(32).toString('hex');
  private address = '';
  private writes: Promise<void> = Promise.resolve();
  private mutations: Promise<unknown> = Promise.resolve();
  private active = new Map<ServerResponse, () => void>();
  private closed = false;

  constructor(
    readonly directory: string,
    private maxBytes = 20 * 1024 ** 3,
    options: Options = {},
    client?: WebTorrent,
  ) {
    if (!Number.isFinite(maxBytes) || maxBytes < 64 * 1024 ** 2)
      throw new Error('TORRENT_MAX_GB must allow at least 64 MiB.');
    this.client =
      client ||
      new WebTorrent({
        maxConns: 40,
        uploadLimit: 128 * 1024,
        natUpnp: false,
        natPmp: false,
        utp: false,
        ...options,
        webSeeds: false,
      });
    this.client.on('error', (error) => {
      console.error('Torrent engine:', String(error));
      for (const entry of this.entries.values())
        entry.error = 'Torrent engine unavailable. Restart the host.';
    });
  }

  async start() {
    await mkdir(path.join(this.directory, 'pieces'), { recursive: true, mode: 0o700 });
    await new Promise<void>((resolve, reject) => {
      this.bridge.once('error', reject);
      this.bridge.listen(0, '127.0.0.1', resolve);
    });
    const address = this.bridge.address();
    if (!address || typeof address === 'string') throw new Error('Torrent bridge did not start.');
    this.address = `http://127.0.0.1:${address.port}/${this.secret}`;
    let saved: unknown;
    try {
      saved = JSON.parse(await readFile(path.join(this.directory, 'library.json'), 'utf8'));
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      return;
    }
    if (!Array.isArray(saved) || saved.length > 32) throw new Error('Invalid saved torrent library.');
    for (const item of saved as SavedTorrent[]) {
      if (
        !/^[a-f0-9]{40}$/.test(item.id) ||
        typeof item.source !== 'string' ||
        typeof item.paused !== 'boolean'
      )
        throw new Error('Invalid saved torrent entry.');
      const entry: Entry = { saved: item };
      this.entries.set(item.id, entry);
      if (!item.paused) {
        try {
          this.attach(entry, await this.parse(item.file ? Buffer.from(item.source, 'base64') : item.source));
        } catch {
          entry.error = 'Could not restore this torrent. Remove it and add it again.';
        }
      }
    }
  }

  get count() {
    return this.entries.size;
  }

  async waitForTitle(id: string, timeout: number, signal: AbortSignal): Promise<Title> {
    const deadline = Date.now() + timeout;
    while (!signal.aborted && Date.now() < deadline) {
      const entry = this.entries.get(id);
      if (!entry) throw new StreamError('Source was removed.');
      if (entry.error) throw new StreamError(entry.error);
      if (entry.torrent?.ready && entry.saved.title) return entry.saved.title;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new StreamError('Torrent peers did not supply metadata in time.');
  }
  get cachedBytes() {
    return [...this.entries.values()].reduce(
      (sum, entry) => sum + (entry.torrent?.downloaded || entry.saved.cachedBytes || 0),
      0,
    );
  }
  get titles() {
    return [...this.entries.values()].flatMap((entry) => (entry.saved.title ? [entry.saved.title] : []));
  }
  list(): TorrentStatus[] {
    return [...this.entries.values()].map(({ saved, torrent, error }) => ({
      id: saved.id,
      name: saved.name,
      state: error
        ? 'error'
        : saved.paused
          ? 'paused'
          : torrent?.ready
            ? 'ready'
            : torrent?.files.length
              ? 'checking'
              : 'metadata',
      error,
      peers: torrent?.numPeers || 0,
      downloaded: torrent?.downloaded || saved.cachedBytes || 0,
      total: saved.total,
      downloadSpeed: torrent?.downloadSpeed || 0,
      uploadSpeed: torrent?.uploadSpeed || 0,
      videoCount: saved.title?.episodes.length || 0,
    }));
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(work);
    this.mutations = next.catch(() => {});
    return next;
  }

  async add(source: string | Uint8Array): Promise<string> {
    return this.serialize(async () => {
      const parsed = await this.parse(source);
      if (this.entries.has(parsed.infoHash)) return parsed.infoHash;
      if (this.entries.size >= 32)
        throw new StreamError('Remove a torrent before adding more (limit: 32).', 409);
      this.validate(parsed);
      const entry: Entry = {
        saved: {
          id: parsed.infoHash,
          source: typeof source === 'string' ? source : Buffer.from(source).toString('base64'),
          file: typeof source !== 'string',
          paused: false,
          addedAt: Date.now(),
          name: parsed.name || 'Finding torrent metadata…',
          total: parsed.length || 0,
        },
      };
      this.entries.set(parsed.infoHash, entry);
      try {
        await this.persist();
        this.attach(entry, parsed);
      } catch (error) {
        this.entries.delete(parsed.infoHash);
        throw error;
      }
      return parsed.infoHash;
    });
  }

  private async parse(source: string | Uint8Array): Promise<Instance> {
    if (
      typeof source === 'string'
        ? source.length > 16_384 || !source.startsWith('magnet:?')
        : source.length > 2 * 1024 ** 2
    )
      throw new StreamError('Use a magnet link or a .torrent file smaller than 2 MiB.', 400);
    let parsed: Instance;
    try {
      parsed = await parseTorrent(source);
    } catch {
      throw new StreamError('This is not a valid BitTorrent v1 magnet link or .torrent file.', 400);
    }
    if (!/^[a-f0-9]{40}$/.test(parsed.infoHash))
      throw new StreamError('A BitTorrent v1 info hash is required.', 400);
    // Do not fetch arbitrary HTTP metadata (xs/as) or web seeds from supplied links.
    delete parsed.xs;
    delete parsed.as;
    parsed.urlList = [];
    parsed.announce = (parsed.announce || [])
      .filter((url) => /^(udp|https?|wss?):\/\//.test(url))
      .slice(0, 20);
    return parsed;
  }

  private validate(parsed: {
    infoHash: string;
    length?: number;
    files?: Array<{ path: string; length: number }>;
    pieceLength?: number;
  }) {
    if (!parsed.files?.length) return;
    const reserved = [...this.entries.values()]
      .filter((entry) => entry.saved.id !== parsed.infoHash)
      .reduce((sum, entry) => sum + entry.saved.total, 0);
    if (
      !Number.isSafeInteger(parsed.length) ||
      parsed.length! <= 0 ||
      reserved + parsed.length! > this.maxBytes
    )
      throw new StreamError(
        'Torrent library capacity exceeded. Remove a source or raise TORRENT_MAX_GB on the host.',
        413,
      );
    if (parsed.files.length > 5000 || !parsed.pieceLength || parsed.pieceLength > 16 * 1024 ** 2)
      throw new StreamError('This torrent has too many files or unusually large pieces.', 422);
    const root = path.join(this.directory, 'pieces', parsed.infoHash);
    for (const file of parsed.files) {
      if (
        !file.path ||
        file.path.includes('\\') ||
        file.path.includes('\0') ||
        path.isAbsolute(file.path) ||
        file.path.split('/').some((part) => part === '..' || part === '.' || part.startsWith('.')) ||
        !withinRoot(root, path.resolve(root, file.path)) ||
        !Number.isSafeInteger(file.length) ||
        file.length < 0
      )
        throw new StreamError('Torrent contains an unsafe file path or length.', 422);
    }
  }

  private attach(entry: Entry, parsed: Instance) {
    if (this.closed) throw new StreamError('Server is stopping.');
    const torrent = this.client.add(parsed, {
      path: path.join(this.directory, 'pieces', entry.saved.id),
      deselect: true,
      strategy: 'sequential',
      storeCacheSlots: 4,
      destroyStoreOnDestroy: false,
    });
    entry.torrent = torrent;
    entry.error = undefined;
    torrent.on('error', (error) => {
      entry.error = String(error).slice(0, 300);
    });
    torrent.once('metadata', () => {
      try {
        this.validate(torrent);
      } catch (error) {
        entry.error = error instanceof Error ? error.message : 'Unsupported torrent.';
        torrent.destroy();
        return;
      }
      entry.saved.total = torrent.length;
      entry.saved.name = torrent.name;
      entry.saved.source = Buffer.from(torrent.torrentFile).toString('base64');
      entry.saved.file = true;
      void this.persist().catch(() => {
        entry.error = 'Could not save torrent metadata. Check disk space.';
      });
    });
    torrent.once('ready', () => {
      const videos = torrent.files
        .map((file, index) => ({ file, index }))
        .filter(({ file }) => videoExtensions.has(path.extname(file.name).toLowerCase()))
        .sort((a, b) => a.file.path.localeCompare(b.file.path, 'en', { numeric: true }));
      if (!videos.length) {
        entry.error = 'No supported video files in this torrent.';
        return;
      }
      entry.saved.title = {
        id: `torrent-${entry.saved.id}`,
        source: 'torrent',
        name: torrent.name.replace(/\.(mp4|mkv|webm|m4v|mov|ogv)$/i, '').replace(/[._]/g, ' '),
        kind: videos.length > 1 || /s\d+e\d+/i.test(videos[0].file.name) ? 'series' : 'movie',
        description: 'Streamed from torrent peers through your PC. Pick an episode and press play.',
        genres: [],
        addedAt: entry.saved.addedAt,
        episodes: videos
          .map(({ file, index }, order) => {
            const match = file.path.match(/s(\d+)[ ._-]*e(\d+)/i);
            const number =
              match?.[2] ||
              file.name.replace(/\[[^\]]*\]/g, '').match(/(?:^|[\s_-])(\d{1,4})(?:\b|[ ._-])/)?.[1];
            return {
              id: `t-${entry.saved.id}-${index}`,
              title: file.name.replace(/\.[^.]+$/, '').replace(/[._]/g, ' '),
              filename: file.name,
              season: Number(match?.[1] || file.path.match(/season[ ._-]*(\d+)/i)?.[1] || 1),
              number: Number(number || order + 1),
              format: path.extname(file.name).slice(1).toUpperCase(),
              size: file.length,
              subtitles: [],
            };
          })
          .sort((a, b) => a.season - b.season || a.number - b.number),
      };
      void this.persist().catch(() => {
        entry.error = 'Could not save the torrent library. Check disk space.';
      });
    });
  }

  async pause(id: string, paused: boolean) {
    return this.serialize(async () => {
      const entry = this.entries.get(id);
      if (!entry) throw new StreamError('Torrent not found.', 404);
      if (entry.saved.paused === paused && !entry.error) return;
      entry.saved.paused = paused;
      await this.detach(entry);
      if (!paused)
        this.attach(
          entry,
          await this.parse(entry.saved.file ? Buffer.from(entry.saved.source, 'base64') : entry.saved.source),
        );
      await this.persist();
    });
  }

  async remove(id: string) {
    return this.serialize(async () => {
      const entry = this.entries.get(id);
      if (!entry) throw new StreamError('Torrent not found.', 404);
      await this.detach(entry);
      this.entries.delete(id);
      await this.persist();
      await rm(path.join(this.directory, 'pieces', id), { recursive: true, force: true });
    });
  }

  private async detach(entry: Entry) {
    const torrent = entry.torrent;
    if (torrent) entry.saved.cachedBytes = torrent.downloaded;
    entry.torrent = undefined;
    if (torrent && (await this.client.get(entry.saved.id)))
      await new Promise<void>((resolve, reject) => {
        void this.client
          .remove(torrent, { destroyStore: false }, (error?: Error | null) =>
            error ? reject(error) : resolve(),
          )
          .catch(reject);
      });
  }

  private persist() {
    const json = JSON.stringify(
      [...this.entries.values()].map((entry) => entry.saved),
      null,
      2,
    );
    const next = this.writes.then(async () => {
      const target = path.join(this.directory, 'library.json');
      await writeFile(`${target}.tmp`, json, { mode: 0o600 });
      await rename(`${target}.tmp`, target);
    });
    this.writes = next.catch(() => {});
    return next;
  }

  private file(id: string): TorrentFile {
    const match = /^t-([a-f0-9]{40})-(\d+)$/.exec(id);
    const entry = match && this.entries.get(match[1]);
    if (!entry || !entry.saved.title?.episodes.some((episode) => episode.id === id))
      throw new StreamError('Torrent video not found.', 404);
    if (entry.saved.paused)
      throw new StreamError('This torrent is paused. Resume it in Torrent sources.', 409);
    if (entry.error) throw new StreamError(entry.error);
    if (!entry.torrent?.ready)
      throw new StreamError('Waiting for torrent metadata or checking cached pieces. Try again shortly.');
    const file = entry.torrent.files[Number(match![2])];
    if (!file) throw new StreamError('Torrent video not found.', 404);
    return file;
  }

  resolveVideo(id: string): VideoSource | undefined {
    if (!id.startsWith('t-')) return undefined;
    const file = this.file(id);
    return { input: `${this.address}/${id}`, version: `${id}:${file.length}`, network: true };
  }

  serve(req: IncomingMessage, res: ServerResponse, id: string) {
    try {
      if (this.closed || this.active.size >= 12)
        throw new StreamError('Torrent streams are busy. Try again shortly.');
      const file = this.file(id);
      const ranges = req.headers.range ? rangeParser(file.length, req.headers.range) : undefined;
      if (ranges && (typeof ranges === 'number' || ranges.type !== 'bytes' || ranges.length !== 1)) {
        res.writeHead(416, { 'Content-Range': `bytes */${file.length}` }).end();
        return;
      }
      const { start, end } =
        ranges && typeof ranges !== 'number' ? ranges[0] : { start: 0, end: file.length - 1 };
      res.statusCode = ranges ? 206 : 200;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Length', end - start + 1);
      res.setHeader(
        'Content-Type',
        (
          {
            '.mp4': 'video/mp4',
            '.m4v': 'video/mp4',
            '.mkv': 'video/x-matroska',
            '.webm': 'video/webm',
            '.ogv': 'video/ogg',
          } as Record<string, string>
        )[path.extname(file.name).toLowerCase()] || 'video/quicktime',
      );
      if (ranges) res.setHeader('Content-Range', `bytes ${start}-${end}/${file.length}`);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      let current: ReturnType<TorrentFile['createReadStream']> | undefined;
      let stopped = false;
      const timer = setTimeout(() => {
        stop();
        res.destroy(new Error('Torrent peers timed out.'));
      }, 60_000);
      // A single unbounded WebTorrent stream selects the whole episode. Read bounded
      // windows with backpressure and cancel their selections when the viewer seeks.
      const output = Readable.from(
        (async function* () {
          for (let offset = start; offset <= end && !stopped; offset += WINDOW_BYTES) {
            current = file.createReadStream({ start: offset, end: Math.min(end, offset + WINDOW_BYTES - 1) });
            try {
              for await (const chunk of current) {
                timer.refresh();
                yield chunk;
              }
            } finally {
              current.destroy();
            }
          }
        })(),
        { objectMode: false, highWaterMark: 64 * 1024 },
      );
      const stop = () => {
        stopped = true;
        current?.destroy();
        output.destroy();
        clearTimeout(timer);
        this.active.delete(res);
      };
      this.active.set(res, stop);
      res.once('close', stop);
      output.once('error', () => {
        stop();
        res.destroy();
      });
      output.pipe(res);
    } catch (error) {
      res.statusCode = error instanceof StreamError ? error.status : 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Torrent stream failed.' }));
    }
  }

  async close() {
    this.closed = true;
    for (const [response, stop] of this.active) {
      stop();
      response.destroy();
    }
    this.bridge.closeAllConnections();
    await new Promise<void>((resolve) => this.bridge.close(() => resolve()));
    await this.mutations;
    for (const entry of this.entries.values()) {
      if (entry.torrent) entry.saved.cachedBytes = entry.torrent.downloaded;
    }
    await this.persist();
    await new Promise<void>((resolve) => this.client.destroy(() => resolve()));
    await this.writes;
  }
}
