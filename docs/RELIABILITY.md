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
yet; a Settings → Reliability page arrives with the first user-tunable
policies (mount/memory monitoring phases).

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
