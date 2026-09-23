# Release Notes — v0.9.0

Theme: **DUMBscope as the central technical observability layer for the DUMB
container**. Everything in this release is read-only observation and visual
correlation. No new alerts exist: external incident detection/correlation/
Telegram (Hermes) keeps its exclusive role, and DUMBscope's own notification
engine keeps serving the incident classes it already owned — nothing doubled.

New page: **Observability** (Monitor section). New overview widget: *DUMB
observability*. Migration **v10** (additive).

## DUMB cgroup memory analysis (spec §3)

DUMB runs in one container with `memory.high` = 6.5 GiB and `memory.max` =
8 GiB (production values). The kernel's cgroup v2 files are the only
authoritative source for the breakdown — DUMB's own metrics report only the
total. The new panel shows:

- **Breakdown groups**: applications/anon, reclaimable file cache
  (file − shmem), shared/tmpfs, kernel (slab + stack + sock + percpu +
  remainder) — the "applications vs reclaimable cache vs kernel" split,
  because **a high `memory.current` alone is not a problem** (the kernel uses
  allowance as page cache).
- **Rate-based flags** (movement since the previous sample, never bare
  counters): soft-limit reclaim (`memory.events.high`), hard-limit hits
  (`memory.events.max`), pressure (heavy `pgscan_direct` / file refaults at a
  limit), OOM/OOM-kill.
- **History**: 1-minute samples for 26h, 5-minute buckets for 7d, 30-minute
  buckets for 30d — the same bounded three-tier shape as `runtime_samples`.

Sources, in priority order (auto-selected each sample): a **read-only
cgroupfs mount** of the DUMB container's cgroup directory, or — when absent —
an optional **Prometheus/cadvisor** fallback. See docs/OBSERVABILITY.md for
the one-line compose change; without either source the panel honestly reports
"unavailable" instead of guessing.

## Per-service memory observability (spec §2/§5/§9)

Every managed service gets a deterministic classification from its stored RSS
series (order matters, first match wins):

`insufficient-history` → `sawtooth/GC` → `possible-leak` →
`workload-driven` → `elevated-plateau` → `stable`.

Guarantees that matter in production:

- **A high but flat process is never a leak** (`elevated plateau`): the
  level-blind rules use trend evidence (Theil–Sen ≥ 16 MB/h at ≥ 0.7
  confidence *and* ≥ 1.4× the own 24h p50) — not the absolute level. A 1.28 GB
  Sonarr against a 1.25 GB baseline reads
  `1.28 GB | baseline 1.25 GB | +2% | stable plateau`.
- **Sawtooth/GC cycles are their own class**: ≥ 3 ramped drops (≥ 25 %) in
  24h. Single-point spikes are workload noise, not resets.
- **Baseline shifts are reported separately**: old → new baseline, percentage,
  start time and direction (`rising` / `plateau` / `declining`), e.g.
  `650 MB → 1.3 GB plateau` vs `700 MB → 1.8 GB and still rising`.

Views carry RSS, threads, honest uptime (DUMB's `start_time` — a new field
DUMBscope now consumes), version, 1h/6h/24h deltas, 24h p50/p95 and the
lagged 7-day baseline. PSS/Private-Dirty/fd-counts require host-PID access
which DUMBscope deliberately lacks — they render as "—".

## InfiniDysk / NzbWebDAV observability (spec §4)

Fed entirely by the **existing** `/ws/logs` stream (zero extra polling) plus
the existing mount monitor and metrics:

- repair starts (1h/24h) with an *repair active* state (start within 15 min);
- **per-file repair loops**: counts 1h/24h, last error, last event and
  recurrence (distinct UTC days) — repeated repairs of the same media file
  become directly visible;
- `430 No Such Article` counts, missing/unavailable segments (including the
  "Suppressed N additional warnings" rollups), provider fallbacks;
- runtime version + base NZBDAV version, `.NET GCHeapHardLimit` (0xA0000000 →
  2.50 GiB), mount state, restart attempts.

