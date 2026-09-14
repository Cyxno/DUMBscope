# Media correlation (DEEL 2)

How DUMBscope answers "why is this item missing again?" by correlating the
same media item across Sonarr/Radarr, the acquisition paths (InfiniDysk and
Decypharr as seen from the Arr boundary), and storage. Observe and correlate
first — remediation lives in [REMEDIATION.md](./REMEDIATION.md) and is
recommendation-only.

---

## The production complaint, investigated read-only (2026-09-14)

"InfiniDysk lijkt soms films/series opnieuw als missing op te pakken terwijl
Sonarr/Radarr het item al kent en Decypharr de acquisition al heeft geaccepteerd."

### What the real stack actually shows

Read-only audit of the live instances (Sonarr 4.0.19 and Radarr 6.3.0 inside
the DUMB container; InfiniDysk's own SQLite history; DUMB config):

- **Both Arrs have BOTH acquisition paths attached** as enabled download
  clients: `decypharr` (torrent; emulates qBittorrent) and `InfiniDysk`
  (usenet; emulates SABnzbd). Every grab in the Arr history names its client.
- **InfiniDysk's history is request-driven, not spontaneous.** Every
  InfiniDysk job carries the Arr's `downloadId` GUID (its `WatchdogEntries.
  ClickId` / `HistoryItems.ArrDownloadId`). Repeated jobs for one title show
  *different* GUIDs — the Arr genuinely re-offered the request; InfiniDysk
  executed both (e.g. Westworld S02E09: two jobs, 21 minutes apart, two
  different ArrDownloadIds).
- **The usenet path fails fast and often.** Real timelines from Sonarr:
  - Dark Matter S02E03 (09-11): **8 grabs via SABnzbd in ~30 minutes**, each
    `downloadFailed` within ~1 minute; the 9th grab — via qBittorrent —
    imported 60 seconds later.
  - S.W.A.T. S04E05: 7 SABnzbd grabs failed across two months (07-14, 07-28);
    the 09-13 SABnzbd grab imported 2 minutes later.
  - Lanterns S01E05: 3 qBittorrent grabs failed over 5 days; then two
    SABnzbd grabs (01:24 and 01:55) both imported, the second as an upgrade
    (with `episodeFileDeleted` for the first).
- **Successful propagation is fast**: grab → import is seconds to ~2 minutes
  on the healthy stack (S.W.A.T. S04E05: grab 00:17 → import 00:19).

### Root cause (evidence, high confidence)

1. The Arr keeps an item "missing" until a file is **imported** — not until
   an acquisition is accepted. While the usenet path fails quickly, the Arr's
   own search/retry logic re-grabs the same item, repeatedly, and both
   enabled clients compete for the offers.
2. The "InfiniDysk treats it as missing again" perception is therefore
   **upstream retry behaviour + dual-client competition**, not InfiniDysk
   spontaneously re-missing items. DUMBscope cannot and must not "fix" this —
   it belongs to the Arr's search settings and the failing acquisition paths.
3. What DUMBscope CAN do: detect the loop per stable item, attribute the
   acquisition path, correlate a sick storage mount into the picture
   (DEEL 1), and surface the evidence — see "Repeated acquisition request".

### Capability matrix (real endpoints only; nothing invented)

| State        | Sonarr/Radarr (`/api/v3/…`)                        | Decypharr                         | InfiniDysk                                   | Filesystem              |
| ------------ | -------------------------------------------------- | --------------------------------- | -------------------------------------------- | ----------------------- |
| Missing      | `wanted/missing` (episodeId/movieId)               | —                                 | —                                            | —                       |
| Requested    | `history` `grabbed` + `downloadId` + client        | observed as qBittorrent grab      | observed as SABnzbd grab                     | —                       |
| Accepted     | history grab = accepted at the boundary            | — (no authed API proven this run) | `WatchdogEntries.ClickId` = downloadId       | —                       |
| Downloading  | `queue` (status, trackedDownloadStatus)            | —                                 | —                                            | —                       |
| Importing    | `history` `downloadFolderImported` / queue state   | —                                 | —                                            | —                       |
| Available    | `hasFile` / leaves `wanted/missing`                | —                                 | —                                            | symlink sample (DEEL 1) |
| Mounted      | —                                                  | —                                 | —                                            | mount probes (DEEL 1)   |
| Failed       | `history` `downloadFailed`; queue `failure`        | —                                 | `HistoryItems.DownloadStatus=2`              | —                       |
| Retry/repeat | repeated `grabbed` per episode/movie               | —                                 | repeats per JobName/ContentGroupKey          | —                       |
| Stable ID    | episodeId/movieId ↔ `downloadId` GUID              | —                                 | ArrDownloadId GUID                           | path (bounded)          |

Decypharr's own DB/API was not integrable this run (no authenticated API
surface proven; its data files are not SQLite). Its state is observed through
the Arr boundary (qBittorrent-emulated client events) — which is sufficient
for the correlation this phase needs. No endpoint names were invented.

---

## Identity model

Priority (brief §10):

1. Arr-native ids: `sonarr:<integrationId>:episode:<id>`,
   `radarr:<integrationId>:movie:<id>` — the instance namespace prevents
   multi-instance collisions (two Sonarr instances may reuse numeric ids).
2. Upstream request identity: the Arr `downloadId` GUID — one ledger row per
   (integration, downloadId); InfiniDysk carries the same GUID as
   `ClickId`/`ArrDownloadId`.
3. TMDB/TVDB ids (carried in library models for future use).
4. Normalized title/year: **never** used for matching — titles are display
   only.

## Normalized flow model

Per item, per source, an observation: `{ source, state, observedAt,
confidence, evidence }` (`MediaFlowState`: missing/requested/accepted/queued/
downloading/importing/mounted/available/indexed/failed/unknown). The raw
per-source states are always kept and shown in detail; the UI summary is
derived with the precedence failed > importing > downloading >
acquiring > available > missing (brief §14) — and **acquisition-active
overrides plain missing**: Sonarr "missing" + a recent accepted grab shows as
**Acquiring** (brief §15).

## Duplicate detection

`same stable media key + a new grab + the previous request still active
(never imported) or completed within the 4-hour shield` → **Repeated
acquisition request** finding (per item, with firstSeen/lastSeen/request
count). A fresh acquisition long after a completed one is a normal new
request and is never flagged (brief §20). The repeat window comes from the
real evidence — repeats on this stack span 21 minutes to a few days, so the
ledger window is 72 hours with a 14-day ledger retention (§17/§21).
Late/out-of-order events can only move a row forward in state precedence
(completion survives a late failure frame); clock skew is treated
conservatively — timestamps come from one source (the Arr history) per row.

## Grace windows (measured, not arbitrary)

- Successful grab → import: seconds–2 min on the healthy stack → the
  **mismatch grace is 15 minutes**: only after that does "imported but still
  missing" become a `state-propagation-delay` warning (brief §23/§24).
- Grabbed-but-not-imported stays **Acquiring** for 30 minutes before a stale
  verdict is even considered.
- Transitional states are **never** incidents (brief §32); persistent
  mismatch + failures + an unhealthy mount escalate the classification to
  `mount-unavailable` with the DEEL-1 mount evidence attached (brief §26).

## Where it surfaces

- **System → Media state**: bounded metrics (repeated requests 24 h, active
  mismatches, grab→import median/p95) plus the attention items with their
  per-source observation lines.
- **Library item drawers**: a compact *Media flow* block appears only when a
  correlated flow exists (brief §28) — sources that don't exist are never
  rendered. Repeated-request items carry the "Repeated request detected"
  evidence line (brief §30).
- **Incidents**: findings use the existing engine with `media-repeat:` /
  `media-mismatch:` / `media-failing:` fingerprints. Normal propagation never
  opens one; only persistent mismatch or failing acquisitions do (§32/§33).

## Limitations

- Decypharr and InfiniDysk are observed at the Arr boundary, not from their
  internal queues; a claim accepted by Decypharr but never visible to the Arr
  is out of reach until an authenticated Decypharr API is configured.
- The ledger is deliberately small (few hundred KB): correlation memory for a
  72-hour window with 14-day retention — not a media database.
- The usenet/torrent attribution relies on the emulated client labels
  (SABnzbd / qBittorrent) configured in the Arrs; if a deployment renames
  them, attribution falls back to `other`.
