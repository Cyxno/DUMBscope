<div align="center">

<img src="static/favicon.svg" width="72" alt="DUMBscope logo">

# DUMBscope

**Observe your entire DUMB media stack.**

A self-hosted control center for DUMB (Distributed Unlimited Media Bridge):
realtime service health, dependency topology, correlated incidents, live logs
and system metrics — in one calm, dark interface.

One container. One `/config`. No Docker socket. No external database. No telemetry.

</div>

---

## What is DUMBscope?

DUMBscope answers, at a glance:

- Is my DUMB stack healthy?
- Which service is degraded or unhealthy — and **why**?
- Which other services are affected (root-cause correlation)?
- What is happening right now (realtime status, metrics, logs)?
- What happened around a past incident?

It connects to the published **DUMB gateway on port 3005** (REST + WebSockets),
mirrors what DUMB reports into a normalized, correlated view, and adds an
incident engine with fingerprints, deduplication and dependency-aware root-cause
analysis. It is a companion to DUMB — not a replacement for its configuration
UI, and strictly read-only towards your stack in v0.1.

## Screenshots

See [docs/screenshots](docs/) (added in the release notes) for the overview,
pipeline, incidents, logs and mobile views.

## Features

- **Overview** — stack health headline, live media-pipeline topology, bento
  cards (health, resources, incidents, resource history).
- **Pipeline** — automatic dependency graph of _your_ stack: requests →
  managers → indexers → debrid/bridge → mount → media server. Unknown services
  appear as generic nodes; nothing is hardcoded to one layout.
- **Services** — auto-discovered from DUMB; health, run state, CPU/RAM,
  restart statistics, drawer with details; card & compact list views, instant
  search and filters.
- **Incidents** — sustained-failure detection with grace periods and
  hysteresis (no flapping), fingerprint-based deduplication with occurrence
  counts, dependency correlation ("root cause: PostgreSQL"), timeline,
  evidence, one-click log context.
- **Logs** — realtime stream from all DUMB services, level/service filters,
  search, pause/resume, autoscroll, copy, incident deep-links, capped ring
  buffers server- and client-side. DUMB's log redaction is preserved.
- **System** — CPU/memory/disk/network streamed from DUMB, short-range live
  ring plus DUMB's own history series (1h/6h/24h), per-process metrics,
  database health observations.
- **Activity** — an append-only feed of observed facts (health transitions,
  restarts, connection changes). Nothing invented.
- **Command palette** (⌘/Ctrl+K), collapsible sidebar, three themes (dark,
  OLED, light), four accents, responsive mobile layout.
- **Security** — setup-code first run (code printed to the container log),
  admin accounts (scrypt), server-side sessions, encrypted DUMB credentials at
  rest (AES-256-GCM), CSP and hardening headers, rate limiting, same-origin
  checks. See [SECURITY.md](SECURITY.md).

## Architecture

One SvelteKit (Node, adapter-node) process holds a single server-side
connection to DUMB and fans out to browsers via SSE:

```
Browser ──SSE──► DUMBscope (hub: normalize · correlate · cache · incidents)
                     │ REST + 3× WebSocket (Bearer JWT, server-side only)
                     ▼
              DUMB gateway :3005
```

Details in [docs/architecture.md](docs/architecture.md) and
[docs/adr.md](docs/adr.md); design tokens in
[docs/design-system.md](docs/design-system.md).

### Supported DUMB capabilities

DUMBscope feature-detects everything through `GET /process/capabilities` and
degrades gracefully: missing metrics history, missing startup lifecycle or
missing database-health support disables the relevant UI path instead of
breaking the dashboard. Any DUMB-managed service is monitored generically the
moment it appears.

## Installation (Unraid)

1. Add the container from the template (`unraid/dumbscope.xml`) or run it
   directly:

```bash
docker run -d \
  --name dumbscope \
  --restart unless-stopped \
  -p 8091:8091 \
  -e PUID=99 -e PGID=100 -e UMASK=022 \
  -v /mnt/user/appdata/dumbscope:/config \
  ghcr.io/cyxno/dumbscope:latest
```

2. Open `http://HOST:8091`.
3. Copy the **setup code** from the container log (`docker logs dumbscope`).
4. Follow the wizard: DUMB URL (e.g. `http://192.168.1.2:3005`) → test →
   DUMB credentials (if enabled) → create your admin account.

### Docker Compose

