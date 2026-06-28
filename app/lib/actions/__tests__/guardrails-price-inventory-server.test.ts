// Server-side guardrail tests for checkPriceInventoryGuardrails.
// Uses the same fake SupabaseClient pattern as guardrails-server.test.ts.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkPriceInventoryGuardrails } from "../guardrails.server";

const SHOP = "00000000-0000-0000-0000-000000000020";

const baseConfig = {
  autopilot_enabled: true,
  autopilot_bypass_guardrails: false,
  autopilot_daily_action_cap: 10,
  autopilot_min_spend_cents: 5000,
  autopilot_max_budget_cut_pct: 50,
  autopilot_max_budget_increase_pct: 20,
  autopilot_max_daily_budget_cents: null,
  dollar_impact_cap_without_2fa: 10000,
  daily_action_budget: null,
  cooldown_minutes_per_campaign: 30,
  business_hours_only: false,
  business_hours_start_utc: 9,
  business_hours_end_utc: 17,
  autopilot_max_price_change_pct: 10,
  autopilot_max_inventory_units_per_move: 25,
};

/**
 * Minimal fake SupabaseClient for price/inventory guardrail tests.
 * No campaign-cooldown queries are issued by checkPriceInventoryGuardrails,
 * so we only need to handle guardrail_config and the two action_audit queries
 * (count + optional dollar rows).
 */
function fakeSb(opts: {
  config?: Record<string, unknown> | null;
  todayCount?: number;
  dollarRows?: Array<{ dollar_impact_at_exec: number }>;
}) {
  let auditCallCount = 0;

  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.gte = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.or = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => {
      if (table === "guardrail_config") {
        return {
          data: opts.config !== undefined ? opts.config : baseConfig,
          error: null,
        };
      }
      return { data: null, error: null };
    });
    chain.then = (resolve: (r: { count: number; data: unknown; error: null }) => unknown) => {
      if (table === "action_audit") {
        auditCallCount += 1;
        // First call = count (head:true). Second call = dollar rows.
        if (auditCallCount === 1) {
          return resolve({ count: opts.todayCount ?? 0, data: [], error: null });
        }
        return resolve({
          count: (opts.dollarRows ?? []).length,
          data: opts.dollarRows ?? [],
          error: null,
        });
      }
      return resolve({ count: 0, data: [], error: null });
    };
    return chain;
  }

  return { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
}

describe("checkPriceInventoryGuardrails", () => {
  beforeAll(() => vi.useFakeTimers().setSystemTime(new Date("2026-06-26T14:00:00Z")));
  afterAll(() => vi.useRealTimers());

  it("adjust_price: blocks when priceChangePct exceeds the cap", async () => {
    const sb = fakeSb({});
    const r = await checkPriceInventoryGuardrails(
      SHOP,
      { kind: "adjust_price", dollarImpactCents: 500, priceChangePct: 12 },
      sb,
    );
    // cap is 10 → 12 > 10 → blocked
    expect(r).toEqual({ allowed: false, reason: "price change exceeds max" });
  });

  it("adjust_price: allows when priceChangePct is within the cap", async () => {
    const sb = fakeSb({});
    const r = await checkPriceInventoryGuardrails(
      SHOP,
      { kind: "adjust_price", dollarImpactCents: 500, priceChangePct: 8 },
      sb,
    );
    expect(r.allowed).toBe(true);
  });

  it("reallocate_inventory: blocks when inventoryUnitsMoved exceeds the cap", async () => {
    const sb = fakeSb({});
    const r = await checkPriceInventoryGuardrails(
      SHOP,
      { kind: "reallocate_inventory", dollarImpactCents: 200, inventoryUnitsMoved: 50 },
      sb,
    );
    // cap is 25 → 50 > 25 → blocked
    expect(r).toEqual({ allowed: false, reason: "inventory move exceeds max units" });
  });

  it("reallocate_inventory: allows when cap is null (no unit cap configured)", async () => {
    const sb = fakeSb({
      config: { ...baseConfig, autopilot_max_inventory_units_per_move: null },
    });
    const r = await checkPriceInventoryGuardrails(
      SHOP,
      { kind: "reallocate_inventory", dollarImpactCents: 200, inventoryUnitsMoved: 10 },
      sb,
    );
    expect(r.allowed).toBe(true);
  });

  it("adjust_price with minSpendCents > 0 and campaignSpendCents = 0 is still ALLOWED (kind-guard)", async () => {
    // minSpendCents = 5000; campaignSpendCents defaults to 0 in the call.
    // isCampaignKind("adjust_price") = false → min-spend gate must be skipped.
    const sb = fakeSb({});
    const r = await checkPriceInventoryGuardrails(
      SHOP,
      { kind: "adjust_price", dollarImpactCents: 100, priceChangePct: 5 },
      sb,
    );
    expect(r.allowed).toBe(true);
  });

  it("blocks when the daily action cap is reached", async () => {
    const sb = fakeSb({ todayCount: 10 }); // cap = 10 → reached
    const r = await checkPriceInventoryGuardrails(
      SHOP,
      { kind: "adjust_price", dollarImpactCents: 100, priceChangePct: 5 },
      sb,
    );
    expect(r).toEqual({ allowed: false, reason: "daily action cap reached" });
  });

  it("returns no guardrail config when config row is missing", async () => {
    const sb = fakeSb({ config: null });
    const r = await checkPriceInventoryGuardrails(
      SHOP,
      { kind: "adjust_price", dollarImpactCents: 100, priceChangePct: 5 },
      sb,
    );
    expect(r).toEqual({ allowed: false, reason: "no guardrail config" });
  });
});
