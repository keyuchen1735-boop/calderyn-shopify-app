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
  checkGuardrails,
  checkPriceInventoryGuardrails,
  executeAction,
  executeReallocation,
  loadReallocationCandidates,
  pickReallocation,
  checkSkuGuardrails,
  executeDiscontinueAlertAction,
  executeInventoryAlertAction,
  executeReallocateSpendSku,
  executeAdjustPriceAlertAction,
  resolveSkuVariant,
  suggestAdjustPrice,
  readVariantPrice,
  getCurrentUnitCostCents,
  transferPlanFromEvidence,
  enrichRemediation,
  calderynClient,
  unauthenticatedAdmin,
  isGraduated,
  preconditionFresh,
  stockoutPauseAllowed,
  loadAndApplyRules,
  notifyAutonomousAction,
  acquireAutopilotLock,
  releaseAutopilotLock,
} = vi.hoisted(() => ({
  checkGuardrails: vi.fn(),
  checkPriceInventoryGuardrails: vi.fn(async (): Promise<GuardrailResult> => ({ allowed: true })),
  executeAction: vi.fn(async () => ({ id: "aud1", outcome: "succeeded" })),
  executeReallocation: vi.fn(async () => ({ id: "aud2", outcome: "succeeded" })),
  loadReallocationCandidates: vi.fn(async (): Promise<ReallocationCandidate[]> => []),
  pickReallocation: vi.fn((): ReallocationSuggestion => ({ source: null, dest: null })),
  checkSkuGuardrails: vi.fn(async (): Promise<GuardrailResult> => ({ allowed: true })),
  // Both gateways take a single opts object and return { auditId, outcome, acknowledged }.
  executeDiscontinueAlertAction: vi.fn(async () => ({ auditId: "aud3", outcome: "succeeded", acknowledged: true })),
  executeInventoryAlertAction: vi.fn(async () => ({ auditId: "aud6", outcome: "succeeded", acknowledged: true })),
  executeReallocateSpendSku: vi.fn(async () => ({ auditId: "aud4", outcome: "succeeded", acknowledged: true })),
  executeAdjustPriceAlertAction: vi.fn(async () => ({ auditId: "aud5", outcome: "succeeded", acknowledged: true })),
  // SKU→variant resolver for the adjust_price prediction step. Default: a linked variant.
  resolveSkuVariant: vi.fn(async () => ({ skuId: "sku-int-1", variantGid: "gid://shopify/ProductVariant/1" })),
  // Pure price suggestion — mocked so adjust_price tests control the predicted
  // newPriceCents (and thus the priceChangePct fed to the guard). Default: a 7%
  // raise from a 1000c prior price (within a 10% autopilot cap). Return type is
  // the suggestion-or-null union so a per-test null override typechecks.
  suggestAdjustPrice: vi.fn(
    (): { newPriceCents: number; capped: boolean; basis: "margin_erosion" | "cogs_drift" } | null => ({
      newPriceCents: 1070,
      capped: false,
      basis: "margin_erosion",
    }),
  ),
  readVariantPrice: vi.fn(async () => ({ priceCents: 1000, productGid: "gid://shopify/Product/1" })),
  getCurrentUnitCostCents: vi.fn(async (): Promise<number | null> => 600),
  // Default: mirror the REAL pure derivation — a plan only when the evidence
  // carries all four transfer fields, else null. This keeps non-relocation
  // inventory alerts (e.g. sku_stockout_vs_spend with no transfer evidence)
  // falling through, exactly like production.
  transferPlanFromEvidence: vi.fn((evidence: Record<string, unknown> = {}) => {
    const str = (v: unknown): string =>
      typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
    const inventoryItemId = str(evidence.inventory_item_id);
    const fromLocationId = str(evidence.from_location_id);
    const toLocationId = str(evidence.to_location_id);
    const delta = Number(evidence.recommended_delta ?? evidence.delta ?? 0);
    if (!inventoryItemId || !fromLocationId || !toLocationId || !delta) return null;
    return { inventoryItemId, fromLocationId, toLocationId, delta };
  }),
  // Phase-3 resolver is mocked here to isolate routing from the DB read; it is
  // exercised for-real in its own enrich.test.ts (Phase 3). Default = identity.
  enrichRemediation: vi.fn(async (_alert: unknown, plan: unknown) => plan),
  // guardrails.get supplies the merchant confirm cap (max_price_change_pct) the
  // adjust_price branch uses to predict the executor's price. Default 15%.
  calderynClient: vi.fn(() => ({ guardrails: { get: vi.fn(async () => ({ max_price_change_pct: 15 })) } })),
  unauthenticatedAdmin: vi.fn(async () => ({ admin: {} })),
  // Default: true — existing tests that expect executeAction to be reached keep
  // passing. New graduation-gate tests override this per-test. NOTE: this default
  // also lets the merged remediation graduation gate pass, so the remediation
  // routing tests (discontinue / reallocate_spend_sku) reach their executor seams.
  isGraduated: vi.fn(async () => true),
  // Default: ok:true — existing tests that expect executeAction to be reached keep
  // passing. Precondition-gate tests override this per-test.
  preconditionFresh: vi.fn(async (): Promise<{ ok: boolean; reason?: string }> => ({ ok: true })),
  stockoutPauseAllowed: vi.fn(async (): Promise<{ ok: boolean; reason?: string }> => ({ ok: false, reason: "inventory_policy_not_available" })),
  // Default: {} (no veto, no cap) — existing tests that expect executeAction to be
  // reached keep passing. Rule-enforcement tests override this per-test.
  loadAndApplyRules: vi.fn(async () => ({})),
  // Default: resolves immediately — so notify tests can assert calls without
  // needing real Resend credentials. Override per-test if needed.
  notifyAutonomousAction: vi.fn(async () => {}),
  // I6: Default: lock acquired — so all existing tests that reach executeAction
  // continue to pass. Concurrency-lock tests override this per-test.
  acquireAutopilotLock: vi.fn(async (): Promise<{ acquired: boolean; reason?: string; acquiredAt?: string }> => ({ acquired: true, acquiredAt: new Date().toISOString() })),
  releaseAutopilotLock: vi.fn(async () => {}),
}));
vi.mock("../guardrails.server", () => ({ checkGuardrails, checkPriceInventoryGuardrails }));
vi.mock("../execute.server", () => ({ executeAction }));
vi.mock("../reallocate.server", () => ({ executeReallocation }));
vi.mock("../reallocation-suggest.server", () => ({ loadReallocationCandidates, pickReallocation }));
vi.mock("../remediation-guard.server", () => ({ checkSkuGuardrails }));
vi.mock("../../remediation/enrich.server", () => ({ enrichRemediation }));
vi.mock("../alert-action.server", () => ({ executeDiscontinueAlertAction, executeInventoryAlertAction }));
vi.mock("../reallocate-sku.server", () => ({ executeReallocateSpendSku }));
vi.mock("../adjust-price.server", () => ({ executeAdjustPriceAlertAction, resolveSkuVariant }));
vi.mock("../../remediation/price", () => ({ suggestAdjustPrice }));
vi.mock("../../shopify/price.server", () => ({ readVariantPrice }));
vi.mock("../../po/draft.server", () => ({ getCurrentUnitCostCents }));
vi.mock("../../shopify/inventory.server", () => ({ transferPlanFromEvidence }));
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
// Graduation gate mock (Slice 5 Task 2). Default = true (graduated) so existing
// tests that reach executeAction continue to pass. Gate tests override below.
vi.mock("../../calibration/graduation.server", () => ({ isGraduated }));
// Precondition re-check mock (Slice 5 Task 4). Default = ok:true so existing
// tests that reach executeAction continue to pass. Precondition tests override below.
vi.mock("../../calibration/preconditions.server", () => ({ preconditionFresh, stockoutPauseAllowed }));
// Rule enforcement mock (Slice 5 Task 5). Default = {} (no veto, no cap) so
// existing tests that reach executeAction continue to pass. Rule tests override below.
vi.mock("../rule-enforce.server", () => ({ loadAndApplyRules }));
// Notification mock (Slice 5 Task 6). Default = no-op so existing tests are unaffected.
vi.mock("../../calibration/notify-autonomous.server", () => ({ notifyAutonomousAction }));
// I6: Concurrency lock mock (Slice 5 Task 7). Default = acquired:true so all
// existing tests that reach executeAction continue to pass. Lock tests override below.
vi.mock("../autopilot-lock.server", () => ({ acquireAutopilotLock, releaseAutopilotLock }));

