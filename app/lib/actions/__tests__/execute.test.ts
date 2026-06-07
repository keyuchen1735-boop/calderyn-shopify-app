import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeAction } from "../execute.server";
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
function fakeSb(opts: { idempotent?: { audit_id: string }; campaign?: Record<string, unknown> | null }) {
  const calls = { inserts: [] as Array<{ table: string; rows: unknown }> };
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => {
      if (table === "action_idempotency") return { data: opts.idempotent ?? null, error: null };
      if (table === "ad_campaign_dim") return { data: opts.campaign ?? null, error: null };
      if (table === "v_audit_view" || table === "action_audit") return { data: { id: "aud1" }, error: null };
      return { data: null, error: null };
    });
    chain.single = vi.fn(async () => ({ data: { id: "aud1" }, error: null }));
    chain.insert = vi.fn((rows: unknown) => { calls.inserts.push({ table, rows }); return chain; });
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
