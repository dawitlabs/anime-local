import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, FileUp, Magnet, Pause, Play, Trash2, Users } from 'lucide-react';
import type { TorrentStatus } from '../../shared/types';
import { sizeLabel } from '../storage';
import { Dialog } from './Dialog';

export function TorrentManager({
  onClose,
  onChange,
}: {
  onClose: () => void;
  onChange: () => Promise<void>;
}) {
  const [items, setItems] = useState<TorrentStatus[]>([]);
  const [magnet, setMagnet] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    const response = await fetch('/api/torrents');
    if (!response.ok) throw new Error('Could not reach the torrent engine. Check the host server.');
    setItems((await response.json()) as TorrentStatus[]);
  }, []);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh();
      } catch (cause) {
        if (alive) setError(String(cause));
      }
      if (alive) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [refresh]);

  const request = async (url: string, options: RequestInit, success: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error || 'The torrent request failed.');
      }
      setNotice(success);
      setRemoving('');
      await refresh();
      await onChange();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The torrent request failed.');
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Torrent sources" onClose={onClose}>
      <div className="guide-icon">
        <Magnet size={30} />
      </div>
      <h2>Find a story. Press play.</h2>
      <p className="muted">
        Add a magnet link or a .torrent file. Your PC connects to peers and streams the pieces you need as you
        watch.
      </p>
      <form
        className="torrent-form"
        onSubmit={(event) => {
          event.preventDefault();
          void request(
            '/api/torrents',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ magnet }),
            },
            'Source added. Videos appear in your collection when metadata is ready.',
          ).then((ok) => {
            if (ok) setMagnet('');
          });
        }}
      >
        <label className="field-label" htmlFor="magnet">
          Magnet link
        </label>
        <textarea
          id="magnet"
          rows={3}
          value={magnet}
          onChange={(event) => setMagnet(event.target.value)}
          placeholder="magnet:?xt=urn:btih:…"
          maxLength={16384}
          required
          spellCheck={false}
        />
        <div className="torrent-actions">
          <button className="button primary" type="submit" disabled={busy || !magnet.trim()}>
            <Magnet size={16} /> Add source
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={() => upload.current?.click()}
          >
            <FileUp size={16} /> Open .torrent
          </button>
        </div>
        <input
          ref={upload}
          type="file"
          accept=".torrent,application/x-bittorrent"
          hidden
          aria-label="Upload torrent file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            if (file.size > 2 * 1024 ** 2) {
              setError('Choose a .torrent file smaller than 2 MiB.');
              return;
            }
            void request(
              '/api/torrents/file',
              { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file },
              'Source added. Videos will appear in your collection.',
            );
          }}
        />
      </form>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className="torrent-list">
        <h3>
          Your sources <span className="muted">({items.length})</span>
        </h3>
        {!items.length && (
          <p className="muted">Your sources will appear here. Nothing downloads until you choose a video.</p>
        )}
        {items.map((item) => (
          <article className="torrent-item" key={item.id}>
            <div className="torrent-item-heading">
              <strong>{item.name}</strong>
              <span className={`torrent-state ${item.state}`}>
                {
                  {
                    metadata: 'Finding metadata',
                    checking: 'Checking cache',
                    ready: 'Ready to stream',
                    paused: 'Paused',
                    error: 'Needs attention',
                  }[item.state]
                }
              </span>
            </div>
            {item.error && <p className="torrent-error">{item.error}</p>}
            <div className="torrent-metrics">
              <span>
                <Users size={14} /> {item.peers} peers
              </span>
              <span>
                <ArrowDown size={14} /> {sizeLabel(item.downloadSpeed)}/s
              </span>
              <span>
                <ArrowUp size={14} /> {sizeLabel(item.uploadSpeed)}/s
              </span>
              <span>{item.videoCount} videos</span>
            </div>
            <p className="torrent-cache">
              {item.state === 'paused'
                ? 'Cached pieces stay on your PC.'
                : `${sizeLabel(item.downloaded)} cached${item.total ? ` · ${sizeLabel(item.total)} source` : ''}`}
            </p>
            {item.state === 'metadata' && (
              <p className="muted">
                Waiting for peers to share the file list. A source with no reachable peers cannot start.
              </p>
            )}
            <div className="torrent-actions">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void request(
                    `/api/torrents/${item.id}`,
                    {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ paused: item.state !== 'paused' && item.state !== 'error' }),
                    },
                    item.state === 'paused' || item.state === 'error' ? 'Source resumed.' : 'Source paused.',
                  )
                }
              >
                {item.state === 'paused' || item.state === 'error' ? <Play size={14} /> : <Pause size={14} />}
                {item.state === 'paused' || item.state === 'error' ? 'Resume' : 'Pause'}
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => setRemoving(removing === item.id ? '' : item.id)}
              >
                <Trash2 size={14} /> Remove
              </button>
            </div>
            {removing === item.id && (
              <div className="torrent-remove">
                <p>Remove this source and its cached torrent pieces from this PC?</p>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void request(
                      `/api/torrents/${item.id}`,
                      { method: 'DELETE' },
                      'Source and cached pieces removed.',
                    )
                  }
                >
                  Remove source and cache
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      <p className="guide-note">
        Watch directly—there’s no full-file download step. Small pieces are cached on the host and shared with
        peers. Data saver reduces the stream sent to your screen; your PC still fetches the original source
        quality.
      </p>
      <button
        className="button primary full-width"
        onClick={() => {
          void onChange();
          onClose();
        }}
      >
        Back to collection
      </button>
    </Dialog>
  );
}
