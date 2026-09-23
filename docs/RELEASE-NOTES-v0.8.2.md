# Release Notes — v0.8.2

Theme: **safe recovery from a stuck reconciliation cycle**. Detection and
hysteresis are unchanged; the runner can now actually recover.

## feat(reconciliation): cancellable cycles with a hard deadline

- Each cycle runs under its own `AbortController` with a 16-minute hard
  deadline — deliberately beyond the ~15-minute `self:recon-stuck` watchdog
  threshold, so the finding always opens before recovery and auto-resolves
  when the cycle ends.
- On deadline: long awaits (Arr fetches, Plex section refresh) race the
  abort signal and bail promptly; an aborted cycle NEVER applies the
  findings open/close delta — stale data must not resolve real findings;
  run state is always cleared in `finally`; the next scheduled cycle runs
  normally. No process restart required.
- The abort/timeout is recorded in reconciliation observability
  (`status: "timeout"` with the reason, visible in the System panel); the
  subsequent successful cycle records the recovery. Overlap prevention
  (one cycle at a time) is unchanged.
- `stop()` (shutdown/reload) also cancels an in-flight cycle.

Boundary: a _totally_ unresponsive event loop still cannot be interrupted
in-process — that remains external Docker liveness supervision (v0.8.1).
