import type { CatalogPage, Episode, ResolvedEpisode, Title } from '../shared/types.ts';
import { StreamError } from './streaming.ts';
import type { TorrentService } from './torrents.ts';

const TITLE_ID = /^kitsu:\d{1,9}$/;
const VIDEO_ID = /^kitsu:\d{1,9}(?::\d{1,5})?$/;
const string = (value: unknown) => (typeof value === 'string' ? value : '');
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const image = (value: unknown) => {
  try {
    const url = new URL(string(value));
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
};

export function normalizeAnime(value: unknown, details = false): Title | undefined {
  const meta = object(value);
  if (
    !TITLE_ID.test(string(meta.id)) ||
    !string(meta.name) ||
    !['movie', 'series'].includes(string(meta.type))
  )
    return undefined;
  const genres = Array.isArray(meta.genres)
    ? meta.genres.filter((value): value is string => typeof value === 'string').slice(0, 12)
    : [];
  if (genres.some((genre) => /^(hentai|doujinshi)$/i.test(genre))) return undefined;
  const id = String(meta.id);
  const videos = Array.isArray(meta.videos) ? meta.videos : [];
  const episodes: Episode[] = videos
    .flatMap((value) => {
      const video = object(value);
      if (!VIDEO_ID.test(string(video.id)) || !(video.id === id || String(video.id).startsWith(`${id}:`)))
        return [];
      const released = Date.parse(string(video.released));
      if (Number.isFinite(released) && released > Date.now()) return [];
      const number = Number(video.episode ?? String(video.id).split(':')[2] ?? 1);
      const season = Number(video.season ?? 1);
      if (!Number.isSafeInteger(number) || number < 1 || !Number.isSafeInteger(season) || season < 0)
        return [];
      return [
        {
          id: String(video.id),
          title: string(video.title) || `Episode ${number}`,
          filename: '',
          season,
          number,
          format: '',
          size: 0,
          subtitles: [],
        },
      ];
    })
    .slice(0, 5000)
    .sort((a, b) => a.season - b.season || a.number - b.number);
  if (details && meta.type === 'movie' && !episodes.length)
    episodes.push({
      id,
      title: String(meta.name),
      filename: '',
      season: 1,
      number: 1,
      format: '',
      size: 0,
      subtitles: [],
    });
  const year = Number(string(meta.releaseInfo || meta.year).match(/\d{4}/)?.[0]);
  return {
    id,
    source: 'catalog',
    name: String(meta.name).slice(0, 240),
    kind: meta.type === 'movie' ? 'movie' : 'series',
    description: string(meta.description)
      .replace(/<[^>]*>/g, '')
      .slice(0, 5000),
    year: year || undefined,
    genres,
    poster: image(meta.poster),
    backdrop: image(meta.background),
    addedAt: year ? Date.UTC(year, 0, 1) : 0,
    rating: /^\d(?:\.\d)?$|^10$/.test(string(meta.imdbRating)) ? String(meta.imdbRating) : undefined,
    episodeCount: details ? episodes.length : undefined,
    episodes,
  };
}

export interface StreamSource {
  hash: string;
  index?: number;
  filename: string;
  bytes: number;
  peers: number;
  height: number;
  trackers: string[];
}
export function normalizeSources(value: unknown): StreamSource[] {
  if (!Array.isArray(value)) throw new StreamError('The stream provider returned an invalid response.', 502);
  const seen = new Set<string>();
  const sources: StreamSource[] = value.flatMap((value) => {
    const stream = object(value);
    const hash = string(stream.infoHash).toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(hash)) return [];
    const index =
      typeof stream.fileIdx === 'number' && Number.isSafeInteger(stream.fileIdx) && stream.fileIdx >= 0
        ? stream.fileIdx
        : undefined;
    const key = `${hash}:${index}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const description = string(stream.title || stream.description);
    const filename = string(object(stream.behaviorHints).filename).slice(0, 500);
    const size = description.match(/([\d.]+)\s*(GiB|GB|MiB|MB)/i);
    const bytes = size ? Number(size[1]) * (/g/i.test(size[2]) ? 1024 ** 3 : 1024 ** 2) : Infinity;
    if (bytes > 3 * 1024 ** 3 && Number.isFinite(bytes)) return [];
    const heightText = `${stream.name} ${description} ${filename}`.match(
      /\b(2160p|4k|1080p|720p|540p|480p|360p)\b/i,
    )?.[1];
    const height = heightText?.toLowerCase() === '4k' ? 2160 : Number.parseInt(heightText || '0');
    const peers = Number(description.match(/👤\s*(\d+)/)?.[1] ?? -1);
    const trackers = (Array.isArray(stream.sources) ? stream.sources : [])
      .filter(
        (value): value is string => typeof value === 'string' && /^tracker:(udp|https?):\/\//.test(value),
      )
      .map((value) => value.slice(8))
      .slice(0, 15);
    return [{ hash, index, filename, bytes, height, peers, trackers }];
  });
  // Prefer reachable, smaller releases. Lower playback resolution alone cannot
  // reduce the original torrent bytes, so make the source choice economical too.
  return sources.sort(
    (a, b) =>
      Number(b.peers > 0) - Number(a.peers > 0) ||
      Number(a.height > 720) - Number(b.height > 720) ||
      Number(a.height > 1080) - Number(b.height > 1080) ||
      Number(b.peers >= 20) - Number(a.peers >= 20) ||
      (a.bytes === b.bytes ? 0 : a.bytes - b.bytes) ||
      b.peers - a.peers,
  );
}

type TorrentAccess = Pick<
  TorrentService,
  'add' | 'list' | 'resolveVideo' | 'prepareVideo' | 'waitForTitle' | 'pause' | 'remove'
>;

export class CatalogService {
  private cache = new Map<string, { expires: number; data: unknown }>();
  private requests = new Map<string, Promise<unknown>>();
  private resolving = new Map<string, Promise<ResolvedEpisode>>();
  private resolved = new Map<string, ResolvedEpisode>();
  private phases = new Map<string, string>();
  private failures = new Map<string, { expires: number; hashes: Set<string> }>();
  private abort = new AbortController();
  private cleanups = new Map<string, Promise<void>>();
  private leases = new Map<string, { users: number; owned: boolean; succeeded: boolean }>();
  private catalogURL: string;
  private sourcesURL: string;

  constructor(
    private torrents: TorrentAccess,
    options: { catalogURL?: string; sourcesURL?: string; fetcher?: typeof fetch } = {},
  ) {
    this.catalogURL = (options.catalogURL || 'https://anime-kitsu.strem.fun')
      .replace(/\/manifest\.json$/, '')
      .replace(/\/$/, '');
    this.sourcesURL = (options.sourcesURL || 'https://torrentio.strem.fun')
      .replace(/\/manifest\.json$/, '')
      .replace(/\/$/, '');
    for (const address of [this.catalogURL, this.sourcesURL]) {
      const url = new URL(address);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Catalog/provider URLs must be HTTP(S) base URLs without credentials.');
    }
    this.fetcher = options.fetcher || fetch;
  }
  private fetcher: typeof fetch;

  private async request(url: string, label: string, key: 'metas' | 'meta' | 'streams'): Promise<unknown> {
    const hit = this.cache.get(url);
    if (hit && hit.expires > Date.now()) return hit.data;
    const pending = this.requests.get(url);
    if (pending) return pending;
    const work = (async () => {
      try {
        const response = await this.fetcher(url, {
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(25_000)]),
          headers: { 'User-Agent': 'Yoru/1.0', Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (Number(response.headers.get('content-length')) > 3 * 1024 ** 2)
          throw new Error('Response too large');
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Empty response');
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.length;
            if (length > 3 * 1024 ** 2) throw new Error('Response too large');
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel();
        }
        const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = object(data);
        if (
          !(key === 'meta'
            ? result.meta && typeof result.meta === 'object' && !Array.isArray(result.meta)
            : Array.isArray(result[key]))
        )
          throw new Error('Invalid response');
        if (this.cache.size >= 160) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(url, { expires: Date.now() + 5 * 60_000, data });
        return data;
      } catch (error) {
        console.warn(
          'Provider request failed',
          JSON.stringify({ label, reason: error instanceof Error ? error.message : 'Unknown failure' }),
        );
        throw new StreamError(
          `${label} is unavailable right now. Check your internet connection and retry.`,
          502,
        );
      }
    })();
    this.requests.set(url, work);
    try {
      return await work;
    } finally {
      this.requests.delete(url);
    }
  }

  async browse(query = '', page = 0, genre = '', order = 'popular'): Promise<CatalogPage> {
    if (!Number.isSafeInteger(page) || page < 0 || page > 500)
      throw new StreamError('Invalid catalog page.', 400);
    const q = query.trim().slice(0, 120);
    const catalog = q
      ? 'kitsu-anime-list'
      : `kitsu-anime-${['popular', 'trending', 'rating', 'airing'].includes(order) ? order : 'popular'}`;
    const extra: string[] = [];
    if (q) extra.push(`search=${encodeURIComponent(q)}`);
    else if (genre && genre !== 'All genres') extra.push(`genre=${encodeURIComponent(genre.slice(0, 60))}`);
    if (page) extra.push(`skip=${page * 20}`);
    const data = object(
      await this.request(
        `${this.catalogURL}/catalog/anime/${catalog}${extra.length ? `/${extra.join('&')}` : ''}.json`,
        'Anime catalog',
        'metas',
      ),
    );
    if (!Array.isArray(data.metas)) throw new StreamError('The anime catalog returned an invalid page.', 502);
    const titles = data.metas.flatMap((meta) => {
      const title = normalizeAnime(meta);
      return title ? [title] : [];
    });
    return { titles, nextPage: data.metas.length >= 20 && order !== 'trending' ? page + 1 : null };
  }

  async title(id: string): Promise<Title> {
    if (!TITLE_ID.test(id)) throw new StreamError('Invalid anime ID.', 400);
    const data = object(
      await this.request(`${this.catalogURL}/meta/anime/${id}.json`, 'Episode list', 'meta'),
    );
    const title = normalizeAnime(data.meta, true);
    if (!title || title.id !== id) throw new StreamError('This anime was not found in the catalog.', 404);
    return title;
  }

  phase(id: string) {
    return this.phases.get(id) || 'Finding a stream…';
  }

  async resolve(titleId: string, episodeId: string, retry = false): Promise<ResolvedEpisode> {
    if (
      !TITLE_ID.test(titleId) ||
      !VIDEO_ID.test(episodeId) ||
      !(episodeId === titleId || episodeId.startsWith(`${titleId}:`))
    )
      throw new StreamError('Invalid episode.', 400);
    const pending = this.resolving.get(episodeId);
    if (pending) return pending;
    const prior = this.resolved.get(episodeId);
    if (prior && !retry) {
      try {
        if (this.torrents.resolveVideo(prior.streamId)) return prior;
      } catch {
        /* Reconnect paused or expired sources below. */
      }
    }
    if (this.resolving.size >= 4) throw new StreamError('Several streams are starting. Try again shortly.');
    const work = this.find(titleId, episodeId, retry ? prior?.streamId.split('-')[1] : undefined, retry);
    this.resolving.set(episodeId, work);
    try {
      return await work;
    } finally {
      this.resolving.delete(episodeId);
      this.phases.delete(episodeId);
    }
  }

  private async find(
    titleId: string,
    episodeId: string,
    skipHash?: string,
    retry = false,
  ): Promise<ResolvedEpisode> {
    this.phases.set(episodeId, 'Finding a stream…');
    const title = await this.title(titleId);
    const episode = title.episodes.find((episode) => episode.id === episodeId);
    if (!episode) throw new StreamError('This episode is not available in the catalog yet.', 404);
    const data = object(
      await this.request(
        `${this.sourcesURL}/stream/anime/${episodeId}.json`,
        'Automatic stream search',
        'streams',
      ),
    );
    let history = this.failures.get(episodeId);
    if (!history || history.expires < Date.now()) {
      history = { expires: Date.now() + 10 * 60_000, hashes: new Set<string>() };
      if (this.failures.size >= 160) this.failures.delete(this.failures.keys().next().value!);
      this.failures.set(episodeId, history);
    }
    const ready = new Set(
      this.torrents
        .list()
        .filter((item) => item.state === 'ready')
        .map((item) => item.id),
    );
    const unique = new Set<string>();
    const candidates = normalizeSources(data.streams)
      .filter((source) => {
        if (source.hash === skipHash || unique.has(source.hash)) return false;
        unique.add(source.hash);
        return true;
      })
      .sort((a, b) => Number(ready.has(b.hash)) - Number(ready.has(a.hash)));
    let remaining = candidates.filter((source) => !history.hashes.has(source.hash));
    // Exhausting the provider list is different from exhausting one bounded search.
    // Explicit retry starts over only after every candidate has been considered.
    if (!remaining.length && candidates.length && retry) {
      history.hashes.clear();
      remaining = candidates;
    }
    const sources = remaining.filter((source) => ready.has(source.hash)).slice(0, 8);
    const queued = new Set(sources.map((source) => source.hash));
    const economical = remaining.filter((source) => !ready.has(source.hash));
    const connected = economical
      .filter((source) => source.height <= 1080 && source.peers > 0)
      .sort((a, b) => b.peers - a.peers);
    // Keep the low-data choice first, but alternate with healthier swarms so a
    // long list of dead small releases cannot consume the entire search budget.
    while (sources.length < 8 && economical.length) {
      for (const queue of [economical, connected]) {
        let next = queue.shift();
        while (next && queued.has(next.hash)) next = queue.shift();
        if (next && sources.length < 8) {
          sources.push(next);
          queued.add(next.hash);
        }
      }
    }
    const deadline = Date.now() + 120_000;
    let tried = 0;
    let capacityFailures = 0;
    if (!sources.length)
      throw new StreamError(
        'No stream is available for this episode right now. Try another episode or retry later.',
        404,
      );
    for (const [attempt, source] of sources.entries()) {
      if (this.abort.signal.aborted) throw new StreamError('Server is stopping.');
      if (Date.now() >= deadline) break;
      tried++;
      this.phases.set(
        episodeId,
        `${attempt ? 'Trying another source' : 'Connecting to peers'}… (${attempt + 1}/${sources.length})`,
      );
      await this.cleanups.get(source.hash);
      const lease = this.leases.get(source.hash) || {
        users: 0,
        owned: !this.torrents.list().some((item) => item.id === source.hash),
        succeeded: false,
      };
      lease.users++;
      this.leases.set(source.hash, lease);
      try {
        const magnet = `magnet:?xt=urn:btih:${source.hash}${source.trackers.map((url) => `&tr=${encodeURIComponent(url)}`).join('')}`;
        await this.torrents.add(magnet, { selective: true });
        if (this.torrents.list().find((item) => item.id === source.hash)?.state === 'paused')
          await this.torrents.pause(source.hash, false);
        const ready = await this.torrents.waitForTitle(
          source.hash,
          Math.max(1, Math.min(30_000, deadline - Date.now())),
          this.abort.signal,
        );
        const filename = source.filename.split(/[\\/]/).pop()?.toLowerCase();
        const indexed =
          source.index === undefined
            ? undefined
            : ready.episodes.find((video) => video.id === `t-${source.hash}-${source.index}`);
        const matches = filename
          ? ready.episodes.filter((video) => video.filename.toLowerCase() === filename)
          : [];
        const video =
          indexed && (!filename || indexed.filename.toLowerCase() === filename)
            ? indexed
            : matches.length === 1
              ? matches[0]
              : !filename && ready.episodes.length === 1
                ? ready.episodes[0]
                : undefined;
        if (!video) throw new Error('The episode did not match the source file list.');
        this.phases.set(episodeId, 'Buffering the first pieces…');
        const input = await this.torrents.prepareVideo(video.id);
        if (!input) throw new Error('Video unavailable');
        const response = await fetch(input.input, {
          headers: { Range: 'bytes=0-65535' },
          signal: AbortSignal.any([
            this.abort.signal,
            AbortSignal.timeout(Math.max(1, Math.min(45_000, deadline - Date.now()))),
          ]),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('No video pieces');
        }
        await response.arrayBuffer();
        const result = {
          streamId: video.id,
          filename: video.filename,
          size: video.size,
          format: video.format,
          quality: source.height ? `${source.height}p source` : 'Automatic source',
        };
        if (this.resolved.size >= 160) this.resolved.delete(this.resolved.keys().next().value!);
        this.resolved.set(episodeId, result);
        lease.succeeded = true;
        return result;
      } catch (error) {
        history.hashes.add(source.hash);
        history.expires = Date.now() + 10 * 60_000;
        if (error instanceof StreamError && error.status === 413) capacityFailures++;
        const state = this.torrents.list().find((item) => item.id === source.hash);
        console.warn(
          'Stream candidate failed',
          JSON.stringify({
            episode: episodeId,
            source: source.hash.slice(0, 12),
            attempt: attempt + 1,
            stage: this.phases.get(episodeId),
            peers: state?.peers,
            total: state?.total,
            reason: error instanceof Error ? error.message.slice(0, 300) : 'Unknown source failure',
          }),
        );
        // Try the next candidate. Concurrent episode requests may share a batch torrent.
      } finally {
        lease.users--;
        if (!lease.users) {
          this.leases.delete(source.hash);
          if (lease.owned && !lease.succeeded) {
            const cleanup = this.torrents.remove(source.hash).catch(() => {});
            this.cleanups.set(source.hash, cleanup);
            await cleanup;
            if (this.cleanups.get(source.hash) === cleanup) this.cleanups.delete(source.hash);
          }
        }
      }
    }
    throw new StreamError(
      capacityFailures === tried && tried > 0
        ? `The ${tried} sources checked exceed the host source-size budget. Retry to check other sources, or remove an old source in Stream settings.`
        : `Could not start playback from ${tried} sources. ${capacityFailures ? `${capacityFailures} exceeded the host source-size budget. ` : ''}Retry will check other sources; unavailable peers may need more time.`,
    );
  }

  close() {
    this.abort.abort();
  }
}
