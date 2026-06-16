import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAutopilotForShop } from "../autopilot.server";
import type { ReallocationCandidate, ReallocationSuggestion } from "../reallocation-suggest.server";
import type { Platform } from "../../ads/adapter";

// vi.mock is hoisted above imports by Vitest, so the mocks below still apply to
// the runAutopilotForShop import above.
const { checkGuardrails, executeAction, executeReallocation, loadReallocationCandidates, pickReallocation } =
  vi.hoisted(() => ({
    checkGuardrails: vi.fn(),
    executeAction: vi.fn(async () => ({ id: "aud1", outcome: "succeeded" })),
    executeReallocation: vi.fn(async () => ({ id: "aud2", outcome: "succeeded" })),
    loadReallocationCandidates: vi.fn(async (): Promise<ReallocationCandidate[]> => []),
    pickReallocation: vi.fn((): ReallocationSuggestion => ({ source: null, dest: null })),
  }));
vi.mock("../guardrails.server", () => ({ checkGuardrails }));
vi.mock("../execute.server", () => ({ executeAction }));
vi.mock("../reallocate.server", () => ({ executeReallocation }));
vi.mock("../reallocation-suggest.server", () => ({ loadReallocationCandidates, pickReallocation }));

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
  beforeEach(() => {
    vi.clearAllMocks();
    executeAction.mockResolvedValue({ id: "aud1", outcome: "succeeded" });
    executeReallocation.mockResolvedValue({ id: "aud2", outcome: "succeeded" });
    loadReallocationCandidates.mockResolvedValue([]);
    pickReallocation.mockReturnValue({ source: null, dest: null });
  });

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

  const destCandidate: ReallocationCandidate = {
    campaignId: "dest-uuid", externalId: "m-9", platform: "meta" as Platform,
    name: "Winner", dailyBudgetCents: 4000, grade: "winning" as const, roas: 4.2,
  };

  it("REALLOCATES the cut amount when a winning cross-platform dest exists", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    pickReallocation.mockReturnValue({ source: null, dest: destCandidate });
    const sb = fakeSb({ enabled: true, alerts: [{ ...candidate, detector_id: "ad_tax_overload" }] });
    const r = await runAutopilotForShop(SHOP, sb);
    // 50% default cut of 10000 → amount 5000 redirected, not shrunk.
    expect(executeReallocation).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({
        sourceCampaignId: "camp-uuid",
        destCampaignId: "dest-uuid",
        amountCents: 5000,
        actor: "autopilot",
        alertId: "al1",
        idempotencyKey: "autopilot:al1:reallocate_budget",
      }),
      sb,
    );
    expect(executeAction).not.toHaveBeenCalled();
    expect(r.acted).toBe(1);
  });

  it("passes destCampaignId into the guardrail check for reallocations", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    pickReallocation.mockReturnValue({ source: null, dest: destCandidate });
    const sb = fakeSb({ enabled: true, alerts: [{ ...candidate, detector_id: "ad_tax_overload" }] });
    await runAutopilotForShop(SHOP, sb);
    expect(checkGuardrails).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({
        kind: "reallocate_budget",
        campaignId: "camp-uuid",
        destCampaignId: "dest-uuid",
        dollarImpactCents: 5000,
      }),
      sb,
    );
  });

  it("falls back to reduce_campaign_budget when no destination exists", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    pickReallocation.mockReturnValue({ source: null, dest: null });
    const sb = fakeSb({ enabled: true, alerts: [{ ...candidate, detector_id: "ad_tax_overload" }] });
    await runAutopilotForShop(SHOP, sb);
    expect(executeReallocation).not.toHaveBeenCalled();
    expect(executeAction).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({ kind: "reduce_campaign_budget", dailyBudgetCents: 5000 }),
      sb,
    );
  });

  it("blocks (not throws) a budget cut when the candidate has no current budget", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    const sb = fakeSb({
      enabled: true,
      alerts: [{ ...candidate, detector_id: "ad_tax_overload", daily_budget_cents: null }],
    });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(executeAction).not.toHaveBeenCalled();
    expect(executeReallocation).not.toHaveBeenCalled();
    expect(r).toEqual({ skipped: false, acted: 0, blocked: 1 });
  });

  it("keeps draining the remaining candidates after a null-budget block", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    const sb = fakeSb({
      enabled: true,
      alerts: [
        { ...candidate, detector_id: "ad_tax_overload", daily_budget_cents: null },
        { ...candidate, alert_id: "al2", campaign_id: "camp-uuid-2" },
      ],
    });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(executeAction).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({ kind: "pause_campaign", alertId: "al2" }),
      sb,
    );
    expect(r).toEqual({ skipped: false, acted: 1, blocked: 1 });
  });

  it("counts a guardrail-blocked reallocation as blocked (no fallback to reduce)", async () => {
    checkGuardrails.mockResolvedValue({ allowed: false, reason: "destination campaign in cooldown" });
    pickReallocation.mockReturnValue({ source: null, dest: destCandidate });
    const sb = fakeSb({ enabled: true, alerts: [{ ...candidate, detector_id: "ad_tax_overload" }] });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(executeReallocation).not.toHaveBeenCalled();
    expect(executeAction).not.toHaveBeenCalled();
    expect(r.blocked).toBe(1);
  });

  it("passes a plain-language triggerReason containing the action verb and detector label to executeAction", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    const sb = fakeSb({ enabled: true, alerts: [candidate] }); // campaign_below_breakeven → pause
    await runAutopilotForShop(SHOP, sb);
    expect(executeAction).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({
        triggerReason: expect.stringContaining("Auto-pause"),
      }),
      sb,
    );
    const [, secondArg] = executeAction.mock.calls[0] as unknown as [unknown, { triggerReason?: string }];
    expect(secondArg.triggerReason).toContain("Campaign is losing money");
  });

  it("scales a winning campaign within the increase cap", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    const scale = { ...candidate, detector_id: "campaign_scaling_opportunity", dollar_impact: 300 };
    const sb = fakeSb({ enabled: true, alerts: [scale] });
    await runAutopilotForShop(SHOP, sb);
    // default +20% of 10000 -> 12000
    expect(executeAction).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({ kind: "increase_campaign_budget", dailyBudgetCents: 12000, actor: "autopilot" }),
      sb,
    );
  });

  it("processes defensive actions before scale actions", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    const scale = { ...candidate, alert_id: "al-scale", detector_id: "campaign_scaling_opportunity", dollar_impact: 999 };
    const pause = { ...candidate, alert_id: "al-pause", detector_id: "campaign_below_breakeven", dollar_impact: 10 };
    const sb = fakeSb({ enabled: true, alerts: [scale, pause] });
    await runAutopilotForShop(SHOP, sb);
    const kinds = executeAction.mock.calls.map((c) => ((c as unknown as [unknown, { kind: string }])[1]).kind);
    expect(kinds).toEqual(["pause_campaign", "increase_campaign_budget"]);
  });
});
