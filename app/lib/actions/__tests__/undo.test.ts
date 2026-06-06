import { describe, it, expect, vi, beforeEach } from "vitest";

const { adapter, actionAdapterForShop } = vi.hoisted(() => {
  const adapter = { platform: "meta", pause: vi.fn(), resume: vi.fn(async () => {}), setDailyBudget: vi.fn(async () => {}), getState: vi.fn() };
  const actionAdapterForShop = vi.fn(async () => adapter);
  return { adapter, actionAdapterForShop };
});
vi.mock("../../ads/action-registry.server", () => ({ actionAdapterForShop }));

import { undoAction } from "../undo.server";
import type { SupabaseClient } from "@supabase/supabase-js";

const SHOP = "00000000-0000-0000-0000-000000000010";

function fakeSb(original: Record<string, unknown> | null) {
  const calls = { inserts: [] as Array<{ table: string; rows: unknown }> };
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: table === "action_audit" ? original : null, error: null }));
    chain.single = vi.fn(async () => ({ data: { id: "undo1" }, error: null }));
    chain.insert = vi.fn((rows: unknown) => { calls.inserts.push({ table, rows }); return chain; });
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
};

describe("undoAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resumes a paused campaign and writes an undo audit", async () => {
    const { sb, calls } = fakeSb(pauseAudit);
    await undoAction(SHOP, "aud1", sb);
    expect(adapter.resume).toHaveBeenCalledWith("c1");
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

  it("throws when the audit is not found for the shop", async () => {
    const { sb } = fakeSb(null);
    await expect(undoAction(SHOP, "missing", sb)).rejects.toThrow(/not found/i);
  });
});
