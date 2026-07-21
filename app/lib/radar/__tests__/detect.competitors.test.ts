import { describe, expect, it } from "vitest";
import {
  detectCompetitorPriceMoves,
  detectCompetitors,
  detectCompetitorShifts,
} from "../detect-competitors.server";
import type { CompetitorDiffInput } from "../types";

const COMP = "22222222-2222-4222-8222-222222222222";

function diffRow(patch: Partial<CompetitorDiffInput["diff"]>, url = "https://rival.example/products/boots"): CompetitorDiffInput {
  return {
    competitorId: COMP,
    competitorName: "Rival Gear",
    url,
    capturedAt: "2026-07-20T02:00:00Z",
    diff: { titleChanged: null, newHeadings: [], removedHeadings: [], newPrices: [], removedPrices: [], ...patch },
  };
}

describe("detectCompetitorPriceMoves", () => {
  it("drafts an informational review move when a price moved (never auto-apply)", () => {
    const out = detectCompetitorPriceMoves([diffRow({ newPrices: ["$99.00"], removedPrices: ["$129.00"] })]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("competitor_price");
    expect(out[0].dedupKey).toBe(`comp-price:${COMP}:/products/boots`);
    // Pricing moves are informational ALWAYS - review mode, deep link, no auto-apply.
    expect(out[0].payload).toMatchObject({ applyMode: "review", deepLink: "/dashboard/products" });
    expect(out[0].evidence.chips).toEqual(
      expect.arrayContaining(["Rival Gear", "was $129.00", "now $99.00"]),
    );
    expect(out[0].evidence.facts).toMatchObject({ url: "https://rival.example/products/boots" });
    expect(`${out[0].headline} ${out[0].rationale}`).not.toMatch(/ploy/i);
  });
  it("stays silent when prices only appeared or only disappeared", () => {
    expect(detectCompetitorPriceMoves([diffRow({ newPrices: ["$99.00"] })])).toHaveLength(0);
    expect(detectCompetitorPriceMoves([diffRow({ removedPrices: ["$99.00"] })])).toHaveLength(0);
  });
});

describe("detectCompetitorShifts", () => {
  it("drafts ONE home-hero counter per competitor for positioning/new-page changes", () => {
    const out = detectCompetitorShifts([
      diffRow({ titleChanged: { from: "Rival Gear", to: "Rival Gear - Summer Sale" } }, "https://rival.example/"),
      diffRow({ newHeadings: ["New: Alpine collection", "Free shipping"] }, "https://rival.example/collections/alpine"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("competitor_counter");
    expect(out[0].dedupKey).toBe(`comp-counter:${COMP}`);
    expect(out[0].payload).toMatchObject({ applyMode: "refresh_section", target: "home", competitorId: COMP });
    const brief = String(out[0].payload.brief);
    expect(brief).toContain("hero");
    expect(brief).toContain("Do not mention the competitor");
    expect(`${out[0].headline} ${out[0].rationale} ${brief}`).not.toMatch(/ploy/i);
  });
  it("ignores rows with only price noise or a single heading tweak", () => {
    expect(detectCompetitorShifts([diffRow({ newPrices: ["$1.00"], removedPrices: ["$2.00"] })])).toHaveLength(0);
    expect(detectCompetitorShifts([diffRow({ newHeadings: ["Sale"] })])).toHaveLength(0);
  });
});

describe("detectCompetitors", () => {
  it("concatenates both families", () => {
    const out = detectCompetitors([
      diffRow({ newPrices: ["$99.00"], removedPrices: ["$129.00"] }),
      diffRow({ titleChanged: { from: "a", to: "b" }, newHeadings: ["x", "y"] }, "https://rival.example/"),
    ]);
    expect(out.map((c) => c.kind).sort()).toEqual(["competitor_counter", "competitor_price"]);
  });
});
