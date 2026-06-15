import { describe, it, expect } from "vitest";
import { actorLabel, MARGIN_BASIS_LABELS, COST_SOURCE_LABELS } from "../labels";

describe("actorLabel normalization", () => {
  it("maps known internal actors to merchant language", () => {
    expect(actorLabel("merchant")).toBe("You");
    expect(actorLabel("autopilot")).toBe("Autopilot");
    expect(actorLabel("system")).toBe("System");
  });
  it("normalizes the web-dashboard suffix", () => {
    expect(actorLabel("merchant:web-dashboard")).toBe("You (dashboard)");
  });
  it("passes an unknown teammate email through unchanged", () => {
    expect(actorLabel("jane@store.com")).toBe("jane@store.com");
  });
});

describe("margin-basis + cost-source labels", () => {
  it("labels each margin basis", () => {
    expect(MARGIN_BASIS_LABELS.measured).toBe("Measured from budget change");
    expect(MARGIN_BASIS_LABELS.alert_estimate).toBe("Estimated from alert (at-stake)");
    expect(MARGIN_BASIS_LABELS.snapshot).toBe("Estimate snapshot");
    expect(MARGIN_BASIS_LABELS.none).toBe("No booked margin");
  });
  it("labels each cost source", () => {
    expect(COST_SOURCE_LABELS.quickbooks).toBe("QuickBooks");
    expect(COST_SOURCE_LABELS.vendor_invoice).toBe("Vendor invoice");
    expect(COST_SOURCE_LABELS.shopify).toBe("Shopify");
    expect(COST_SOURCE_LABELS.meta).toBe("Meta");
    expect(COST_SOURCE_LABELS.unavailable).toBe("source unavailable");
  });
});
