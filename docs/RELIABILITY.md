# Reliability

How DUMBscope turns raw telemetry into trustworthy statements about the stack —
and why the connectivity layer can no longer lie.

```text
Detect → understand → correlate → explain → recommend → (optionally, safely repair)
```

Priority order, not a slogan: monitoring never auto-restarts anything that was
not explicitly configured to be restartable. Read-only diagnostics come first.

---

## Connectivity (FASE A)

### The problem this replaces

Production incident, 2026-09-13 (DUMBscope 0.3.0): a critical _“DUMB gateway
unreachable”_ incident opened at 09:14 and stayed active for **8+ hours** while
the gateway was healthy and answering `/api/health` the whole time. Two
compounding root causes were proven with a read-only audit of the production
database plus deterministic reproduction against a mock gateway:

1. **The hub had multiple ad-hoc state writers.** A failed REST bootstrap
   forced `state: 'offline'` and clobbered the (live) stream flags; a later
   successful bootstrap only patched the `rest` flag and never recomputed the
   overall state. With the WebSocket streams quietly delivering, no further
   transition ever fired, so a false offline verdict (and its incident) stuck.
2. **A WebSocket stream could go deaf.** `DumbStream`'s reconnect timer handle
   stayed truthy after firing, so a later socket close hit an early-return
   guard and was ignored: a stream that had reconnected once never noticed any
   subsequent disconnect and stayed `live` while frozen. Both false-red
   (offline while healthy) and false-green (live while frozen) could be
   produced from this one bug.

### The fix: one derived state machine

`src/lib/server/dumb/connection.ts` (`ConnectivityTracker`) is now the **single
writer**. The state is never assigned; every reader gets `snapshot()`, which is
recomputed from current layer facts. Stale verdicts are impossible by
construction because nothing is stored except facts:

| Layer   | Facts                                                                                         |
| ------- | --------------------------------------------------------------------------------------------- |
| HTTP    | unauthenticated `GET /api/health` probe (failure classification only, to avoid extra traffic) |
| Auth    | `/api/auth/status`, token login/refresh                                                       |
| REST    | authenticated discovery round trip (`processes` + `capabilities`)                             |
| Streams | per-stream socket state (`status`, `metrics`, `logs`)                                         |
| Data    | freshness of the last real telemetry frame                                                    |

Derived states (`ConnectionState` in `src/lib/types.ts`):

| State                 | Meaning                                                                                                                                                         | Colour |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `starting`            | DUMBscope/hub just (re)started; DUMB may still be booting after a host reboot. Amber ceiling of **120 s**, exits on the first success — a ceiling, not a delay. | amber  |
| `connecting`          | First contact attempts (per-stream only).                                                                                                                       | amber  |
| `live`                | Status + metrics streams delivering, data fresh.                                                                                                                | green  |
| `degraded`            | Honest partial: REST reachable but streams unavailable, or only some streams delivering.                                                                        | amber  |
| `reconnecting`        | A previously-working session broke (both core streams lost, or hub reload); bounded recovery window of **90 s**.                                                | amber  |
| `stale`               | Sockets nominal but no data for 90 s.                                                                                                                           | amber  |
| `offline`             | Grace windows expired with failing probes — genuinely unreachable.                                                                                              | red    |
| `credentials-invalid` | DUMB rejects the stored credentials.                                                                                                                            | red    |

Rules that make the semantics trustworthy:

- **Amber never pages.** The incident engine only opens the _gateway
  unreachable_ incident for a derived `offline` verdict that persists past its
  own 15 s debounce; `starting`/`reconnecting`/`degraded`/`stale` never open
  connectivity incidents. Total time from outage to red is therefore
  ≥ grace window + debounce, with multiple failed probe cycles in between.
- **Recovery is automatic and verified.** The incident resolves only after the
  connection has been `live` for 30 s; no browser reload, no manual refresh.
- **Grace windows use real signals.** `starting` ends the moment any probe or
  frame succeeds; there is no fixed “wait 5 minutes”.
- **REST-up/WS-down is reported as `degraded`**, not as an outage — the UI says
  exactly which layers are up (brief: “HTTP is reachable, WebSocket is
  reconnecting”).
