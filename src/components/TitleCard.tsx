import { Bookmark, Check, Play } from 'lucide-react';
import type { Episode, Title, WatchProgress } from '../../shared/types';

export function Poster({ title, className = '' }: { title: Title; className?: string }) {
  const variant = parseInt(title.id.slice(0, 2), 16) % 5;
  return (
    <div className={`poster-art palette-${variant} ${className}`}>
      <div className="poster-moon" />
      <div className="poster-mountain back" />
      <div className="poster-mountain front" />
      <span className="poster-kanji" aria-hidden="true">
        夜
      </span>
      <div className="poster-words">
        <small>YOUR LOCAL COLLECTION</small>
        <strong>{title.name}</strong>
      </div>
      {title.poster && (
        <img
          src={title.poster}
          alt=""
          loading="lazy"
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      )}
    </div>
  );
}

export function TitleCard({
  title,
  saved,
  onSave,
  onPlay,
}: {
  title: Title;
  saved: boolean;
  onSave: () => void;
  onPlay: () => void;
}) {
  return (
    <article className="title-card">
      <button className="poster-button" onClick={onPlay} aria-label={`Watch ${title.name}`}>
        <Poster title={title} />
        <span className="card-kind">{title.kind === 'movie' ? 'MOVIE' : 'SERIES'}</span>
        <span className="poster-play">
          <Play size={24} fill="currentColor" />
        </span>
      </button>
      <div className="card-title-row">
        <button className="text-button title-link" onClick={onPlay}>
          {title.name}
        </button>
        <button
          className={`icon-button bookmark ${saved ? 'active' : ''}`}
          aria-label={`${saved ? 'Remove' : 'Add'} ${title.name} ${saved ? 'from' : 'to'} watchlist`}
          aria-pressed={saved}
          onClick={onSave}
        >
          <Bookmark size={17} fill={saved ? 'currentColor' : 'none'} />
        </button>
      </div>
      <p className="card-meta">
        {title.year && (
          <>
            {title.year}
            <span>·</span>
          </>
        )}
        {title.kind === 'series' ? `${title.episodes.length} episodes` : title.episodes[0]?.format}
        {title.genres[0] && (
          <>
            <span>·</span>
            {title.genres[0]}
          </>
        )}
      </p>
    </article>
  );
}

export function ContinueCard({
  title,
  episode,
  progress,
  onPlay,
}: {
  title: Title;
  episode: Episode;
  progress: WatchProgress;
  onPlay: () => void;
}) {
  return (
    <button className="continue-card" onClick={onPlay}>
      <Poster title={title} />
      <div className="continue-info">
        <span className="eyebrow">
          {title.kind === 'movie' ? 'MOVIE' : `S${episode.season} · E${episode.number}`}
        </span>
        <strong>{title.name}</strong>
        <span className="muted">
          {progress.completed ? (
            <>
              <Check size={13} /> Watched
            </>
          ) : (
            `${Math.max(1, Math.ceil((progress.duration - progress.time) / 60))} min left`
          )}
        </span>
        <span className="progress-track">
          <span style={{ width: `${Math.min(100, (progress.time / progress.duration) * 100)}%` }} />
        </span>
      </div>
      <Play size={20} />
    </button>
  );
}
