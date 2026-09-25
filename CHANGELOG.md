# Changelog

All notable changes to DUMBscope are documented here. Releases follow
[semver](https://semver.org/); database migrations are additive, versioned and
run transactionally on startup.

## [0.9.7] — 2026-09-25

Release-pipeline robustness. v0.9.6 verified the pushed image but could not
read the freshly-published tag back: the registry HTTP fallback used in
post-publish verification built a malformed reference (registry host left
inside the repo path). The reference is now normalized and the fallback is
exercised against all three published tags.

## [0.9.6] — 2026-09-25

Release-pipeline resilience. v0.9.5's image verified and published correctly,
but the follow-up manifest step died on a second registry read: `docker
buildx imagetools` calls intermittently fail on hosted runners (transient
registry/network errors surface as buildx exit 255).

### Fixed

- **Registry reads in the release pipeline retry with backoff** (4 attempts),
  and the post-publish verification exports the verified digest as a step
  output — the release manifest now consumes that authoritative digest
  instead of issuing a second, flake-exposed registry call.

## [0.9.5] — 2026-09-25

Release-pipeline fix. v0.9.4's image was built, pushed and is content-correct
(verified against the registry: all three tags resolve to the same digest,
both platforms present), but its post-publish verification step failed
instantly with an unattributable exit-255 and the release stopped there —
per policy the exact tag stays as-is and a new patch version ships instead.

### Fixed

- **Post-publish verification is failure-attributable** — every registry
  inspection and runtime assertion now emits an explicit marker and a
  `::error::` annotation before failing, and the step no longer hard-depends
  on the build step's digest output (an absent digest downgrades to a
  registry-only verification with a warning instead of an opaque abort).

## [0.9.4] — 2026-09-25

Rate-based repeat-acquisition detection: severity now follows the request rate
over sliding time windows instead of an absolute count inside a 72 h ledger
horizon. Release tooling hardening (release-guard robustness, tag/version/
changelog identity validation, validate→publish split with GHCR immutability
and post-publish verification, pinned actions) also ships in this release.

### Fixed

- **Repeated-acquisition detector rebuilt (`media-repeat`)** — two grabs hours
  apart while an earlier request never imported (the classic quality-upgrade
  shape: 720p superseded by 1080p) no longer open a warning; they stay below
  the rate thresholds and surface only in the flow's audit state. Tiers now:
  2 grabs within 1 h → info (audit, likely upgrade); ≥3 within 1 h or ≥4
  within 3 h → warning; ≥5 within 1 h or ≥6 within 3 h → critical (sustained
  loop). The verified active-work condition (missing / queued / recent
  activity) is unchanged, so stale history echoes still resolve on their own.
  Regression: the 2026-09-25 "Dark Matter S02E06" warning fired on exactly 2
  grabs 7.2 h apart while the superseded grab sat `grabbed` in the ledger.
- **e2e fixture vs namespace guard** — the reliability spec's broken-symlink
  fixture pointed targets outside the walked mount root, which the namespace
  guard (correctly) classifies unresolvable; stale targets now live inside
  the reachable tree so the systemic-broken signal is exercised conclusively.

## [0.9.3] — 2026-09-25

Merge the `hardening/symlink-namespace-guard` fixes into main. v0.9.1/v0.9.2
were cut from main, which never received this branch — deploying 0.9.2
regressed the TV/Movies symlink-root monitoring back to counting ENOENT
behind the DUMB-only rclone mount as broken (23/24, 20/24), re-opening both
systemic findings for healthy libraries.

### Fixed

- **Symlink targets behind foreign mounts are unresolvable, not broken**
  (b2af2aa) — fsprobe classifies ENOENT whose first missing directory lies
  outside the walked tree as `unresolvable`; unresolvable links are not
  conclusive evidence (not counted in `sampled`) and cannot trip the systemic
  finding. Existing findings resolve via the normal clean-round hysteresis.
- **Hydrated mount findings of removed targets retire** (21366fb) — the
  lifecycle pass resolves any mount/symlink finding whose fingerprint no
  configured target produces; identity-based retire alone could never match
  findings hydrated after a restart.

## [0.9.2] — 2026-09-25

Build provenance: every production image now reports exactly which commit it
was built from.

### Added

- **Build provenance at runtime** — the image build injects `BUILD_SHA` and
  `BUILD_DATE` (the release commit and UTC build timestamp; no git inside the
  image). `/api/health/live` returns them next to `version`
  (`{"status":"live","version":"0.9.2","buildSha":"…","buildDate":"…"}`), and
  System → DUMBscope Runtime shows `version · build <short sha>` with the full
  SHA and build date in the tooltip. Local/dev builds without build args
  degrade gracefully to version-only. CI's docker smoke test and the release
  pipeline now verify the reported SHA matches the built commit.

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
  process is explicitly _not_ a leak.
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
- **UI** — new _Observability_ page (nav group Monitor): headline tiles (DUMB
  memory state, anon vs cache, thermal, InfiniDysk), cgroup breakdown +
  history chart, per-service classification table with shift annotations,
  InfiniDysk card with repair-loop table, routing table, Arr stack cards,
  thermal chart + last-spike snapshot, versions table and the timeline.
  Compact new _DUMB observability_ overview widget (orderable/hideable) and a
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
