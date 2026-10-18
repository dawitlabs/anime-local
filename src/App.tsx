import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownUp,
  ArrowRight,
  Bookmark,
  Check,
  ChevronRight,
  CircleHelp,
  Clapperboard,
  Film,
  FolderOpen,
  HardDrive,
  LayoutGrid,
  Moon,
  Magnet,
  Play,
  Plus,
  RefreshCw,
  Search,
  Signal,
  Sparkles,
  Tv,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { CatalogPage, Library, Title } from '../shared/types';
import { Landscape } from './components/Landscape';
import { TitleCard, ContinueCard } from './components/TitleCard';
import { LibraryGuide } from './components/LibraryGuide';
import { TorrentManager } from './components/TorrentManager';
import { usePreferences } from './storage';

const Player = lazy(() => import('./components/Player').then((module) => ({ default: module.Player })));
const CatalogWatch = lazy(() =>
  import('./components/CatalogWatch').then((module) => ({ default: module.CatalogWatch })),
);
type View = 'all' | 'series' | 'movie' | 'saved' | 'local';
const views: Array<{ id: View; label: string; icon: LucideIcon }> = [
  { id: 'all', label: 'Discover', icon: LayoutGrid },
  { id: 'series', label: 'Anime series', icon: Tv },
  { id: 'movie', label: 'Movies', icon: Film },
  { id: 'saved', label: 'My watchlist', icon: Bookmark },
];

