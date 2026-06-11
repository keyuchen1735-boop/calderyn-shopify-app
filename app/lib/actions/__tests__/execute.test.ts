import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeAction } from "../execute.server";
import { ActionError } from "../../ads/actions";
import type { SupabaseClient } from "@supabase/supabase-js";

const { adapter, actionAdapterForShop } = vi.hoisted(() => {
  const adapter = { platform: "meta", pause: vi.fn(async () => {}), resume: vi.fn(), setDailyBudget: vi.fn(async () => {}), getState: vi.fn() };
  const actionAdapterForShop = vi.fn(async (): Promise<typeof adapter | null> => adapter);
  return { adapter, actionAdapterForShop };
});
vi.mock("../../ads/action-registry.server", () => ({ actionAdapterForShop }));

const SHOP = "00000000-0000-0000-0000-000000000010";
const CAMP = "11111111-1111-1111-1111-111111111111";

// Fake supabase: campaign lookup, idempotency lookup, audit insert, idempotency insert.
function fakeSb(opts: {
  idempotent?: { audit_id: string };
  campaign?: Record<string, unknown> | null;
  priorOutcome?: string;
  idemInsertError?: { message: string };
  alertImpactDollars?: number;
}) {
  const calls = { inserts: [] as Array<{ table: string; rows: unknown }> };
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => {
      if (table === "action_idempotency") return { data: opts.idempotent ?? null, error: null };
      if (table === "ad_campaign_dim") return { data: opts.campaign ?? null, error: null };
      if (table === "alerts") return { data: { dollar_impact: opts.alertImpactDollars ?? null }, error: null };
      if (table === "v_audit_view" || table === "action_audit") return { data: { id: "aud1", outcome: opts.priorOutcome ?? "succeeded" }, error: null };
      return { data: null, error: null };
    });
    chain.single = vi.fn(async () => ({ data: { id: "aud1" }, error: null }));
    chain.insert = vi.fn((rows: unknown) => { calls.inserts.push({ table, rows }); return chain; });
    // Bare-awaited inserts (no .single()) resolve here, e.g. action_idempotency.
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({
        data: null,
        error: table === "action_idempotency" ? (opts.idemInsertError ?? null) : null,
      }).then(resolve);
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
  return { sb, calls };
}

const campaign = { id: CAMP, shop_id: SHOP, external_id: "c1", platform: "meta", status: "active", daily_budget_cents: 5000 };

