# DUMBscope 0.6.0 — Alerts & Notifications

New alerts layer: findings, warnings, incidents and recoveries can now be
forwarded to Browser, Discord and Telegram — with per-rule filters, dedupe
with cooldown, quiet hours, per-destination rate caps and a bounded delivery
queue. Built entirely on the existing incident/finding lifecycle: no new
monitoring logic was added.

## Highlights

- **Destinations**: Discord webhook (rich embed with severity colour, service,
  event, time and deep link), Telegram bot (compact message), and in-app
  browser notifications (delivered while the app is open; desktop notification
  only after the user explicitly grants the browser permission; click opens
  the relevant page).
- **Rules & presets**: Critical only / Warnings + Critical / Operations /
  Everything / Custom. Filters per rule: severity, category (connectivity,
  mount, memory, media-state, service, storage, incident), optional service
  allowlist, and event type (opened / escalated / resolved / reopened —
  recovery notifications are a first-class event).
- **Dedupe & cooldown**: first open notifies; repeats at the same or lower
  severity are suppressed; severity increases notify as escalations;
  resolutions can notify; a finding that returns inside the rule's cooldown is
  suppressed, after it notifies as a reopen.
- **Quiet hours** per rule (start / end / timezone, windows may cross
  midnight): critical always delivers; warnings defer by default;
  attention/info defer or suppress per rule. The browser destination is
  real-time only and suppresses non-critical during quiet hours.
- **Delivery**: bounded queue (200) with retry only on transient failures
  (429 / 5xx / timeout), exponential backoff, hard attempt cap. Per-destination
  rate cap (default 10/min) prevents alert storms. A failing destination never
  blocks another destination, findings, or the app.
- **History**: 30-day bounded record of every decision — sent, suppressed,
  deferred, rate-limited or failed — so the UI can explain both deliveries and
  silences.
- **Security**: Discord webhook URLs and Telegram bot tokens are encrypted at
  rest (AES-256-GCM application key) and are never returned to the browser —
  the UI shows masked representations only. The test button runs server-side
  against the stored configuration.
- **Settings → Notifications**: Destinations, Rules, Quiet hours & delivery,
  History. Optional public base URL for outbound deep links.

## Tests

- Unit suite (`tests/notifications.test.ts`, 20 tests): filter matching,
  severity/category/service matching, dedupe/escalation/resolution/reopen,
  quiet hours incl. critical bypass and invalid timezones, Discord/Telegram
  success and failure, retry and backoff, rate limiting, secret masking,
  browser pickup.
- E2E journey (`tests/e2e/notifications.spec.ts`): configures mock Discord/
  Telegram endpoints, walks a real memory finding through open → suppress →
  escalate → resolve → recovery, asserts delivery counts per channel, history
  completeness, masked secrets, the test button and the browser pickup flow.
