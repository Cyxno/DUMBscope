# DUMBscope 0.5.0 — Reliability & Operations

User-oriented release notes for the three-part reliability series
(reliability core, media correlation, customization & release).

## Reliability

- **Honest DUMB connectivity**: one derived state machine (starting /
  connecting / live / degraded / reconnecting / stale / offline /
  authentication failed). A server reboot no longer leaves a sticky
  "DUMB unreachable" — amber recovery states first, red only for proven
  outages, automatic reconnect without a browser refresh.
- **Mount health monitoring** (opt-in, read-only): stat latency, bounded
  directory walks and capped symlink sampling for your debrid mounts and
  symlink roots, with hard timeouts that can never block the poller.
  Repeated timeout patterns raise "storage mount appears unhealthy" with
  the affected consumers named.
- **Memory anomaly detection**: per-process RSS sampled from the existing
  telemetry stream, judged against a rolling-median baseline — warnings need
  absolute AND relative evidence (the 4–5 GB runaway class becomes visible
  long before the OOM), with persistence, hysteresis and flap protection.

## Media flow

- **Cross-service acquisition correlation**: see per item what Sonarr/Radarr,
  the acquisition path (InfiniDysk via SABnzbd emulation, Decypharr via
  qBittorrent emulation) and storage report — with provenance, timestamps and
  confidence.
- **Repeated acquisition request detection**: the "same item grabbed again
  while the earlier acquisition was still active" loop is now detected,
  counted and explained; normal quality upgrades are not flagged.
- **Library media flow**: series and movie drawers show a compact flow block
  (Acquiring / Importing / Available / repeated-request evidence) when a
  correlated flow exists.

## Recovery

- **Safe single-service restart**: recommendation-only — a sustained memory
  anomaly proposes "Restart <service>" with the evidence attached.
  Execution goes through DUMB's own management route, requires explicit
  administrator confirmation, and is followed by automatic verification.
- **Guardrails**: preflight checks, one action per target, 6-hour cooldown,
  max 2 attempts per 24 hours (then suspended), full audit trail, and crash
  recovery for in-flight actions. Success is never claimed without verified
  recovery.

## Customization

- **Appearance**: System theme joins Dark/OLED/Light (OLED now selectable),
  six new accents, three chart palettes (including colorblind-friendly and
  monochrome), interface density, and motion control — all applied live.
- **Dashboard**: show/hide and reorder Overview widgets, with Balanced /
  Media-focused / Operations / Minimal presets and a Reliability widget that
  stays compact when healthy and specific when something needs attention.
- **Navigation**: sidebar modes, default landing page, hide/reorder nav items
  (hidden routes keep working; Settings always stays reachable).
- **Library**: default tab, default TV view, poster size.
- **Data display**: date style, 12/24-hour time, GB/GiB units, simple or
  detailed status vocabulary, optional technical identifiers.
- **Accessibility**: higher contrast, enhanced focus outlines, reduced
  transparency, always-visible status labels, larger text size.
- **Reset interface settings** restores shipped defaults. Existing users see
  the same interface as before after upgrading.

## Read/write statement

Monitoring and correlation remain read-only. Service restart actions require
explicit administrator confirmation. Automatic recovery is disabled by default.

## Upgrade notes

- Migration 5 (memory samples) and 6 (acquisition ledger + remediation audit)
  apply automatically; both are additive and bounded by retention.
- For mount monitoring, bind the paths you want observed into the container
  **read-only** (see docs/RELIABILITY.md for the exact list used on the
  reference stack). Without binds the Reliability page honestly reports
  "No mount paths configured" — no false alerts.
