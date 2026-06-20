// app/lib/__tests__/row-to-alert-remediation.test.ts
import { describe, it, expect } from "vitest";
import { attachRemediation } from "../calderyn.server";
import type { Alert } from "../types";

function baseAlert(p: Partial<Alert>): Alert {
  return {
    id: "a1",
    detector_id: "negative_unit_economics",
    severity: "high",
    status: "open",
    dollar_impact: 530449,
    claude_rank: 1,
    created_at: "2026-06-20T00:00:00Z",
    title: "Summit Logo Tee — M",
    narrative: "Acquisition cost is pushing the net per unit below zero.",
    campaign: null,
    campaign_id: null,
    campaign_external_id: null,
    sku: "Summit Logo Tee — M",
    evidence: {},
    remediation: null,
    rec_detail: "",
    ...p,
  };
}

describe("attachRemediation", () => {
  it("fills remediation + synopsis for a product-economics alert", () => {
    const a = attachRemediation(
      baseAlert({
        evidence: { gross_unit_margin_usd: 23, cac_per_unit_usd: 170, net_per_unit_usd: -147 },
      }),
    );
    expect(a.remediation?.recommended).toBe("reallocate_to_winner");
    expect(a.rec_detail).toContain("$170");
  });

  it("leaves non-product-economics alerts untouched (null plan, empty synopsis)", () => {
    const a = attachRemediation(baseAlert({ detector_id: "sku_stockout_vs_spend" }));
    expect(a.remediation).toBeNull();
    expect(a.rec_detail).toBe("");
  });
});
