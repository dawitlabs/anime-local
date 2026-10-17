import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LibraryStore, VideoSource } from './library.ts';

const exec = promisify(execFile);
export const SEGMENT_SECONDS = 6;
const profiles = [
  { height: 240, videoKbps: 200, audioKbps: 40 },
  { height: 360, videoKbps: 400, audioKbps: 48 },
  { height: 720, videoKbps: 1300, audioKbps: 64 },
];
interface Quality {
  height: number;
  width: number;
  videoKbps: number;
  audioKbps: number;
}
interface MediaInfo {
  network: boolean;
  key: string;
  file: string;
  duration: number;
  audio: boolean;
  qualities: Quality[];
}
interface CacheEntry {
  size: number;
  used: number;
  leases: number;
}

export class StreamError extends Error {
  constructor(
    message: string,
    readonly status = 503,
  ) {
    super(message);
  }
}

/** Demand-driven HLS: encode only the six-second chunks a viewer actually requests. */
export class StreamingService {
  private metadata = new Map<string, Promise<MediaInfo>>();
  private inFlight = new Map<string, Promise<string>>();
  private entries = new Map<string, CacheEntry>();
  private bytes = 0;
  private running = 0;
  private queue: Array<() => void> = [];
  private ready: Promise<void>;
  private closed = false;
  private abort = new AbortController();
  private commits: Promise<void> = Promise.resolve();

  constructor(
    private store: LibraryStore,
    readonly cacheDirectory: string,
    private maxBytes = 512 * 1024 ** 2,
    private concurrency = 2,
  ) {
    if (!Number.isFinite(maxBytes) || maxBytes < 32 * 1024 ** 2)
      throw new Error('CACHE_MAX_MB must be at least 32.');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
      throw new Error('TRANSCODE_WORKERS must be from 1 to 4.');
    this.ready = this.initialize();
    void this.ready.catch(() => {});
  }

  private async initialize() {
    await mkdir(this.cacheDirectory, { recursive: true });
    for (const name of await readdir(this.cacheDirectory)) {
      if (!/^[a-f0-9]{24}_\d+_\d+\.ts(?:\.partial)?$/.test(name)) continue;
      const file = path.join(this.cacheDirectory, name);
      if (name.endsWith('.partial')) {
        await rm(file, { force: true });
        continue;
      }
      const info = await stat(file);
      this.entries.set(file, { size: info.size, used: info.mtimeMs, leases: 0 });
      this.bytes += info.size;
    }
    await this.makeSpace(0);
  }

  async info(id: string): Promise<MediaInfo> {
    const source = await this.store.resolveVideo(id);
    if (!source) throw new StreamError('Video not found. Check your library or torrent sources.', 404);
    const key = createHash('sha256').update(`v2:${source.version}`).digest('hex').slice(0, 24);
    let pending = this.metadata.get(key);
    if (!pending) {
      pending = this.probe(source, key);
      this.metadata.set(key, pending);
      void pending.catch(() => this.metadata.delete(key));
      if (this.metadata.size > 1024) this.metadata.delete(this.metadata.keys().next().value!);
    }
    return pending;
  }

  private async probe(source: VideoSource, key: string): Promise<MediaInfo> {
    let stdout: string;
    try {
      ({ stdout } = await exec(
        'ffprobe',
        [
          '-v',
          'error',
          '-protocol_whitelist',
          source.network ? 'http,tcp' : 'file',
          ...(source.network ? ['-rw_timeout', '60000000'] : []),
          '-show_entries',
          'stream=codec_type,width,height:format=duration',
          '-of',
          'json',
          source.input,
        ],
        { timeout: source.network ? 90_000 : 15_000, maxBuffer: 1024 * 1024, signal: this.abort.signal },
      ));
    } catch {
      throw new StreamError(
        source.network
          ? 'Could not read the video from peers. Check torrent status, wait for peers, then retry. FFmpeg must be installed.'
          : 'Adaptive streaming needs FFmpeg and FFprobe installed on the host PC, and a readable video file.',
      );
    }
    const data = JSON.parse(stdout) as {
      streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
      format?: { duration?: string };
    };
    const video = data.streams?.find((item) => item.codec_type === 'video');
    const duration = Number(data.format?.duration);
    if (!video?.width || !video.height || !Number.isFinite(duration) || duration <= 0 || duration > 86400)
      throw new StreamError('The video needs a readable duration (up to 24 hours).', 422);
    const sourceHeight = Math.max(2, Math.floor(video.height / 2) * 2);
    const selected = profiles.filter((quality) => quality.height <= sourceHeight);
    if (!selected.length) selected.push({ ...profiles[0], height: sourceHeight });
    return {
      key,
      file: source.input,
      network: source.network,
      duration,
      audio: data.streams?.some((item) => item.codec_type === 'audio') || false,
      qualities: selected.map((quality) => ({
        ...quality,
        width: Math.max(2, Math.round(((video.width! / video.height!) * quality.height) / 2) * 2),
      })),
    };
  }