- **No flapping.** Transient probe failures never take down a `live`
  connection; hysteresis lives in the derivation, thresholds live in
  `CONNECTIVITY_TUNING` (`src/lib/server/dumb/connection.ts`).
- **Failure classification** (`classifyProbeError`): refused / DNS / timeout /
  connection reset / HTTP status / auth-rejected, in plain language, as probe
  detail and incident evidence — never raw errno in user-facing copy.
- **Recovery acceleration.** When a REST bootstrap succeeds while streams are
  stuck in reconnect backoff, the hub bounces the streams immediately (fresh
  credentials, no up-to-60 s wait). After a recovery that rode in on the
  streams' own backoff, one successful REST round trip reconciles the probe
  verdicts on the next housekeeping tick.

### What the UI shows

- **Connection pill** (top bar): `CONNECTED` / `STARTING` / `RECONNECTING` /
  `PARTIAL` / `STALE` / `UNREACHABLE` / `AUTH NEEDED`, amber for every
  grace/partial state.
- **Connection popover**: one-line honest summary, per-layer probe rows with
  detail, per-stream rows, last successful contact, last update, reconnect
  attempts.
- **Overview banner**: amber “DUMB may still be starting after a restart…” /
  “Reconnecting to DUMB · last successful contact …” during grace; red
  “DUMB is currently unreachable” only for `offline`.
- **System → DUMB connection card**: the same layer facts for troubleshooting.

### Tuning

All knobs are constants with sane defaults in `CONNECTIVITY_TUNING`:
`startupGraceMs` 120 s, `recoveryGraceMs` 90 s, `probeFreshMs` 10 min (matches
discovery refresh), `staleAfterMs` 90 s. They are intentionally not settings
yet; the Settings → Reliability page covers the mount/memory monitoring
switches and memory thresholds (see below).

### Known limitations

- DUMB exposes no uptime/process-start signal in the payloads DUMBscope reads,
  so “host recently restarted” is inferred from the hub restart and from a
  lost-then-restored session — not from a host uptime value.
- The old boolean-derived `reachable` ideas are gone; `ConnectionSnapshot`
  gained additive fields (`lastSuccessAt`, `connectedSince`, `stateSince`,
  `probes`). Older browser caches simply miss them until the next SSE event.

### Tests

`tests/connectivity.test.ts` pins the whole matrix: the production repro
(sticky false-offline), the boot-grace and recovery windows under a controlled
clock, partial states, stale, credentials, no-flap hysteresis, hub-restart
semantics, probe classification, and the full hub + incident-engine journey
(amber during boot → critical only after sustained failure → automatic
resolution). `tests/e2e/connectivity.spec.ts` drives a real browser through a
real gateway outage (mock sockets destroyed and restored) and asserts the UI
never shows a false red and recovers by itself.

---

## Mount health (FASE B)

Read-only observability for the stack's storage paths. DUMBscope never
mounts, remounts, restarts or repairs anything here — detection and honest
lifecycle management only. (The one write path that exists anywhere in the
product is the separately-gated Safe Actions control plane,
docs/ACTIONS.md.)

### The monitored inventory

Mount paths are **opt-in per deployment** (`DUMBSCOPE_MOUNTS` env JSON or the
`reliability.mounts` setting) because probing paths a container cannot see
would only produce false `missing` verdicts. Each target declares `component →
mount → consumer`. The current beta deployment monitors this stack (paths as
visible from the DUMBscope container, all binds read-only):

| Component                 | Mount                                          | Kind           | Consumers (shown as "may be affected")        |
| ------------------------- | ---------------------------------------------- | -------------- | --------------------------------------------- |
| TV symlink root           | `/mnt/vm_storage/symlinks/TV Shows`            | `symlink-root` | Plex Media Server, Sonarr, Bazarr             |
| Movies symlink root       | `/mnt/vm_storage/symlinks/Movies`              | `symlink-root` | Plex Media Server, Radarr, Bazarr             |
| NZBDAV (rclone FUSE view) | `/mnt/remote/nzbdav`                           | `fuse`         | Plex Media Server, Sonarr, Radarr, InfiniDysk |
| Decypharr debrid bridge   | `/mnt/cache/appdata/DUMB/mnt/debrid/decypharr` | `fuse`         | Sonarr, Radarr, Plex Media Server             |

