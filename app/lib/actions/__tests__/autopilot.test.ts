import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAutopilotForShop } from "../autopilot.server";
import { getActionPolicy } from "../action-policy.server";
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
};

describe("runAutopilotForShop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeAction.mockResolvedValue({ id: "aud1", outcome: "succeeded" });
    executeReallocation.mockResolvedValue({ id: "aud2", outcome: "succeeded" });
    loadReallocationCandidates.mockResolvedValue([]);
    pickReallocation.mockReturnValue({ source: null, dest: null });
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
    expect(r).toMatchObject({ skipped: false, acted: 0, blocked: 1, failed: 0 });
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
    expect(r).toMatchObject({ skipped: false, acted: 1, blocked: 1, failed: 0 });
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