  master(info: MediaInfo): string {
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      ...info.qualities.flatMap((quality) => [
        `#EXT-X-STREAM-INF:BANDWIDTH=${Math.ceil((quality.videoKbps + (info.audio ? quality.audioKbps : 0)) * 1250)},RESOLUTION=${quality.width}x${quality.height}`,
        `${quality.height}/index.m3u8`,
      ]),
      '',
    ].join('\n');
  }

  playlist(info: MediaInfo, height: number): string {
    this.quality(info, height);
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-INDEPENDENT-SEGMENTS',
    ];
    for (let index = 0; index < Math.ceil(info.duration / SEGMENT_SECONDS); index++) {
      // Each independently encoded chunk has its own timestamp origin. Declare it
      // so native HLS and hls.js map timestamps to the correct VOD timeline.
      if (index) lines.push('#EXT-X-DISCONTINUITY');
      lines.push(
        `#EXTINF:${Math.min(SEGMENT_SECONDS, info.duration - index * SEGMENT_SECONDS).toFixed(6)},`,
        `${index}.ts`,
      );
    }
    return [...lines, '#EXT-X-ENDLIST', ''].join('\n');
  }

  private quality(info: MediaInfo, height: number) {
    const quality = info.qualities.find((item) => item.height === height);
    if (!quality) throw new StreamError('Quality not found.', 404);
    return quality;
  }

  async segment(
    info: MediaInfo,
    height: number,
    index: number,
  ): Promise<{ file: string; release: () => void }> {
    await this.ready;
    if (this.closed) throw new StreamError('Server is stopping.');
    const quality = this.quality(info, height);
    if (!Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(info.duration / SEGMENT_SECONDS))
      throw new StreamError('Segment not found.', 404);
    const file = path.join(this.cacheDirectory, `${info.key}_${height}_${index}.ts`);
    let entry = this.entries.get(file);
    if (!entry) {
      let pending = this.inFlight.get(file);
      if (!pending) {
        if (this.queue.length >= 16) throw new StreamError('The host PC is busy. Try again in a moment.');
        pending = this.encode(info, quality, index, file);
        this.inFlight.set(file, pending);
        void pending.finally(() => this.inFlight.delete(file)).catch(() => {});
      }
      await pending;
      entry = this.entries.get(file);
    }
    if (!entry) throw new StreamError('Could not prepare the video segment. Please retry.');
    entry.used = Date.now();
    entry.leases++;
    let released = false;
    return {
      file,
      release: () => {
        if (!released) {
          entry.leases--;
          released = true;
        }
      },
    };
  }

  private async encode(info: MediaInfo, quality: Quality, index: number, file: string): Promise<string> {
    if (this.running >= this.concurrency) await new Promise<void>((resolve) => this.queue.push(resolve));
    else this.running++;
    const partial = `${file}.partial`;
    try {
      if (this.closed) throw new StreamError('Server is stopping.');
      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-y',
        '-threads',
        '2',
        '-protocol_whitelist',
        info.network ? 'http,tcp' : 'file',
        ...(info.network ? ['-rw_timeout', '60000000'] : []),
        '-ss',
        String(index * SEGMENT_SECONDS),
        '-i',
        info.file,
        '-t',
        String(Math.min(SEGMENT_SECONDS, info.duration - index * SEGMENT_SECONDS)),
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-sn',
        '-dn',
        '-vf',
        `scale=${quality.width}:${quality.height},setsar=1,fps=24`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-profile:v',
        'baseline',
        '-pix_fmt',
        'yuv420p',
        '-b:v',
        `${quality.videoKbps}k`,
        '-maxrate',
        `${quality.videoKbps}k`,
        '-bufsize',
        `${quality.videoKbps * 2}k`,
        '-threads',
        '2',
        '-g',
        '144',
        '-keyint_min',
        '144',
        '-sc_threshold',
        '0',
        '-c:a',
        'aac',
        '-ac',
        '2',
        '-ar',
        '48000',
        '-b:a',
        `${quality.audioKbps}k`,
        '-avoid_negative_ts',
        'make_zero',
        '-f',
        'mpegts',
        partial,
      ];
      await exec('ffmpeg', args, {
        timeout: info.network ? 120_000 : 90_000,
        maxBuffer: 1024 * 1024,
        signal: this.abort.signal,
      });
      const { size } = await stat(partial);
      const commit = this.commits.then(async () => {
        await this.makeSpace(size);
        await rename(partial, file);
        this.entries.set(file, { size, used: Date.now(), leases: 0 });
        this.bytes += size;
      });
      this.commits = commit.catch(() => {});
      await commit;
      return file;
    } catch (error) {
      await rm(partial, { force: true }).catch(() => {});
      if (error instanceof StreamError) throw error;
      console.error(
        'Segment encoding failed:',
        error instanceof Error ? error.message.slice(0, 1500) : 'Unknown error',
      );
      throw new StreamError(
        'The host could not encode this segment. Check FFmpeg, disk space, or try original quality.',
      );
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.running--;
    }
  }

  private async makeSpace(incoming: number) {
    const candidates = [...this.entries.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [file, entry] of candidates) {
      if (this.bytes + incoming <= this.maxBytes) break;
      if (entry.leases || this.inFlight.has(file)) continue;
      // Remove from the index before yielding so concurrent completions cannot
      // count the same eviction twice.
      if (!this.entries.delete(file)) continue;
      this.bytes -= entry.size;
      await rm(file, { force: true });
    }
    if (this.bytes + incoming > this.maxBytes)
      throw new StreamError('The streaming cache is full. Try again after other streams finish.');
  }

  close() {
    this.closed = true;
    this.abort.abort();
  }
}
