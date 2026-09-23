# DUMBscope Architecture

> One repo, one image, one container, one Node/SvelteKit application, one
> embedded SQLite database, one config volume. That constraint is the design.

DUMBscope is a self-hosted observability control center for
[DUMB (Distributed Unlimited Media Bridge)](https://github.com/I-am-PUID-0/DUMB).
It talks to the published DUMB gateway on port **3005** (REST + WebSockets),
never touches the Docker socket, and never exposes DUMB credentials to the
browser.

```
Browser
   │  HTTPS (session cookie)
   ▼
DUMBscope  ── one SvelteKit (adapter-node) process ──
   │        ├── hooks: auth guard, security headers, CSRF
   │        ├── SSE fan-out  ◄──┐
   │        ├── incident engine │
   │        ├── telemetry hub   │ (normalize → cache → broadcast)
   │        └── SQLite /config/dumbscope.db
   │  REST + WS (Bearer JWT)
   ▼
DUMB gateway :3005
```

## Layers

```
src/
├── lib/
│   ├── types.ts                  shared domain model (server + client)
│   ├── shared/                   data usable on both sides (service catalog)
│   ├── server/
│   │   ├── dumb/                 DUMB API client
│   │   │   ├── client.ts         REST + auth (login, refresh-on-401)
│   │   │   ├── streams.ts        outbound WS with backoff + jitter + stale
│   │   │   ├── normalize.ts      raw payload → domain types (tolerant)
│   │   │   ├── capabilities.ts   feature gating
│   │   │   └── types.ts          raw DUMB shapes (all-optional fields)
│   │   ├── telemetry/
│   │   │   ├── hub.ts            shared live state + SSE fan-out singleton
│   │   │   └── activity.ts       observed-fact activity feed
│   │   ├── incidents/
│   │   │   ├── engine.ts         thresholds, hysteresis, dedup, reopen
│   │   │   ├── correlate.ts      (inside engine) dependency root-cause
│   │   │   ├── fingerprint.ts    stable per-failure-class identity
│   │   │   ├── repository.ts     SQLite persistence
│   │   │   └── tuning.ts         all magic numbers, documented
│   │   ├── topology/graph.ts     dependency graph from the service catalog
│   │   ├── integrations/
│   │   │   ├── registry.ts       adapter registry, generic fallback
│   │   │   └── catalog.ts (shared/) known-service metadata
│   │   ├── logs/parse.ts         DUMB log line parser
│   │   ├── database/             node:sqlite, versioned migrations
│   │   ├── security/             scrypt, AES-256-GCM, sessions, rate limit,
│   │   │                         origin checks, setup-session signing
│   │   └── config/settings.ts    DB-backed settings (+ DUMB_URL env seed)
│   ├── stores/live.svelte.ts     client SSE state (capped buffers)
│   ├── components/               design system + shell + topology + charts
│   └── utils/                    formatting, status semantics
└── routes/                       pages + JSON/SSE API
```

## Key decisions (see docs/adr/ for rationale)

| Decision                               | Why                                                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single SvelteKit process               | One-container requirement; SQLite and SSE remove the need for external infra.                                                                                          |
| DUMB gateway :3005 only                | Official published API surface; the native backend on :8000 stays internal.                                                                                            |
| One server-side connection set         | The hub holds one REST session + three WebSockets regardless of browser tabs; the browser gets one SSE stream per tab.                                                 |
| SSE instead of browser WebSockets      | Simpler, proxy-friendly, auto-reconnect for free; fan-out is a per-process `Set` of subscribers.                                                                       |
| No Docker socket                       | DUMB already reports process state, health, restarts, metrics and logs. Root-equivalent access is unjustifiable for a viewer.                                          |
| SQLite via `node:sqlite`               | Zero native dependencies (nothing to compile), synchronous API fits the access patterns, WAL mode.                                                                     |
| JWT handling server-side               | DUMB tokens are queried-params on WS URLs — that must never touch a browser. Tokens live only in hub memory; long-lived credentials are AES-256-GCM encrypted at rest. |
| Incident engine with grace periods     | A service unavailable for two seconds must never page anyone. All thresholds live in `incidents/tuning.ts` with comments.                                              |
| Adapter registry with generic fallback | Unknown/new DUMB services still appear everywhere; deep integrations can degrade without breaking monitoring.                                                          |

## Realtime data flow

1. `Hub.start()` reads settings, creates a `DumbClient` and three `DumbStream`s
   (`/ws/status?health=true`, `/ws/metrics?bootstrap=true`, `/ws/logs`).
2. Streams reconnect with exponential backoff + jitter; state is per-stream
   (`connecting | live | reconnecting | stale | offline`), aggregated into a
   connection snapshot that also distinguishes `credentials-invalid`.
3. Every payload is normalized (`dumb/normalize.ts`) into the domain model;
   unknown fields map to `unknown`, never crash.
4. The hub keeps: services map, metrics ring (~1h), log ring (5000 lines),
   incident state. Each update is broadcast to SSE subscribers
   (`connection`, `services`, `metrics`, `log`, `incident`, `activity`).
5. The incident engine consumes the same updates. Signals need sustained
   confirmation (N consecutive observations or a grace period) before an
   incident opens; resolution requires sustained recovery; re-occurrence bumps
   `occurrences` on the same row (fingerprint-keyed, DB-unique while active).
6. Correlation walks the dependency graph: incidents whose service depends on
   another active incident get `rootCauseService`; the root incident
   accumulates every downstream service it knocked out.

## First-run & security

- When no admin exists, DUMBscope prints a **setup code** to the container log
  (valid 30 minutes). The wizard requires it before anything else; verification
  is rate-limited and the resulting setup session is a short-lived HMAC cookie.
- The admin password is stored as a salted **scrypt** hash.
- DUMB credentials are stored **AES-256-GCM**-encrypted under a local key at
  `/config/secret.key` (0600, generated on first use).
- Sessions: random token, only its SHA-256 is stored, HttpOnly + SameSite=Lax
  cookie, `Secure` only behind an explicitly trusted proxy
  (`DUMBSCOPE_TRUST_PROXY=true` + `X-Forwarded-Proto: https`).
- Every response carries hardening headers; SvelteKit CSP runs in hash mode.
- Mutating API requests are checked for same-origin in addition to cookies.
- Control-plane actions towards DUMB are allowlisted to three Safe Actions
  (search-again, refresh, restart for a managed Sonarr/Radarr; docs/ACTIONS.md)
  plus DUMB's own single-service restart route behind the remediation manager.
  Each requires an admin session, same-origin and confirmation, and is
  audit-first; everything else stays read-only.

## Health semantics

Two public probes with distinct contracts (v0.8.1):

- `GET /api/health/live` — **liveness**. The handler running _is_ the check:
  process up, event loop answering. It consults no dependency, so a broken
  database or an offline DUMB can never fail it. The Docker `HEALTHCHECK`
  uses this endpoint; Docker restarts the container when it stops answering.
- `GET /api/health/ready` — **readiness**. Answers "can this instance serve
  requests": SQLite answers a trivial query, the telemetry hub is
  initialized, and the housekeeping heartbeat (10 s interval) is fresh
  within 45 s. Returns 503 with the failing checks. DUMB connectivity is
  reported informationally and never gates readiness — a DUMB outage must
  degrade what DUMBscope _shows_, not whether it serves.

The hub stamps a heartbeat on every housekeeping tick; the runtime sampler
(15 s, independent interval) watches that heartbeat and the reconciliation
runner's in-flight cycle, opening `self:housekeeping` / `self:recon-stuck`
incidents through the normal engine with hysteresis. What this watchdog
layer cannot observe is total process death or a fully starved event loop —
by then its own timer is dead too; that failure class belongs to external
supervision (the liveness HEALTHCHECK + container restart policy).

## Database schema

`settings`, `users`, `sessions`, `incidents` (lifecycle metadata:
`detector`, `last_evaluated_at`, `last_evidence_at`, `acknowledged_at`,
`resolution_kind`, `resolution_reason`), `incident_events`,
`health_transitions`, `service_events`, `integrations`, `activity`,
`media_snapshots`, `memory_samples` (+ `instance_key` and
`_5m`/`_30m` aggregate tiers), `media_acquisitions`,
`remediation_actions`, `notification_*`, `integration_actions`,
`runtime_samples` (+ `_5m`/`_30m` tiers), `schema_version`. Migrations
are versioned, transactional and run automatically on startup. Log content and
media titles are never persisted; DUMB's own log redaction is applied before
DUMBscope ever sees bytes.

## Pipeline presentation layer (ux/pipeline-overhaul)

Domain data and presentation are separated deliberately:

```
DUMB discovery/status
  → hub → buildTopology()  (domain: nodes + explicit edges only)
  → SSE 'topology' → live store
  → buildPipelineModel()   (src/lib/pipeline/model.ts — the ONE viewmodel:
                             stage mapping, friendly naming, semantic status,
                             ghost/infrastructure handling, failure propagation)
  → renderers              (DesktopPipeline / MobilePipeline / PipelineSummary /
                            Services grouping — projections of the same model)
```

`buildTopology()` resolves **only explicit catalog dependencies** into service
edges; category-level relationships are expressed as stage-to-stage trunks in
the viewmodel instead of invented service edges. `?demo=failure` / `?demo=stale`
are read-only rendering overrides for QA (see `pipelineDemoFromUrl`).
