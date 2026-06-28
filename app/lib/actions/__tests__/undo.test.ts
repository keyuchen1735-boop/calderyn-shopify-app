import { describe, it, expect, vi, beforeEach } from "vitest";
import { undoAction } from "../undo.server";
import type { SupabaseClient } from "@supabase/supabase-js";

const { adapter, actionAdapterForShop } = vi.hoisted(() => {
  const adapter = { platform: "meta", pause: vi.fn(), resume: vi.fn(async () => {}), setDailyBudget: vi.fn(async () => {}), getState: vi.fn(), excludeGeo: vi.fn(async () => {}), includeGeo: vi.fn(async () => {}) };
  const actionAdapterForShop = vi.fn(async () => adapter);
  return { adapter, actionAdapterForShop };
});
vi.mock("../../ads/action-registry.server", () => ({ actionAdapterForShop }));

const SHOP = "00000000-0000-0000-0000-000000000010";

function fakeSb(
  original: Record<string, unknown> | null,
  existingUndo: { id: string } | null = null,
) {
  const calls = {
    inserts: [] as Array<{ table: string; rows: unknown }>,
    updates: [] as Array<{ table: string; payload: unknown }>,
  };
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    let selected = "";
    chain.select = vi.fn((cols: string) => {
      selected = cols;
      return chain;
    });
    chain.eq = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    // The double-undo guard selects only "id"; the orig lookup selects the full
    // column list. Key the resolved row on that so each query gets its own data.
    chain.maybeSingle = vi.fn(async () => ({
      data: table !== "action_audit" ? null : selected === "id" ? existingUndo : original,
      error: null,
    }));
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
  outcome: "succeeded",
};

const excludeGeoAudit = {
  id: "aud2", shop_id: SHOP, action_kind: "exclude_geo",
  params: { external_id: "c1", platform: "meta", region: "us-west" },
  pre_state: { status: "active", daily_budget_cents: 5000 },
  post_state: { status: "active", daily_budget_cents: 5000 },
  dollar_impact_at_exec: 0,
  outcome: "succeeded",
};

