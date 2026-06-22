// app/lib/remediation/__tests__/price.test.ts
import { describe, it, expect } from "vitest";
import { suggestAdjustPrice } from "../price";

describe("suggestAdjustPrice — margin_erosion restores the pre-erosion dollar margin", () => {
  it("raises price to current COGS + the baseline per-unit margin", () => {
    // Margin eroded from $9/unit to $7/unit. COGS is $8, price is $15.
    // Restore: new price = COGS ($8) + baseline margin ($9) = $17 → +13.3%, under the 15% cap.
    const s = suggestAdjustPrice({
      detectorId: "margin_erosion",
      evidence: { baseline_unit_margin_usd: 9, current_unit_margin_usd: 7 },
      currentPriceCents: 1500,
      currentCogsCents: 800,
      capPct: 15,
    });
    expect(s).toEqual({ newPriceCents: 1700, capped: false, basis: "margin_erosion" });
  });
});

describe("suggestAdjustPrice — cogs_drift passes the cost increase through", () => {
  it("raises price by exactly the per-unit cost increase (restores absolute margin)", () => {
    // Cost rose $5 → $7. Price is $15. Restore margin: new price = $15 + $2 = $17 → +13.3%.
    const s = suggestAdjustPrice({
      detectorId: "cogs_drift",
      evidence: { prior_unit_cost_usd: 5, current_unit_cost_usd: 7 },
      currentPriceCents: 1500,
      currentCogsCents: 700,
      capPct: 15,
    });
    expect(s).toEqual({ newPriceCents: 1700, capped: false, basis: "cogs_drift" });
  });
});

describe("suggestAdjustPrice — raise or hold, never auto-cut", () => {
  it("returns null when the restored price would be at or below the current price", () => {
    // Baseline margin $5 + COGS $8 = $13 target, but price is already $15. No raise to make.
    const s = suggestAdjustPrice({
      detectorId: "margin_erosion",
      evidence: { baseline_unit_margin_usd: 5 },
      currentPriceCents: 1500,
      currentCogsCents: 800,
      capPct: 15,
    });
    expect(s).toBeNull();
  });
});

describe("suggestAdjustPrice — clamps the raise to the guardrail cap", () => {
  it("caps the increase at capPct of the current price and flags capped=true", () => {
    // Target would be $8 COGS + $12 baseline margin = $20 (+33%), but the 15% cap
    // limits the raise to $15 × 1.15 = $17.25.
    const s = suggestAdjustPrice({
      detectorId: "margin_erosion",
      evidence: { baseline_unit_margin_usd: 12 },
      currentPriceCents: 1500,
      currentCogsCents: 800,
      capPct: 15,
    });
    expect(s).toEqual({ newPriceCents: 1725, capped: true, basis: "margin_erosion" });
  });
});

describe("suggestAdjustPrice — returns null on missing/invalid inputs", () => {
  const base = {
    currentPriceCents: 1500,
    currentCogsCents: 800,
    capPct: 15,
  } as const;

  it("margin_erosion without a baseline margin → null", () => {
    expect(
      suggestAdjustPrice({ ...base, detectorId: "margin_erosion", evidence: {} }),
    ).toBeNull();
  });

  it("margin_erosion without known COGS → null", () => {
    expect(
      suggestAdjustPrice({
        ...base,
        currentCogsCents: null,
        detectorId: "margin_erosion",
        evidence: { baseline_unit_margin_usd: 9 },
      }),
    ).toBeNull();
  });

  it("cogs_drift missing a cost figure → null", () => {
    expect(
      suggestAdjustPrice({
        ...base,
        detectorId: "cogs_drift",
        evidence: { prior_unit_cost_usd: 5 },
      }),
    ).toBeNull();
  });

  it("non-positive current price → null", () => {
    expect(
      suggestAdjustPrice({
        ...base,
        currentPriceCents: 0,
        detectorId: "margin_erosion",
        evidence: { baseline_unit_margin_usd: 9 },
      }),
    ).toBeNull();
  });

  it("a detector outside the price bases → null", () => {
    expect(
      suggestAdjustPrice({
        ...base,
        detectorId: "negative_unit_economics",
        evidence: { baseline_unit_margin_usd: 9 },
      }),
    ).toBeNull();
  });
});
