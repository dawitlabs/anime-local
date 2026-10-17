# Deployment scope

Yoru is a personal PC application. It binds to loopback by default and has no account or authentication system. Enabling a LAN bind gives everyone who can reach it control over the library, torrent sources and their cache. For remote access, use an authenticated VPN. A reverse proxy needs both HTTPS authentication and a correctly configured origin policy; this repository does not ship that deployment.

Torrent connections originate from the host PC. Peers and trackers can see its network address. The engine does not automatically configure UPnP/NAT-PMP router mappings. Private tracker credentials may be present in `data/torrents/library.json`; keep the entire data directory private and out of Git.

Sources accept magnet links and bounded torrent-file uploads. Arbitrary local paths, HTTP source URLs, magnet HTTP metadata references and web seeds are not accepted as video sources. File paths and source size are checked before cached pieces are read or written. The FFmpeg bridge is loopback-only with an unpredictable per-process path, and FFmpeg input protocols are restricted. These are application boundaries, not a sandbox for FFmpeg; keep Node, FFmpeg and dependencies current.

# Dependency review: 2026-10-17

`npm audit` reports four high-severity package entries along one dependency chain: `webtorrent` → `torrent-discovery` → `bittorrent-tracker` → `ip`. They refer to [GHSA-2p57-rm9w-gvfp](https://github.com/advisories/GHSA-2p57-rm9w-gvfp), incorrect public-address classification by `ip.isPublic`.

The installed `bittorrent-tracker` 11.2.3 imports `ip` in its tracker **server** UDP parser and calls `toString`; Yoru runs the torrent **client**, and neither Yoru nor that dependency calls `ip.isPublic`. Yoru does not rely on that function for access control. This assessment limits the reachable advisory path; it is not a claim of an audit-clean dependency tree. There is no patched `ip` version recommended by the audit. Its proposed forced WebTorrent downgrade is not applied because it would replace the current engine with an obsolete incompatible version.

Reassess this advisory when upgrading the torrent stack. Run `npm audit` yourself before deploying changes.
