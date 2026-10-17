import { useCallback, useState } from 'react';
import type { WatchProgress } from '../shared/types';

interface Preferences {
  saved: string[];
  progress: Record<string, WatchProgress>;
}
const key = 'yoru-library-v1';
function read(): Preferences {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(key) || '{}');
    if (!data || typeof data !== 'object') return { saved: [], progress: {} };
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
    return { saved, progress };
  } catch {
    return { saved: [], progress: {} };
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
    (id: string) =>
      update((previous) => ({
        ...previous,
        saved: previous.saved.includes(id)
          ? previous.saved.filter((item) => item !== id)
          : [...previous.saved, id],
      })),
    [update],
  );
  const saveProgress = useCallback(
    (id: string, progress: WatchProgress) =>
      update((previous) => ({ ...previous, progress: { ...previous.progress, [id]: progress } })),
    [update],
  );
  return { ...preferences, toggleSaved, saveProgress, storageError };
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
