import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js/light';
import { AlertCircle, LoaderCircle, Signal, Wifi } from 'lucide-react';
import type { Episode, TorrentStatus, WatchProgress } from '../../shared/types';

interface Props {
  episode: Episode;
  poster?: string;
  progress?: WatchProgress;
  onProgress: (value: WatchProgress) => void;
  onEnded: () => void;
}

function preferredHeight(): number {
  try {
    const value = Number(localStorage.getItem('yoru-quality-height') || -1);
    return Number.isFinite(value) && value > 0 && value <= 720 ? value : -1;
  } catch {
    return -1;
  }
}

function rememberHeight(height: number) {
  try {
    localStorage.setItem('yoru-quality-height', String(height));
  } catch {
    /* Quality selection still works when browser storage is unavailable. */
  }
}

export function AdaptiveVideo({ episode, poster, progress, onProgress, onEnded }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const engine = useRef<Hls | null>(null);
  const callbacks = useRef({ onProgress, onEnded, progress });
  callbacks.current = { onProgress, onEnded, progress };
  const lastSave = useRef(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [original, setOriginal] = useState(false);
  const [retry, setRetry] = useState(0);
  const [qualities, setQualities] = useState<number[]>([]);
  const [quality, setQuality] = useState(-1);
  const [playingHeight, setPlayingHeight] = useState(0);
  const [torrent, setTorrent] = useState<TorrentStatus>();
  const manifest = useRef('');
  const nativeResume = useRef<number | null>(null);

  useEffect(() => {
    const id = /^t-([a-f0-9]{40})-/.exec(episode.id)?.[1];
    if (!id) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch('/api/torrents', { signal: abort.signal });
        if (response.ok)
          setTorrent(((await response.json()) as TorrentStatus[]).find((item) => item.id === id));
      } catch {
        /* The player has its own actionable connection error. */
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [episode.id]);

  useEffect(() => {
    const element = video.current!;
    const controller = new AbortController();
    let alive = true;
    setError('');
    setLoading(true);
    setPlayingHeight(0);
    const saved = callbacks.current.progress;
    const start = saved && !saved.completed ? saved.time : 0;
    nativeResume.current = start;
    const startPlayback = () => {
      void element.play().catch(() => {});
    };
    const setup = async () => {
      if (original) {
        element.src = `/api/stream/${episode.id}`;
        startPlayback();
        return;
      }
      const response = await fetch(`/api/playback/${episode.id}`, { signal: controller.signal });
      const data = (await response.json()) as { manifest: string; qualities: number[]; error?: string };
      if (!response.ok) throw new Error(data.error || 'The host could not prepare this stream.');
      if (!alive) return;
      manifest.current = data.manifest;
      setQualities(data.qualities);
      const preferred = preferredHeight();
      const preferredIndex =
        preferred === -1
          ? -1
          : Math.max(
              0,
              data.qualities.findLastIndex((height) => height <= preferred),
            );
      setQuality(preferredIndex);
      if (Hls.isSupported()) {
        const hls = new Hls({
          startLevel: 0,
          startPosition: start,
          maxBufferLength: 18,
          maxMaxBufferLength: 24,
          backBufferLength: 6,
          maxBufferSize: 12 * 1024 * 1024,
          capLevelToPlayerSize: true,
          abrEwmaDefaultEstimate: 300_000,
          fragLoadPolicy: {
            default: {
              ...Hls.DefaultConfig.fragLoadPolicy.default,
              maxTimeToFirstByteMs: episode.id.startsWith('t-') ? 120_000 : 30_000,
              maxLoadTimeMs: episode.id.startsWith('t-') ? 150_000 : 60_000,
            },
          },
        });
        engine.current = hls;
        nativeResume.current = null;
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (preferredIndex >= 0) hls.currentLevel = preferredIndex;
          startPlayback();
        });
        hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) =>
          setPlayingHeight(hls.levels[data.level]?.height || 0),
        );
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            setLoading(false);
            setError(
              'The adaptive stream was interrupted. Retry playback, or use original quality if your browser supports the source file.',
            );
          }
        });
        hls.loadSource(data.manifest);
        hls.attachMedia(element);
      } else if (element.canPlayType('application/vnd.apple.mpegurl')) {
        element.src =
          preferredIndex === -1
            ? data.manifest
            : data.manifest.replace('master.m3u8', `${data.qualities[preferredIndex]}/index.m3u8`);
        startPlayback();
      } else
        throw new Error(
          'Adaptive playback is not supported in this browser. Try original quality or use a current browser.',
        );
    };
    void setup().catch((cause: unknown) => {
      if (alive && !controller.signal.aborted) {
        setLoading(false);
        setError(cause instanceof Error ? cause.message : 'Could not start playback.');
      }
    });
    return () => {
      alive = false;
      controller.abort();
      if (Number.isFinite(element.duration) && element.duration > 0)
        callbacks.current.onProgress({
          time: element.currentTime,
          duration: element.duration,
          completed: element.ended,
          updatedAt: Date.now(),
        });
      engine.current?.destroy();
      engine.current = null;
      element.pause();
      element.removeAttribute('src');
      element.load();
    };
  }, [episode.id, original, retry]);

  const save = (element: HTMLVideoElement, completed = false) => {
    if (element.duration > 0 && Number.isFinite(element.duration))
      callbacks.current.onProgress({
        time: element.currentTime,
        duration: element.duration,
        updatedAt: Date.now(),
        completed: completed || element.ended,
      });
    lastSave.current = Date.now();
  };
  const changeQuality = (value: number) => {
    rememberHeight(value === -1 ? -1 : qualities[value]);
    setQuality(value);
    const hls = engine.current;
    if (hls) {
      hls.nextLevel = value;
      return;
    }
    if (video.current) {
      nativeResume.current = video.current.currentTime;
      video.current.src =
        value === -1
          ? manifest.current
          : manifest.current.replace('master.m3u8', `${qualities[value]}/index.m3u8`);
      void video.current.play().catch(() => {});
    }
  };
  return (
    <>
      <div className="video-wrap">
        <video
          ref={video}
          controls
          controlsList="nodownload"
          playsInline
          preload="metadata"
          className="video-player"
          poster={poster}
          onLoadedMetadata={(event) => {
            if (nativeResume.current !== null) {
              event.currentTarget.currentTime = nativeResume.current;
              nativeResume.current = null;
            }
          }}
          onCanPlay={() => setLoading(false)}
          onPlaying={() => setLoading(false)}
          onWaiting={() => setLoading(true)}
          onTimeUpdate={(event) => {
            if (Date.now() - lastSave.current > 5000) save(event.currentTarget);
          }}
          onPause={(event) => save(event.currentTarget)}
          onEnded={(event) => {
            save(event.currentTarget, true);
            callbacks.current.onEnded();
          }}
          onError={() => {
            if (video.current?.getAttribute('src')) {
              setLoading(false);
              setError(
                'This video could not be played. Try adaptive playback to convert it into a browser-friendly stream.',
              );
            }
          }}
        >
          {episode.subtitles.map((subtitle, i) => (
            <track
              key={subtitle.id}
              kind="subtitles"
              src={`/api/subtitles/${subtitle.id}`}
              srcLang={subtitle.language}
              label={subtitle.label}
              default={i === 0}
            />
          ))}
        </video>
        {loading && !error && (
          <div className="video-loading" role="status">
            <LoaderCircle size={26} className="spin" />
            <span>Preparing your stream…</span>
            <small>
              {torrent
                ? torrent.error ||
                  (torrent.state === 'paused'
                    ? 'Resume this source in Torrent sources.'
                    : `${torrent.peers} peers · Fetching pieces and preparing video on your PC.`)
                : 'The first few seconds are prepared on the host PC.'}
            </small>
          </div>
        )}
      </div>
      <div className="stream-toolbar">
        <span>
          <Signal size={16} />
          {original ? 'Original file' : `${playingHeight ? `${playingHeight}p · ` : ''}Adaptive streaming`}
        </span>
        <div>
          <Wifi size={15} />
          <label htmlFor="stream-quality">Quality</label>
          <select
            id="stream-quality"
            value={original ? 'original' : quality}
            onChange={(event) => {
              if (event.target.value === 'original') setOriginal(true);
              else if (original) {
                const value = Number(event.target.value);
                rememberHeight(value === -1 ? -1 : qualities[value]);
                setOriginal(false);
              } else changeQuality(Number(event.target.value));
            }}
          >
            <option value={-1}>Auto · adapts to your network</option>
            {qualities.map((height, index) => (
              <option key={height} value={index}>
                {height}p{index === 0 ? ' · Data saver' : ''}
              </option>
            ))}
            <option value="original">Original · higher data use</option>
          </select>
        </div>
      </div>
      {error && (
        <div className="notice error" role="alert">
          <AlertCircle size={20} />
          <div>
            <p>{error}</p>
            <div className="button-group">
              <button className="button secondary" onClick={() => setRetry((value) => value + 1)}>
                Retry
              </button>
              <button className="button secondary" onClick={() => setOriginal(!original)}>
                {original ? 'Use adaptive playback' : 'Try original quality'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
