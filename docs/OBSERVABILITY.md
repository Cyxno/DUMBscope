# Observability (v0.9)

Deep DUMB-stack monitoring: what DUMBscope measures, where the data comes
from, how it is stored, and how it is classified. **DUMBscope observes and
visualises — it never alerts about these signals.** Incident detection,
correlation and notifications (Telegram) remain the job of your external
alerting layer (Hermes); DUMBscope's own notification engine stays available
for the incident classes it already owns.

## Sources (no duplicate polling)

Everything rides sources that already exist:

| Source                                       | Used for                                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| DUMB `/ws/metrics` (existing stream)         | per-process RSS, CPU, **threads**, **vms**, **start_time** (uptime), host load                                             |
| DUMB `/ws/logs` (existing stream)            | InfiniDysk repair loops, `430 No Such Article`, missing segments, provider fallbacks                                       |
| DUMB `/api/process/processes` (existing)     | versions, update status, pinned/auto-update policy, GC heap hard limit (env)                                               |
| DUMB cgroup v2 directory (read-only mount)   | `memory.current/high/max/peak`, `memory.stat` (anon/file/shmem/slab), `memory.events`, `pgscan`, `workingset_refault_file` |
| Prometheus/cadvisor (optional fallback)      | container memory usage/rss/cache/kernel/oom when no cgroup mount exists                                                    |
| Sonarr/Radarr REST (existing integrations)   | queue, blocklist, history, download clients, delay profiles, backups (DB size)                                             |
| `/sys/class/thermal` (readable in-container) | host temperature zones + spike detection (90/95/100 °C)                                                                    |
| DUMBscope's own `memory_samples` tiers       | per-service 24h p50/p95, 1h/6h/24h deltas, 7d lagged baseline                                                              |

PSS / Private Dirty / per-process fd counts require host-PID visibility into
the DUMB container, which DUMBscope deliberately does not have (non-privileged,
no Docker socket). They are shown as "—" unless DUMB itself ever exposes them.

## Cgroup memory (v2)

DUMB runs in one container with `memory.high` and `memory.max` (production:
6.5 GiB / 8 GiB). The Observability page shows:

- **Breakdown** — applications/anon, shared/tmpfs, reclaimable file cache
  (file − shmem), kernel (slab + stack + sock + percpu + remainder).
- **Limits** — current as % of `memory.high` and `memory.max`, `memory.peak`.
- **Interpretation flags**, rate-based over the previous sample:
  - _soft reclaim active_ — `memory.events.high` moved;
  - _hard limit hit_ — `memory.events.max` moved;
  - _memory pressure_ — heavy `pgscan_direct` / file refaults while at or over
    a limit;
  - _OOM_ — `memory.events.oom` / `oom_kill` moved.
- **History** — 1-minute raw samples (26h) with 5-minute (7d) and 30-minute
  (30d) rollups, mirroring the runtime samples tiers.

> A high `memory.current` alone is **not** a problem — the kernel uses every
> byte of allowance as page cache. Only the rate-based flags above constitute
> pressure.

### Wiring the rich source (recommended)

Mount the DUMB container's cgroup directory read-only:

```yaml
services:
  dumbscope:
    environment:
      - DUMBSCOPE_DUMB_CGROUP_PATH=/dumb-cgroup # explicit path, or:
      # - DUMBSCOPE_DUMB_CGROUP_PARENT=/mnt/cgroup-docker
      # - DUMBSCOPE_DUMB_CONTAINER_ID=<64-hex id>
      - DUMBSCOPE_PROMETHEUS_URL=http://192.168.1.2:9090 # optional fallback + id resolver
    volumes:
      - /sys/fs/cgroup/docker/<DUMB container id>:/dumb-cgroup:ro
      # or the whole parent: /sys/fs/cgroup/docker:/mnt/cgroup-docker:ro
```

When `DUMBSCOPE_DUMB_CGROUP_PARENT` is set without an id, DUMBscope resolves
the DUMB container id through Prometheus/cadvisor's `name` label (cached 10
minutes) — this depends on your cadvisor build exposing that label. Where it
does not (older cadvisor releases), set `DUMBSCOPE_DUMB_CONTAINER_ID`
explicitly and update it when the DUMB container is recreated; until then the
cgroup panel degrades honestly to "unavailable". Without any cgroup
source, the section degrades to an honest "unavailable" and the optional
Prometheus fallback (`container_memory_*`, `container_oom_events_total`) is
used if `DUMBSCOPE_PROMETHEUS_URL` is configured.

## Per-service memory classification

Every enabled managed service gets a deterministic class, computed from its
stored RSS series (first matching rule wins):