describe("executeAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a campaign that does not belong to the shop (ownership guard)", async () => {
    const { sb } = fakeSb({ campaign: null });
    await expect(executeAction(SHOP, { alertId: null, kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "k1" }, sb))
      .rejects.toThrow(/not found|ownership/i);
  });

  it("pauses via the adapter and writes a succeeded audit + idempotency", async () => {
    const { sb, calls } = fakeSb({ campaign });
    await executeAction(SHOP, { alertId: null, kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "k1" }, sb);
    expect(adapter.pause).toHaveBeenCalledWith("c1");
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as Record<string, unknown>)).toMatchObject({
      shop_id: SHOP, action_kind: "pause_campaign", outcome: "succeeded",
      pre_state: { status: "active", daily_budget_cents: 5000 },
    });
    expect(calls.inserts.some((i) => i.table === "action_idempotency")).toBe(true);
  });

  it("records the alert's at-stake dollars as recovered impact for a value-recovering action", async () => {
    const { sb, calls } = fakeSb({ campaign, alertImpactDollars: 1693.03 });
    await executeAction(SHOP, { alertId: "alert-1", kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "kimp" }, sb);
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as Record<string, unknown>).dollar_impact_at_exec).toBe(1693.03);
  });

  it("records the stopped daily budget as recovered impact for a no-alert pause", async () => {
    // Campaigns-page / dashboard-API pauses have no alert to claw back from;
    // the recovered dollars are the daily spend being stopped.
    const { sb, calls } = fakeSb({ campaign });
    await executeAction(SHOP, { alertId: null, kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "knp" }, sb);
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as Record<string, unknown>).dollar_impact_at_exec).toBe(50); // 5000c/day stopped
  });

  it("records the daily delta as recovered impact for a no-alert budget reduction", async () => {
    const { sb, calls } = fakeSb({ campaign });
    await executeAction(SHOP, { alertId: null, kind: "reduce_campaign_budget", campaignId: CAMP, idempotencyKey: "knb", dailyBudgetCents: 3500 }, sb);
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as Record<string, unknown>).dollar_impact_at_exec).toBe(15); // 5000→3500
  });

  it("records zero recovered impact for a no-alert resume (neutral)", async () => {
    const paused = { ...campaign, status: "paused" };
    const { sb, calls } = fakeSb({ campaign: paused });
    await executeAction(SHOP, { alertId: null, kind: "resume_campaign", campaignId: CAMP, idempotencyKey: "knr" }, sb);
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as Record<string, unknown>).dollar_impact_at_exec).toBe(0);
  });

  it("records zero recovered impact for a neutral action even with an alert", async () => {
    const paused = { ...campaign, status: "paused" };
    const { sb, calls } = fakeSb({ campaign: paused, alertImpactDollars: 1693.03 });
    await executeAction(SHOP, { alertId: "alert-1", kind: "resume_campaign", campaignId: CAMP, idempotencyKey: "kn" }, sb);
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as Record<string, unknown>).dollar_impact_at_exec).toBe(0);
  });

  it("resume_campaign calls adapter.resume and writes a succeeded audit + idempotency", async () => {
    const paused = { ...campaign, status: "paused" };
    const { sb, calls } = fakeSb({ campaign: paused });
    await executeAction(SHOP, { alertId: null, kind: "resume_campaign", campaignId: CAMP, idempotencyKey: "kr" }, sb);
    expect(adapter.resume).toHaveBeenCalledWith("c1");
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as Record<string, unknown>)).toMatchObject({
      action_kind: "resume_campaign", outcome: "succeeded",
      post_state: { status: "active", daily_budget_cents: 5000 },
    });
    expect(calls.inserts.some((i) => i.table === "action_idempotency")).toBe(true);
  });

  it("refuses reduce_campaign_budget without a target budget instead of zeroing it", async () => {
    // Alerts whose evidence lacks the current budget produce
    // dailyBudgetCents=undefined; the old `?? 0` fallthrough set the live
    // campaign budget to $0.
    const { sb, calls } = fakeSb({ campaign });

    await expect(
      executeAction(
        SHOP,
        { alertId: null, kind: "reduce_campaign_budget", campaignId: CAMP, idempotencyKey: "kb" },
        sb,
      ),
    ).rejects.toThrow(/dailyBudgetCents/);
    expect(adapter.setDailyBudget).not.toHaveBeenCalled();
    expect(calls.inserts).toHaveLength(0); // nothing recorded for a refused input
  });

  it("surfaces an idempotency insert failure without failing the executed action", async () => {
    // The platform call already happened and the audit row exists; failing
    // here would provoke the duplicate execution the key prevents. But the
    // lost protection must be loud, not silent (rule 12).
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sb } = fakeSb({ campaign, idemInsertError: { message: "constraint violation" } });

    const result = await executeAction(
      SHOP,
      { alertId: null, kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "k9" },
      sb,
    );

    expect(result.outcome).toBe("succeeded");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("idempotency"),
      expect.anything(),
    );
    errSpy.mockRestore();
  });

  it("resume_campaign short-circuits on a used idempotency key (no adapter call)", async () => {
    const { sb } = fakeSb({ idempotent: { audit_id: "prev" }, campaign });
    await executeAction(SHOP, { alertId: null, kind: "resume_campaign", campaignId: CAMP, idempotencyKey: "kr" }, sb);
    expect(adapter.resume).not.toHaveBeenCalled();
  });

  it("reduce_campaign_budget calls setDailyBudget with the new cents", async () => {
    const { sb } = fakeSb({ campaign });
    await executeAction(SHOP, { alertId: null, kind: "reduce_campaign_budget", campaignId: CAMP, idempotencyKey: "k2", dailyBudgetCents: 2500 }, sb);
    expect(adapter.setDailyBudget).toHaveBeenCalledWith("c1", 2500);
  });

  it("short-circuits on a used idempotency key (no adapter call)", async () => {
    const { sb } = fakeSb({ idempotent: { audit_id: "prev" }, campaign });
    await executeAction(SHOP, { alertId: null, kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "k1" }, sb);
    expect(adapter.pause).not.toHaveBeenCalled();
  });

  it("returns the prior attempt's real outcome on a used key (not a hardcoded success)", async () => {
    // The first attempt is still parked as `retrying`; a re-submit must not
    // report success for an action that has not actually succeeded (rule 12).
    const { sb } = fakeSb({ idempotent: { audit_id: "prev" }, campaign, priorOutcome: "retrying" });
    const res = await executeAction(SHOP, { alertId: null, kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "k1" }, sb);
    expect(res.outcome).toBe("retrying");
    expect(adapter.pause).not.toHaveBeenCalled();
  });

  it("records a retrying audit (attempts 1) when the adapter throws a transient error", async () => {
    adapter.pause.mockRejectedValueOnce(new Error("Meta API 503"));
    const { sb, calls } = fakeSb({ campaign });
    await executeAction(SHOP, { alertId: null, kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "kt1" }, sb);
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as Record<string, unknown>)).toMatchObject({ outcome: "retrying", attempts: 1, post_state: null });
  });

  it("records a terminal failed audit when the adapter throws a non-retriable error", async () => {
    adapter.pause.mockRejectedValueOnce(new ActionError("meta", "invalid token", { retriable: false }));
    const { sb, calls } = fakeSb({ campaign });
    await executeAction(SHOP, { alertId: null, kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "kt2" }, sb);
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as Record<string, unknown>)).toMatchObject({ outcome: "failed" });
  });

  it("records a failed audit when the platform is not connected", async () => {
    actionAdapterForShop.mockResolvedValueOnce(null);
    const { sb, calls } = fakeSb({ campaign });
    await executeAction(SHOP, { alertId: null, kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "k3" }, sb);
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as Record<string, unknown>)).toMatchObject({ outcome: "failed" });
  });

  it("records the actor on the audit row", async () => {
    const { sb, calls } = fakeSb({ campaign });
    await executeAction(SHOP, { alertId: null, kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "kA", actor: "autopilot" }, sb);
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as Record<string, unknown>).actor_user_id).toBe("autopilot");
  });
});
