# Safe Actions — the DUMBscope control plane (v0.7.0)

DUMBscope started as pure observability. Safe Actions is a deliberately
narrow control plane on top: **explicitly allowlisted, user-initiated
actions** executed against your managed services — without turning DUMBscope
into a generic remote-control tool.

## Supported actions

| Action id              | Label (UI)      | Target               | Upstream call                             | Cooldown |
| ---------------------- | --------------- | -------------------- | ----------------------------------------- | -------- |
| `sonarr.searchEpisode` | Search again    | exact episode id(s)  | `POST /api/v3/command` → `EpisodeSearch`  | 60 s     |
| `sonarr.searchSeason`  | Search season   | series id + season # | `POST /api/v3/command` → `SeasonSearch`   | 60 s     |
| `sonarr.refreshSeries` | Refresh series  | series id            | `POST /api/v3/command` → `RefreshSeries`  | 120 s    |
| `radarr.searchMovie`   | Search again    | movie id             | `POST /api/v3/command` → `MoviesSearch`   | 60 s     |
| `radarr.refreshMovie`  | Refresh movie   | movie id             | `POST /api/v3/command` → `RefreshMovie`   | 120 s    |
| `service.restart`      | Restart service | managed process name | DUMB `POST /api/process/restart-service`  | 6 h      |
| `service.open`         | Open _Service_  | configured web URL   | none — direct browser navigation, new tab | —        |

That is the complete list. There is **no** generic "call an arbitrary Arr
endpoint" action, no Docker socket, no shell, no container exec, no bulk
"search all missing" (see [Non-goals](#non-goals)).

`service.restart` is _not_ a second implementation: it rides the existing
remediation layer unchanged (allowlist, preflight, server-side target
resolution, per-target lock, 6 h cooldown, attempt caps, audit-first
persistence, post-conditions verification) — see docs/REMEDIATION.md.

## Where the buttons live

- **Series drawer (Library → TV)** — _Refresh series_ in the header,
  _Search season_ on every season row that has missing episodes, and
  _Search again_ in a missing episode's expanded detail.
- **Movie drawer (Library → Movies)** — _Search again_, _Refresh_ and
  _Open in Radarr_ in the missing-movie context block.
- **Service drawer (Services / Pipeline)** — _Open {Service}_ and
  _Restart service_ (with confirmation) for every DUMB-managed service.
- **Activity** — a _Recent actions_ audit card listing every executed action.

Buttons render from the integration's **published capabilities**, never from
hardcoded names: a Sonarr instance shows episode/season/series commands, a
Radarr instance shows movie commands, everything else shows none.

## Honest semantics

Acceptance is **not** outcome. Clicking _Search again_ reports:

```
click → executing → accepted ("Search requested in Sonarr")
      → (bounded follow-up) completed / failed / unconfirmed
```

- `accepted` — Sonarr/Radarr accepted the command (HTTP 201 + command id).
- `completed` — the upstream command finished. This still does **not** mean
  media was found; watch the Library/Queue/media flow for the result.
- `failed` — upstream rejected or reported failure (named cause, see below).
- `unconfirmed` — accepted, but upstream did not report a final state within
  the ~20 s follow window; the command may still be running.

Upstream errors are named, never a generic "something went wrong":
authentication failures, HTTP 400 rejections, unsupported-version 404s,
timeouts and unreachable services all produce their own message.

## Open-service links

- The link target is **config, not code**: each integration has its API `url`
  (server-side polling) and an optional **public URL** (browser-facing web
  UI), editable in Settings → Integrations.
- Settings → Integrations → _Open links using_ — **Auto** (default: public
  URL when the browser is not on the internal host), **Internal**, or
  **Public**.
- Deep links are built only where a safe route exists from stable ids:
  Sonarr `/series/{titleSlug}`, Radarr `/movie/{tmdbId}`. Otherwise the link
  falls back to the service root.
- Links open in a new tab (`rel="noreferrer noopener"`). No credentials or
  tokens are ever embedded in a URL, and only `http:`/`https:` URLs are
  accepted (no `javascript:`, `file:`, `data:`).

## Security model

Every action is:

1. **Authenticated** — admin session required (the global hook rejects
   unauthenticated API calls; routes double-check `locals.user`).
2. **Same-origin** — non-GET API requests are verified against the Origin/
   Referer host by `hooks.server.ts`.
3. **Rate limited** — 10 actions per session per minute (429 beyond that).
4. **Allowlisted** — the action id must exist in the server-side registry;
   the target must pass per-action structural validation (positive integer
   ids only).
5. **Server-resolved** — the integration instance is looked up by exact
   stable id (`sonarr-main`, `radarr-4k`, …) and its type must match the
   action. Multi-instance stacks (Sonarr Default + Sonarr Anime, Radarr 4K)
   route to the exact instance — never first-match. The client can never
   name an arbitrary URL, endpoint, process or command.
6. **API-key safe** — the upstream key is decrypted server-side for the
   request and never stored in the audit, logged, or sent to the browser.

## Cooldowns

Per (integration instance, action, target) — anti double-click/spam, not a
safety gate:

- searches: 60 s
- refreshes: 120 s
- restarts: the remediation layer's existing 6 h cooldown + 2 attempts/24 h

A rejected cooldown attempt is audited as `rejected` but never extends the
cooldown. The UI surfaces remaining cooldown in the error message.

## Audit & history

Every attempt is persisted **before** any upstream request (audit-first, same
philosophy as remediation). One row per attempt in `integration_actions`:

```
id · action · integration_id · target · target_key · actor
· state · message · upstream_command_id · requested_at · finished_at
```

- Bounded view: the last 25 actions on **Activity → Recent actions**.
- Retention: 14 days (pruned opportunistically).
- No secrets: rows carry ids and plain-language messages only.

## Command follow-up (bounded)

After acceptance the server polls the upstream command status at most
10 × every 2 s (~20 s window) and settles the row on
`completed` / `failed` / `unconfirmed`. The UI polls the action endpoint a
bounded number of times too. There is no endless polling and no background
polling storm; monitoring cadences are unaffected.

## Capabilities

`GET /api/integrations` publishes per instance:

```
canSearchEpisode · canSearchSeason · canRefreshSeries   (sonarr)
canSearchMovie · canRefreshMovie                        (radarr)
```

plus URL availability for `service.open`. UI renders from these flags.

## API

- `POST /api/actions` — `{ actionId, integrationId, target }` →
  `{ id, state, message, upstreamCommandId, cooldownRemainingMs }`.
- `GET /api/actions` — recent audit trail (bounded).
- `GET /api/actions/[id]` — one action's current state.
- `PUT /api/integrations/[id]` — now accepts optional `publicUrl`.
- `PATCH /api/settings` — now accepts `linkOpenPreference`.

## Non-goals

Never built, by design:

- Docker socket integration, container exec, terminal/shell, host restart
- arbitrary REST client or generic "POST any endpoint" action
- bulk library operations (`Search all missing`, `Search entire library`)
- automatic (non-user-initiated) search, refresh or restart
- queue manipulation (retry/remove/blocklist) — tracked as a follow-up,
  only to be added with clear upstream semantics + confirmation

## Tests

- `tests/actions.test.ts` — registry allowlist + target validation, audit
  ordering, multi-instance routing, cross-type rejection, cooldowns, honest
  upstream error naming, bounded follow-up to `unconfirmed`, secret-free
  audit, link building and scheme guards.
- `tests/e2e/actions.spec.ts` — Library flows (episode search → accepted →
  history entry; movie search + deep link), service drawer (open link,
  confirmed restart) — all against the mock stack.
