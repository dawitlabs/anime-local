import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Play } from 'lucide-react';
import type { Title, WatchProgress } from '../../shared/types';
import { sizeLabel } from '../storage';
import { Dialog } from './Dialog';
import { EpisodeStream } from './EpisodeStream';

interface Props {
  title: Title;
  initialEpisode?: string;
  progress: Record<string, WatchProgress>;
  onProgress: (id: string, value: WatchProgress) => void;
  onClose: () => void;
}

export function Player({ title, initialEpisode, progress, onProgress, onClose }: Props) {
  const [episodeId, setEpisodeId] = useState(initialEpisode || title.episodes[0].id);
  const episode = title.episodes.find((item) => item.id === episodeId) || title.episodes[0];
  const index = title.episodes.indexOf(episode);
  const [season, setSeason] = useState(episode.season);
  const [autoNext, setAutoNext] = useState(true);
  const seasons = [...new Set(title.episodes.map((item) => item.season))];
  const select = (id: string) => {
    const next = title.episodes.find((item) => item.id === id);
    if (next) {
      setEpisodeId(id);
      setSeason(next.season);
    }
  };
  return (
    <Dialog title="Now playing · local stream" wide onClose={onClose}>
      <EpisodeStream
        key={episode.id}
        episode={episode}
        catalogId={title.source === 'catalog' ? title.id : undefined}
        poster={title.backdrop || title.poster}
        progress={progress[episode.id]}
        onProgress={(value) => onProgress(episode.id, value)}
        onEnded={() => {
          if (autoNext && title.episodes[index + 1]) select(title.episodes[index + 1].id);
        }}
      />
      <div className="player-title">
        <div>
          <span className="eyebrow">
            {title.kind === 'movie' ? 'FEATURE FILM' : `SEASON ${episode.season} · EPISODE ${episode.number}`}
          </span>
          <h2>{title.name}</h2>
          <p className="muted">
            {episode.title}
            {episode.size > 0 && (
              <>
                {' '}
                <span>·</span> {episode.format} <span>·</span> {sizeLabel(episode.size)}
              </>
            )}
          </p>
        </div>
        <span className="local-pill">
          <span /> Streaming from your PC
        </span>
      </div>
      {title.description && <p className="player-description muted">{title.description}</p>}
      {title.kind === 'series' && (
        <>
          <div className="player-controls">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={autoNext}
                onChange={(event) => setAutoNext(event.target.checked)}
              />{' '}
              Play next episode automatically
            </label>
            <div className="button-group">
              <button
                className="button secondary"
                disabled={index === 0}
                onClick={() => select(title.episodes[index - 1].id)}
              >
                <ArrowLeft size={16} /> Previous
              </button>
              <button
                className="button primary"
                disabled={index === title.episodes.length - 1}
                onClick={() => select(title.episodes[index + 1].id)}
              >
                Next episode <ArrowRight size={16} />
              </button>
            </div>
          </div>
          <div className="section-heading">
            <h3>
              Episodes <span>{title.episodes.length}</span>
            </h3>
            <select
              aria-label="Season"
              value={season}
              onChange={(event) => setSeason(Number(event.target.value))}
            >
              {seasons.map((value) => (
                <option key={value} value={value}>
                  Season {value}
                </option>
              ))}
            </select>
          </div>
          <div className="episode-list">
            {title.episodes
              .filter((item) => item.season === season)
              .map((item) => (
                <button
                  key={item.id}
                  className={`episode-row ${item.id === episode.id ? 'playing' : ''}`}
                  onClick={() => select(item.id)}
                  aria-current={item.id === episode.id ? 'true' : undefined}
                >
                  <span className="episode-number">{String(item.number).padStart(2, '0')}</span>
                  <span className="episode-name">
                    {item.title}
                    <small>
                      {item.size > 0
                        ? `${item.format} · ${sizeLabel(item.size)}`
                        : 'Stream selected automatically'}
                    </small>
                  </span>
                  {progress[item.id]?.completed ? <Check size={18} /> : <Play size={16} />}
                </button>
              ))}
          </div>
        </>
      )}
    </Dialog>
  );
}
