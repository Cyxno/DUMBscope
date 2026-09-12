# Unified Library Manager (Library Browser)

DUMBscope's item-level media library browser, on top of the existing Library
Intelligence layer. Library Intelligence answers _how much_ is missing or
incomplete; the Library Browser answers _which_ series, seasons, episodes,
movies, qualities, files and subtitle gaps exactly.

Strictly **read-only**: no search, grab, monitor, delete, quality-profile,
queue or subtitle actions are exposed anywhere (§1/§2/§127). Every upstream
call is a GET.

## Architecture

```
Sonarr ──browse poller──▶ ┌────────────────────────────┐
Radarr ──browse poller──▶ │ integration manager cache  │◀── reads ── DUMBscope API
Bazarr ──browse poller──▶ │ (normalized browse models) │            (/api/library/*)
                          └────────────────────────────┘            ▲
Sonarr ──lazy per-series episodes──▶ TTL cache (10 min)  ──────────┘
Bazarr ──lazy per-series episodes──▶ TTL cache (15 min)  ──────────┘
Sonarr/Radarr MediaCover ──▶ /api/library/poster/[key] proxy ──▶ <img>
```

- **Pollers** (`src/lib/server/integrations/media.ts`): one bulk request per
  service every 10–15 min builds the whole inventory cache. Browser requests
  never trigger upstream calls (§79).
- **Lazy detail** (`browse.ts`): clicking a series triggers at most **one**
  Sonarr episode request + **one** Bazarr episode request, both behind a
  bounded TTL cache (60 series, 10/15 min) — never N+1 (§75/§80/§172).
- **UI** (`src/lib/components/library/`): TV / Movies / Subtitles browsers +
  detail drawers. Components see only normalized shapes (§55).

## Sources (audited against the live stack)

| Service | Version at audit | Browse endpoints used (all GET)                                                                                                                                                                    |
| ------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sonarr  | 4.0.19           | `/api/v3/series` (+ `/qualityprofile`), `/api/v3/episode?seriesId=X&includeEpisodeFile=true`, `/api/v3/history`, `/api/v3/calendar`, `/api/v3/MediaCover/{id}/poster.jpg`                          |
| Radarr  | 6.3.0            | `/api/v3/movie` (+ `/qualityprofile`, file embedded incl. `qualityCutoffNotMet`), `/api/v3/history?movieId=`, `/api/v3/MediaCover/{id}/poster.jpg`                                                 |
| Bazarr  | 1.6.0            | `/api/series`, `/api/movies`, `/api/episodes?seriesid[]=X` (**bracket param spelling**), `/api/system/languages`, `/api/system/languages/profiles`, `/api/movies/history`, `/api/episodes/history` |

Audit notes encoded in the code:

- Sonarr's `/api/v3/history` **ignores** a `seriesId` filter — and Radarr
  6.3.0's `movieId` filter **returns unrelated movie ids** (verified live,
  §189 class bug). Item history therefore always fetches one bounded page
  (100 records) and filters by the upstream id server-side.