The TV/Movies links point at `/mnt/remote/nzbdav/.ids/…` inside the rclone
mount, so a dead NZBDAV/rclone mount shows up twice: as an unresponsive FUSE
probe _and_ as broken sampled links.

### How a probe round works

Every 60 s per target (driven by the hub housekeeper, failure-isolated):

1. `stat` the path — existence + responsiveness latency.
2. A **bounded** walk: ≤400 entries, depth ≤3, collecting symlinks
   (symlink roots nest show → season → link). Never a full library walk.
3. Up to **24 symlinks** sampled (hard cap) from the walk; each is `lstat`ed
   and its target `stat`ed → `sampled / valid / broken / unreadable`.

All filesystem work runs in a **disposable worker thread with a hard 30 s
deadline**. A hung FUSE mount blocks _in syscall_; the worker is terminated at
the deadline and the round is recorded as a timeout — the poller itself never
blocks (brief §45).

### States and evidence

| State          | Requires                                                                                                                                                                                                                   | Finding                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `healthy`      | stat + walk succeed, stat latency ≤ 1.5 s                                                                                                                                                                                  | —                                            |
| `slow`         | stat latency > 1.5 s (stat = plain responsiveness; the walk's list latency is budgeted work — 400 entries over shfs/FUSE easily exceeds a second on a healthy array — and is reported in the UI but never a health signal) | —                                            |
| `degraded`     | 2 consecutive failed rounds                                                                                                                                                                                                | warning (intermittent)                       |
| `unresponsive` | 3 consecutive failed rounds (timeouts)                                                                                                                                                                                     | critical — "storage mount appears unhealthy" |
| `read-error`   | 3 consecutive failed rounds with EIO/EACCES                                                                                                                                                                                | critical                                     |
| `missing`      | 2 consecutive ENOENT rounds                                                                                                                                                                                                | warning                                      |
| `unknown`      | no probe result yet                                                                                                                                                                                                        | —                                            |

One bad round **never** reclassifies a healthy mount; findings resolve only
after 2 consecutive healthy rounds (hysteresis, brief §26/§27). Symlink
sampling only opens a finding on a **systemic** signal (≥8 sampled **and** ≥80%
broken — e.g. the debrid target is gone); a few stale links are evidence, not
findings (brief §23).

When a mount stops answering while a storage service (InfiniDysk, Decypharr,
rclone, NZBDAV…) reports running, the finding says so and lists consumers as
**"may be affected"** — a consumer is never opened an incident of its own and
never turned red (brief §24).

### False-positive protections

- ENOENT twice, timeouts ×3, degraded ×2 before any verdict.
- Recovery clears only after sustained healthy rounds.
- The bounded walk can't drown the array: 400-entry budget per round.
- Monitoring can be switched off entirely (Settings → Reliability).

---

## Memory anomaly detection (FASE C)

The production complaint: NZBDAV/InfiniDysk-adjacent memory creeping towards
4–5 GB inside the DUMB container's 6 GB cgroup until a restart is needed —
previously invisible. Detection is observation-only; **no auto-restart exists
or is planned in this phase**.

### Data

- Source: the **existing metrics stream** — no extra polling of DUMB. Per
  process RSS lands in the `memory_samples` table, throttled to one row per
  process per minute, pruned beyond 26 h (≈1.5k rows/process, a few MB total —
  never a raw probe firehose, brief §42/§43).
- Processes are identified by name as DUMB reports them (e.g. `NzbWebDAV`,
  `Sonarr`) — nothing is hardcoded (brief §29). Same-named entries collapse to
  the largest RSS.

### Detection rules (brief §31–§34)

A finding needs **absolute usage above the bar AND relative evidence** — never
a bare threshold:

- **Warning** (default ≥ 3.5 GB) AND either
  - current ≥ 1.75 × rolling-median baseline (6 h window), or
  - ≥ +512 MB growth over the last hour,
  - held for 10 minutes (persistence) before the finding opens.
- **Critical** (default ≥ 4.5 GB) AND (still growing ≥ +96 MB/15 min **or**
  host/cgroup pressure ≥ 90 % **or** the warning evidence).
- **Baseline**: rolling median over 6 h, **lagged 5 min and frozen when the
  evidence first arms** — a growing leak must not absorb into its own baseline
  before the persistence window closes. Needs ~20 samples before relative
  rules arm; without a baseline, only the hourly-growth path can arm.
- **Spike vs leak**: a spike that recovers below the bar inside the 10-minute
  persistence window never opens anything.
- **Hysteresis** (brief §37): recovery resolves only after ~10 minutes of
  sustained normalisation (below bar × 0.85 / near baseline). Re-opens bump
  `occurrences` instead of creating rows (flap protection, brief §38).

### UI

- **System → Memory anomalies**: per-process `current · typical · 6h change ·
24h peak`, anomalies highlighted.
- **Overview/Incidents**: the finding summary is the attention line, e.g.
  _"NzbWebDAV memory use is unusually high — 4.2 GB · +1.8 GB over 6h ·
  typical 1.2 GB · host memory pressure 96%"_.
- Escalation warning→critical is recorded in the finding timeline.

---

## Findings model

There is **one** findings layer: the existing incident engine. Mount, symlink
and memory findings are incidents with a stable fingerprint
(`mount:<path>`, `symlinks:<path>`, `memory:<process>`), severity, evidence
lines (`source: reliability`), firstSeen/lastSeen/status and occurrence counts
for flap history. Lifecycle: active → (sustained recovery) → resolved →
(recur) reopen with `occurrences+1`. Severity transitions are recorded in the
timeline. No second engine (brief §25/§26).

---

## Settings

Settings → Reliability (observation switches; the remediation _recommendation_
layer is separate and off unless explicitly enabled):

- Mount monitoring — ON by default.
- Memory monitoring — ON by default.
- Memory warning threshold — default 3.5 GB.
- Memory critical threshold — default 4.5 GB (never below warning).

The thresholds apply on the next detection pass; no reload needed.

---

## Incident lifecycle semantics (v0.8)

Incident state must represent reality. Every detector that can open a finding
owns deterministic recovery/close semantics, and every resolution records
WHAT it means — a recovery is never inferred from silence, and "cannot
verify" is never reported as "recovered".

### Statuses

- **active** — open problem, detector still sees it. The default Incidents
  view is this list: "what requires attention right now?"
- **acknowledged** — an operator saw it. Still technically open: the detector
  keeps evaluating it, it keeps escalating/correlating, and it resolves
  normally once recovery is verified. It renders muted, never gone.
- **resolved** — closed with a recorded resolutionKind:
  - `recovered` — the detector positively confirmed recovery.
  - `obsolete` — the finding's origin is provably gone (target removed,
    monitor disabled, integration deleted, process no longer reported). This
    is explicitly NOT a recovery and is labelled as such in the UI.
  - `operator` — archive/clear bookkeeping.
