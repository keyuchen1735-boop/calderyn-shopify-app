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
  loadSavedLayouts,
  saveLayouts,
  resetLayouts,
  tileScale,
  TILE_SCALE_MIN,
  TILE_SCALE_MAX,
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
    expect(parseLayouts(JSON.stringify({ lg: [{ i: "stats" }] }))).toBeNull();
  });

  it("parseLayouts accepts a well-formed blob", () => {
    const good = { lg: [{ i: "stats", x: 0, y: 0, w: 12, h: 3 }] };
    expect(parseLayouts(JSON.stringify(good))).toEqual(good);
  });

  it("loadLayouts is SSR-safe with no storage (no window) → defaults", () => {
    expect(loadLayouts(null)).toEqual(DEFAULT_LAYOUTS);
  });

  // loadSavedLayouts is what drives the "default view = original layout"
  // behavior: it returns null (NOT the defaults) until the user has actually
  // saved a custom arrangement, so an uncustomized dashboard renders its
  // original flow layout instead of the grid.
  it("loadSavedLayouts returns null when nothing is saved", () => {
    expect(loadSavedLayouts(memStorage())).toBeNull();
  });

  it("loadSavedLayouts is SSR-safe with no storage → null", () => {
    expect(loadSavedLayouts(null)).toBeNull();
  });

  it("loadSavedLayouts returns the saved layout once present", () => {
    const s = memStorage();
    saveLayouts(DEFAULT_LAYOUTS, s);
    expect(loadSavedLayouts(s)).toEqual(DEFAULT_LAYOUTS);
  });

  // A layout saved before the min-size guard (under the old key) had tiles
  // smaller than today's minW/minH, so restoring it rendered a squished grid on
  // startup. Bumping the storage key discards those stale blobs: startup falls
  // back to the clean original layout, and every new save (constrained by rgl's
  // minW/minH) is safe.
  it("ignores a layout saved under a previous schema version", () => {
    expect(DASH_LAYOUT_KEY).not.toBe("cd:dash:layout:v1");
    const s = memStorage();
    s.setItem("cd:dash:layout:v1", JSON.stringify(DEFAULT_LAYOUTS));
    expect(loadSavedLayouts(s)).toBeNull();
  });

  it("loadSavedLayouts returns null (never throws) for a corrupt blob", () => {
    const s = memStorage();
    s.setItem(DASH_LAYOUT_KEY, "garbage{");
    expect(loadSavedLayouts(s)).toBeNull();
  });
});

// tileScale drives the "content zooms with the tile" behaviour: a tile at its
// default size renders 1×, a smaller tile zooms down (floored so text stays
// legible), a larger tile zooms up (capped), and only the lg grid zooms at all.
describe("tileScale (resize zoom factor)", () => {
  const def = DEFAULT_LAYOUTS.lg!.find((l) => l.i === "predictor")!; // 6×5

  it("is 1× when a tile is at its default size", () => {
    expect(tileScale("predictor", { w: def.w, h: def.h }, "lg")).toBe(1);
  });

  it("zooms down for a smaller tile, floored at the min", () => {
    const s = tileScale("predictor", { w: 4, h: 3 }, "lg");
    expect(s).toBeLessThan(1);
    expect(s).toBeGreaterThanOrEqual(TILE_SCALE_MIN);
  });

  it("zooms up for a larger tile, capped at the max", () => {
    const s = tileScale("predictor", { w: 12, h: 12 }, "lg");
    expect(s).toBeGreaterThan(1);
    expect(s).toBeLessThanOrEqual(TILE_SCALE_MAX);
  });

  it("uses the smaller of the width/height ratios (content always fits)", () => {
    // 12 wide (2×) but 5 tall (1×) → 1×, so it can't overflow vertically.
    expect(tileScale("predictor", { w: 12, h: 5 }, "lg")).toBe(1);
  });

  it("never zooms outside the lg grid, or for unknown/missing tiles", () => {
    expect(tileScale("predictor", { w: 2, h: 2 }, "sm")).toBe(1);
    expect(tileScale("nope", { w: 2, h: 2 }, "lg")).toBe(1);
    expect(tileScale("predictor", undefined, "lg")).toBe(1);
  });
});
