import { describe, it, expect, vi, beforeEach } from "vitest";
import { undoAction } from "../undo.server";
import type { SupabaseClient } from "@supabase/supabase-js";

const { adapter, actionAdapterForShop } = vi.hoisted(() => {
  const adapter = { platform: "meta", pause: vi.fn(), resume: vi.fn(async () => {}), setDailyBudget: vi.fn(async () => {}), getState: vi.fn() };
  const actionAdapterForShop = vi.fn(async () => adapter);
  return { adapter, actionAdapterForShop };
});
vi.mock("../../ads/action-registry.server", () => ({ actionAdapterForShop }));

const SHOP = "00000000-0000-0000-0000-000000000010";

function fakeSb(original: Record<string, unknown> | null) {
  const calls = {
    inserts: [] as Array<{ table: string; rows: unknown }>,
    updates: [] as Array<{ table: string; payload: unknown }>,
  };
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: table === "action_audit" ? original : null, error: null }));
    chain.single = vi.fn(async () => ({ data: { id: "undo1" }, error: null }));
    chain.insert = vi.fn((rows: unknown) => { calls.inserts.push({ table, rows }); return chain; });
    chain.update = vi.fn((payload: unknown) => { calls.updates.push({ table, payload }); return chain; });
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
  return { sb, calls };
}

const pauseAudit = {
  id: "aud1", shop_id: SHOP, action_kind: "pause_campaign",
  params: { external_id: "c1", platform: "meta" },
  pre_state: { status: "active", daily_budget_cents: 5000 },
  post_state: { status: "paused", daily_budget_cents: 5000 },
  dollar_impact_at_exec: 5000,
};

describe("undoAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resumes a paused campaign and writes an undo audit", async () => {
    const { sb, calls } = fakeSb(pauseAudit);
    await undoAction(SHOP, "aud1", sb);
    expect(adapter.resume).toHaveBeenCalledWith("c1");
    const undo = calls.inserts.find((i) => i.table === "action_audit");
    expect((undo?.rows as Record<string, unknown>)).toMatchObject({
      undo_of: "aud1",
      outcome: "succeeded",
      dollar_impact_at_exec: -5000, // pulls the original's recovered impact back out
    });
  });

  it("re-pauses a campaign on a resume_campaign undo (restores pre status)", async () => {
    const resumeAudit = { ...pauseAudit, action_kind: "resume_campaign",
      pre_state: { status: "paused", daily_budget_cents: 5000 },
      post_state: { status: "active", daily_budget_cents: 5000 } };
    const { sb, calls } = fakeSb(resumeAudit);
    await undoAction(SHOP, "aud1", sb);
    expect(adapter.pause).toHaveBeenCalledWith("c1");
    expect(adapter.resume).not.toHaveBeenCalled();
    const undo = calls.inserts.find((i) => i.table === "action_audit");
    expect((undo?.rows as Record<string, unknown>)).toMatchObject({ undo_of: "aud1", outcome: "succeeded" });
  });

  it("restores the prior budget on a budget-action undo", async () => {
    const budgetAudit = { ...pauseAudit, action_kind: "reduce_campaign_budget",
      pre_state: { status: "active", daily_budget_cents: 5000 },
      post_state: { status: "active", daily_budget_cents: 2500 } };
    const { sb } = fakeSb(budgetAudit);
    await undoAction(SHOP, "aud1", sb);
    expect(adapter.setDailyBudget).toHaveBeenCalledWith("c1", 5000);
  });

  // Same optimistic-mirror gap as executeAction: undo reverses the platform but
  // the campaigns view (ad_campaign_dim via v_campaigns_flat) stays stale until
  // the next sync. Undo restores pre_state, so write pre_state back.
  it("writes the restored status into ad_campaign_dim when undoing a pause", async () => {
    const { sb, calls } = fakeSb(pauseAudit);
    await undoAction(SHOP, "aud1", sb);
    const mirror = calls.updates.find((u) => u.table === "ad_campaign_dim");
    expect(mirror?.payload).toMatchObject({ status: "active" });
  });

  it("writes the restored budget into ad_campaign_dim when undoing a budget change", async () => {
    const budgetAudit = { ...pauseAudit, action_kind: "reduce_campaign_budget",
      pre_state: { status: "active", daily_budget_cents: 5000 },
      post_state: { status: "active", daily_budget_cents: 2500 } };
    const { sb, calls } = fakeSb(budgetAudit);
    await undoAction(SHOP, "aud1", sb);
    const mirror = calls.updates.find((u) => u.table === "ad_campaign_dim");
    expect(mirror?.payload).toMatchObject({ daily_budget_cents: 5000 });
  });

  it("throws when the audit is not found for the shop", async () => {
    const { sb } = fakeSb(null);
    await expect(undoAction(SHOP, "missing", sb)).rejects.toThrow(/not found/i);
  });

  it("re-opens the acknowledged alert and carries alert_id onto the undo row", async () => {
    // acknowledge-on-execute closed the alert; every undo surface (dashboard
    // route, reallocate delegation) goes through undoAction, so the re-open
    // must live here — not only in the legacy calderyn.server.ts wrapper.
    const { sb, calls } = fakeSb({ ...pauseAudit, alert_id: "al-9" });
    await undoAction(SHOP, "aud1", sb);
    expect(calls.updates).toContainEqual({ table: "alerts", payload: { status: "open" } });
    const undo = calls.inserts.find((i) => i.table === "action_audit");
    expect((undo?.rows as Record<string, unknown>).alert_id).toBe("al-9");
  });

  it("does not touch alerts when the original action had none", async () => {
    const { sb, calls } = fakeSb(pauseAudit);
    await undoAction(SHOP, "aud1", sb);
    expect(calls.updates.filter((u) => u.table === "alerts")).toEqual([]);
  });
});

