// Pure localStorage-backed persistence for the customizable dashboard grid.
// No React / no react-grid-layout *runtime* — only the Layout/Layouts types —
// so it unit-tests in the node vitest env with an injectable storage stub and
// never touches `window` during SSR.
import type { Layout, Layouts } from "react-grid-layout";

// v2: bumped from v1 to discard layouts saved before the min-size guard
// (minW/minH below) — those had sub-minimum tiles that rendered a squished grid
// on startup. Dropping them lets startup fall back to the clean original layout.
export const DASH_LAYOUT_KEY = "cd:dash:layout:v2";

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
// Heights are fitted to measured content (rowHeight 30 + 16px margin → tile px
// ≈ 46h − 16) so opening "Customize" starts roughly matching the default view;
// the user resizes from there.
// minW/minH are the "min-size guard". They're set so min(minW/w, minH/h) stays
// ≥ TILE_SCALE_MIN for every tile: the zoom factor is then never clamped, so a
// resize only ever shrinks content down to that legible floor and NEVER past
// the point where it would overflow the cell and get clipped (nothing hidden).
// Full-width sections (stats/attention/benchmarks) pin minW = cols so they stay
// long bars, never narrow slivers. feed.h is sized so its bottom lines up with
// revenue's; benchmarks.h fits the header + its KPI bars at scale 1.
const LG: Layout[] = [
  { i: "stats", x: 0, y: 0, w: 12, h: 4, minW: 12, minH: 3 },
  { i: "focus", x: 0, y: 4, w: 8, h: 6, minW: 6, minH: 5 },
  { i: "feed", x: 8, y: 4, w: 4, h: 13, minW: 3, minH: 10 },
  { i: "revenue", x: 0, y: 10, w: 8, h: 7, minW: 6, minH: 6 },
  { i: "attention", x: 0, y: 17, w: 12, h: 5, minW: 12, minH: 4 },
  { i: "predictor", x: 0, y: 22, w: 6, h: 5, minW: 5, minH: 4 },
  { i: "autopilot", x: 6, y: 22, w: 6, h: 5, minW: 5, minH: 4 },
  { i: "benchmarks", x: 0, y: 27, w: 12, h: 10, minW: 12, minH: 7 },
];

// Smaller breakpoints: full-width vertical stack in registry order.
const STACK_H: Record<DashTileId, number> = {
  stats: 4,
  focus: 6,
  feed: 11,
  revenue: 7,
  attention: 5,
  predictor: 5,
  autopilot: 5,
  benchmarks: 10,
};
function stack(cols: number): Layout[] {
  let y = 0;
  return DASH_TILE_IDS.map((id) => {
    const h = STACK_H[id];
    // Proportional floor so a tall tile (e.g. feed) can't be resized down to a
    // sliver in the stacked breakpoints. ponytail: half-height heuristic.
    const item: Layout = {
      i: id,
      x: 0,
      y,
      w: cols,
      h,
      minW: cols,
      minH: Math.max(2, Math.ceil(h / 2)),
    };
    y += h;
    return item;
  });
}

export const DEFAULT_LAYOUTS: Layouts = {
  lg: LG,
  sm: stack(2),
};

// lg (the 2-column grid) engages whenever the screen container is ≥ 840px,
// matching the original layout — which stays 2-column until the viewport
// narrows (`.cd-screen` itself caps at 1020px). Below 840 the tiles stack.
export const DASH_BREAKPOINTS = { lg: 840, sm: 0 };
export const DASH_COLS = { lg: 12, sm: 2 };

// ---- True-zoom scaling for the Customize grid -------------------------------
// When a tile is resized its content scales proportionally with the cell (a
// real zoom, never a squished re-flow), so every button/figure stays legible
// and nothing overflows into a neighbouring tile. The factor is a pure function
// of the tile's current grid size vs its default ("100%") size, clamped so the
// content can't zoom into an unreadable smudge or a cartoonish blow-up. The
// layout's minW/minH keep the real range comfortably inside these clamps.
export const TILE_SCALE_MIN = 0.7;
export const TILE_SCALE_MAX = 1.75;

const LG_DEFAULT_DIMS: Record<string, { w: number; h: number }> =
  Object.fromEntries(LG.map((l) => [l.i, { w: l.w, h: l.h }]));

// Canonical lg geometry per tile, used to repair stored layouts (sanitizeLayouts).
const LG_CANON: Record<
  string,
  { w: number; h: number; minW: number; minH: number }
> = Object.fromEntries(
  LG.map((l) => [l.i, { w: l.w, h: l.h, minW: l.minW!, minH: l.minH! }]),
);

/** Repair a stored layout before it drives the grid: a saved tile below its
 *  canonical minimum — e.g. a conditionally-mounted tile (peer benchmarks) that
 *  react-grid-layout auto-placed at 1×1 because it loaded after the layout was
 *  saved — is clamped back up and re-stamped with its minW/minH, so it can't
 *  render as an illegible sliver. Only the lg grid is repaired; the sm stack is
 *  always full-width. Unknown tile ids pass through untouched. */
export function sanitizeLayouts(layouts: Layouts): Layouts {
  const lg = layouts.lg;
  if (!Array.isArray(lg)) return layouts;
  return {
    ...layouts,
    lg: lg.map((item) => {
      const c = LG_CANON[item.i];
      if (!c) return item;
      return {
        ...item,
        w: Math.max(item.w, c.minW),
        h: Math.max(item.h, c.minH),
        minW: c.minW,
        minH: c.minH,
      };
    }),
  };
}

/** Proportional zoom factor for a tile from its live grid size vs the default.
 *  Only the `lg` 2-column grid zooms; the stacked `sm` breakpoint is full-width
 *  (tiles render 1×, content fills width as before). */
export function tileScale(
  id: string,
  item: { w: number; h: number } | undefined,
  breakpoint: string,
): number {
  if (breakpoint !== "lg") return 1;
  const def = LG_DEFAULT_DIMS[id];
  if (!def || !item) return 1;
  const raw = Math.min(item.w / def.w, item.h / def.h);
  return Math.max(TILE_SCALE_MIN, Math.min(TILE_SCALE_MAX, raw));
}

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

// Note: we intentionally do NOT reject layouts containing unknown tile ids —
// react-grid-layout ignores layout entries without a matching child, and the
// versioned key (DASH_LAYOUT_KEY) handles genuinely breaking schema changes.
// Rejecting the whole blob on one stale id would needlessly wipe a user's layout.
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
  return parsed ? sanitizeLayouts(parsed) : DEFAULT_LAYOUTS;
}

/** Like loadLayouts but returns null (not the defaults) when nothing valid is
 *  saved — lets the screen render its ORIGINAL flow layout until the user has
 *  actually customized, so the default view is unchanged by this feature. */
export function loadSavedLayouts(
  storage: StorageLike | null = browserStorage(),
): Layouts | null {
  const parsed = storage ? parseLayouts(storage.getItem(DASH_LAYOUT_KEY)) : null;
  return parsed ? sanitizeLayouts(parsed) : null;
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