export function App() {
  const [library, setLibrary] = useState<Library | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<Title[]>([]);
  const [catalogError, setCatalogError] = useState('');
  const [page, setPage] = useState(0);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState('');
  const [guide, setGuide] = useState(false);
  const [torrentManager, setTorrentManager] = useState(false);
  const [view, setView] = useState<View>('all');
  const [query, setQuery] = useState('');
  const [genre, setGenre] = useState('All genres');
  const [sort, setSort] = useState('popular');
  const [selected, setSelected] = useState<{ title: Title; episode?: string } | null>(null);
  const preferences = usePreferences();
  const load = useCallback(async (scan = false) => {
    if (scan) setScanning(true);
    setError('');
    try {
      const response = await fetch(scan ? '/api/library/scan' : '/api/library', {
        method: scan ? 'POST' : 'GET',
      });
      if (!response.ok)
        throw new Error(
          'Could not read your library. Check the host server and media folder, then try again.',
        );
      const data = (await response.json()) as Library;
      setLibrary(data);
      if (scan)
        setNotice(
          `Library refreshed. ${data.titles.length} ${data.titles.length === 1 ? 'title' : 'titles'} ready to watch.`,
        );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load your library.');
    } finally {
      setScanning(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);
  const browsing = view !== 'saved' && view !== 'local';
  useEffect(() => {
    setPage(0);
    setCatalog([]);
  }, [query, genre, sort]);
  useEffect(() => {
    if (!browsing) {
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setCatalogError('');
    const timer = setTimeout(
      () => {
        const params = new URLSearchParams({ q: query, page: String(page), genre, order: sort });
        void fetch(`/api/catalog?${params}`, { signal: abort.signal })
          .then(async (response) => {
            const data = (await response.json()) as CatalogPage & { error?: string };
            if (!response.ok) throw new Error(data.error || 'Could not load the anime catalog.');
            if (!abort.signal.aborted) {
              setCatalog((previous) =>
                page
                  ? [...new Map([...previous, ...data.titles].map((title) => [title.id, title])).values()]
                  : data.titles,
              );
              setNextPage(data.nextPage);
            }
          })
          .catch((cause: unknown) => {
            if (!abort.signal.aborted)
              setCatalogError(cause instanceof Error ? cause.message : 'Could not load the catalog.');
          })
          .finally(() => {
            if (!abort.signal.aborted) setLoading(false);
          });
      },
      query ? 350 : 0,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, page, genre, sort, browsing, catalogRefresh]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const titles = browsing
    ? catalog
    : view === 'saved'
      ? [...Object.values(preferences.titles), ...(library?.titles || [])].filter((title) =>
          preferences.saved.includes(title.id),
        )
      : library?.titles || [];
  const featured = useMemo(() => catalog[0], [catalog]);
  const genres = [
    'Action',
    'Adventure',
    'Comedy',
    'Drama',
    'Fantasy',
    'Romance',
    'Sci-Fi',
    'Slice of Life',
    'Sports',
    'Mystery',
  ];
  const filtered = titles
    .filter(
      (title) =>
        (view === 'all' ||
          view === 'local' ||
          (view === 'saved' ? preferences.saved.includes(title.id) : title.kind === view)) &&
        (genre === 'All genres' || title.genres.includes(genre)) &&
        (browsing || `${title.name} ${title.genres.join(' ')}`.toLowerCase().includes(query.toLowerCase())),
    )
    .sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : 0));
  const continuing = [...Object.values(preferences.titles), ...(library?.titles || [])]
    .flatMap((title) =>
      title.episodes.map((episode) => ({ title, episode, progress: preferences.progress[episode.id] })),
    )
    .filter((item) => item.progress && !item.progress.completed && item.progress.time > 1)
    .sort((a, b) => b.progress.updatedAt - a.progress.updatedAt)
    .slice(0, 3);
  const play = (title: Title, episode?: string) => {
    const latest = (preferences.titles[title.id] || title).episodes
      .filter((item) => preferences.progress[item.id] && !preferences.progress[item.id].completed)
      .sort((a, b) => preferences.progress[b.id].updatedAt - preferences.progress[a.id].updatedAt)[0];
    setSelected({ title, episode: episode || latest?.id });
    if (!preferences.titles[title.id]) preferences.rememberTitle(title);
  };
  const navigate = (next: View) => {
    setView(next);
    setQuery('');
    setGenre('All genres');
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to library
      </a>
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate('all')} aria-label="Yoru home">
          <span className="brand-symbol">
            <Moon size={25} fill="currentColor" />
          </span>
          <span>
            yoru<span className="brand-dot">.</span>
          </span>
        </button>
        <div className="sidebar-caption">YOUR OWN LITTLE CINEMA</div>
        <span className="nav-label">EXPLORE</span>
        <nav aria-label="Main navigation">
          {views.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${view === id ? 'selected' : ''}`}
              onClick={() => navigate(id)}
              aria-current={view === id ? 'page' : undefined}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === 'saved' && preferences.saved.length > 0 && <small>{preferences.saved.length}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-library">
          <span className="nav-label">YOUR SPACE</span>
          <button
            className={`nav-item ${view === 'local' ? 'selected' : ''}`}
            onClick={() => navigate('local')}
          >
            <HardDrive size={19} />
            <span>On this PC</span>
          </button>
          <button className="nav-item" onClick={() => setTorrentManager(true)}>
            <Magnet size={19} />
            <span>Stream settings</span>
          </button>
          <button className="nav-item" onClick={() => setGuide(true)}>
            <FolderOpen size={19} />
            <span>Local files</span>
          </button>
        </div>
        <div className="sidebar-bottom">
          <div className="local-card">
            <span className="local-card-icon">
              <HardDrive size={21} />
            </span>
            <div>
              <strong>Home is the server.</strong>
              <p>Pick a story. Press play.</p>
            </div>
            <span className="online-dot" />
          </div>
          <button className="help-link" onClick={() => setTorrentManager(true)}>
            <CircleHelp size={16} /> Advanced sources <ChevronRight size={15} />
          </button>
          <div className="sidebar-footer">
            MADE FOR THE LOVE OF ANIME <span>夜</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Anime <ChevronRight size={14} />
            <span>{view === 'local' ? 'On this PC' : views.find((item) => item.id === view)?.label}</span>
          </div>
          <label className="search-box">
            <Search size={18} />
            <input
              type="search"
              placeholder="Find your next story…"
              aria-label="Search anime"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <span className="search-shortcut">⌕</span>
          </label>
          <button
            className="profile-button"
            onClick={() => setTorrentManager(true)}
            aria-label="Open torrent sources"
          >
            <span className="online-dot" />
            LOCAL
            <Magnet size={16} />
          </button>
        </header>
        <main id="main-content">
          {error && (
            <div className="notice error" role="alert">
              <p>{error}</p>
              <button className="button secondary" onClick={() => void load()}>
                Retry
              </button>
            </div>
          )}
          {catalogError && browsing && (
            <div className="notice error" role="alert">
              <p>{catalogError}</p>
              <button className="button secondary" onClick={() => setCatalogRefresh((value) => value + 1)}>
                Retry catalog
              </button>
            </div>
          )}
          {preferences.storageError && (
            <div className="notice" role="alert">
              Your browser could not save watch progress. Allow local storage to keep it between visits.
            </div>
          )}
          {library?.warnings.length ? (
            <details className="notice">
              <summary>{library.warnings.length} library items need attention</summary>
              {library.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </details>
          ) : null}
          {view === 'all' && !query && (
            <>
              <div className="welcome-row">
                <div>
                  <p className="eyebrow">A LITTLE ESCAPE, ANYTIME</p>
                  <h1>
                    Make tonight an anime night<span>.</span>
                  </h1>
                </div>
                <span className="welcome-japanese" aria-hidden="true">
                  物語のある暮らし
                </span>
              </div>
              <section
                className={`hero ${featured?.backdrop ? 'has-backdrop' : ''}`}
                aria-label={featured ? 'Featured in your library' : 'Welcome to your local cinema'}
              >
                <Landscape className="hero-landscape" />
                {featured?.backdrop && <img className="hero-backdrop" src={featured.backdrop} alt="" />}
                <div className="hero-shade" />
                <div className="hero-content">
                  <span className="hero-kicker">
                    <span />
                    {featured ? 'YOUR NEXT STORY' : 'YOUR WORLD. ON PLAY.'}
                  </span>
                  <h2>
                    {featured ? (
                      featured.name
                    ) : (
                      <>
                        Great stories.
                        <br />
                        Closer to home.
                      </>
                    )}
                  </h2>
                  <div className="hero-meta">
                    {featured ? (
                      <>
                        <span>{featured.kind === 'movie' ? 'Movie' : 'Anime series'}</span>
                        {featured.year && (
                          <>
                            <i />
                            {featured.year}
                          </>
                        )}
                        {featured.genres.slice(0, 2).map((item) => (
                          <span key={item}>
                            <i />
                            {item}
                          </span>
                        ))}
                      </>
                    ) : (
                      <>
                        <span>Anime series</span>
                        <i />
                        <span>Full movies</span>
                        <i />
                        <span>All yours</span>
                      </>
                    )}
                  </div>
                  <p>
                    {featured?.description ||
                      'Browse anime, choose an episode, and settle in. Your PC finds a stream automatically.'}
                  </p>
                  <div className="hero-actions">
                    <button
                      className="button primary"
                      disabled={!featured}
                      onClick={() => featured && play(featured)}
                    >
                      {featured ? <Play size={18} fill="currentColor" /> : <Plus size={19} />}
                      {featured ? 'Watch now' : 'Loading anime…'}
                    </button>
                    {featured ? (
                      <button
                        className="button glass"
                        onClick={() => preferences.toggleSaved(featured.id, featured)}
                      >
                        {preferences.saved.includes(featured.id) ? <Check size={18} /> : <Plus size={18} />}My
                        watchlist
                      </button>
                    ) : (
                      <span className="hero-text-button">No links to find. Just press play.</span>
                    )}
                  </div>
                </div>
                <div className="hero-note">
                  <span className="online-dot" />
                  STREAMED FROM HOME
                </div>
                <div className="hero-seal" aria-hidden="true">
                  夜<span>YORU</span>
                </div>
              </section>
              <div className="library-stats">
                <span>
                  <Clapperboard size={16} />
                  <strong>{titles.length}</strong> anime to explore
                </span>
                <span>
                  <Tv size={16} />
                  Movies &amp; full series
                </span>
                <span>
                  <Signal size={16} />
                  Adaptive quality. Less buffering.
                </span>
                <span className="storage-stat">
                  <HardDrive size={15} />
                  Automatic source selection
                </span>
              </div>
              {continuing.length > 0 && (
                <section className="continue-section">
                  <div className="section-heading">
                    <h2>Pick up where you left off</h2>
                    <span className="muted">Your next chapter awaits</span>
                  </div>
                  <div className="continue-grid">
                    {continuing.map((item) => (
                      <ContinueCard
                        key={item.episode.id}
                        {...item}
                        onPlay={() => play(item.title, item.episode.id)}
                      />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
          <section className="collection">
            <div className="section-heading">
              <div className="collection-title">
                <h2>
                  {query
                    ? 'Search results'
                    : view === 'saved'
                      ? 'Your watchlist'
                      : view === 'movie'
                        ? 'A movie kind of night'
                        : view === 'series'
                          ? 'One more episode'
                          : view === 'local'
                            ? 'On this PC'
                            : 'Find your next story'}
                </h2>
                <span className="count-badge">{filtered.length}</span>
              </div>
              <button
                className="text-button refresh-button"
                disabled={scanning || loading}
                onClick={() => (browsing ? setCatalogRefresh((value) => value + 1) : void load(true))}
              >
                <RefreshCw size={15} className={scanning ? 'spin' : ''} />
                {loading || scanning ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
            <div className="collection-toolbar">
              <div className="filter-tabs" role="group" aria-label="Filter collection">
                {(
                  [
                    { id: 'all', label: 'All anime' },
                    { id: 'series', label: 'Series' },
                    { id: 'movie', label: 'Movies' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    className={view === item.id ? 'active' : ''}
                    onClick={() => setView(item.id)}
                    aria-pressed={view === item.id}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="select-group">
                <select aria-label="Genre" value={genre} onChange={(event) => setGenre(event.target.value)}>
                  <option>All genres</option>
                  {genres.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
                <label className="sort-label">
                  <ArrowDownUp size={14} />
                  <select
                    aria-label="Sort titles"
                    value={sort}
                    onChange={(event) => setSort(event.target.value)}
                  >
                    <option value="popular">Most popular</option>
                    <option value="trending">Trending</option>
                    <option value="rating">Top rated</option>
                    <option value="airing">Currently airing</option>
                    <option value="name">Title A–Z</option>
                  </select>
                </label>
              </div>
            </div>
            {loading && !titles.length ? (
              <div className="empty-state" role="status">
                <RefreshCw className="spin" />
                <h3>Opening the anime catalog…</h3>
              </div>
            ) : filtered.length ? (
              <div className="title-grid">
                {filtered.map((title) => (
                  <TitleCard
                    key={title.id}
                    title={title}
                    saved={preferences.saved.includes(title.id)}
                    onSave={() => preferences.toggleSaved(title.id, title)}
                    onPlay={() => play(title)}
                  />
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-icon">
                  {query ? (
                    <Search size={29} />
                  ) : view === 'saved' ? (
                    <Bookmark size={29} />
                  ) : (
                    <FolderOpen size={29} />
                  )}
                  <span>
                    <Sparkles size={13} />
                  </span>
                </div>
                <h3>
                  {query
                    ? 'No stories by that name.'
                    : view === 'saved'
                      ? 'Save a little something for later.'
                      : titles.length
                        ? 'Nothing here just yet.'
                        : browsing
                          ? 'No anime found here yet.'
                          : 'Every collection starts with one story.'}
                </h3>
                <p>
                  {query
                    ? 'Try another title or clear your filters.'
                    : view === 'saved'
                      ? 'Tap the bookmark on any title to add it to your watchlist.'
                      : titles.length
                        ? 'Load more anime or try a different filter.'
                        : browsing
                          ? 'Try searching for an anime title or changing the filters.'
                          : 'Start watching from Discover. Sources are added to this PC automatically.'}
                </p>
                {!titles.length && !browsing ? (
                  <button className="button secondary" onClick={() => navigate('all')}>
                    <Play size={16} /> Browse anime <ArrowRight size={15} />
                  </button>
                ) : query ? (
                  <button
                    className="button secondary"
                    onClick={() => {
                      setQuery('');
                      setGenre('All genres');
                    }}
                  >
                    Clear search
                  </button>
                ) : null}
                <div className="empty-footnote">
                  <span className="online-dot" />
                  Your collection stays on your PC
                </div>
              </div>
            )}
            {browsing && nextPage !== null && !catalogError && (
              <div className="catalog-more">
                <button className="button secondary" disabled={loading} onClick={() => setPage(nextPage)}>
                  {loading ? 'Loading more anime…' : 'Load more anime'} <ArrowRight size={16} />
                </button>
              </div>
            )}
          </section>
          <footer className="page-footer">
            <span>Less scrolling. More stories.</span>
            <span>
              YOUR FILES. YOUR CINEMA. <Moon size={13} />
            </span>
          </footer>
        </main>
      </div>
      {guide && (
        <LibraryGuide
          directory={library?.mediaDirectory || './media'}
          scanning={scanning}
          onScan={() => load(true)}
          onClose={() => setGuide(false)}
        />
      )}
      {torrentManager && <TorrentManager onClose={() => setTorrentManager(false)} onChange={load} />}
      {selected && (
        <Suspense
          fallback={
            <div className="toast" role="status">
              Opening player…
            </div>
          }
        >
          {selected.title.source === 'catalog' ? (
            <CatalogWatch
              title={selected.title}
              initialEpisode={selected.episode}
              progress={preferences.progress}
              onProgress={preferences.saveProgress}
              onRemember={preferences.rememberTitle}
              onClose={() => setSelected(null)}
            />
          ) : (
            <Player
              title={selected.title}
              initialEpisode={selected.episode}
              progress={preferences.progress}
              onProgress={preferences.saveProgress}
              onClose={() => setSelected(null)}
            />
          )}
        </Suspense>
      )}
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
          <button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice('')}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
