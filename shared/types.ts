export interface Subtitle {
  id: string;
  label: string;
  language: string;
}

export interface Episode {
  streamId?: string;
  id: string;
  title: string;
  filename: string;
  season: number;
  number: number;
  format: string;
  size: number;
  subtitles: Subtitle[];
}

export interface Title {
  source?: 'torrent' | 'catalog';
  episodeCount?: number;
  rating?: string;
  id: string;
  name: string;
  kind: 'movie' | 'series';
  description: string;
  year?: number;
  genres: string[];
  poster?: string;
  backdrop?: string;
  addedAt: number;
  episodes: Episode[];
}

export interface CatalogPage {
  titles: Title[];
  nextPage: number | null;
}
export interface ResolvedEpisode {
  streamId: string;
  filename: string;
  size: number;
  format: string;
  quality: string;
}

export interface Library {
  torrentCount?: number;
  titles: Title[];
  mediaDirectory: string;
  scannedAt: string;
  warnings: string[];
  totalBytes: number;
}

export interface TorrentStatus {
  id: string;
  name: string;
  state: 'metadata' | 'checking' | 'ready' | 'paused' | 'error';
  error?: string;
  peers: number;
  downloaded: number;
  total: number;
  downloadSpeed: number;
  uploadSpeed: number;
  videoCount: number;
}

export interface WatchProgress {
  time: number;
  duration: number;
  updatedAt: number;
  completed: boolean;
}
