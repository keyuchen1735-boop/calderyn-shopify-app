/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory supabase fake */
import { describe, it, expect } from "vitest";
import { runShipCostResolution, rollShipCostIntoSkuPnl } from "../runner.server";
import { DEFAULT_SHIP_RATE_PER_KG_CENTS } from "../model";

// ---------------------------------------------------------------------------
// Minimal in-memory Supabase stub
// ---------------------------------------------------------------------------

interface UpdateRecord {
  table: string;
  payload: Record<string, unknown>;
  filters: Record<string, unknown>;
}

// PostgREST silently truncates an uncapped select at this many rows. The fake
// emulates that default so a query without an explicit cap or .range() loop
// cannot read past it — proving the truncation bug the runner has to defeat.
const POSTGREST_DEFAULT_MAX = 1000;

function makeSupabaseFake(tables: Record<string, any[]>) {
  const updates: UpdateRecord[] = [];

  function makeChain(table: string, rows: any[]) {
    let filters: Record<string, unknown> = {};
    let selectedRows = rows;
    // null until the caller sets an explicit cap (.limit) or page (.range);
    // when null the read is truncated to POSTGREST_DEFAULT_MAX, like real PostgREST.
    let rangeFrom: number | null = null;
    let rangeTo: number | null = null;
    let explicitLimit: number | null = null;
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
      limit(n: number) {
        explicitLimit = n;
        return chain;
      },
      range(from: number, to: number) {
        // PostgREST .range is inclusive on both ends.
        rangeFrom = from;
        rangeTo = to;
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
        let out: any[];
        if (rangeFrom != null && rangeTo != null) {
          // Range page: inclusive slice; this is how a paginating reader walks
          // past the default truncation ceiling.
          out = selectedRows.slice(rangeFrom, rangeTo + 1);
        } else if (explicitLimit != null) {
          out = selectedRows.slice(0, explicitLimit);
        } else {
          // No explicit cap/page → PostgREST default truncation.
          out = selectedRows.slice(0, POSTGREST_DEFAULT_MAX);
        }
        return Promise.resolve(cb({ data: out, error: null }));
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
// Test 2b: manual override (from v_order_ship_features) wins, stamps 'manual'
// ---------------------------------------------------------------------------
describe("runShipCostResolution — manual override", () => {
  it("manual override wins over allocation and stamps source 'manual'", async () => {
    const tables: Record<string, any[]> = {
      v_order_ship_features: [
        { id: "a", shop_id: "shop1", customer_country: "US", grams_sum: 100, item_count: 1, fulfillment_count: 1, ship_cost_manual_cents: 999 },
        { id: "b", shop_id: "shop1", customer_country: "US", grams_sum: 100, item_count: 1, fulfillment_count: 1, ship_cost_manual_cents: null },
      ],
      shipping_cost_period: [{ shop_id: "shop1", total_cents: 8000 }],
      shipping_invoice_line: [],
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    };

    const sb = makeSupabaseFake(tables);
    await runShipCostResolution(sb as any, "shop1", { shopCountry: "US" });

    const orderUpdates = sb._updates.filter((u: UpdateRecord) => u.table === "order_fact");
    const a = orderUpdates.find((u: UpdateRecord) => u.filters["id"] === "a")!;
    expect(a.payload.ship_cost_cents).toBe(999);
    expect(a.payload.ship_cost_source).toBe("manual");
    expect(a.payload.ship_cost_confidence).toBe("high");
    // b has no override → still reconciled allocation
    expect(
      orderUpdates.find((u: UpdateRecord) => u.filters["id"] === "b")!.payload.ship_cost_source,
    ).toBe("reconciled");
  });
});

// ---------------------------------------------------------------------------
// Test 2c: weight model — no manual/invoice/period cost → estimate from
// weight × zone, source 'modeled'; an order with no weight falls to fallback.
// ---------------------------------------------------------------------------
describe("runShipCostResolution — weight model", () => {
  it("estimates ship cost from weight × zone and stamps source 'modeled'", async () => {
    const tables: Record<string, any[]> = {
      v_order_ship_features: [
        { id: "o1", shop_id: "shop1", customer_country: "US", grams_sum: 1000, item_count: 1, fulfillment_count: 1, ship_cost_manual_cents: null },
        { id: "o2", shop_id: "shop1", customer_country: "US", grams_sum: null, item_count: 1, fulfillment_count: 1, ship_cost_manual_cents: null },
      ],
      shipping_cost_period: [], // no period total → no allocation
      shipping_invoice_line: [], // no invoice
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    };

    const sb = makeSupabaseFake(tables);
    await runShipCostResolution(sb as any, "shop1", { shopCountry: "US" });

    const u = sb._updates.filter((x: UpdateRecord) => x.table === "order_fact");
    const o1 = u.find((x: UpdateRecord) => x.filters["id"] === "o1")!;
    // 1 kg, domestic (×1) → default rate, low confidence.
    expect(o1.payload.ship_cost_source).toBe("modeled");
    expect(o1.payload.ship_cost_confidence).toBe("low");
    expect(o1.payload.ship_cost_cents).toBe(DEFAULT_SHIP_RATE_PER_KG_CENTS);
    // o2 has no weight → model returns null → falls through to fallback (no real cost).
    const o2 = u.find((x: UpdateRecord) => x.filters["id"] === "o2")!;
    expect(o2.payload.ship_cost_source).toBe("fallback");
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

// ---------------------------------------------------------------------------
// Test 4: >1000 rows — runShipCostResolution must resolve EVERY order, not just
// the first PostgREST-truncated 1000. Regression for prod: a cron tick resolved
// exactly 1000 orders/shop and left the rest unreconciled.
// ---------------------------------------------------------------------------
describe("runShipCostResolution — processes all rows past the 1000-row truncation", () => {
  it("resolves all 2500 orders in one tick (defeats PostgREST default truncation)", async () => {
    const N = 2500;
    const orders = Array.from({ length: N }, (_, i) => ({
      id: `o${i}`,
      shop_id: "shop1",
      customer_country: "US",
      grams_sum: 100,
      item_count: 1,
      fulfillment_count: 1,
      ship_cost_manual_cents: null,
    }));

    const tables: Record<string, any[]> = {
      v_order_ship_features: orders,
      shipping_cost_period: [{ shop_id: "shop1", total_cents: 1_000_000 }],
      shipping_invoice_line: [],
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    };

    const sb = makeSupabaseFake(tables);
    await runShipCostResolution(sb as any, "shop1", { shopCountry: "US" });

    const orderUpdates = sb._updates.filter((u: UpdateRecord) => u.table === "order_fact");
    // Every order must be reconciled — not just the first 1000.
    expect(orderUpdates).toHaveLength(N);
    const updatedIds = new Set(orderUpdates.map((u: UpdateRecord) => u.filters["id"]));
    expect(updatedIds.size).toBe(N);
    expect(updatedIds.has("o0")).toBe(true);
    expect(updatedIds.has(`o${N - 1}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 5: >1000 rows — rollShipCostIntoSkuPnl must read every order_fact,
// order_line_fact and sku_pnl row, not the first truncated 1000 of each.
// ---------------------------------------------------------------------------
describe("rollShipCostIntoSkuPnl — processes all rows past the 1000-row truncation", () => {
  it("updates all 1500 sku_pnl rows (reads full order_fact + order_line_fact)", async () => {
    const N = 1500;
    const orderFacts = Array.from({ length: N }, (_, i) => ({
      id: `o${i}`,
      shop_id: "shop1",
      created_at_source: "2026-01-15T10:00:00Z",
      ship_cost_cents: 400,
    }));
    const orderLines = Array.from({ length: N }, (_, i) => ({
      id: `l${i}`,
      order_id: `o${i}`,
      shop_id: "shop1",
      sku_id: `sku-${i}`,
      grams: 200,
      quantity: 1,
    }));
    const pnlRows = Array.from({ length: N }, (_, i) => ({
      id: `pnl${i}`,
      shop_id: "shop1",
      sku_id: `sku-${i}`,
      day: "2026-01-15",
      revenue_cents: 10000,
      cogs_cents: 3000,
      ad_spend_attrib_cents: 1500,
      return_cents: 200,
    }));

    const tables: Record<string, any[]> = {
      order_fact: orderFacts,
      order_line_fact: orderLines,
      sku_pnl: pnlRows,
    };

    const sb = makeSupabaseFake(tables);
    await rollShipCostIntoSkuPnl(sb as any, "shop1");

    const pnlUpdates = sb._updates.filter((u: UpdateRecord) => u.table === "sku_pnl");
    // Every sku_pnl row gets its ship cost rolled in — only possible if the
    // order_fact, order_line_fact AND sku_pnl reads all paged past 1000 rows.
    expect(pnlUpdates).toHaveLength(N);
    const updatedIds = new Set(pnlUpdates.map((u: UpdateRecord) => u.filters["id"]));
    expect(updatedIds.size).toBe(N);
    expect(updatedIds.has("pnl0")).toBe(true);
    expect(updatedIds.has(`pnl${N - 1}`)).toBe(true);
  });
});
