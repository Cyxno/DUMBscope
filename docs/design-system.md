# DUMBscope Design System

Dark-first, calm, premium. The interface should feel like a precision
instrument, not a dashboard template: quiet surfaces, semantic color, tabular
numbers, one accent used sparingly.

## Tokens (`src/app.css`)

All color/shape/motion values live as CSS custom properties on `:root`.
Utilities are generated through Tailwind v4's `@theme inline` mapping
(`bg-surface-1`, `text-muted`, `border-border-subtle`, …).

### Surfaces & elevation

| Token             | Dark      | Role                        |
| ----------------- | --------- | --------------------------- |
| `--bg`            | `#08090B` | app background              |
| `--surface-1`     | `#0D0F12` | cards, panels               |
| `--surface-2`     | `#13161B` | inputs, inner blocks, hover |
| `--surface-3`     | `#1A1E24` | raised hover, active chips  |
| `--border-subtle` | 6% white  | default borders             |
| `--border-strong` | 12% white | hover borders               |

Shadows are deep and soft (`--shadow-1..3`); translucency is reserved for the
topbar and drawers. No glowing glass tiles.

### Text

`--text-primary` (almost white), `--text-secondary`, `--text-muted`,
`--text-faint`. Body text is 13–14px; labels 10–11px uppercase with wide
tracking.

### Status color — semantic, never decorative

| Meaning              | Token                |
| -------------------- | -------------------- |
| Healthy              | `--healthy` (green)  |
| Degraded / starting  | `--degraded` (amber) |
| Critical / unhealthy | `--critical` (red)   |
| Unknown / stopped    | `--unknown` (grey)   |
| Live data / flow     | `--live` (cyan)      |

Each has a `*-soft` background tint for badges. Service brand logos appear only
in 36px icon containers; they never drive layout color.

### Accent

Default cyan; blue/indigo/violet selectable in Settings via `[data-accent]`.
The accent marks interactivity and live data — never entire panels.

## Themes

`dark` (default) → `oled` (pure black surfaces) → `light` (professionally
tuned, not inverted). Theme + accent are persisted server-side and applied via
`data-theme`/`data-accent` attributes on `<html>`.

## Typography

Geist / Inter / system stack (bundled, no CDN). All numerals in stats use
`.tnum` (tabular figures). Monospace (`--font-mono`) for logs, timestamps,
IDs, code.

## Motion

- Page content: small `fade`/`fly` on load (≤ 260 ms, `--ease-out`).
- Drawer: 260 ms fly from the right (mobile: full-screen sheet).
- Topology edges: a subtle dash-flow on healthy links only.
- Charts: width transitions on bars, no re-draw flicker.
- `prefers-reduced-motion` and the manual "reduce motion" switch collapse all
  animation to near-zero globally.

## Components

- **Card** (`Card.svelte`) — surface with optional header/actions; the only
  allowed container style. No uniform card grids: the overview uses an
  asymmetric bento layout.
- **StatusDot / HealthBadge** — the only two ways health is displayed.
- **ServiceIcon** — 36px icon tile, lucide glyph per known service, `Box`
  fallback for unknown services.
- **Drawer** — right sheet ≥768px, full-screen below; focus-trapped,
  Escape-to-close, backdrop click, scroll-locked.
- **TopologyView** — custom SVG. Category columns left→right following the
  media pipeline; bezier edges colored by upstream health (`╳` marker on
  failed); keyboard-accessible nodes.
- **AreaChart / Sparkline** — dependency-free SVG charts with hover crosshair.
- **CommandPalette** — ⌘/Ctrl+K; pages, services and actions in one list.
- **EmptyState** — quiet, text-first, no illustrations; used for all nine
  documented empty scenarios.

## Accessibility

Keyboard navigation everywhere (sidebar, drawers, topology nodes, log lines),
visible focus (`--border-focus`), `aria-current` on nav, `role="log"` for the
log viewer, status never encoded by color alone (always text + dot), and a
manual reduced-motion switch in addition to the media query.

## Content rules

UI copy is English; strings are centralized enough for a future i18n pass
(never inline concatenated sentences). Errors address the operator ("Could not
read DUMB service status. Last successful update: 14s ago."), never leak stack
traces, and always state what happens next ("DUMBscope will retry
automatically.").

## Pipeline principles (ux/pipeline-overhaul)

The Pipeline is a story of how media moves, not a dependency graph.

1. **Pipeline first.** Services are grouped into user-facing stages —
   Requests → Automation → Acquisition → Storage → Media — with Supporting
   beside the flow and Infrastructure hidden by default. Internal categories
   (`debrid`, `bridge`, `mount`, …) never surface in the UI.
2. **Flow over graph.** Stage-to-stage trunks are drawn instead of per-service
   edges. A category-level relationship must never become an edge between two
   arbitrary services; only explicit catalog dependencies may.
3. **Health is quiet.** A healthy service is a neutral card with a small green
   dot and no label. `Running` (process up, no health probe) is neutral
   blue-gray — never a warning, never "unknown".
4. **Problems are prominent.** Root cause is red; downstream services are
   amber ("May be affected"); the trunk breaks (`╳`) after the failing stage.
   A correlated incident shows the root-cause banner above the pipeline.
5. **Full names over compactness.** Primary service names never truncate or
   ellipsize; internal identifiers are never user-facing. Canonical naming
   comes from the catalog and is identical in Pipeline, Overview, Services
   and the drawer.
6. **One semantic status model.** `healthy / degraded / critical / offline /
running / affected / stale` — derived centrally (`pipelineStatusFor`),
   consumed by hero, pipeline, services and drawer alike.
7. **Mobile is vertical.** Below `lg` the same PipelineViewModel renders as a
   vertical operational timeline. The desktop layout is never scaled down.
8. **Progressive disclosure.** `Simple` (default) hides never-running entries
   and infrastructure; `Detailed` reveals them. `?demo=failure` / `?demo=stale`
   render synthetic stories read-only for QA.
