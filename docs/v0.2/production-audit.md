# v0.2 production audit — 2026-09-10

Read-only audit of the production DUMBscope v0.1.1 install and the real DUMB
stack it monitors. Evidence sources: production SQLite (read-only), DUMB's
public API, `dumb_config.json` + service data dirs (secrets redacted), and
today's DUMB runtime log. No assumptions from earlier conversations.

## Production state (DUMBscope)

- Image `ghcr.io/cyxno/dumbscope:0.1.1`, healthy, 0 restarts, ~0% CPU, ~31 MiB RSS.
- SQLite 86 KiB + WAL; tables: incidents(1), incident_events(1),
  health_transitions(0), service_events(0), sessions(1), users(1), settings(8).
- Setup completed; hub `connected` to the real gateway.

### v0.1.1 defects found by this audit

1. **Orphaned active incidents after restart.** The engine does not hydrate
   persisted incidents at boot (`reset()` only clears state; nothing loads the
   repository). Consequence: the row `dumb-credentials:9feb88cc…`
   ("DUMB credentials rejected") has been `active` since 2026-09-09 22:19 even
   though the hub reconnected hours ago — a standing false alarm on the
   incidents page. Fix in v0.2: hydrate active incidents into engine state at
   startup so they resolve naturally, plus resolve-on-rehydrate when the
   condition no longer holds.
2. **Activity feed is memory-only.** No `activity` table exists; every restart
   wipes the feed. v0.2 adds a persisted, classified activity store (§15/§16 of
   the brief).
3. **No per-service reliability history** (uptime/restart/incident rollups).

## Real stack (runtime evidence)

Subprocess log volume today (evidence of actually-running services):

| Process           | Log lines | Category            | DUMB port → host              |
| ----------------- | --------- | ------------------- | ----------------------------- |
| Seerr             | 3462      | request             | 5055 → 5055                   |
| Sonarr            | 927       | arr (TV)            | 8989 → 7854                   |
| Prowlarr          | 831       | indexer             | 9696 → 9696                   |
| InfiniDysk        | 164       | mount/storage       | 8282 → 8282                   |
| Radarr            | 125       | arr (movies)        | 7878 → 7878                   |
| Plex Media Server | 105       | media-server        | 32400 → 32400                 |
| Decypharr         | 89        | debrid              | 8181 → 8181                   |
| DUMB Frontend     | 86        | core                | 3005 → 3005                   |
| Tautulli          | 21        | analytics           | internal (not host-published) |
| Bazarr            | 20        | utility (subtitles) | 6767 → 6767                   |

Config confirms `enabled=true` for decypharr, infinidysk, plex, tautulli,
bazarr; everything else disabled or zero instances (no Jellyfin, no Emby, no
PostgreSQL service, no Lidarr/Whisparr/Riven/Zurg instances).

Notable config facts:

- Several DUMB service types are **instance-based** (`sonarr.instances`,
  `radarr.instances`, `prowlarr.instances`, `seerr.instances`, …). The current
  file has one implicit instance each, but the model must be ID-based (brief
  §65).
- Service API keys are server-side discoverable from per-service config
  (`data/<service>/default/config.xml` for the *Arrs; Plex token lives in
  `dumb.plex_token`; Tautulli/Seerr/Decypharr keep their own config stores).
  v0.2 Settings will offer explicit per-integration connection + key entry,
  with masked replace-only UX; auto-discovery is a server-side read that the
  user confirms, never silent harvesting.
- InfiniDysk keeps its own `db.sqlite` + `metrics.sqlite` and performs segment
  repair on mounted content (log evidence) — rich integration target.
- Tautulli ships its API docs locally (`API.md`) and monitors Plex.

## Dependency map (evidence-based)

```
REQUESTS            ACQUISITION                STORAGE               MEDIA
Seerr ──hard──► Sonarr ──soft──► Prowlarr
  │             │
  │             └──hard──► Decypharr ──data──► InfiniDysk ──data──► Plex
  │             │                                          │
  └─observed──► └──────────── Bazarr ──soft───────────────┘
                                                    Tautulli ──data──► Plex
```

| Edge                   | Type       | Source   | Confidence | Evidence                                                               |
| ---------------------- | ---------- | -------- | ---------- | ---------------------------------------------------------------------- |
| Seerr → Sonarr         | hard       | config   | 0.9        | Seerr request routing; verified via Seerr API in beta                  |
| Seerr → Radarr         | hard       | config   | 0.9        | idem                                                                   |
| Seerr → Plex           | data-flow  | observed | 0.8        | "Plex Watchlist Sync" + "Plex Recently Added Scan" jobs in today's log |
| Sonarr → Prowlarr      | soft       | adapter  | 0.7        | indexer sync semantics; confirm via Arr API in beta                    |
| Radarr → Prowlarr      | soft       | adapter  | 0.7        | idem                                                                   |
| Sonarr → Decypharr     | hard       | config   | 0.8        | download client; Decypharr `arrs` config section                       |
| Radarr → Decypharr     | hard       | config   | 0.8        | idem                                                                   |
| Decypharr → InfiniDysk | data-flow  | observed | 0.6        | debrid → mount pipeline; confirm in beta                               |
| InfiniDysk → Plex      | hard       | observed | 0.8        | InfiniDysk repairs `/content/tv/...` media files Plex serves           |
| Bazarr → Sonarr/Radarr | soft       | adapter  | 0.7        | subtitle sync semantics                                                |
| Tautulli → Plex        | data-flow  | config   | 0.9        | Tautulli monitors Plex                                                 |
| All → DUMB             | management | dumb     | 1.0        | DUMB spawns/supervises every subprocess                                |

Every edge carries `type`/`source`/`confidence` internally (brief §2); the UI
shows edge style differences without a color circus.

## Integration priority (value ÷ effort, real stack)

1. **Sonarr** — v3 API, key discoverable, highest user value.
2. **Radarr** — same shared `ArrBaseClient`, near-free after Sonarr.
3. **Plex** — sessions/direct-play/transcode card; token available server-side.
4. **Prowlarr** — indexer health, feeds dependency evidence for the arrs.
5. **Seerr** — request pipeline; completes the request→acquisition story.
6. **Tautulli** — richer Plex sessions/history where Plex alone is weaker.
7. **InfiniDysk** — highest structural value (mount/storage), but custom app:
   API surface researched in beta before committing.
8. **Decypharr** — queue/repair visibility; logs + config verified, API probed
   in beta.
9. **Bazarr** — stays generic DUMB monitoring unless cheap to add.

## Incidents v0.2 (grounded in this stack)

Candidates that make sense here: `arr_queue_stalled`, `arr_import_failed`,
`indexer_degraded`, `media_server_unreachable`, `mount_unavailable`
(InfiniDysk), `download_pipeline_stalled` (Seerr→arr→Decypharr chain),
`telemetry_stale`, `stream_disconnect`, `high_resource_usage`, `disk_near_full`.
Each rule: explainable evidence list, throttled, severity tied to actual impact.
