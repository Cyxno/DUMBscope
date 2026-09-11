# Media Library Intelligence

DUMBscope's content-level observability layer. Instead of only reporting that
Sonarr/Radarr/Bazarr are healthy, the Library answers: what's missing, what's
incomplete, what's queued, what can be upgraded, where subtitles are lacking,
and which service causes the most open issues.

Strictly **read-only** — the feature never triggers searches, downloads,
deletions or monitoring changes (brief §2/§107).

## Sources (audited against the real running stack)

| Service  | Version at audit | Endpoints used (all GET)                                                                                                                                               |
| -------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sonarr   | 4.0.19           | `/api/v3/series`, `/api/v3/wanted/missing` (paged, `includeSeries=true`), `/api/v3/wanted/cutoff` (count), `/api/v3/queue`, `/api/v3/health`, `/api/v3/calendar`       |
| Radarr   | 5.x              | `/api/v3/movie`, `/api/v3/wanted/missing` (paged, **without** `includeSeries` — Radarr rejects it), `/api/v3/wanted/cutoff` (count), `/api/v3/queue`, `/api/v3/health` |
| Bazarr   | 1.x              | `/api/system/status`, `/api/badges`, `/api/movies`, `/api/series`, `/api/movies/wanted`, `/api/system/languages` (all paged where supported)                           |
| Prowlarr | —                | not used by Library v1 (reserved for indexer context)                                                                                                                  |

The `includeSeries` parameter is **Sonarr-only**: Radarr returns HTTP 400 for
unknown query params. This asymmetry is encoded in `ArrBaseClient.wantedMissing`
and regression-tested (`tests/library-media.test.ts`).

## Metrics: exact vs derived (§53)

| Metric                    | Provenance   | Source                                                                                      |
| ------------------------- | ------------ | ------------------------------------------------------------------------------------------- |
| Missing episodes (TV)     | exact        | `wanted/missing.totalRecords` — monitored, released, no file                                |
| Missing movies            | exact        | `wanted/missing` records filtered to `isAvailable === true`                                 |
| Upcoming (TV/movies)      | exact        | series `totalEpisodeCount − episodeCount` / movies with `isAvailable === false`             |
| Upgrades available        | exact        | `wanted/cutoff.totalRecords` — presented neutrally, never as a warning (§42)                |
| Queue items/issues        | exact        | `/queue` records + `trackedDownloadStatus`                                                  |
| Health warnings           | exact        | `/health` entries per service                                                               |
| Subtitle gaps             | exact        | Bazarr `/api/badges` (episodes + movies)                                                    |
| Completion %              | **derived**  | see formula below                                                                           |
| Backlog age buckets       | **derived**  | release/air date → `<24h / 1–7d / 7–30d / 30d+` (released items only, future excluded)      |
| Subtitle coverage %       | **derived**  | per language: `(required − missing) / required` over monitored movies                       |
| "Waiting for acquisition" | **inferred** | missing + no queue entry + no recent search — shown only when all evidence agrees (§23/§24) |

## Completion formula (§14/§15)

```
completion % = (released monitored items − monitored missing) / released monitored items × 100
```

- TV: `released monitored` = Σ `statistics.episodeCount` over monitored series
  (aired episodes; future episodes never count).
- Movies: `released monitored` = monitored movies with `isAvailable !== false`.
- Known conservative edge case: a series' unmonitored aired episodes are
  included in the denominator (aggregate statistics do not split them), which
  can only make completion look slightly _worse_, never better.
- Example: `98.7% complete · 26 released episodes missing` — the ratio gives
  scale, the absolute count gives the work list.

## Backlog age (§12/§13)

Missing items are bucketed by release/air date: `<24h`, `1–7d`, `7–30d`,
`30d+`. Future items are excluded from buckets entirely and shown as
`Upcoming` — missing ≠ future.

## Attention model (§39–§43)

Explicit rules, ranked by severity:

| Severity        | Meaning                | Examples                                                  |
| --------------- | ---------------------- | --------------------------------------------------------- |
| `issue`         | operational failure    | failed imports, queue errors, integration health warnings |
| `attention`     | needs a human decision | missing > 30 days                                         |
| `backlog`       | normal library debt    | plain missing counts, upgrades                            |
| `informational` | context                | trends                                                    |

**Missing ≠ incident.** A 26-episode backlog is a normal library state and
never enters the Incidents page. Incidents remain reserved for operational
failures (unreachable API, auth failures, repeated import failures).
**Upgrades ≠ warning** — rendered with neutral/accent styling.

## API (§46–§48)

| Endpoint                                                   | Purpose                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /api/library?window=7\|30\|90`                        | bounded overview: summary, queue groups, attention, trends, availability |
| `GET /api/library/tv/missing?limit&offset&sort&filter`     | paginated missing episodes (limit ≤ 100)                                 |
| `GET /api/library/movies/missing?limit&offset&sort&filter` | paginated missing movies                                                 |
| `GET /api/library/subtitles/missing?limit&lang&q`          | paginated subtitle gaps                                                  |
| `GET /api/library/queue?filter=all\|tv\|movies\|issues`    | combined Sonarr/Radarr queue                                             |

Sorts: `most | oldest | recent | name` (missing lists), validated server-side.
The browser never calls Sonarr/Radarr/Bazarr directly — everything is served
from the pollers' in-memory cache (§49).

## Poll frequencies (§50)

| Data                          | Interval          |
| ----------------------------- | ----------------- |
| queue                         | 15 s (existing)   |
| library totals + missing list | 10–15 min         |
| wanted/cutoff counts          | 15 min (existing) |
| Bazarr coverage               | 15 min            |
| version probes                | 60 min            |

Worst-case request budget with Sonarr + Radarr + Bazarr configured: ~
0.2 requests/second sustained, well inside any service's limits. Failure
isolation: a broken Bazarr degrades only the Subtitles tab (§68/§70).

## Storage (§17/§18/§80–§82)

Migration 4 adds `media_snapshots(at, kind, missing, upgrades, total,
available, gaps)` — aggregates only, never a library dump. Hourly capture
(3 rows/hour) ≈ 26k rows / ~2–3 MB per year; retention prunes rows older than
90 days, so steady state stays well under 1 MB. Additive migration; fresh and
upgrade paths are migration-tested.

## UI

- `Library` page in the MONITOR nav group: tabs `Overview / TV / Movies /
Subtitles / Queue`, URL state (`/library?view=tv`), server-paginated lists.
- Overview gains a compact Library card (completion + backlog numbers) that
  only renders when a deep integration is available.
- Pipeline cards show one library metric per service (§84) when the data
  exists.
- Service drawer shows library numbers for Sonarr/Radarr (missing/upgrades/
  queue) and Bazarr (gaps/coverage).
- Not-configured services get partial functionality + a Settings CTA — the
  Library page never blocks (§69/§70/§98).

## Limitations

- Subtitle per-language coverage is computed over **movies**; per-episode
  language coverage would need per-series episode fetches (N+1) and is
  deferred (§59).
- "Missing since" is not exposed by the APIs; backlog age uses release/air
  date as a proxy and is labeled `derived`.
- Trends require accumulated snapshots; a fresh install shows a notice until
  enough data exists (§97).
