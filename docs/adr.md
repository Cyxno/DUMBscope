# Architecture Decision Records

Short records of the choices that shape DUMBscope. Each entry: context →
decision → consequence.

## ADR-001 — Exactly one container

**Context:** The app must run on a home Unraid server without operational
burden. Multi-container stacks (separate API/worker/DB/proxy) multiply update
surface, memory and failure modes for zero benefit at this scale.

**Decision:** One image, one Node process (SvelteKit adapter-node), embedded
SQLite, in-process scheduler and SSE fan-out. Only `/config` is a persistent
volume.

**Consequence:** No Redis/Postgres/nginx containers. Scaling past one node is
explicitly out of scope; if that day comes, the hub interface is the seam to
replace.

## ADR-002 — DUMB gateway on :3005 is the only integration surface

**Context:** DUMB publishes a frontend/API gateway on :3005 and a native
backend on :8000 that is meant to stay internal/loopback.

**Decision:** DUMBscope only speaks to `http(s)://<host>:3005` (`/api/...`,
`/ws/...`). Port 8000 is never contacted.

**Consequence:** Works with the standard deployment and behind NAT/container
boundaries; behavior verified against the documented API bundled with DUMB.

## ADR-003 — No Docker socket

**Context:** Container-level monitoring usually means mounting
`/var/run/docker.sock`, which is root-equivalent on the host.

**Decision:** DUMBscope does not mount the socket and never will by default.
Everything it shows derives from DUMB's own API (process state, health probes,
restart counters, metrics, logs).

**Consequence:** No container-restart/stop features in v0.1 — a deliberate
read-only posture. Host-level Docker integration would be an explicit,
opt-in future feature.

## ADR-004 — Backend proxy; DUMB credentials never reach the browser

**Context:** DUMB WebSockets authenticate via a JWT **query parameter**, which
must not leak into browser history/logs of third parties; storing tokens in
client JS would widen the attack surface.

**Decision:** Only the server holds and refreshes tokens/credentials. The
browser talks exclusively to DUMBscope and receives one SSE stream. Persistent
DUMB credentials are AES-256-GCM encrypted at rest with a per-install key
(`/config/secret.key`).

**Consequence:** A small amount of state fan-out code in the hub; in exchange,
the security model is easy to reason about.

## ADR-005 — SSE for browser-facing realtime

**Context:** DUMB exposes WebSockets upstream. Options downstream: a second
WebSocket server, or SSE.

**Decision:** SSE (`/api/stream`, one per browser tab). EventSource
auto-reconnects for free, works through reverse proxies without upgrade
headers, and fits the one-way broadcast shape of the data.

**Consequence:** No client→server realtime channel exists; that is fine for a
read-only product.

## ADR-006 — SQLite via `node:sqlite` and versioned migrations

**Context:** State to persist: settings, users/sessions, incidents, activity.
No external DB is allowed.

**Decision:** Embedded SQLite through Node's built-in `node:sqlite`
(`DatabaseSync`), WAL mode, transactional versioned migrations. No native
module compilation.

**Consequence:** Zero build-time dependencies for the database layer; the
runtime image is tiny. DB backups before risky migrations can be added to
`/config/backups` later.

## ADR-007 — Adapter registry with a generic fallback

**Context:** DUMB manages a growing list of services. DUMBscope must show a
brand-new service today, and a rich view for known ones later.

**Decision:** `src/lib/server/integrations` holds a catalog of known services
(category, icon, dependencies) and an adapter registry. Every unknown service
falls back to the generic adapter; a broken adapter can never break generic
monitoring (`safeSummary`).

**Consequence:** Deep integrations (querying Sonarr's own API, etc.) slot into
the registry without architectural change.

## ADR-008 — GitHub is the source of truth

**Context:** Production must be reproducible; no hand-patched images.

**Decision:** All code lives in `Cyxno/DUMBscope`. CI runs lint/typecheck/
tests/build and a Docker smoke test per PR; tags build multi-arch images and
push `ghcr.io/cyxno/dumbscope:<semver>`. Production on Unraid pulls only
published GHCR tags.

**Consequence:** Local builds are for development only; the running container
must always match a git tag.
