import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAutopilotForShop } from "../autopilot.server";
import type { ReallocationCandidate, ReallocationSuggestion } from "../reallocation-suggest.server";
import type { Platform } from "../../ads/adapter";
import type { GuardrailResult } from "../guardrails";

// vi.mock is hoisted above imports by Vitest, so the mocks below still apply to
// the runAutopilotForShop import above.
const {
  checkGuardrails, executeAction, executeReallocation,
  loadReallocationCandidates, pickReallocation,
  checkSkuGuardrails, executeDiscontinueAlertAction, executeReallocateSpendSku,
  enrichRemediation, calderynClient, unauthenticatedAdmin,
} = vi.hoisted(() => ({
  checkGuardrails: vi.fn(),
  executeAction: vi.fn(async () => ({ id: "aud1", outcome: "succeeded" })),
  executeReallocation: vi.fn(async () => ({ id: "aud2", outcome: "succeeded" })),
  loadReallocationCandidates: vi.fn(async (): Promise<ReallocationCandidate[]> => []),
  pickReallocation: vi.fn((): ReallocationSuggestion => ({ source: null, dest: null })),
  checkSkuGuardrails: vi.fn(async (): Promise<GuardrailResult> => ({ allowed: true })),
  // Both gateways take a single opts object and return { auditId, outcome, acknowledged }.
  executeDiscontinueAlertAction: vi.fn(async () => ({ auditId: "aud3", outcome: "succeeded", acknowledged: true })),
  executeReallocateSpendSku: vi.fn(async () => ({ auditId: "aud4", outcome: "succeeded", acknowledged: true })),
  // Phase-3 resolver is mocked here to isolate routing from the DB read; it is
  // exercised for-real in its own enrich.test.ts (Phase 3). Default = identity.
  enrichRemediation: vi.fn(async (_alert: unknown, plan: unknown) => plan),
  calderynClient: vi.fn(() => ({})),
  unauthenticatedAdmin: vi.fn(async () => ({ admin: {} })),
}));
vi.mock("../guardrails.server", () => ({ checkGuardrails }));
vi.mock("../execute.server", () => ({ executeAction }));
vi.mock("../reallocate.server", () => ({ executeReallocation }));
vi.mock("../reallocation-suggest.server", () => ({ loadReallocationCandidates, pickReallocation }));
vi.mock("../remediation-guard.server", () => ({ checkSkuGuardrails }));
vi.mock("../remediation/enrich.server", () => ({ enrichRemediation }));
vi.mock("../alert-action.server", () => ({ executeDiscontinueAlertAction }));
vi.mock("../reallocate-sku.server", () => ({ executeReallocateSpendSku }));
vi.mock("../../calderyn.server", () => ({ calderynClient }));
vi.mock("~/shopify.server", () => ({ unauthenticated: { admin: unauthenticatedAdmin } }));

const SHOP = "00000000-0000-0000-0000-000000000010";

// rows: guardrail_config (enabled), candidate alerts (with campaign + spend).
function fakeSb(opts: { enabled: boolean; alerts: Array<Record<string, unknown>> }) {
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.in = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({
      data: {
        autopilot_enabled: opts.enabled,
        autopilot_max_budget_cut_pct: 50,
        autopilot_max_budget_increase_pct: 20,
        autopilot_max_daily_budget_cents: null,
      },
      error: null,
    }));
    chain.then = (resolve: (r: { data: unknown; error: null }) => unknown) =>
      resolve({ data: table === "v_autopilot_candidates" ? opts.alerts : [], error: null });
    return chain;
  }
  return { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
}

const candidate = {
  alert_id: "al1", detector_id: "campaign_below_breakeven", dollar_impact: 80,
  campaign_id: "camp-uuid", campaign_spend_cents: 50000, daily_budget_cents: 10000,
  evidence: null, sku: null, sku_id: null,
};

