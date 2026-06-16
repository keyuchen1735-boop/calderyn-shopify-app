import { describe, it, expect } from "vitest";
import { runFreeShipLeakageDetect } from "../detect-free-ship-leakage.server";

/**
 * Minimal fake of the supabase-js query builder we use: select+eq (reads) and
 * upsert (writes). Each table returns its seeded rows; upserts are captured.
 */
function makeFakeSupabase(tables: Record<string, Record<string, unknown>[]>) {
  const upserts: { table: string; rows: Record<string, unknown>[]; onConflict?: string }[] = [];
  const client = {
    from(table: string) {
      return {
        select() {
          return {
            eq(_col: string, _val: unknown) {
              return Promise.resolve({ data: tables[table] ?? [], error: null });
            },
          };
        },
        upsert(rows: Record<string, unknown>[], opts?: { onConflict?: string }) {
          upserts.push({ table, rows, onConflict: opts?.onConflict });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client, upserts };
}

const SHOP = "shop-1";

function baseTables() {
  return {
    order_fact: [
      { id: "o1", shop_id: SHOP, shipping_cents: 0, ship_cost_cents: 3000, ship_cost_confidence: "high", customer_country: "US" },
      { id: "o2", shop_id: SHOP, shipping_cents: 0, ship_cost_cents: 3000, ship_cost_confidence: "high", customer_country: "US" },
    ],
    order_line_fact: [
      { order_id: "o1", sku_id: "sku-a", grams: 100, quantity: 1 },
      { order_id: "o2", sku_id: "sku-a", grams: 100, quantity: 1 },
    ],
    sku_dim: [{ id: "sku-a", sku: "TEE-RED", grams: 100 }],
    shops: [{ id: SHOP, country: "US" }],
  };
}

describe("runFreeShipLeakageDetect", () => {
  it("upserts an alert row for a bleeding SKU cluster, keyed on the condition", async () => {
    const { client, upserts } = makeFakeSupabase(baseTables());
    const n = await runFreeShipLeakageDetect(client as never, SHOP);
    expect(n).toBeGreaterThan(0);
    const alertUpsert = upserts.find((u) => u.table === "alerts");
    expect(alertUpsert).toBeDefined();
    expect(alertUpsert!.onConflict).toBe("shop_id,detector_id,entity_ref");
    const skuRow = alertUpsert!.rows.find(
      (r) => (r.entity_ref as { kind: string }).kind === "sku",
    )!;
    expect(skuRow.detector_id).toBe("free_shipping_leakage");
    // $60 carrier cost, $0 collected → $60 bleed; alerts.dollar_impact is DOLLARS.
    expect(skuRow.dollar_impact).toBe(60);
    expect(skuRow.severity).toBe("medium");
    expect((skuRow.entity_ref as { sku: string }).sku).toBe("TEE-RED");
    expect((skuRow.evidence as { ship_cost_confidence: string }).ship_cost_confidence).toBe("high");
  });

  it("does NOT upsert when nothing clears the floor/confidence bar", async () => {
    const tables = baseTables();
    tables.order_fact = [
      { id: "o1", shop_id: SHOP, shipping_cents: 0, ship_cost_cents: 500, ship_cost_confidence: "high", customer_country: "US" },
    ];
    tables.order_line_fact = [{ order_id: "o1", sku_id: "sku-a", grams: 100, quantity: 1 }];
    const { client, upserts } = makeFakeSupabase(tables);
    const n = await runFreeShipLeakageDetect(client as never, SHOP);
    expect(n).toBe(0);
    expect(upserts.find((u) => u.table === "alerts")).toBeUndefined();
  });
});