- Sonarr's `/api/v3/wanted/cutoff` **ignores** a `seriesId` filter; per-series
  upgrade counts therefore come from the lazy episode fetch
  (`episodeFile.qualityCutoffNotMet`, upstream's own computation).
- The legacy unauthenticated `/MediaCover/...` path exists on both Arrs but is
  deliberately **not** used; the proxy always authenticates (§63).
- Bazarr's `/api/history` is a frontend route (HTML), the real endpoints are
  `/api/{episodes,movies}/history`.

## API (§56)

All authenticated (session cookie), all GET, all bounded.

| Endpoint                                            | Purpose                                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/api/library/tv`                                   | Series inventory: `q`, `filter`, `sort`, `offset`, `limit` (≤100) + header totals + upcoming |
| `/api/library/tv/[key]`                             | Series detail: metadata + per-season counts                                                  |
| `/api/library/tv/[key]/episodes`                    | Lazy per-series episodes with quality/file/queue/subtitle overlays                           |
| `/api/library/movies`                               | Movie inventory: same param contract + upgrades/missing filters                              |
| `/api/library/movies/[key]`                         | Movie detail: file, queue, subtitles, bounded history                                        |
| `/api/library/subtitles`                            | Subtitle browser: header, languages, profiles, movies/series rows                            |
| `/api/library/subtitles/tv/[key]`                   | Per-episode subtitle states for one series                                                   |
| `/api/library/poster/[key]`                         | Poster proxy (see below)                                                                     |
| `/api/library` (+ existing missing/queue endpoints) | Library Intelligence v1 — unchanged                                                          |

`[key]` is the stable composite id (`sonarr-series-3`, `radarr-movie-9`,
§61). Unknown keys → `400`; stale deep links to deleted items → `404` with
"This item is no longer in the library." (§129/§130).

Param validation (§59/§60/§128): filters/sorts are allowlisted, `limit`
defaults 50 / caps 100, `offset` caps 10k, `q` is trimmed and capped at 80
chars. No arbitrary query logic is passed upstream.

## Item semantics

| State                        | Meaning                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------- |
| Available                    | Upstream `hasFile` (episode/movie file exists)                               |
| Missing                      | Released + monitored + no file — from Sonarr/Radarr, never derived (§112)    |
| Future / Upcoming            | Not yet aired / `isAvailable === false` — **never** counted as missing (§19) |
| Downloading/Queued/Importing | Active queue entry correlated by **upstream id** only (§115)                 |
| Upgrade available            | `qualityCutoffNotMet` from the upstream file object only (§114)              |
| Not monitored                | `monitored === false` — calm neutral state (§23)                             |
| Subtitle gap                 | Bazarr's own `missing_subtitles` (wanted-but-absent, §47)                    |

Completion percentages reuse the Library Intelligence caches so the Overview
and the browsers can never disagree (§3). Series-level "missing" is Sonarr's
own series math (`episodeCount − episodeFileCount`), which includes unmonitored
aired episodes exactly like Sonarr's UI does.

## Cross-service correlation (§62)

- Sonarr series id ↔ Bazarr `sonarrSeriesId`; Sonarr episode id ↔
  Bazarr `sonarrEpisodeId`; Radarr movie id ↔ Bazarr `radarrId`.
- Queue items carry `seriesId`/`episodeId`/`movieId` from the upstream queue
  records. **No title matching anywhere.**

## Posters (§7/§63/§64)

`/api/library/poster/[key]` proxies Sonarr/Radarr `MediaCover` artwork:

- accepts only ids that exist in the cached inventory — no open proxy, no
  arbitrary URLs, and the upstream API key never reaches the browser;
- validates `content-type: image/*`, caps responses at 8 MB, times out at 8 s;
- bounded in-memory cache (80 images) + `ETag` from the MediaCover
  `lastWrite` + `Cache-Control: private, max-age=86400` + 304 revalidation;
- image tags authenticate with the normal session cookie (same-origin);
- failures fall back to an initials tile in the UI (§65).

## Caching & failure behavior (§78-§82)

| Data               | Freshness                                         |
| ------------------ | ------------------------------------------------- |
| TV/movie inventory | polled 10 min, TTL 30 min, stale-flag > 15 min    |
| Bazarr coverage    | polled 15 min, TTL 15 min                         |
| Lazy episodes      | TTL 10 min (Sonarr) / 15 min (Bazarr), ≤60 series |
| Posters            | browser 24 h + in-memory + ETag                   |
| History (detail)   | fetched on drawer open, bounded 10 events         |

- Sonarr down → TV grid keeps showing the last inventory with a "data last
  updated X ago" note; Movies/Subtitles keep working (§81/§82).
- Bazarr down → TV/Movies work without subtitle detail (§82).
- Unconfigured service → dedicated empty state pointing at Settings
  (§83/§84).

## URL state & deep links (§66-§70/§134-§138)

- `/library?view=tv&filter=missing` → series with missing episodes
  (`filter=missing` maps to the Incomplete chip; the exact episode list is in
  the "Missing episode backlog" panel below the browser).
- `/library?view=movies&filter=missing` → missing movies.
- `/library?view=tv&item=sonarr-series-3` → opens the series drawer with a
  canonical URL; browser back closes it (§70/§135).
- `/library?view=subtitles&sbmode=tv&sbfilter=has-gaps` → subtitle gap drill.
- Overview cards link "Which episodes/movies? →" straight into the filters;
  service drawers link "Open TV/Movie/Subtitle Library →"; the command
  palette has Browse TV / movies / subtitle gaps entries (§66-§68).

## Known limitations (real ones only)

- Series-level upgrade counts appear after the lazy episode load (Sonarr does
  not expose per-series cutoff totals cheaply); movie upgrades are exact
  everywhere.
- Per-language subtitle coverage is exact for movies; episode-level
  per-language totals would require walking every series, so the Languages
  view shows movie gaps exactly and total episode gaps only.
- Series detail history filters a bounded recent window — a very quiet
  series' last event may be older than the window and show no activity.
- Poster proxies are cached per DUMBscope process (not persisted); after a
  restart the first view refetches from the Arrs.
- Unmonitored series' episodes still count toward the series-level missing
  math (upstream's own definition — kept deliberately for Sonarr-UI parity).

## Testing

`tests/library-browse.test.ts` covers normalization of every audited upstream
shape, the no-false-states matrix (future ≠ missing, upgrade only from
`qualityCutoffNotMet`, unmonitored ≠ missing), id-only queue correlation,
filter/sort behavior, pagination boundaries (0/1/50/100/beyond-end), param
validation and the exact query-shape of the lazy client endpoints (including
Bazarr's `seriesid[]` spelling).
