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
