import { describe, it, expect } from "vitest";
import { planTick } from "../tick.server";
import { DEFAULT_BUDGET_CONFIG } from "../score.server";
import type { GateStatic } from "../guardrails.server";
import type { MetaCampaign } from "../../meta/campaigns.server";

function campaign(over: Partial<MetaCampaign>): MetaCampaign {
  return { id: "c", name: "C", status: "ACTIVE", effectiveStatus: "ACTIVE", dailyBudgetCents: 5000, ...over };
}

function openGate(over: Partial<GateStatic> = {}): GateStatic {
  return {
    nowUtc: new Date("2026-06-02T15:00:00Z"),
    businessHoursStartUtc: 0,
    businessHoursEndUtc: 0, // always open
    cooldownMinutes: 30,
    dollarCapCents: 1_000_000,
    dailyActionBudgetCents: 1_000_000,
    lastActionAtByCampaign: {},
    ...over,
  };
}

describe("planTick", () => {
  it("cuts losers, then feeds winners from the realized pool, staying budget-neutral", () => {
    const campaigns = [
      campaign({ id: "loser", dailyBudgetCents: 5000 }),
      campaign({ id: "winner", dailyBudgetCents: 8000 }),
    ];
    const insights = {
      loser: { spend7dCents: 10000, roas7d: 0.7 },
      winner: { spend7dCents: 10000, roas7d: 3.1 },
    };
    const plan = planTick(campaigns, insights, DEFAULT_BUDGET_CONFIG, openGate(), 0);
    expect(plan.cuts).toHaveLength(1);
    expect(plan.cuts[0]).toMatchObject({ campaignId: "loser", toCents: 4000, decision: "execute" });
    expect(plan.feeds).toHaveLength(1);
    // realized pool = 1000; winner ceiling = 1600 -> add 1000
    expect(plan.feeds[0]).toMatchObject({ campaignId: "winner", deltaCents: 1000, toCents: 9000, decision: "execute" });
    expect(plan.breachingCampaignIds).toEqual(["loser"]);
    expect(plan.loserAlerts[0].entity_ref.campaign_id).toBe("loser");
  });

  it("does NOT feed from a blocked cut -- a blocked cut contributes nothing to the pool", () => {
    const campaigns = [
      campaign({ id: "loser", dailyBudgetCents: 5000 }),
      campaign({ id: "winner", dailyBudgetCents: 8000 }),
    ];
    const insights = {
      loser: { spend7dCents: 10000, roas7d: 0.7 },
      winner: { spend7dCents: 10000, roas7d: 3.1 },
    };
    // cap below the cut magnitude (1000) -> cut blocked -> pool stays 0 -> no feeds
    const plan = planTick(campaigns, insights, DEFAULT_BUDGET_CONFIG, openGate({ dollarCapCents: 500 }), 0);
    expect(plan.cuts[0].decision).toBe("block");
    expect(plan.feeds).toEqual([]);
  });
});
