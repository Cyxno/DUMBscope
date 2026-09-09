# Security Policy

DUMBscope is a self-hosted, network-exposed dashboard. This document explains
the security model, the guarantees v0.1 makes, and how to report problems.

## Threat model

DUMBscope runs on a home network, may be exposed through a reverse proxy, and
holds credentials that unlock a system (DUMB) that manages services and mounts.
The design assumes:

- The host running DUMBscope and the DUMB gateway are on a trusted LAN.
- The operator may expose DUMBscope via HTTPS reverse proxy to the outside.
- An attacker with LAN access should not be able to read DUMB secrets, take
  over the dashboard, or pivot into DUMB.

## Guarantees in v0.1

### DUMB credentials

- **Never sent to the browser.** The browser talks only to DUMBscope; all
  REST/WebSocket traffic to DUMB happens server-side. DUMB's WebSocket auth
  (JWT in a query parameter) never appears in any page, script or API response.
- **Encrypted at rest** with AES-256-GCM. The key is a random 32-byte file at
  `<config>/secret.key`, created with mode `0600` on first use. The ciphertext
  envelope is versioned (`v1:<iv>:<tag>:<ciphertext>`).
- **Never logged.** Logging of secrets is avoided structurally; diagnostics
  bundles are redacted (host:port only, no credentials, no log content).

### Accounts & sessions

- The admin password is stored as a salted **scrypt** hash (N=32768, r=8,
  per-password salt, constant-time comparison). The plaintext never touches
  disk.
- Sessions are 32-byte random tokens; the database stores only their SHA-256.
  Cookies are `HttpOnly`, `SameSite=Lax`, path-scoped, and expire after 7 days
  (sliding). `Secure` is set **only** when `DUMBSCOPE_TRUST_PROXY=true` and the
  proxy reports HTTPS — otherwise forwarded headers are ignored so plain-HTTP
  LAN installs stay safe by default.
- Logout destroys the server-side session, not just the cookie.

### First-run setup

- When unconfigured, DUMBscope prints a random 8-character **setup code** to
  the container log, valid for 30 minutes. The wizard requires it before it
  will test connections or create the admin account.
- Setup code verification is rate limited (10 attempts / 15 min / IP); the
  resulting setup session is a short-lived HMAC-signed cookie that grants
  access to the setup endpoints only and is deleted after completion.

### API hardening

- All state-changing requests require a session **and** pass a same-origin
  check (Origin/Referer must match the request host).
- Login and setup endpoints are rate limited with lockout windows.
- All responses carry `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`,
  `frame-ancestors 'none'` (via CSP), a restrictive `Permissions-Policy`, and a
  CSP in hash mode with `default-src 'self'` — no CDN, no inline scripts beyond
  framework-hashed ones, no third-party code.
- Input validation everywhere (Zod schemas + URL validation). The DUMB URL
  must be http(s), may not embed credentials or query strings.
- `/api/health` is the only unauthenticated endpoint and exposes nothing but
  `status`/`dumb`/`version`.
- No `eval`, no shell endpoints, no filesystem browsing, no arbitrary command
  execution anywhere in the codebase.

### Read-only towards DUMB

v0.1 has no endpoints that mutate DUMB state — no start/stop/restart, no
config writes. The DUMB integration surface is limited to documented GET
endpoints plus the three read-only WebSocket streams. Lifecycle controls, if
ever added, will require explicit opt-in, capability detection, an allowlist
and confirmation.

### Privacy

No telemetry, analytics, error reporting, CDN resources or external fonts.
DUMBscope makes outbound connections to exactly one host: your DUMB gateway.
Log content passes through DUMB's own redaction before DUMBscope receives it,
and DUMBscope does not persist log contents at all.

## Reporting a vulnerability

Please open a GitHub security advisory (Security → Report a vulnerability) or
contact the maintainer directly. Include reproduction steps and affected
version/commit. Do not open public issues for exploitable findings.

## Known limitations (not hidden, just honest)

- Session revocation is all-or-nothing per logout; there is no admin UI to
  list/revoke individual sessions yet.
- `secret.key` protects data at rest against casual copying (e.g. backups) but
  not against an attacker with root on the host — nothing can.
- The setup code and session store live in one process; there is no cluster
  mode by design (see ADR-001).
