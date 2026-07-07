import { describe, it, expect } from "vitest";

import { canOneClickAlert } from "../one-click";
import type { AlertVM } from "~/components/dashboard/view-models";

function makeVM(overrides: Partial<AlertVM> = {}): AlertVM {
  return {
    id: "a1",
    detector_id: "wrong_location_concentration",
    severity: "high",
    status: "open",
    claude_rank: 1,
    dollar_impact: 1000,
    created_at: "2026-07-06T00:00:00Z",
    title: "t",
    narrative: "n",
    campaign: null,
    sku: "SKU-1",
    evidence: {},
    campaign_id: null,
    region: undefined,
    actions: [],
    deepLinkKinds: [],
    recommended: null,
    rec_detail: "",
    remediation: null,
    ...overrides,
  } as AlertVM;
}

describe("canOneClickAlert — reallocate_inventory", () => {
  it("is false when the evidence has no transfer plan (would 422)", () => {
    expect(canOneClickAlert(makeVM({ evidence: {} }), "reallocate_inventory")).toBe(false);
  });

  it("is true when the evidence carries a complete transfer plan", () => {
    const vm = makeVM({
      evidence: {
        inventory_item_id: "inv-1",
        from_location_id: "loc-a",
        to_location_id: "loc-b",
        recommended_delta: "12",
      },
    });
    expect(canOneClickAlert(vm, "reallocate_inventory")).toBe(true);
  });

  it("is false for a missing alert or a non-whitelisted kind", () => {
    expect(canOneClickAlert(undefined, "reallocate_inventory")).toBe(false);
    expect(canOneClickAlert(makeVM(), "adjust_price")).toBe(false);
  });
});
