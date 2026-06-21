# Dashboard Customizable Tiles + Clickable Analytics KPIs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `/dashboard` only: make the overview a free-form draggable + resizable tile grid (saved per-browser), and make the 4 Analytics KPI tiles navigate to Campaigns.

**Architecture:** Each overview section becomes a tile rendered inside `react-grid-layout`'s `Responsive`+`WidthProvider`. A pure, injectable-storage module (`dashboard-layout.ts`) owns the localStorage round-trip and the default layout. A header "Customize" toggle gates drag/resize; a per-tile grip handle (`.cd-tile-grip`) means clicks elsewhere still navigate, so no click-vs-drag conflict. Analytics KPIs reuse the existing `<Card hover onClick>` pattern.

**Tech Stack:** Remix + React 18, TypeScript (strict), `react-grid-layout` (new dep), vitest (node env, `react-dom/server` `renderToString` tests), dashboard's own `cd-*` CSS.

---

## Context for the implementer

- **Worktree:** all work happens in `../calderyn-dash-tiles` on branch `feat/dashboard-tiles` (already created, based on `feat/peer-benchmarks` HEAD so the Peer Benchmarks tile exists).
- **Surface:** `/dashboard` only. Do **not** touch `app/routes/app.*` (the Polaris embedded admin). Parity is N/A for this change (UI personalization, no product-brain change).
- **Tests:** `npm run test` → `vitest run`. Env is node; tests render screens with `renderToString` from `react-dom/server` (no jsdom, effects do **not** run). This is why Feature 2 has no unit test (see Task 5).
- **Gate before any commit of code (not docs):** `npm run typecheck` → `npm run lint` → `npm run build` → `npm run test`, all exit 0. Per the repo contract, never `--no-verify` / `eslint-disable` / narrow types to silence `tsc`.

### Files

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `app/components/dashboard/screens/dashboard-layout.ts` | Tile ids, default layouts, breakpoints/cols, pure localStorage load/save/reset + parse/validate. No React/rgl runtime. |
| Create | `app/components/dashboard/screens/__tests__/dashboard-layout.test.ts` | Unit tests for the store (round-trip, corrupt/empty fallback, SSR-safe no-arg). |
| Modify | `app/components/dashboard/screens/Dashboard.tsx` | Extract sections into tiles; render via the grid; add Customize/Reset + persistence. |
| Modify | `app/components/dashboard/screens/__tests__/dashboard-stat-row.test.ts:122` | Update the stat-grid slice boundary (refactor removes the `cd-grid-main` wrapper it relied on). |
| Modify | `app/components/dashboard/screens/Analytics.tsx` | Make the 4 KPI cards clickable → Campaigns. |
| Modify | `app/routes/dashboard._index.tsx:15-22` | Add the two `react-grid-layout` stylesheet links. |
| Modify | `app/styles/dashboard.css` | `.cd-tile` / `.cd-tile-grip` / placeholder styling. |
| Modify | `package.json` | `react-grid-layout` + `@types/react-grid-layout`. |

---

## Task 1: Add the dependency and wire its CSS

**Files:**
- Modify: `package.json`
- Modify: `app/routes/dashboard._index.tsx:15-22`

- [ ] **Step 1: Install the library and its types**

Run (from the worktree root `../calderyn-dash-tiles`):

```bash
npm install react-grid-layout@^1.5.0
npm install -D @types/react-grid-layout@^1.3.5
```

Expected: both added to `package.json`; `react-grid-layout` under `dependencies`, the types under `devDependencies`. (`react-grid-layout` is MIT; it pulls `react-draggable` + `react-resizable`.)

- [ ] **Step 2: Add the two stylesheets to the dashboard route's `links()`**

In `app/routes/dashboard._index.tsx`, add the imports next to the existing CSS imports (after line 16) and append two link entries. Final block:

```tsx
import dashboardUtils from "~/styles/dashboard-utils.css?url";
import dashboard from "~/styles/dashboard.css?url";
import rglStyles from "react-grid-layout/css/styles.css?url";
import rglResize from "react-resizable/css/styles.css?url";

// Utils first so the cd-* rules in dashboard.css can override the utility layer.
// react-grid-layout base styles before dashboard.css so our .cd-tile rules win.
export const links: LinksFunction = () => [
  { rel: "stylesheet", href: dashboardUtils },
  { rel: "stylesheet", href: rglStyles },
  { rel: "stylesheet", href: rglResize },
  { rel: "stylesheet", href: dashboard },
];
```

