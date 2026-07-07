import { describe, it, expect } from "vitest";
import { oneClickKind, canOneClickAlert } from "../one-click";
import type { AlertVM } from "~/components/dashboard/view-models";

const alert = (over: Partial<AlertVM> = {}): AlertVM =>
  ({ id: "a1", campaign_id: "c1", region: null, ...over }) as unknown as AlertVM;

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

describe("one-click resume_campaign (restock → resume ads)", () => {
  it("treats resume_campaign as a one-click, executable kind", () => {
    // Previously false, so an approved 'resume ads when restocked' proposal routed
    // to Review and dead-ended (no resume affordance on the alert surface).
    expect(oneClickKind("resume_campaign")).toBe(true);
  });

  it("can one-click resume when the alert carries a campaign id", () => {
    expect(canOneClickAlert(alert({ campaign_id: "c1" }), "resume_campaign")).toBe(true);
  });

  it("cannot one-click resume without a campaign id (would 422)", () => {
    expect(canOneClickAlert(alert({ campaign_id: null }), "resume_campaign")).toBe(false);
  });
});

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