describe("undoAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("undo of exclude_geo re-includes the recorded region", async () => {
    const { sb, calls } = fakeSb(excludeGeoAudit);
    await undoAction(SHOP, "aud2", sb);
    expect(adapter.includeGeo).toHaveBeenCalledWith("c1", "us-west");
    const undo = calls.inserts.find((i) => i.table === "action_audit");
    expect((undo?.rows as Record<string, unknown>)).toMatchObject({ undo_of: "aud2", outcome: "succeeded" });
  });

  it("refuses to undo exclude_geo with no recorded region", async () => {
    const noRegion = { ...excludeGeoAudit, params: { external_id: "c1", platform: "meta" } };
    const { sb } = fakeSb(noRegion);
    await expect(undoAction(SHOP, "aud2", sb)).rejects.toThrow(/region/i);
    expect(adapter.includeGeo).not.toHaveBeenCalled();
  });

  it("refuses to undo a campaign row with no external id (never calls the platform with a blank id)", async () => {
    // Legacy rows could lack params.external_id; reversing with "" would hit the
    // ad platform with a blank campaign id (404 or silent no-op). Fail loudly.
    const noExternalId = { ...pauseAudit, params: { platform: "meta" } };
    const { sb } = fakeSb(noExternalId);
    await expect(undoAction(SHOP, "aud1", sb)).rejects.toThrow(/external id|campaign id/i);
    expect(adapter.resume).not.toHaveBeenCalled();
    expect(adapter.pause).not.toHaveBeenCalled();
  });

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

  it("treats pre_state status case-insensitively (legacy rows stored uppercase)", async () => {
    // The pre-gateway actions.execute path recorded Meta's uppercase "ACTIVE".
    // Routing those through undo must still resume (not pause) on undo.
    const legacyUpper = { ...pauseAudit, pre_state: { status: "ACTIVE", daily_budget_cents: 5000 } };
    const { sb } = fakeSb(legacyUpper);
    await undoAction(SHOP, "aud1", sb);
    expect(adapter.resume).toHaveBeenCalledWith("c1");
    expect(adapter.pause).not.toHaveBeenCalled();
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

  it("refuses when the audit was already undone, without any platform call", async () => {
    const { sb, calls } = fakeSb(pauseAudit, { id: "undo-prior" });
    await expect(undoAction(SHOP, "aud1", sb)).rejects.toThrow(/already undone/i);
    expect(adapter.resume).not.toHaveBeenCalled();
    expect(adapter.pause).not.toHaveBeenCalled();
    expect(calls.inserts).toEqual([]);
  });

  it("refuses to undo a row that is itself an undo, without any platform call", async () => {
    const { sb, calls } = fakeSb({ ...pauseAudit, undo_of: "aud0" });
    await expect(undoAction(SHOP, "aud1", sb)).rejects.toThrow(/cannot undo an undo/i);
    expect(adapter.resume).not.toHaveBeenCalled();
    expect(adapter.pause).not.toHaveBeenCalled();
    expect(calls.inserts).toEqual([]);
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
    outcome: "succeeded",
  };

  function fakeUndoSb(orig: Record<string, unknown>) {
    const inserts: Array<Record<string, unknown>> = [];
    function builder() {
      const chain: Record<string, unknown> = {};
      let selected = "";
      chain.select = vi.fn((cols: string) => {
        selected = cols;
        return chain;
      });
      chain.eq = vi.fn(() => chain);
      chain.limit = vi.fn(() => chain);
      // select("id") is the double-undo guard's existence probe — resolve it
      // empty so the orig row only answers the full-column lookup.
      chain.maybeSingle = vi.fn(async () => ({ data: selected === "id" ? null : orig, error: null }));
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

describe("undoAction · actor-dependent undo window", () => {
  beforeEach(() => vi.clearAllMocks());

  // Merchant actions: 24-hour window.
  // Autopilot actions: 48-hour window (merchant needs time to notice).
  // v_audit_view.undo_eligible mirrors these via undo_expires_at (computed in view);
  // this asserts the API enforces the same windows (the real boundary).
  const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

  // --- Merchant (24h) ---
  it("refuses to undo a merchant action older than 24 hours, without any platform call", async () => {
    const stale = { ...pauseAudit, actor_user_id: "merchant", created_at: hoursAgo(25) };
    const { sb, calls } = fakeSb(stale);
    await expect(undoAction(SHOP, "aud1", sb)).rejects.toThrow(/24-hour|undo window/i);
    expect(adapter.resume).not.toHaveBeenCalled();
    expect(adapter.pause).not.toHaveBeenCalled();
    expect(calls.inserts).toEqual([]);
  });

  it("allows undo of a merchant action within the last 24 hours", async () => {
    const fresh = { ...pauseAudit, actor_user_id: "merchant", created_at: hoursAgo(1) };
    const { sb, calls } = fakeSb(fresh);
    await undoAction(SHOP, "aud1", sb);
    expect(adapter.resume).toHaveBeenCalledWith("c1");
    expect(calls.inserts.some((i) => i.table === "action_audit")).toBe(true);
  });

  // --- Autopilot (48h) ---
  it("allows undo of an autopilot action at 36 hours (within 48h window)", async () => {
    const fresh = { ...pauseAudit, actor_user_id: "autopilot", created_at: hoursAgo(36) };
    const { sb, calls } = fakeSb(fresh);
    await undoAction(SHOP, "aud1", sb);
    expect(adapter.resume).toHaveBeenCalledWith("c1");
    expect(calls.inserts.some((i) => i.table === "action_audit")).toBe(true);
  });

  it("refuses undo of an autopilot action at 49 hours (outside 48h window)", async () => {
    const stale = { ...pauseAudit, actor_user_id: "autopilot", created_at: hoursAgo(49) };
    const { sb, calls } = fakeSb(stale);
    await expect(undoAction(SHOP, "aud1", sb)).rejects.toThrow(/48-hour|undo window/i);
    expect(adapter.resume).not.toHaveBeenCalled();
    expect(adapter.pause).not.toHaveBeenCalled();
    expect(calls.inserts).toEqual([]);
  });

  it("autopilot action at 23h is eligible (well within 48h window)", async () => {
    const fresh = { ...pauseAudit, actor_user_id: "autopilot", created_at: hoursAgo(23) };
    const { sb, calls } = fakeSb(fresh);
    await undoAction(SHOP, "aud1", sb);
    expect(adapter.resume).toHaveBeenCalledWith("c1");
    expect(calls.inserts.some((i) => i.table === "action_audit")).toBe(true);
  });

  it("merchant action at 25h is ineligible (past 24h)", async () => {
    const stale = { ...pauseAudit, actor_user_id: "merchant", created_at: hoursAgo(25) };
    const { sb, calls } = fakeSb(stale);
    await expect(undoAction(SHOP, "aud1", sb)).rejects.toThrow(/24-hour|undo window/i);
    expect(adapter.resume).not.toHaveBeenCalled();
    expect(calls.inserts).toEqual([]);
  });
});

describe("undoAction · unhandled action kind guard", () => {
  function fakeUndoSb(orig: Record<string, unknown>) {
    const inserts: Array<Record<string, unknown>> = [];
    function builder() {
      const chain: Record<string, unknown> = {};
      let selected = "";
      chain.select = vi.fn((cols: string) => {
        selected = cols;
        return chain;
      });
      chain.eq = vi.fn(() => chain);
      chain.limit = vi.fn(() => chain);
      // select("id") is the double-undo guard's existence probe — resolve it
      // empty so the orig row only answers the full-column lookup.
      chain.maybeSingle = vi.fn(async () => ({ data: selected === "id" ? null : orig, error: null }));
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
      outcome: "succeeded",
    };
    const { sb } = fakeUndoSb(unknownAudit);
    await expect(undoAction(SHOP, "audX", sb)).rejects.toThrow(/undo not supported for action kind snooze_alert/i);
  });
});
