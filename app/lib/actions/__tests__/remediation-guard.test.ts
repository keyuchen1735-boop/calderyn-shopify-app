// app/lib/actions/__tests__/remediation-guard.test.ts
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkSkuGuardrails } from "../remediation-guard.server";

const SHOP = "00000000-0000-0000-0000-000000000010";

// Minimal supabase double: guardrail_config.maybeSingle() returns the config
// row; action_audit count head-select returns `todayCount`.
function fakeSb(opts: { config: Record<string, unknown> | null; todayCount: number }) {
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.gte = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: opts.config, error: null }));
    // count head-select resolves via the awaited builder itself.
    chain.then = (resolve: (r: { count: number; error: null }) => unknown) =>
      resolve({ count: table === "action_audit" ? opts.todayCount : 0, error: null });
    return chain;
  }
  return { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
}

const config = {
  autopilot_enabled: true,
  autopilot_daily_action_cap: 5,
  dollar_impact_cap_without_2fa: 100, // dollars → 10000 cents
  business_hours_only: false,
  business_hours_start_utc: 0,
  business_hours_end_utc: 0,
};

describe("checkSkuGuardrails", () => {
  it("allows a SKU move within cap and under the dollar cap", async () => {
    const sb = fakeSb({ config, todayCount: 0 });
    const v = await checkSkuGuardrails(SHOP, { dollarImpactCents: 5000 }, sb);
    expect(v.allowed).toBe(true);
  });

  it("blocks when autopilot is disabled", async () => {
    const sb = fakeSb({ config: { ...config, autopilot_enabled: false }, todayCount: 0 });
    const v = await checkSkuGuardrails(SHOP, { dollarImpactCents: 5000 }, sb);
    expect(v).toEqual({ allowed: false, reason: "auto-pilot disabled" });
  });

  it("blocks when the daily action cap is reached", async () => {
    const sb = fakeSb({ config, todayCount: 5 });
    const v = await checkSkuGuardrails(SHOP, { dollarImpactCents: 5000 }, sb);
    expect(v).toEqual({ allowed: false, reason: "daily action cap reached" });
  });

  it("blocks when the projected impact exceeds the dollar cap", async () => {
    const sb = fakeSb({ config, todayCount: 0 });
    const v = await checkSkuGuardrails(SHOP, { dollarImpactCents: 20000 }, sb); // > 10000c cap
    expect(v).toEqual({ allowed: false, reason: "dollar impact exceeds cap" });
  });

  it("blocks when there is no guardrail config", async () => {
    const sb = fakeSb({ config: null, todayCount: 0 });
    const v = await checkSkuGuardrails(SHOP, { dollarImpactCents: 1 }, sb);
    expect(v).toEqual({ allowed: false, reason: "no guardrail config" });
  });
});
