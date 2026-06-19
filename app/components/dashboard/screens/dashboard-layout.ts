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

// Note: we intentionally do NOT reject layouts containing unknown tile ids —
// react-grid-layout ignores layout entries without a matching child, and the
// versioned key (cd:dash:layout:v1) handles genuinely breaking schema changes.
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
