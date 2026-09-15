# DUMBscope 0.6.1 — compatibility audit

Patch release from the compatibility audit: every service DUMB's registry can
report is now recognized with its canonical name, icon, category and pipeline
stage, plus an honest, machine-readable support matrix. No monitoring logic
changed.

## Fixed / improved

- **Catalog coverage**: Traefik (+ Proxy Admin), Authelia, Cloudflared, CLI
  Battery, Phalanx DB, pgAdmin, Maintainerr, AIOStreams, MediaStorm and Seerr
  Sync are now recognized services with names, icons, categories and pipeline
  stages — previously they fell back to the anonymous generic node.
- **Separator-style matching bug**: catalog matching normalizes underscores,
  dashes and spaces, so services like `cli_debrid` / "CLI Debrid" can never
  fall back to generic monitoring because of naming style.
- **Seerr Sync** is matched as its own service instead of being shadowed by
  the Seerr entry.
- Recognized services that are configured but never reported now surface as
  "not running" entries instead of invisible infrastructure noise.

## Compatibility documentation

- New **docs/COMPATIBILITY.md**: per-service support matrix (Discovery / Basic
  / Operational / Deep integration / Remediation / Contract tested / Real
  tested) generated from `src/lib/shared/service-capabilities.ts`.
- Central registry fixture (`tests/fixtures/services/dumb-registry.json`)
  mirrored from a live DUMB v2.22.x install, plus a contract suite pinning
  recognition, uniqueness, icons, multi-instance behavior and honest health
  semantics; a drift-guard test keeps the docs table in sync with code.

No production deployment is required to benefit from documentation changes;
the compatibility fixes only affect how discovered services are named and
grouped.
