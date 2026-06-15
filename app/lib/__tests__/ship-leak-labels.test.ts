import { describe, it, expect } from "vitest";
import {
  DETECTOR_LABELS,
  DETECTOR_TERMS,
  DETECTOR_TO_ACTIONS,
  ACTION_LABELS,
  ACTION_VERBS,
  EVIDENCE_LABELS,
} from "~/lib/labels";

describe("free_shipping_leakage labels", () => {
  it("has a plain label and analyst term", () => {
    expect(DETECTOR_LABELS.free_shipping_leakage).toMatch(/free ship/i);
    expect(DETECTOR_TERMS.free_shipping_leakage).toMatch(/leakage/i);
  });
  it("allows the two free-ship actions plus snooze", () => {
    expect(DETECTOR_TO_ACTIONS.free_shipping_leakage).toEqual([
      "raise_free_ship_threshold",
      "exclude_sku_free_ship",
      "snooze_alert",
    ]);
  });
  it("the two actions have labels and verbs", () => {
    expect(ACTION_LABELS.raise_free_ship_threshold).toBe("Raise free-shipping threshold");
    expect(ACTION_LABELS.exclude_sku_free_ship).toBe("Exclude SKU from free shipping");
    expect(ACTION_VERBS.raise_free_ship_threshold).toBe("Raised free-ship threshold");
    expect(ACTION_VERBS.exclude_sku_free_ship).toBe("Excluded SKU from free shipping");
  });
  it("labels the new evidence keys", () => {
    expect(EVIDENCE_LABELS.net_shipping_pnl_usd).toBe("Net shipping P&L");
    expect(EVIDENCE_LABELS.ship_cost_confidence).toBe("Ship-cost confidence");
  });
});
