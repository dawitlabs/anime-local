export interface Subtitle {
  id: string;
  label: string;
  language: string;
}

export interface Episode {
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

export interface Library {
  titles: Title[];
  mediaDirectory: string;
  scannedAt: string;
  warnings: string[];
  totalBytes: number;
}

export interface WatchProgress {
  time: number;
  duration: number;
  updatedAt: number;
  completed: boolean;
}
