import { Check, Copy, FolderOpen, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Dialog } from './Dialog';

export function LibraryGuide({
  directory,
  scanning,
  onScan,
  onClose,
}: {
  directory: string;
  scanning: boolean;
  onScan: () => Promise<void>;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  return (
    <Dialog title="Your local library" onClose={onClose}>
      <div className="guide-icon">
        <FolderOpen size={30} />
      </div>
      <h2>A home for your anime.</h2>
      <p className="muted">
        Add your video files to this folder on the host PC, then scan your library. Your videos stay on your
        machine.
      </p>
      <label className="field-label" htmlFor="media-path">
        Media folder
      </label>
      <div className="path-field">
        <input id="media-path" value={directory} readOnly />
        <button
          className="icon-button"
          aria-label="Copy media folder path"
          onClick={() => {
            if (!navigator.clipboard) {
              setCopyError(true);
              return;
            }
            void navigator.clipboard
              .writeText(directory)
              .then(() => {
                setCopied(true);
                setCopyError(false);
              })
              .catch(() => setCopyError(true));
          }}
        >
          {copied ? <Check size={18} /> : <Copy size={18} />}
        </button>
      </div>
      {copyError && <p className="muted">Select the folder path above and copy it manually.</p>}
      <h3>Give each story its own folder</h3>
      <pre className="folder-tree">
        {
          'media/\n├── Movies/\n│   └── My Anime Movie/\n│       ├── movie.mp4\n│       └── poster.jpg\n└── Series/\n    └── My Anime Series/\n        └── Season 01/\n            ├── S01E01 - The Beginning.mp4\n            ├── S01E01 - The Beginning.en.srt\n            └── S01E02 - A New Journey.mp4'
        }
      </pre>
      <p className="guide-note">
        MP4, MKV, WebM, and other supported videos stream in your browser. Adaptive quality keeps data use
        lower on slow connections. Choose Data saver in the player to stay at the smallest quality.
      </p>
      <details>
        <summary>Use a different folder or add artwork</summary>
        <p>
          Copy <code>.env.example</code> to <code>.env</code>, set <code>MEDIA_DIR</code> to your video
          folder, and restart the server. Add <code>poster.jpg</code>, <code>backdrop.jpg</code>, and an
          optional <code>title.json</code> inside a title’s folder. The README includes examples.
        </p>
      </details>
      <button
        className="button primary full-width"
        disabled={scanning}
        onClick={() => {
          void onScan();
        }}
      >
        <RefreshCw size={17} className={scanning ? 'spin' : ''} />
        {scanning ? 'Scanning your folder…' : 'Scan library'}
      </button>
    </Dialog>
  );
}
