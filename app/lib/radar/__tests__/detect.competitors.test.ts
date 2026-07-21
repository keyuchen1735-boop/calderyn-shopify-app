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
    // Aggregated per-competitor (no page/date component), like comp-counter.
    expect(out[0].dedupKey).toBe(`comp-price:${COMP}`);
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
    // Marks the copy as the generic (unpaired) case for the drafter's polish gate.
    expect(out[0].evidence.facts).toMatchObject({ pricingClaim: "generic" });
    // Raw set-difference arrays may still live in evidence.facts (nested per page) for audit.
    expect(out[0].evidence.facts).toMatchObject({
      pages: [expect.objectContaining({
        url: "https://rival.example/products/boots",
        newPrices: ["$99.00"],
        removedPrices: ["$129.00"],
      })],
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
    expect(out[0].dedupKey).toBe(`comp-price:${COMP}`);
    expect(out[0].payload).toMatchObject({ applyMode: "review", deepLink: "/dashboard/products" });
    const allCopy = [out[0].headline, out[0].rationale, ...out[0].evidence.chips].join(" ");
    expect(allCopy).toContain("Boots");
    expect(allCopy).toContain("$129.00");
    expect(allCopy).toContain("$99.00");
    expect(out[0].rationale).toMatch(/Boots.*\$129\.00 is now \$99\.00/);
    expect(out[0].evidence.facts).toMatchObject({
      pricingClaim: "labeled",
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

  describe("per-competitor aggregation (a site-wide sale drafts ONE move, not one per page)", () => {
    it("aggregates multiple generic (set-difference-only) pages into a single move", () => {
      const out = detectCompetitorPriceMoves([
        diffRow({ newPrices: ["$99.00"], removedPrices: ["$129.00"] }, "https://rival.example/products/boots"),
        diffRow({ newPrices: ["$40.00"], removedPrices: ["$50.00"] }, "https://rival.example/products/gloves"),
        diffRow({ newPrices: ["$10.00"], removedPrices: ["$15.00"] }, "https://rival.example/products/hats"),
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].dedupKey).toBe(`comp-price:${COMP}`);
      expect(out[0].rationale).toMatch(/changed prices on 3 pages/);
      expect(out[0].evidence.facts).toMatchObject({ pricingClaim: "generic" });
      const facts = out[0].evidence.facts as { pages: unknown[] };
      expect(facts.pages).toHaveLength(3);
      const allCopy = [out[0].headline, out[0].rationale, ...out[0].evidence.chips].join(" ");
      expect(allCopy).not.toMatch(/\bwas\s/i);
      expect(allCopy).not.toMatch(/\bnow\s/i);
    });
    it("aggregates a mix of labeled and generic-only pages into one move, leading with the first labeled change", () => {
      const out = detectCompetitorPriceMoves([
        diffRow({
          newPrices: ["$99.00"], removedPrices: ["$129.00"],
          priceChanges: [{ label: "Boots", from: "$129.00", to: "$99.00" }],
        }, "https://rival.example/products/boots"),
        diffRow({ newPrices: ["$40.00"], removedPrices: ["$50.00"] }, "https://rival.example/products/gloves"),
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].dedupKey).toBe(`comp-price:${COMP}`);
      expect(out[0].rationale).toMatch(/Boots.*\$129\.00 is now \$99\.00/);
      expect(out[0].rationale).toMatch(/and 1 more change/);
      expect(out[0].evidence.facts).toMatchObject({ pricingClaim: "labeled" });
      const allCopy = [out[0].headline, out[0].rationale, ...out[0].evidence.chips].join(" ");
      expect(allCopy).not.toContain("$40.00"); // generic page's prices stay unlabeled
      expect(allCopy).not.toContain("$50.00");
    });
    it("keeps separate competitors as separate moves", () => {
      const out = detectCompetitorPriceMoves([
        diffRow({ newPrices: ["$99.00"], removedPrices: ["$129.00"] }, "https://rival.example/products/boots"),
        {
          ...diffRow({ newPrices: ["$1.00"], removedPrices: ["$2.00"] }, "https://other.example/products/x"),
          competitorId: "33333333-3333-4333-8333-333333333333",
          competitorName: "Other Co",
        },
      ]);
      expect(out).toHaveLength(2);
      expect(out.map((o) => o.dedupKey).sort()).toEqual([
        `comp-price:${COMP}`,
        "comp-price:33333333-3333-4333-8333-333333333333",
      ]);
    });
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
