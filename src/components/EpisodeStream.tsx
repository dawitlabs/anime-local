import { useEffect, useState } from 'react';
import { AlertCircle, LoaderCircle, RefreshCw } from 'lucide-react';
import type { Episode, ResolvedEpisode, WatchProgress } from '../../shared/types';
import { AdaptiveVideo } from './AdaptiveVideo';

export function EpisodeStream({
  episode,
  catalogId,
  ...props
}: {
  episode: Episode;
  catalogId?: string;
  poster?: string;
  progress?: WatchProgress;
  onProgress: (value: WatchProgress) => void;
  onEnded: () => void;
}) {
  const [resolved, setResolved] = useState<ResolvedEpisode>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('Finding a stream…');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!catalogId) return;
    const abort = new AbortController();
    setResolved(undefined);
    setError('');
    setMessage('Finding a stream…');
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(
          `/api/catalog/${encodeURIComponent(catalogId)}/status/${encodeURIComponent(episode.id)}`,
          { signal: abort.signal },
        );
        if (response.ok) setMessage(((await response.json()) as { message: string }).message);
      } catch {
        /* The resolve request reports actionable failures. */
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    void fetch(`/api/catalog/${encodeURIComponent(catalogId)}/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episode: episode.id, retry: attempt > 0 }),
      signal: abort.signal,
    })
      .then(async (response) => {
        const data = (await response.json()) as ResolvedEpisode & { error?: string };
        if (!response.ok) throw new Error(data.error || 'Could not start this episode.');
        if (!abort.signal.aborted) setResolved(data);
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Could not start playback.');
      })
      .finally(() => {
        clearTimeout(timer);
        abort.abort();
      });
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [catalogId, episode.id, attempt]);
  if (!catalogId) return <AdaptiveVideo episode={episode} {...props} />;
  if (resolved)
    return (
      <>
        <AdaptiveVideo
          key={`${episode.id}:${resolved.streamId}`}
          episode={{ ...episode, ...resolved }}
          {...props}
        />
        <div className="source-choice">
          <span>{resolved.quality} · chosen automatically</span>
          <button className="text-button" onClick={() => setAttempt((value) => value + 1)}>
            <RefreshCw size={14} /> Try another stream
          </button>
        </div>
      </>
    );
  return (
    <div className="catalog-loading stream-loading" role={error ? 'alert' : 'status'}>
      {error ? <AlertCircle size={30} /> : <LoaderCircle size={30} className="spin" />}
      <h3>{error ? 'This stream could not start' : message}</h3>
      <p className="muted">
        {error ||
          'Your PC is finding peers for this episode. Playback begins as soon as the first pieces are ready.'}
      </p>
      {error && (
        <button className="button primary" onClick={() => setAttempt((value) => value + 1)}>
          <RefreshCw size={16} /> Retry stream
        </button>
      )}
    </div>
  );
}
