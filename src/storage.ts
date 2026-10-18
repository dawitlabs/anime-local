import { useCallback, useState } from 'react';
import type { Title, WatchProgress } from '../shared/types';

interface Preferences {
  saved: string[];
  progress: Record<string, WatchProgress>;
  titles: Record<string, Title>;
}
const key = 'yoru-library-v1';
function read(): Preferences {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(key) || '{}');
    if (!data || typeof data !== 'object') return { saved: [], progress: {}, titles: {} };
    const raw = data as Record<string, unknown>;
    const saved = Array.isArray(raw.saved)
      ? raw.saved.filter((id): id is string => typeof id === 'string')
      : [];
    const progress: Record<string, WatchProgress> = {};
    if (raw.progress && typeof raw.progress === 'object') {
      for (const [id, value] of Object.entries(raw.progress)) {
        if (!value || typeof value !== 'object') continue;
        const item = value as Record<string, unknown>;
        if (
          typeof item.time === 'number' &&
          Number.isFinite(item.time) &&
          item.time >= 0 &&
          typeof item.duration === 'number' &&
          Number.isFinite(item.duration) &&
          item.duration > 0 &&
          typeof item.updatedAt === 'number' &&
          typeof item.completed === 'boolean'
        ) {
          progress[id] = {
            time: item.time,
            duration: item.duration,
            updatedAt: item.updatedAt,
            completed: item.completed,
          };
        }
      }
    }
    const titles: Record<string, Title> = {};
    if (raw.titles && typeof raw.titles === 'object') {
      for (const [id, value] of Object.entries(raw.titles).slice(-100)) {
        if (!value || typeof value !== 'object') continue;
        const title = value as Partial<Title>;
        if (
          title.id !== id ||
          title.source !== 'catalog' ||
          typeof title.name !== 'string' ||
          !['movie', 'series'].includes(title.kind || '') ||
          !Array.isArray(title.genres) ||
          !Array.isArray(title.episodes) ||
          title.episodes.some(
            (episode) =>
              !episode ||
              typeof episode.id !== 'string' ||
              typeof episode.title !== 'string' ||
              typeof episode.number !== 'number',
          )
        )
          continue;
        titles[id] = {
          ...title,
          description: typeof title.description === 'string' ? title.description : '',
          genres: title.genres.filter((genre) => typeof genre === 'string'),
          addedAt: Number(title.addedAt) || 0,
        } as Title;
      }
    }
    return { saved, progress, titles };
  } catch {
    return { saved: [], progress: {}, titles: {} };
  }
}

export function usePreferences() {
  const [preferences, setPreferences] = useState<Preferences>(read);
  const [storageError, setStorageError] = useState(false);
  const update = useCallback((fn: (previous: Preferences) => Preferences) => {
    setPreferences((previous) => {
      const next = fn(previous);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        setStorageError(true);
      }
      return next;
    });
  }, []);
  const toggleSaved = useCallback(
    (id: string, title?: Title) =>
      update((previous) => ({
        ...previous,
        titles:
          title?.source === 'catalog'
            ? { ...previous.titles, [id]: previous.titles[id]?.episodes.length ? previous.titles[id] : title }
            : previous.titles,
        saved: previous.saved.includes(id)
          ? previous.saved.filter((item) => item !== id)
          : [...previous.saved, id],
      })),
    [update],
  );
  const rememberTitle = useCallback(
    (title: Title) => {
      if (title.source !== 'catalog') return;
      update((previous) => ({ ...previous, titles: { ...previous.titles, [title.id]: title } }));
    },
    [update],
  );
  const saveProgress = useCallback(
    (id: string, progress: WatchProgress) =>
      update((previous) => ({ ...previous, progress: { ...previous.progress, [id]: progress } })),
    [update],
  );
  return { ...preferences, toggleSaved, rememberTitle, saveProgress, storageError };
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