- [ ] **Step 3: Verify it builds**

Run: `npm run typecheck && npm run build`
Expected: exit 0 (the `?url` CSS imports resolve under Vite; no code uses rgl yet).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json app/routes/dashboard._index.tsx
git commit -m "dashboard: add react-grid-layout dep + base stylesheets

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pure layout store (TDD)

**Files:**
- Test: `app/components/dashboard/screens/__tests__/dashboard-layout.test.ts`
- Create: `app/components/dashboard/screens/dashboard-layout.ts`

- [ ] **Step 1: Write the failing test**

Create `app/components/dashboard/screens/__tests__/dashboard-layout.test.ts`:

```ts
// The dashboard grid persists each browser's tile arrangement in localStorage.
// The store must round-trip a valid layout and — critically (rule 12: fail
// visibly, never silently) — fall back to the shipped defaults on a missing,
// corrupt, or empty blob rather than rendering a broken/empty dashboard.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAYOUTS,
  DASH_LAYOUT_KEY,
  parseLayouts,
  loadLayouts,
  saveLayouts,
  resetLayouts,
} from "../dashboard-layout";

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    _map: m,
  };
}

describe("dashboard-layout store", () => {
  it("returns defaults from an empty store", () => {
    expect(loadLayouts(memStorage())).toEqual(DEFAULT_LAYOUTS);
  });

  it("round-trips a saved layout", () => {
    const s = memStorage();
    saveLayouts(DEFAULT_LAYOUTS, s);
    expect(s._map.get(DASH_LAYOUT_KEY)).toBeTypeOf("string");
    expect(loadLayouts(s)).toEqual(DEFAULT_LAYOUTS);
  });

  it("reset clears the saved layout so load falls back to defaults", () => {
    const s = memStorage();
    saveLayouts(DEFAULT_LAYOUTS, s);
    resetLayouts(s);
    expect(s._map.get(DASH_LAYOUT_KEY)).toBeUndefined();
    expect(loadLayouts(s)).toEqual(DEFAULT_LAYOUTS);
  });

  it("parseLayouts rejects null, garbage, empty, and wrong-shape blobs", () => {
    expect(parseLayouts(null)).toBeNull();
    expect(parseLayouts("not json{")).toBeNull();
    expect(parseLayouts("{}")).toBeNull();
    expect(parseLayouts("[1,2,3]")).toBeNull();
    // right container, wrong item shape (missing numeric x/y/w/h)
    expect(parseLayouts(JSON.stringify({ lg: [{ i: "stats" }] }))).toBeNull();
  });

  it("parseLayouts accepts a well-formed blob", () => {
    const good = { lg: [{ i: "stats", x: 0, y: 0, w: 12, h: 3 }] };
    expect(parseLayouts(JSON.stringify(good))).toEqual(good);
  });

  it("loadLayouts is SSR-safe with no storage (no window) → defaults", () => {
    expect(loadLayouts(null)).toEqual(DEFAULT_LAYOUTS);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- dashboard-layout`
Expected: FAIL — `Cannot find module '../dashboard-layout'`.

- [ ] **Step 3: Write the store**

Create `app/components/dashboard/screens/dashboard-layout.ts`:

