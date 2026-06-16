/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory supabase fake */
import { describe, it, expect } from "vitest";
import { runShipCostResolution, rollShipCostIntoSkuPnl } from "../runner.server";

// ---------------------------------------------------------------------------
// Minimal in-memory Supabase stub
// ---------------------------------------------------------------------------

interface UpdateRecord {
  table: string;
  payload: Record<string, unknown>;
  filters: Record<string, unknown>;
}

function makeSupabaseFake(tables: Record<string, any[]>) {
  const updates: UpdateRecord[] = [];

  function makeChain(table: string, rows: any[]) {
    let filters: Record<string, unknown> = {};
    let selectedRows = rows;
    const chain: any = {
      select(_cols?: string) {
        return chain;
      },
      eq(col: string, val: unknown) {
        filters = { ...filters, [col]: val };
        selectedRows = selectedRows.filter((r) => r[col] === val);
        return chain;
      },
      not(col: string, _op: string, _val: unknown) {
        // .not("ship_cost_cents", "is", null) → filter out rows where col IS null
        selectedRows = selectedRows.filter((r) => r[col] !== null && r[col] !== undefined);
        return chain;
      },
      update(payload: Record<string, unknown>) {
        const updateFilters: Record<string, unknown> = {};
        // update chain collects eq filters for assertion but does not enforce them as row guards
        const updateChain: any = {
          eq(col: string, val: unknown) {
            updateFilters[col] = val;
            return updateChain;
          },
          then(cb: (r: { data: null; error: null }) => unknown) {
            updates.push({ table, payload, filters: updateFilters });
            return Promise.resolve(cb({ data: null, error: null }));
          },
        };
        return updateChain;
      },
      then(cb: (r: { data: any[]; error: null }) => unknown) {
        return Promise.resolve(cb({ data: selectedRows, error: null }));
      },
    };
    return chain;
  }

  const sb: any = {
    from(table: string) {
      const rows = tables[table] ?? [];
      return makeChain(table, rows);
    },
    _updates: updates,
  };

  return sb;
}

// ---------------------------------------------------------------------------
// Test 1: period total allocated correctly across 2 orders (grams-weighted)
// ---------------------------------------------------------------------------
describe("runShipCostResolution — period total allocation", () => {
  it("sum of ship_cost_cents updates equals period total; heavier/farther order gets more", async () => {
    const tables: Record<string, any[]> = {
      v_order_ship_features: [
        { id: "o1", shop_id: "shop1", customer_country: "US", grams_sum: 100, item_count: 1, fulfillment_count: 1 },
        { id: "o2", shop_id: "shop1", customer_country: "CA", grams_sum: 300, item_count: 1, fulfillment_count: 1 },
      ],
      shipping_cost_period: [{ shop_id: "shop1", total_cents: 1000 }],
      shipping_invoice_line: [],
      // rollShipCostIntoSkuPnl needs these — empty so it's a no-op
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    };

    const sb = makeSupabaseFake(tables);
    await runShipCostResolution(sb as any, "shop1", { shopCountry: null });

    const orderUpdates = sb._updates.filter((u: UpdateRecord) => u.table === "order_fact");
    expect(orderUpdates).toHaveLength(2);

    const total = orderUpdates.reduce(
      (s: number, u: UpdateRecord) => s + (u.payload.ship_cost_cents as number),
      0,
    );
    expect(total).toBe(1000);

    const o1 = orderUpdates.find((u: UpdateRecord) => u.filters["id"] === "o1")!;
    const o2 = orderUpdates.find((u: UpdateRecord) => u.filters["id"] === "o2")!;
    // o2 is heavier (300g) so must get more than o1 (100g)
    // (zone multiplier is 1 for both since shopCountry is null → domestic)
    expect(o2.payload.ship_cost_cents as number).toBeGreaterThan(
      o1.payload.ship_cost_cents as number,
    );
  });
});

// ---------------------------------------------------------------------------
// Test 2: shipping_invoice_line matched to an order → source = actual_invoice
// ---------------------------------------------------------------------------
describe("runShipCostResolution — invoice line takes priority", () => {
  it("matched invoice order gets source=actual_invoice and exact invoice cost_cents", async () => {
    const tables: Record<string, any[]> = {
      v_order_ship_features: [
        { id: "o1", shop_id: "shop1", customer_country: "US", grams_sum: 200, item_count: 2, fulfillment_count: 1 },
      ],
      shipping_cost_period: [{ shop_id: "shop1", total_cents: 5000 }],
      shipping_invoice_line: [
        { shop_id: "shop1", matched_order_id: "o1", cost_cents: 750 },
      ],
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    };

    const sb = makeSupabaseFake(tables);
    await runShipCostResolution(sb as any, "shop1", { shopCountry: null });

    const orderUpdates = sb._updates.filter((u: UpdateRecord) => u.table === "order_fact");
    expect(orderUpdates).toHaveLength(1);
    expect(orderUpdates[0].payload.ship_cost_source).toBe("actual_invoice");
    expect(orderUpdates[0].payload.ship_cost_cents).toBe(750);
    expect(orderUpdates[0].payload.ship_cost_confidence).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// Test 3: rollShipCostIntoSkuPnl reduces contribution_margin_cents
// ---------------------------------------------------------------------------
describe("rollShipCostIntoSkuPnl", () => {
  it("updates sku_pnl row: contribution_margin_cents drops by attributed ship_cost", async () => {
    const tables: Record<string, any[]> = {
      order_fact: [
        { id: "o1", shop_id: "shop1", created_at_source: "2026-01-15T10:00:00Z", ship_cost_cents: 400 },
      ],
      order_line_fact: [
        { id: "l1", order_id: "o1", shop_id: "shop1", sku_id: "sku-A", grams: 200, quantity: 1 },
      ],
      sku_pnl: [
        {
          id: "pnl1",
          shop_id: "shop1",
          sku_id: "sku-A",
          day: "2026-01-15",
          revenue_cents: 10000,
          cogs_cents: 3000,
          ad_spend_attrib_cents: 1500,
          return_cents: 200,
        },
      ],
    };

    const sb = makeSupabaseFake(tables);
    await rollShipCostIntoSkuPnl(sb as any, "shop1");

    const pnlUpdates = sb._updates.filter((u: UpdateRecord) => u.table === "sku_pnl");
    expect(pnlUpdates).toHaveLength(1);

    const update = pnlUpdates[0];
    // All 400 cents attributed to the one line/sku
    expect(update.payload.ship_cost_cents).toBe(400);
    // contribution = 10000 - 3000 - 1500 - 200 - 400 = 4900
    expect(update.payload.contribution_margin_cents).toBe(4900);
  });
});
