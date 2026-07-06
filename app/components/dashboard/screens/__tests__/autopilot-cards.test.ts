import { describe, it, expect } from "vitest";
import { moneyVerb, reasonLines } from "../autopilot-cards";

describe("moneyVerb", () => {
  it("returns Earns for growth actions", () => {
    expect(moneyVerb("increase_campaign_budget")).toBe("Earns");
    expect(moneyVerb("reallocate_budget")).toBe("Earns");
    expect(moneyVerb("reallocate_spend_sku")).toBe("Earns");
    expect(moneyVerb("create_po_draft")).toBe("Earns");
  });

  it("returns Keeps for loss-stopping and unknown actions", () => {
    expect(moneyVerb("pause_campaign")).toBe("Keeps");
    expect(moneyVerb("reduce_campaign_budget")).toBe("Keeps");
    expect(moneyVerb("exclude_geo")).toBe("Keeps");
    expect(moneyVerb("something_new")).toBe("Keeps");
  });
});

describe("reasonLines", () => {
  it("returns the narrative when present, trimmed", () => {
    const r = reasonLines("  Spend up 40% but sales flat.  ", "campaign_below_breakeven");
    expect(r.category).toBe("Campaign is losing money");
    expect(r.narrative).toBe("Spend up 40% but sales flat.");
  });

  it("falls back to category only when narrative is blank", () => {
    expect(reasonLines("", "campaign_below_breakeven").narrative).toBeNull();
    expect(reasonLines("   ", "campaign_below_breakeven").narrative).toBeNull();
    expect(reasonLines(null, "campaign_below_breakeven").narrative).toBeNull();
    expect(reasonLines(undefined, "campaign_below_breakeven").narrative).toBeNull();
  });

  it("uses detectorLabel for the category, humanizing unknown ids", () => {
    expect(reasonLines("x", "campaign_below_breakeven").category).toBe("Campaign is losing money");
    expect(reasonLines("x", "brand_new_detector").category).toBe("Brand New Detector");
  });
});
