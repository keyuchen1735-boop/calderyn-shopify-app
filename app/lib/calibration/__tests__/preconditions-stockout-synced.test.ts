import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { stockoutPauseAllowed } from "../preconditions.server";

type Row = Record<string, unknown>;

function sbWith(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from: vi.fn((table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = vi.fn(self);
      chain.eq = vi.fn(self);
      chain.in = vi.fn(self);
      chain.maybeSingle = vi.fn(async () => ({
        data: tables[table]?.[0] ?? null,
        error: null,
      }));
      chain.then = (resolve: (result: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve(resolve({ data: tables[table] ?? [], error: null }));
      return chain;
    }),
  } as unknown as SupabaseClient;
}

const now = Date.now();
const alert = {
  id: "alert-1",
  detector_id: "sku_stockout_vs_spend",
  entity_ref: { sku_id: "sku-1" },
};

function validTables(): Record<string, Row[]> {
  return {
    sku_dim: [{
      id: "sku-1",
      product_id: "gid://shopify/Product/1",
      inventory_policy: "deny",
      inventory_tracked: true,
    }],
    inventory_level_fact: [{
      sku_id: "sku-1",
      location_id: "loc-1",
      available: 0,
      observed_at: new Date(now - 5 * 60_000).toISOString(),
    }],
    ad_campaign_dim: [{
      id: "campaign-1",
      status: "ACTIVE",
      last_synced_at: new Date(now - 5 * 60_000).toISOString(),
    }],
  };
}

describe("stockoutPauseAllowed with synced Shopify settings", () => {
  const run = (tables: Record<string, Row[]>) =>
    stockoutPauseAllowed({
      shopId: "shop-1",
      alert,
      campaignId: "campaign-1",
      sb: sbWith(tables),
      nowMs: now,
    });

  it("allows a tracked deny-policy product that is freshly sold out", async () => {
    await expect(run(validTables())).resolves.toEqual({ ok: true });
  });

  it("blocks backorders, untracked variants, live stock, stale stock, and paused campaigns", async () => {
    const backorder = validTables();
    backorder.sku_dim[0].inventory_policy = "continue";
    expect((await run(backorder)).ok).toBe(false);

    const untracked = validTables();
    untracked.sku_dim[0].inventory_tracked = false;
    expect((await run(untracked)).ok).toBe(false);

    const stocked = validTables();
    stocked.inventory_level_fact[0].available = 1;
    expect((await run(stocked)).ok).toBe(false);

    const stale = validTables();
    stale.inventory_level_fact[0].observed_at = new Date(now - 61 * 60_000).toISOString();
    expect((await run(stale)).ok).toBe(false);

    const paused = validTables();
    paused.ad_campaign_dim[0].status = "PAUSED";
    expect((await run(paused)).ok).toBe(false);
  });
});