```ts
// Pure localStorage-backed persistence for the customizable dashboard grid.
// No React / no react-grid-layout *runtime* — only the Layout/Layouts types —
// so it unit-tests in the node vitest env with an injectable storage stub and
// never touches `window` during SSR.
import type { Layout, Layouts } from "react-grid-layout";

export const DASH_LAYOUT_KEY = "cd:dash:layout:v1";

// Tile ids in stable DOM/registry order. Dashboard.tsx renders tiles in this
// order; DEFAULT_LAYOUTS positions them. `stats` precedes `focus` so the
// stat-row test can still isolate the stat grid.
export const DASH_TILE_IDS = [
  "stats",
  "focus",
  "feed",
  "revenue",
  "attention",
  "predictor",
  "autopilot",
  "benchmarks",
] as const;
export type DashTileId = (typeof DASH_TILE_IDS)[number];

// lg = hand-tuned 12-col arrangement reproducing today's two-column layout
// (feed tall on the right alongside focus + revenue). compactType="vertical"
// removes any leftover gaps, so exact y values only need to be in order.
const LG: Layout[] = [
  { i: "stats", x: 0, y: 0, w: 12, h: 3, minW: 6, minH: 2 },
  { i: "focus", x: 0, y: 3, w: 8, h: 6, minW: 4, minH: 4 },
  { i: "feed", x: 8, y: 3, w: 4, h: 12, minW: 3, minH: 6 },
  { i: "revenue", x: 0, y: 9, w: 8, h: 6, minW: 4, minH: 4 },
  { i: "attention", x: 0, y: 15, w: 12, h: 4, minW: 4, minH: 3 },
  { i: "predictor", x: 0, y: 19, w: 6, h: 5, minW: 3, minH: 4 },
  { i: "autopilot", x: 6, y: 19, w: 6, h: 5, minW: 3, minH: 4 },
  { i: "benchmarks", x: 0, y: 24, w: 12, h: 5, minW: 4, minH: 3 },
];

// Smaller breakpoints: full-width vertical stack in registry order.
const STACK_H: Record<DashTileId, number> = {
  stats: 3,
  focus: 6,
  feed: 8,
  revenue: 6,
  attention: 4,
  predictor: 5,
  autopilot: 5,
  benchmarks: 5,
};
function stack(cols: number): Layout[] {
  let y = 0;
  return DASH_TILE_IDS.map((id) => {
    const h = STACK_H[id];
    const item: Layout = { i: id, x: 0, y, w: cols, h, minW: cols, minH: 2 };
    y += h;
    return item;
  });
}

export const DEFAULT_LAYOUTS: Layouts = {
  lg: LG,
  md: stack(8),
  sm: stack(2),
};

export const DASH_BREAKPOINTS = { lg: 996, md: 768, sm: 0 };
export const DASH_COLS = { lg: 12, md: 8, sm: 2 };

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null; // Safari private mode etc.
  }
}

function isLayoutItem(o: unknown): o is Layout {
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  return (
    typeof r.i === "string" &&
    typeof r.x === "number" &&
    typeof r.y === "number" &&
    typeof r.w === "number" &&
    typeof r.h === "number"
  );
}

/** Parse a stored blob into Layouts, or null if absent/corrupt/empty/wrong-shape. */
export function parseLayouts(raw: string | null): Layouts | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    console.error("dash layout: bad JSON, falling back to defaults", e);
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return null;
  const ok = entries.every(
    ([, arr]) => Array.isArray(arr) && arr.every(isLayoutItem),
  );
  return ok ? (v as Layouts) : null;
}

export function loadLayouts(
  storage: StorageLike | null = browserStorage(),
): Layouts {
  const parsed = storage ? parseLayouts(storage.getItem(DASH_LAYOUT_KEY)) : null;
  return parsed ?? DEFAULT_LAYOUTS;
}

export function saveLayouts(
  layouts: Layouts,
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(DASH_LAYOUT_KEY, JSON.stringify(layouts));
  } catch (e) {
    console.error("dash layout: save failed", e);
  }
}

export function resetLayouts(
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(DASH_LAYOUT_KEY);
  } catch (e) {
    console.error("dash layout: reset failed", e);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- dashboard-layout`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/components/dashboard/screens/dashboard-layout.ts app/components/dashboard/screens/__tests__/dashboard-layout.test.ts
git commit -m "dashboard/screens: layout store for customizable tile grid

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Static tile grid (no interactivity yet, must look identical to today)

Goal of this task: render the existing sections through the grid with the default layout, **non-draggable/non-resizable**, so the page is visually unchanged. The next task adds editing.

**Files:**
- Modify: `app/components/dashboard/screens/Dashboard.tsx`
- Modify: `app/components/dashboard/screens/__tests__/dashboard-stat-row.test.ts:122`
- Modify: `app/styles/dashboard.css`

- [ ] **Step 1: Add imports to `Dashboard.tsx`**

At the top of `Dashboard.tsx`, add after the existing imports (keep all current imports):

```tsx
import { Responsive, WidthProvider } from "react-grid-layout";
import type { Layout, Layouts } from "react-grid-layout";
import {
  DEFAULT_LAYOUTS,
  DASH_BREAKPOINTS,
  DASH_COLS,
  loadLayouts,
  saveLayouts,
  resetLayouts,
} from "./dashboard-layout";

const DashGrid = WidthProvider(Responsive);
```

