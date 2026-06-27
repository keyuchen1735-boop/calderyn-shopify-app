import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeAction, recoveredDollarsForAlertAction } from "../execute.server";
import { ActionError } from "../../ads/actions";
import type { SupabaseClient } from "@supabase/supabase-js";

const { adapter, actionAdapterForShop } = vi.hoisted(() => {
  const adapter = { platform: "meta", pause: vi.fn(async () => {}), resume: vi.fn(), setDailyBudget: vi.fn(async () => {}), getState: vi.fn(), excludeGeo: vi.fn(async () => {}), includeGeo: vi.fn(async () => {}) };
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
  const calls = {
    inserts: [] as Array<{ table: string; rows: unknown }>,
    updates: [] as Array<{ table: string; payload: unknown }>,
  };
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.update = vi.fn((payload: unknown) => {
      calls.updates.push({ table, payload });
      return chain;
    });
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

  it("acknowledges the alert (open → acknowledged) on a succeeded action with an alert", async () => {
    // Centralized in insertAuditWithIdempotency so EVERY executor path —
    // autopilot, dashboard API, reallocation — closes the alert, not just
    // the alert-detail route.
    const { sb, calls } = fakeSb({ campaign, alertImpactDollars: 100 });
    await executeAction(SHOP, { alertId: "alert-1", kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "kack" }, sb);
    expect(calls.updates).toContainEqual({ table: "alerts", payload: { status: "acknowledged" } });
  });

  it("does not acknowledge the alert when the platform call fails", async () => {
    adapter.pause.mockRejectedValueOnce(new Error("platform down"));
    const { sb, calls } = fakeSb({ campaign, alertImpactDollars: 100 });
    await executeAction(SHOP, { alertId: "alert-1", kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "kackf" }, sb);
    expect(calls.updates.filter((u) => u.table === "alerts")).toEqual([]);
  });

  it("exclude_geo calls adapter.excludeGeo with the region and records it in params", async () => {
    const { sb, calls } = fakeSb({ campaign });
    const res = await executeAction(
      SHOP,
      { alertId: "alert-1", kind: "exclude_geo", campaignId: CAMP, idempotencyKey: "kgeo", region: "us-west" },
      sb,
    );
    expect(adapter.excludeGeo).toHaveBeenCalledWith("c1", "us-west");
    expect(res.outcome).toBe("succeeded");
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as { action_kind: string; params: Record<string, unknown> }).action_kind).toBe("exclude_geo");
    expect((audit?.rows as { params: Record<string, unknown> }).params).toMatchObject({ region: "us-west" });
    // Targeting-only change: status/budget unchanged in post_state.
    expect((audit?.rows as { post_state: Record<string, unknown> }).post_state).toMatchObject({ status: "active", daily_budget_cents: 5000 });
  });

  it("exclude_geo without a region fails visibly before any platform call", async () => {
    const { sb } = fakeSb({ campaign });
    await expect(
      executeAction(SHOP, { alertId: "alert-1", kind: "exclude_geo", campaignId: CAMP, idempotencyKey: "kgeo2" }, sb),
    ).rejects.toThrow(/region/i);
    expect(adapter.excludeGeo).not.toHaveBeenCalled();
  });

  it("exclude_geo rejects an unknown region bucket before any platform call", async () => {
    const { sb } = fakeSb({ campaign });
    await expect(
      executeAction(
        SHOP,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the bad-region guard
        { alertId: "alert-1", kind: "exclude_geo", campaignId: CAMP, idempotencyKey: "kgeo3", region: "us-bogus" as any },
        sb,
      ),
    ).rejects.toThrow(/valid region/i);
    expect(adapter.excludeGeo).not.toHaveBeenCalled();
  });

  it("does not touch alerts on a succeeded action without an alert", async () => {
    const { sb, calls } = fakeSb({ campaign });
    await executeAction(SHOP, { alertId: null, kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "kackn" }, sb);
    expect(calls.updates.filter((u) => u.table === "alerts")).toEqual([]);
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

  // Optimistic mirror update: the campaigns view reads ad_campaign_dim (via
  // v_campaigns_flat), refreshed only by ingestion. After a succeeded action we
  // already KNOW the new state, so write it back immediately — no extra
  // platform call, and the next sync still reconciles.
  it("writes the new paused status into ad_campaign_dim after a succeeded pause", async () => {
    const { sb, calls } = fakeSb({ campaign });
    await executeAction(SHOP, { alertId: null, kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "km1" }, sb);
    const mirror = calls.updates.find((u) => u.table === "ad_campaign_dim");
    expect(mirror?.payload).toMatchObject({ status: "paused" });
  });

  it("writes the new active status into ad_campaign_dim after a succeeded resume", async () => {
    const paused = { ...campaign, status: "paused" };
    const { sb, calls } = fakeSb({ campaign: paused });
    await executeAction(SHOP, { alertId: null, kind: "resume_campaign", campaignId: CAMP, idempotencyKey: "km2" }, sb);
    const mirror = calls.updates.find((u) => u.table === "ad_campaign_dim");
    expect(mirror?.payload).toMatchObject({ status: "active" });
  });

  it("writes the new daily budget into ad_campaign_dim after a succeeded budget change", async () => {
    const { sb, calls } = fakeSb({ campaign });
    await executeAction(SHOP, { alertId: null, kind: "reduce_campaign_budget", campaignId: CAMP, idempotencyKey: "km3", dailyBudgetCents: 3500 }, sb);
    const mirror = calls.updates.find((u) => u.table === "ad_campaign_dim");
    expect(mirror?.payload).toMatchObject({ daily_budget_cents: 3500 });
  });

  it("does NOT update ad_campaign_dim when the platform call fails (no lying about state)", async () => {
    adapter.pause.mockRejectedValueOnce(new ActionError("meta", "invalid token", { retriable: false }));
    const { sb, calls } = fakeSb({ campaign });
    await executeAction(SHOP, { alertId: null, kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "km4" }, sb);
    expect(calls.updates.filter((u) => u.table === "ad_campaign_dim")).toEqual([]);
  });

  it("increase_campaign_budget mirrors the new budget and records $0 recovered", async () => {
    const { sb, calls } = fakeSb({ campaign });
    await executeAction(SHOP, { alertId: null, kind: "increase_campaign_budget", campaignId: CAMP, idempotencyKey: "kib", dailyBudgetCents: 6000 }, sb);
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as Record<string, unknown>).action_kind).toBe("increase_campaign_budget");
    expect((audit?.rows as Record<string, unknown>).post_state).toMatchObject({ daily_budget_cents: 6000, status: "active" });
    expect((audit?.rows as Record<string, unknown>).dollar_impact_at_exec).toBe(0);
  });

  it("increase_campaign_budget refuses a missing target budget", async () => {
    const { sb } = fakeSb({ campaign });
    await expect(
      executeAction(SHOP, { alertId: null, kind: "increase_campaign_budget", campaignId: CAMP, idempotencyKey: "kib2" }, sb),
    ).rejects.toThrow(/no positive dailyBudgetCents/);
  });

  // ─── I5: Outcome-idempotent budget guard ─────────────────────────────────
  // When live budget <= target, the reduce is a no-op: setDailyBudget must NOT
  // be called and a succeeded audit row with noop_reason must be recorded.
  // This makes overlapping/replayed ticks idempotent on outcome.

  describe("I5: outcome-idempotent budget (reduce_campaign_budget)", () => {
    it("no-ops (no setDailyBudget) when live budget is already at the target", async () => {
      // campaign.daily_budget_cents = 5000; target = 5000 → live == target → no-op.
      const { sb } = fakeSb({ campaign });
      const result = await executeAction(
        SHOP,
        { alertId: null, kind: "reduce_campaign_budget", campaignId: CAMP, idempotencyKey: "ki5-eq", dailyBudgetCents: 5000 },
        sb,
      );
      expect(adapter.setDailyBudget).not.toHaveBeenCalled();
      expect(result.outcome).toBe("succeeded");
    });

    it("no-ops when live budget is already BELOW the target (second tick scenario)", async () => {
      // campaign.daily_budget_cents = 3000; target = 5000 → live < target → no-op.
      // This is the double-cut scenario: first tick already reduced to 3000,
      // second tick tries to reduce to 5000 (its snapshot target) — must no-op.
      const alreadyReduced = { ...campaign, daily_budget_cents: 3000 };
      const { sb } = fakeSb({ campaign: alreadyReduced });
      const result = await executeAction(
        SHOP,
        { alertId: null, kind: "reduce_campaign_budget", campaignId: CAMP, idempotencyKey: "ki5-lt", dailyBudgetCents: 5000 },
        sb,
      );
      expect(adapter.setDailyBudget).not.toHaveBeenCalled();
      expect(result.outcome).toBe("succeeded");
    });

    it("records noop_reason in params when skipping the platform call", async () => {
      const { sb, calls } = fakeSb({ campaign }); // daily_budget_cents: 5000, target: 5000
      await executeAction(
        SHOP,
        { alertId: null, kind: "reduce_campaign_budget", campaignId: CAMP, idempotencyKey: "ki5-pr", dailyBudgetCents: 5000 },
        sb,
      );
      const audit = calls.inserts.find((i) => i.table === "action_audit");
      expect((audit?.rows as Record<string, unknown>).params).toMatchObject({ noop_reason: "already_at_target" });
    });

    it("DOES call setDailyBudget when live budget is ABOVE the target (normal reduce path)", async () => {
      // campaign.daily_budget_cents = 5000; target = 3500 → live > target → normal cut.
      const { sb } = fakeSb({ campaign });
      await executeAction(
        SHOP,
        { alertId: null, kind: "reduce_campaign_budget", campaignId: CAMP, idempotencyKey: "ki5-ok", dailyBudgetCents: 3500 },
        sb,
      );
      expect(adapter.setDailyBudget).toHaveBeenCalledWith("c1", 3500);
    });

    it("two sequential calls with the same key: first reduces normally, second is a key-dedup no-op", async () => {
      // The second call is caught by idempotency key dedup (priorExecutionForKey),
      // not the live-budget guard — both mechanisms protect against double-acting.
      const { sb } = fakeSb({ idempotent: { audit_id: "prev" }, campaign, priorOutcome: "succeeded" });
      const result = await executeAction(
        SHOP,
        { alertId: null, kind: "reduce_campaign_budget", campaignId: CAMP, idempotencyKey: "ki5-dup", dailyBudgetCents: 3500 },
        sb,
      );
      // Returns the prior outcome without calling the adapter.
      expect(adapter.setDailyBudget).not.toHaveBeenCalled();
      expect(result.outcome).toBe("succeeded");
    });
  });
});

