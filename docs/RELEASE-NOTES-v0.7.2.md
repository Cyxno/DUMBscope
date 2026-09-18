# Release Notes — v0.7.2

## feat(reconciliation): deterministic library reconciliation (FASE D)

Read-only verification that what Sonarr/Radarr and Plex *claim* is
actually true on the filesystem, with findings flowing into the incident
engine via stateless open/close deltas.

- Per-item classification: `arr-file-missing`, `broken-symlink`,
  `plex-ghost`, `plex-stale`, `backend-unavailable`, `mount-unverifiable`.
- Plex library parts are read from a throwaway snapshot copy of the Plex
  DB (`node:sqlite`) — the original database is never opened.
- Cadence: one cycle per 30 minutes plus a post-restart verification
  cycle; Sonarr fetching is capped (max 400 series, concurrency 8).
- **Error isolation**: one unreachable Arr degrades only its own
  integration (bounded exponential backoff, deduped degraded incident);
  it never crashes the process.

## Ships with the reliability fixes from v0.7.1

The reconciliation line carries the fsprobe worker-leak fix (probe
workers reclaimed on every round exit path) and adds identity-safe
cleanup for its own long-lived prober worker (a stale worker's exit can
no longer kill its replacement mid-op).

## Operational note (rollout)

Reconciliation is **enabled by default** (`reconciliation.enabled`) and
uses the existing mount targets. Set `reconciliation.enabled=false` in
settings to keep it off; the Plex dimension stays inactive until
`reconciliation.plexDbPath` is configured.
