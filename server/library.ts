import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Episode, Library, Title } from '../shared/types.ts';

const videoExtensions = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.ogv']);
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
type FileKind = 'video' | 'artwork' | 'subtitle';
interface MediaFile {
  path: string;
  kind: FileKind;
}
interface Snapshot {
  library: Library;
  files: Map<string, MediaFile>;
  root: string;
}
interface Metadata {
  title?: string;
  description?: string;
  year?: number;
  genres?: string[];
}

const idFor = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const tidy = (value: string) =>
  value
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const withoutExtension = (file: string) => file.slice(0, -path.extname(file).length);

export function withinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export class LibraryStore {
  private snapshot?: Snapshot;
  private scanning?: Promise<Library>;

  constructor(readonly directory: string) {}

  get library(): Library {
    if (!this.snapshot) throw new Error('Library has not been scanned.');
    return this.snapshot.library;
  }

  scan(): Promise<Library> {
    if (this.scanning) return this.scanning;
    this.scanning = this.build()
      .then((snapshot) => {
        this.snapshot = snapshot;
        return snapshot.library;
      })
      .finally(() => {
        this.scanning = undefined;
      });
    return this.scanning;
  }

  async resolveFile(id: string, kind: FileKind): Promise<string | undefined> {
    const snapshot = this.snapshot;
    const file = snapshot?.files.get(id);
    if (!snapshot || !file || file.kind !== kind) return undefined;
    try {
      const canonical = await realpath(file.path);
      if (!withinRoot(snapshot.root, canonical) || !(await stat(canonical)).isFile()) return undefined;
      return canonical;
    } catch {
      return undefined;
    }
  }

  private async build(): Promise<Snapshot> {
    const root = await realpath(this.directory);
    const relativeFiles: string[] = [];
    const warnings: string[] = [];
    const files = new Map<string, MediaFile>();
    const groups = new Map<string, { title: Title; folder: string }>();
    let totalBytes = 0;

    const walk = async (folder: string, depth: number): Promise<void> => {
      if (depth > 20) {
        warnings.push(`Skipped deeply nested folder: ${folder}`);
        return;
      }
      let entries;
      try {
        entries = await readdir(path.join(root, folder), { withFileTypes: true });
      } catch (error) {
        if (!folder) throw error;
        warnings.push(`Could not read folder: ${folder}`);
        return;
      }
      for (const entry of entries.sort((a, b) => collator.compare(a.name, b.name))) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const relative = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(relative, depth + 1);
        else if (entry.isFile()) relativeFiles.push(relative);
      }
    };
    await walk('', 0);

    const register = (relative: string, kind: FileKind): string => {
      const id = idFor(`${kind}:${relative.split(path.sep).join('/')}`);
      files.set(id, { path: path.join(root, relative), kind });
      return id;
    };

    const safeRead = async (relative: string): Promise<string> => {
      const canonical = await realpath(path.join(root, relative));
      if (!withinRoot(root, canonical)) throw new Error('File is outside the media folder.');
      if ((await stat(canonical)).size > 256_000) throw new Error('Metadata is too large.');
      return readFile(canonical, 'utf8');
    };

    for (const relative of relativeFiles.filter((file) =>
      videoExtensions.has(path.extname(file).toLowerCase()),
    )) {
      const segments = relative.split(path.sep);
      const category = segments[0].toLowerCase();
      const categorized = ['movies', 'movie', 'series', 'tv'].includes(category);
      const content = categorized ? segments.slice(1) : segments;
      const filename = path.basename(relative);
      const stem = withoutExtension(filename);
      const folder =
        content.length > 1 ? segments.slice(0, categorized ? 2 : 1).join(path.sep) : path.dirname(relative);
      const groupKey = content.length > 1 ? folder : relative;
      let info;
      try {
        const canonical = await realpath(path.join(root, relative));
        if (!withinRoot(root, canonical)) continue;
        info = await stat(canonical);
      } catch {
        warnings.push(`Could not read video: ${relative}`);
        continue;
      }

      if (!groups.has(groupKey)) {
        let metadata: Metadata = {};
        const metadataFile =
          content.length > 1 ? path.join(folder, 'title.json') : path.join(folder, `${stem}.json`);
        if (relativeFiles.includes(metadataFile)) {
          try {
            const raw: unknown = JSON.parse(await safeRead(metadataFile));
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected an object.');
            const data = raw as Record<string, unknown>;
            metadata = {
              title: typeof data.title === 'string' ? data.title.slice(0, 200) : undefined,
              description: typeof data.description === 'string' ? data.description.slice(0, 5000) : undefined,
              year: typeof data.year === 'number' && Number.isInteger(data.year) ? data.year : undefined,
              genres: Array.isArray(data.genres)
                ? data.genres.filter((genre): genre is string => typeof genre === 'string').slice(0, 12)
                : [],
            };
          } catch {
            warnings.push(`Invalid metadata: ${metadataFile}`);
          }
        }
        const artwork = (name: string): string | undefined => {
          const match = relativeFiles.find(
            (file) =>
              path.dirname(file) === folder &&
              withoutExtension(path.basename(file)).toLowerCase() ===
                (content.length > 1 ? name : `${stem}.${name}`).toLowerCase() &&
              imageExtensions.has(path.extname(file).toLowerCase()),
          );
          return match ? `/api/artwork/${register(match, 'artwork')}` : undefined;
        };
        groups.set(groupKey, {
          folder,
          title: {
            id: idFor(`title:${groupKey.split(path.sep).join('/')}`),
            name: metadata.title || tidy(content.length > 1 ? content[0] : stem) || stem,
            kind: ['series', 'tv'].includes(category) ? 'series' : 'movie',
            description: metadata.description || '',
            year: metadata.year,
            genres: metadata.genres || [],
            poster: artwork('poster'),
            backdrop: artwork('backdrop'),
            addedAt: info.mtimeMs,
            episodes: [],
          },
        });
      }
      const group = groups.get(groupKey)!;
      const seasonEpisode = stem.match(/s(\d{1,3})[ ._-]*e(\d{1,4})/i);
      const seasonFolder = path.dirname(relative).match(/season[ ._-]*(\d{1,3})/i);
      const episodeMatch = stem
        .replace(/\[[^\]]*\]/g, '')
        .match(/(?:^|[\s_-])(?:e(?:p(?:isode)?)?[ ._-]*)?(\d{1,4})(?:\b|[ ._-])/i);
      const season = Number(seasonEpisode?.[1] ?? seasonFolder?.[1] ?? 1);
      const number = Number(seasonEpisode?.[2] ?? episodeMatch?.[1] ?? group.title.episodes.length + 1);
      if (seasonEpisode || seasonFolder || group.title.episodes.length > 0) group.title.kind = 'series';
      const id = register(relative, 'video');
      const episode: Episode = {
        id,
        title: tidy(stem),
        filename,
        season,
        number,
        format: path.extname(filename).slice(1).toUpperCase(),
        size: info.size,
        subtitles: [],
      };
      const subtitlePrefix = path.join(path.dirname(relative), stem);
      for (const candidate of relativeFiles) {
        if (!['.vtt', '.srt'].includes(path.extname(candidate).toLowerCase())) continue;
        const subtitleStem = withoutExtension(candidate);
        if (subtitleStem !== subtitlePrefix && !subtitleStem.startsWith(`${subtitlePrefix}.`)) continue;
        const suffix = subtitleStem.slice(subtitlePrefix.length).replace(/^\./, '');
        const language = suffix.split('.')[0] || 'en';
        episode.subtitles.push({
          id: register(candidate, 'subtitle'),
          language: /^[a-z]{2,3}$/i.test(language) ? language : 'und',
          label: suffix || 'Subtitles',
        });
      }
      group.title.episodes.push(episode);
      group.title.addedAt = Math.max(group.title.addedAt, info.mtimeMs);
      totalBytes += info.size;
    }

    const titles = [...groups.values()]
      .map(({ title }) => {
        title.episodes.sort(
          (a, b) => a.season - b.season || a.number - b.number || collator.compare(a.filename, b.filename),
        );
        return title;
      })
      .sort((a, b) => collator.compare(a.name, b.name));
    return {
      root,
      files,
      library: {
        titles,
        mediaDirectory: this.directory,
        scannedAt: new Date().toISOString(),
        warnings,
        totalBytes,
      },
    };
  }
}