```yaml
services:
  dumbscope:
    image: ghcr.io/cyxno/dumbscope:latest
    container_name: dumbscope
    restart: unless-stopped
    ports:
      - '8091:8091'
    environment:
      - PUID=99
      - PGID=100
      - UMASK=022
      # - DUMB_URL=http://192.168.1.2:3005   # optional pre-set for the wizard
      # - DUMBSCOPE_TRUST_PROXY=true         # only behind an HTTPS reverse proxy
    volumes:
      - /mnt/user/appdata/dumbscope:/config
```

## Configuration

Runtime state lives under `/config`:

| File           | Purpose                                                 |
| -------------- | ------------------------------------------------------- |
| `dumbscope.db` | settings, users, sessions, incident history, activity   |
| `secret.key`   | local key that encrypts DUMB credentials at rest (0600) |

Environment variables:

| Variable                  | Default              | Purpose                                                                |
| ------------------------- | -------------------- | ---------------------------------------------------------------------- |
| `PORT`                    | `8091`               | web UI port                                                            |
| `PUID` / `PGID` / `UMASK` | `99` / `100` / `022` | runtime identity for `/config`                                         |
| `DUMB_URL`                | —                    | optional seed for the wizard's DUMB URL                                |
| `DUMBSCOPE_TRUST_PROXY`   | `false`              | trust `X-Forwarded-Proto` for Secure cookies (behind HTTPS proxy only) |
| `DUMBSCOPE_CONFIG_DIR`    | `/config`            | config location                                                        |
| `DUMBSCOPE_SETUP_CODE`    | —                    | pre-set setup code instead of the random one                           |

### Reverse proxy

Terminate HTTPS at your proxy and set `DUMBSCOPE_TRUST_PROXY=true` so session
cookies get the `Secure` flag. Without it, forwarded headers are ignored —
direct HTTP installs stay safe by default. Example Nginx location:

```nginx
location / {
    proxy_pass http://127.0.0.1:8091;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Connection "";   # keep SSE working (no buffering!)
    proxy_buffering off;
}
```

## Updating

```bash
docker pull ghcr.io/cyxno/dumbscope:latest
# then recreate the container (Unraid: update via the Apps/Docker tab)
```

`/config` persists. Database migrations run automatically and transactionally
on startup. DUMBscope never auto-updates itself.

## Security

See [SECURITY.md](SECURITY.md) for the full model: what is stored, how
credentials are encrypted, session handling, and how to report an issue.
Highlights: no Docker socket, no telemetry, no external calls, DUMB
credentials never leave the server process, read-only towards DUMB.

## Troubleshooting

| Symptom                         | What to do                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Setup code rejected             | It expires after 30 minutes; restart the container for a new one (also printed again in the log).                                |
| “DUMB is currently unreachable” | Check the gateway URL (port **3005**), network, and that DUMB is up. DUMBscope keeps retrying; history and settings stay usable. |
| “DUMB credentials rejected”     | Update username/password in Settings → DUMB connection. Credentials are verified before being saved.                             |
| Metrics/chart empty             | DUMB may not expose the metrics capability; check Settings → Diagnostics and DUMB's own dashboard.                               |
| No logs appearing               | The log stream reconnects automatically after DUMB restarts; check Settings → Diagnostics for stream states.                     |

Diagnostics → **Copy diagnostics** produces a redacted bundle (no credentials,
no URLs beyond host:port, no log contents) for bug reports.

## Development

```bash
pnpm install
pnpm dev                 # dev server (set DUMBSCOPE_CONFIG_DIR, e.g. ./data)
pnpm mock:dumb           # mock DUMB gateway on :3105 (scenarios, see file)
pnpm test                # unit + integration tests (uses the mock)
pnpm check               # typecheck
pnpm lint                # prettier + eslint
pnpm build               # production build
```

The mock gateway (`tests/mock-dumb/server.mjs`) implements the documented DUMB
API and supports scenarios: `healthy`, `degraded`, `crash-loop`,
`dependency-failure`, `log-burst`, `disk-full`, plus `MOCK_AUTH=off` and
`MOCK_POSTGRES_DOWN=1`. CI runs the whole suite plus a Docker smoke test on
every PR.

## Contributing

Issues and PRs are welcome. Keep the priorities in order: **data correctness →
security → stability → UI/UX → simplicity → performance**. Ask before adding
dependencies, and keep the one-container constraint.

## License

[MIT](LICENSE)
