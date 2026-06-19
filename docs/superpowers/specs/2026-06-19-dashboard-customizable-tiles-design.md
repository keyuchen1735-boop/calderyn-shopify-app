# Dashboard customizable tiles + clickable Analytics KPIs — Design

- **Date:** 2026-06-19
- **Status:** Approved (brainstorm)
- **Surface:** `/dashboard` ONLY — not the Shopify embedded admin (`app/routes/app.*`). Confirmed by user.
- **Worktree / branch:** `feat/dashboard-tiles` @ `../calderyn-dash-tiles`, based on `feat/peer-benchmarks` HEAD.

## Summary

Two dashboard-only UX features:

1. **Customizable grid** — the main `/dashboard` overview becomes a free-form, draggable + resizable tile grid. Each user's layout is saved in their browser. Defaults reproduce today's layout exactly.
2. **Clickable Analytics KPIs** — the 4 KPI tiles on the Analytics screen become clickable and navigate to the Campaigns screen.

## Scope / non-goals

- **In:** `Dashboard.tsx`, `Analytics.tsx`, one new tiles module, one new dependency (`react-grid-layout`) + its CSS.
- **Out:** Shopify embedded admin (Polaris layout is fixed + App-Store-review-constrained). No detector/action/data-contract change. No backend/DB. No cross-device sync.

## Feature 1 — Customizable dashboard grid

### Library

`react-grid-layout` (MIT). Pulls peers `react-resizable` / `react-draggable`; ~30kb gz. Requires two CSS imports where dashboard global CSS is loaded:

- `react-grid-layout/css/styles.css`
- `react-resizable/css/styles.css`

Flagged & approved per the repo "no new top-level deps without flagging the tradeoff" rule.

### Tile registry

New module `app/components/dashboard/screens/dashboard-tiles.tsx` holds the registry **and** the localStorage helpers (one file — these are ~15 lines, no need to split):

```
type DashTile = {
  id: string;
  render: (app: DashboardCtx) => ReactNode;   // wraps existing section JSX, unchanged
  default: { x: number; y: number; w: number; h: number; minW: number; minH: number };
};
export const DASH_TILES: DashTile[];
```

Sections extracted from `Dashboard.tsx` into tiles (12-col grid, defaults reproduce the current layout 1:1):

| id | current section | conditional |
|----|-----------------|-------------|
| `stats` | 4-up stat row (Open alerts / Recovered / Daily budget / Real ad return) | always |
| `focus` | `FocusCard` | always |
| `revenue` | Revenue-vs-ad-spend area chart card | always |
| `feed` | `ActivityFeed` | always |
| `attention` | Needs-attention top alerts | only if `topAlerts.length` |
| `predictor` | `PredictorCard` | always |
| `autopilot` | `GuardrailCard` | always |
| `benchmarks` | `PeerBenchmarks` | only if data present |

Conditional tiles are omitted from the rendered grid when absent; their layout entries are simply not emitted.

### Edit mode

- **"Customize" toggle** (existing `Btn`) in `ScreenHeader` children; `isEditing` state, default `false`.
- `false` (view): `isDraggable/isResizable=false`; tiles render normally; stat cards keep their `onClick` navigation.
- `true` (edit): drag + resize enabled via a `draggableHandle` grip per tile; a **"Reset layout"** `Btn` appears (clears the localStorage key + restores defaults). Stat-card navigation is suppressed while editing so drag never fires a navigate.

### Persistence

- Key: `localStorage['cd:dash:layout:v1']` (versioned so a future schema bump invalidates cleanly).
- Stores the react-grid-layout `layouts` object.
- **On mount:** read + `JSON.parse` + shape-validate (array/object of `{i,x,y,w,h}`). On any failure → defaults + `console.error` (rule 12: fail visibly, never silently).
- **On `onLayoutChange`** (drag/resize stop): write back.
- **Reset:** `removeItem` + restore defaults.

### Responsive

`WidthProvider(Responsive)` with breakpoints `lg/md/sm` and cols `{lg:12, md:8, sm:4}`. Author the `lg` defaults; let rgl derive smaller breakpoints, then verify it stacks acceptably on narrow widths.

### Self-check

A small `assert`-based self-check colocated with the persistence helpers:

- `serialize(defaults)` → string → `parse` → deep-equals `defaults`.
- `parse('garbage')`, `parse('{}')`, missing key → returns defaults, never throws.

Uses the repo's existing test runner (vitest); no new framework/fixtures.

## Feature 2 — Clickable Analytics KPI tiles

In `Analytics.tsx`, the 4 KPI `<Card>`s (Ad spend / Attributed revenue / Blended ROAS / Campaign health) become:

```
<Card hover onClick={() => app.navigate("campaigns")}>
```

Same pattern already used by the Dashboard stat row and the campaign-grade rows. All four target **Campaigns** — the only screen where these rollups are actionable (ROAS/Spend have no distinct page; the chart is already on Analytics). ~4 line-edits, no new component.

## Parity

Dashboard-only by explicit user decision. Embedded admin unchanged. Parity **N/A**, recorded here per the mandatory-parity rule (flagged, not silently single-sided).

## Testing / pre-commit gate

- Persistence self-check (above).
- `npm run typecheck` / `lint` / `build` green.
- Manual: drag + resize a tile, reload → persists; Reset → defaults; toggle off → stat cards navigate again; Analytics KPI click → Campaigns.

## Files

- **M** `app/components/dashboard/screens/Dashboard.tsx` — render via grid + registry, add Customize/Reset.
- **A** `app/components/dashboard/screens/dashboard-tiles.tsx` — registry + defaults + localStorage load/save/reset + self-check.
- **M** `app/components/dashboard/screens/Analytics.tsx` — clickable KPIs.
- **M** `package.json` — `react-grid-layout`.
- **M** dashboard CSS entry point — two rgl CSS imports.

**Dependency:** the `benchmarks` tile relies on `feat/peer-benchmarks`; this branch is based on it and should land after/with it.
