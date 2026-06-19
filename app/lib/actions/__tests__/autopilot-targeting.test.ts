import { describe, it, expect, vi } from "vitest";
import { resolveScopedCandidates } from "../autopilot-targeting.server";
import type { ReallocationCandidate } from "../reallocation-suggest.server";

const graded: ReallocationCandidate[] = [
  { campaignId: "c-poor", externalId: "x1", platform: "meta", name: "P", dailyBudgetCents: 5000, grade: "poor", roas: 0.4 },
  { campaignId: "c-win",  externalId: "x2", platform: "google", name: "W", dailyBudgetCents: 9000, grade: "winning", roas: 3.1 },
];

describe("resolveScopedCandidates", () => {
  it("maps a shop-scoped ad_tax_overload alert to the worst-graded source campaign", async () => {
    const alerts = [{ id: "a1", detector_id: "ad_tax_overload", dollar_impact: 120, entity_ref: { scope: "shop" } }];
    const sb = { from: vi.fn() } as never;
    const out = await resolveScopedCandidates("shop1", alerts as never, graded, sb);
    expect(out).toEqual([
      { alert_id: "a1", detector_id: "ad_tax_overload", dollar_impact: 120, campaign_id: "c-poor", campaign_spend_cents: 5000, daily_budget_cents: 5000 },
    ]);
  });

  it("drops an alert when the pool has no eligible (non-winning) source", async () => {
    const onlyWinner = [graded[1]];
    const alerts = [{ id: "a1", detector_id: "ad_tax_overload", dollar_impact: 120, entity_ref: { scope: "shop" } }];
    const out = await resolveScopedCandidates("shop1", alerts as never, onlyWinner, {} as never);
    expect(out).toEqual([]);
  });
});
