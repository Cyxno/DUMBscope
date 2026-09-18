# Release Notes — v0.7.1

## fix(reliability): reclaim probe workers on every round exit path

`runProbeRound()` terminated its probe worker only on a deadline overrun,
so every healthy round leaked one idle worker isolate (~8 MB RSS). The
mount monitor runs one probe round per mount per minute — with four
mounts configured that is ~4 workers/min ≈ 2 GB/hour of steady anonymous
memory growth in every instance (production finding 2026-09-17: an
instance at 7.1 GB RSS with `heapUsed` of just 31 MB and 878 live
MessagePorts).

- **fsprobe.ts** — the worker is now terminated inside `finish()`, so
  success, error and timeout paths all reclaim the isolate.
- **tests/fsprobe-worker-lifecycle.test.ts** — regression tests: 40
  healthy probe rounds must add zero threads (demonstrated to fail on
  the unfixed code), timeout and mixed rounds stay bounded.

Validated in production: RSS flat at ~100 MB with zero thread growth
across dozens of mount-monitor rounds (previously +2 GB/hour).
