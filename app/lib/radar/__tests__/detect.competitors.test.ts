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
  it("stays GENERIC (no was/now pairing anywhere) when only set-difference fields changed", () => {
    // newPrices/removedPrices are unordered page-wide set differences - nothing ties
    // removedPrices[0] to newPrices[0], so this case must never claim a specific
    // "$129.00 is now $99.00" pairing (per the truthfulness contract in types.ts).
    const out = detectCompetitorPriceMoves([diffRow({ newPrices: ["$99.00"], removedPrices: ["$129.00"] })]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("competitor_price");
    expect(out[0].dedupKey).toBe(`comp-price:${COMP}:/products/boots`);
    // Pricing moves are informational ALWAYS - review mode, deep link, no auto-apply.
    expect(out[0].payload).toMatchObject({ applyMode: "review", deepLink: "/dashboard/products" });
    expect(out[0].headline).toContain("Rival Gear");
    expect(out[0].rationale).toContain("Rival Gear");
    expect(out[0].rationale).toContain(`their "boots" page`);
    const allCopy = [out[0].headline, out[0].rationale, ...out[0].evidence.chips].join(" ");
    expect(allCopy).not.toMatch(/\bwas\s/i);
    expect(allCopy).not.toMatch(/\bnow\s/i);
    expect(allCopy).not.toContain("$99.00");
    expect(allCopy).not.toContain("$129.00");
    // Raw set-difference arrays may still live in evidence.facts for audit.
    expect(out[0].evidence.facts).toMatchObject({
      url: "https://rival.example/products/boots",
      newPrices: ["$99.00"],
      removedPrices: ["$129.00"],
    });
  });
  it("drafts a specific labeled claim when priceChanges pairs a product with its from->to move", () => {
    const out = detectCompetitorPriceMoves([
      diffRow({
        newPrices: ["$99.00"],
        removedPrices: ["$129.00"],
        priceChanges: [{ label: "Boots", from: "$129.00", to: "$99.00" }],
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("competitor_price");
    expect(out[0].dedupKey).toBe(`comp-price:${COMP}:/products/boots`);
    expect(out[0].payload).toMatchObject({ applyMode: "review", deepLink: "/dashboard/products" });
    const allCopy = [out[0].headline, out[0].rationale, ...out[0].evidence.chips].join(" ");
    expect(allCopy).toContain("Boots");
    expect(allCopy).toContain("$129.00");
    expect(allCopy).toContain("$99.00");
    expect(out[0].rationale).toMatch(/Boots.*\$129\.00 is now \$99\.00/);
    expect(out[0].evidence.facts).toMatchObject({
      priceChanges: [{ label: "Boots", from: "$129.00", to: "$99.00" }],
    });
    expect(`${out[0].headline} ${out[0].rationale}`).not.toMatch(/ploy/i);
  });
  it("names additional changes when priceChanges has more than one entry", () => {
    const out = detectCompetitorPriceMoves([
      diffRow({
        newPrices: ["$99.00", "$40.00"],
        removedPrices: ["$129.00", "$50.00"],
        priceChanges: [
          { label: "Boots", from: "$129.00", to: "$99.00" },
          { label: "Gloves", from: "$50.00", to: "$40.00" },
        ],
      }),
    ]);
    expect(out[0].rationale).toMatch(/and 1 more change/);
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