const SHOP = "00000000-0000-0000-0000-000000000010";

// rows: guardrail_config (enabled), candidate alerts (with campaign + spend).
// scopedAlerts: rows to return for the new `alerts` table query (defaults to []).
// sessionEmail: optional email to return from shopify_sessions (simulates a shop
//   with an account-owner online session that has an email populated).
function fakeSb(opts: {
  enabled: boolean;
  alerts: Array<Record<string, unknown>>;
  scopedAlerts?: Array<Record<string, unknown>>;
  sessionEmail?: string | null;
}) {
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.in = vi.fn(() => chain);
    chain.not = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => {
      if (table === "shops") {
        return { data: { shop_domain: "test-store.myshopify.com" }, error: null };
      }
      if (table === "alerts") {
        return { data: opts.scopedAlerts?.[0] ?? null, error: null };
      }
      return {
        data: {
          autopilot_enabled: opts.enabled,
          autopilot_max_budget_cut_pct: 50,
          autopilot_max_budget_increase_pct: 20,
          autopilot_max_daily_budget_cents: null,
        },
        error: null,
      };
    });
    chain.then = (resolve: (r: { data: unknown; error: null }) => unknown) => {
      let data: unknown = [];
      if (table === "v_autopilot_candidates") data = opts.alerts;
      else if (table === "alerts") data = opts.scopedAlerts ?? [];
      else if (table === "shopify_sessions") {
        // Simulate online account-owner session rows (or empty if no sessionEmail).
        data =
          opts.sessionEmail != null
            ? [{ email: opts.sessionEmail, isOnline: true, accountOwner: true }]
            : [];
      }
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
    // Default: graduated=true so existing tests that reach executeAction keep passing.
    isGraduated.mockReset().mockResolvedValue(true);
    // Default: precondition ok:true so existing tests that reach executeAction keep passing.
    preconditionFresh.mockReset().mockResolvedValue({ ok: true });
    stockoutPauseAllowed.mockReset().mockResolvedValue({ ok: false, reason: "inventory_policy_not_available" });
    // Default: {} (no veto, no cap) so existing tests that reach executeAction keep passing.
    loadAndApplyRules.mockReset().mockResolvedValue({});
    // Default: no-op so existing tests are unaffected by the notification path.
    notifyAutonomousAction.mockReset().mockResolvedValue(undefined);
    // Default: lock acquired (acquired:true) so existing tests that reach
    // executeAction continue to pass. I6 tests override below.
    acquireAutopilotLock.mockReset().mockResolvedValue({ acquired: true, acquiredAt: new Date().toISOString() });
    releaseAutopilotLock.mockReset().mockResolvedValue(undefined);
    // Task 18c: price/inventory autonomous-execution mocks. Defaults chosen so a
    // graduated, within-cap move ACTS; price/inventory gate tests override below.
    checkPriceInventoryGuardrails.mockReset().mockResolvedValue({ allowed: true });
    executeInventoryAlertAction.mockReset().mockResolvedValue({ auditId: "aud6", outcome: "succeeded", acknowledged: true });
    executeAdjustPriceAlertAction.mockReset().mockResolvedValue({ auditId: "aud5", outcome: "succeeded", acknowledged: true });
    resolveSkuVariant.mockReset().mockResolvedValue({ skuId: "sku-int-1", variantGid: "gid://shopify/ProductVariant/1" });
    suggestAdjustPrice.mockReset().mockReturnValue({ newPriceCents: 1070, capped: false, basis: "margin_erosion" });
    readVariantPrice.mockReset().mockResolvedValue({ priceCents: 1000, productGid: "gid://shopify/Product/1" });
    getCurrentUnitCostCents.mockReset().mockResolvedValue(600);
    // Reset to the real pure derivation (plan only when evidence has all four
    // transfer fields), so the default never spuriously diverts a non-relocation
    // inventory alert from its legacy path.
    transferPlanFromEvidence.mockReset().mockImplementation((evidence: Record<string, unknown> = {}) => {
      const str = (v: unknown): string =>
        typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
      const inventoryItemId = str(evidence.inventory_item_id);
      const fromLocationId = str(evidence.from_location_id);
      const toLocationId = str(evidence.to_location_id);
      const delta = Number(evidence.recommended_delta ?? evidence.delta ?? 0);
      if (!inventoryItemId || !fromLocationId || !toLocationId || !delta) return null;
      return { inventoryItemId, fromLocationId, toLocationId, delta };
    });
    calderynClient.mockReset().mockReturnValue({ guardrails: { get: vi.fn(async () => ({ max_price_change_pct: 15 })) } });
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

  it("pauses a dedicated sold-out-product campaign after the stockout allowlist passes", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    stockoutPauseAllowed.mockResolvedValue({ ok: true });
    const stockout = {
      ...candidate,
      detector_id: "sku_stockout_vs_spend",
      sku_id: "sku-1",
      sku: "WID-1",
    };
    const sb = fakeSb({
      enabled: true,
      alerts: [stockout],
      scopedAlerts: [{
        id: "al1",
        detector_id: "sku_stockout_vs_spend",
        entity_ref: { sku_id: "sku-1" },
      }],
    });

    await runAutopilotForShop(SHOP, sb);

    expect(stockoutPauseAllowed).toHaveBeenCalledWith(expect.objectContaining({
      shopId: SHOP,
      campaignId: "camp-uuid",
    }));
    expect(executeAction).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({ kind: "pause_campaign", campaignId: "camp-uuid" }),
      sb,
    );
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
      { forceBypassOff: true, autonomous: true },
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
      { forceBypassOff: true, autonomous: true },
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

  // MERGE (calibration × remediation): an executable remediation move is gated on
  // calibration graduation, exactly like the legacy autonomous path. When the
  // (detector, executor) pair is NOT graduated, tryRemediation must skip BEFORE
  // touching the executor or any guardrail, bucket the skip as `skippedMoves`
  // (not a guardrail `blocked`), and the candidate must be fully resolved — it
  // does NOT fall through to a legacy action (no double-evaluation). This is the
  // This fixture has no graduated remediation pair, so that path stays dormant.
  it("skips a remediation move when the (detector, executor) pair is NOT graduated", async () => {
    // discontinue_sku for negative_unit_economics is not graduated (v1 default).
    isGraduated.mockResolvedValue(false);
    checkSkuGuardrails.mockResolvedValue({ allowed: true }); // would allow if reached
    const sb = fakeSb({ enabled: true, alerts: [deadSku] });
    const r = await runAutopilotForShop(SHOP, sb);
    // The remediation executor must NOT fire, and its SKU guard must not even be
    // consulted — the graduation gate precedes it.
    expect(executeDiscontinueAlertAction).not.toHaveBeenCalled();
    expect(checkSkuGuardrails).not.toHaveBeenCalled();
    // No fall-through to a legacy campaign action either.
    expect(executeAction).not.toHaveBeenCalled();
    // Gate keys on the move's EXECUTOR kind (discontinue_sku), not the detector's
    // legacy kind — same isGraduated check the legacy autonomous path applies.
    expect(isGraduated).toHaveBeenCalledWith(
      SHOP,
      "negative_unit_economics",
      "discontinue_sku",
      sb,
    );
    // Bucketed as a skipped move, NOT a guardrail block: skippedMoves bumps,
    // blocked stays 0, and the reason is surfaced (rule 12).
    expect(r.acted).toBe(0);
    expect(r.skippedMoves).toBe(1);
    expect(r.blocked).toBe(0);
    const dec = r.decisions.find((d) => d.alertId === "al-dead");
    expect(dec).toMatchObject({ outcome: "skipped", reason: "remediation pair not graduated" });
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

  // ─── Slice 5 Task 2: Graduation gate tests ────────────────────────────────

  describe("graduation gate (Slice 5 Task 2)", () => {
    it("skips a non-graduated candidate with reason 'pair not graduated' and does NOT call executeAction", async () => {
      // Override: this specific pair is NOT graduated.
      isGraduated.mockResolvedValue(false);
      checkGuardrails.mockResolvedValue({ allowed: true }); // would allow if reached
      const sb = fakeSb({ enabled: true, alerts: [candidate] });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeAction).not.toHaveBeenCalled();
      expect(checkGuardrails).not.toHaveBeenCalled();
      expect(r.acted).toBe(0);
      // A pre-flight skip lands in the blocked counter (same bucket as other skips).
      expect(r.blocked).toBe(1);
      expect(r.blockedReasons).toEqual({ "pair not graduated": 1 });
      const dec = r.decisions[0];
      expect(dec).toMatchObject({
        alertId: "al1",
        campaignId: "camp-uuid",
        detectorId: "campaign_below_breakeven",
        intendedKind: "pause_campaign",
        outcome: "skipped",
        reason: "pair not graduated",
      });
    });

    it("a graduated candidate proceeds past the gate to the guardrail check", async () => {
      // Default mock (true) — pair is graduated.
      checkGuardrails.mockResolvedValue({ allowed: true });
      const sb = fakeSb({ enabled: true, alerts: [candidate] });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(checkGuardrails).toHaveBeenCalled();
      expect(executeAction).toHaveBeenCalledWith(
        SHOP,
        expect.objectContaining({ kind: "pause_campaign", alertId: "al1" }),
        sb,
      );
      expect(r.acted).toBe(1);
    });

    it("executes nothing when no candidate pair is graduated", async () => {
      // The default failure mode: isGraduated → false for all pairs.
      isGraduated.mockResolvedValue(false);
      checkGuardrails.mockResolvedValue({ allowed: true });
      const sb = fakeSb({
        enabled: true,
        alerts: [
          candidate,
          { ...candidate, alert_id: "al2", campaign_id: "camp-uuid-2" },
          { ...candidate, alert_id: "al3", campaign_id: "camp-uuid-3", detector_id: "ad_tax_overload" },
        ],
      });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeAction).not.toHaveBeenCalled();
      expect(executeReallocation).not.toHaveBeenCalled();
      expect(r.acted).toBe(0);
      // All 3 candidates skipped, none reached guardrails.
      expect(r.considered).toBe(3);
      expect(r.blocked).toBe(3);
      expect(checkGuardrails).not.toHaveBeenCalled();
    });

    it("isGraduated is called with correct shopId, detector_id, kind, and sb", async () => {
      isGraduated.mockResolvedValue(false); // stop after gate
      const sb = fakeSb({ enabled: true, alerts: [candidate] });
      await runAutopilotForShop(SHOP, sb);
      expect(isGraduated).toHaveBeenCalledWith(
        SHOP,
        "campaign_below_breakeven",
        "pause_campaign",
        sb,
      );
    });

    it("graduated reduce + dest available + reallocate_budget NOT graduated → plain reduce fires, reallocation skipped", async () => {
      // reduce_campaign_budget is graduated; reallocate_budget is not (v1 invariant).
      // isGraduated is called twice: once for reduce (top-of-loop, must return true),
      // once for reallocate_budget (sub-branch gate, must return false).
      isGraduated
        .mockResolvedValueOnce(true)  // top-of-loop: reduce_campaign_budget → graduated
        .mockResolvedValueOnce(false); // sub-branch gate: reallocate_budget → NOT graduated
      checkGuardrails.mockResolvedValue({ allowed: true });
      pickReallocation.mockReturnValue({ source: null, dest: destCandidate });
      const sb = fakeSb({ enabled: true, alerts: [{ ...candidate, detector_id: "ad_tax_overload" }] });
      const r = await runAutopilotForShop(SHOP, sb);
      // executeReallocation must NOT have been called — reallocate_budget is not graduated.
      expect(executeReallocation).not.toHaveBeenCalled();
      // The plain reduce must still fire so loss-prevention acts.
      expect(executeAction).toHaveBeenCalledWith(
        SHOP,
        expect.objectContaining({ kind: "reduce_campaign_budget", dailyBudgetCents: 5000 }),
        sb,
      );
      expect(r.acted).toBe(1);
    });

    it("(optional) graduated reduce + dest + reallocate_budget graduated → reallocation proceeds", async () => {
      // When reallocate_budget IS graduated (hypothetical, not possible in v1), the
      // reallocation path executes normally.
      isGraduated.mockResolvedValue(true); // all kinds graduated
      checkGuardrails.mockResolvedValue({ allowed: true });
      pickReallocation.mockReturnValue({ source: null, dest: destCandidate });
      const sb = fakeSb({ enabled: true, alerts: [{ ...candidate, detector_id: "ad_tax_overload" }] });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeReallocation).toHaveBeenCalledWith(
        SHOP,
        expect.objectContaining({ sourceCampaignId: "camp-uuid", destCampaignId: "dest-uuid" }),
        sb,
      );
      expect(executeAction).not.toHaveBeenCalled();
      expect(r.acted).toBe(1);
    });

    it("mixed: graduated candidate acts, non-graduated is skipped; guardrails only called for graduated", async () => {
      // First call: graduated (al1); second call: not graduated (al2).
      isGraduated
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      checkGuardrails.mockResolvedValue({ allowed: true });
      const sb = fakeSb({
        enabled: true,
        alerts: [
          candidate,
          { ...candidate, alert_id: "al2", campaign_id: "camp-uuid-2" },
        ],
      });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeAction).toHaveBeenCalledTimes(1);
      expect(executeAction).toHaveBeenCalledWith(
        SHOP,
        expect.objectContaining({ alertId: "al1" }),
        sb,
      );
      expect(r.acted).toBe(1);
      expect(r.blocked).toBe(1);
      expect(r.blockedReasons).toEqual({ "pair not graduated": 1 });
    });
  });

  // ─── Slice 5 Task 5: Rule enforcement tests ──────────────────────────────

  describe("rule enforcement (Slice 5 Task 5)", () => {
    it("skips (vetoes) a pause candidate with an active muted_pair rule", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      loadAndApplyRules.mockResolvedValue({ veto: "merchant handles this" });
      const sb = fakeSb({ enabled: true, alerts: [candidate] });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeAction).not.toHaveBeenCalled();
      expect(r.acted).toBe(0);
      expect(r.blocked).toBe(1);
      const dec = r.decisions[0];
      expect(dec.outcome).toBe("skipped");
      expect(dec.reason).toContain("merchant handles this");
    });

    it("skips a reduce candidate with a pair_blackout_hours veto", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      loadAndApplyRules.mockResolvedValue({ veto: "outside merchant-allowed hours" });
      const reduceCand = { ...candidate, detector_id: "ad_tax_overload" };
      const sb = fakeSb({ enabled: true, alerts: [reduceCand] });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeAction).not.toHaveBeenCalled();
      expect(executeReallocation).not.toHaveBeenCalled();
      expect(r.acted).toBe(0);
      expect(r.blocked).toBe(1);
      const dec = r.decisions[0];
      expect(dec.outcome).toBe("skipped");
      expect(dec.reason).toBe("rule: outside merchant-allowed hours");
    });

    it("skips a pause candidate that exceeds the pair_dollar_cap (cannot downsize a pause)", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      loadAndApplyRules.mockResolvedValue({ veto: "exceeds merchant dollar cap" });
      const sb = fakeSb({ enabled: true, alerts: [candidate] });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeAction).not.toHaveBeenCalled();
      expect(r.acted).toBe(0);
      expect(r.blocked).toBe(1);
      const dec = r.decisions[0];
      expect(dec.outcome).toBe("skipped");
      expect(dec.reason).toContain("exceeds merchant dollar cap");
    });

    it("skips a candidate when rules unavailable (load failure = veto)", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      loadAndApplyRules.mockResolvedValue({ veto: "rules unavailable" });
      const sb = fakeSb({ enabled: true, alerts: [candidate] });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeAction).not.toHaveBeenCalled();
      expect(r.acted).toBe(0);
      expect(r.blocked).toBe(1);
      const dec = r.decisions[0];
      expect(dec.outcome).toBe("skipped");
      expect(dec.reason).toContain("rules unavailable");
    });

    it("downsizes a reduce budget cut when pair_dollar_cap returns cappedDollarCents", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      pickReallocation.mockReturnValue({ source: null, dest: null });
      // Cap: max cut = 2000c. Default newBudgetCents = 10000 - 5000 = 5000 (50% cut = 5000c cut).
      // Clamp: newBudgetCents = max(5000, 10000 - 2000) = max(5000, 8000) = 8000.
      loadAndApplyRules.mockResolvedValue({ cappedDollarCents: 2000 });
      const reduceCand = { ...candidate, detector_id: "ad_tax_overload", daily_budget_cents: 10000 };
      const sb = fakeSb({ enabled: true, alerts: [reduceCand] });
      const r = await runAutopilotForShop(SHOP, sb);
      // The cut must be clamped: budget goes to 8000c (only 2000c cut), not 5000c.
      expect(executeAction).toHaveBeenCalledWith(
        SHOP,
        expect.objectContaining({ kind: "reduce_campaign_budget", dailyBudgetCents: 8000 }),
        sb,
      );
      expect(r.acted).toBe(1);
    });

    it("skips a min_spend veto and continues to the next candidate", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      // First candidate: min_spend veto; second: no veto (executes).
      loadAndApplyRules
        .mockResolvedValueOnce({ veto: "below merchant min spend" })
        .mockResolvedValueOnce({});
      const sb = fakeSb({
        enabled: true,
        alerts: [
          candidate,
          { ...candidate, alert_id: "al2", campaign_id: "camp-uuid-2" },
        ],
      });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(r.acted).toBe(1);
      expect(r.blocked).toBe(1);
      expect(executeAction).toHaveBeenCalledTimes(1);
      expect(executeAction).toHaveBeenCalledWith(
        SHOP,
        expect.objectContaining({ alertId: "al2" }),
        sb,
      );
    });

    it("a candidate with no active rules passes through and executes normally", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      loadAndApplyRules.mockResolvedValue({}); // default: no rules
      const sb = fakeSb({ enabled: true, alerts: [candidate] });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeAction).toHaveBeenCalledWith(
        SHOP,
        expect.objectContaining({ kind: "pause_campaign", alertId: "al1" }),
        sb,
      );
      expect(r.acted).toBe(1);
    });
  });

  // ─── Slice 5 Task 6: Notify fix tests ────────────────────────────────────

  describe("notify fix (Task 6): email from shopify_sessions + awaited notifies", () => {
    it("resolves merchant email from shopify_sessions (not shops.email) and passes it to notifyAutonomousAction", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      // sessionEmail simulates an online session row in shopify_sessions with a populated email.
      const sb = fakeSb({ enabled: true, alerts: [candidate], sessionEmail: "merchant@example.com" });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(r.acted).toBe(1);
      expect(notifyAutonomousAction).toHaveBeenCalledWith(
        expect.objectContaining({ shopId: SHOP }),
        "merchant@example.com",
      );
    });

    it("passes null email to notifyAutonomousAction when no session has an email (graceful no-op)", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      // No sessionEmail → shopify_sessions returns [] → merchantEmail stays null.
      const sb = fakeSb({ enabled: true, alerts: [candidate], sessionEmail: null });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(r.acted).toBe(1);
      expect(notifyAutonomousAction).toHaveBeenCalledWith(
        expect.objectContaining({ shopId: SHOP }),
        null,
      );
    });

    it("awaits notifies before returning — a notify failure does NOT fail the run", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      // Make notifyAutonomousAction reject; the run must still return acted=1.
      notifyAutonomousAction.mockRejectedValue(new Error("Resend 503"));
      const sb = fakeSb({ enabled: true, alerts: [candidate], sessionEmail: "m@ex.com" });
      // Should not throw; Promise.allSettled absorbs the rejection.
      const r = await runAutopilotForShop(SHOP, sb);
      expect(r.acted).toBe(1);
      expect(r.failed).toBe(0);
      // notifyAutonomousAction was still called (action landed).
      expect(notifyAutonomousAction).toHaveBeenCalledTimes(1);
    });

    it("notifies on increase_campaign_budget success, using session email", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      const scale = { ...candidate, detector_id: "campaign_scaling_opportunity", dollar_impact: 300 };
      const sb = fakeSb({ enabled: true, alerts: [scale], sessionEmail: "scale@ex.com" });
      await runAutopilotForShop(SHOP, sb);
      expect(notifyAutonomousAction).toHaveBeenCalledWith(
        expect.objectContaining({ actionDescription: expect.stringContaining("Scaled up campaign budget") }),
        "scale@ex.com",
      );
    });

    it("does NOT call notifyAutonomousAction when executeAction fails", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      executeAction.mockResolvedValue({ id: "aud1", outcome: "failed" });
      const sb = fakeSb({ enabled: true, alerts: [candidate], sessionEmail: "m@ex.com" });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(r.acted).toBe(0);
      expect(notifyAutonomousAction).not.toHaveBeenCalled();
    });
  });

  // ─── Slice 5 Task 7: Concurrency lock (I6) tests ────────────────────────

  describe("concurrency lock (Slice 5 Task 7, I6)", () => {
    it("skips the tick (returns skipped:true) when lock is NOT acquired (concurrent tick)", async () => {
      // Simulate: another tick holds the lock.
      acquireAutopilotLock.mockResolvedValue({ acquired: false, reason: "locked_by_concurrent_tick (age=5s)" });
      checkGuardrails.mockResolvedValue({ allowed: true });
      const sb = fakeSb({ enabled: true, alerts: [candidate] });
      const r = await runAutopilotForShop(SHOP, sb);
      // The run must short-circuit before touching any candidates.
      expect(executeAction).not.toHaveBeenCalled();
      expect(checkGuardrails).not.toHaveBeenCalled();
      expect(r.skipped).toBe(true);
      expect(r.acted).toBe(0);
    });

    it("executes nothing when lock acquisition fails due to a DB error (fail-safe)", async () => {
      acquireAutopilotLock.mockResolvedValue({ acquired: false, reason: "db_error: connection refused" });
      const sb = fakeSb({ enabled: true, alerts: [candidate] });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeAction).not.toHaveBeenCalled();
      expect(r.skipped).toBe(true);
    });

    it("releases the lock after a successful run", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      const sb = fakeSb({ enabled: true, alerts: [candidate] });
      await runAutopilotForShop(SHOP, sb);
      expect(releaseAutopilotLock).toHaveBeenCalledWith(SHOP, expect.any(String), sb);
    });

    it("releases the lock even when the run throws (finally-block guarantee)", async () => {
      // Simulate a thrown error after lock acquisition (e.g., v_autopilot_candidates read fails).
      // To trigger this we'll have acquireAutopilotLock succeed but then have
      // the first from() call after lock acquisition throw. We can't easily
      // intercept that here since fakeSb doesn't throw; instead we verify the
      // finally-block release by checking releaseAutopilotLock is still called
      // when executeAction throws (which is caught per-candidate, not per-run).
      // For a true outer-throw test: override the sb.from to throw on the shops table.
      const throwingSb = {
        from: vi.fn((table: string) => {
          if (table === "guardrail_config") {
            // Simulate the guardrail_config read returning enabled=true first,
            // then everything else throws.
            const chain: Record<string, unknown> = {};
            chain.select = vi.fn(() => chain);
            chain.eq = vi.fn(() => chain);
            chain.maybeSingle = vi.fn(async () => ({
              data: { autopilot_enabled: true, autopilot_max_budget_cut_pct: 50, autopilot_max_budget_increase_pct: 20, autopilot_max_daily_budget_cents: null },
              error: null,
            }));
            return chain;
          }
          // All other table reads throw — simulates an unexpected DB error.
          throw new Error("DB connection lost mid-run");
        }),
      } as unknown as SupabaseClient;

      // acquireAutopilotLock itself is mocked (acquired:true) so the lock is held.
      // The outer try block will throw, and finally must release.
      await expect(runAutopilotForShop(SHOP, throwingSb)).rejects.toThrow("DB connection lost mid-run");
      expect(releaseAutopilotLock).toHaveBeenCalledWith(SHOP, expect.any(String), throwingSb);
    });

    it("does NOT call releaseAutopilotLock when the lock was never acquired (early return)", async () => {
      acquireAutopilotLock.mockResolvedValue({ acquired: false, reason: "locked_by_concurrent_tick (age=5s)" });
      const sb = fakeSb({ enabled: true, alerts: [candidate] });
      await runAutopilotForShop(SHOP, sb);
      // The function returns before the try block, so releaseAutopilotLock is never called.
      expect(releaseAutopilotLock).not.toHaveBeenCalled();
    });

    it("normal run calls acquireAutopilotLock with shopId and sb", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      const sb = fakeSb({ enabled: true, alerts: [candidate] });
      await runAutopilotForShop(SHOP, sb);
      expect(acquireAutopilotLock).toHaveBeenCalledWith(SHOP, sb);
    });
  });

  // ─── Slice 5 Task 4: Precondition re-check gate tests (I4) ───────────────

  describe("precondition re-check gate (Slice 5 Task 4)", () => {
    it("skips a pause candidate when preconditionFresh returns ok:false (campaign already paused)", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      preconditionFresh.mockResolvedValue({ ok: false, reason: "precondition_stale: not active (status=PAUSED)" });
      const sb = fakeSb({ enabled: true, alerts: [candidate] });
      const r = await runAutopilotForShop(SHOP, sb);
      // The precondition failed → must NOT execute
      expect(executeAction).not.toHaveBeenCalled();
      expect(r.acted).toBe(0);
      // Skipped (precondition) counts as blocked in the counter (same as graduation skip)
      expect(r.blocked).toBe(1);
      expect(r.blockedReasons).toMatchObject({ "precondition_stale: not active (status=PAUSED)": 1 });
      const dec = r.decisions[0];
      expect(dec).toMatchObject({
        alertId: "al1",
        intendedKind: "pause_campaign",
        outcome: "skipped",
        reason: "precondition_stale: not active (status=PAUSED)",
      });
    });

    it("skips a reduce candidate when preconditionFresh returns ok:false (budget already cut)", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      preconditionFresh.mockResolvedValue({
        ok: false,
        reason: "precondition_stale: budget already at/below target (live=4000c < snapshot=10000c)",
      });
      const reduceCand = { ...candidate, detector_id: "ad_tax_overload" };
      const sb = fakeSb({ enabled: true, alerts: [reduceCand] });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeAction).not.toHaveBeenCalled();
      expect(executeReallocation).not.toHaveBeenCalled();
      expect(r.acted).toBe(0);
      expect(r.blocked).toBe(1);
    });

    it("graduated+guardrails-passing candidate with preconditionFresh ok:false records 'skipped' and does NOT execute", async () => {
      // Both graduation and guardrails pass — only precondition blocks it.
      isGraduated.mockResolvedValue(true);
      checkGuardrails.mockResolvedValue({ allowed: true });
      preconditionFresh.mockResolvedValue({ ok: false, reason: "stale_facts: campaign last synced 30h ago" });
      const sb = fakeSb({ enabled: true, alerts: [candidate] });
      const r = await runAutopilotForShop(SHOP, sb);
      // Graduated, guardrails clear, but precondition failed → no execute
      expect(executeAction).not.toHaveBeenCalled();
      expect(r.acted).toBe(0);
      expect(r.blocked).toBe(1);
      const dec = r.decisions[0];
      expect(dec.outcome).toBe("skipped");
      expect(dec.reason).toContain("stale_facts");
    });

    it("preconditionFresh is NOT called for increase_campaign_budget (only pause/reduce require re-check)", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      const scaleCand = { ...candidate, detector_id: "campaign_scaling_opportunity", dollar_impact: 300 };
      const sb = fakeSb({ enabled: true, alerts: [scaleCand] });
      await runAutopilotForShop(SHOP, sb);
      // increase_campaign_budget does not go through preconditionFresh
      expect(preconditionFresh).not.toHaveBeenCalled();
      // But the action DID execute (guardrails passed)
      expect(executeAction).toHaveBeenCalledWith(
        SHOP,
        expect.objectContaining({ kind: "increase_campaign_budget" }),
        sb,
      );
    });

    it("preconditionFresh throwing is treated as ok:false (fail-safe)", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      // preconditionFresh itself is mocked — simulate it returning ok:false (the
      // real function wraps throws internally and returns ok:false; the autopilot
      // also wraps in a try/catch). Either way, no execute.
      preconditionFresh.mockResolvedValue({ ok: false, reason: "threw: unexpected db failure" });
      const sb = fakeSb({ enabled: true, alerts: [candidate] });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeAction).not.toHaveBeenCalled();
      expect(r.acted).toBe(0);
    });

    it("when preconditionFresh passes, the action still executes normally", async () => {
      checkGuardrails.mockResolvedValue({ allowed: true });
      // Default from beforeEach: preconditionFresh returns ok:true
      const sb = fakeSb({ enabled: true, alerts: [candidate] });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(preconditionFresh).toHaveBeenCalled();
      expect(executeAction).toHaveBeenCalledWith(
        SHOP,
        expect.objectContaining({ kind: "pause_campaign", alertId: "al1" }),
        sb,
      );
      expect(r.acted).toBe(1);
    });
  });

  // ─── Task 18c: autonomous adjust_price execution ─────────────────────────
  // margin_erosion / cogs_drift reach tryRemediation (PRODUCT_ECON). enrichRemediation
  // flips review_pricing → executor "adjust_price"; the autopilot PREDICTS the
  // executor's price (suggestAdjustPrice with the merchant cap) and BLOCKS an
  // over-cap move (routes to the merchant queue) rather than clamping it.

  describe("autonomous adjust_price (Task 18c)", () => {
    const priceAlert = {
      alert_id: "al-price",
      detector_id: "margin_erosion",
      dollar_impact: 200, // dollars
      campaign_id: null,
      campaign_spend_cents: 0,
      daily_budget_cents: null,
      evidence: { baseline_unit_margin_usd: 18, current_unit_margin_usd: 7 },
      sku: "Slim Margin Tee",
      sku_id: "sku-2",
    };

    // enrichRemediation flips review_pricing to an executable adjust_price move.
    function withAdjustPriceMove() {
      enrichRemediation.mockResolvedValueOnce({
        moves: [
          {
            kind: "review_pricing",
            dollarImpactCents: 20000,
            executor: "adjust_price",
            label: "Raise price to restore margin",
            target: { skuId: "sku-2" },
          },
          { kind: "snooze", dollarImpactCents: 0, executor: "snooze_alert", label: "Snooze" },
        ],
        recommended: "review_pricing",
        structurallyDead: false,
      });
    }

    it("graduated + within cap → acts via executeAdjustPriceAlertAction (actor autopilot, once)", async () => {
      withAdjustPriceMove();
      // Predicted 1000c → 1070c = +7% (< 15% merchant cap, < 10% autopilot cap).
      suggestAdjustPrice.mockReturnValue({ newPriceCents: 1070, capped: false, basis: "margin_erosion" });
      checkPriceInventoryGuardrails.mockResolvedValue({ allowed: true });
      const sb = fakeSb({ enabled: true, alerts: [priceAlert] });
      const r = await runAutopilotForShop(SHOP, sb);

      expect(executeAdjustPriceAlertAction).toHaveBeenCalledTimes(1);
      expect(executeAdjustPriceAlertAction).toHaveBeenCalledWith(
        expect.objectContaining({
          shopId: SHOP,
          alertId: "al-price",
          kind: "adjust_price",
          actor: "autopilot",
          idempotencyKey: "autopilot:al-price:adjust_price",
        }),
      );
      // The guard saw the PREDICTED +7% change and the per-action dollar impact (cents).
      expect(checkPriceInventoryGuardrails).toHaveBeenCalledWith(
        SHOP,
        expect.objectContaining({ kind: "adjust_price", priceChangePct: expect.closeTo(7, 5) }),
        sb,
      );
      expect(r.acted).toBe(1);
    });

    it("predicts the price using the merchant confirm cap (not the autopilot cap)", async () => {
      withAdjustPriceMove();
      checkPriceInventoryGuardrails.mockResolvedValue({ allowed: true });
      const sb = fakeSb({ enabled: true, alerts: [priceAlert] });
      await runAutopilotForShop(SHOP, sb);
      // suggestAdjustPrice must be called with capPct = the merchant cap (15),
      // so the prediction equals the price the executor will recompute + apply.
      expect(suggestAdjustPrice).toHaveBeenCalledWith(
        expect.objectContaining({
          detectorId: "margin_erosion",
          currentPriceCents: 1000,
          currentCogsCents: 600,
          capPct: 15,
        }),
      );
    });

    it("graduated + OVER cap → blocked 'price change exceeds max', executor NOT called, alert stays open", async () => {
      withAdjustPriceMove();
      // Predicted 1000c → 1200c = +20% (> 10% autopilot cap).
      suggestAdjustPrice.mockReturnValue({ newPriceCents: 1200, capped: false, basis: "margin_erosion" });
      // The guard is the source of truth for the cap decision (block, not clamp).
      checkPriceInventoryGuardrails.mockResolvedValue({ allowed: false, reason: "price change exceeds max" });
      const sb = fakeSb({ enabled: true, alerts: [priceAlert] });
      const r = await runAutopilotForShop(SHOP, sb);

      // BLOCK-NOT-CLAMP: the executor must not fire (no price applied, no ack).
      expect(executeAdjustPriceAlertAction).not.toHaveBeenCalled();
      expect(r.acted).toBe(0);
      expect(r.blocked).toBe(1);
      expect(r.blockedReasons).toEqual({ "price change exceeds max": 1 });
      const dec = r.decisions.find((d) => d.alertId === "al-price");
      expect(dec).toMatchObject({ outcome: "blocked", reason: "price change exceeds max" });
    });

    it("not graduated → skipped (skippedMoves), executor + guard NOT called", async () => {
      withAdjustPriceMove();
      isGraduated.mockResolvedValue(false);
      const sb = fakeSb({ enabled: true, alerts: [priceAlert] });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeAdjustPriceAlertAction).not.toHaveBeenCalled();
      expect(checkPriceInventoryGuardrails).not.toHaveBeenCalled();
      expect(r.acted).toBe(0);
      expect(r.skippedMoves).toBe(1);
      expect(r.blocked).toBe(0);
      // Gate keys on the move's EXECUTOR kind (adjust_price).
      expect(isGraduated).toHaveBeenCalledWith(SHOP, "margin_erosion", "adjust_price", sb);
    });

    it("no price suggestion → blocked, executor + guard NOT called", async () => {
      withAdjustPriceMove();
      suggestAdjustPrice.mockReturnValue(null);
      const sb = fakeSb({ enabled: true, alerts: [priceAlert] });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeAdjustPriceAlertAction).not.toHaveBeenCalled();
      expect(checkPriceInventoryGuardrails).not.toHaveBeenCalled();
      expect(r.acted).toBe(0);
      expect(r.blocked).toBe(1);
      const dec = r.decisions.find((d) => d.alertId === "al-price");
      expect(dec?.reason).toContain("no price suggestion");
    });
  });

  // ─── Task 18c: autonomous reallocate_inventory execution ─────────────────
  // Inventory-relocation detectors route through tryInventoryRelocation (NOT a
  // remediation MoveKind), guarded by graduation + an inventory-unit cap.

  describe("autonomous reallocate_inventory (Task 18c)", () => {
    const invAlert = {
      alert_id: "al-inv",
      detector_id: "regional_shortage_risk",
      dollar_impact: 90, // dollars
      campaign_id: null,
      campaign_spend_cents: 0,
      daily_budget_cents: null,
      evidence: {
        inventory_item_id: "gid://shopify/InventoryItem/1",
        from_location_id: "gid://shopify/Location/1",
        to_location_id: "gid://shopify/Location/2",
        recommended_delta: 4,
      },
      sku: "Regional Tee",
      sku_id: "sku-inv",
    };

    it("graduated + delta ≤ cap → acts via executeInventoryAlertAction (actor autopilot)", async () => {
      transferPlanFromEvidence.mockReturnValue({
        inventoryItemId: "gid://shopify/InventoryItem/1",
        fromLocationId: "gid://shopify/Location/1",
        toLocationId: "gid://shopify/Location/2",
        delta: 4,
      });
      checkPriceInventoryGuardrails.mockResolvedValue({ allowed: true });
      const sb = fakeSb({ enabled: true, alerts: [invAlert] });
      const r = await runAutopilotForShop(SHOP, sb);

      expect(executeInventoryAlertAction).toHaveBeenCalledTimes(1);
      expect(executeInventoryAlertAction).toHaveBeenCalledWith(
        expect.objectContaining({
          shopId: SHOP,
          alertId: "al-inv",
          kind: "reallocate_inventory",
          actor: "autopilot",
          idempotencyKey: "autopilot:al-inv:reallocate_inventory",
        }),
      );
      // Guard saw the |delta| as the units moved, and dollar impact in CENTS (90 → 9000).
      expect(checkPriceInventoryGuardrails).toHaveBeenCalledWith(
        SHOP,
        expect.objectContaining({
          kind: "reallocate_inventory",
          inventoryUnitsMoved: 4,
          dollarImpactCents: 9000,
        }),
        sb,
      );
      expect(r.acted).toBe(1);
    });

    it("delta > cap → blocked 'inventory move exceeds max units', executor NOT called", async () => {
      transferPlanFromEvidence.mockReturnValue({
        inventoryItemId: "gid://shopify/InventoryItem/1",
        fromLocationId: "gid://shopify/Location/1",
        toLocationId: "gid://shopify/Location/2",
        delta: -50, // |50| over the merchant cap
      });
      checkPriceInventoryGuardrails.mockResolvedValue({ allowed: false, reason: "inventory move exceeds max units" });
      const sb = fakeSb({ enabled: true, alerts: [invAlert] });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeInventoryAlertAction).not.toHaveBeenCalled();
      expect(r.acted).toBe(0);
      expect(r.blocked).toBe(1);
      expect(r.blockedReasons).toEqual({ "inventory move exceeds max units": 1 });
      // |delta| is what the guard receives.
      expect(checkPriceInventoryGuardrails).toHaveBeenCalledWith(
        SHOP,
        expect.objectContaining({ inventoryUnitsMoved: 50 }),
        sb,
      );
    });

    it("not graduated → skipped (skippedMoves), executor + guard NOT called", async () => {
      isGraduated.mockResolvedValue(false);
      const sb = fakeSb({ enabled: true, alerts: [invAlert] });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeInventoryAlertAction).not.toHaveBeenCalled();
      expect(checkPriceInventoryGuardrails).not.toHaveBeenCalled();
      expect(r.acted).toBe(0);
      expect(r.skippedMoves).toBe(1);
      expect(isGraduated).toHaveBeenCalledWith(SHOP, "regional_shortage_risk", "reallocate_inventory", sb);
    });

    it("missing/invalid evidence (pure-relocation detector) → blocked, executor NOT called", async () => {
      transferPlanFromEvidence.mockReturnValue(null);
      const sb = fakeSb({ enabled: true, alerts: [invAlert] });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeInventoryAlertAction).not.toHaveBeenCalled();
      expect(r.acted).toBe(0);
      expect(r.blocked).toBe(1);
      const dec = r.decisions.find((d) => d.alertId === "al-inv");
      expect(dec?.reason).toContain("invalid inventory evidence");
    });

    it("non-inventory detector → fell_through (handled by the existing pause path)", async () => {
      // campaign_below_breakeven is not an inventory detector — tryInventoryRelocation
      // must defer so the legacy pause path still acts on it.
      checkGuardrails.mockResolvedValue({ allowed: true });
      const sb = fakeSb({ enabled: true, alerts: [candidate] });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeInventoryAlertAction).not.toHaveBeenCalled();
      expect(executeAction).toHaveBeenCalledWith(
        SHOP,
        expect.objectContaining({ kind: "pause_campaign", alertId: "al1" }),
        sb,
      );
      expect(r.acted).toBe(1);
    });

    it("sku_stockout_vs_spend with NO transfer plan falls through to its legacy pause path", async () => {
      // sku_stockout_vs_spend is an inventory detector but its evidence carries no
      // transfer plan; it must defer to the pause path rather than block, so the
      // shipped stockout-pause no-brainer autonomy is preserved (one decision/alert).
      transferPlanFromEvidence.mockReturnValue(null);
      checkGuardrails.mockResolvedValue({ allowed: true });
      stockoutPauseAllowed.mockResolvedValue({ ok: true });
      const stockout = {
        ...candidate,
        alert_id: "al-stock",
        detector_id: "sku_stockout_vs_spend",
        sku_id: "sku-1",
        sku: "WID-1",
      };
      const sb = fakeSb({
        enabled: true,
        alerts: [stockout],
        scopedAlerts: [{ id: "al-stock", detector_id: "sku_stockout_vs_spend", entity_ref: { sku_id: "sku-1" } }],
      });
      const r = await runAutopilotForShop(SHOP, sb);
      expect(executeInventoryAlertAction).not.toHaveBeenCalled();
      expect(executeAction).toHaveBeenCalledWith(
        SHOP,
        expect.objectContaining({ kind: "pause_campaign", alertId: "al-stock" }),
        sb,
      );
      expect(r.acted).toBe(1);
    });
  });
});
