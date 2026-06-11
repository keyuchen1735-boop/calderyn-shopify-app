import { describe, it, expect } from "vitest";

import { adaptAlert } from "../client";
import type { Alert } from "~/lib/types";
import type { CampaignVM } from "~/components/dashboard/view-models";

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: "a1",
    detector_id: "regional_spend_starved_stock",
    severity: "high",
    status: "open",
    claude_rank: 1,
    dollar_impact: 50_000,
    created_at: "2026-06-11T12:00:00Z",
    title: "Paying for ads where you're out of stock",
    narrative: "Texas spend is fanning out to a starved SKU.",
    campaign: null,
    sku: "SKU-1",
    evidence: {},
    ...overrides,
  } as Alert;
}

const CAMPAIGNS = [{ id: "c1", name: "Summer Sale" } as CampaignVM];

describe("adaptAlert action list", () => {
  it("offers reallocate_inventory for detectors that expose it, and recommends it", () => {
    const vm = adaptAlert(makeAlert(), CAMPAIGNS);
    expect(vm.actions).toContain("reallocate_inventory");
    expect(vm.actions).toContain("snooze_alert");
    // Only live-executable kinds may render as buttons; exclude_geo has no
    // dashboard endpoint yet and must stay hidden.
    expect(vm.actions).not.toContain("exclude_geo");
    expect(vm.actions).not.toContain("pause_campaign");
    expect(vm.recommended).toBe("reallocate_inventory");
  });

  it("keeps campaign actions first for campaign-linked alerts", () => {
    const vm = adaptAlert(
      makeAlert({ detector_id: "campaign_below_breakeven", campaign: "Summer Sale", sku: null }),
      CAMPAIGNS,
    );
    expect(vm.actions.slice(0, 2)).toEqual(["pause_campaign", "reduce_campaign_budget"]);
    expect(vm.actions).not.toContain("reallocate_inventory");
    expect(vm.recommended).toBe("pause_campaign");
  });

  it("stays snooze-only with no recommendation for snooze-only detectors", () => {
    const vm = adaptAlert(makeAlert({ detector_id: "margin_erosion" }), CAMPAIGNS);
    expect(vm.actions).toEqual(["snooze_alert"]);
    expect(vm.recommended).toBeNull();
  });
});
