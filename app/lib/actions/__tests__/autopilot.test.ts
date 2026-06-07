import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAutopilotForShop } from "../autopilot.server";

// vi.mock is hoisted above imports by Vitest, so the mocks below still apply to
// the runAutopilotForShop import above.
const { checkGuardrails, executeAction } = vi.hoisted(() => ({
  checkGuardrails: vi.fn(),
  executeAction: vi.fn(async () => ({ id: "aud1", outcome: "succeeded" })),
}));
vi.mock("../guardrails.server", () => ({ checkGuardrails }));
vi.mock("../execute.server", () => ({ executeAction }));

const SHOP = "00000000-0000-0000-0000-000000000010";

// rows: guardrail_config (enabled), candidate alerts (with campaign + spend).
function fakeSb(opts: { enabled: boolean; alerts: Array<Record<string, unknown>> }) {
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.in = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: { autopilot_enabled: opts.enabled }, error: null }));
    chain.then = (resolve: (r: { data: unknown; error: null }) => unknown) =>
      resolve({ data: table === "v_autopilot_candidates" ? opts.alerts : [], error: null });
    return chain;
  }
  return { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
}

const candidate = {
  alert_id: "al1", detector_id: "campaign_below_breakeven", dollar_impact: 80,
  campaign_id: "camp-uuid", campaign_spend_cents: 50000, daily_budget_cents: 10000,
};

describe("runAutopilotForShop", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips entirely when auto-pilot is disabled", async () => {
    const sb = fakeSb({ enabled: false, alerts: [candidate] });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(r.skipped).toBe(true);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("pauses a money-losing campaign when guardrails allow", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    const sb = fakeSb({ enabled: true, alerts: [candidate] });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(executeAction).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({ kind: "pause_campaign", campaignId: "camp-uuid", actor: "autopilot", alertId: "al1" }),
      sb,
    );
    expect(r.acted).toBe(1);
  });

  it("does not act when guardrails block", async () => {
    checkGuardrails.mockResolvedValue({ allowed: false, reason: "daily action cap reached" });
    const sb = fakeSb({ enabled: true, alerts: [candidate] });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(executeAction).not.toHaveBeenCalled();
    expect(r.blocked).toBe(1);
  });

  it("reduces budget for an ad_tax_overload alert", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    const sb = fakeSb({ enabled: true, alerts: [{ ...candidate, detector_id: "ad_tax_overload" }] });
    await runAutopilotForShop(SHOP, sb);
    // 50% default cut of 10000 -> 5000
    expect(executeAction).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({ kind: "reduce_campaign_budget", dailyBudgetCents: 5000 }),
      sb,
    );
  });
});
