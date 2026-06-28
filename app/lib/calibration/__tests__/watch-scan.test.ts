import { describe, it, expect } from "vitest";
import { buildWatchScan } from "../watch-scan";

describe("buildWatchScan", () => {
  it("maps SKUs to inv (stock-left value) and campaigns to ads (ROAS value)", () => {
    const out = buildWatchScan(
      [
        { title: "Summit Logo Tee", onHand: 12 },
        { title: "Cascade Rain Shell", onHand: 4 },
      ],
      [{ name: "Meta · Retargeting", roas7d: 1.83, status: "active" }],
    );
    expect(out.inv).toEqual([
      { label: "Summit Logo Tee", value: "12 left" },
      { label: "Cascade Rain Shell", value: "4 left" },
    ]);
    expect(out.ads).toEqual([{ label: "Meta · Retargeting", value: "1.8×" }]);
    expect(out.ret).toEqual([]);
  });

  it("uses signed per-unit profit for pricing, blank when no P&L", () => {
    const out = buildWatchScan(
      [
        { title: "A", onHand: 1, velocity: 5, shipPnlCents: 640 },
        { title: "B", onHand: 1, velocity: 9, shipPnlCents: -250 },
        { title: "C", onHand: 1, velocity: 7, shipPnlCents: null },
      ],
      [],
    );
    // price is ordered by velocity desc: B(9), C(7), A(5)
    expect(out.price).toEqual([
      { label: "B", value: "-$3/u" },
      { label: "C", value: "" },
      { label: "A", value: "+$6/u" },
    ]);
  });

  it("shows no figure for sub-$1 per-unit P&L (avoids a signed $0/u)", () => {
    const out = buildWatchScan([{ title: "Tiny", onHand: 1, shipPnlCents: -40 }], []);
    expect(out.price).toEqual([{ label: "Tiny", value: "" }]);
  });

  it("orders ads with active campaigns before paused; ungraded ROAS is blank", () => {
    const out = buildWatchScan(
      [],
      [
        { name: "Paused One", roas7d: 2.0, status: "paused" },
        { name: "Active One", roas7d: 0, status: "active" },
      ],
    );
    expect(out.ads.map((i) => i.label)).toEqual(["Active One", "Paused One"]);
    expect(out.ads[0].value).toBe(""); // roas 0 → blank
    expect(out.ads[1].value).toBe("2.0×");
  });

  it("caps each list at 8, trims, and dedupes by label (case-insensitive)", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `Item ${i}`, onHand: i }));
    const out = buildWatchScan([{ title: "  Tee  ", onHand: 1 }, { title: "tee", onHand: 2 }, ...many], []);
    expect(out.inv).toHaveLength(8);
    expect(out.inv[0]).toEqual({ label: "Tee", value: "1 left" });
    expect(out.inv.filter((i) => i.label.toLowerCase() === "tee")).toHaveLength(1);
  });

  it("rotates price when velocity order matches inv so the rows never look identical", () => {
    const out = buildWatchScan(
      [
        { title: "A", onHand: 1 },
        { title: "B", onHand: 1 },
        { title: "C", onHand: 1 },
        { title: "D", onHand: 1 },
      ],
      [],
    );
    expect(out.price.map((i) => i.label)).not.toEqual(out.inv.map((i) => i.label));
    expect(out.price.map((i) => i.label).sort()).toEqual(out.inv.map((i) => i.label).sort());
  });

  it("returns all-empty lists for empty inputs", () => {
    expect(buildWatchScan([], [])).toEqual({ inv: [], ads: [], price: [], ret: [] });
  });
});