(`saveLayouts`/`resetLayouts` are used in Task 4; importing them now is fine — they're referenced by Task 4's edits in the same file. If your linter flags unused imports between tasks, add them in Task 4 instead.)

- [ ] **Step 2: Extract three local components from the current inline JSX**

Add these three components to `Dashboard.tsx` (anywhere above the default export, next to the existing `FocusCard`/`GuardrailCard`). The JSX is moved **verbatim** from the current `Dashboard()` body — only wrapped in components that recompute their own inputs.

```tsx
/* ---------- Stat row (4 KPI tiles) ---------- */
function StatRow({ app }: { app: DashboardCtx }) {
  const open = app.alerts.filter((a) => a.status === "open");
  const critical = open.filter((a) => a.severity === "critical");
  const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recovered7d = recoveredWithin(app.audit, sinceIso);
  const g = app.guardrails;
  const budgetCap = g?.daily_action_budget_cents ?? 0;
  const budgetUsed = g?.daily_action_budget_used_cents ?? 0;
  const budgetLeft = Math.max(0, budgetCap - budgetUsed);
  const budgetPct = budgetCap > 0 ? (budgetUsed / budgetCap) * 100 : 0;
  return (
    <div className="cd-stat-grid">
      <Card hover onClick={() => app.navigate("alerts")} className="cd-stat">
        <span className="cd-stat-label">Open alerts</span>
        <span className="cd-stat-value" style={critical.length ? { color: "var(--red)" } : undefined}>
          {open.length}
        </span>
        <span className="cd-caption">
          {critical.length ? `${critical.length} critical` : "clear of critical"}
        </span>
      </Card>
      <Card hover onClick={() => app.navigate("audit")} className="cd-stat">
        <span className="cd-stat-label">Recovered (7d)</span>
        <span className="cd-stat-value" style={{ color: "var(--green)" }}>
          <CountMoney cents={recovered7d.cents} />
        </span>
        <span className="cd-caption">
          across {recovered7d.count} action{recovered7d.count === 1 ? "" : "s"}
        </span>
      </Card>
      <Card hover onClick={() => app.navigate("settings")} className="cd-stat">
        <span className="cd-stat-label">Daily action budget</span>
        {g ? (
          <>
            <Meter pct={budgetPct} tone={budgetPct > 85 ? "warn" : "accent"} />
            <span className="cd-caption tabular-nums">{money(budgetLeft)} left today</span>
          </>
        ) : (
          <span className="cd-caption">unavailable</span>
        )}
      </Card>
      <Card hover onClick={() => app.navigate("campaigns")} className="cd-stat">
        <span className="cd-stat-label">Real ad return (7d)</span>
        <span className="cd-stat-value tabular-nums">{trueRoas(app.campaigns)}</span>
        <span className="cd-caption">margin-adjusted ROAS, all campaigns</span>
      </Card>
    </div>
  );
}

/* ---------- Revenue vs ad spend ---------- */
function RevenueCard({ app }: { app: DashboardCtx }) {
  const series = app.overview?.roas_series ?? [];
  return (
    <Card pad={false}>
      <div className="cd-pad-x cd-pad-t flex items-center justify-between">
        <h2 className="cd-h2">Revenue vs ad spend</h2>
        <span className="cd-caption">30 days · blended</span>
      </div>
      <div className="cd-pad" style={{ paddingTop: 8 }}>
        {series.length > 1 ? (
          <AreaChart rows={series} live={app.liveOn} />
        ) : (
          <Placeholder
            icon="chart"
            title={app.overview === null ? "Loading chart" : "No history yet"}
            sub="Revenue and ad spend for the last 30 days will plot here once data is in."
          />
        )}
      </div>
    </Card>
  );
}

/* ---------- Needs attention (top alerts) ---------- */
function AttentionSection({ app }: { app: DashboardCtx }) {
  const open = app.alerts.filter((a) => a.status === "open");
  const topAlerts: AlertVM[] = [...open]
    .sort((a, b) => a.claude_rank - b.claude_rank)
    .slice(1, 4);
  return (
    <section>
      <SectionTitle action="All alerts" onAction={() => app.navigate("alerts")}>
        Needs attention
      </SectionTitle>
      <div className="cd-attn-grid">
        {topAlerts.map((a) => (
          <Card
            key={a.id}
            hover
            onClick={() => app.navigate("alerts", a.id)}
            className="flex flex-col gap-2"
          >
            <div className="flex items-center gap-2">
              <SevBadge severity={a.severity} />
              <span className="cd-caption truncate">
                {DETECTOR_TERMS[a.detector_id] || a.detector_id}
              </span>
            </div>
            <div className="cd-h3">{a.title}</div>
            <div className="cd-caption truncate">{a.sku || a.campaign}</div>
            <div className="cd-kv mt-auto">
              <span>At risk</span>
              <b className="tabular-nums" style={{ color: "var(--red)" }}>
                {money(a.dollar_impact)}/wk
              </b>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Replace the `Dashboard` default export body with the grid**

Replace the entire `export default function Dashboard({ app }: { app: DashboardCtx }) { ... }` (currently lines ~267–432) with:

```tsx
/* ---------- Screen ---------- */
export default function Dashboard({ app }: { app: DashboardCtx }) {
  const open = app.alerts.filter((a) => a.status === "open");
  const hasAttention = open.length >= 2; // slice(1,4) is empty with ≤1 open alert

  // Peer Benchmarks: self-fetched so no DashboardCtx threading needed.
  const [benchmarks, setBenchmarks] = useState<BenchmarksData | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/dashboard/api/benchmarks")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d && Array.isArray((d as BenchmarksData).kpis)) {
          setBenchmarks(d as BenchmarksData);
        }
      })
      .catch((e) => {
        console.error("peer benchmarks fetch failed", e);
      });
    return () => {
      alive = false;
    };
  }, []);

  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  // Per-browser saved arrangement; SSR-safe (returns defaults when no window).
  const [layouts] = useState<Layouts>(() => loadLayouts());

  const tiles: { id: string; node: ReactNode }[] = [
    { id: "stats", node: <StatRow app={app} /> },
    { id: "focus", node: <FocusCard app={app} /> },
    { id: "feed", node: <ActivityFeed app={app} limit={7} tall /> },
    { id: "revenue", node: <RevenueCard app={app} /> },
    ...(hasAttention ? [{ id: "attention", node: <AttentionSection app={app} /> }] : []),
    { id: "predictor", node: <PredictorCard app={app} /> },
    { id: "autopilot", node: <GuardrailCard app={app} /> },
    ...(benchmarks ? [{ id: "benchmarks", node: <PeerBenchmarks data={benchmarks} /> }] : []),
  ];

  return (
    <div className="cd-screen">
      <ScreenHeader title={greet} sub="Watching ad spend and inventory — together.">
        <LiveBadge on={app.liveOn} onToggle={() => app.setLiveOn(!app.liveOn)} />
        <Btn icon="bell" onClick={() => app.navigate("alerts")} small>
          All alerts
        </Btn>
      </ScreenHeader>

      <DashGrid
        className="cd-dash-grid"
        layouts={layouts}
        breakpoints={DASH_BREAKPOINTS}
        cols={DASH_COLS}
        rowHeight={30}
        margin={[16, 16]}
        isDraggable={false}
        isResizable={false}
        compactType="vertical"
      >
        {tiles.map((t) => (
          <div key={t.id} data-tile={t.id} className="cd-tile">
            {t.node}
          </div>
        ))}
      </DashGrid>
    </div>
  );
}
```

Note: `recoveredWithin`, `trueRoas`, `money`, the `ActivityFeed limit/tall` props, and the benchmarks fetch are unchanged — they now live in `StatRow` / the export. After this edit, search the file for now-unused locals from the old body (`recovered7d`, `series`, `topAlerts`, `critical`, `budget*`) and confirm none remain at the top level (they were moved into `StatRow`/`AttentionSection`/`RevenueCard`). The lint step in Step 6 will catch any leftover.

- [ ] **Step 4: Update the stat-row test's slice boundary**

The refactor removes the `cd-grid-main` wrapper that `renderStatGrid` used as its end boundary. Each tile is now wrapped in `<div data-tile="…">`, in registry order (`stats` then `focus`), so slice from the stat grid to the next tile. In `app/components/dashboard/screens/__tests__/dashboard-stat-row.test.ts`, change line 122:

```ts
  const end = html.indexOf('data-tile="focus"');
