import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aggregateLiveEngine, setPairAutonomy } from "../live-engine.server";

const NOW = new Date("2026-06-21T12:00:00Z").getTime();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

describe("aggregateLiveEngine", () => {
  it("aggregates autonomous money + count per pair and the this-week total", () => {
    const pairs = [
      { detector_id: "campaign_below_breakeven", action_kind: "pause_campaign", merchant_disabled: false },
      { detector_id: "sku_stockout_vs_spend", action_kind: "pause_campaign", merchant_disabled: true },
    ];
    // dollar_impact_at_exec is stored in DOLLARS.
    const audit = [
      { detector_id: "campaign_below_breakeven", action_kind: "pause_campaign", dollar_impact_at_exec: 50, created_at: iso(1) },
      { detector_id: "campaign_below_breakeven", action_kind: "pause_campaign", dollar_impact_at_exec: 30, created_at: iso(10) },
      { detector_id: "sku_stockout_vs_spend", action_kind: "pause_campaign", dollar_impact_at_exec: 20, created_at: iso(2) },
    ];
    const out = aggregateLiveEngine(pairs, audit, NOW);

    const f1 = out.features.find((f) => f.detectorId === "campaign_below_breakeven")!;
    expect(f1.moneyCents).toBe(8000); // ($50 + $30) -> cents
    expect(f1.actions).toBe(2);
    expect(f1.enabled).toBe(true);
    expect(f1.lastAt).toBe(iso(1)); // most recent

    const f2 = out.features.find((f) => f.detectorId === "sku_stockout_vs_spend")!;
    expect(f2.moneyCents).toBe(2000);
    expect(f2.actions).toBe(1);
    expect(f2.enabled).toBe(false); // merchant_disabled -> paused

    // this week = $50 + $20 ($30 from 10d ago is excluded) -> 7000 cents
    expect(out.moneyProtectedWeekCents).toBe(7000);
  });

  it("includes graduated pairs that have not acted yet, zeroed", () => {
    const out = aggregateLiveEngine(
      [{ detector_id: "campaign_below_breakeven", action_kind: "pause_campaign", merchant_disabled: false }],
      [],
      NOW,
    );
    expect(out.features).toHaveLength(1);
    expect(out.features[0].moneyCents).toBe(0);
    expect(out.features[0].actions).toBe(0);
    expect(out.features[0].lastAt).toBeNull();
    expect(out.moneyProtectedWeekCents).toBe(0);
  });

  it("sorts by money desc and labels each feature (no em dashes)", () => {
    const out = aggregateLiveEngine(
      [
        { detector_id: "campaign_below_breakeven", action_kind: "pause_campaign", merchant_disabled: false },
        { detector_id: "sku_stockout_vs_spend", action_kind: "pause_campaign", merchant_disabled: false },
      ],
      [{ detector_id: "sku_stockout_vs_spend", action_kind: "pause_campaign", dollar_impact_at_exec: 99, created_at: iso(1) }],
      NOW,
    );
    expect(out.features[0].detectorId).toBe("sku_stockout_vs_spend"); // higher money first
    for (const f of out.features) {
      expect(f.name.length).toBeGreaterThan(0);
      expect(f.watching.length).toBeGreaterThan(0);
      expect(f.name).not.toMatch(/[—–]/);
      expect(f.watching).not.toMatch(/[—–]/);
    }
  });
});

/* Minimal Supabase mock: captures the update payload, resolves { error: null }. */
type Chain = {
  update: (p: Record<string, unknown>) => Chain;
  eq: () => Chain;
  then: (res: (v: { error: null }) => void) => void;
};
function mockSb(cap: { payload?: Record<string, unknown> }): SupabaseClient {
  const chain: Chain = {
    update: (p) => {
      cap.payload = p;
      return chain;
    },
    eq: () => chain,
    then: (res) => res({ error: null }),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

describe("setPairAutonomy", () => {
  it("disabling sets merchant_disabled=true (always-safe direction)", async () => {
    const cap: { payload?: Record<string, unknown> } = {};
    const r = await setPairAutonomy("shop-1", "campaign_below_breakeven", "pause_campaign", false, mockSb(cap));
    expect(r.ok).toBe(true);
    expect(cap.payload?.merchant_disabled).toBe(true);
  });

  it("enabling sets merchant_disabled=false", async () => {
    const cap: { payload?: Record<string, unknown> } = {};
    const r = await setPairAutonomy("shop-1", "campaign_below_breakeven", "pause_campaign", true, mockSb(cap));
    expect(r.ok).toBe(true);
    expect(cap.payload?.merchant_disabled).toBe(false);
  });
});
