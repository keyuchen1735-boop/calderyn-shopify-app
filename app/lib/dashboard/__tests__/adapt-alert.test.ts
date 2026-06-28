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
    // exclude_geo needs both a campaign and a valid region bucket; this alert has
    // neither, so it stays a deep-link rather than an execute button.
    expect(vm.actions).not.toContain("exclude_geo");
    expect(vm.actions).not.toContain("pause_campaign");
    expect(vm.recommended).toBe("reallocate_inventory");
  });

  it("offers exclude_geo as an executable action when the alert has a campaign and a valid region bucket", () => {
    const vm = adaptAlert(
      makeAlert({
        detector_id: "regional_spend_starved_stock",
        campaign_id: "c1",
        evidence: { region: "us-central" },
      }),
      CAMPAIGNS,
    );
    expect(vm.actions).toContain("exclude_geo");
    expect(vm.region).toBe("us-central");
    // Executable → it must NOT also appear as a deep-link (no double surface).
    expect(vm.deepLinkKinds ?? []).not.toContain("exclude_geo");
  });

  it("keeps exclude_geo a deep-link when the evidence region is a state, not one of the four buckets", () => {
    // The engine emits state-form regions (e.g. US-TX) in some evidence; the
    // executor only accepts the four buckets, so a non-bucket must NOT render a
    // button that would 422 — it stays the Ads Manager deep-link.
    const vm = adaptAlert(
      makeAlert({
        detector_id: "regional_spend_starved_stock",
        campaign_id: "c1",
        evidence: { region: "US-TX" },
      }),
      CAMPAIGNS,
    );
    expect(vm.actions).not.toContain("exclude_geo");
    expect(vm.deepLinkKinds).toContain("exclude_geo");
    expect(vm.region).toBeUndefined();
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

  it("disambiguates same-named campaigns by the alert's campaign_id, not name", () => {
    // Two active campaigns share a name; only the id resolves the right one.
    // A name match would wrongly pick the first ("c1").
    const dupes = [
      { id: "c1", name: "Summer Sale" } as CampaignVM,
      { id: "c2", name: "Summer Sale" } as CampaignVM,
    ];
    const vm = adaptAlert(
      makeAlert({ detector_id: "campaign_below_breakeven", campaign: "Summer Sale", campaign_id: "c2", sku: null }),
      dupes,
    );
    expect(vm.campaign_id).toBe("c2");
  });

  it("offers increase_campaign_budget (and recommends it) for a campaign_scaling_opportunity alert", () => {
    const vm = adaptAlert(
      makeAlert({
        detector_id: "campaign_scaling_opportunity",
        campaign: "Summer Sale",
        sku: null,
        evidence: { daily_budget_cents: "10000", increase_pct: "25" },
      }),
      CAMPAIGNS,
    );
    expect(vm.actions).toContain("increase_campaign_budget");
    expect(vm.recommended).toBe("increase_campaign_budget");
    // A winning campaign must not offer pause/reduce (wrong direction) — parity
    // with the embedded surface, whose recommended action is the scale-up.
    expect(vm.actions).not.toContain("pause_campaign");
    expect(vm.actions).not.toContain("reduce_campaign_budget");
  });

  it("stays snooze-only with no recommendation for snooze-only detectors", () => {
    const vm = adaptAlert(makeAlert({ detector_id: "margin_erosion" }), CAMPAIGNS);
    expect(vm.actions).toEqual(["snooze_alert"]);
    expect(vm.recommended).toBeNull();
  });

  it("surfaces free-shipping kinds as deep-link kinds (no executor → manual deep-link, not a dead button)", () => {
    const vm = adaptAlert(makeAlert({ detector_id: "free_shipping_leakage", sku: "SKU-1" }), CAMPAIGNS);
    // No executor exists, so they must NOT be execute buttons...
    expect(vm.actions).not.toContain("raise_free_ship_threshold");
    expect(vm.actions).not.toContain("exclude_sku_free_ship");
    // ...but the UI gets them as deep-link kinds so it can link to Shipping settings.
    expect(vm.deepLinkKinds).toContain("raise_free_ship_threshold");
    expect(vm.deepLinkKinds).toContain("exclude_sku_free_ship");
  });

  it("surfaces exclude_geo as a deep-link kind (no per-region exclusion executor)", () => {
    // regional_spend_starved_stock lists exclude_geo; it has no executor, so it
    // must surface as a deep-link, never an execute button.
    const vm = adaptAlert(makeAlert({ detector_id: "regional_spend_starved_stock" }), CAMPAIGNS);
    expect(vm.actions).not.toContain("exclude_geo");
    expect(vm.deepLinkKinds).toContain("exclude_geo");
  });

  it("has no deep-link kinds for a detector whose actions are all executable", () => {
    const vm = adaptAlert(
      makeAlert({ detector_id: "campaign_below_breakeven", campaign: "Summer Sale", sku: null }),
      CAMPAIGNS,
    );
    expect(vm.deepLinkKinds ?? []).toHaveLength(0);
  });
});

describe("adaptAlert remediation passthrough", () => {
  it("passes remediation + rec_detail through to the view model", () => {
    const vm = adaptAlert(
      makeAlert({
        detector_id: "negative_unit_economics",
        sku: "Summit Logo Tee — M",
        evidence: { gross_unit_margin_usd: 23, cac_per_unit_usd: 170 },
        remediation: {
          moves: [
            { kind: "reallocate_to_winner", dollarImpactCents: 530449, executor: null, label: "x" },
            { kind: "snooze", dollarImpactCents: 0, executor: "snooze_alert", label: "Snooze" },
          ],
          recommended: "reallocate_to_winner",
          structurallyDead: false,
        },
        rec_detail: "synopsis here",
      }),
      [],
    );
    expect(vm.remediation?.recommended).toBe("reallocate_to_winner");
    expect(vm.rec_detail).toBe("synopsis here");
  });

  it("non-product alerts keep the legacy campaign-gated actions, remediation null", () => {
    const vm = adaptAlert(
      makeAlert({
        detector_id: "sku_stockout_vs_spend",
        remediation: null,
        rec_detail: "",
        campaign_id: "c1",
      }),
      CAMPAIGNS,
    );
    expect(vm.remediation).toBeNull();
    expect(vm.actions).toContain("pause_campaign");
  });
});
