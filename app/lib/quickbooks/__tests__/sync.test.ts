import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncQuickbooksCogs } from "../ingest.server";
import type { QboConnection } from "../client.server";

// Scripted Supabase fake. Tracks inserts/updates per table and serves canned
// reads for sku_dim (one .eq) and cogs_fact (.eq.eq.is.maybeSingle).
function makeSb(opts: {
  skuRows: Array<{ id: string; sku: string }>;
  openCostBySku: Record<string, { id: string; unit_cost_cents: number } | null>;
}) {
  const inserts: Record<string, Array<Record<string, unknown>>> = {};
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
  let currentSkuId = "";

  const sb = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      chain.insert = (rows: Record<string, unknown>) => {
        (inserts[table] ??= []).push(rows);
        return Promise.resolve({ error: null });
      };
      chain.update = (patch: Record<string, unknown>) => {
        updates.push({ table, patch });
        const u: Record<string, unknown> = {};
        u.eq = () => u;
        u.then = (r: (v: { error: null }) => unknown) => r({ error: null });
        return u;
      };
      chain.select = () => chain;
      chain.is = () => chain;
      chain.eq = (col: string, val: string) => {
        if (table === "cogs_fact" && col === "sku_id") currentSkuId = val;
        return chain;
      };
      chain.maybeSingle = () => {
        // only cogs_fact reaches maybeSingle here
        const skuRow = opts.skuRows.find((r) => r.id === currentSkuId);
        const open = skuRow ? opts.openCostBySku[skuRow.sku] ?? null : null;
        return Promise.resolve({ data: open, error: null });
      };
      // awaiting the sku_dim select chain resolves the rows
      chain.then = (resolve: (r: { data: unknown; error: null }) => unknown) =>
        resolve({ data: table === "sku_dim" ? opts.skuRows : [], error: null });
      return chain;
    },
  } as unknown as SupabaseClient;

  return { sb, inserts, updates };
}

function conn(items: unknown): QboConnection {
  return { realmId: "r", client: { queryItems: vi.fn(async () => items) } };
}

const itemsPayload = (rows: Array<{ Id: string; Sku: string; PurchaseCost: number }>) => ({
  QueryResponse: { Item: rows.map((r) => ({ ...r, Type: "Inventory" })) },
});

describe("syncQuickbooksCogs", () => {
  it("inserts a new cogs_fact for a matched SKU and archives the raw payload", async () => {
    const { sb, inserts } = makeSb({ skuRows: [{ id: "sku-1", sku: "MUG" }], openCostBySku: {} });
    const counts = await syncQuickbooksCogs("shop-1", conn(itemsPayload([{ Id: "1", Sku: "MUG", PurchaseCost: 8 }])), sb);
    expect(counts).toMatchObject({ matched: 1, inserted: 1, unchanged: 0, updated: 0, skippedNoMatch: 0 });
    expect(inserts["raw_quickbooks_poll"]).toHaveLength(1);
    expect(inserts["cogs_fact"][0]).toMatchObject({
      shop_id: "shop-1", sku_id: "sku-1", unit_cost_cents: 800, source: "quickbooks", source_ref: "1",
    });
  });

  it("no-ops when the open cost is unchanged", async () => {
    const { sb, inserts } = makeSb({
      skuRows: [{ id: "sku-1", sku: "MUG" }],
      openCostBySku: { MUG: { id: "old", unit_cost_cents: 800 } },
    });
    const counts = await syncQuickbooksCogs("shop-1", conn(itemsPayload([{ Id: "1", Sku: "MUG", PurchaseCost: 8 }])), sb);
    expect(counts).toMatchObject({ matched: 1, inserted: 0, unchanged: 1, updated: 0 });
    expect(inserts["cogs_fact"]).toBeUndefined();
  });

  it("closes the old row and inserts a new one when the cost changes", async () => {
    const { sb, inserts, updates } = makeSb({
      skuRows: [{ id: "sku-1", sku: "MUG" }],
      openCostBySku: { MUG: { id: "old", unit_cost_cents: 800 } },
    });
    const counts = await syncQuickbooksCogs("shop-1", conn(itemsPayload([{ Id: "1", Sku: "MUG", PurchaseCost: 9 }])), sb);
    expect(counts).toMatchObject({ matched: 1, updated: 1, inserted: 0 });
    expect(updates.some((u) => u.table === "cogs_fact" && u.patch.effective_to)).toBe(true);
    expect(inserts["cogs_fact"][0]).toMatchObject({ unit_cost_cents: 900 });
  });

  it("counts items whose SKU has no sku_dim match as skippedNoMatch", async () => {
    const { sb, inserts } = makeSb({ skuRows: [], openCostBySku: {} });
    const counts = await syncQuickbooksCogs("shop-1", conn(itemsPayload([{ Id: "1", Sku: "GHOST", PurchaseCost: 8 }])), sb);
    expect(counts).toMatchObject({ matched: 0, skippedNoMatch: 1, inserted: 0 });
    expect(inserts["cogs_fact"]).toBeUndefined();
  });
});
