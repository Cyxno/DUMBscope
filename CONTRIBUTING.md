# Contributing to DUMBscope

Issues and PRs are welcome. The project is deliberately narrow — reading
this page first saves everyone time.

## Priorities, in order

1. **Data correctness** — never render a guess as a fact; unknown is unknown.
2. **Security** — one container, no Docker socket, credentials never reach
   the browser, write paths are allowlisted and audited.
3. **Stability** — graceful degradation beats cleverness; DUMB being offline
   must degrade what is shown, never how DUMBscope serves.
4. **UI/UX**
5. **Simplicity**
6. **Performance**

## Ground rules

- **One container, one `/config` volume.** No external database, no sidecars,
  no Docker socket. If a change needs any of those, it needs an ADR first
  (see `docs/adr.md`).
- **The write surface is the Safe Actions allowlist** (`docs/ACTIONS.md`).
  New actions are added to the registry with structural target validation,
  audit-first persistence, the atomic claim (§13a) and cooldowns — nothing
  executes outside the registry.
- **Ask before adding dependencies**, and keep the production runtime
  dependency-free (the app ships as a single adapter-node build).
- **Observation-first**: detect-and-report, with sustained evidence and
  hysteresis, beats act-automatically.
- No telemetry, no third-party calls, no CDN assets.

## Development

```sh
pnpm install
pnpm dev                 # dev server (set DUMBSCOPE_CONFIG_DIR, e.g. ./data)
pnpm mock:dumb           # mock DUMB gateway on :3105
pnpm test                # unit + integration tests
pnpm check               # svelte-check
pnpm lint                # prettier + eslint
pnpm e2e                 # full e2e harness (ephemeral mock stack)
pnpm build               # production build
```

The e2e harness boots its own ephemeral stack (mock DUMB gateway, mock
Sonarr/Radarr/Bazarr/Plex/Overseerr, throwaway config) and tears everything
down afterwards — no real services and no production data are involved.

CI runs lint, typecheck, unit tests, the e2e suite and a Docker smoke test.
PRs should keep all of those green and include tests for behavior changes.

## Releases

Releases are cut from `main` by pushing a `vX.Y.Z` tag — the release CI
validates tag/version/changelog identity before anything is built
(`docs/RELEASING.md`). Exact release tags are immutable; a failed release is
corrected with a new version.
