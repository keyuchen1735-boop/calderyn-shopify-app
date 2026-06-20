// app/lib/remediation/__tests__/synopsis.test.ts
import { describe, it, expect } from "vitest";
import { synopsisFor } from "../synopsis";
import { rankMoves } from "../rank";
import type { RemediationInput } from "../types";

function withSynopsis(p: RemediationInput) {
  return synopsisFor(rankMoves(p), p);
}

describe("synopsisFor", () => {
  it("viable-but-ad-bled product explains it's the ads, not the product", () => {
    const s = withSynopsis({
      detectorId: "negative_unit_economics",
      dollarImpactCents: 530449,
      evidence: { gross_unit_margin_usd: 23, cac_per_unit_usd: 170, net_per_unit_usd: -147 },
    });
    expect(s).toContain("$23");
    expect(s).toContain("$170");
    expect(s.toLowerCase()).toContain("ad");
    expect(s.toLowerCase()).not.toContain("stop reordering");
  });

  it("structurally dead product tells the merchant to stop reordering", () => {
    const s = withSynopsis({
      detectorId: "negative_unit_economics",
      dollarImpactCents: 50000,
      evidence: { gross_unit_margin_usd: -4, net_per_unit_usd: -34 },
    });
    expect(s.toLowerCase()).toContain("stop");
  });

  it("returns synopsis names the return rate and the recovered dollars", () => {
    const s = withSynopsis({
      detectorId: "return_rate_hidden_loss",
      dollarImpactCents: 100000,
      evidence: { unit_margin_usd: 12, return_rate: 0.31, return_30d_usd: 1800 },
    });
    expect(s).toContain("31%");
    expect(s).toContain("$1,800");
  });

  it("never returns an empty string for any in-scope detector", () => {
    for (const detectorId of [
      "negative_unit_economics",
      "ad_tax_overload",
      "return_rate_hidden_loss",
      "margin_erosion",
      "cogs_drift",
    ] as const) {
      const s = withSynopsis({ detectorId, dollarImpactCents: 10000, evidence: {} });
      expect(s.length).toBeGreaterThan(0);
    }
  });
});