describe("undoAction · reallocate_budget", () => {
  const reallocAudit = {
    id: "audR",
    shop_id: SHOP,
    action_kind: "reallocate_budget",
    params: {
      source_campaign_id: "src-uuid",
      source_external_id: "g-1",
      source_platform: "google",
      dest_campaign_id: "dst-uuid",
      dest_external_id: "m-1",
      dest_platform: "meta",
      amount_cents: 500,
      external_id: "m-1",
      platform: "meta",
      daily_budget_cents: 1500,
    },
    pre_state: { source: { daily_budget_cents: 2000 }, dest: { daily_budget_cents: 1000 } },
    post_state: { source: { daily_budget_cents: 1500 }, dest: { daily_budget_cents: 1500 } },
  };

  function fakeUndoSb(orig: Record<string, unknown>) {
    const inserts: Array<Record<string, unknown>> = [];
    function builder() {
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () => ({ data: orig, error: null }));
      chain.insert = vi.fn((rows: Record<string, unknown>) => {
        inserts.push(rows);
        return chain;
      });
      chain.single = vi.fn(async () => ({ data: { id: "undo1" }, error: null }));
      return chain;
    }
    return { sb: { from: vi.fn(() => builder()) } as unknown as SupabaseClient, inserts };
  }

  beforeEach(() => vi.clearAllMocks());

  it("restores BOTH budgets from pre_state, dest first (never over-spend mid-undo)", async () => {
    const { sb, inserts } = fakeUndoSb(reallocAudit);
    await undoAction(SHOP, "audR", sb);
    // dest back to 1000 BEFORE source back to 2000
    expect(adapter.setDailyBudget).toHaveBeenNthCalledWith(1, "m-1", 1000);
    expect(adapter.setDailyBudget).toHaveBeenNthCalledWith(2, "g-1", 2000);
    expect(inserts[0]).toMatchObject({
      action_kind: "reallocate_budget",
      undo_of: "audR",
      pre_state: reallocAudit.post_state,
      post_state: reallocAudit.pre_state,
      outcome: "succeeded",
    });
  });
});

describe("undoAction · unhandled action kind guard", () => {
  function fakeUndoSb(orig: Record<string, unknown>) {
    const inserts: Array<Record<string, unknown>> = [];
    function builder() {
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () => ({ data: orig, error: null }));
      chain.insert = vi.fn((rows: Record<string, unknown>) => {
        inserts.push(rows);
        return chain;
      });
      chain.single = vi.fn(async () => ({ data: { id: "undo1" }, error: null }));
      return chain;
    }
    return { sb: { from: vi.fn(() => builder()) } as unknown as SupabaseClient, inserts };
  }

  beforeEach(() => vi.clearAllMocks());

  it("throws for unhandled action kind (rule 12: never silently succeed)", async () => {
    const unknownAudit = {
      id: "audX",
      shop_id: SHOP,
      action_kind: "snooze_alert",
      params: { external_id: "x-1", platform: "meta" },
      pre_state: {},
      post_state: {},
    };
    const { sb } = fakeUndoSb(unknownAudit);
    await expect(undoAction(SHOP, "audX", sb)).rejects.toThrow(/undo not supported for action kind snooze_alert/i);
  });
});