- **archived** — cleared from the working views by an operator (soft state,
  never a deletion). A recurrence opens a NEW row; archived history does not
  resurrect.

### Lifecycle metadata

Every incident row carries `detector` (owning detector, e.g. `mounts`,
`media-flow`, `runtime`), `last_evaluated_at` (proof the detector ran and
had the chance to change its verdict), `last_evidence_at` (last positive
evidence), `acknowledged_at`, `resolved_at`, `resolution_kind` and
`resolution_reason`.

### Per-detector recovery semantics

- **Service health/stopped/restart** (`status.*`): resolve after a sustained
  healthy streak (3 observations) or a running state; a service that
  disappears from DUMB's managed registry resolves as `obsolete`.
- **Log-error bursts** (`logs.errors`): resolve after one full window with
  no errors. After a restart the burst window is re-seeded, so post-restart
  recovery is reachable.
- **Disk / database health / memory** (`metrics.*`, `memory`): resolve on
  positive healthy readings with hysteresis; if the filesystem/process
  disappears from otherwise-fresh DUMB metrics for >10 min, resolve as
  `obsolete` ("no longer reported"). A single absent frame never resolves.
- **Mounts** (`mounts`): resolve after the configured number of healthy probe
  rounds (default 2). Mount targets sync from settings on every housekeeping
  tick; removing a target stops probing and retires its findings as
  `obsolete` ("target removed").
- **Symlinks** (`mounts.symlinks`): opening the systemic finding needs ≥8
  sampled links AND ≥80% broken; recovery needs clean rounds (broken ratio
  below the systemic threshold) — including rounds that sample fewer links or
  none at all, which previously made recovery unreachable.