// Cross-tenant accounting guard: the alerts lookup that drives recovered-impact
// dollars must be scoped to the acting shop. A merchant for shop A supplying an
// alert_id owned by shop B must NOT count shop B's dollar_impact toward shop A
// (it resolves to no row → 0), while a legitimately-owned alert still returns
// its impact.
const SHOP_A = "aaaaaaaa-0000-0000-0000-000000000001";
const SHOP_B = "bbbbbbbb-0000-0000-0000-000000000002";

// Fake supabase whose `alerts` lookup HONORS the shop_id eq filter, unlike the
// permissive fakeSb above. The alert exists only for the shop it belongs to.
function fakeAlertsSb(opts: { alertId: string; ownerShop: string; dollars: number }) {
  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn((col: string, val: unknown) => {
      filters[col] = val;
      return chain;
    });
    chain.maybeSingle = vi.fn(async () => {
      if (table !== "alerts") return { data: null, error: null };
      const idMatch = filters.id === opts.alertId;
      // shop_id is present in filters only after the fix threads it through.
      const shopMatch = !("shop_id" in filters) || filters.shop_id === opts.ownerShop;
      return idMatch && shopMatch
        ? { data: { dollar_impact: opts.dollars }, error: null }
        : { data: null, error: null };
    });
    return chain;
  }
  return { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
}

describe("recoveredDollarsForAlertAction — cross-tenant scoping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 0 when the alert belongs to another shop (cross-tenant alert_id)", async () => {
    // Alert is owned by shop B; shop A acts with shop B's alert_id.
    const sb = fakeAlertsSb({ alertId: "alert-of-B", ownerShop: SHOP_B, dollars: 1693.03 });
    const recovered = await recoveredDollarsForAlertAction(sb, "alert-of-B", "pause_campaign", SHOP_A);
    expect(recovered).toBe(0);
  });

  it("returns the alert's impact when it belongs to the acting shop", async () => {
    const sb = fakeAlertsSb({ alertId: "alert-of-A", ownerShop: SHOP_A, dollars: 1693.03 });
    const recovered = await recoveredDollarsForAlertAction(sb, "alert-of-A", "pause_campaign", SHOP_A);
    expect(recovered).toBe(1693.03);
  });
});
