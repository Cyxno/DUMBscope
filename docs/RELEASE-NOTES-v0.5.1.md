# DUMBscope 0.5.1 — Library tab navigation fix

Patch release. Fixes one release-blocking regression in the Library tabs and
adds a hard regression suite so it cannot come back. No other behaviour
changes; the diff touches only Library view state, tab navigation and tests.

## Fixed

- **Library tab clicks did nothing** (v0.5.0 regression, release-blocking).
  Clicking TV / Movies / Subtitles / Queue after opening Library → Overview
  changed the address bar but never switched the rendered panel: the tab
  handler relied on SvelteKit's shallow-routing `replaceState()` to update
  `page.url`, which it never does — so the URL→view effect never re-ran and
  the view stayed on Overview. Tab switching now adopts the view immediately
  and performs a real `goto()` navigation, which makes the URL the source of
  truth again: clicks, deep links, refresh and browser back/forward all stay
  in sync. The configured default Library tab still applies only when no
  explicit `?view=` is present and never overrides an explicit tab choice.
- **`each_key_duplicate` crash on the Queue tab**: two identical queue issues
  from the same integration (e.g. two Radarr downloads flagged "Download
  needs attention" — seen in production) collided on the `{#each}` key and
  threw an uncaught render error. Keys are now unique per entry.

## Tests

- New e2e regression suite (`tests/e2e/library-tabs.spec.ts`): full
  click-through journey with panel-content assertions (not just URL),
  duplicate-queue-issues render, immediate click after load, deep links,
  invalid view fallback, refresh persistence, back/forward, default-tab
  preference semantics (default applies on entry, never fights explicit
  views or refresh), drawer interplay across tab switches, and a mobile
  390×844 flow — all asserting a clean console (no uncaught exceptions).