- **Reconciliation** (`reconciliation`): complete-cycle open/close deltas —
  anything previously detected but absent from a successful cycle resolves;
  a failed or incomplete cycle (unreachable Arr, skipped diff) resolves
  NOTHING. An integration deleted mid-incident is retired by the safety net.
- **Media flow** (`media-flow`): a repeated acquisition request resolves when
  the acquisition is no longer verifiably active — the item imported, left
  the queue, the condition dropped out of Arr state, or the cluster went
  silent beyond the acquiring grace. Item-level close-outs run only on
  complete cycles (every enabled Arr answered); a failed Arr read resolves
  nothing.
- **Integrations** (`integration`): resolve after sustained successful
  polling; deleting the integration retires the finding (`obsolete`).
- **Memory anomalies** (`memory`): resolve through the tracker's existing
  hysteresis (sustained at-or-below the recovery line).
- **DUMBscope runtime** (`runtime`): self-monitoring findings resolve after a
  sustained recovery window; disabling runtime monitoring retires them.
- **Connection**: offline resolves only after a sustained live period;
  credentials resolve on acceptance. Removing the DUMB configuration retires
  stack findings via the safety net.

### Stale-incident safety net

A bounded pass (every 10 min) inspects open incidents against the currently
registered detectors/targets: configured mount paths, registered
integrations, enabled monitors, the managed service registry. Findings whose
origin is gone resolve with an explicit `obsolete` reason recorded in the
timeline ("target removed", "monitor disabled", "integration deleted"). The
pass never resolves anything because an incident is merely old, and
never while its data source is unavailable — "detector cannot verify" and
"target removed" stay different states.

### Operator controls

Acknowledge (mutes, keeps evaluating), Unacknowledge, Archive (resolved
only), and bulk "Clear resolved" (all / older than 24 h / 7 d / 30 d).
Clearing is a soft archive — history stays queryable, and the header counts
(Active · Acknowledged · Resolved) stay truthful.

---

## Scheduler watchdogs (v0.8.1)

DUMBscope's self-monitoring includes two independent watchdogs, both running
on the runtime sampler's own 15 s interval — deliberately separate from the
things they watch:

- **Housekeeping heartbeat** (`self:housekeeping`, critical): the hub stamps
  a heartbeat on every completed 10 s housekeeping tick. If the heartbeat is
  older than 60 s for two consecutive samples, the finding opens (incident
  evaluation, safety net and telemetry-freshness checks are not running). It
  resolves after two consecutive fresh samples.
- **Stuck reconciliation** (`self:recon-stuck`, warning): a reconciliation
  cycle running longer than 15 minutes — safely beyond the worst legitimate
  cycle (~13 min: 400-series cap, 8 s per-request deadline, 8 concurrent
  fetchers) — is presumed wedged and reported. The runner aborts the cycle
  itself at its 16-minute hard deadline (AbortController + cooperative
  signal checks; the findings delta is skipped on an aborted cycle, so
  stale data can never resolve real findings), state is cleared in a
  `finally`, and the next scheduled cycle runs normally — no process
  restart required. The finding auto-resolves when the cycle ends. The
  timeout is recorded in reconciliation observability (`status:
"timeout"`) alongside the subsequent successful recovery.

**External supervision boundary (documented, not an accident):** total
process death and a fully starved event loop stop this sampler along with
everything else — no in-process monitor can observe them. That failure class
is supervised externally by the Docker liveness `HEALTHCHECK`
(`GET /api/health/live`, process/event-loop answering only) plus the
container restart policy. Readiness (`GET /api/health/ready`: SQLite +
initialized hub + fresh housekeeping heartbeat) is exposed for reverse
proxies and orchestrators, and never fails merely because DUMB is offline.

---

## Database & retention

- Migration 5 (additive): `memory_samples(process, at, rss_bytes)` with
  `(process, at)` and `(at)` indexes. One row per process per minute,
  retention-pruned at 26 h (~62k rows steady-state for a 40-process stack, a
  few MB).
- Findings reuse the existing incident tables and retention — no new store.
- Migration 9 (v0.8, additive): incident lifecycle metadata columns;
  `runtime_samples` + `runtime_samples_5m` + `runtime_samples_30m`;
  `memory_samples.instance_key` and the `memory_samples_5m`/`_30m` tiers.

