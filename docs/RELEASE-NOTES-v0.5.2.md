# DUMBscope 0.5.2 — sidebar navigation fix

Patch release. Fixes a navigation regression introduced by the v0.5.0
customization work and hardens stored navigation preferences. No other
behaviour changes; the diff touches only the canonical nav definition,
preference normalization, the sidebar render and tests.

## Fixed

- **Sidebar rendered Incidents/Logs/Activity/System twice** (v0.5.0
  regression, found on v0.5.1). When navigation became preference-driven, the
  Monitor section was built from the full ordered preference list (all eight
  routes) instead of only its own group, while Operate rendered its own
  subset — so the four Operate routes appeared under both headers and two
  links carried `aria-current="page"` at once. Section membership now comes
  from the canonical navigation config: preferences may only reorder routes
  within their section and hide them — never duplicate or relocate them.
  Every visible route renders exactly once.
- **Stored navigation orders are normalized on load** (defence in depth):
  duplicate ids are dropped, unknown ids are removed, and canonical routes
  the stored list never mentioned are appended in default order. Existing
  browsers heal automatically on the next page load; clearing localStorage is
  never required.

## Tests

- New unit suite (`tests/navigation.test.ts`): canonical config uniqueness,
  disjoint Monitor/Operate sections, default grouping, duplicate/unknown/
  empty/partial stored orders, visibility, in-section ordering, reset.
- New e2e suite (`tests/e2e/navigation.spec.ts`): per-route render counts,
  section assertions, single active item, hydration (single set straight
  after load), hide + deep-link reachability, custom order, corrupt stored
  preferences, compact/icons sidebar modes, mobile drawer and reload
  persistence — all asserting a clean console.
