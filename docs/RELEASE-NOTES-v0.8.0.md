# Release Notes — v0.8.0

Theme: **incident truth** — incidents now represent reality across their
whole lifecycle. Stale/zombie incidents are fixed at the root (detector
semantics, not a UI clear button), operators get honest lifecycle controls,
and DUMBscope gains self-observability strong enough to catch its own
regression classes (worker leaks, FD leaks, memory growth, reconciliation
slowdowns).

## fix(incidents): zombie incidents resolved at the root

Seven distinct lifecycle bugs could keep an incident ACTIVE long after its
underlying condition ended. All are fixed in the detector itself:

1. **Repeated acquisition requests stayed active for days.** The media
   correlator only resolved findings for items still inside its evaluation
   window; items that aged out of the history window, vanished from the
   queue, or whose integration died were never resolved. The correlator now
   runs a complete-cycle open/close sweep, and a "repeat" additionally
   requires verified active work (item missing, queued, or recent activity).
   A failed Arr read still resolves nothing.
2. **Broken symlink findings outliving their cause.** Recovery required a
   minimum sample size; a healthy mount that legitimately sampled fewer
   links could never resolve its finding. Any real sample below the systemic
   broken ratio now counts as recovery evidence.
3. **Mount findings after the mount recovered or config changed.** Monitored
   targets were captured once at startup; removing a mount kept probing it
   forever with findings that could never see a healthy round. Targets now
   sync from settings, and removed targets retire their findings with an
   explicit "target removed" resolution.
4. **Service findings for services that disappeared from DUMB.** The
   registry sweep only covered `stopped`; unhealthy/degraded/restart/log/
   database findings now resolve as obsolete too.
5. **Log-error incidents unresolvable after a restart.** The in-memory error
   window is now re-seeded on hydration, so one clean verification window
   after boot resolves the incident.
6. **Disk/database/memory findings for entities that vanish from DUMB
   metrics.** Absence on fresh metrics now retires the finding as obsolete
   after a bounded window (10 min) — never on a single missing frame.
7. **Deleted integrations and disabled monitors.** `integration-down`
   findings for deleted integrations, and all findings of a disabled monitor
   (mounts / memory / reconciliation / runtime), are retired with explicit
   reasons.

`pruneHistory` (cap 500) is now actually called — incident history is bounded.

## feat(incidents): lifecycle semantics, acknowledgement and archive

- New statuses: `active`, `acknowledged`, `resolved`, `archived`.
- Every resolution records **what it means**: `recovered` (detector
  positively confirmed), `obsolete` (target removed / monitor disabled /
  detector unavailable — never presented as a recovery), `operator`.
  UNKNOWN is never turned into RECOVERED.
- New metadata per incident: `detector`, `lastEvaluatedAt`,
  `lastEvidenceAt`, `acknowledgedAt`, `resolutionKind`, `resolutionReason`.
- **Acknowledged incidents stay technically open**: the detector keeps
  evaluating them and resolves them normally on verified recovery.
- **Archive is a soft state**: resolved incidents can be archived
  individually or via bulk "Clear resolved" (all / 24 h / 7 d / 30 d);
  archived history stays queryable and a recurrence opens a fresh row
  instead of un-archiving.
- **Stale-incident safety net**: a bounded pass (10 min) retires findings
  whose origin is provably gone — mount target removed, monitor disabled,
  integration deleted, service no longer managed — with the reason recorded
  in the timeline. It never resolves anything while the data source is
  unavailable.

### Incidents page

- Header counts (Active · Acknowledged · Resolved) and status filters, live
  over SSE: an incident that resolves while you watch moves out of the
  active list without a reload.
- Correlated findings render as one chain under the evidence-based root
  cause (declared mount consumers participate), instead of N independent
  problems. Causality is shown only where dependency evidence exists.
- The detail drawer shows the resolution banner ("recovered — verified by
  detector" vs "obsolete …"), the owning detector, and evaluation/evidence
  freshness.

Migration 9 is additive and backwards compatible.

## feat(runtime): DUMBscope self-monitoring (System → DUMBscope runtime)

DUMBscope now watches itself with a bounded sampler (one cheap pass every
15 s, one 1-minute persisted row): process RSS, heap used/total,
external/array buffers, event-loop lag, open file descriptors (Linux),
fsprobe worker counters (spawned / active / reclaimed / timed out), SSE
clients, SQLite + WAL size, scheduled jobs, reconciliation and reliability
probe durations, and the notification queue depth.

Findings about DUMBscope itself (fingerprints `self:*`) reuse the same
sustained-baseline + persistence + hysteresis architecture as the stack-side
anomaly detection through the ONE incident engine: RSS growth, worker-count
growth, FD growth, event-loop lag, and reconciliation runtime regression.
Trends use a robust Theil–Sen estimator with confidence; projections to a
threshold are labelled estimates and omitted when confidence is
insufficient.

Example findings: "DUMBscope worker count is growing abnormally — 12 → 84
workers in 3h · baseline ~11" or "DUMBscope RSS is increasing ~95 MB/hour ·
current 1.8 GB · baseline 420 MB".

## feat(metrics): long-term, bounded metric history

- Runtime vitals: 1-minute rows kept 26 h, 5-minute aggregates (avg+max)
  kept 7 d, 30-minute aggregates kept 30 d — idempotent per bucket, pruned
  hourly, well under 1 MB steady state (documented in docs/RELIABILITY.md).
- Service memory gains the same 5-minute and 30-minute tiers; the raw 26 h
  window continues to feed anomaly detection.
- Incident history is capped at 500 rows.

## feat(reliability): process identity, restart storms, SLO

- **Process identity**: memory samples carry the discovered service
  instance key (`instance_key`), so same-name instances (Sonarr / Sonarr
  Anime / Radarr / Radarr 4K) never mix baselines or history. Legacy
  name-only rows remain readable, keeping history continuous across the
  upgrade.
- **Restart storms**: repeated observed restarts (default ≥3 within an
  hour, baseline <1/day) open one deduped warning and resolve when the rate
  normalises. A disk-exhaustion trend finding (info, labelled estimate)
  opens when a confident growth trend projects into the warning level
  within 48 h.
- **Per-service operational statistics** (24 h / 7 d / 30 d): availability,
  incident count, restart count, total degraded time, longest outage, MTTR
  — computed from existing incident + service-event history. Availability
  is explicitly the share of _monitored_ time; periods where DUMBscope was
  not observing are excluded and reported as coverage (API:
  `GET /api/reliability/slo`).

## docs

SECURITY.md, README.md and docs/architecture.md no longer describe the
project as v0.1 read-only — they now document the actual Safe Actions
control plane (allowlist, confirmation, audit) alongside the observation
defaults. docs/RELIABILITY.md gains the full incident lifecycle semantics
and the retention tables.

## Upgrade notes

- Migration 9 runs automatically and is purely additive; existing incidents,
  findings and memory samples carry over.
- After upgrading, previously-stuck incidents (repeated requests, broken
  symlinks, mounts that recovered, deleted integrations) resolve themselves
  within the normal evaluation cadence — obsolete ones are explicitly
  labelled, not silently hidden.
- No configuration is required; all new behaviour is on by default and the
  runtime sampler's overhead is a few cheap calls every 15 s (see
  docs/RELIABILITY.md §Overhead).
