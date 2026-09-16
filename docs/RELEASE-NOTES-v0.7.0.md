# DUMBscope 0.7.0 — Safe Actions / control plane

The first functional layer on top of observability: a **deliberately narrow,
allowlist-only control plane**. From the Library you can now act on the gaps
DUMBscope already shows you — search a missing episode, search a season,
refresh a series or movie — and from the service drawer you can open a
service's web UI or restart it through DUMB's own management route.
Full documentation: [docs/ACTIONS.md](ACTIONS.md).

## Safe Actions

- **Targeted Sonarr commands** — `Search again` (exact episode), `Search
season` (season rows with missing episodes) and `Refresh series`, executed
  through Sonarr's official command API with exact upstream ids.
- **Targeted Radarr commands** — `Search again` and `Refresh` on missing
  movies via the official command API.
- **Open {Service}** — deep links into each service's own web UI: Sonarr
  series pages (`/series/{titleSlug}`), Radarr movie pages
  (`/movie/{tmdbId}`), service root as fallback. Per-integration optional
  **public URL** plus an **Auto / Internal / Public** link preference for
  home vs reverse-proxy access. Links are http(s)-only, open in a new tab and
  never embed credentials.
- **Restart service** — in the service drawer behind an explicit
  confirmation; reuses the existing remediation layer unchanged (allowlist,
  preflight, 6 h cooldown, attempt caps, audit, post-conditions
  verification). Still never a container restart.
- **Honest semantics** — `Search requested` ≠ `media found`: actions report
  accepted → completed / failed / unconfirmed, with named upstream errors
  (authentication failed, command rejected, timed out, unsupported version).
  Bounded command follow-up (~20 s window) — no endless polling.
- **Capability-gated UI** — buttons render from per-instance published
  capabilities (`canSearchEpisode`, `canSearchMovie`, …), never hardcoded
  names; services without commands show none.
- **Multi-instance routing** — actions name the exact integration instance
  (`sonarr-main`, `sonarr-anime`, `radarr-4k`, …); server resolves by stable
  id, type-checked, never first-match.
- **Audit-first history** — every attempt persisted before execution (actor,
  target, result, upstream command id; no secrets) and surfaced in a new
  **Activity → Recent actions** card. 14-day retention, bounded view.
- **Guardrails** — admin session + same-origin + rate limit (10/min) on the
  actions endpoint; per-target cooldowns (60 s search / 120 s refresh);
  per-action structural validation (positive integer ids only).

## Non-goals (unchanged)

No Docker socket, no shell/exec, no arbitrary REST client, no generic
"call any Arr endpoint" action, no bulk "search all missing", no automatic
(non-user-initiated) actions. Queue manipulation (retry/remove/blocklist)
remains a documented follow-up, not an implementation.

## For operators

- New config: optional **public URL** per integration
  (Settings → Integrations) and the **link preference**
  (Settings → Integrations → "Open links using").
- Database migration 8 adds the `integration_actions` audit table and the
  `integrations.public_url` column; it runs automatically on first start.
- API additions: `POST/GET /api/actions`, `GET /api/actions/[id]`;
  `PUT /api/integrations/[id]` accepts `publicUrl`; `PATCH /api/settings`
  accepts `linkOpenPreference`; `GET /api/integrations` now includes per
  instance `actions` capabilities.

## Tests

- New unit suite `tests/actions.test.ts` (16 cases): registry allowlist,
  target validation, audit-first ordering, multi-instance routing, cross-type
  rejection, cooldowns and their expiry, honest upstream error naming,
  bounded follow-up to `unconfirmed`, secret-free audit, deep-link/scheme
  guards.
- New e2e suite `tests/e2e/actions.spec.ts`: Library missing-episode flow
  (search → accepted → history entry), missing-movie flow with TMDB deep
  link, service-drawer open link + confirmed restart — all against the mock
  stack; the mock media servers gained a strictly allowlisted
  `/api/v3/command` surface for it.
