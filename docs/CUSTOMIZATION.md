# Customization (DEEL 3)

How interface customization works, where it is stored, and what it intentionally
does not do.

## Information architecture

Settings is organized into sections (pill navigation at the top of the page):

```text
Connection · Appearance · Dashboard · Navigation · Library
Reliability · Data display · Accessibility · Integrations · About
```

No section is a settings-form-wall: each uses card-based selectors with live
previews and immediate apply. There is no save button for interface
preferences.

## Storage model (§96/§151)

| Layer | Scope | Contents |
| ----- | ----- | -------- |
| Browser-local (`localStorage`, versioned `dumbscope.prefs.v1`) | per browser | theme, accent, motion, density, chart palette, text size, contrast, focus outlines, transparency, status labels, sidebar mode, landing page, nav order/visibility, dashboard widgets/order/preset, library defaults, date/time style, units, status detail, technical ids |
| Account (SQLite `settings`) | per install | DUMB URL + credentials, stream intervals, reliability monitoring switches and memory thresholds, legacy `ui.theme`/`ui.accent`/`ui.reducedMotion` (kept as first-run seeds) |

- Existing users upgrade to exactly the current UI: every preference default
  reproduces the pre-customization look, and the stored account theme seeds the
  browser profile on first run (§100).
- Corrupt or partially-written preference JSON falls back to safe defaults;
  unknown fields are dropped and enum fields are re-validated (§101/§102).
- No database migration is required for customization (§151).

## What is customizable

- **Appearance** — Theme (System / Dark / OLED / Light; OLED is a real
  near-black derivative, not `#000` on the old palette), accent (cyan, blue,
  teal, emerald, indigo, violet, amber, orange, rose, slate — each with
  previews), density (Comfortable / Compact / Dense), chart palette (Default /
  Colorblind-friendly / Monochrome), motion (System / Reduced / Full).
- **Dashboard** — Overview widget visibility + order, with presets
  (Balanced / Media-focused / Operations / Minimal). A preset is a starting
  point; changes mark the layout `Custom`. Constrained layout only — no
  freeform grid builder (§28).
- **Navigation** — Sidebar mode (Expanded / Compact / Icons-only; icons-only
  keeps accessible labels + tooltips), default landing page (root navigation
  opens it; deep links to Overview keep working), nav item visibility and
  order with accessible Move up/Move down controls, Reset navigation. Settings
  can never be hidden; hidden routes keep working (§21/§22).
- **Library** — default tab, default TV view (grid/list), poster size
  (small/medium/large).
- **Data display** — date style (relative/absolute/both), time format
  (system/24h/12h), memory + storage units (auto/GB/GiB/TB/TiB), status detail
  level (Simple/Detailed), technical identifiers (config keys, pids, media
  keys — off by default).
- **Accessibility** — higher contrast, enhanced focus outlines, reduced
  transparency, always-show status labels, larger text size. Semantic status
  colors are never remapped by any of these (§9/§90/§95).
- **Reset** — "Reset interface settings" restores shipped defaults after a
  confirmation (§99). Auto-recovery stays Off after any reset (§75).

## Reliability settings

Settings → Reliability holds the DEEL-1 monitoring switches (mount +
memory monitoring, on by default), memory thresholds behind an Advanced
disclosure, and the recovery policy. In this release the only recovery mode is
**Off** — every restart action is an explicit, confirmed, administrator
decision (see [REMEDIATION.md](./REMEDIATION.md)).

## Notes

- Changing appearance preferences never touches the server (§143).
- Mobile hides desktop-only options (sidebar modes) and keeps comfortable
  touch targets in every density (§103/§12).