## Download routing (spec §6)

New read-only pollers on the existing Sonarr/Radarr integrations (5 min stack
/ 10 min routing):

- 24h **grabs / imports / failures / success rate per download client** —
  see directly whether Decypharr stays primary and when InfiniDysk is used as
  the fallback;
- client priorities + **primary badge** (lowest priority among enabled
  clients) and the Arr **preferred protocols** (delay profile);
- per-Arr stack facts: queue (+warnings/failures), blocklist size, history
  total, DB size proxy (latest scheduled backup), uptime, version, RSS-sync
  and search activity from the command journal.

## Thermal correlation (spec §7)

`/sys/class/thermal` is readable from inside a standard container — no
privileges needed. One sample per minute; spikes at **90/95/100 °C** with
5 °C recovery hysteresis; each crossing captures a small correlation snapshot
(timestamp → temperature → host load → DUMB CPU → top internal services →
InfiniDysk repair active?) plus a recovery marker. Display-only correlation —
no causality is claimed.

## Combined incident timeline (spec §8)

One merged feed of restarts, health transitions, memory anomalies, InfiniDysk
repair loops, mount failures, OOM, cgroup high/max movements, thermal spikes,
deploys and download failures — filterable by window/kind/service. It claims
nothing about causality and never notifies.

## Version/update awareness (spec §10)

The registry's versions + update verdicts are diffed across discovery
refreshes: "this version since" markers, deploy timeline events, pinned vs
auto-update policy per service. InfiniDysk's pinned runtime (auto-update off)
is explicitly labelled — it does **not** automatically follow `DUMB:latest`.

## UI (spec §12)

No redesign: dark mode, tokens, components and mobile behaviour unchanged.
Additions: the Observability page (Monitor nav), the compact *DUMB
observability* overview widget (orderable/hideable like every dashboard
widget), and a memory-baseline block in the service drawer. All charts reuse
the existing AreaChart/Sparkline components; the page is responsive
(grid-cols-1 → sm/lg/xl).

## Architecture (spec §11/§13)

Everything rides existing sources — the DUMB WebSocket streams, the DUMB REST
registry, the integration pollers, the log stream, DUMBscope's own sample
tiers — plus one new read-only source (cgroupfs/Prometheus) for what DUMB
does not expose. Storage is bounded: migration v10 adds the three cgroup
tiers and the capped timeline table; a small audit also fixed the
`service_events` prune that was never called.

## Tests (spec §14)

60 new test cases: baseline calculation (p50/p95/deltas), leak vs plateau vs
sawtooth vs workload classification, cgroup parsing/anon-vs-cache split and
high/max interpretation, InfiniDysk parsing + per-file aggregation + repair
window, routing aggregation/primary detection/protocol parsing, baseline
shifts (up/down/rising), thermal spike levels/hysteresis/snapshots, timeline
record/query/throttle/retention/cap, cgroup rollups + retention, migration
v10 (applied exactly once, tables + indexes present) and the three API
response shapes. Existing suites unchanged and green: 449 unit/integration +
73 e2e, plus typecheck, lint and production build.

## Upgrade

```bash
docker pull ghcr.io/cyxno/dumbscope:0.9.0
# then recreate the container (Unraid: Apps/Docker tab)
```

Optional (recommended) for the full cgroup picture — mount the DUMB
container's cgroup read-only and restart DUMBscope with:

```yaml
environment:
  - DUMBSCOPE_DUMB_CGROUP_PATH=/dumb-cgroup
volumes:
  - /sys/fs/cgroup/docker/<DUMB_ID>:/dumb-cgroup:ro
# robust alternative: mount the parent + set DUMBSCOPE_PROMETHEUS_URL so the
# container id resolves automatically (survives DUMB recreations)
```

Without it, the cgroup panel degrades honestly; everything else works.

### Rollback

Database migrations are additive — v0.8.2 can read the v10 database as-is
(it ignores the new tables). Roll back by recreating the container with the
previous image tag; no data loss, no manual steps.
