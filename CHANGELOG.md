# Changelog

All notable changes to DUMBscope are documented here. Releases follow
[semver](https://semver.org/); database migrations are additive, versioned and
run transactionally on startup.

## [0.9.0] — 2026-09-23

Deep DUMB-stack observability: DUMBscope becomes the central technical
observability layer for the DUMB container (cgroup memory, per-service memory
classification, InfiniDysk internals, download routing, thermal correlation,
a combined incident timeline and version awareness). Observation-first, as
always: nothing in this release sends notifications — external alerting
(Hermes/Telegram) stays the single alerting path.

### Added

- **DUMB cgroup memory analysis (v2)** — applications/anon vs reclaimable file
  cache vs shared/tmpfs vs kernel breakdown; `memory.current/high/max/peak`;
  rate-based interpretation flags (soft-limit reclaim, hard-limit hits,
  pressure via `pgscan_direct`/file refaults, OOM/OOM-kill). A high
  `memory.current` alone is never rendered as a problem. Sources, in order:
  a read-only cgroupfs mount (`DUMBSCOPE_DUMB_CGROUP_PATH`, or
  `DUMBSCOPE_DUMB_CGROUP_PARENT` + container id resolved via Prometheus), with
  an optional Prometheus/cadvisor fallback (`DUMBSCOPE_PROMETHEUS_URL`).
  Samples persist 1/minute with 5m/30m rollups (26h/7d/30d retention).
- **Per-service memory observability** — for every managed service: RSS,
  threads, CPU, honest uptime (from DUMB's `start_time`), version, 1h/6h/24h
  deltas, 24h p50/p95 baseline, lagged 7-day baseline and a deterministic
  classification: `stable`, `elevated plateau`, `workload-driven`,
  `sawtooth/GC`, `possible leak`, `insufficient history`. A high but flat
  process is explicitly *not* a leak.
- **Baseline shift detection** — trailing 24h p50 vs lagged days-2..7 p50;
  reports old → new baseline, the percentage, when the shift started and the
  direction (`rising` / `plateau` / `declining`).
- **InfiniDysk / NzbWebDAV observability** — fed from the existing log stream:
  repair starts 1h/24h with an active-repair state, per-file repair loops
  (1h/24h counts, last error, recurrence over days), `430 No Such Article`
  counts, missing/unavailable segments (incl. suppressed rollups), provider
  fallbacks, GC heap hard limit, base NZBDAV version, mount state, restarts.
- **Sonarr/Radarr stack observability** — queue, blocklist, history totals,
  DB size proxy (scheduled backups), uptime, version, 24h
  grabs/imports/failures, RSS-sync and search activity (new 5-min poller).
- **Download routing statistics** — 24h grabs/imports/failures per download
  client (Decypharr vs InfiniDysk vs …) with success rates, client
  priorities, a **primary** badge and the Arr-preferred protocols (new 10-min
  poller).
- **Thermal correlation** — host thermal zones (readable in-container),
  90/95/100 °C spike detection with 5 °C recovery hysteresis and a correlation
  snapshot (temperature, host load, DUMB CPU, top services, InfiniDysk repair
  state). Limited scope by design; no causality claims.
- **Combined incident timeline** — restarts, health transitions, memory
  anomalies, repair loops, mount failures, OOM, cgroup high/max movements,
  thermal spikes, deploys and download failures in one merged feed
  (`observability_events`, 30-day retention + 20 000-row cap).
- **Version/update awareness** — current version, update status/available
  version, auto-update/pinned policy and "this version since" per service;
  InfiniDysk's pinned runtime (does not follow `DUMB:latest`) is explicit.
  Deploy events land on the timeline when registry versions change.
- **UI** — new *Observability* page (nav group Monitor): headline tiles (DUMB
  memory state, anon vs cache, thermal, InfiniDysk), cgroup breakdown +
  history chart, per-service classification table with shift annotations,
  InfiniDysk card with repair-loop table, routing table, Arr stack cards,
  thermal chart + last-spike snapshot, versions table and the timeline.
  Compact new *DUMB observability* overview widget (orderable/hideable) and a
  memory-baseline block in the service drawer.
- **API** — `GET /api/observability`, `/api/observability/history`,
  `/api/observability/timeline` and a signature-diffed SSE `observability`
  event (replayed on connect).

### Changed

- Process metrics normalization now consumes DUMB's `threads`, `vms` and
  `start_time` fields (available on current gateways; absent fields stay
  `null`).
- Navigation, landing-page options and dashboard presets gained the
  Observability entries (canonical nav updated; stored preferences stay
  compatible).

### Database

- **Migration v10** (additive, transactional): `cgroup_samples` +
  `cgroup_samples_5m` + `cgroup_samples_30m` (bounded 26h/7d/30d tiers) and
  `observability_events` (30d retention, 20 000-row hard cap) with indexes.
  No existing tables are modified; upgrade and rollback are safe.

### Fixed

- The `service_events` activity feed had a prune helper that was never called
  (unbounded growth); activity feed retention is now enforced daily.

## [0.8.2] — 2026-09-23

- Reconciliation: safe recovery from a stuck cycle — cancellable, self-healing.

## [0.8.1] — 2026-09-23

- Health semantics: liveness/readiness endpoints, Docker `HEALTHCHECK`,
  scheduler watchdogs; pre-v0.8 active incidents safely re-evaluated on
  upgrade; schema upgrade/backup/restore test coverage.

## [0.8.0] — 2026-09-22

- Incident lifecycle semantics (detector ownership, resolution kinds,
  operator ack/archive), self-monitoring with rolling baselines and robust
  trends, SLO panel, operator lifecycle UI.

## [0.7.2] — and earlier

See the git history (`git log --oneline`) for the pre-changelog era.