| Class                  | Rule (summarised)                                                              |
| ---------------------- | ------------------------------------------------------------------------------ |
| `insufficient-history` | < 6h of samples                                                                |
| `sawtooth`             | ≥ 3 ramped drops (≥ 25 % from the running peak) in 24h — GC/workload cycle     |
| `possible-leak`        | Theil–Sen slope ≥ 16 MB/h with confidence ≥ 0.7 **and** ≥ 1.4× its own 24h p50 |
| `workload-driven`      | p95/p50 ≥ 1.8 without a confident trend                                        |
| `elevated-plateau`     | ≥ 1.3× the lagged 7-day baseline while flat — **high is not a leak**           |
| `stable`               | everything else                                                                |

Views also carry current, 24h p50/p95, lagged 7d baseline, Δ1h/6h/24h, the
robust trend (bytes/hour with confidence), threads, honest uptime (from
DUMB's `start_time`), version, and any detected **baseline shift**.

## Baseline shift detection

Compares the trailing 24h p50 against the lagged days-2..7 p50 (30-minute
tier). A shift is reported when the level moved ≥ 25 % up (or ≥ 25 % down),
held for ≥ 4 consecutive 30-minute buckets, with:

- old → new baseline and the percentage;
- when the shift started (first bucket of the sustained crossing);
- direction: `rising` (still climbing) vs `plateau` (shifted, stabilised) vs
  `declining`.

Example displays: `Sonarr: 650 MB → 1.3 GB plateau` or
`NzbWebDAV: 700 MB → 1.8 GB and still rising`.

## InfiniDysk / NzbWebDAV

Dedicated card fed from the existing log stream — no extra polling:

- runtime version + base NZBDAV version + repo (from the DUMB registry);
- `.NET GCHeapHardLimit` parsed from the service env;
- RSS, growth (24h Theil–Sen), threads, CPU, honest uptime;
- repair starts 1h/24h with a **repair active** state (started within 15 min);
- `430 No Such Article` count, missing/unavailable segments (including
  suppressed-warning rollups), provider fallbacks;
- mount state (via the existing mount monitor), restart attempts;
- **per-file repair loops**: repairs 1h/24h, last event, last error and
  recurrence (distinct days) — heaviest files first.

## Sonarr/Radarr + download routing

Two low-frequency pollers extend the existing Arr integrations (read-only):

- _stack_ (5 min): queue (+warnings/failures), blocklist size, history total,
  DB size proxy (latest scheduled backup), uptime, version, 24h
  grabs/imports/failures, RSS-sync and search activity from the command journal.
- _routing_ (10 min): download clients (protocol, priority, enabled), delay
  profile preferred protocol, and a 24h grab/import/failure aggregate per
  client with success rate and a **primary** badge (lowest priority among
  enabled clients).

This makes it directly visible whether Decypharr stays primary and when
InfiniDysk (or any other client) is actually used as the fallback.

## Thermal correlation

Reads `/sys/class/thermal/thermal_zone*` (readable inside the container) once
per minute. Spike levels: 90 / 95 / 100 °C with 5 °C recovery hysteresis. At a
crossing a **correlation snapshot** is captured — timestamp, temperature,
host load, DUMB CPU, top DUMB services by CPU, InfiniDysk repair active — plus
a recovery marker. Snapshots are correlation _display_; no causality is
claimed and nothing is sent to Telegram/Discord.

## Combined incident timeline

One merged feed (`observability_events`, 30-day retention, hard 20 000-row
cap): service restarts, health transitions, memory anomalies, InfiniDysk
repair loops, mount failures, OOM, cgroup high/max movements, thermal spikes,
deploy/version changes and download failures. Filter by window, kind and
service on the Observability page or via `/api/observability/timeline`.

## Versions & update awareness

From the DUMB registry: current version, `update_status` verdict, available
version, auto-update/pinned policy, and "this version since" (deploy marker,
diffed across discovery refreshes). InfiniDysk's pinned runtime
(`auto_update: false`) is displayed explicitly — it does **not** automatically
move with `DUMB:latest`.

## API

| Endpoint                                                        | Purpose                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /api/observability`                                        | full snapshot (cgroup, services, InfiniDysk, Arrs, routing, thermal, versions) |
| `GET /api/observability/history?hours=`                         | cgroup history across tiers + in-memory thermal series                         |
| `GET /api/observability/timeline?hours=&kinds=&service=&limit=` | merged timeline                                                                |
| SSE `observability` event                                       | signature-diffed live updates (replayed on connect)                            |

## Storage & retention (migration v10)

| Table                  | Retention | Notes                                  |
| ---------------------- | --------- | -------------------------------------- |
| `cgroup_samples`       | 26h       | 1/minute, fixed-width rows             |
| `cgroup_samples_5m`    | 7d        | avg/max per bucket, idempotent upserts |
| `cgroup_samples_30m`   | 30d       | avg/max per bucket                     |
| `observability_events` | 30d       | append-only + 20 000-row hard cap      |

Steady-state growth is bounded (same shape as `runtime_samples`). The timeline
replaces nothing: `service_events` (activity) and incidents keep working as
before.