### Long-term tiers (v0.8) — predictable, bounded growth

| Series                                                                | Tier           | Retention | Steady-state rows      |
| --------------------------------------------------------------------- | -------------- | --------- | ---------------------- |
| Runtime vitals (RSS, heap, lag, FDs, workers, SSE, DB/WAL, durations) | 1 min raw      | 26 h      | ~1.5k                  |
| same                                                                  | 5 min avg+max  | 7 d       | ~2.0k                  |
| same                                                                  | 30 min avg+max | 30 d      | ~1.4k                  |
| Service memory                                                        | 1 min raw      | 26 h      | ~1.5k per 40 processes |
| same                                                                  | 5 min avg+max  | 7 d       | ~2.0k per process      |
| same                                                                  | 30 min avg+max | 30 d      | ~1.4k per process      |

Aggregation keeps avg AND max per bucket (an average must not hide a leak
spike), is idempotent per bucket (overlapping runs never duplicate), and a
single hourly maintenance pass downsamples and prunes all tiers. Incident
history itself is capped at 500 rows (`pruneHistory`, now actually wired).
Total steady-state growth of the new tables is a few thousand fixed-width
rows — well under 1 MB.

---

## Overhead (measured on the beta, real stack)

- Mount probes: **1 round / 60 s per target**; 4 targets → ~4 stat + 4 bounded
  walks per minute (8 filesystem op-encounters/min, `fsCalls` counter in
  `/api/reliability`). A full round over all 4 targets ≈ 2.3 s wall time in a
  worker thread — off the main request path.
- Memory: sample insert ≤ 1 row/process/min; detection pass is a few bounded
  SQL aggregates per minute.
- DB growth: see above (~a few MB/day worst case, pruned).
- Failure isolation: a timed-out mount probe only costs that probe round; the
  DUMB connection, service registry and incident engine are untouched.
- Runtime self-monitoring (v0.8): one sample pass per 15 s of `memoryUsage()`
  - `/proc/self/fd` readdir + two stat calls + one SQLite row per minute.
    Measured sync cost on the reference NAS: **≈15 µs per pass, ≈3.7 ms of
    sync work per hour** (plus ~4 one-row inserts per minute). The hourly
    maintenance pass (downsample + prune) is a handful of bounded SQL
    statements over capped tables. Event-loop lag is measured by observing
    drift of the sampler's own 1 s heartbeat — no busy work.
- Safety net (v0.8): one pass per 10 min over the (few dozen) open incident
  rows already in memory; no extra polling of DUMB or the filesystem.

---

## Known limitations

- DUMBscope can only probe paths that are mounted into its container. The
  production container mounts only `/config`; the beta deployment adds the
  four read-only binds above. Production deployment should adopt the same
  binds (or configure `reliability.mounts`) to enable mount monitoring.
- No host-uptime signal exists in DUMB's payloads; "recently restarted"
  remains inferred from the hub restart and lost-then-restored sessions.
- The bounded walk samples the shallowest 400 entries; a pathological broken
  subset deeper than the budget is not sampled this round (by design — never a
  full walk).
- `memory.percent` reflects DUMB's metrics scope (cgroup), so "host pressure"
  means the DUMB container's 6 GB budget — which is exactly the budget the
  4–5 GB complaint lives in.
- Mount findings and memory findings are observation-only; the memory
  remediation _recommendation_ (restart-managed-service) is operator-gated
  and off by default (docs/REMEDIATION.md).

### Tests

- `tests/mounts.test.ts` — real probe worker against real trees: latency,
  ENOENT, sampling bookkeeping, entry budget, two-round `missing`.
- `tests/mount-states.test.ts` — deterministic state machine (mocked probes)
  - engine finding lifecycle incl. systemic-only symlink warning.
- `tests/memory-anomaly.test.ts` — controlled-clock rules against the real
  sample store: spike-vs-leak, sustained leak → warning → critical → resolve,
  no-bare-threshold, host pressure, drawer features, pruning, lifecycle.
- `tests/e2e/reliability.spec.ts` — real browser journeys: broken fixture
  opens the symlink warning and resolves after repair; a 4.2 GB RSS jump
  opens the memory finding and resolves on recovery.
