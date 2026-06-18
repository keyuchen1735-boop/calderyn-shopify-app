import { describe, it, expect } from "vitest";
import { recommendedAction } from "../labels";

// P2-14: the recommended action must fit the alert. A campaign action must never
// be recommended for an alert with no campaign attached (e.g. a SKU-level
// negative_unit_economics) — that was surfacing "Pause campaign" with nothing to
// pause.
describe("recommendedAction", () => {
  it("recommends pausing a campaign when one is attached", () => {
    expect(recommendedAction("negative_unit_economics", { hasCampaign: true })).toBe(
      "pause_campaign",
    );
  });

  it("never recommends a campaign action when no campaign is attached", () => {
    expect(recommendedAction("negative_unit_economics", { hasCampaign: false })).toBeNull();
  });

  it("recommends a PO draft for reorder timing, campaign or not", () => {
    expect(recommendedAction("reorder_timing", { hasCampaign: false })).toBe("create_po_draft");
  });

  it("falls back to a non-campaign remedy (exclude geo) for a no-campaign stockout-vs-spend", () => {
    expect(recommendedAction("sku_stockout_vs_spend", { hasCampaign: false })).toBe("exclude_geo");
  });
});
