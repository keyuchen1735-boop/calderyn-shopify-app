import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAutopilotForShop } from "../autopilot.server";
import { getActionPolicy } from "../action-policy.server";
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
vi.mock("../../remediation/enrich.server", () => ({ enrichRemediation }));
vi.mock("../alert-action.server", () => ({ executeDiscontinueAlertAction }));
vi.mock("../reallocate-sku.server", () => ({ executeReallocateSpendSku }));
vi.mock("../../calderyn.server", () => ({ calderynClient }));
vi.mock("~/shopify.server", () => ({ unauthenticated: { admin: unauthenticatedAdmin } }));
// Default: null → mu falls back to 1 → full-cap behavior (today's exact numbers).
// Per-test override via vi.mocked(getActionPolicy).mockResolvedValueOnce(mu).
vi.mock("../action-policy.server", () => ({ getActionPolicy: vi.fn().mockResolvedValue(null) }));
// resolveScopedCandidates is NOT mocked — we test it exercised through the real
// targeting module (which itself calls the already-mocked pickReallocation).
vi.mock("../autopilot-targeting.server", async (importOriginal) => {
  return await importOriginal();
});

const SHOP = "00000000-0000-0000-0000-000000000010";

// rows: guardrail_config (enabled), candidate alerts (with campaign + spend).
// scopedAlerts: rows to return for the new `alerts` table query (defaults to []).
function fakeSb(opts: {
  enabled: boolean;
  alerts: Array<Record<string, unknown>>;
  scopedAlerts?: Array<Record<string, unknown>>;
}) {
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
    chain.then = (resolve: (r: { data: unknown; error: null }) => unknown) => {
      let data: unknown = [];
      if (table === "v_autopilot_candidates") data = opts.alerts;
      else if (table === "alerts") data = opts.scopedAlerts ?? [];
      return resolve({ data, error: null });
    };
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
    // clearAllMocks resets calls but NOT implementations — restore the default
    // (no learned dial -> full cap) so a per-test mockImplementation can't leak.
    vi.mocked(getActionPolicy).mockReset().mockResolvedValue(null);
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

  it("scales the reallocated amount by the learned reallocate_budget mu (not the reduce dial)", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    pickReallocation.mockReturnValue({ source: null, dest: destCandidate });
    // Learned dial only for reallocate_budget; reduce stays at full cap (null -> 1).
    vi.mocked(getActionPolicy).mockImplementation(async (_sb, _shop, _det, actionKind) =>
      actionKind === "reallocate_budget" ? 0.5 : null,
    );
    const sb = fakeSb({ enabled: true, alerts: [{ ...candidate, detector_id: "ad_tax_overload" }] });
    await runAutopilotForShop(SHOP, sb);
    // 10000 * 50% cap * 0.5 mu = 2500 moved (vs 5000 at full cap); source budget -> 7500.
    expect(executeReallocation).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({ amountCents: 2500, destCampaignId: "dest-uuid" }),
      sb,
    );
    expect(checkGuardrails).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({ kind: "reallocate_budget", dollarImpactCents: 2500, newBudgetCents: 7500 }),
      sb,
    );
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
    // Merged summary carries main's structured fields too (considered /
    // blockedReasons / decisions), so an exhaustive toEqual no longer applies;
    // toMatchObject still pins acted/blocked/failed AND our skippedMoves.
    expect(r).toMatchObject({ skipped: false, acted: 0, blocked: 1, skippedMoves: 0, failed: 0 });
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
    // Merged summary has extra structured fields → toMatchObject, still pinning
    // our skippedMoves alongside main's acted/blocked/failed.
    expect(r).toMatchObject({ skipped: false, acted: 1, blocked: 1, skippedMoves: 0, failed: 0 });
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
    expect(r).toMatchObject({ skipped: false, acted: 1, blocked: 0, skippedMoves: 0, failed: 1 });
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

  // ad_tax_overload WITH campaign + sku_id: rankMoves returns reallocate_to_winner
  // (executor null from rank.ts). enrichRemediation.mockResolvedValueOnce flips
  // the move's executor to "reallocate_spend_sku" → tryRemediation routes to the
  // Phase-3 SKU gateway. The discontinue/legacy seams must NOT be called.
  // NOTE: for ad_tax_overload fixtures WITHOUT evidence (the legacy tests above),
  // enrichRemediation identity-mock keeps executor null → fell_through → legacy
  // reduce/reallocate path. That is correct no-sku_id fallback; see Task 5 Step 3.
  it("acts on a reallocate_to_winner recommendation via the SKU-realloc seam with a deterministic reason", async () => {
    const reallocCandidate = {
      alert_id: "al-realloc", detector_id: "ad_tax_overload", dollar_impact: 5305,
      campaign_id: "camp-loser", campaign_spend_cents: 80000, daily_budget_cents: 20000,
      evidence: { gross_unit_margin_usd: 3, ad_spend_7d_usd: 800 }, sku: "Tax Overload Tee", sku_id: "sku-3",
    };
    // rankMoves(ad_tax_overload, not-structurally-dead) → recommended="reallocate_to_winner",
    // executor=null. Simulate enrichRemediation filling in the winner campaign:
    enrichRemediation.mockResolvedValueOnce({
      moves: [
        { kind: "reallocate_to_winner", dollarImpactCents: 530500, executor: "reallocate_spend_sku",
          label: "Move ad budget to a higher-margin product",
          target: { loserCampaignId: "camp-loser", winnerCampaignId: "camp-winner", amountCents: 530500 } },
        { kind: "cut_ads", dollarImpactCents: 530500, executor: "pause_campaign", label: "Cut the ad spend driving the loss" },
        { kind: "snooze", dollarImpactCents: 0, executor: "snooze_alert", label: "Snooze" },
      ],
      recommended: "reallocate_to_winner",
      structurallyDead: false,
    });
    checkSkuGuardrails.mockResolvedValue({ allowed: true });
    const sb = fakeSb({ enabled: true, alerts: [reallocCandidate] });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(executeReallocateSpendSku).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: SHOP,
        alertId: "al-realloc",
        actor: "autopilot",
        idempotencyKey: "autopilot:al-realloc:reallocate_spend_sku",
      }),
    );
    const [opts] = executeReallocateSpendSku.mock.calls[0] as unknown as [{ triggerReason: string }];
    expect(opts.triggerReason).toContain("reallocate_to_winner");
    expect(opts.triggerReason).toContain("$5,305");  // recommended 530500c
    expect(opts.triggerReason).toContain("cut_ads");  // runner-up in reason
    // Legacy campaign seam and discontinue seam must NOT be called.
    expect(executeAction).not.toHaveBeenCalled();
    expect(executeDiscontinueAlertAction).not.toHaveBeenCalled();
    expect(r.acted).toBe(1);
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

  describe("observability (rule 12: fail visibly)", () => {
    it("shop-level disabled short-circuit reports considered=0 and no decisions", async () => {
      const sb = fakeSb({ enabled: false, alerts: [candidate] });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(r.skipped).toBe(true);
      expect(r.considered).toBe(0);
      expect(r.blockedReasons).toEqual({});
      expect(r.decisions).toEqual([]);
    });

    it("counts every candidate considered and maps the guardrail reason when all are blocked", async () => {
      checkGuardrails.mockResolvedValue({ allowed: false, reason: "campaign spend below minimum" });
      const sb = fakeSb({
        enabled: true,
        alerts: [
          candidate,
          { ...candidate, alert_id: "al2", campaign_id: "camp-uuid-2" },
          { ...candidate, alert_id: "al3", campaign_id: "camp-uuid-3" },
        ],
      });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(r.acted).toBe(0);
      expect(r.blocked).toBe(3);
      expect(r.considered).toBe(3);
      expect(r.blockedReasons).toEqual({ "campaign spend below minimum": 3 });
      // A structured decision exists for every candidate considered.
      expect(r.decisions).toHaveLength(3);
      expect(r.decisions[0]).toMatchObject({
        alertId: "al1",
        campaignId: "camp-uuid",
        detectorId: "campaign_below_breakeven",
        intendedKind: "pause_campaign",
        outcome: "blocked",
        reason: "campaign spend below minimum",
      });
    });

    it("reports acted and the right blocked reasons in a mixed run", async () => {
      // al1 pauses (allowed); al2's guardrail blocks with a distinct reason.
      checkGuardrails
        .mockResolvedValueOnce({ allowed: true })
        .mockResolvedValueOnce({ allowed: false, reason: "daily action cap reached" });
      const sb = fakeSb({
        enabled: true,
        alerts: [candidate, { ...candidate, alert_id: "al2", campaign_id: "camp-uuid-2" }],
      });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(r.acted).toBe(1);
      expect(r.blocked).toBe(1);
      expect(r.considered).toBe(2);
      expect(r.blockedReasons).toEqual({ "daily action cap reached": 1 });
      const acted = r.decisions.find((d) => d.outcome === "acted");
      expect(acted).toMatchObject({ alertId: "al1", outcome: "acted", reason: "pause_campaign" });
    });

    it("records a skipped-for-missing-budget candidate with a stable reason", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      const sb = fakeSb({
        enabled: true,
        alerts: [{ ...candidate, detector_id: "ad_tax_overload", daily_budget_cents: null }],
      });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(r.acted).toBe(0);
      expect(r.blocked).toBe(1);
      expect(r.considered).toBe(1);
      const dec = r.decisions[0];
      expect(dec).toMatchObject({
        alertId: "al1",
        campaignId: "camp-uuid",
        intendedKind: "reduce_campaign_budget",
        outcome: "skipped",
      });
      expect(dec.reason).toBe("current daily budget missing from sync");
      // A pre-flight skip still lands in the `blocked` counter, so its reason
      // must appear in the histogram — sum(blockedReasons) === blocked.
      expect(r.blockedReasons).toEqual({ "current daily budget missing from sync": 1 });
    });

    it("keeps sum(blockedReasons) === blocked across mixed skip + guardrail-block reasons", async () => {
      // al1: reduce with null budget → pre-flight skip. al2: guardrail block.
      checkGuardrails.mockResolvedValue({ allowed: false, reason: "campaign spend below minimum" });
      const sb = fakeSb({
        enabled: true,
        alerts: [
          { ...candidate, detector_id: "ad_tax_overload", daily_budget_cents: null },
          { ...candidate, alert_id: "al2", campaign_id: "camp-uuid-2" },
        ],
      });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(r.blocked).toBe(2);
      expect(r.blockedReasons).toEqual({
        "current daily budget missing from sync": 1,
        "campaign spend below minimum": 1,
      });
      const total = Object.values(r.blockedReasons).reduce((a, b) => a + b, 0);
      expect(total).toBe(r.blocked);
    });
  });

  // A platform error is CAUGHT inside executeAction and returned as
  // outcome:"failed" (e.g. "meta not connected") — the budget never changed,
  // so the run summary must NOT report it as an action taken.
  it("does not count a failed executeAction outcome as acted", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    executeAction.mockResolvedValue({ id: "aud1", outcome: "failed" });
    const sb = fakeSb({ enabled: true, alerts: [candidate] });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(r).toMatchObject({ skipped: false, acted: 0, blocked: 0, failed: 1 });
  });

  // A transient platform failure is parked as outcome:"retrying" for the retry
  // cron — nothing landed this run, so it is not an action taken either.
  it("does not count a retrying executeAction outcome as acted", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    executeAction.mockResolvedValue({ id: "aud1", outcome: "retrying" });
    const sb = fakeSb({ enabled: true, alerts: [candidate] });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(r).toMatchObject({ skipped: false, acted: 0, blocked: 0, failed: 1 });
  });

  // executeAction THROWS on ownership/validation/DB errors. One bad candidate
  // must not abort loss-prevention for the shop's other money-losing campaigns.
  it("isolates an executeAction throw and keeps draining candidates", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    executeAction
      .mockRejectedValueOnce(new Error("campaign not found (ownership check failed)"))
      .mockResolvedValue({ id: "aud2", outcome: "succeeded" });
    const sb = fakeSb({
      enabled: true,
      alerts: [
        { ...candidate, alert_id: "al-bad", campaign_id: "camp-bad" },
        { ...candidate, alert_id: "al-good", campaign_id: "camp-good" },
      ],
    });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(executeAction).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ skipped: false, acted: 1, blocked: 0, failed: 1 });
  });

  // D6: a shop-scoped ad_tax_overload alert has no campaign_id in
  // v_autopilot_candidates (so the view row never exists), but the `alerts`
  // table row IS present. resolveScopedCandidates picks the worst-graded
  // source campaign from the graded pool and synthesises a candidate so the
  // reallocation path in the loop fires normally.
  describe("ad_tax_overload scoped candidate (D6)", () => {
    const scopedSource: ReallocationCandidate = {
      campaignId: "source-uuid", externalId: "g-1", platform: "google" as Platform,
      name: "Bleeder", dailyBudgetCents: 8000, grade: "poor" as const, roas: 0.3,
    };
    const scopedDest: ReallocationCandidate = {
      campaignId: "dest-uuid-d6", externalId: "m-5", platform: "meta" as Platform,
      name: "Winner D6", dailyBudgetCents: 6000, grade: "winning" as const, roas: 5.1,
    };

    it("acts (reallocates) when v_autopilot_candidates is empty but a scoped ad_tax_overload alert exists", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      // First pickReallocation call (inside resolveScopedCandidates): returns
      // the worst source so a synthetic candidate is built. Second call (inside
      // the loop's reallocation branch): returns the winning destination.
      pickReallocation
        .mockReturnValueOnce({ source: scopedSource, dest: null }) // targeting: picks source
        .mockReturnValueOnce({ source: null, dest: scopedDest });   // loop: picks dest
      loadReallocationCandidates.mockResolvedValue([scopedSource, scopedDest]);

      const sb = fakeSb({
        enabled: true,
        alerts: [],               // v_autopilot_candidates is empty
        scopedAlerts: [           // but an open ad_tax_overload alert exists
          { id: "al-scoped", detector_id: "ad_tax_overload", dollar_impact: 120, entity_ref: {} },
        ],
      });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeReallocation).toHaveBeenCalledWith(
        SHOP,
        expect.objectContaining({
          sourceCampaignId: "source-uuid",
          destCampaignId: "dest-uuid-d6",
          actor: "autopilot",
          alertId: "al-scoped",
        }),
        sb,
      );
      expect(r.acted).toBe(1);
    });

    // LIVE-MONEY double-processing regression: the v_autopilot_candidates view is
    // a LEFT JOIN, so a campaign-less ad_tax_overload alert now appears in BOTH
    // the view (evidence, campaign_id null, 0 budget) AND the scoped `alerts`
    // query (resolveScopedCandidates resolves a campaign + budget). Before the
    // merge, that one alert_id produced TWO candidates — the campaign-less view
    // row fell through to a legacy reduce and BLOCKED ("requires a campaign_id"),
    // while the scoped row reallocated/reduced and ACTED: two decisions for one
    // alert and a corrupted audit (and, in the real engine, two budget writes on
    // one alert). The per-alert_id merge backfills the resolved campaign_id +
    // budget into the single view candidate, so the alert is processed ONCE.
    it("processes a campaign-less ad_tax_overload alert present in BOTH sources exactly once (no double action)", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      // resolveScopedCandidates picks the worst-graded source; the loop's
      // reallocation branch then picks the winning dest.
      pickReallocation
        .mockReturnValueOnce({ source: scopedSource, dest: null }) // targeting: source
        .mockReturnValueOnce({ source: null, dest: scopedDest });  // loop: dest
      loadReallocationCandidates.mockResolvedValue([scopedSource, scopedDest]);

      // SAME alert id "al-dup" on BOTH sides. View row: evidence present,
      // campaign_id null, 0 budget (the LEFT-JOIN shape). Scoped row: the open
      // ad_tax_overload alert the resolver turns into a campaign target.
      const sb = fakeSb({
        enabled: true,
        alerts: [
          {
            alert_id: "al-dup",
            detector_id: "ad_tax_overload",
            dollar_impact: 150,
            campaign_id: null,
            campaign_spend_cents: 0,
            daily_budget_cents: null,
            evidence: { gross_unit_margin_usd: 3, ad_spend_7d_usd: 800 },
            sku: "Dup Tee",
            sku_id: "sku-dup",
          },
        ],
        scopedAlerts: [
          { id: "al-dup", detector_id: "ad_tax_overload", dollar_impact: 150, entity_ref: {} },
        ],
      });
      const r = await runAutopilotForShop(SHOP, sb);

      // Exactly ONE decision for the alert — not a block + an act.
      expect(r.decisions.filter((d) => d.alertId === "al-dup")).toHaveLength(1);
      // At most one executor fired for it: a reallocation acted, and the legacy
      // campaign executor (reduce/pause) must NOT have ALSO fired.
      expect(executeReallocation).toHaveBeenCalledTimes(1);
      expect(executeReallocation).toHaveBeenCalledWith(
        SHOP,
        expect.objectContaining({ sourceCampaignId: "source-uuid", alertId: "al-dup" }),
        sb,
      );
      expect(executeAction).not.toHaveBeenCalled();
      // No spurious "requires a campaign_id" block in the audit.
      expect(r.blocked).toBe(0);
      expect(r.blockedReasons).toEqual({});
      expect(r.acted).toBe(1);
    });
  });

  // D5: mu=0.5 halves the effective cut pct within the merchant cap.
  // $100 (10000c) budget at maxCutPct=50 with mu=0.5 → effectivePct=25% → 7500c.
  // With mu=null (default) → effectivePct=50% → 5000c (today's exact behavior).
  describe("D5: learned mu scales cut/increase within guardrail cap", () => {
    it("mu=0.5 halves the cut magnitude; null mu preserves full-cap (5000c)", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      pickReallocation.mockReturnValue({ source: null, dest: null }); // force plain reduce path

      const reduceCand = { ...candidate, detector_id: "ad_tax_overload", daily_budget_cents: 10000 };

      // First: mu=null (default mock) → full 50% cut → 5000c.
      const sbFull = fakeSb({ enabled: true, alerts: [reduceCand] });
      await runAutopilotForShop(SHOP, sbFull);
      expect(executeAction).toHaveBeenCalledWith(
        SHOP,
        expect.objectContaining({ kind: "reduce_campaign_budget", dailyBudgetCents: 5000 }),
        sbFull,
      );

      vi.clearAllMocks();
      checkGuardrails.mockResolvedValue({ allowed: true });
      pickReallocation.mockReturnValue({ source: null, dest: null });
      executeAction.mockResolvedValue({ id: "aud1", outcome: "succeeded" });
      executeReallocation.mockResolvedValue({ id: "aud2", outcome: "succeeded" });
      loadReallocationCandidates.mockResolvedValue([]);

      // Now: mu=0.5 → effectivePct = 50*0.5 = 25% → 10000*(1-0.25) = 7500c.
      vi.mocked(getActionPolicy).mockResolvedValueOnce(0.5);
      const sbHalf = fakeSb({ enabled: true, alerts: [reduceCand] });
      await runAutopilotForShop(SHOP, sbHalf);
      expect(executeAction).toHaveBeenCalledWith(
        SHOP,
        expect.objectContaining({ kind: "reduce_campaign_budget", dailyBudgetCents: 7500 }),
        sbHalf,
      );
    });
  });

  // executeReallocation THROWS when the live source budget dropped below the
  // view snapshot (amount >= source budget). The throw must be isolated, not
  // abort the run, and the pause candidate behind it must still be acted on.
  it("isolates an executeReallocation throw and keeps draining candidates", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    pickReallocation.mockReturnValue({ source: null, dest: destCandidate });
    executeReallocation.mockRejectedValue(new Error("amount must leave the source budget above zero"));
    const sb = fakeSb({
      enabled: true,
      alerts: [
        { ...candidate, alert_id: "al-realloc", detector_id: "ad_tax_overload", campaign_id: "camp-realloc" },
        { ...candidate, alert_id: "al-pause", campaign_id: "camp-pause" },
      ],
    });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(executeAction).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({ kind: "pause_campaign", alertId: "al-pause" }),
      sb,
    );
    expect(r).toMatchObject({ skipped: false, acted: 1, blocked: 0, failed: 1 });
  });
});