```

All behavioral assertions (four named tiles, `trueRoas` = 1.3×, $380 budget, Recovered math, **exactly 4 `role="button"`**) are unchanged — only the slice plumbing moves. This test is also the SSR guard: it proves `Dashboard` still server-renders through `react-grid-layout` without throwing and in stable DOM order.

- [ ] **Step 5: Add the tile CSS**

Append to `app/styles/dashboard.css`:

```css
/* ---- Customizable dashboard grid (react-grid-layout) ---- */
.cd-dash-grid {
  position: relative;
}
.cd-tile {
  height: 100%;
  display: flex;
  flex-direction: column;
}
/* The tile's content (a card or a section) fills the grid cell. */
.cd-tile > .cd-card,
.cd-tile > section {
  flex: 1 1 auto;
  min-height: 0;
}
.cd-tile-grip {
  position: absolute;
  top: 6px;
  right: 10px;
  z-index: 2;
  cursor: grab;
  user-select: none;
  line-height: 1;
  font-size: 16px;
  color: var(--text-3);
}
.cd-tile-grip:active {
  cursor: grabbing;
}
.cd-dash-grid-editing .cd-tile {
  outline: 1px dashed var(--border, #2a2a2a);
  outline-offset: 2px;
  border-radius: 12px;
}
.react-grid-item.react-grid-placeholder {
  background: var(--accent);
  opacity: 0.15;
  border-radius: 12px;
}
```

- [ ] **Step 6: Run the gate for this task**

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```
Expected: all exit 0. Pay attention to:
- `dashboard-stat-row.test.ts` → PASS (slice + 4 role="button" still hold).
- lint → no unused-var warnings in `Dashboard.tsx`.

- [ ] **Step 7: Manual visual check (static)**

Run the dashboard (e.g. `npm run dev`, open `/dashboard`). The overview should look **the same as before**: stat row on top, focus + revenue on the left, feed tall on the right, attention, predictor|autopilot, benchmarks. No drag handles yet. Stat tiles still navigate on click.

- [ ] **Step 8: Commit**

```bash
git add app/components/dashboard/screens/Dashboard.tsx app/components/dashboard/screens/__tests__/dashboard-stat-row.test.ts app/styles/dashboard.css
git commit -m "dashboard/screens: render overview sections as a react-grid-layout grid

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Customize toggle, drag/resize, persistence, reset

**Files:**
- Modify: `app/components/dashboard/screens/Dashboard.tsx`

- [ ] **Step 1: Add editing state + handlers in the default export**

In `Dashboard()`, add below the `const [layouts] = useState(...)` line — and change that line to expose a setter:

```tsx
  // Per-browser saved arrangement; SSR-safe (returns defaults when no window).
  const [layouts, setLayouts] = useState<Layouts>(() => loadLayouts());
  const [editing, setEditing] = useState(false);

  // Only persist while editing — rgl also fires onLayoutChange on mount and on
  // breakpoint changes, which we must not treat as user edits.
  const onLayoutChange = (_current: Layout[], all: Layouts) => {
    if (!editing) return;
    setLayouts(all);
    saveLayouts(all);
  };
  const handleReset = () => {
    resetLayouts();
    setLayouts(DEFAULT_LAYOUTS);
  };
```

- [ ] **Step 2: Add the Customize/Reset buttons to the header**

Replace the `ScreenHeader` children with (adds two buttons before "All alerts"):

```tsx
      <ScreenHeader title={greet} sub="Watching ad spend and inventory — together.">
        <LiveBadge on={app.liveOn} onToggle={() => app.setLiveOn(!app.liveOn)} />
        {editing && (
          <Btn small onClick={handleReset}>
            Reset layout
          </Btn>
        )}
        <Btn
          small
          kind={editing ? "primary" : "secondary"}
          onClick={() => setEditing((e) => !e)}
        >
          {editing ? "Done" : "Customize"}
        </Btn>
        <Btn icon="bell" onClick={() => app.navigate("alerts")} small>
          All alerts
        </Btn>
      </ScreenHeader>
```

(Text-only Customize/Reset buttons — deliberately no `icon` so we don't couple to the `CD_ICONS` registry; add an icon later if wanted.)

- [ ] **Step 3: Wire editing into the grid + add the grip handle**

Replace the `<DashGrid …>` opening tag and the tile `map` with:

```tsx
      <DashGrid
        className={"cd-dash-grid" + (editing ? " cd-dash-grid-editing" : "")}
        layouts={layouts}
        breakpoints={DASH_BREAKPOINTS}
        cols={DASH_COLS}
        rowHeight={30}
        margin={[16, 16]}
        isDraggable={editing}
        isResizable={editing}
        draggableHandle=".cd-tile-grip"
        compactType="vertical"
        onLayoutChange={onLayoutChange}
      >
        {tiles.map((t) => (
          <div key={t.id} data-tile={t.id} className="cd-tile">
            {editing && (
              <span className="cd-tile-grip" aria-hidden="true">
                ⠿
              </span>
            )}
            {t.node}
          </div>
        ))}
      </DashGrid>
```

`draggableHandle=".cd-tile-grip"` means dragging starts only from the grip (shown only while editing), so a stat card's `onClick` navigation keeps working even in edit mode — no click-vs-drag conflict, no need to suppress navigation. Resize uses rgl's bottom-right handle (visible only when `isResizable`).

> **A11y note (documented, not a gap to silently ship):** drag-reorder is pointer-only — `react-grid-layout` has no built-in keyboard reordering, and the grip is `aria-hidden`. The feature degrades safely: ships with a sensible default layout, every tile's content stays fully keyboard-operable, and customization is an optional power-user nicety. Keyboard reordering is out of scope for this change.

- [ ] **Step 4: Run the gate**

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```
Expected: all exit 0 (the stat-row test renders with `editing=false` → no grips → still exactly 4 `role="button"`).

- [ ] **Step 5: Manual verification (the real test for this task)**

rgl drag/resize can't be exercised by the node `renderToString` harness, so verify by hand at `/dashboard`:

1. Click **Customize** → grips (⠿) appear, tiles get a dashed outline, resize handles appear bottom-right.
2. Drag a tile by its grip to a new position → it moves and others reflow.
3. Resize a tile from its corner → it resizes.
4. Click **Done**, then **reload the page** → your arrangement persists (localStorage `cd:dash:layout:v1`).
5. Click **Customize → Reset layout** → returns to the default arrangement; reload → still default (key cleared).
6. While **not** editing, click a stat tile → it still navigates (Open alerts → Alerts, etc.).
7. Open a second browser/incognito → sees the default layout (per-browser, as designed).

- [ ] **Step 6: Commit**

```bash
git add app/components/dashboard/screens/Dashboard.tsx
git commit -m "dashboard/screens: Customize toggle — drag/resize tiles, persist + reset

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Clickable Analytics KPI tiles → Campaigns

**Files:**
- Modify: `app/components/dashboard/screens/Analytics.tsx` (the four `<Card className="cd-stat">` in the `cd-stat-grid`, ~lines 142–175)

**No automated test (honest rationale, rule 9 / rule 12):** `Analytics` self-fetches via `fetchAnalytics()` in a `useEffect`. The node `renderToString` harness never flushes effects, so a server-rendered `Analytics` shows the *loading* placeholder, not the KPI grid — the populated state is unreachable without adding jsdom + effect-flushing infra, which is disproportionate for wiring four cards to an already-proven (`dashboard-stat-row.test.ts`) `<Card hover onClick>` pattern. Verified instead by `typecheck` (the `navigate("campaigns")` signature) + `build` + manual click-through.

- [ ] **Step 1: Make the four KPI cards clickable**

In `Analytics.tsx`, add `hover onClick={() => app.navigate("campaigns")}` to each of the four KPI cards. The four become:

```tsx
        <Card hover onClick={() => app.navigate("campaigns")} className="cd-stat">
          <span className="cd-stat-label">Ad spend ({range})</span>
          <span className="cd-stat-value">
            <CountMoney cents={spend} />
          </span>
          <span className="cd-caption">across {grades.length} graded campaigns</span>
        </Card>
        <Card hover onClick={() => app.navigate("campaigns")} className="cd-stat">
          <span className="cd-stat-label">Attributed revenue</span>
          <span className="cd-stat-value">
            <CountMoney cents={revenue} />
          </span>
          <span className="cd-caption">last-click + modeled</span>
        </Card>
        <Card hover onClick={() => app.navigate("campaigns")} className="cd-stat">
          <span className="cd-stat-label">Blended ROAS</span>
          <span
            className="cd-stat-value tabular-nums"
            style={{ color: blended >= 2 ? "var(--green)" : "var(--orange)" }}
          >
            <CountNum value={blended} decimals={1} suffix="×" />
          </span>
          <span className="cd-caption">revenue ÷ spend, blended</span>
        </Card>
        <Card hover onClick={() => app.navigate("campaigns")} className="cd-stat">
          <span className="cd-stat-label">Campaign health</span>
          <span className="cd-stat-value tabular-nums">
            {winning.length}
            <span style={{ color: "var(--text-3)", fontWeight: 500 }}>/{grades.length}</span>
          </span>
          <span className="cd-caption" style={losing.length ? { color: "var(--red)" } : undefined}>
            {losing.length ? `${losing.length} below break-even` : "all above break-even"}
          </span>
        </Card>
```

- [ ] **Step 2: Gate**

```bash
npm run typecheck && npm run lint && npm run build
```
Expected: exit 0.

- [ ] **Step 3: Manual verification**

At `/dashboard` → Analytics: hover the four KPI tiles → pointer/hover affordance; click each → navigates to the Campaigns screen.

- [ ] **Step 4: Commit**

```bash
git add app/components/dashboard/screens/Analytics.tsx
git commit -m "dashboard/screens/Analytics: KPI tiles navigate to Campaigns

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full pre-commit gate + finish

- [ ] **Step 1: Run the complete gate one final time**

```bash
npm run typecheck && npm run lint && npm run build && npm run test
```
Expected: all exit 0. Paste results (rule 12 — evidence, not assertion).

- [ ] **Step 2: Run `/code-review` on the working tree / branch**

Resolve every blocker; downgrade nits with a one-line justification each.

- [ ] **Step 3: Patch sanity**

```bash
git diff --stat origin/feat/peer-benchmarks...HEAD
git diff --check
```
Confirm no stray `console.log`, `.only`, `TODO(me)`, or commented-out blocks introduced.

- [ ] **Step 4: Final manual pass** — re-run the Task 4 Step 5 checklist + Task 5 Step 3 once more on a fresh load.

- [ ] **Step 5: Stop.** Do not push or open a PR unless explicitly asked. Report status with the gate output.

---

## Self-review (plan vs spec)

- **Spec coverage:** Feature 1 free-form grid → Tasks 1–4. localStorage persistence → Task 2 (store) + Task 4 (wiring). Customize/Reset edit mode → Task 4. Defaults reproduce current layout → Task 2 `LG` + Task 3 Step 7 visual check. Feature 2 KPIs navigate → Task 5. Parity N/A / dashboard-only → honored (no `app/routes/app.*` touched). Self-check → Task 2 tests. ✔
- **Deviation from spec (intentional, noted):** spec said one file (`dashboard-tiles.tsx`) holding registry + store; the plan keeps the tile registry **inline in `Dashboard.tsx`** (registry is a small array next to the section components — one fewer file) and puts only the pure store in `dashboard-layout.ts` (so the unit test imports no React/chart/rgl runtime). Net: same surface, cleaner test isolation.
- **Deviation from spec (intentional, noted):** spec said "suppress stat-card navigation while editing"; the plan uses a **grip-handle** (`draggableHandle`) instead, which removes the click-vs-drag conflict without suppression — simpler and keeps navigation available in edit mode.
- **Type consistency:** `Layouts`/`Layout` from `react-grid-layout` used in store + Dashboard; `loadLayouts/saveLayouts/resetLayouts/DEFAULT_LAYOUTS/DASH_BREAKPOINTS/DASH_COLS` names match between `dashboard-layout.ts` and `Dashboard.tsx`; tile ids in `DASH_TILE_IDS` / `DEFAULT_LAYOUTS` match the `data-tile`/`key` ids rendered in Task 3/4 (`stats,focus,feed,revenue,attention,predictor,autopilot,benchmarks`). ✔
- **Placeholder scan:** no TBD/TODO; every code step shows full code; CSS values are concrete (tunable during the Task 3/4 visual-verify steps, which is verification, not a placeholder). ✔