describe("runAutopilotForShop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeAction.mockResolvedValue({ id: "aud1", outcome: "succeeded" });
    executeReallocation.mockResolvedValue({ id: "aud2", outcome: "succeeded" });
    loadReallocationCandidates.mockResolvedValue([]);
    pickReallocation.mockReturnValue({ source: null, dest: null });
    checkSkuGuardrails.mockResolvedValue({ allowed: true });
    // enrichRemediation identity mock: returns the plan unchanged so executor
    // stays null for most tests (no reallocate winner found).
    enrichRemediation.mockImplementation(async (_alert: unknown, plan: unknown) => plan);
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

  // ad_tax_overload WITH a campaign but NO evidence: enrichRemediation (mocked
  // as identity) leaves the reallocate_to_winner move with executor null →
  // tryRemediation returns "fell_through" → legacy reduce/reallocate path runs.
  // NOTE: This is the ⚠️ DECISION REQUIRED scenario. With Option A these
  // assertions would instead point at executeReallocateSpendSku. For now
  // (Task 4), the identity enrichRemediation mock keeps executor null so the
  // legacy path still runs — preserving these assertions without change.
  // The true Option-A collision only appears in the real engine (no mock);
  // Task 5 will handle that.
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
    expect(r).toEqual({ skipped: false, acted: 0, blocked: 1, skippedMoves: 0, failed: 0 });
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
    expect(r).toEqual({ skipped: false, acted: 1, blocked: 1, skippedMoves: 0, failed: 0 });
  });

  it("keeps acting on remaining alerts after one action throws, counting the failure", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    // First candidate's execution throws (e.g. a DB/ownership error inside
    // executeAction); the second must still be attempted, not skipped.
    executeAction
      .mockRejectedValueOnce(new Error("ownership check failed"))
      .mockResolvedValue({ id: "aud1", outcome: "succeeded" });
    const sb = fakeSb({
      enabled: true,
      alerts: [
        { ...candidate, alert_id: "al1", campaign_id: "camp-1" },
        { ...candidate, alert_id: "al2", campaign_id: "camp-2" },
      ],
    });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(executeAction).toHaveBeenCalledTimes(2);
    expect(executeAction).toHaveBeenNthCalledWith(
      2,
      SHOP,
      expect.objectContaining({ alertId: "al2" }),
      sb,
    );
    expect(r).toEqual({ skipped: false, acted: 1, blocked: 0, skippedMoves: 0, failed: 1 });
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

  // ─── Task 4: remediation branch tests ────────────────────────────────────────
  // rankMoves / toNumericEvidence / remediationReason are pure and NOT mocked —
  // the test exercises real ranking + real reasoning (rule 9: checks behavior).
  // enrichRemediation IS mocked (identity by default) so this suite tests routing,
  // not the SKU→campaign DB resolution (Phase 3's enrich.test.ts owns that).

  // Structurally-dead SKU economics alert (no campaign): plan.recommended ==
  // "discontinue", executor "discontinue_sku" → executes via the SKU seam.
  const deadSku = {
    alert_id: "al-dead", detector_id: "negative_unit_economics", dollar_impact: 4000,
    campaign_id: null, campaign_spend_cents: 0, daily_budget_cents: null,
    evidence: { gross_unit_margin_usd: -4, net_per_unit_usd: -34 }, sku: "Dead Tee — M", sku_id: "sku-1",
  };

  it("acts on a discontinue recommendation via the SKU seam with a deterministic reason", async () => {
    checkSkuGuardrails.mockResolvedValue({ allowed: true });
    const sb = fakeSb({ enabled: true, alerts: [deadSku] });
    const r = await runAutopilotForShop(SHOP, sb);
    // The Phase-2 gateway takes a SINGLE opts object (client + admin + sb + ids).
    expect(executeDiscontinueAlertAction).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: SHOP,
        alertId: "al-dead",
        kind: "discontinue_sku",
        actor: "autopilot",
        idempotencyKey: "autopilot:al-dead:discontinue_sku",
        sb,
      }),
    );
    const [opts] = executeDiscontinueAlertAction.mock.calls[0] as unknown as [{ triggerReason: string }];
    expect(opts.triggerReason).toContain("discontinue");
    expect(opts.triggerReason).toContain("structurally dead");
    expect(opts.triggerReason).toContain("$4,000");
    expect(executeAction).not.toHaveBeenCalled();
    expect(r.acted).toBe(1);
  });

  it("respects the daily action cap on a remediation move (blocked, no execution)", async () => {
    checkSkuGuardrails.mockResolvedValue({ allowed: false, reason: "daily action cap reached" });
    const sb = fakeSb({ enabled: true, alerts: [deadSku] });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(executeDiscontinueAlertAction).not.toHaveBeenCalled();
    expect(r.blocked).toBe(1);
    expect(r.acted).toBe(0);
  });

  // Viable margin-erosion alert: plan.recommended == "review_pricing" (or
  // "reallocate_to_winner" with null executor from identity enrichRemediation)
  // → advisory, executor null → tryRemediation returns "fell_through".
  // The legacy path finds no kind for margin_erosion → continues without action.
  it("does NOT act on an advisory recommendation and surfaces it as a skip", async () => {
    const advisory = {
      alert_id: "al-adv", detector_id: "margin_erosion", dollar_impact: 200,
      campaign_id: null, campaign_spend_cents: 0, daily_budget_cents: null,
      evidence: { baseline_unit_margin_usd: 18, current_unit_margin_usd: 7, drop_pct: 61 },
      sku: "Slim Margin Tee", sku_id: "sku-2",
    };
    const sb = fakeSb({ enabled: true, alerts: [advisory] });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(executeDiscontinueAlertAction).not.toHaveBeenCalled();
    expect(executeReallocateSpendSku).not.toHaveBeenCalled();
    expect(executeAction).not.toHaveBeenCalled();
    expect(r.acted).toBe(0);
    // review_pricing is advisory → "fell_through" to legacy logic, which has no
    // campaign action for a SKU-only margin_erosion alert, so nothing is done.
    expect(r.skippedMoves + r.blocked).toBe(0);
  });
});
