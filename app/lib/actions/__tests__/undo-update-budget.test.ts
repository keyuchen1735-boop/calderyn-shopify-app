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

function fakeSb(original: Record<string, unknown> | null) {
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
    chain.maybeSingle = vi.fn(async () => ({
      data: table !== "action_audit" ? null : selected === "id" ? null : original,
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

const updateBudgetAudit = {
  id: "aud_ub", shop_id: SHOP, action_kind: "update_campaign_budget",
  params: { external_id: "c1", platform: "meta" },
  pre_state: { status: "active", daily_budget_cents: 6000 },
  post_state: { status: "active", daily_budget_cents: 9000 },
  dollar_impact_at_exec: 0,
  outcome: "succeeded",
};

describe("undoAction — update_campaign_budget", () => {
  beforeEach(() => vi.clearAllMocks());

  it("restores the prior daily budget on an update_campaign_budget undo", async () => {
    const { sb } = fakeSb(updateBudgetAudit);
    await undoAction(SHOP, "aud_ub", sb);
    expect(adapter.setDailyBudget).toHaveBeenCalledWith("c1", 6000);
  });

  it("writes the restored budget into ad_campaign_dim", async () => {
    const { sb, calls } = fakeSb(updateBudgetAudit);
    await undoAction(SHOP, "aud_ub", sb);
    const mirror = calls.updates.find((u) => u.table === "ad_campaign_dim");
    expect(mirror?.payload).toMatchObject({ daily_budget_cents: 6000 });
  });

  it("refuses to undo with no recorded external id", async () => {
    const noExternalId = { ...updateBudgetAudit, params: { platform: "meta" } };
    const { sb } = fakeSb(noExternalId);
    await expect(undoAction(SHOP, "aud_ub", sb)).rejects.toThrow(/external id|campaign id/i);
    expect(adapter.setDailyBudget).not.toHaveBeenCalled();
  });
});
