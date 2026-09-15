# DUMBscope Compatibility

Support matrix for the services DUMB can manage. This document is **generated
from code**: the table below is rendered from
`src/lib/shared/service-capabilities.ts` and a unit test
(`tests/service-capabilities.test.ts`) fails when the docs drift from it.

## Support levels

- **Discovery** — DUMBscope recognises the service/instance from DUMB's
  process registry and renders its canonical name, icon, category and
  pipeline stage.
- **Basic monitoring** — running/stopped state, process identity, CPU/memory,
  logs.
- **Operational monitoring** — service-specific health semantics, incidents
  and findings, meaningful diagnostics. Findings feed the notification layer.
- **Deep integration** — native API/domain data: Library browsers (TV,
  movies, subtitles), missing/upgrades/queue, media-flow correlation.
- **Remediation** — safe service-level recovery through DUMB's own
  `restart-service` management route (never a container restart; guarded by
  confirmation, cooldowns and attempt caps).
- **Contract tested** — behavior verified against the central registry
  fixture (`tests/fixtures/services/dumb-registry.json`, mirrored from a
  live DUMB v2.22.x install) and the pipeline/catalog suites.
- **Real tested** — verified against the real, running instance on the
  reference stack (DUMB v2.22.x with 11 enabled services, all healthy).

## Reading the table

✅ supported · — not applicable / not implemented. A dash under
**Deep integration** means DUMBscope still gives the service full generic
monitoring but has no native API integration — the claim is deliberately
honest rather than optimistic. Services marked _not managed by the current
DUMB config surface_ are in the catalog for robust matching only.

## Matrix

<!-- BEGIN GENERATED COMPATIBILITY TABLE -->
| Service | Discovery | Basic monitoring | Operational | Deep integration | Remediation | Contract tested | Real tested |
|---|---|---|---|---|---|---|---|
| DUMB Frontend | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| DUMB API | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| Sonarr | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Radarr | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Lidarr | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Readarr | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Whisparr | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Bazarr | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Prowlarr | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| Jackett | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Decypharr | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| NZB Dav | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| AltMount | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| CLI Debrid | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| SABnzbd | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| NZBGet | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| rclone | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| InfiniDysk | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| Zurg | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| CLI Battery | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| PostgreSQL | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| MySQL | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| pgAdmin | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Phalanx DB | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Plex | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| Jellyfin | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Emby | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Seerr | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| Seerr Sync | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Pulsarr | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Tautulli | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| Kometa | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Maintainerr | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| AIOStreams | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| MediaStorm | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Riven | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Neutarr | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Profilarr | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Zilean | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Symlink Manager | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Traefik | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Traefik Proxy Admin | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Authelia | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
| Cloudflared | ✅ | ✅ | ✅ | — | ✅ | ✅ | — |
<!-- END GENERATED COMPATIBILITY TABLE -->

## Multi-instance

DUMB manages multiple instances per service (`sonarr.instances`). Every
instance is rendered separately with its instance qualifier (e.g. `Radarr
4K`), duplicate canonical names are always disambiguated, and disabled
instances never render as running.

## Known limitations

- Services without a native adapter show **Running (unverified)** instead of
  a fabricated health state — DUMBscope never invents health.
- Deep integration for Jellyfin/Emby/Lidarr/Readarr/Whisparr is not
  implemented; they receive full basic + operational monitoring.
- Catalog coverage mirrors the current DUMB config surface; services DUMB
  does not know are out of scope.
