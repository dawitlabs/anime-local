# Deployment scope

Yoru is a personal PC application. It binds to loopback by default and has no account or authentication system. Enabling a LAN bind gives everyone who can reach it control over the library, torrent sources and their cache. Hostnames are restricted to localhost, numeric IPs and explicit `ALLOWED_HOSTS` to reject DNS rebinding through arbitrary domains. For remote access, use an authenticated VPN. A reverse proxy needs both HTTPS authentication and a correctly configured origin policy; this repository does not ship that deployment.

Torrent connections originate from the host PC. Peers and trackers can see its network address. The engine does not automatically configure UPnP/NAT-PMP router mappings. Private tracker credentials may be present in `data/torrents/library.json`; keep the entire data directory private and out of Git.

Sources accept magnet links and bounded torrent-file uploads. Arbitrary local paths, HTTP source URLs, magnet HTTP metadata references and web seeds are not accepted as video sources. File paths and source size are checked before cached pieces are read or written. The FFmpeg bridge is loopback-only with an unpredictable per-process path, and FFmpeg input protocols are restricted. These are application boundaries, not a sandbox for FFmpeg; keep Node, FFmpeg and dependencies current.

Catalog search and episode discovery contact the configured third-party providers from the host PC. Artwork loads from HTTPS image hosts in catalog metadata. Source responses only supply validated v1 hashes, file indexes/names and bounded tracker lists; arbitrary provider video URLs are ignored. Provider requests have deadlines, response-size limits and bounded caches. Provider base URLs are host configuration, not viewer-controlled input. Browsing does not start torrent downloads; Play does. The site cannot promise that all catalog entries have available sources.

# Dependency review: 2026-10-17

`npm audit` reports four high-severity package entries along one dependency chain: `webtorrent` → `torrent-discovery` → `bittorrent-tracker` → `ip`. They refer to [GHSA-2p57-rm9w-gvfp](https://github.com/advisories/GHSA-2p57-rm9w-gvfp), incorrect public-address classification by `ip.isPublic`.

The installed `bittorrent-tracker` 11.2.3 imports `ip` in its tracker **server** UDP parser and calls `toString`; Yoru runs the torrent **client**, and neither Yoru nor that dependency calls `ip.isPublic`. Yoru does not rely on that function for access control. This assessment limits the reachable advisory path; it is not a claim of an audit-clean dependency tree. There is no patched `ip` version recommended by the audit. Its proposed forced WebTorrent downgrade is not applied because it would replace the current engine with an obsolete incompatible version.

Reassess this advisory when upgrading the torrent stack. Run `npm audit` yourself before deploying changes.
