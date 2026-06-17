/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory supabase fake */
import { describe, it, expect } from "vitest";
import { runShipCostResolution } from "../runner.server";

// The allocation fence (C6) adds `.in("source", ["upload","typed"])` to the period
// query in runner.server.ts. This fake therefore MUST honor .in() as a real filter on
// `source` — otherwise it couldn't detect whether connector periods leaked into the
// allocation pool. (The existing runner.test.ts fake predates the fence and has no
// .in(); a dedicated fake here keeps that file untouched — rule 3.)
interface UpdateRecord {
  table: string;
  payload: Record<string, unknown>;
  filters: Record<string, unknown>;
}

function makeSupabaseFake(tables: Record<string, any[]>) {
  const updates: UpdateRecord[] = [];

  function makeChain(table: string, rows: any[]) {
    let selectedRows = rows;
    const chain: any = {
      select() {
        return chain;
      },
      eq(col: string, val: unknown) {
        selectedRows = selectedRows.filter((r) => r[col] === val);
        return chain;
      },
      in(col: string, vals: unknown[]) {
        selectedRows = selectedRows.filter((r) => vals.includes(r[col]));
        return chain;
      },
      not(col: string, _op: string, _val: unknown) {
        selectedRows = selectedRows.filter((r) => r[col] !== null && r[col] !== undefined);
        return chain;
      },
      range(from: number, to: number) {
        // runner.server.ts paginates via fetchAllRows → PostgREST .range (inclusive
        // both ends), stopping on a short page. Fixtures seed < 1 page, so a single
        // window returns every (already .eq/.in-filtered) row. Without this the chain
        // throws "range is not a function" before any assertion runs.
        selectedRows = selectedRows.slice(from, to + 1);
        return chain;
      },
      update(payload: Record<string, unknown>) {
        const updateFilters: Record<string, unknown> = {};
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

  return {
    sb: { from: (table: string) => makeChain(table, tables[table] ?? []) } as any,
    updates,
  };
}

describe("runShipCostResolution — allocation fence (C6)", () => {
  it("EXCLUDES a source='connector' period from the allocation pool (no double-count)", async () => {
    const { sb, updates } = makeSupabaseFake({
      // One order with NO invoice line and NO weight → if connector money leaked into
      // the pool it would be spread here as a 'reconciled' slice.
      v_order_ship_features: [
        { id: "o1", shop_id: "shop1", customer_country: "US", grams_sum: null, item_count: 1, fulfillment_count: 1, ship_cost_manual_cents: null },
      ],
      shipping_cost_period: [
        { shop_id: "shop1", total_cents: 5000, source: "connector" }, // fenced out
      ],
      shipping_invoice_line: [],
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    });

    await runShipCostResolution(sb, "shop1", { shopCountry: "US" });

    const o1 = updates.find((u) => u.table === "order_fact" && u.filters.id === "o1")!;
    // With the connector period fenced out, periodTotal is null → no allocation → the
    // order falls through to 'fallback' (flat 0), NEVER 'reconciled' from connector money.
    expect(o1.payload.ship_cost_source).not.toBe("reconciled");
    expect(o1.payload.ship_cost_cents).toBe(0);
  });

  it("still allocates real 'upload' period money, and does NOT add connector money to it", async () => {
    const { sb, updates } = makeSupabaseFake({
      v_order_ship_features: [
        { id: "o1", shop_id: "shop1", customer_country: "US", grams_sum: 100, item_count: 1, fulfillment_count: 1, ship_cost_manual_cents: null },
      ],
      shipping_cost_period: [
        { shop_id: "shop1", total_cents: 1000, source: "upload" }, // counted
        { shop_id: "shop1", total_cents: 5000, source: "connector" }, // fenced out
      ],
      shipping_invoice_line: [],
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    });

    await runShipCostResolution(sb, "shop1", { shopCountry: "US" });

    const o1 = updates.find((u) => u.table === "order_fact" && u.filters.id === "o1")!;
    // The single order absorbs the whole UPLOAD total (1000) via reconciled allocation —
    // and crucially NOT 1000+5000=6000, proving the connector total was excluded.
    expect(o1.payload.ship_cost_source).toBe("reconciled");
    expect(o1.payload.ship_cost_cents).toBe(1000);
  });
});
