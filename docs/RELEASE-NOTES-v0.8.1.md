# Release Notes — v0.8.1

Theme: **production readiness** — Docker health semantics, self-observed
scheduler watchdogs, and validated upgrade/restore paths. No feature changes;
no schema migration beyond v0.8.0's.

## feat(health): liveness vs readiness

- `GET /api/health/live` — **liveness**: the process is up and its event loop
  answers. Consults no dependency, so nothing downstream can fail it. The
  Docker `HEALTHCHECK` now probes this endpoint; Docker restarts the
  container when it stops answering.
- `GET /api/health/ready` — **readiness**: SQLite answers, the telemetry hub
  is initialized, and the 10 s housekeeping heartbeat is fresh (≤45 s).
  Returns 503 with the failing checks otherwise. DUMB being offline never
  gates readiness — it is reported informationally.
- The hub stamps a housekeeping heartbeat on every tick and now runs its
  schedulers even while unconfigured, with a first tick ~1 s after start.
  The hub boots eagerly with the server process (hooks module), so an
  instance nobody has opened in a browser still monitors from boot.

## feat(runtime): scheduler watchdogs

Two self-observability findings through the normal incident engine, watched
by the independent 15 s runtime sampler:

- `self:housekeeping` (critical) — the 10 s housekeeping heartbeat is older
  than 60 s for two consecutive samples; resolves after two fresh samples.
- `self:recon-stuck` (warning) — a reconciliation cycle running longer than
  15 minutes (worst legitimate cycle ≈13 min); resolves when it finishes.

Documented boundary: total process death or a fully starved event loop stops
the sampler too — that class is supervised externally by the liveness
`HEALTHCHECK` plus the container restart policy.

## fix(incidents): pre-v0.8 rows are safely re-evaluated on upgrade

Upgraded databases carry active incidents without lifecycle metadata. The
engine now stamps a hydrated pre-v0.8 row with its owning detector (derived
from the fingerprint) and, on first re-evaluation, its affected entity. A
safety-net rule retires rows that no detector re-adopted within one hour of
upgrade as explicitly **obsolete** ("legacy (pre-v0.8) finding could no
longer be evaluated by any current detector") — never as recovered. A legacy
finding whose condition still holds stays open; one whose condition cleared
resolves as recovered, exactly like a native row.

## tests: upgrade/restore/WAL validation

New suites: `tests/health.test.ts` (live/ready semantics, DUMB-offline
readiness, stale-heartbeat 503), `tests/database-recovery.test.ts` (v8→v9
upgrade with pre-v0.8 rows preserved + safely re-evaluated, file-copy
backup/restore startup, WAL persistence across clean restart).
