import { describe, it, expect } from "vitest";
import { buildWatchScan, scanLineFor } from "../watch-scan";

describe("buildWatchScan", () => {
  it("maps titles to inv and campaign names to ads, ret stays empty", () => {
    const out = buildWatchScan(
      [{ title: "Summit Logo Tee" }, { title: "Cascade Rain Shell" }],
      [{ name: "Meta · Retargeting" }],
    );
    expect(out.inv).toEqual(["Summit Logo Tee", "Cascade Rain Shell"]);
    expect(out.ads).toEqual(["Meta · Retargeting"]);
    expect(out.ret).toEqual([]);
  });

  it("caps each list at 8, trims, and dedupes case-insensitively", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `Item ${i}` }));
    const out = buildWatchScan([{ title: "  Tee  " }, { title: "tee" }, ...many], []);
    expect(out.inv).toHaveLength(8);
    expect(out.inv[0]).toBe("Tee");
    expect(out.inv.filter((n) => n.toLowerCase() === "tee")).toHaveLength(1);
  });

  it("orders price by velocity desc so its lead differs from inv", () => {
    const out = buildWatchScan(
      [
        { title: "A", velocity: 1 },
        { title: "B", velocity: 9 },
        { title: "C", velocity: 5 },
      ],
      [],
    );
    expect(out.inv[0]).toBe("A");
    expect(out.price[0]).toBe("B");
  });

  it("rotates price when velocity order matches inv, so they never look identical", () => {
    const out = buildWatchScan(
      [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }],
      [],
    );
    expect(out.price).not.toEqual(out.inv);
    expect([...out.price].sort()).toEqual([...out.inv].sort());
  });

  it("returns all-empty lists for empty inputs", () => {
    expect(buildWatchScan([], [])).toEqual({ inv: [], ads: [], price: [], ret: [] });
  });
});

describe("scanLineFor", () => {
  it("cycles list names by index", () => {
    expect(scanLineFor(["a", "b"], ["x"], 0)).toBe("a");
    expect(scanLineFor(["a", "b"], ["x"], 3)).toBe("b");
  });
  it("falls back to aspect lines when the list is empty", () => {
    expect(scanLineFor([], ["x", "y"], 1)).toBe("y");
  });
  it("returns empty string when both are empty", () => {
    expect(scanLineFor([], [], 0)).toBe("");
  });
});
