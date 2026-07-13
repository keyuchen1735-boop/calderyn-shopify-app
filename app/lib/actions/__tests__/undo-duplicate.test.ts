import { describe, it, expect, vi, beforeEach } from "vitest";
import { undoAction } from "../undo.server";
import type { SupabaseClient } from "@supabase/supabase-js";

// undo.server imports the action registry at module scope; this kind does not
// resolve an adapter, but keep the mock to avoid live wiring on import.
vi.mock("../../ads/action-registry.server", () => ({ actionAdapterForShop: vi.fn(async () => null) }));

const SHOP = "00000000-0000-0000-0000-000000000010";

function fakeSb(original: Record<string, unknown> | null, existingUndo: { id: string } | null = null) {
  const calls = {
    inserts: [] as Array<{ table: string; rows: unknown }>,
    deletes: [] as Array<{ table: string }>,
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
      data: table !== "action_audit" ? null : selected === "id" ? existingUndo : original,
      error: null,
    }));
    chain.single = vi.fn(async () => ({ data: { id: "undo1" }, error: null }));
    chain.insert = vi.fn((rows: unknown) => {
      calls.inserts.push({ table, rows });
      return chain;
    });
    chain.update = vi.fn(() => chain);
    chain.delete = vi.fn(() => {
      calls.deletes.push({ table });
      return chain;
    });
    // the mirror-row delete awaits the chain directly (no terminal single())
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve);
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
  return { sb, calls };
}

const dupAudit = {
  id: "aud1",
  shop_id: SHOP,
  alert_id: null,
  action_kind: "duplicate_campaign",
  params: { campaign_id: "c-uuid", external_id: "120", platform: "meta" },
  pre_state: { status: "active", daily_budget_cents: 5000 },
  post_state: { copied_campaign_external_id: "999", copied_campaign_dim_id: "dim-copy-1" },
  dollar_impact_at_exec: 0,
  undo_of: null,
  outcome: "succeeded",
  created_at: new Date().toISOString(),
  actor_user_id: "merchant:web-dashboard",
};

describe("undoAction — duplicate_campaign", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes the copied campaign, drops the mirror row, and writes an undo audit", async () => {
    const { sb, calls } = fakeSb(dupAudit);
    const deleteAd = vi.fn(async () => {});
    const resolveMetaWriteClient = vi.fn(async () => ({ client: {} as never, adAccountId: "act_1" }));
    await undoAction(SHOP, "aud1", sb, { resolveMetaWriteClient, deleteAd });
    expect(resolveMetaWriteClient).toHaveBeenCalledWith(SHOP);
    expect(deleteAd).toHaveBeenCalledWith({}, "999");
    expect(calls.deletes).toContainEqual({ table: "ad_campaign_dim" });
    const undo = calls.inserts.find((i) => i.table === "action_audit");
    expect(undo?.rows as Record<string, unknown>).toMatchObject({ undo_of: "aud1", outcome: "succeeded" });
  });

  it("refuses when the audit lacks copied_campaign_external_id", async () => {
    const broken = { ...dupAudit, post_state: { copied_campaign_dim_id: "dim-copy-1" } };
    const { sb } = fakeSb(broken);
    const deleteAd = vi.fn(async () => {});
    await expect(
      undoAction(SHOP, "aud1", sb, { resolveMetaWriteClient: vi.fn(async () => ({ client: {} as never, adAccountId: "act_1" })), deleteAd }),
    ).rejects.toThrow(/copied_campaign_external_id/i);
    expect(deleteAd).not.toHaveBeenCalled();
  });

  it("refuses when Meta is not connected", async () => {
    const { sb } = fakeSb(dupAudit);
    await expect(
      undoAction(SHOP, "aud1", sb, { resolveMetaWriteClient: vi.fn(async () => null), deleteAd: vi.fn() }),
    ).rejects.toThrow(/not connected/i);
  });
});
