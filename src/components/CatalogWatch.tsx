import { useEffect, useState } from 'react';
import { AlertCircle, LoaderCircle, RefreshCw } from 'lucide-react';
import type { Title, WatchProgress } from '../../shared/types';
import { Dialog } from './Dialog';
import { Player } from './Player';

export function CatalogWatch({
  title,
  initialEpisode,
  progress,
  onProgress,
  onRemember,
  onClose,
}: {
  title: Title;
  initialEpisode?: string;
  progress: Record<string, WatchProgress>;
  onProgress: (id: string, progress: WatchProgress) => void;
  onRemember: (title: Title) => void;
  onClose: () => void;
}) {
  const [details, setDetails] = useState<Title>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setError('');
    void fetch(`/api/catalog/${encodeURIComponent(title.id)}`, { signal: abort.signal })
      .then(async (response) => {
        const data = (await response.json()) as Title & { error?: string };
        if (!response.ok) throw new Error(data.error || 'Could not load the episode list.');
        if (!data.episodes.length) throw new Error('No released episodes are listed yet. Check back later.');
        if (!abort.signal.aborted) {
          setDetails(data);
          onRemember(data);
        }
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Could not load episodes.');
      });
    return () => abort.abort();
  }, [title.id, retry, onRemember]);
  if (details)
    return (
      <Player
        title={details}
        initialEpisode={initialEpisode}
        progress={progress}
        onProgress={onProgress}
        onClose={onClose}
      />
    );
  return (
    <Dialog title={title.name} onClose={onClose}>
      <div className="catalog-loading">
        {error ? <AlertCircle size={30} /> : <LoaderCircle size={30} className="spin" />}
        <h2>{error ? 'Could not open this anime' : 'Opening your next story…'}</h2>
        <p className="muted">{error || 'Loading the episode list. Your stream is selected automatically.'}</p>
        {error && (
          <button className="button primary" onClick={() => setRetry((value) => value + 1)}>
            <RefreshCw size={16} /> Retry
          </button>
        )}
      </div>
    </Dialog>
  );
}
